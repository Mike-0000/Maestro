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
 *
 * A relative rule only reaches into the working directory, so each extra folder gets the same
 * patterns again, anchored at its absolute path.
 */
export function scoutDenyRules(
  extraFolders: readonly string[] = [],
  platform: NodeJS.Platform = process.platform
): string[] {
  const patterns = [
    ...SCOUT_DENY.files,
    ...SCOUT_DENY.directories.map((directory) => `${directory}/**`),
  ];
  const rules = patterns.flatMap((pattern) => [`Read(./${pattern})`, `Read(**/${pattern})`]);
  for (const folder of extraFolders) {
    const root = claudeRulePath(folder, platform);
    rules.push(
      ...patterns.flatMap((pattern) => [`Read(${root}/${pattern})`, `Read(${root}/**/${pattern})`])
    );
  }
  return rules;
}

/**
 * An absolute folder as Claude Code's permission rules write it: `//` and the path in POSIX
 * form. On Windows the drive letter becomes the first segment, so `C:\Users\me` is
 * `//c/Users/me`. The containment self-test proves on each computer that the form is honoured.
 * Only folders that passed `checkScoutFolder` reach here: absolute, with a drive on Windows.
 */
export function claudeRulePath(
  folder: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    const [, letter = '', rest = ''] = /^([A-Za-z]):[\\/]*(.*)$/.exec(folder) ?? [];
    const tail = rest.replace(/\\/g, '/').replace(/\/+$/, '');
    return `//${letter.toLowerCase()}${tail ? `/${tail}` : ''}`;
  }
  return `/${folder.replace(/\/+$/, '')}`;
}

/**
 * The exact content of a scout's settings file: the deny list and, when the developer allowed
 * extra folders, those folders as additional working directories. Nothing else.
 */
export function scoutSettingsContent(
  extraFolders: readonly string[] = [],
  platform: NodeJS.Platform = process.platform
): string {
  const permissions =
    extraFolders.length > 0
      ? { deny: scoutDenyRules(extraFolders, platform), additionalDirectories: [...extraFolders] }
      : { deny: scoutDenyRules() };
  return `${JSON.stringify({ permissions }, null, 2)}\n`;
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
