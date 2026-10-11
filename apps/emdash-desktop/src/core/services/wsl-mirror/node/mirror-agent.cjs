'use strict';
/**
 * One side of a live mirror between a Windows folder and its copy inside a WSL2 distro.
 *
 * The same program runs on both sides, so both read the tree by the same rules: in the desktop
 * app as a worker thread (messages over the parent port), and in the distro as a Node process
 * (one JSON message per line on stdin and stdout). It has no dependencies.
 *
 * An agent only ever reports what is on its own disk and changes its own disk. The one
 * exception is `stage`, on the side that can see the other one's folder (the distro, through
 * the drive mount): it copies file contents across into a temporary file, and the side that
 * owns the destination then checks and renames it into place itself (`commit`). Every check
 * against "what the plan assumed" is therefore made natively, by the side that owns the file.
 *
 * Nothing here decides what to copy or delete. That is the session's job; see mirror-plan.ts.
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/** Temporary files of a copy in flight. Never mirrored, and cleared when left behind. */
const TEMP_PREFIX = '.~mirror-';
const STALE_TEMP_MS = 60 * 60 * 1000;
const TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DIRTY = 3000;
const NOTIFY_DELAY_MS = 60;
/** State files in `.git` whose change means refs, HEAD, or an operation in progress changed. */
const GIT_STATE_NAMES = new Set([
  'HEAD',
  'packed-refs',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'index.lock',
  'rebase-merge',
  'rebase-apply',
]);
const GIT_BUSY_NAMES = [
  'index.lock',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'rebase-merge',
  'rebase-apply',
];

let cfg = null;
let gitEnabled = false;
/** Paths git ignores, as it lists them: a whole ignored directory is one entry. */
let ignored = new Set();
/** What the last scans reported, path to kind, to tell a new path from a known one. */
let known = new Map();
let dirty = new Set();
let dirtyAll = false;
let gitDirty = false;
let links = 0;
let watchDegraded = false;
let notifyTimer = null;
let rootWatcher = null;
const dirWatchers = new Map();
const gitWatchers = new Map();
let preserveMatchers = [];

// ── transport ──────────────────────────────────────────────────────────────────────────────

let workerPort = null;
try {
  const workerThreads = require('node:worker_threads');
  if (!workerThreads.isMainThread) workerPort = workerThreads.parentPort;
} catch {}

function send(message) {
  if (workerPort) workerPort.postMessage(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
}

function receive(message) {
  const { id, method, params } = message;
  const run = methods[method];
  if (!run) {
    send({ id, ok: false, error: `Unknown method: ${method}` });
    return;
  }
  Promise.resolve()
    .then(() => run(params || {}))
    .then(
      (result) => send({ id, ok: true, result }),
      (error) => send({ id, ok: false, error: String((error && error.message) || error) })
    );
}

if (workerPort) {
  workerPort.on('message', receive);
} else {
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      try {
        receive(JSON.parse(line));
      } catch (error) {
        send({ event: 'protocol-error', error: String(error) });
      }
    }
  });
  // The app going away must take this process with it.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
}

// ── paths and rules ────────────────────────────────────────────────────────────────────────

function abs(rel) {
  return rel ? path.join(cfg.root, ...rel.split('/')) : cfg.root;
}

function peerAbs(rel) {
  return rel ? path.join(cfg.peerRoot, ...rel.split('/')) : cfg.peerRoot;
}

function parentOf(rel) {
  const at = rel.lastIndexOf('/');
  return at < 0 ? '' : rel.slice(0, at);
}

function baseOf(rel) {
  const at = rel.lastIndexOf('/');
  return at < 0 ? rel : rel.slice(at + 1);
}

/** Windows and macOS find `Foo.txt` when asked for `foo.txt`; the distro does not. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * `lstat` that answers only for the name exactly as written. Where the disk ignores case, a
 * file whose name differs only in case is not this file: it fails with `ECASE`, so a caller
 * can neither take it for the file nor write over it. `listings` saves reading a folder twice.
 */
