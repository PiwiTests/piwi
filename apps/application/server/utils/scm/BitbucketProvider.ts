import {
  ScmProvider,
  type RerunDispatchRequest,
  type RerunDispatchResult,
  truncatePatch,
  MAX_SCM_FILES_TOTAL,
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
  CreatePullRequestInput,
} from './ScmProvider';
import { TtlCache } from '../ttl-cache';
import { isValidGitRef, encodeGitRef, encodePathSegments } from './refs';
import type { CiRerunSettings } from '#shared/ci-rerun';

/** Turn a non-2xx Bitbucket response into an Error carrying the API's own message. */
async function bitbucketError(res: Response, action: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return new Error(`Bitbucket ${action} failed (${res.status}): ${body.error?.message ?? res.statusText}`);
}

const listBranchesCache = new TtlCache<string[]>(3 * 60 * 1000);
const listCommitsCache = new TtlCache<ScmCommitDetail[]>(3 * 60 * 1000);
const fetchChangesCache = new TtlCache<ScmChanges>(10 * 60 * 1000);
const rangeCommitsCache = new TtlCache<ScmCommit[]>(10 * 60 * 1000);
/** Commits listed for one range: one page of the commits endpoint. */
const MAX_RANGE_COMMITS = 100;
const fetchFileCache = new TtlCache<ScmFileContent | null>(30 * 60 * 1000);
const defaultBranchCache = new TtlCache<string | null>(30 * 60 * 1000);
// Author is immutable per SHA, so cache it (incl. negative lookups) for longer.
const commitAuthorCache = new TtlCache<ScmCommitAuthor | null>(30 * 60 * 1000);

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

function parsePatchesByFile(rawDiff: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = rawDiff.split('\n');
  let currentFile = '';
  let currentLines: string[] = [];

  const flush = () => {
    if (currentFile) result.set(currentFile, truncatePatch(currentLines.join('\n')));
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = line.match(/ b\/(.+)$/);
      currentFile = match ? (match[1] ?? '') : '';
      currentLines = [line];
    } else if (currentFile) {
      currentLines.push(line);
    }
  }
  flush();
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

    const url = branch
      ? `${this.base}/commits/${encodeURIComponent(branch)}?pagelen=${limit}`
      : `${this.base}/commits?pagelen=${limit}`;
    const res = await fetch(url, {
      headers: this.makeHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      values?: Array<{ hash: string; message: string; author: { raw?: string }; date: string }>;
    };
    const result = (data.values ?? []).map((c) => ({
      sha: c.hash,
      shortSha: c.hash.slice(0, 7),
      message: (c.message.split('\n')[0] ?? '').trim(),
      author: (c.author?.raw ?? '').replace(/<[^>]+>\s*$/, '').trim(),
      date: c.date,
    }));
    listCommitsCache.set(key, result);
    return result;
  }

  async fetchChanges(fromSha: string, toSha: string): Promise<ScmChanges | null> {
    if (!isValidGitRef(fromSha) || !isValidGitRef(toSha)) return null;
    const [changes, commits] = await Promise.all([this.diffRange(fromSha, toSha), this.rangeCommits(fromSha, toSha)]);
    return changes ? { ...changes, commits } : null;
  }

  /**
   * The commits reachable from `toSha` and not from `fromSha`, oldest first as
   * the other hosts list them, with their full messages. Empty when the
   * commits endpoint fails: the files still answer.
   */
  private async rangeCommits(fromSha: string, toSha: string): Promise<ScmCommit[]> {
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
      if (!res.ok) return [];
      const data = (await res.json()) as { values?: Array<{ hash: string; message?: string }> };
      const result = (data.values ?? [])
        .map((c) => {
          const message = c.message ?? '';
          return { sha: c.hash.slice(0, 7), message: (message.split('\n')[0] ?? '').trim(), fullMessage: message };
        })
        .reverse();
      rangeCommitsCache.set(key, result);
      return result;
    } catch {
      return [];
    }
  }

  /**
   * Diff two refs. Callers pass either two validated refs (fetchChanges) or a
   * commit and its own `~1` parent (fetchCommitDiff) — the parent suffix is built
   * from an already-validated SHA, so each ref is trusted here and encoded per
   * segment before it enters the `from..to` spec.
   */
  private async diffRange(fromRef: string, toRef: string): Promise<ScmChanges | null> {
    const key = `${this.keyPrefix}:${this.workspace}/${this.repoSlug}:${fromRef}:${toRef}`;
    const hit = fetchChangesCache.get(key);
    if (hit !== undefined) return hit;

    const spec = `${encodeGitRef(fromRef)}..${encodeGitRef(toRef)}`;
    // Raw patch text in parallel; the diffstat is paged for the file list.
    const diffPromise = fetch(`${this.base}/diff/${spec}`, {
      headers: this.makeHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    type DiffStatValue = {
      status: string;
      old?: { path: string };
      new?: { path: string };
      lines_removed?: number;
      lines_added?: number;
    };
    const values: DiffStatValue[] = [];
    let filesTruncated = false;
    // Follow Bitbucket's `next` cursor up to the total cap so a large pull
    // request's later files are not silently dropped at one page of 30.
    let next: string | null = `${this.base}/diffstat/${spec}?pagelen=100`;
    let firstPage = true;
    while (next && values.length < MAX_SCM_FILES_TOTAL) {
      const res: Response = await fetch(next, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (firstPage) return null;
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

    const diffRes = await diffPromise;
    let patchesByFile = new Map<string, string>();
    let patchesOmitted = false;
    if (diffRes.ok) {
      const rawDiff = await diffRes.text();
      if (rawDiff.length > MAX_RAW_DIFF_BYTES) {
        patchesOmitted = true;
      } else {
        patchesByFile = parsePatchesByFile(rawDiff);
      }
    }

    const result: ScmChanges = {
      commits: [],
      patchesOmitted,
      filesTruncated,
      files: values.map((f) => {
        const filename = (f.new?.path || f.old?.path) ?? '';
        return {
          filename,
          status: f.status,
          additions: f.lines_added ?? 0,
          deletions: f.lines_removed ?? 0,
          patch: patchesByFile.get(filename),
        };
      }),
    };
    fetchChangesCache.set(key, result);
    return result;
  }

  async fetchCommitDiff(sha: string): Promise<ScmChanges | null> {
    if (!isValidGitRef(sha)) return null;
    // `${sha}~1` is git rev syntax, not a plain ref, so it is built from the
    // validated SHA and handed straight to diffRange rather than re-validated.
    return this.diffRange(`${sha}~1`, sha);
  }

  async getCommitAuthor(sha: string): Promise<ScmCommitAuthor | null> {
    if (!isValidGitRef(sha)) return null;
    const key = `${this.keyPrefix}:author:${this.workspace}/${this.repoSlug}:${sha}`;
    const hit = commitAuthorCache.get(key);
    if (hit !== undefined) return hit;

    try {
      const res = await fetch(`${this.base}/commit/${encodeURIComponent(sha)}`, {
        headers: this.makeHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        commitAuthorCache.set(key, null);
        return null;
      }
      const data = (await res.json()) as { author?: { raw?: string } };
      const result = data.author?.raw ? parseAuthorRaw(data.author.raw) : null;
      commitAuthorCache.set(key, result);
      return result;
    } catch {
      return null;
    }
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
      fetchFileCache.set(key, null);
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
        summary: { raw: input.body },
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
