import type { Configuration } from 'electron-builder';
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
  directories: { output: 'release' },
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
  asarUnpack: [
    'out/main/adapters/**',
    'node_modules/better-sqlite3/**',
    'node_modules/node-pty/**',
    // Global hold-to-talk keyboard hook: N-API prebuilds are resolved from its folder at runtime.
    'node_modules/uiohook-napi/**',
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