async function lstatExact(rel, listings) {
  const stat = await fsp.lstat(abs(rel));
  if (!CASE_INSENSITIVE || rel === '') return stat;
  const parent = parentOf(rel);
  let names = listings ? listings.get(parent) : undefined;
  if (!names) {
    names = new Set(await fsp.readdir(abs(parent)));
    if (listings) listings.set(parent, names);
  }
  if (names.has(baseOf(rel))) return stat;
  const error = new Error(`Another file is named like ${rel}, in different case.`);
  error.code = 'ECASE';
  throw error;
}

function hardExcluded(name) {
  return cfg.hardExcludes.has(name) || name.startsWith(TEMP_PREFIX);
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else source += '[^/]*';
    } else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * Ignored files worth mirroring anyway (`.env`, local settings). A pattern without a slash
 * names a file wherever git lists it as ignored; one with a slash is a path from the root, and
 * may reach into an ignored directory.
 */
function compilePreserve(patterns) {
  return patterns
    .map((pattern) => String(pattern).trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean)
    .map((pattern) => {
      const anywhere = !pattern.includes('/');
      const wildcard = pattern.search(/[*?]/);
      return {
        anywhere,
        test: globToRegExp(pattern),
        literal: wildcard < 0 ? pattern : pattern.slice(0, wildcard),
      };
    });
}

function matchesPreserve(rel, insideIgnoredDirectory) {
  for (const matcher of preserveMatchers) {
    if (matcher.anywhere) {
      if (!insideIgnoredDirectory && matcher.test.test(baseOf(rel))) return true;
    } else if (matcher.test.test(rel)) return true;
  }
  return false;
}

function couldContainPreserved(relDir) {
  const prefix = `${relDir}/`;
  return preserveMatchers.some(
    (matcher) => !matcher.anywhere && matcher.literal.startsWith(prefix)
  );
}

/** The topmost ignored ancestor of a path (or the path itself), or null. */
function ignoredAncestor(rel) {
  if (ignored.size === 0) return null;
  let at = rel.indexOf('/');
  while (at >= 0) {
    const prefix = rel.slice(0, at);
    if (ignored.has(prefix)) return prefix;
    at = rel.indexOf('/', at + 1);
  }
  return ignored.has(rel) ? rel : null;
}

function hasExcludedSegment(rel) {
  for (const segment of rel.split('/')) if (hardExcluded(segment)) return true;
  return false;
}

/** Whether a path can be part of the mirror at all, by its name and git's ignore rules. */
function mirrored(rel, isFile) {
  if (hasExcludedSegment(rel)) return false;
  const ancestor = ignoredAncestor(rel);
  if (ancestor === null) return true;
  if (ancestor === rel) return isFile ? matchesPreserve(rel, false) : couldContainPreserved(rel);
  return couldContainPreserved(ancestor) && (!isFile || matchesPreserve(rel, true));
}

// ── git ────────────────────────────────────────────────────────────────────────────────────

