import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import {
  ScmProvider,
  truncatePatch,
  MAX_SCM_FILES_TOTAL,
  MAX_FILE_BYTES,
  FETCH_TIMEOUT_MS,
  isGitObjectId,
  type RerunDispatchRequest,
  type RerunDispatchResult,
} from './ScmProvider';
import type {
  ChangedFile,
  ScmChanges,
  ScmCommitAuthor,
  ScmCommitDetail,
  ScmCommitStatus,
  ScmEntityRef,
  ScmFileContent,
  ScmFileEdit,
  ScmPullRequest,
  CreatePullRequestInput,
  ScmPostedComment,
} from './ScmProvider';
import { isValidGitRef } from './refs';
import { TtlCache } from '../ttl-cache';
import { desktopLinkedFolder } from '../desktop-links';
import type { CiRerunSettings } from '#shared/ci-rerun';
import type { ScmProviderName } from '#shared/scm-urls';

// The demo's service worker bundles this module through `createScmProvider` and
// has no `process`: read it inside functions only, never at module level.

/** Cap on what one git command may print; past it the output is cut and the command stopped. */
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Cap on the patch text of one diff. Files past it keep their counts but carry no patch. */
const MAX_LOCAL_PATCH_BYTES = 8 * 1024 * 1024;
/** Most commits a range lists; past it, the newest are kept. */
const MAX_RANGE_COMMITS = 250;

interface GitOutput {
  ok: boolean;
  stdout: string;
  /** The output reached the byte cap and was cut there. */
  overflow: boolean;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

let cachedGit: string | undefined;

/**
 * `git` on the PATH, then in the folders it installs to that a GUI-launched app
 * may not have on its PATH. Only a hit is cached, so installing git later works.
 */
function resolveGitBinary(): string | null {
  if (cachedGit) return cachedGit;
  const isWindows = process.platform === 'win32';
  const name = isWindows ? 'git.exe' : 'git';
  const extra = isWindows
    ? [
        process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'cmd'),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'),
      ]
    : ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), ...extra]) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isFile(candidate)) {
      cachedGit = candidate;
      return candidate;
    }
  }
  return null;
}

/**
 * Run git in `cwd` and collect its output up to `maxBytes`. Never throws: a
 * missing git, a non-zero exit or a timeout come back as `ok: false`. Reaching
 * the cap stops the command and comes back `ok` with `overflow` set.
 */
function runGit(cwd: string, args: string[], maxBytes = MAX_GIT_OUTPUT_BYTES): Promise<GitOutput> {
  const bin = resolveGitBinary();
  if (!bin) return Promise.resolve({ ok: false, stdout: '', overflow: false });
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ ok, stdout: Buffer.concat(chunks).toString('utf8'), overflow });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['-c', 'core.quotePath=false', ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, FETCH_TIMEOUT_MS);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (overflow) return;
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        overflow = true;
        child.kill();
        finish(true);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/** Non-empty lines of a command's output. */
function lines(out: string): string[] {
  return out.split('\n').filter((l) => l.length > 0);
}

/** Records printed with `%x1e` after each and `%x1f` between fields. */
function parseRecords(out: string): string[][] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => r.split('\x1f'));
}

/**
 * The repository a remote URL names, as lower-cased `host/path`: the same for
 * its HTTPS, SSH and scp-like (`git@host:owner/repo`) forms, with or without a
 * user, credentials or a `.git` suffix. Null for a URL with no host, such as a
 * local path.
 */
export function remoteKey(url: string): string | null {
  let u = url.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    const scp = u.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (!scp) return null;
    u = `ssh://${scp[1]}/${scp[2]}`;
  }
  try {
    const parsed = new URL(u);
    const path = parsed.pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/, '')
      .toLowerCase();
    return parsed.hostname && path ? `${parsed.hostname.toLowerCase()}/${path}` : null;
  } catch {
    return null;
  }
}

