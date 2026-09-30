# Maestro auto-update (Azure Blob feed)

Maestro installs updates from a static feed in an Azure Blob container. The existing
`electron-updater` service downloads a newer Windows NSIS installer, and the installer is applied
on restart. Updates stay off until the feed URL and a signing key are set in
`apps/emdash-desktop/src/core/primitives/app-identity/api/app-identity.ts`.

## How updates are trusted

- **Signed manifest.** Each release manifest (`v1-stable.yml`) carries an Ed25519 signature made
  with the publisher's private key. The app contains the matching public keys
  (`UPDATE_SIGNING_PUBLIC_KEYS`). Through the updater's `isUpdateSupported` hook, the app rejects
  any manifest that is unsigned, signed by an unknown key, or changed after signing. The signed
  fields are version, files, hashes, sizes, elevation, rollout, and release notes. This check
  runs before `electron-updater` treats an update as available. Code:
  `apps/emdash-desktop/src/main/host/updates/update-manifest-signature.ts`.
- **Integrity.** `electron-updater` checks every downloaded installer (full or differential)
  against the signed SHA-512, and the release scripts check the same hash before uploading.
- **Transport.** The feed must be `https://`. Azure serves it over TLS 1.2 or later.
- **No downgrades.** `allowDowngrade` stays `false`, and every published version must sort after
  the live one. An old signed manifest therefore cannot roll an installed copy back.
- **Immutable releases.** Installers are uploaded once under `releases/<version>/` with
  create-only writes. The live manifest is replaced last, so clients never see a release whose
  files are missing.
- **Why not Authenticode.** Local builds are signed with a certificate that only the developer's
  machine trusts (`scripts/setup-windows-local-signing.ps1`). On other machines,
  `electron-updater`'s publisher check would reject every update. That check is turned off with
  `win.verifyUpdateCodeSignature: false`, and the Ed25519 manifest signature replaces it.

Feed layout:

```text
<feed>/v1-stable.yml                               live signed manifest (no-cache)
<feed>/releases/<version>/maestro-x64.exe          installer (immutable)
<feed>/releases/<version>/maestro-x64.exe.blockmap differential-download map
<feed>/releases/<version>/v1-stable.yml            the release's signed manifest (for --restore)
```

## Hosting model

The recommended setup is a container with anonymous **blob-level** read access. Readers can fetch
a blob only if they know its URL; they cannot list the container. Nobody can tamper with an update
without the signing key, and only the upload SAS can write.

For a private feed, keep anonymous access off. Instead, put a long-lived, read-only
(`sp=r`), container-scoped SAS in the query string of `UPDATE_FEED_URL`. `electron-updater` keeps
that query on every request. Anyone who has the app can extract the SAS, so this only limits
access to people you have given the app. Revoke it by rotating the storage key or its stored
access policy, then publish a build with a new SAS.

## One-time setup

1. **Storage.** Create the storage account and container with Azure CLI, or do the same in the
   portal:

   ```powershell
   az storage account create -n <account> -g <resource-group> -l <region> `
     --sku Standard_LRS --kind StorageV2 --https-only true --min-tls-version TLS1_2 `
     --allow-blob-public-access true
   az storage container create --account-name <account> -n maestro --public-access blob --auth-mode login
   ```

   An existing account may block public access. Enable it with
   `az storage account update -n <account> -g <resource-group> --allow-blob-public-access true`.
   The feed URL is then `https://<account>.blob.core.windows.net/maestro`.

2. **Signing key.** Run this from `apps/emdash-desktop`:

   ```powershell
   pnpm run updates:keygen
   ```

   The script writes the private key to
   `%LOCALAPPDATA%\Chorus\UpdateSigning\maestro-update-signing.pem`. Set
   `MAESTRO_UPDATE_SIGNING_KEY_FILE` to use a different path. It prints the public key. **Back up
   the private key** somewhere private, such as a password manager. If you lose it, installed copies
   cannot update until they are reinstalled with a build that trusts a new key. Never commit it.

3. **App configuration.** In `app-identity.ts`, set the following and commit the change through
   the normal Chorus flow:

   ```ts
   export const UPDATE_FEED_URL: string | null = 'https://<account>.blob.core.windows.net/maestro';
   export const UPDATE_SIGNING_PUBLIC_KEYS: readonly string[] = ['<public key from keygen>'];
   ```

   From then on, every installer build includes `resources/app-update.yml` pointing at the feed.
   Publish the first release before sharing it, or installed copies report a missing
   `v1-stable.yml` when they check for updates.

## Publishing a release

Build from a clean checkout of the validated `chorus/main`, from `apps/emdash-desktop`:

```powershell
pnpm run updates:build --notes "What changed"      # builds release/maestro-update (no upload)
pnpm run updates:publish                           # dry run: verify, sign, print the upload plan
$env:MAESTRO_AZURE_UPLOAD_SAS = '<container SAS with r,c,w>'
pnpm run updates:publish --publish                 # upload, then verify the feed as a client
```

- The version is `<package version>-maestro.<UTC yyyymmddHHMM>`, for example
  `1.2.6-maestro.202609291530`. Each publish therefore sorts after the previous one, and an
  upstream version bump still sorts higher.
- For the upload SAS, prefer a short-lived user-delegation SAS created just before publishing.
  This requires the *Storage Blob Data Contributor* role:

  ```powershell
  az storage container generate-sas --account-name <account> -n maestro --permissions rcw `
    --expiry (Get-Date).ToUniversalTime().AddHours(2).ToString('yyyy-MM-ddTHH:mmZ') `
    --https-only --auth-mode login --as-user -o tsv
  ```

  The token needs no delete permission. The scripts never print it.
- If a publish is interrupted, rerun it. Files that are already uploaded are reused only when their
  size and SHA-512 match.
- `pnpm run updates:publish --restore <version> --publish` points the live manifest back at an
  earlier signed release. This affects only new installs and clients older than that version:
  installed apps never downgrade. To fix a bad release, publish a newer build.

## First install and friends

Existing builds have updates turned off, so each machine needs one manual install of a release
built with the feed configured. Download it from
`https://<account>.blob.core.windows.net/maestro/releases/<version>/maestro-x64.exe`. Later
versions are found automatically (30 s after launch, then hourly). The app announces each one;
choose **Download** in the update card or notification, then **Restart** (or just quit, and the
update installs on exit).

On a new machine, the unsigned or locally signed installer shows a Windows SmartScreen warning
the first time (**More info → Run anyway**). Auto-updates do not show that warning. To remove it,
sign releases with a publicly trusted certificate, such as Azure Trusted Signing.

## Limitations

- The feed covers Windows x64 only. macOS updates need an Apple Developer ID signature and
  notarization. Linux is not set up.
- `/push` installs from the local delivery coordinator are unpacked builds without
  `app-update.yml`, so their updater stays off. They keep the plain package version (such as
  `1.2.6`) and are updated only by `/push`. On a given machine, use either `/push` or the feed.
- A feed host can withhold new releases (a freeze), but it cannot serve a modified or older one.
- To rotate the signing key, ship a build that trusts both keys, then switch publishing to the new
  key.