function git(args, input) {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      {
        cwd: cfg.root,
        maxBuffer: 512 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

function mirrorDir() {
  return path.join(cfg.root, '.git', 'maestro-mirror');
}

function expandGitArg(arg) {
  return arg
    .replace('{mirrorDir}', () => mirrorDir())
    .replace('{peerMirrorDir}', () =>
      cfg.peerRoot ? path.join(cfg.peerRoot, '.git', 'maestro-mirror') : ''
    );
}

async function refreshIgnored() {
  if (!gitEnabled) return { added: [], removed: [] };
  const listed = await git([
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
  ]);
  if (listed.code !== 0) return { added: [], removed: [] };
  const next = new Set();
  for (const entry of listed.stdout.split('\0')) {
    if (entry) next.add(entry.endsWith('/') ? entry.slice(0, -1) : entry);
  }
  const added = [];
  const removed = [];
  for (const entry of next) if (!ignored.has(entry)) added.push(entry);
  for (const entry of ignored) if (!next.has(entry)) removed.push(entry);
  ignored = next;
  return { added, removed };
}

async function exists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function gitState() {
  if (!gitEnabled) return { enabled: false };
  const gitDir = path.join(cfg.root, '.git');
  let busy = false;
  for (const name of GIT_BUSY_NAMES) {
    if (await exists(path.join(gitDir, name))) busy = true;
  }
  const [symbolic, head, listed] = await Promise.all([
    git(['symbolic-ref', '-q', 'HEAD']),
    git(['rev-parse', '-q', '--verify', 'HEAD^{commit}']),
    git([
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      'refs/heads',
      'refs/tags',
      'refs/remotes',
    ]),
  ]);
  if (listed.code !== 0) throw new Error(listed.stderr.trim() || 'git for-each-ref failed');
  const refs = {};
  for (const line of listed.stdout.split('\n')) {
    const at = line.indexOf(' ');
    if (at <= 0) continue;
    const name = line.slice(at + 1).trim();
    // A remote's HEAD is a pointer to one of its branches, not a ref of its own.
    if (name.startsWith('refs/remotes/') && name.endsWith('/HEAD')) continue;
    refs[name] = line.slice(0, at);
  }
  if (cfg.watchMode === 'tree') watchGitRefs();
  return {
    enabled: true,
    busy,
    head: {
      ref: symbolic.code === 0 ? symbolic.stdout.trim() : null,
      oid: head.code === 0 ? head.stdout.trim() : null,
    },
    refs,
  };
}

// ── watching ───────────────────────────────────────────────────────────────────────────────

function notifySoon() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    send({ event: 'dirty' });
  }, NOTIFY_DELAY_MS);
}

function isGitStatePath(rel) {
  const inner = rel.slice('.git/'.length);
  if (inner.startsWith('refs/maestro-mirror')) return false;
  if (inner.startsWith('refs/')) return !inner.endsWith('.lock');
  const first = inner.split('/')[0];
  return GIT_STATE_NAMES.has(first);
}

function onFileEvent(rel) {
  if (rel === null) {
    dirtyAll = true;
    notifySoon();
    return;
  }
  if (rel === '.git' || rel.startsWith('.git/')) {
    if (gitEnabled && rel !== '.git' && isGitStatePath(rel)) {
      gitDirty = true;
      notifySoon();
    }
    return;
  }
  if (hasExcludedSegment(rel)) return;
  const ancestor = ignoredAncestor(rel);
  if (ancestor !== null && ancestor !== rel && !couldContainPreserved(ancestor)) return;
  dirty.add(rel);
  notifySoon();
}

function degrade(error) {
  if (watchDegraded) return;
  watchDegraded = true;
  send({ event: 'watch-degraded', error: String((error && error.message) || error) });
}

function unwatchDirectory(relDir) {
  const entry = dirWatchers.get(relDir);
  if (!entry) return false;
  entry.watcher.close();
  dirWatchers.delete(relDir);
  return true;
}

/**
 * What tells one folder from another at the same path. The inode number alone does not: a
 * Linux disk hands the number of a folder just removed to the next one made.
 */
function directoryIdentity(relDir) {
  const stat = fs.statSync(abs(relDir), { bigint: true });
  return `${stat.ino}:${stat.birthtimeNs}`;
}

/** True when the folder at a watched path is no longer the one being watched. */
function directoryReplaced(relDir) {
  const entry = dirWatchers.get(relDir);
  if (!entry) return false;
  try {
    return directoryIdentity(relDir) !== entry.ino;
  } catch {
    return false;
  }
}