/** The nearest folder at or above `folder` holding a `.git` entry (a directory, or a file in a worktree). */
function findRepoRoot(folder: string): string | null {
  let dir = resolve(folder);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The remote of the clone at `root` that points at `repositoryUrl`, `origin` first. */
async function matchingRemote(root: string, repositoryUrl: string): Promise<string | null> {
  const want = remoteKey(repositoryUrl);
  if (!want) return null;
  const out = await runGit(root, ['remote', '-v']);
  if (!out.ok) return null;
  const names = new Set<string>();
  for (const line of lines(out.stdout)) {
    const [name, url] = line.split(/\s+/);
    if (name && url && remoteKey(url) === want) names.add(name);
  }
  if (names.has('origin')) return 'origin';
  return names.values().next().value ?? null;
}

const remoteCache = new TtlCache<string | null>(60 * 1000);

/**
 * On the desktop app, a provider that reads the project's history with git in
 * the folder linked to the project, when that folder is a clone of
 * `repositoryUrl`. Null outside the desktop app, without a linked folder, or
 * when no remote of the clone points at the repository.
 */
export async function localGitProvider(
  projectId: number,
  repositoryUrl: string,
  hosted: ScmProvider,
): Promise<LocalGitProvider | null> {
  const folder = desktopLinkedFolder(projectId);
  const root = folder ? findRepoRoot(folder) : null;
  if (!root) return null;
  const key = `${root}\n${repositoryUrl}`;
  let remote = remoteCache.get(key);
  if (remote === undefined) {
    remote = await matchingRemote(root, repositoryUrl);
    remoteCache.set(key, remote);
  }
  return remote ? new LocalGitProvider(root, remote, hosted) : null;
}

/** git's status letters in the hosts' words; a copy is a new file, anything else a modification. */
const STATUS_BY_LETTER: Record<string, string> = { A: 'added', C: 'added', D: 'removed', R: 'renamed' };

/** A gitlink's mode: the "blob" of a submodule is a commit. */
const GITLINK_MODE = '160000';

/**
 * `git diff --raw -z --no-abbrev`: each file's status, (new) path and blob id
 * on the new side, in diff order. Each entry is
 * `:<old mode> <new mode> <old id> <new id> <status>`, then the path, or the
 * old and the new path for a rename or a copy; a removed file's new id is all
 * zeros, and a submodule has no blob.
 */
function parseRawDiff(out: string): Array<{ status: string; path: string; blob?: string }> {
  const parts = out.split('\0');
  const result: Array<{ status: string; path: string; blob?: string }> = [];
  for (let i = 0; i < parts.length;) {
    const meta = parts[i++];
    if (!meta?.startsWith(':')) continue;
    const [, newMode = '', , newId = '', code = ''] = meta.slice(1).split(' ');
    if (code.startsWith('R') || code.startsWith('C')) i++; // the old path comes first
    const blob = newMode !== GITLINK_MODE && isGitObjectId(newId) && /[^0]/.test(newId) ? newId : undefined;
    result.push({
      status: STATUS_BY_LETTER[code[0]!] ?? 'modified',
      path: parts[i++] ?? '',
      ...(blob ? { blob } : {}),
    });
  }
  return result;
}

/** `git diff --numstat -z`: each file's added and deleted lines (0 for a binary file), in diff order. */
function parseNumstat(out: string): Array<{ additions: number; deletions: number; path: string }> {
  const parts = out.split('\0');
  const result: Array<{ additions: number; deletions: number; path: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const match = parts[i]!.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
    if (!match) continue;
    let path = match[3]!;
    if (path === '') {
      // A rename: the old and the new path follow as their own fields.
      i += 2;
      path = parts[i] ?? '';
    }
    result.push({
      additions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
      path,
    });
  }
  return result;
}

/**
 * Each file's section of a `git diff --patch`, in diff order: its `diff --git`
 * header and its hunks from the first `@@` line (none for a binary, mode-only
 * or pure-rename change). A section the byte cap cut short is left out.
 */
function splitPatch(raw: string, cut: boolean): Array<{ header: string; hunks: string | undefined }> {
  const sections: Array<{ header: string; hunks: string[] }> = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      sections.push({ header: line, hunks: [] });
      continue;
    }
    const current = sections[sections.length - 1];
    if (current && (current.hunks.length > 0 || line.startsWith('@@'))) current.hunks.push(line);
  }
  if (cut) sections.pop();
  return sections.map((s) => ({
    header: s.header,
    hunks: s.hunks.length > 0 ? s.hunks.join('\n').replace(/\n$/, '') : undefined,
  }));
}

