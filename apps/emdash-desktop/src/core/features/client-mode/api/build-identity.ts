import { z } from 'zod';

/** Which build of Maestro a process is: client and host must run the same one. */
export const buildIdentitySchema = z.object({
  version: z.string(),
  /** The source commit from `build-provenance.json`; null when the build has none. */
  commit: z.string().nullable(),
  /** An unpackaged development run. */
  dev: z.boolean(),
});
export type BuildIdentity = z.infer<typeof buildIdentitySchema>;

/**
 * Two builds can talk when they come from the same commit. When either side does not know its
 * commit, the version strings must match instead.
 */
export function buildsCompatible(a: BuildIdentity, b: BuildIdentity): boolean {
  if (a.commit !== null && b.commit !== null) return a.commit === b.commit;
  return a.version === b.version;
}

/** A short human label for a build, for example `1.4.2 (3f9c2ab)` or `1.4.2 dev`. */
export function describeBuild(build: BuildIdentity): string {
  const parts = [build.version];
  if (build.commit) parts.push(`(${build.commit.slice(0, 7)})`);
  if (build.dev) parts.push('dev');
  return parts.join(' ');
}
