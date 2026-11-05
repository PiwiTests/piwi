import {
  ScmProvider,
  type RerunDispatchRequest,
  type RerunDispatchResult,
  truncatePatch,
  MAX_SCM_FILES_TOTAL,
  HOST_MAX_PAGE_SIZE,
  MAX_FILE_BYTES,
  MAX_RAW_DIFF_BYTES,
  FETCH_TIMEOUT_MS,
} from './ScmProvider';
import type {
  ScmCommit,
  ScmCommitDetail,
  ScmCommitAuthor,
  ScmChanges,
  ScmFileContent,
  ScmEntityRef,
  ScmEntityState,
  ScmPullRequest,
  ScmFileEdit,
  ScmCommitStatus,
  ScmPostedComment,
  CreatePullRequestInput,
} from './ScmProvider';
import { TtlCache } from '../ttl-cache';
import { splitGitDiff } from './diff-text';
import { isValidGitRef, encodeGitRef, encodePathSegments } from './refs';
import type { CiRerunSettings } from '#shared/ci-rerun';
import { HEAL_PR_MARKER } from '#shared/heal-pr';

/** Turn a non-2xx Bitbucket response into an Error carrying the API's own message. */
async function bitbucketError(res: Response, action: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return new Error(`Bitbucket ${action} failed (${res.status}): ${body.error?.message ?? res.statusText}`);
}

const listBranchesCache = new TtlCache<string[]>(3 * 60 * 1000);
const listCommitsCache = new TtlCache<ScmCommitDetail[]>(3 * 60 * 1000);
const fetchChangesCache = new TtlCache<ScmChanges>(10 * 60 * 1000);
const rangeCommitsCache = new TtlCache<{ commits: ScmCommit[]; truncated: boolean }>(10 * 60 * 1000);
/** Commits listed for one range: one page of the commits endpoint. */
const MAX_RANGE_COMMITS = 100;
const fetchFileCache = new TtlCache<ScmFileContent | null>(30 * 60 * 1000);
const defaultBranchCache = new TtlCache<string | null>(30 * 60 * 1000);
// A commit is immutable per SHA, so cache it (and a commit the host does not have) for longer.
const commitInfoCache = new TtlCache<{ hash: string; message: string; authorRaw: string | null } | null>(
  30 * 60 * 1000,
);

/** A commit as `fetchChanges` and `fetchCommitDiff` list it. */
function commitOf(hash: string, message: string): ScmCommit {
  return { sha: hash.slice(0, 7), message: (message.split('\n')[0] ?? '').trim(), fullMessage: message };
}

/** Split Bitbucket's `author.raw` ("Ada Lovelace <ada@example.com>") into name + email. */
function parseAuthorRaw(raw: string): ScmCommitAuthor | null {
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    const email = match[2]!.trim();
    return email ? { name: match[1]!.trim() || email, email } : null;
  }
  // No angle brackets: a bare email is still usable, anything else is not.
  const bare = raw.trim();
  return /^[^\s@]+@[^\s@]+$/.test(bare) ? { name: bare, email: bare } : null;
}

/** The most pages of a pull request's comments read to find Piwi's own. */
const MAX_COMMENT_PAGES = 5;

/**
 * Piwi's comment marker as Bitbucket keeps it: an HTML comment
 * (`<!-- piwi-dashboard:run-summary -->`) becomes a CommonMark link reference
 * definition (`[//]: # (piwi-dashboard:run-summary)`), which Markdown does not render.
 */
export function bitbucketCommentMarker(marker: string): string {
  const name = /^<!--\s*(.*?)\s*-->$/.exec(marker.trim())?.[1];
  return name ? `[//]: # (${name})` : marker;
}

/** A commit status's state as Bitbucket names it. */
const BITBUCKET_STATUS_STATE: Record<ScmCommitStatus['state'], string> = {
  success: 'SUCCESSFUL',
  failure: 'FAILED',
  error: 'FAILED',
  pending: 'INPROGRESS',
};

/** Each file's hunks in a raw diff, by its path on the new side (the old side for a removed file). */
function parsePatchesByFile(rawDiff: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const section of splitGitDiff(rawDiff)) {
    if (section.path && section.hunks) result.set(section.path, truncatePatch(section.hunks));
  }
  return result;
}