/**
 * Reads a repository's history with git in a local clone: the folder the
 * desktop app links to the project. Each read falls back to `hosted`, the Git
 * host's own provider, for a commit or branch the clone does not have; every
 * write and every issue or pull-request lookup goes to `hosted`.
 */
export class LocalGitProvider extends ScmProvider {
  readonly provider: ScmProviderName;
  readonly webUrl: string;

  constructor(
    /** Top level of the clone. */
    readonly root: string,
    /** The clone's remote that points at the repository, for its remote-tracking branches. */
    private readonly remote: string,
    private readonly hosted: ScmProvider,
  ) {
    super(null);
    this.provider = hosted.provider;
    this.webUrl = hosted.webUrl;
  }

  private git(args: string[], maxBytes?: number): Promise<GitOutput> {
    return runGit(this.root, args, maxBytes);
  }

  private async resolvesToCommit(rev: string): Promise<boolean> {
    return (await this.git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).ok;
  }

  /** The branch `<remote>/HEAD` points at, when the clone records it. */
  private async localDefaultBranch(): Promise<string | null> {
    const prefix = `refs/remotes/${this.remote}/`;
    const out = await this.git(['symbolic-ref', '--quiet', `${prefix}HEAD`]);
    const ref = out.ok ? out.stdout.trim() : '';
    return ref.startsWith(prefix) ? ref.slice(prefix.length) || null : null;
  }

  /**
   * What to list for a branch: its local and remote-tracking refs, whichever
   * exist, else the name itself when it names a commit. Without a branch, the
   * default branch, else `HEAD`. Empty when the clone has nothing by that name.
   */
  private async revsFor(branch?: string): Promise<string[]> {
    const name = branch ?? (await this.localDefaultBranch());
    if (name) {
      if (!isValidGitRef(name)) return [];
      const wanted = [`refs/heads/${name}`, `refs/remotes/${this.remote}/${name}`];
      const out = await this.git(['for-each-ref', '--format=%(refname)', ...wanted]);
      const refs = out.ok ? lines(out.stdout).filter((ref) => wanted.includes(ref)) : [];
      if (refs.length > 0) return refs;
      if (branch) return (await this.resolvesToCommit(branch)) ? [branch] : [];
    }
    return ['HEAD'];
  }

  /** The changed files between two revisions (as `git diff` takes them), with their hunks. Null when git fails. */
  private async diff(revs: string[]): Promise<Omit<ScmChanges, 'commits'> | null> {
    const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short', '-M'];
    const [numstat, raw, patch] = await Promise.all([
      this.git([...base, '--numstat', '-z', ...revs, '--']),
      this.git([...base, '--raw', '-z', '--no-abbrev', ...revs, '--']),
      this.git([...base, '--patch', '--src-prefix=a/', '--dst-prefix=b/', ...revs, '--'], MAX_LOCAL_PATCH_BYTES),
    ]);
    if (!numstat.ok || !raw.ok) return null;

    const counts = parseNumstat(numstat.stdout);
    const statuses = parseRawDiff(raw.stdout);
    const sections = patch.ok ? splitPatch(patch.stdout, patch.overflow) : [];
    const files: ChangedFile[] = statuses.slice(0, MAX_SCM_FILES_TOTAL).map(({ status, path, blob }, i) => {
      const count = counts[i]?.path === path ? counts[i] : undefined;
      const section = sections[i];
      const hunks = section?.header.endsWith(` b/${path}`) ? section.hunks : undefined;
      return {
        filename: path,
        status,
        additions: count?.additions ?? 0,
        deletions: count?.deletions ?? 0,
        patch: hunks ? truncatePatch(hunks) : undefined,
        ...(blob ? { blob } : {}),
      };
    });
    const filesTruncated = statuses.length > MAX_SCM_FILES_TOTAL;
    return { files, filesTruncated, ...(filesTruncated ? { totalChangedFiles: statuses.length } : {}) };
  }