function watchDirectory(relDir) {
  if (cfg.watchMode !== 'tree' || watchDegraded) return;
  // A folder that was removed and made again is a new folder: the old watch sees nothing.
  let ino;
  try {
    ino = directoryIdentity(relDir);
  } catch {
    return;
  }
  const existing = dirWatchers.get(relDir);
  if (existing) {
    if (existing.ino === ino) return;
    unwatchDirectory(relDir);
  }
  try {
    const watcher = fs.watch(abs(relDir), { persistent: true }, (_type, filename) => {
      if (filename === null || filename === undefined) onFileEvent(relDir || null);
      else onFileEvent(relDir ? `${relDir}/${filename}` : String(filename));
    });
    watcher.on('error', () => {
      if (dirWatchers.get(relDir)?.watcher === watcher) dirWatchers.delete(relDir);
      watcher.close();
      onFileEvent(relDir || null);
    });
    dirWatchers.set(relDir, { watcher, ino });
  } catch (error) {
    if (error && (error.code === 'ENOSPC' || error.code === 'EMFILE')) degrade(error);
  }
}

/** In tree mode `.git` and everything under `.git/refs` is watched, one directory at a time. */
function watchGitRefs() {
  if (!gitEnabled || watchDegraded) return;
  const visit = (dir, rel) => {
    if (!gitWatchers.has(rel)) {
      try {
        const watcher = fs.watch(dir, { persistent: true }, (_type, filename) => {
          if (filename) onFileEvent(`${rel}/${filename}`);
        });
        watcher.on('error', () => {
          watcher.close();
          gitWatchers.delete(rel);
        });
        gitWatchers.set(rel, watcher);
      } catch (error) {
        if (error && (error.code === 'ENOSPC' || error.code === 'EMFILE')) degrade(error);
        return;
      }
    }
    if (rel === '.git') {
      visit(path.join(dir, 'refs'), '.git/refs');
      return;
    }
    let children = [];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {}
    for (const child of children) {
      if (child.isDirectory() && child.name !== 'maestro-mirror') {
        visit(path.join(dir, child.name), `${rel}/${child.name}`);
      }
    }
  };
  visit(path.join(cfg.root, '.git'), '.git');
}

function startWatching() {
  if (cfg.watchMode === 'none') return;
  if (cfg.watchMode === 'tree') {
    watchGitRefs();
    return;
  }
  try {
    rootWatcher = fs.watch(cfg.root, { recursive: true, persistent: true }, (_type, filename) => {
      onFileEvent(
        filename === null || filename === undefined ? null : String(filename).replace(/\\/g, '/')
      );
    });
    rootWatcher.on('error', (error) => {
      send({ event: 'watch-error', error: String((error && error.message) || error) });
    });
  } catch (error) {
    degrade(error);
  }
}

// ── reading the tree ───────────────────────────────────────────────────────────────────────

async function walk(relDir, ignoredMode, out, visited) {
  // Watched before it is read, so nothing created in between goes unseen.
  if (!ignoredMode) watchDirectory(relDir);
  let children;
  try {
    children = await fsp.readdir(abs(relDir), { withFileTypes: true });
  } catch (error) {
    // The root has to be readable; anything below it may vanish while it is being read.
    if (relDir === '') throw error;
    return;
  }
  if (!ignoredMode && visited) visited.add(relDir);
  const files = [];
  for (const child of children) {
    const name = child.name;
    const rel = relDir ? `${relDir}/${name}` : name;
    if (hardExcluded(name)) {
      if (name.startsWith(TEMP_PREFIX)) void dropStaleTemp(abs(rel));
      continue;
    }
    if (child.isSymbolicLink()) {
      links += 1;
      continue;
    }
    const isIgnored = ignoredMode || ignored.has(rel);
    if (child.isDirectory()) {
      if (isIgnored) {
        if (couldContainPreserved(rel)) await walk(rel, true, out, visited);
        continue;
      }
      out.push([rel, 'd', 0, 0]);
      await walk(rel, false, out, visited);
    } else if (child.isFile()) {
      if (isIgnored && !matchesPreserve(rel, ignoredMode)) continue;
      files.push(rel);
    }
  }
  const stats = await Promise.all(files.map((rel) => fsp.lstat(abs(rel)).catch(() => null)));
  for (let i = 0; i < files.length; i += 1) {
    const stat = stats[i];
    if (stat && stat.isFile()) out.push([files[i], 'f', stat.size, stat.mtimeMs]);
  }
}

