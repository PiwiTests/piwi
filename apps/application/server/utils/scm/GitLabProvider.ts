import {
  ScmProvider,
  type RerunDispatchRequest,
  type RerunDispatchResult,
  truncatePatch,
  MAX_SCM_FILES_TOTAL,
  HOST_MAX_PAGE_SIZE,
  MAX_FILE_BYTES,
  FETCH_TIMEOUT_MS,
  readBlobText,
} from './ScmProvider';
import { isGitObjectId } from '#shared/utils/hash';
import type {
  ChangedFile,
  ScmCommit,
  ScmCommitDetail,
  ScmCommitAuthor,
  ScmChanges,
  ScmFileContent,
  ScmEntityRef,
  ScmEntityState,
  ScmPullRequest,
  ScmCommitStatus,
  ScmFileEdit,
  CreatePullRequestInput,
  ScmPostedComment,
} from './ScmProvider';
import { TtlCache } from '../ttl-cache';
import { isValidGitRef, encodeGitRef } from './refs';
import type { CiRerunSettings } from '#shared/ci-rerun';

/** Turn a non-2xx GitLab response into an Error carrying the API's own message. */
async function gitlabError(res: Response, action: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
  const detail =
    typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : res.statusText;
  return new Error(`GitLab ${action} failed (${res.status}): ${detail}`);
}

const listBranchesCache = new TtlCache<string[]>(3 * 60 * 1000);
const listCommitsCache = new TtlCache<ScmCommitDetail[]>(3 * 60 * 1000);
const fetchChangesCache = new TtlCache<ScmChanges>(10 * 60 * 1000);
const fetchCommitDiffCache = new TtlCache<ScmChanges>(10 * 60 * 1000);
const fetchFileCache = new TtlCache<ScmFileContent | null>(30 * 60 * 1000);
const fetchTreeCache = new TtlCache<string[]>(10 * 60 * 1000);
const defaultBranchCache = new TtlCache<string | null>(30 * 60 * 1000);
// A commit is immutable per SHA, so cache it (and a commit the host does not have) for longer.
const commitInfoCache = new TtlCache<{ id: string; message: string; authorName: string; authorEmail: string } | null>(
  30 * 60 * 1000,
);

/** A changed file as the compare and commit diff endpoints list it. */
interface GitLabDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}

/** A changed file of GitLab's in the provider's shape. */
function changedFileOf(f: GitLabDiff): ChangedFile {
  const { additions, deletions } = countDiffLines(f.diff ?? '');
  const filename = f.new_path || f.old_path;
  return {
    filename,
    ...(f.renamed_file && f.old_path && f.old_path !== filename ? { previousFilename: f.old_path } : {}),
    status: f.new_file ? 'added' : f.deleted_file ? 'removed' : f.renamed_file ? 'renamed' : 'modified',
    additions,
    deletions,
    patch: f.diff ? truncatePatch(f.diff) : undefined,
  };
}

/** A commit as `fetchChanges` and `fetchCommitDiff` list it. */
function commitOf(id: string, message: string): ScmCommit {
  return { sha: id.slice(0, 7), message: (message.split('\n')[0] ?? '').trim(), fullMessage: message };
}

/** Files read per page of a commit's diff. */
const COMMIT_DIFF_PAGE_SIZE = HOST_MAX_PAGE_SIZE;

