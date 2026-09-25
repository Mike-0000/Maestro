import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// KittenML KittenTTS Mini 0.8, converted by sherpa-onnx (both Apache-2.0).
// Never package unverified model bytes; the download is a build-time operation only.
const NAME = 'kitten-mini-en-v0_8';
const SHA256 = '518f9b130320f690d5b5476df77bde4215fca67773cda16710318e5081234b9d';
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${NAME}.tar.bz2`;
// sherpa-onnx links eSpeak NG (GPL-3.0) for English phonemization. Include its license.
const ESPEAK_LICENSE_URL =
  'https://raw.githubusercontent.com/csukuangfj/espeak-ng/ed530aa113046142eb5115cf2fc9157854d0ffe1/COPYING';
const ESPEAK_LICENSE_SHA256 = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903';
export const LOCAL_TTS_MODEL_DIR = join(import.meta.dirname, '..', '.cache', 'local-tts', NAME);

async function modelReady(): Promise<boolean> {
  try {
    return (
      (await readFile(join(LOCAL_TTS_MODEL_DIR, '.archive-sha256'), 'utf8')).trim() === SHA256 &&
      (await stat(join(LOCAL_TTS_MODEL_DIR, 'model.onnx'))).size > 10_000_000 &&
      existsSync(join(LOCAL_TTS_MODEL_DIR, 'voices.bin')) &&
      existsSync(join(LOCAL_TTS_MODEL_DIR, 'tokens.txt')) &&
      existsSync(join(LOCAL_TTS_MODEL_DIR, 'espeak-ng-data', 'phontab')) &&
      existsSync(join(LOCAL_TTS_MODEL_DIR, 'LICENSE'))
    );
  } catch {
    return false;
  }
}

async function addEspeakLicense(directory: string): Promise<void> {
  if (existsSync(join(directory, 'ESPEAK-NG-COPYING.txt'))) return;
  const licenseResponse = await fetch(ESPEAK_LICENSE_URL);
  if (!licenseResponse.ok) throw new Error('Could not download the eSpeak NG license');
  const license = Buffer.from(await licenseResponse.arrayBuffer());
  if (createHash('sha256').update(license).digest('hex') !== ESPEAK_LICENSE_SHA256) {
    throw new Error('eSpeak NG license checksum mismatch');
  }
  await writeFile(join(directory, 'ESPEAK-NG-COPYING.txt'), license);
}

export async function prepareLocalTtsModel(): Promise<void> {
  if (await modelReady()) {
    await addEspeakLicense(LOCAL_TTS_MODEL_DIR);
    return;
  }
  // Never remove an in-use model while a development instance may be synthesizing.
  if (existsSync(LOCAL_TTS_MODEL_DIR)) {
    throw new Error(`Incomplete model cache at ${LOCAL_TTS_MODEL_DIR}; remove it and retry`);
  }
  const parent = join(import.meta.dirname, '..', '.cache', 'local-tts');
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, '.download-'));
  try {
    const response = await fetch(URL);
    if (!response.ok) throw new Error(`Kitten TTS model download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== SHA256) {
      throw new Error('Kitten TTS archive checksum mismatch');
    }
    const archive = join(temporary, `${NAME}.tar.bz2`);
    await writeFile(archive, bytes);
    // Arguments are fixed; never interpolate paths into a shell command. SHA-256 is checked first.
    const tar =
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    // Extract only after checksum verification. Windows can reject renaming the freshly extracted
    // directory while its antivirus is scanning files, so write directly into the cache path.
    execFileSync(tar, ['-xjf', archive, '-C', parent]);
    await addEspeakLicense(LOCAL_TTS_MODEL_DIR);
    await writeFile(join(LOCAL_TTS_MODEL_DIR, '.archive-sha256'), `${SHA256}\n`);
    if (!(await modelReady())) throw new Error('Kitten TTS archive is missing required files');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await prepareLocalTtsModel();
}
