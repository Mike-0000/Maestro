/**
 * What a code scout may never read. One list serves two uses: the deny rules written to the
 * scout's Claude Code settings file, and the check that refuses evidence quoted from such a file.
 * Every entry applies at the project root and at any depth.
 */
export const SCOUT_DENY = {
  /** File names; `*` stands for any run of characters within the name. */
  files: [
    '.env',
    '.env.*',
    '.envrc',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    '*.jks',
    '*.ppk',
    'id_rsa*',
    'id_ed25519*',
    'id_ecdsa*',
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.git-credentials',
    '*.tfvars',
    'terraform.tfstate*',
  ],
  /** Directories; everything under them is denied. */
  directories: ['.git', '.ssh', '.aws', '.kube', '.docker'],
} as const;

/**
 * The `permissions.deny` entries for Claude Code. Its `Read` rules also cover `Grep` and `Glob`.
 * Each pattern is given twice, anchored at the working directory and at any depth, so the list
 * does not depend on how one form treats the root.
 */
export function scoutDenyRules(): string[] {
  const patterns = [
    ...SCOUT_DENY.files,
    ...SCOUT_DENY.directories.map((directory) => `${directory}/**`),
  ];
  return patterns.flatMap((pattern) => [`Read(./${pattern})`, `Read(**/${pattern})`]);
}

/** The exact content of the scout's settings file: a deny list and nothing else. */
export function scoutSettingsContent(): string {
  return `${JSON.stringify({ permissions: { deny: scoutDenyRules() } }, null, 2)}\n`;
}

/** File systems that fold case, where `.ENV` is the same file as `.env`. */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function nameMatcher(pattern: string, insensitive: boolean): RegExp {
  const source = pattern
    .split('*')
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, insensitive ? 'i' : '');
}

/**
 * Whether a path inside the project is on the deny list. It accepts either separator. A denied
 * name is refused wherever it appears in the path, so a directory called `backup.key` hides what
 * is under it: stricter than the rules need, and never looser.
 */
export function isScoutDenied(
  relativePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const insensitive = foldsCase(platform);
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment && segment !== '.');
  const names = [...SCOUT_DENY.files, ...SCOUT_DENY.directories].map((pattern) =>
    nameMatcher(pattern, insensitive)
  );
  return segments.some((segment) => names.some((name) => name.test(segment)));
}
