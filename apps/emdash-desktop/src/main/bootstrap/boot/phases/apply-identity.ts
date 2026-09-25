import { join } from 'node:path';
import { app } from 'electron';
import { log } from '@main/lib/logger';
import type { AppConfig } from '../../core/config';
import { markUserDataConfigured } from '../../core/config';
import { importEmdashProfileOnce } from './import-emdash-profile';

export function applyIdentity(config: AppConfig): void {
  app.setName(config.identity.productName);
  // EMDASH_USER_DATA_DIR redirects the whole profile (DB, logs, mementos) to an
  // isolated directory — used by the boot-measurement harness and scratch profiles.
  const userDataPath =
    config.userDataDir ?? join(app.getPath('appData'), config.identity.userDataDirName);
  if (!config.userDataDir && !config.isDev && !config.identity.isCanary) {
    importLegacyProfile(join(app.getPath('appData'), 'emdash'), userDataPath);
  }
  app.setPath('userData', userDataPath);
  markUserDataConfigured();
}

function importLegacyProfile(sourcePath: string, targetPath: string): void {
  try {
    const result = importEmdashProfileOnce({ sourcePath, targetPath });
    if (result.kind === 'imported' || result.kind === 'deferred') {
      log.info('apply-identity: Emdash profile import', { sourcePath, targetPath, ...result });
    }
  } catch (error) {
    // No marker is written, so the import is retried on the next launch.
    log.error('apply-identity: Emdash profile import failed', {
      sourcePath,
      targetPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
