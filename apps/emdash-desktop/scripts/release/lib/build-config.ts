import type { Configuration } from 'electron-builder';

export function createReleaseBuildConfig(
  baseConfig: Configuration,
  electronVersion: string,
  versionOverride?: string
): Configuration {
  // electron-builder mutates config.files while normalizing it. Each architecture
  // needs its own copy, including nested metadata and platform configuration.
  // Keep executable packaging hooks by reference; structuredClone cannot clone functions.
  const { beforePack, afterPack, ...cloneableConfig } = baseConfig;
  const config = structuredClone(cloneableConfig);
  return {
    ...config,
    ...(beforePack ? { beforePack } : {}),
    ...(afterPack ? { afterPack } : {}),
    electronVersion,
    npmRebuild: false,
    ...(versionOverride === undefined
      ? {}
      : { extraMetadata: { ...config.extraMetadata, version: versionOverride } }),
  };
}
