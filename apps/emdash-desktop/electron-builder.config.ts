import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Configuration } from 'electron-builder';
import { LOCAL_TTS_MODEL_DIR, prepareLocalTtsModel } from './scripts/prepare-local-tts-model.ts';
import {
  prepareWorkspaceServerBundle,
  WORKSPACE_SERVER_BUNDLE_DIR,
} from './scripts/prepare-workspace-server-bundle.ts';
import { resolveWindowsSigntoolOptions } from './scripts/windows-signing.ts';
import {
  APP_ID,
  ARTIFACT_PREFIX,
  LINUX_DESKTOP_ID,
  PRODUCT_NAME,
  R2_BASE_URL,
  UPDATE_CHANNEL,
  UPDATE_FEED_URL,
} from './src/core/primitives/app-identity/api/app-identity.ts';

const config: Configuration = {
  appId: APP_ID,
  productName: PRODUCT_NAME,
  executableName: PRODUCT_NAME,
  extraMetadata: { desktopName: `${LINUX_DESKTOP_ID}.desktop` },
  directories: { output: process.env.CHORUS_DELIVERY_BUILD_OUTPUT ?? 'release' },
  artifactName: `${ARTIFACT_PREFIX}-\${arch}.\${ext}`,
  publish: [
    {
      provider: 'generic',
      // Written into resources/app-update.yml; the app enables its updater only when
      // UPDATE_FEED_URL and a signing key are configured in app-identity.ts.
      url: UPDATE_FEED_URL ?? R2_BASE_URL,
      channel: UPDATE_CHANNEL,
    },
  ],
  generateUpdatesFilesForAllChannels: false,
  files: ['out/**/*', 'node_modules/**/*', 'drizzle/**/*'],
  // The pinned, checksum-verified offline model ships with every installer; no first-run download.
  // Windows remote hosts install the bundled workspace server over SSH (no hosted release needed).
  beforePack: async () => {
    await prepareLocalTtsModel();
    await prepareWorkspaceServerBundle();
  },
  extraResources: [
    { from: LOCAL_TTS_MODEL_DIR, to: 'models/kitten-mini-en-v0_8' },
    { from: WORKSPACE_SERVER_BUNDLE_DIR, to: 'workspace-server' },
    {
      from: '../../tooling/chorus-delivery/install-chorus-update.ps1',
      to: 'chorus-delivery/install-chorus-update.ps1',
    },
  ],
  afterPack: async ({ appOutDir, electronPlatformName }) => {
    // Installed Chorus workers still require this executable in every Windows candidate.
    // Copy the primary binary before packaging/signing and before delivery hashes the tree.
    if (electronPlatformName === 'win32') {
      await copyFile(join(appOutDir, `${PRODUCT_NAME}.exe`), join(appOutDir, 'Chorus.exe'));
    }
    const provenance = process.env.CHORUS_BUILD_PROVENANCE_JSON;
    if (!provenance) return;
    const resourcesPath = join(appOutDir, 'resources');
    await mkdir(resourcesPath, { recursive: true });
    await writeFile(join(resourcesPath, 'build-provenance.json'), provenance, 'utf8');
  },
  afterSign: async ({ appOutDir, electronPlatformName }) => {
    if (electronPlatformName === 'win32') {
      // electron-builder flips fuses and edits/signs Maestro.exe after afterPack.
      // Refresh the alias so a legacy worker boots the same final binary and cookie store.
      await copyFile(join(appOutDir, `${PRODUCT_NAME}.exe`), join(appOutDir, 'Chorus.exe'));
    }
  },
  asarUnpack: [
    'out/main/adapters/**',
    'node_modules/better-sqlite3/**',
    'node_modules/node-pty/**',
    // Global hold-to-talk keyboard hook: N-API prebuilds are resolved from its folder at runtime.
    'node_modules/uiohook-napi/**',
    // The native addon loads its ONNX runtime DLLs/dylibs/so files from its own directory.
    'node_modules/sherpa-onnx-*/**',
    'node_modules/@parcel/watcher/**',
    '**/*.node',
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Maestro needs microphone access for voice commands and dictation.',
      NSLocalNetworkUsageDescription:
        'Maestro needs local network access to connect to SSH hosts on your network.',
    },
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    icon: 'src/assets/images/chorus/chorus.icns',
    notarize: false,
  },
  dmg: {
    icon: 'src/assets/images/chorus/chorus.icns',
    background: 'build/dmg-background.tiff',
    window: { width: 530, height: 319 },
    contents: [
      { x: 132, y: 150, type: 'file' },
      { x: 398, y: 150, type: 'link', path: '/Applications' },
    ],
  },
  linux: {
    category: 'Development',
    icon: 'src/assets/images/chorus/chorus.png',
    syncDesktopName: true,
    desktop: {
      entry: { StartupWMClass: PRODUCT_NAME },
    },
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
      { target: 'rpm', arch: ['x64'] },
    ],
  },
  win: {
    icon: 'src/assets/images/chorus/chorus.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'msi', arch: ['x64'] },
    ],
    // Signed only on machines set up by scripts/setup-windows-local-signing.ps1 (a locally
    // trusted certificate); otherwise unsigned until release signing lands (docs/chorus/PLAN.md §5.4).
    signtoolOptions: resolveWindowsSigntoolOptions(),
    // Keep publisherName out of app-update.yml. Local builds are signed with a certificate only this
    // machine trusts, so electron-updater's Authenticode check would reject every update on other
    // machines. Update authenticity comes from the Ed25519-signed manifest the app verifies instead
    // (src/main/host/updates/update-manifest-signature.ts).
    verifyUpdateCodeSignature: false,
  },
  msi: {
    oneClick: false,
    perMachine: false,
  },
  nsis: {
    differentialPackage: true,
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
  npmRebuild: false,
  // Encrypt Chromium's on-disk cookie store (in-app browser logins) with OS-level
  // keys, like Chrome does. One-way: never disable once shipped or existing
  // cookie stores become unreadable.
  electronFuses: {
    enableCookieEncryption: true,
  },
};

export default config;