async function dropStaleTemp(target) {
  try {
    const stat = await fsp.lstat(target);
    if (Date.now() - stat.mtimeMs > STALE_TEMP_MS) await fsp.unlink(target);
  } catch {}
}

async function scan() {
  // Events that arrive while the tree is being read stay for the next rescan.
  dirty = new Set();
  dirtyAll = false;
  links = 0;
  await refreshIgnored();
  const out = [];
  const visited = new Set();
  await walk('', false, out, visited);
  for (const relDir of [...dirWatchers.keys()]) {
    if (!visited.has(relDir)) unwatchDirectory(relDir);
  }
  known = new Map(out.map((entry) => [entry[0], entry[1]]));
  return { entries: out, links, gitDirty: takeGitDirty() };
}

function takeGitDirty() {
  const was = gitDirty;
  gitDirty = false;
  return was;
}

function forget(prefix) {
  known.delete(prefix);
  const under = `${prefix}/`;
  for (const key of known.keys()) if (key.startsWith(under)) known.delete(key);
  for (const relDir of [...dirWatchers.keys()]) {
    if (relDir === prefix || relDir.startsWith(under)) unwatchDirectory(relDir);
  }
}

/**
 * Reads again only what changed since the last scan. `removed` are paths that are gone, each
 * standing for everything under it; `entries` are what is there now. `full` asks for a scan
 * instead, when too much changed to tell.
 */
async function rescan() {
  if (dirtyAll || dirty.size > MAX_DIRTY) return { full: true, gitDirty: takeGitDirty() };
  const taken = [...dirty];
  dirty = new Set();
  const gitChanged = takeGitDirty();
  if (taken.length === 0) return { removed: [], entries: [], gitDirty: gitChanged };

  // A changed directory is read one level deep: its own files report their own changes.
  const candidates = new Set();
  const vanished = new Set();
  const listings = new Map();
  let childrenOf = null;
  for (const rel of taken) {
    candidates.add(rel);
    // Removed and made again since it was read: nothing known about it still holds.
    if (known.get(rel) === 'd' && directoryReplaced(rel)) vanished.add(rel);
    if (known.get(rel) !== 'd' || vanished.has(rel)) continue;
    let names;
    try {
      names = await fsp.readdir(abs(rel));
    } catch {
      continue;
    }
    if (!childrenOf) {
      childrenOf = new Map();
      for (const key of known.keys()) {
        const parent = parentOf(key);
        let set = childrenOf.get(parent);
        if (!set) childrenOf.set(parent, (set = new Set()));
        set.add(key);
      }
    }
    const present = new Set();
    for (const name of names) {
      const child = `${rel}/${name}`;
      present.add(child);
      if (!known.has(child)) candidates.add(child);
    }
    for (const child of childrenOf.get(rel) || []) if (!present.has(child)) vanished.add(child);
  }

  let needRules = false;
  for (const rel of candidates) {
    if (!known.has(rel) || baseOf(rel) === '.gitignore') {
      needRules = true;
      break;
    }
  }
  const removed = [...vanished];
  for (const rel of vanished) forget(rel);
  if (needRules) {
    const delta = await refreshIgnored();
    // Newly ignored paths leave the mirror; paths no longer ignored are read like new ones.
    for (const rel of delta.added) {
      const kind = known.get(rel);
      if (kind === undefined) continue;
      if (kind === 'f' ? matchesPreserve(rel, false) : false) continue;
      removed.push(rel);
      forget(rel);
    }
    for (const rel of delta.removed) candidates.add(rel);
  }

  const ordered = [...candidates].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const entries = [];
  let covered = null;
  for (const rel of ordered) {
    // A directory read in full below already covers everything under it.
    if (covered !== null && rel.startsWith(covered)) continue;
    let stat = null;
    try {
      stat = await lstatExact(rel, listings);
    } catch {}
    if (!stat || stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) {
      // Reported even when it was never seen here: the session may know it from a step it
      // had this side carry out.
      removed.push(rel);
      forget(rel);
      continue;
    }
    const isFile = stat.isFile();
    if (!mirrored(rel, isFile)) {
      if (known.has(rel)) {
        removed.push(rel);
        forget(rel);
      }
      continue;
    }
    if (isFile) {
      if (known.get(rel) === 'd') {
        removed.push(rel);
        forget(rel);
      }
      entries.push([rel, 'f', stat.size, stat.mtimeMs]);
      known.set(rel, 'f');
      continue;
    }
    if (known.get(rel) === 'd') continue;
    if (known.has(rel)) {
      removed.push(rel);
      forget(rel);
    }
    const ancestor = ignoredAncestor(rel);
    const out = [];
    if (ancestor === null) out.push([rel, 'd', 0, 0]);
    await walk(rel, ancestor !== null, out, null);
    for (const entry of out) {
      entries.push(entry);
      known.set(entry[0], entry[1]);
    }
    covered = `${rel}/`;
  }
  return { removed, entries, gitDirty: gitChanged };
}