  /** The hash of the empty tree, the base a root commit's diff is taken against. */
  private async emptyTree(): Promise<string | null> {
    const out = await this.git(['hash-object', '-t', 'tree', '--stdin']);
    return out.ok ? out.stdout.trim() || null : null;
  }

  async listBranches(limit = 100): Promise<string[]> {
    const prefixes = ['refs/heads/', `refs/remotes/${this.remote}/`];
    const out = await this.git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)', ...prefixes]);
    const names = new Set<string>();
    for (const ref of out.ok ? lines(out.stdout) : []) {
      if (names.size >= limit) break;
      const prefix = prefixes.find((p) => ref.startsWith(p));
      const name = prefix ? ref.slice(prefix.length) : '';
      if (name && name !== 'HEAD') names.add(name);
    }
    return names.size > 0 ? [...names] : this.hosted.listBranches(limit);
  }

  async listCommits(limit = 50, branch?: string): Promise<ScmCommitDetail[]> {
    const revs = await this.revsFor(branch);
    const out =
      revs.length > 0
        ? await this.git([
            'log',
            '--no-color',
            '--no-show-signature',
            `-n${limit}`,
            '--format=%H%x1f%an%x1f%aI%x1f%s%x1e',
            ...revs,
            '--',
          ])
        : null;
    const commits = out?.ok
      ? parseRecords(out.stdout).map(([sha = '', author = '', date = '', subject = '']) => ({
          sha,
          shortSha: sha.slice(0, 7),
          message: subject.trim(),
          author,
          date,
        }))
      : [];
    return commits.length > 0 ? commits : this.hosted.listCommits(limit, branch);
  }

  async fetchChanges(fromSha: string, toSha: string): Promise<ScmChanges | null> {
    if (!isValidGitRef(fromSha) || !isValidGitRef(toSha)) return null;
    if (!(await this.resolvesToCommit(fromSha)) || !(await this.resolvesToCommit(toSha))) {
      return this.hosted.fetchChanges(fromSha, toSha);
    }
    // Commits in `from..to`, oldest first as the hosts list them; files from the
    // merge base, as the hosts' compare views show them.
    const [log, diff] = await Promise.all([
      this.git([
        'log',
        '--no-color',
        '--no-show-signature',
        '--reverse',
        `-n${MAX_RANGE_COMMITS}`,
        '--format=%H%x1f%s%x1f%B%x1e',
        `${fromSha}..${toSha}`,
        '--',
      ]),
      this.diff([`${fromSha}...${toSha}`]),
    ]);
    if (!log.ok || !diff) return this.hosted.fetchChanges(fromSha, toSha);
    const commits = parseRecords(log.stdout).map(([sha = '', subject = '', body = '']) => ({
      sha: sha.slice(0, 7),
      message: subject,
      fullMessage: body.trim(),
    }));
    return { commits, ...diff };
  }

  async fetchCommitDiff(sha: string): Promise<ScmChanges | null> {
    if (!isValidGitRef(sha)) return null;
    const parents = await this.git(['rev-list', '--parents', '-n1', sha, '--']);
    const [commit, parent] = parents.ok ? parents.stdout.trim().split(' ') : [];
    if (!commit) return this.hosted.fetchCommitDiff(sha);
    const base = parent ?? (await this.emptyTree());
    const diff = base ? await this.diff([base, commit]) : null;
    return diff ? { commits: [], ...diff } : this.hosted.fetchCommitDiff(sha);
  }

  async getCommitAuthor(sha: string): Promise<ScmCommitAuthor | null> {
    if (!isValidGitRef(sha)) return null;
    const out = await this.git(['log', '-n1', '--no-show-signature', '--format=%an%x1f%ae', sha, '--']);
    if (!out.ok) return this.hosted.getCommitAuthor(sha);
    const [name = '', email = ''] = out.stdout.trim().split('\x1f');
    return email.trim() ? { name: name.trim() || email.trim(), email: email.trim() } : null;
  }

  async probeError(branch?: string): Promise<string | null> {
    const where = `the folder linked to this project (${this.root})`;
    return branch
      ? `Branch '${branch}' is not in ${where}. Fetch it there, or set an SCM token in Settings → AI to read it from the host.`
      : `No commits found in ${where}.`;
  }

  async fetchFileAtRef(path: string, ref: string): Promise<ScmFileContent | null> {
    if (!isValidGitRef(ref)) return null;
    const cleanPath = path.replace(/^\//, '');
    const out = await this.git(['cat-file', 'blob', `${ref}:${cleanPath}`], MAX_FILE_BYTES * 4);
    if (!out.ok) {
      // The commit is here and the file is not: that is the answer. Only a
      // commit the clone lacks is worth asking the host about.
      return (await this.resolvesToCommit(ref)) ? null : this.hosted.fetchFileAtRef(path, ref);
    }
    return {
      path: cleanPath,
      content: out.stdout.slice(0, MAX_FILE_BYTES),
      truncated: out.overflow || out.stdout.length > MAX_FILE_BYTES,
    };
  }

  async fetchTree(ref: string): Promise<string[] | null> {
    if (!isValidGitRef(ref)) return null;
    const out = await this.git(['ls-tree', '-r', '-z', '--full-tree', ref]);
    if (!out.ok) return this.hosted.fetchTree(ref);
    const entries = out.stdout.split('\0');
    if (out.overflow) entries.pop();
    const paths: string[] = [];
    for (const entry of entries) {
      // `<mode> <type> <object>\t<path>`
      const tab = entry.indexOf('\t');
      if (tab > 0 && entry.slice(0, tab).split(' ')[1] === 'blob') paths.push(entry.slice(tab + 1));
    }
    return paths;
  }

  override async getDefaultBranch(): Promise<string | null> {
    return (await this.localDefaultBranch()) ?? this.hosted.getDefaultBranch();
  }

  // ── The host's own: issues, pull requests and every write ─────────────────

  fetchIssue(number: number): Promise<ScmEntityRef | null> {
    return this.hosted.fetchIssue(number);
  }

  fetchPullRequest(number: number): Promise<ScmEntityRef | null> {
    return this.hosted.fetchPullRequest(number);
  }

  override findPullRequestForBranch(branch: string): Promise<ScmPullRequest | null> {
    return this.hosted.findPullRequestForBranch(branch);
  }

  override upsertPullRequestComment(prNumber: number, marker: string, body: string): Promise<boolean> {
    return this.hosted.upsertPullRequestComment(prNumber, marker, body);
  }

  override postPullRequestComment(prNumber: number, marker: string, body: string): Promise<ScmPostedComment | null> {
    return this.hosted.postPullRequestComment(prNumber, marker, body);
  }

  override postCommitStatus(sha: string, status: ScmCommitStatus): Promise<boolean> {
    return this.hosted.postCommitStatus(sha, status);
  }

  override getBranchHead(branch: string): Promise<string | null> {
    return this.hosted.getBranchHead(branch);
  }

  override createBranch(name: string, fromSha: string): Promise<void> {
    return this.hosted.createBranch(name, fromSha);
  }

  override commitFiles(branch: string, message: string, files: ScmFileEdit[]): Promise<string> {
    return this.hosted.commitFiles(branch, message, files);
  }

  override createPullRequest(input: CreatePullRequestInput): Promise<ScmPullRequest> {
    return this.hosted.createPullRequest(input);
  }

  override dispatchRerun(
    settings: CiRerunSettings,
    playwrightArgs: string,
    request: RerunDispatchRequest = {},
  ): Promise<RerunDispatchResult> {
    return this.hosted.dispatchRerun(settings, playwrightArgs, request);
  }
}