/** Count added/removed lines in a unified-diff hunk body (ignores +++/--- headers). */
function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export class GitLabProvider extends ScmProvider {
  readonly provider = 'gitlab' as const;
  get webUrl(): string {
    return `https://${this.hostname}/${this.repoPath}`;
  }

  constructor(
    private readonly hostname: string,
    private readonly repoPath: string,
    token: string | null,
  ) {
    super(token);
  }

  async listBranches(limit = 100): Promise<string[]> {
    const key = `${this.keyPrefix}:branches:${this.hostname}:${this.repoPath}:${limit}`;
    const hit = listBranchesCache.get(key);
    if (hit !== undefined) return hit;

    const projectPath = encodeURIComponent(this.repoPath);
    const res = await fetch(
      `https://${this.hostname}/api/v4/projects/${projectPath}/repository/branches?per_page=${limit}&order_by=updated_at&sort=desc`,
      { headers: this.makeHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ name: string }>;
    const result = data.map((b) => b.name);
    listBranchesCache.set(key, result);
    return result;
  }

  async listCommits(limit = 50, branch?: string): Promise<ScmCommitDetail[]> {
    const key = `${this.keyPrefix}:${this.hostname}:${this.repoPath}:${limit}:${branch ?? ''}`;
    const hit = listCommitsCache.get(key);
    if (hit !== undefined) return hit;

    const projectPath = encodeURIComponent(this.repoPath);
    // A page holds at most 100 commits: page until `limit`.
    const perPage = Math.min(limit, HOST_MAX_PAGE_SIZE);
    const result: ScmCommitDetail[] = [];
    let complete = true;
    for (let page = 1; result.length < limit; page++) {
      const url = new URL(`https://${this.hostname}/api/v4/projects/${projectPath}/repository/commits`);
      url.searchParams.set('per_page', String(perPage));
      url.searchParams.set('page', String(page));
      if (branch) url.searchParams.set('ref_name', branch);
      const res = await fetch(url.toString(), {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (page === 1) return [];
        complete = false;
        break;
      }
      const data = (await res.json()) as Array<{
        id: string;
        message: string;
        author_name: string;
        created_at: string;
      }>;
      for (const c of data) {
        result.push({
          sha: c.id,
          shortSha: c.id.slice(0, 7),
          message: (c.message.split('\n')[0] ?? '').trim(),
          author: c.author_name,
          date: c.created_at,
        });
      }
      if (data.length < perPage) break;
    }
    result.splice(limit);
    if (!complete) return result;
    listCommitsCache.set(key, result);
    return result;
  }

  async fetchChanges(fromSha: string, toSha: string): Promise<ScmChanges | null> {
    if (!isValidGitRef(fromSha) || !isValidGitRef(toSha)) return null;
    const key = `${this.keyPrefix}:${this.hostname}:${this.repoPath}:${fromSha}:${toSha}`;
    const hit = fetchChangesCache.get(key);
    if (hit !== undefined) return hit;

    const projectPath = encodeURIComponent(this.repoPath);
    const res = await fetch(
      `https://${this.hostname}/api/v4/projects/${projectPath}/repository/compare?from=${encodeURIComponent(fromSha)}&to=${encodeURIComponent(toSha)}`,
      { headers: this.makeHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      commits?: Array<{ id: string; message: string }>;
      diffs?: GitLabDiff[];
    };
    const allDiffs = data.diffs ?? [];
    const result: ScmChanges = {
      commits: (data.commits ?? []).map((c) => commitOf(c.id, c.message)),
      files: allDiffs.slice(0, MAX_SCM_FILES_TOTAL).map(changedFileOf),
      filesTruncated: allDiffs.length > MAX_SCM_FILES_TOTAL,
      ...(allDiffs.length > MAX_SCM_FILES_TOTAL ? { totalChangedFiles: allDiffs.length } : {}),
    };
    fetchChangesCache.set(key, result);
    return result;
  }

  async fetchCommitDiff(sha: string): Promise<ScmChanges | null> {
    if (!isValidGitRef(sha)) return null;
    const key = `${this.keyPrefix}:${this.hostname}:${this.repoPath}:${sha}`;
    const hit = fetchCommitDiffCache.get(key);
    if (hit !== undefined) return hit;

    const commitUrl = `https://${this.hostname}/api/v4/projects/${encodeURIComponent(this.repoPath)}/repository/commits/${encodeURIComponent(sha)}`;
    const commitPromise = this.commitInfo(sha);
    // The endpoint is paged: read pages until the last one or the file cap.
    const diffs: GitLabDiff[] = [];
    let filesTruncated = false;
    // An answer read in part (a later page or the commit failed) is returned but not cached.
    let complete = true;
    for (let page = 1; ; page++) {
      const res = await fetch(`${commitUrl}/diff?per_page=${COMMIT_DIFF_PAGE_SIZE}&page=${page}`, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (page > 1) {
          complete = false;
          filesTruncated = true;
          break;
        }
        throw await gitlabError(res, `reading commit ${sha}`);
      }
      const pageDiffs = (await res.json()) as GitLabDiff[];
      diffs.push(...pageDiffs);
      // GitLab names the next page, and sends the header empty on the last one.
      const nextPage = res.headers.get('x-next-page');
      const more = nextPage !== null ? nextPage.trim() !== '' : pageDiffs.length === COMMIT_DIFF_PAGE_SIZE;
      if (diffs.length > MAX_SCM_FILES_TOTAL || (more && diffs.length >= MAX_SCM_FILES_TOTAL)) {
        filesTruncated = true;
        break;
      }
      if (!more || pageDiffs.length === 0) break;
    }
    const commit = await commitPromise;
    const result: ScmChanges = {
      commits: commit ? [commitOf(commit.id, commit.message)] : [],
      files: diffs.slice(0, MAX_SCM_FILES_TOTAL).map(changedFileOf),
      filesTruncated,
    };
    if (complete && commit) fetchCommitDiffCache.set(key, result);
    return result;
  }

  /** A commit's id, message and author, or null when it cannot be read. */
  private async commitInfo(
    sha: string,
  ): Promise<{ id: string; message: string; authorName: string; authorEmail: string } | null> {
    const key = `${this.keyPrefix}:commit:${this.hostname}:${this.repoPath}:${sha}`;
    const hit = commitInfoCache.get(key);
    if (hit !== undefined) return hit;
    try {
      const projectPath = encodeURIComponent(this.repoPath);
      const res = await fetch(
        `https://${this.hostname}/api/v4/projects/${projectPath}/repository/commits/${encodeURIComponent(sha)}`,
        { headers: this.makeHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (!res.ok) {
        if (res.status === 404) commitInfoCache.set(key, null);
        return null;
      }
      const data = (await res.json()) as { id?: string; message?: string; author_name?: string; author_email?: string };
      const result = {
        id: data.id ?? sha,
        message: data.message ?? '',
        authorName: data.author_name?.trim() ?? '',
        authorEmail: data.author_email?.trim() ?? '',
      };
      commitInfoCache.set(key, result);
      return result;
    } catch {
      return null;
    }
  }

  async getCommitAuthor(sha: string): Promise<ScmCommitAuthor | null> {
    if (!isValidGitRef(sha)) return null;
    const commit = await this.commitInfo(sha);
    return commit?.authorEmail ? { name: commit.authorName || commit.authorEmail, email: commit.authorEmail } : null;
  }

  async fetchIssue(number: number): Promise<ScmEntityRef | null> {
    if (!Number.isInteger(number) || number <= 0) return null;
    try {
      const projectPath = encodeURIComponent(this.repoPath);
      const res = await fetch(`https://${this.hostname}/api/v4/projects/${projectPath}/issues/${number}`, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        title?: string;
        state?: string;
        author?: { name?: string; username?: string };
        web_url?: string;
        updated_at?: string;
      };
      return {
        title: data.title ?? null,
        state: data.state === 'closed' ? 'closed' : data.state === 'opened' ? 'open' : null,
        author: data.author?.name ?? data.author?.username ?? null,
        url: data.web_url ?? null,
        updatedAt: data.updated_at ?? null,
      };
    } catch {
      return null;
    }
  }

  async fetchPullRequest(number: number): Promise<ScmEntityRef | null> {
    if (!Number.isInteger(number) || number <= 0) return null;
    try {
      const projectPath = encodeURIComponent(this.repoPath);
      const res = await fetch(`https://${this.hostname}/api/v4/projects/${projectPath}/merge_requests/${number}`, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        title?: string;
        state?: string;
        draft?: boolean;
        work_in_progress?: boolean;
        author?: { name?: string; username?: string };
        web_url?: string;
        updated_at?: string;
      };
      const state: ScmEntityState =
        data.state === 'merged'
          ? 'merged'
          : data.state === 'closed'
            ? 'closed'
            : data.draft || data.work_in_progress
              ? 'draft'
              : data.state === 'opened'
                ? 'open'
                : null;
      return {
        title: data.title ?? null,
        state,
        author: data.author?.name ?? data.author?.username ?? null,
        url: data.web_url ?? null,
        updatedAt: data.updated_at ?? null,
      };
    } catch {
      return null;
    }
  }

  async fetchFileAtRef(path: string, ref: string): Promise<ScmFileContent | null> {
    if (!isValidGitRef(ref)) return null;
    const cleanPath = path.replace(/^\//, '');
    const key = `${this.keyPrefix}:file:${this.hostname}:${this.repoPath}:${ref}:${cleanPath}`;
    const hit = fetchFileCache.get(key);
    if (hit !== undefined) return hit;

    const projectPath = encodeURIComponent(this.repoPath);
    const encodedFile = encodeURIComponent(cleanPath);
    const res = await fetch(
      `https://${this.hostname}/api/v4/projects/${projectPath}/repository/files/${encodedFile}/raw?ref=${encodeURIComponent(ref)}`,
      { headers: this.makeHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
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

  override async fetchBlob(blob: string): Promise<string | null> {
    if (!isGitObjectId(blob)) return null;
    const projectPath = encodeURIComponent(this.repoPath);
    const res = await fetch(
      `https://${this.hostname}/api/v4/projects/${projectPath}/repository/blobs/${blob.toLowerCase()}/raw`,
      { headers: this.makeHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    return res.ok ? readBlobText(res) : null;
  }

  async fetchTree(ref: string): Promise<string[] | null> {
    if (!isValidGitRef(ref)) return null;
    const key = `${this.keyPrefix}:tree:${this.hostname}:${this.repoPath}:${ref}`;
    const hit = fetchTreeCache.get(key);
    if (hit !== undefined) return hit;

    const projectPath = encodeURIComponent(this.repoPath);
    const paths: string[] = [];
    // GitLab paginates the tree; fetch a bounded number of pages for best-effort coverage.
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(
        `https://${this.hostname}/api/v4/projects/${projectPath}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&page=${page}`,
        { headers: this.makeHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (!res.ok) return page === 1 ? null : paths;
      const data = (await res.json()) as Array<{ path: string; type: string }>;
      for (const e of data) if (e.type === 'blob') paths.push(e.path);
      if (data.length < 100) break;
    }
    fetchTreeCache.set(key, paths);
    return paths;
  }

  async probeError(branch?: string): Promise<string | null> {
    try {
      const projectPath = encodeURIComponent(this.repoPath);
      const res = await fetch(`https://${this.hostname}/api/v4/projects/${projectPath}`, {
        headers: this.makeHeaders(),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        const msg = body?.message ?? `GitLab API returned ${res.status}`;
        return `GitLab API error: ${msg}`;
      }
      return `No commits found on ${branch ? `branch '${branch}'` : 'the default branch'}.`;
    } catch {
      return 'Could not reach the GitLab API. Check your network connection.';
    }
  }

  override async getDefaultBranch(): Promise<string | null> {
    const key = `${this.keyPrefix}:default-branch:${this.hostname}:${this.repoPath}`;
    const cached = defaultBranchCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const projectPath = encodeURIComponent(this.repoPath);
      const res = await fetch(`https://${this.hostname}/api/v4/projects/${projectPath}`, {
        headers: this.makeHeaders(),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { default_branch?: string };
      const branch = body.default_branch?.trim() || null;
      defaultBranchCache.set(key, branch);
      return branch;
    } catch {
      return null;
    }
  }

  // ── Merge-request feedback ─────────────────────────────────────────────────

  private projectPath(): string {
    return encodeURIComponent(this.repoPath);
  }

  override async findPullRequestForBranch(branch: string): Promise<ScmPullRequest | null> {
    if (!branch) return null;
    try {
      const url = new URL(`https://${this.hostname}/api/v4/projects/${this.projectPath()}/merge_requests`);
      url.searchParams.set('state', 'opened');
      url.searchParams.set('source_branch', branch);
      url.searchParams.set('per_page', '1');

      const res = await fetch(url.toString(), {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Array<{ iid?: number; web_url?: string; target_branch?: string }>;
      const mr = data[0];
      if (!mr?.iid) return null;
      return {
        number: mr.iid,
        url: mr.web_url ?? `https://${this.hostname}/${this.repoPath}/-/merge_requests/${mr.iid}`,
        baseBranch: mr.target_branch ?? null,
      };
    } catch {
      return null;
    }
  }

  override async upsertPullRequestComment(prNumber: number, marker: string, body: string): Promise<boolean> {
    return (await this.postPullRequestComment(prNumber, marker, body)) !== null;
  }

  override async postPullRequestComment(
    prNumber: number,
    marker: string,
    body: string,
  ): Promise<ScmPostedComment | null> {
    if (!this.token) return null;
    try {
      const base = `https://${this.hostname}/api/v4/projects/${this.projectPath()}/merge_requests/${prNumber}/notes`;

      const listUrl = new URL(base);
      listUrl.searchParams.set('per_page', '100');
      const listRes = await fetch(listUrl.toString(), {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      let existingId: number | null = null;
      if (listRes.ok) {
        const notes = (await listRes.json()) as Array<{ id?: number; body?: string; system?: boolean }>;
        existingId = notes.find((n) => !n.system && typeof n.body === 'string' && n.body.includes(marker))?.id ?? null;
      }

      const res = await fetch(existingId ? `${base}/${existingId}` : base, {
        method: existingId ? 'PUT' : 'POST',
        headers: { ...this.makeHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
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

  override async postCommitStatus(sha: string, status: ScmCommitStatus): Promise<boolean> {
    if (!this.token || !isValidGitRef(sha)) return false;
    try {
      // GitLab has no `error` state; it splits GitHub's `failure` into
      // `failed` and `canceled`. Map both non-success states onto `failed`.
      // A run in progress stays `pending`, which a later `pending` updates.
      const state = status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'failed';
      const url = new URL(
        `https://${this.hostname}/api/v4/projects/${this.projectPath()}/statuses/${encodeGitRef(sha)}`,
      );
      url.searchParams.set('state', state);
      url.searchParams.set('name', status.context);
      url.searchParams.set('description', status.description);
      url.searchParams.set('target_url', status.targetUrl);

      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Write capability (auto-heal) ───────────────────────────────────────────

  override async getBranchHead(branch: string): Promise<string | null> {
    const res = await fetch(
      `https://${this.hostname}/api/v4/projects/${this.projectPath()}/repository/branches/${encodeURIComponent(branch)}`,
      { headers: this.makeHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await gitlabError(res, 'read branch');
    const data = (await res.json()) as { commit?: { id?: string } };
    return data.commit?.id ?? null;
  }

  override async createBranch(name: string, fromSha: string): Promise<void> {
    const url = new URL(`https://${this.hostname}/api/v4/projects/${this.projectPath()}/repository/branches`);
    url.searchParams.set('branch', name);
    url.searchParams.set('ref', fromSha);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: this.makeHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw await gitlabError(res, 'create branch');
  }

  override async commitFiles(branch: string, message: string, files: ScmFileEdit[]): Promise<string> {
    const res = await fetch(`https://${this.hostname}/api/v4/projects/${this.projectPath()}/repository/commits`, {
      method: 'POST',
      headers: { ...this.makeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch,
        commit_message: message,
        actions: files.map((f) => ({ action: 'update', file_path: f.path, content: f.content })),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw await gitlabError(res, 'commit files');
    const id = ((await res.json()) as { id?: string }).id;
    if (!id) throw new Error('GitLab commit response had no id');
    return id;
  }

  override async createPullRequest(input: CreatePullRequestInput): Promise<ScmPullRequest> {
    // GitLab marks a draft MR by a `Draft:` title prefix.
    const title = input.draft ? `Draft: ${input.title}` : input.title;
    const res = await fetch(`https://${this.hostname}/api/v4/projects/${this.projectPath()}/merge_requests`, {
      method: 'POST',
      headers: { ...this.makeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_branch: input.head,
        target_branch: input.base,
        title,
        description: input.body,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw await gitlabError(res, 'open merge request');
    const mr = (await res.json()) as { iid?: number; web_url?: string };
    if (!mr.iid) throw new Error('GitLab merge request response had no iid');
    return {
      number: mr.iid,
      url: mr.web_url ?? `https://${this.hostname}/${this.repoPath}/-/merge_requests/${mr.iid}`,
    };
  }

  // ── CI re-run ──────────────────────────────────────────────────────────────

  override async dispatchRerun(
    settings: CiRerunSettings,
    playwrightArgs: string,
    request: RerunDispatchRequest = {},
  ): Promise<RerunDispatchResult> {
    const target = settings.gitlab;
    if (!target) throw new Error('No GitLab pipeline configured for CI re-run');
    const ref = request.ref || target.ref;

    const res = await fetch(`https://${this.hostname}/api/v4/projects/${this.projectPath()}/pipeline`, {
      method: 'POST',
      headers: { ...this.makeHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref,
        variables: [{ key: target.variableName, value: playwrightArgs }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw await gitlabError(res, 'trigger pipeline');
    const pipeline = (await res.json()) as { id?: number; web_url?: string };
    const url = pipeline.web_url ?? `https://${this.hostname}/${this.repoPath}/-/pipelines/${pipeline.id ?? ''}`;
    return { url, ref, ...(pipeline.id != null ? { pipelineId: String(pipeline.id) } : {}) };
  }
}