/**
 * What is at each path, whether mirrored or not: a kind, or null for nothing. `c` is a file
 * of the same name in different case, which only a disk that ignores case can report.
 */
async function statPaths(paths) {
  const listings = new Map();
  return Promise.all(
    paths.map(async (rel) => {
      try {
        const stat = await lstatExact(rel, listings);
        if (stat.isSymbolicLink()) return [rel, 'l', 0, 0];
        if (stat.isDirectory()) return [rel, 'd', 0, 0];
        if (stat.isFile()) return [rel, 'f', stat.size, stat.mtimeMs];
        return [rel, 'o', 0, 0];
      } catch (error) {
        const code = error && error.code;
        // A parent that is a file, not a folder, means there is nothing at the path either.
        if (code === 'ENOENT' || code === 'ENOTDIR') return [rel, null, 0, 0];
        return [rel, code === 'ECASE' ? 'c' : 'e', 0, 0];
      }
    })
  );
}

function hashFile(target) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(target);
    stream.on('error', () => resolve(null));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function hashPaths(paths) {
  const out = [];
  for (const rel of paths) out.push([rel, await hashFile(abs(rel))]);
  return out;
}

// ── changing the tree ──────────────────────────────────────────────────────────────────────

function sameStat(stat, expect) {
  return stat.isFile() && stat.size === expect.size && stat.mtimeMs === expect.mtimeMs;
}

/**
 * Moves a file out of the tree instead of destroying it. In a repository that is a folder
 * inside `.git`, which is on the same disk and which git and the mirror both leave alone;
 * elsewhere there is no such place, and the file is kept next to itself under another name.
 */
async function setAside(rel, stamp) {
  const from = abs(rel);
  if (gitEnabled) {
    const to = path.join(mirrorDir(), 'trash', stamp, ...rel.split('/'));
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return;
  }
  await fsp.rename(from, `${from}.mirror-conflict-${stamp}`);
}

