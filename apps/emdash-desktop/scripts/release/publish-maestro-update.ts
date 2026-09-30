// Signs the Maestro update manifest built by build-maestro-update.ts and uploads the release to the
// Azure Blob feed. Dry run by default: pass --publish to upload. See docs/chorus/auto-update.md.
//
// Layout under UPDATE_FEED_URL:
//   releases/<version>/<installer>(.blockmap)  immutable, never overwritten
//   releases/<version>/<channel>.yml           signed manifest archived with its release
//   <channel>.yml                              signed live manifest, replaced last
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  UPDATE_CHANNEL,
  UPDATE_FEED_URL,
  UPDATE_SIGNING_PUBLIC_KEYS,
} from '../../src/core/primitives/app-identity/api/app-identity.ts';
import { verifyUpdateManifest } from '../../src/main/host/updates/update-manifest-signature.ts';
import { getBlobProperties, getBlobText, putBlob } from './lib/azure-blob.ts';
import { fail, info, step, warn } from './lib/log.ts';
import {
  blockmapName,
  compareSemver,
  defaultSigningKeyFile,
  feedBlobUrl,
  IMMUTABLE_CACHE_CONTROL,
  loadSigningKey,
  MAESTRO_UPDATE_OUTPUT,
  MANIFEST_CACHE_CONTROL,
  manifestFileName,
  parseFeedUrl,
  parseManifest,
  relocateManifest,
  releaseBlobPath,
  signManifest,
  trustedKeyIdFor,
  UPLOAD_SAS_ENV,
} from './lib/maestro-update.ts';

const { values } = parseArgs({
  // `pnpm run <script> -- --flag` forwards the separator itself.
  args: process.argv.slice(2).filter((arg, index) => index > 0 || arg !== '--'),
  options: {
    dir: { type: 'string', default: MAESTRO_UPDATE_OUTPUT },
    publish: { type: 'boolean', default: false },
    restore: { type: 'string' },
  },
  strict: true,
});

if (!UPDATE_FEED_URL || UPDATE_SIGNING_PUBLIC_KEYS.length === 0) {
  fail('Set UPDATE_FEED_URL and UPDATE_SIGNING_PUBLIC_KEYS in app-identity.ts first');
}
const feedUrl = UPDATE_FEED_URL;
parseFeedUrl(feedUrl);
const channelFile = manifestFileName(UPDATE_CHANNEL);

function uploadSas(): string {
  const sas = process.env[UPLOAD_SAS_ENV]?.trim().replace(/^\?/, '');
  if (!sas || !/(^|&)sig=/.test(sas)) {
    fail(`Set ${UPLOAD_SAS_ENV} to a container SAS token with read, create, and write permissions`);
  }
  return sas;
}

/** The manifest clients see right now, read through the upload SAS so private containers work. */
async function readLiveManifest(sas: string | null): Promise<Record<string, unknown> | null> {
  const url = sas ? feedBlobUrl(feedUrl, channelFile, sas) : feedBlobUrl(feedUrl, channelFile);
  const text = await getBlobText(url, channelFile);
  return text === null ? null : parseManifest(text);
}

/** Read the live manifest exactly as an installed app does and confirm it verifies. */
async function verifyAsClient(
  expectedVersion: string,
  installerBlob: string | null
): Promise<void> {
  step('Verifying the live feed as an installed app sees it');
  const text = await getBlobText(feedBlobUrl(feedUrl, channelFile), channelFile);
  if (text === null) {
    fail(
      'The feed manifest is not readable without credentials. Allow anonymous blob read on the ' +
        'container, or add a read-only SAS query to UPDATE_FEED_URL'
    );
  }
  const payload = verifyUpdateManifest(parseManifest(text), UPDATE_SIGNING_PUBLIC_KEYS);
  if (payload.version !== expectedVersion) {
    fail(`Live manifest reports ${payload.version}, expected ${expectedVersion}`);
  }
  if (installerBlob) {
    const properties = await getBlobProperties(feedBlobUrl(feedUrl, installerBlob), installerBlob);
    if (!properties) fail(`${installerBlob} is not readable through the feed URL`);
  }
  info(`Clients now see ${expectedVersion}`);
}

async function restore(version: string): Promise<void> {
  // Re-pointing the feed only affects clients still older than `version`: installed apps never
  // downgrade. To replace a bad release, publish a newer build instead.
  const sas = values.publish ? uploadSas() : null;
  const archived = releaseBlobPath(version, channelFile);
  const text = await getBlobText(
    sas ? feedBlobUrl(feedUrl, archived, sas) : feedBlobUrl(feedUrl, archived),
    archived
  );
  if (text === null) fail(`${archived} does not exist`);
  verifyUpdateManifest(parseManifest(text), UPDATE_SIGNING_PUBLIC_KEYS);
  info(`${archived} is signed by a trusted key`);
  if (!sas) {
    info(`Dry run: pass --publish to make ${version} the live release`);
    return;
  }
  await putBlob(
    feedBlobUrl(feedUrl, channelFile, sas),
    Buffer.from(text, 'utf8'),
    { contentType: 'text/yaml', cacheControl: MANIFEST_CACHE_CONTROL, createOnly: false },
    channelFile
  );
  await verifyAsClient(version, null);
}