export class BitbucketProvider extends ScmProvider {
  readonly provider = 'bitbucket' as const;
  get webUrl(): string {
    return `https://bitbucket.org/${this.workspace}/${this.repoSlug}`;
  }
  private readonly base: string;

  constructor(
    private readonly workspace: string,
    private readonly repoSlug: string,
    token: string | null,
  ) {
    super(token);
    this.base = `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}`;
  }

  async listBranches(limit = 100): Promise<string[]> {
    const key = `${this.keyPrefix}:branches:${this.workspace}/${this.repoSlug}:${limit}`;
    const hit = listBranchesCache.get(key);
    if (hit !== undefined) return hit;

    const res = await fetch(`${this.base}/refs/branches?sort=-target.date&pagelen=${limit}`, {
      headers: this.makeHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { values?: Array<{ name: string }> };
    const result = (data.values ?? []).map((b) => b.name);
    listBranchesCache.set(key, result);
    return result;
  }

  async listCommits(limit = 50, branch?: string): Promise<ScmCommitDetail[]> {
    const key = `${this.keyPrefix}:${this.workspace}/${this.repoSlug}:${limit}:${branch ?? ''}`;
    const hit = listCommitsCache.get(key);
    if (hit !== undefined) return hit;

    // A page holds at most 100 commits: follow `next` until `limit`.
    const pagelen = Math.min(limit, HOST_MAX_PAGE_SIZE);
    let next: string | null = branch
      ? `${this.base}/commits/${encodeURIComponent(branch)}?pagelen=${pagelen}`
      : `${this.base}/commits?pagelen=${pagelen}`;
    const result: ScmCommitDetail[] = [];
    let complete = true;
    while (next && result.length < limit) {
      const res: Response = await fetch(next, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (result.length === 0) return [];
        complete = false;
        break;
      }
      const data = (await res.json()) as {
        values?: Array<{ hash: string; message: string; author: { raw?: string }; date: string }>;
        next?: string;
      };
      for (const c of data.values ?? []) {
        result.push({
          sha: c.hash,
          shortSha: c.hash.slice(0, 7),
          message: (c.message.split('\n')[0] ?? '').trim(),
          author: (c.author?.raw ?? '').replace(/<[^>]+>\s*$/, '').trim(),
          date: c.date,
        });
      }
      next = data.next ?? null;
    }
    result.splice(limit);
    if (!complete) return result;
    listCommitsCache.set(key, result);
    return result;
  }

  async fetchChanges(fromSha: string, toSha: string): Promise<ScmChanges | null> {
    if (!isValidGitRef(fromSha) || !isValidGitRef(toSha)) return null;
    // Bitbucket takes the commit holding the changes first and the one it is
    // compared with second, and diffs from their merge base: `to..from` here is
    // git's `from...to`.
    const [changes, range] = await Promise.all([
      this.diffSpec(`${encodeGitRef(toSha)}..${encodeGitRef(fromSha)}`),
      this.rangeCommits(fromSha, toSha),
    ]);
    return changes ? { ...changes, commits: range.commits, commitsTruncated: range.truncated } : null;
  }

  /**
   * The commits reachable from `toSha` and not from `fromSha`, oldest first as
   * the other hosts list them, with their full messages. Empty when the
   * commits endpoint fails: the files still answer.
   */
  private async rangeCommits(fromSha: string, toSha: string): Promise<{ commits: ScmCommit[]; truncated: boolean }> {
    const key = `${this.keyPrefix}:${this.workspace}/${this.repoSlug}:commits:${fromSha}:${toSha}`;
    const hit = rangeCommitsCache.get(key);
    if (hit !== undefined) return hit;
    try {
      const url = new URL(`${this.base}/commits`);
      url.searchParams.set('include', toSha);
      url.searchParams.set('exclude', fromSha);
      url.searchParams.set('pagelen', String(MAX_RANGE_COMMITS));
      const res = await fetch(url.toString(), {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return { commits: [], truncated: false };
      const data = (await res.json()) as { values?: Array<{ hash: string; message?: string }>; next?: string };
      const result = {
        commits: (data.values ?? []).map((c) => commitOf(c.hash, c.message ?? '')).reverse(),
        truncated: Boolean(data.next),
      };
      rangeCommitsCache.set(key, result);
      return result;
    } catch {
      return { commits: [], truncated: false };
    }
  }

  /**
   * The changed files of a diff spec: a single commit (against its first
   * parent) or `<changes>..<compared with>`, each part already validated and
   * encoded by the caller.
   */
  private async diffSpec(spec: string): Promise<ScmChanges | null> {
    const key = `${this.keyPrefix}:${this.workspace}/${this.repoSlug}:${spec}`;
    const hit = fetchChangesCache.get(key);
    if (hit !== undefined) return hit;

    // Raw patch text in parallel; the diffstat is paged for the file list. Both
    // diff from the merge base (`topic`), as git's `from...to` does.
    const diffPromise = fetch(`${this.base}/diff/${spec}?topic=true`, {
      headers: this.makeHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch(() => null);

    type DiffStatValue = {
      status: string;
      old?: { path: string } | null;
      new?: { path: string } | null;
      lines_removed?: number;
      lines_added?: number;
    };
    const values: DiffStatValue[] = [];
    let filesTruncated = false;
    // Follow Bitbucket's `next` cursor up to the total cap so a large pull
    // request's later files are not silently dropped at one page of 30.
    let next: string | null = `${this.base}/diffstat/${spec}?pagelen=100&topic=true`;
    let firstPage = true;
    // An answer read in part (a later page or the raw diff failed) is returned but not cached.
    let complete = true;
    while (next && values.length < MAX_SCM_FILES_TOTAL) {
      const res: Response = await fetch(next, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (firstPage) {
          diffPromise.then((r) => r?.body?.cancel()).catch(() => {});
          return null;
        }
        complete = false;
        filesTruncated = true;
        break;
      }
      firstPage = false;
      const page = (await res.json()) as { values?: DiffStatValue[]; next?: string };
      for (const v of page.values ?? []) {
        if (values.length >= MAX_SCM_FILES_TOTAL) {
          filesTruncated = true;
          break;
        }
        values.push(v);
      }
      next = page.next ?? null;
      if (next && values.length >= MAX_SCM_FILES_TOTAL) filesTruncated = true;
    }

    let patchesByFile = new Map<string, string>();
    let patchesOmitted = true;
    const diffRes = await diffPromise;
    const rawDiff = diffRes?.ok ? await diffRes.text().catch(() => null) : null;
    if (rawDiff === null) complete = false;
    else if (rawDiff.length <= MAX_RAW_DIFF_BYTES) {
      patchesByFile = parsePatchesByFile(rawDiff);
      patchesOmitted = false;
    }

    const result: ScmChanges = {
      commits: [],
      patchesOmitted,
      filesTruncated,
      files: values.map((f) => {
        const filename = (f.new?.path || f.old?.path) ?? '';
        const previous = f.status === 'renamed' && f.old?.path && f.old.path !== filename ? f.old.path : undefined;
        return {
          filename,
          ...(previous ? { previousFilename: previous } : {}),
          status: f.status,
          additions: f.lines_added ?? 0,
          deletions: f.lines_removed ?? 0,
          patch: patchesByFile.get(filename),
        };
      }),
    };
    if (complete) fetchChangesCache.set(key, result);
    return result;
  }

  async fetchCommitDiff(sha: string): Promise<ScmChanges | null> {
    if (!isValidGitRef(sha)) return null;
    // A single commit is diffed against its first parent.
    const [changes, commit] = await Promise.all([this.diffSpec(encodeGitRef(sha)), this.commitInfo(sha)]);
    if (!changes) return null;
    return { ...changes, commits: commit ? [commitOf(commit.hash, commit.message)] : [] };
  }

  /** A commit's hash, message and raw author, or null when it cannot be read. */
  private async commitInfo(sha: string): Promise<{ hash: string; message: string; authorRaw: string | null } | null> {
    const key = `${this.keyPrefix}:commit:${this.workspace}/${this.repoSlug}:${sha}`;
    const hit = commitInfoCache.get(key);
    if (hit !== undefined) return hit;
    try {
      const res = await fetch(`${this.base}/commit/${encodeURIComponent(sha)}`, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (res.status === 404) commitInfoCache.set(key, null);
        return null;
      }
      const data = (await res.json()) as { hash?: string; message?: string; author?: { raw?: string } };
      const result = { hash: data.hash ?? sha, message: data.message ?? '', authorRaw: data.author?.raw ?? null };
      commitInfoCache.set(key, result);
      return result;
    } catch {
      return null;
    }
  }

  async getCommitAuthor(sha: string): Promise<ScmCommitAuthor | null> {
    if (!isValidGitRef(sha)) return null;
    const commit = await this.commitInfo(sha);
    return commit?.authorRaw ? parseAuthorRaw(commit.authorRaw) : null;
  }

  async fetchIssue(number: number): Promise<ScmEntityRef | null> {
    if (!Number.isInteger(number) || number <= 0) return null;
    try {
      const res = await fetch(`${this.base}/issues/${number}`, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        title?: string;
        state?: string;
        reporter?: { display_name?: string };
        links?: { html?: { href?: string } };
        updated_on?: string;
      };
      const open = data.state === 'new' || data.state === 'open' || data.state === 'on hold';
      return {
        title: data.title ?? null,
        state: data.state ? (open ? 'open' : 'closed') : null,
        author: data.reporter?.display_name ?? null,
        url: data.links?.html?.href ?? null,
        updatedAt: data.updated_on ?? null,
      };
    } catch {
      return null;
    }
  }

  async fetchPullRequest(number: number): Promise<ScmEntityRef | null> {
    if (!Number.isInteger(number) || number <= 0) return null;
    try {
      const res = await fetch(`${this.base}/pullrequests/${number}`, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        title?: string;
        state?: string;
        author?: { display_name?: string };
        links?: { html?: { href?: string } };
        updated_on?: string;
      };
      const state: ScmEntityState =
        data.state === 'MERGED' ? 'merged' : data.state === 'OPEN' ? 'open' : data.state ? 'closed' : null;
      return {
        title: data.title ?? null,
        state,
        author: data.author?.display_name ?? null,
        url: data.links?.html?.href ?? null,
        updatedAt: data.updated_on ?? null,
      };
    } catch {
      return null;
    }
  }

  async fetchFileAtRef(path: string, ref: string): Promise<ScmFileContent | null> {
    if (!isValidGitRef(ref)) return null;
    const cleanPath = path.replace(/^\//, '');
    const key = `${this.keyPrefix}:file:${this.workspace}/${this.repoSlug}:${ref}:${cleanPath}`;
    const hit = fetchFileCache.get(key);
    if (hit !== undefined) return hit;

    const res = await fetch(`${this.base}/src/${encodeURIComponent(ref)}/${encodePathSegments(cleanPath)}`, {
      headers: this.makeHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Only a missing file is an answer to keep; a refused or failed request is tried again.
      if (res.status === 404) fetchFileCache.set(key, null);
      return null;
    }
    const raw = await res.text();
    const result: ScmFileContent = {
      path: cleanPath,
      content: raw.length > MAX_FILE_BYTES ? raw.slice(0, MAX_FILE_BYTES) : raw,
      truncated: raw.length > MAX_FILE_BYTES,
    };
    fetchFileCache.set(key, result);
    return result;
  }

  async fetchTree(_ref: string): Promise<string[] | null> {
    // Bitbucket's `src` endpoint has no clean recursive listing; skip tree-based
    // path normalization for Bitbucket (callers degrade gracefully to null).
    return null;
  }

  async probeError(branch?: string): Promise<string | null> {
    try {
      const res = await fetch(this.base, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (res.status === 404)
          return 'Repository not found on Bitbucket. Check the remote URL in your test run metadata.';
        if (res.status === 401 || res.status === 403)
          return 'Bitbucket API authentication failed. Check your SCM token in Settings → AI.';
        return `Bitbucket API returned ${res.status}.`;
      }
      return `No commits found on ${branch ? `branch '${branch}'` : 'the default branch'}.`;
    } catch {
      return 'Could not reach the Bitbucket API. Check your network connection.';
    }
  }

  override async getDefaultBranch(): Promise<string | null> {
    const key = `${this.keyPrefix}:default-branch:${this.workspace}/${this.repoSlug}`;
    const cached = defaultBranchCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const res = await fetch(this.base, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { mainbranch?: { name?: string } };
      const branch = body.mainbranch?.name?.trim() || null;
      defaultBranchCache.set(key, branch);
      return branch;
    } catch {
      return null;
    }
  }

  // ── Pull-request discovery + write capability (auto-heal) ──────────────────

  override async findPullRequestForBranch(branch: string): Promise<ScmPullRequest | null> {
    if (!branch) return null;
    try {
      const url = new URL(`${this.base}/pullrequests`);
      url.searchParams.set('q', `source.branch.name="${branch}"`);
      url.searchParams.set('state', 'OPEN');
      url.searchParams.set('pagelen', '1');
      const res = await fetch(url.toString(), {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        values?: Array<{
          id?: number;
          links?: { html?: { href?: string } };
          destination?: { branch?: { name?: string } };
        }>;
      };
      const pr = data.values?.[0];
      if (!pr?.id) return null;
      return {
        number: pr.id,
        url: pr.links?.html?.href ?? `https://bitbucket.org/${this.workspace}/${this.repoSlug}/pull-requests/${pr.id}`,
        baseBranch: pr.destination?.branch?.name ?? null,
      };
    } catch {
      return null;
    }
  }

  // ── Pull-request feedback ─────────────────────────────────────────────────

  override async upsertPullRequestComment(prNumber: number, marker: string, body: string): Promise<boolean> {
    return (await this.postPullRequestComment(prNumber, marker, body)) !== null;
  }

  override async postPullRequestComment(
    prNumber: number,
    marker: string,
    body: string,
  ): Promise<ScmPostedComment | null> {
    if (!this.token || !Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
    const hidden = bitbucketCommentMarker(marker);
    try {
      // Only a comment carrying the marker is ever edited, so a human comment is never overwritten.
      const existingId = await this.findMarkedComment(prNumber, hidden);
      // Comments that could not all be read may hold Piwi's: posting another would duplicate it.
      if (existingId === undefined) return null;
      const comments = `${this.base}/pullrequests/${prNumber}/comments`;
      const res = await fetch(existingId != null ? `${comments}/${existingId}` : comments, {
        method: existingId != null ? 'PUT' : 'POST',
        headers: { ...this.makeHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { raw: body.split(marker).join(hidden) } }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const posted = (await res.json().catch(() => null)) as { id?: number } | null;
      const id = posted?.id ?? existingId;
      return { id: id != null ? String(id) : null };
    } catch {
      return null;
    }
  }

  /**
   * The id of the pull request's top-level comment that carries the marker,
   * null when it has none, or undefined when its comments could not all be
   * read (an error, or more than {@link MAX_COMMENT_PAGES} pages).
   */
  private async findMarkedComment(prNumber: number, marker: string): Promise<number | null | undefined> {
    let url: string | null = `${this.base}/pullrequests/${prNumber}/comments?pagelen=${HOST_MAX_PAGE_SIZE}`;
    for (let page = 0; url; page++) {
      if (page === MAX_COMMENT_PAGES) return undefined;
      const res = await fetch(url, { headers: this.makeHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return undefined;
      const data = (await res.json()) as {
        values?: Array<{
          id?: unknown;
          deleted?: boolean;
          inline?: unknown;
          parent?: unknown;
          content?: { raw?: unknown };
        }>;
        next?: unknown;
      };
      const mine = (data.values ?? []).find(
        (c) =>
          typeof c.id === 'number' &&
          !c.deleted &&
          !c.inline &&
          !c.parent &&
          typeof c.content?.raw === 'string' &&
          c.content.raw.includes(marker),
      );
      if (mine) return mine.id as number;
      if (data.next === undefined || data.next === null) return null;
      url = this.ownApiUrl(data.next);
      if (!url) return undefined;
    }
    return null;
  }

  /** A link the API answered with, when it stays in this repository's API; the token follows no other. */
  private ownApiUrl(link: unknown): string | null {
    if (typeof link !== 'string') return null;
    try {
      const url = new URL(link);
      const base = new URL(`${this.base}/`);
      return url.origin === base.origin && url.pathname.startsWith(base.pathname) ? url.href : null;
    } catch {
      return null;
    }
  }

  override async postCommitStatus(sha: string, status: ScmCommitStatus): Promise<boolean> {
    if (!this.token || !isValidGitRef(sha)) return false;
    try {
      // Posting a key again replaces that status, so each run updates its own.
      const res = await fetch(`${this.base}/commit/${encodeGitRef(sha)}/statuses/build`, {
        method: 'POST',
        headers: { ...this.makeHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: status.context,
          name: status.context,
          state: BITBUCKET_STATUS_STATE[status.state],
          description: status.description,
          url: status.targetUrl,
          ...(status.ref ? { refname: status.ref } : {}),
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  override async getBranchHead(branch: string): Promise<string | null> {
    const res = await fetch(`${this.base}/refs/branches/${encodeURIComponent(branch)}`, {
      headers: this.makeHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw await bitbucketError(res, 'read branch');
    const data = (await res.json()) as { target?: { hash?: string } };
    return data.target?.hash ?? null;
  }

  override async createBranch(name: string, fromSha: string): Promise<void> {
    const res = await fetch(`${this.base}/refs/branches`, {
      method: 'POST',
      headers: { ...this.makeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, target: { hash: fromSha } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw await bitbucketError(res, 'create branch');
  }

  override async commitFiles(branch: string, message: string, files: ScmFileEdit[]): Promise<string> {
    // Bitbucket's `/src` endpoint takes form fields: `message`, `branch`, and one
    // field per file keyed by its path — creating a single commit on that branch.
    const form = new URLSearchParams();
    form.set('message', message);
    form.set('branch', branch);
    for (const f of files) form.set(f.path, f.content);

    const res = await fetch(`${this.base}/src`, {
      method: 'POST',
      headers: { ...this.makeHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw await bitbucketError(res, 'commit files');

    // The `/src` POST returns no commit hash, so read the branch head back.
    const head = await this.getBranchHead(branch);
    if (!head) throw new Error('Bitbucket commit succeeded but the new branch head could not be read');
    return head;
  }

  override async createPullRequest(input: CreatePullRequestInput): Promise<ScmPullRequest> {
    // Bitbucket Cloud has no draft pull requests; `input.draft` is ignored.
    const res = await fetch(`${this.base}/pullrequests`, {
      method: 'POST',
      headers: { ...this.makeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        // The auto-heal marker is hidden the way a comment's is: Bitbucket shows an HTML comment as text.
        summary: { raw: input.body.split(HEAL_PR_MARKER).join(bitbucketCommentMarker(HEAL_PR_MARKER)) },
        source: { branch: { name: input.head } },
        destination: { branch: { name: input.base } },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw await bitbucketError(res, 'open pull request');
    const pr = (await res.json()) as { id?: number; links?: { html?: { href?: string } } };
    if (!pr.id) throw new Error('Bitbucket pull request response had no id');
    return {
      number: pr.id,
      url: pr.links?.html?.href ?? `https://bitbucket.org/${this.workspace}/${this.repoSlug}/pull-requests/${pr.id}`,
    };
  }

  // ── CI re-run ──────────────────────────────────────────────────────────────

  override async dispatchRerun(
    settings: CiRerunSettings,
    playwrightArgs: string,
    request: RerunDispatchRequest = {},
  ): Promise<RerunDispatchResult> {
    const target = settings.bitbucket;
    if (!target) throw new Error('No Bitbucket pipeline configured for CI re-run');

    // A custom pipeline runs against a branch: the requested one, else the
    // repository's default branch, since the config names only the pipeline.
    const branch = request.ref || (await this.getDefaultBranch()) || 'main';
    const res = await fetch(`${this.base}/pipelines/`, {
      method: 'POST',
      headers: { ...this.makeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: {
          type: 'pipeline_ref_target',
          ref_type: 'branch',
          ref_name: branch,
          selector: { type: 'custom', pattern: target.pipeline },
        },
        variables: [{ key: target.variableName, value: playwrightArgs }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw await bitbucketError(res, 'trigger pipeline');
    const pipeline = (await res.json()) as { build_number?: number; links?: { self?: { href?: string } } };
    const url =
      pipeline.build_number != null
        ? `https://bitbucket.org/${this.workspace}/${this.repoSlug}/pipelines/results/${pipeline.build_number}`
        : (pipeline.links?.self?.href ?? `https://bitbucket.org/${this.workspace}/${this.repoSlug}/pipelines`);
    return {
      url,
      ref: branch,
      ...(pipeline.build_number != null ? { buildNumber: String(pipeline.build_number) } : {}),
    };
  }
}