async function removePaths({ items, stamp }) {
  const results = [];
  for (const item of items) {
    const target = abs(item.path);
    try {
      if (item.kind === 'd') {
        // On Windows a watched folder is held open and cannot go while it is watched.
        const watched = unwatchDirectory(item.path);
        try {
          await fsp.rmdir(target);
        } catch (error) {
          if (watched && error && error.code !== 'ENOENT') watchDirectory(item.path);
          throw error;
        }
        forget(item.path);
        results.push('ok');
        continue;
      }
      const stat = await lstatExact(item.path);
      if (!sameStat(stat, item)) {
        results.push('changed');
        continue;
      }
      // `keep`: the file is not known to exist anywhere else, so it is never destroyed.
      if (gitEnabled || item.keep) await setAside(item.path, stamp);
      else await fsp.unlink(target);
      known.delete(item.path);
      results.push('ok');
    } catch (error) {
      const code = error && error.code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ECASE') results.push('gone');
      else if (code === 'ENOTEMPTY' || code === 'EEXIST') results.push('notEmpty');
      else results.push(`error:${code || String(error)}`);
    }
  }
  return results;
}

async function makeDirectories({ paths }) {
  const results = [];
  for (const rel of paths) {
    try {
      await fsp.mkdir(abs(rel), { recursive: true });
      known.set(rel, 'd');
      watchDirectory(rel);
      results.push('ok');
    } catch (error) {
      results.push(`error:${(error && error.code) || String(error)}`);
    }
  }
  return results;
}

