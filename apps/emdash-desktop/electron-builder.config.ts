import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Configuration } from 'electron-builder';
import { LOCAL_TTS_MODEL_DIR, prepareLocalTtsModel } from './scripts/prepare-local-tts-model.ts';
import {
  APP_ID,
  ARTIFACT_PREFIX,
  LINUX_DESKTOP_ID,
  PRODUCT_NAME,
  R2_BASE_URL,
  UPDATE_CHANNEL,
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
      url: R2_BASE_URL,
      channel: UPDATE_CHANNEL,
    },
  ],
  generateUpdatesFilesForAllChannels: false,
  files: ['out/**/*', 'node_modules/**/*', 'drizzle/**/*'],
  // The pinned, checksum-verified offline model ships with every installer; no first-run download.
  beforePack: async () => prepareLocalTtsModel(),
  extraResources: [
    { from: LOCAL_TTS_MODEL_DIR, to: 'models/kitten-mini-en-v0_8' },
    {
      from: '../../tooling/chorus-delivery/install-chorus-update.ps1',
      to: 'chorus-delivery/install-chorus-update.ps1',
    },
  ],
  afterPack: async ({ appOutDir }) => {
    const provenance = process.env.CHORUS_BUILD_PROVENANCE_JSON;
    if (!provenance) return;
    const resourcesPath = join(appOutDir, 'resources');
    await mkdir(resourcesPath, { recursive: true });
    await writeFile(join(resourcesPath, 'build-provenance.json'), provenance, 'utf8');
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
        'Chorus needs microphone access for voice commands and dictation.',
      NSLocalNetworkUsageDescription:
        'Chorus needs local network access to connect to SSH hosts on your network.',
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
    // Chorus has no signing identity yet (see docs/chorus/PLAN.md §5.4); builds are unsigned.
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