async function publish(): Promise<void> {
  const dir = values.dir ?? MAESTRO_UPDATE_OUTPUT;
  const keyFile = defaultSigningKeyFile();
  if (!keyFile || !existsSync(keyFile)) {
    fail(
      'No signing key found. Run `pnpm run updates:keygen` (or set MAESTRO_UPDATE_SIGNING_KEY_FILE)'
    );
  }
  const privateKey = loadSigningKey(keyFile);
  const keyId = trustedKeyIdFor(privateKey, UPDATE_SIGNING_PUBLIC_KEYS);
  if (!keyId) fail(`${keyFile} is not one of this build's UPDATE_SIGNING_PUBLIC_KEYS`);

  step('Checking the built release');
  const built = parseManifest(readFileSync(join(dir, channelFile), 'utf8'));
  const version = String(built.version);
  const { manifest, uploads } = relocateManifest(built, version);
  const files = uploads.flatMap((upload) => {
    const bytes = readFileSync(join(dir, upload.localName));
    const entries = [{ ...upload, bytes, contentType: 'application/octet-stream' }];
    const blockmap = blockmapName(upload.localName);
    if (existsSync(join(dir, blockmap))) {
      entries.push({
        localName: blockmap,
        blobPath: releaseBlobPath(version, blockmap),
        bytes: readFileSync(join(dir, blockmap)),
        contentType: 'application/octet-stream',
      });
    }
    return entries;
  });
  for (const entry of (manifest.files as Array<Record<string, unknown>>) ?? []) {
    const file = files.find((candidate) => candidate.blobPath === entry.url);
    const sha512 = file && createHash('sha512').update(file.bytes).digest('base64');
    if (!file || sha512 !== entry.sha512 || file.bytes.length !== entry.size) {
      fail(`${String(entry.url)} does not match its manifest entry; rebuild before publishing`);
    }
  }
  const signed = signManifest(manifest, privateKey, UPDATE_SIGNING_PUBLIC_KEYS);
  info(`Version ${version}, signed with key ${keyId}`);

  const sas = values.publish ? uploadSas() : null;
  const live = await readLiveManifest(sas).catch((error: unknown) => {
    if (sas) throw error;
    warn(`Could not read the live manifest without credentials: ${String(error)}`);
    return null;
  });
  const liveVersion = live && typeof live.version === 'string' ? live.version : null;
  if (liveVersion && compareSemver(version, liveVersion) <= 0) {
    fail(`The feed already serves ${liveVersion}; ${version} would not be offered as an update`);
  }
  info(liveVersion ? `Replaces live release ${liveVersion}` : 'No live release yet');

  const archivedManifest = releaseBlobPath(version, channelFile);
  if (!sas) {
    const preview = join(dir, 'publish-preview');
    mkdirSync(preview, { recursive: true });
    writeFileSync(join(preview, channelFile), signed);
    step('Dry run: nothing uploaded');
    for (const file of files) info(`would upload ${file.blobPath} (${file.bytes.length} bytes)`);
    info(`would upload ${archivedManifest}`);
    info(`would replace ${channelFile} (signed copy: ${join(preview, channelFile)})`);
    info(`Pass --publish with ${UPLOAD_SAS_ENV} set to upload`);
    return;
  }

  step('Uploading release files');
  for (const file of files) {
    const sha512 = createHash('sha512').update(file.bytes).digest('base64');
    const existing = await getBlobProperties(
      feedBlobUrl(feedUrl, file.blobPath, sas),
      file.blobPath
    );
    if (existing) {
      // Immutable: only an identical earlier upload (e.g. an interrupted publish) may be reused.
      if (existing.size !== file.bytes.length || existing.sha512 !== sha512) {
        fail(`${file.blobPath} already exists with different contents`);
      }
      info(`${file.blobPath} already uploaded`);
      continue;
    }
    await putBlob(
      feedBlobUrl(feedUrl, file.blobPath, sas),
      file.bytes,
      {
        contentType: file.contentType,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        createOnly: true,
        sha512,
      },
      file.blobPath
    );
    info(`uploaded ${file.blobPath}`);
  }

  step('Publishing the signed manifest');
  const manifestBytes = Buffer.from(signed, 'utf8');
  if (!(await getBlobProperties(feedBlobUrl(feedUrl, archivedManifest, sas), archivedManifest))) {
    await putBlob(
      feedBlobUrl(feedUrl, archivedManifest, sas),
      manifestBytes,
      { contentType: 'text/yaml', cacheControl: IMMUTABLE_CACHE_CONTROL, createOnly: true },
      archivedManifest
    );
  }
  // The live manifest goes last, so clients never see a release whose files are missing.
  await putBlob(
    feedBlobUrl(feedUrl, channelFile, sas),
    manifestBytes,
    { contentType: 'text/yaml', cacheControl: MANIFEST_CACHE_CONTROL, createOnly: false },
    channelFile
  );
  await verifyAsClient(version, files[0]?.blobPath ?? null);
}

try {
  if (values.restore) await restore(values.restore);
  else await publish();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