async function flush(target) {
  const handle = await fsp.open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Copies contents across into temporary files, on the side that can see both folders.
 * `toPeer` are this side's files, checked against the plan before and after the read;
 * `fromPeer` are the other side's, which it checks itself afterwards.
 */
async function stage({ toPeer, fromPeer }) {
  const sent = [];
  for (const item of toPeer || []) {
    const source = abs(item.path);
    const temp = path.join(path.dirname(peerAbs(item.path)), item.tmp);
    try {
      const before = await lstatExact(item.path);
      if (!sameStat(before, item)) {
        sent.push('changed');
        continue;
      }
      await fsp.mkdir(path.dirname(temp), { recursive: true });
      await fsp.copyFile(source, temp);
      await flush(temp);
      const after = await fsp.lstat(source);
      if (!sameStat(after, item)) {
        await fsp.unlink(temp).catch(() => {});
        sent.push('changed');
        continue;
      }
      sent.push('ok');
    } catch (error) {
      await fsp.unlink(temp).catch(() => {});
      const code = error && error.code;
      const moved = code === 'ENOENT' || code === 'ENOTDIR' || code === 'ECASE';
      sent.push(moved ? 'changed' : `error:${code || String(error)}`);
    }
  }
  const fetched = [];
  for (const item of fromPeer || []) {
    const temp = path.join(path.dirname(abs(item.path)), item.tmp);
    try {
      await fsp.mkdir(path.dirname(temp), { recursive: true });
      await fsp.copyFile(peerAbs(item.path), temp);
      fetched.push('ok');
    } catch (error) {
      await fsp.unlink(temp).catch(() => {});
      const code = error && error.code;
      fetched.push(code === 'ENOENT' ? 'changed' : `error:${code || String(error)}`);
    }
  }
  return { toPeer: sent, fromPeer: fetched };
}

async function startsWithShebang(target) {
  let handle;
  try {
    handle = await fsp.open(target, 'r');
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    return bytesRead === 2 && buffer[0] === 0x23 && buffer[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function renameIntoPlace(temp, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(temp, target);
      return;
    } catch (error) {
      const code = error && error.code;
      const held = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!held || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

/**
 * Puts staged files in place on the side that owns them. The destination must still be what
 * the plan saw (`expect`, or absent); otherwise the staged copy is dropped and the next round
 * decides again. `backup` keeps the replaced file, for the losing side of a conflict.
 */
async function commit({ items, stamp }) {
  const results = [];
  for (const item of items) {
    const target = abs(item.path);
    const temp = path.join(path.dirname(target), item.tmp);
    try {
      let current = null;
      try {
        current = await lstatExact(item.path);
      } catch (error) {
        if (error && error.code === 'ECASE') {
          // Renaming over it would replace a different file that merely shares the name.
          await fsp.unlink(temp).catch(() => {});
          results.push({ status: 'case' });
          continue;
        }
        if (!error || error.code !== 'ENOENT') throw error;
      }
      const asExpected = item.expect
        ? current !== null && sameStat(current, item.expect)
        : current === null;
      if (!asExpected) {
        await fsp.unlink(temp).catch(() => {});
        results.push({ status: 'changed' });
        continue;
      }
      if (process.platform !== 'win32') {
        if (current) await fsp.chmod(temp, current.mode & 0o777);
        else if (await startsWithShebang(temp)) await fsp.chmod(temp, 0o755);
      }
      await fsp.utimes(temp, new Date(), new Date(item.mtimeMs));
      if (current && item.backup) await setAside(item.path, stamp);
      await renameIntoPlace(temp, target);
      const stat = await fsp.lstat(target);
      known.set(item.path, 'f');
      results.push({ status: 'ok', size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      await fsp.unlink(temp).catch(() => {});
      const code = error && error.code;
      const held = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      results.push({ status: held ? 'busy' : `error:${code || String(error)}` });
    }
  }
  return results;
}

async function discard({ items }) {
  for (const item of items) {
    await fsp.unlink(path.join(path.dirname(abs(item.path)), item.tmp)).catch(() => {});
  }
  return true;
}

async function pruneMirrorDir() {
  const trash = path.join(mirrorDir(), 'trash');
  let names = [];
  try {
    names = await fsp.readdir(trash);
  } catch {}
  for (const name of names) {
    try {
      const target = path.join(trash, name);
      const stat = await fsp.lstat(target);
      if (Date.now() - stat.mtimeMs > TRASH_KEEP_MS) {
        await fsp.rm(target, { recursive: true, force: true });
      }
    } catch {}
  }
  try {
    for (const name of await fsp.readdir(mirrorDir())) {
      if (name.endsWith('.bundle')) await fsp.unlink(path.join(mirrorDir(), name)).catch(() => {});
    }
  } catch {}
}

async function init(params) {
  cfg = {
    root: params.root,
    peerRoot: params.peerRoot || null,
    hardExcludes: new Set(params.hardExcludes || ['.git', 'node_modules']),
    watchMode: params.watchMode || (process.platform === 'linux' ? 'tree' : 'recursive'),
  };
  preserveMatchers = compilePreserve(params.preserve || []);
  const rootStat = await fsp.stat(cfg.root);
  if (!rootStat.isDirectory()) throw new Error(`Not a folder: ${cfg.root}`);
  // Only a real `.git` folder: a linked worktree or submodule keeps its git state elsewhere.
  gitEnabled = false;
  if (params.git !== false) {
    try {
      gitEnabled = (await fsp.lstat(path.join(cfg.root, '.git'))).isDirectory();
    } catch {}
    if (gitEnabled && (await git(['rev-parse', '--git-dir'])).code !== 0) gitEnabled = false;
  }
  if (gitEnabled) {
    await fsp.mkdir(mirrorDir(), { recursive: true });
    await pruneMirrorDir();
  }
  startWatching();
  return { platform: process.platform, gitEnabled, watchMode: cfg.watchMode };
}

const methods = {
  init,
  scan,
  rescan,
  stat: ({ paths }) => statPaths(paths),
  hash: ({ paths }) => hashPaths(paths),
  mkdir: makeDirectories,
  remove: removePaths,
  stage,
  commit,
  discard,
  gitState,
  git: ({ args, input }) => git(args.map(expandGitArg), input),
  /** Removes a bundle the two sides exchanged objects in; only a plain name is accepted. */
  dropMirrorFile: async ({ name }) => {
    if (gitEnabled && /^[\w.-]+$/.test(name)) {
      await fsp.unlink(path.join(mirrorDir(), name)).catch(() => {});
    }
    return true;
  },
  markDirty: () => {
    dirtyAll = true;
    return true;
  },
};
