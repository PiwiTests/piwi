import {
  CODEOWNERS_PATHS,
  compileCodeowners,
  parseCodeowners,
  type CompiledCodeowners,
} from '@piwitests/core/codeowners';
import type { CiRerunSettings } from '#shared/ci-rerun';
import { PATCH_TRUNCATED_NOTE } from '#shared/patch';

/** What a CI re-run dispatch carries besides the Playwright arguments. */
export interface RerunDispatchRequest {
  /** The branch to run on; the target's configured ref when absent. */
  ref?: string | null;
  /** The dispatch's id, sent where the target names an input for it. */
  dispatchId?: string;
}

/** What a provider answers to a CI re-run dispatch. */
export interface RerunDispatchResult {
  url: string;
  /** The branch the pipeline runs on. */
  ref?: string;
  /** GitLab's pipeline id. */
  pipelineId?: string;
  /** Bitbucket's build number. */
  buildNumber?: string;
}
import { commitUrl, compareUrl, fileUrl, type ScmProviderName } from '#shared/scm-urls';

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  /**
   * The git blob id of the file at the head commit, where the host gives it
   * (GitHub and a local clone; never for a removed file). Suspect lines use it
   * to tell whether a test's coverage refers to this version of the file.
   */
  blob?: string;
}

/** A git object id: 40 hex characters (SHA-1) or 64 (SHA-256). */
export function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

export interface ScmCommit {
  sha: string;
  /** The subject: the message's first line. */
  message: string;
  /** The whole message, trailers included, where the host returns it ({@link ScmProvider.fetchChanges} does). */
  fullMessage?: string;
}

export interface ScmCommitDetail {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
}

/** The name and email a commit records for its author. */
export interface ScmCommitAuthor {
  name: string;
  email: string;
}

export interface ScmChanges {
  commits: ScmCommit[];
  files: ChangedFile[];
  /** true when the raw diff was skipped because it exceeded the size cap */
  patchesOmitted?: boolean;
  /** true when the changed-file list was capped at {@link MAX_SCM_FILES_TOTAL} */
  filesTruncated?: boolean;
  /** total changed files the provider reported, when it exposes a count past the cap */
  totalChangedFiles?: number;
}

/** Full content of a file at a specific ref (used to ground diagnosis patches). */
export interface ScmFileContent {
  path: string;
  content: string;
  /** true when the content was truncated to MAX_FILE_BYTES */
  truncated: boolean;
}

export const MAX_SCM_FILES = 30;
/**
 * Cap on the full changed-file list a diff returns, paged up to here so a large
 * pull request's later files are not silently dropped. When a diff has more, the
 * result is capped at this many and flagged `filesTruncated` with `totalChangedFiles`
 * where the provider exposes a count, so the comment can say "and N more".
 */
export const MAX_SCM_FILES_TOTAL = 300;
export const MAX_PATCH_PER_FILE = 100_000;
export const MAX_RAW_DIFF_BYTES = 200_000;
/** Cap on a single file's content fetched via fetchFileAtRef. */
export const MAX_FILE_BYTES = 200_000;
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * A blob response's text, or null when it is longer than {@link MAX_FILE_BYTES}
 * characters: a blob is served whole or not at all. A body whose declared size
 * is past four bytes a character is not read.
 */
export async function readBlobText(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES * 4) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const text = await res.text();
  return text.length > MAX_FILE_BYTES ? null : text;
}

export function truncatePatch(patch: string): string {
  if (patch.length <= MAX_PATCH_PER_FILE) return patch;
  return `${patch.slice(0, MAX_PATCH_PER_FILE)}\n${PATCH_TRUNCATED_NOTE}`;
}

/** FNV-1a 32-bit hash → 8 hex chars. Stable, dependency-free, good enough to namespace cache keys by token. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** An open pull request / merge request the run's branch belongs to. */
export interface ScmPullRequest {
  /** Number on GitHub / Bitbucket, `iid` on GitLab. */
  number: number;
  url: string;
}

/** Normalized lifecycle state of an issue or pull/merge request. */
export type ScmEntityState = 'open' | 'closed' | 'merged' | 'draft' | null;

/**
 * An issue or pull/merge request reduced to what an unfurl card needs. Each
 * provider maps its own host's state vocabulary onto {@link ScmEntityState}.
 */
export interface ScmEntityRef {
  title: string | null;
  state: ScmEntityState;
  /** Display name or login of the author, or null when the host omits it. */
  author: string | null;
  /** Canonical web URL of the entity, or null when the host omits it. */
  url: string | null;
  /** ISO-8601 timestamp of the last update, or null. */
  updatedAt: string | null;
}

/** The comment Piwi posted on a pull request. */
export interface ScmPostedComment {
  /** The host's id of the comment, or null when it returned none. */
  id: string | null;
}

/** A commit status (GitHub "status", GitLab "commit status", Bitbucket "build status"). */
export interface ScmCommitStatus {
  state: 'success' | 'failure' | 'error' | 'pending';
  description: string;
  targetUrl: string;
  context: string;
}

/** One file to create/update in a commit. */
export interface ScmFileEdit {
  path: string;
  content: string;
}

/** Inputs for opening a pull/merge request. */
export interface CreatePullRequestInput {
  title: string;
  body: string;
  /** Source branch (already pushed). */
  head: string;
  /** Target branch. */
  base: string;
  /** Open as a draft where the host supports it (Bitbucket has no drafts). */
  draft: boolean;
}

export abstract class ScmProvider {
  abstract readonly provider: ScmProviderName;
  /** Canonical web URL of the repository (no trailing slash), for building links. */
  abstract readonly webUrl: string;
  protected readonly token: string | null;
  /**
   * Namespaces module-level cache keys by the token in use so a token-less
   * (public, rate-limited) fetch can never serve its result to an authenticated
   * caller, or vice-versa.
   */
  protected readonly keyPrefix: string;

  constructor(token: string | null) {
    this.token = token;
    this.keyPrefix = token ? shortHash(token) : 'anon';
  }

  protected makeHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'User-Agent': 'piwi-dashboard' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  // ── Web links ──────────────────────────────────────────────────────────────
  // Built from this provider's own `webUrl` through the shared `#shared/scm-urls`
  // module, so server code that holds a provider never hand-writes a URL.

  /** URL for viewing one commit. */
  commitUrl(sha: string): string | null {
    return commitUrl(this.webUrl, sha);
  }

  /** URL comparing two commits. */
  compareUrl(fromSha: string, toSha: string): string | null {
    return compareUrl(this.webUrl, fromSha, toSha);
  }

  /** URL for a file at a ref, optionally anchored to a line. */
  fileUrl(ref: string, path: string, line?: number | null): string | null {
    return fileUrl(this.webUrl, ref, path, line);
  }

  abstract listBranches(limit?: number): Promise<string[]>;
  abstract listCommits(limit?: number, branch?: string): Promise<ScmCommitDetail[]>;
  /**
   * The commits in `fromSha..toSha`, oldest first, each with its full message,
   * and the files changed between the two.
   */
  abstract fetchChanges(fromSha: string, toSha: string): Promise<ScmChanges | null>;
  abstract fetchCommitDiff(sha: string): Promise<ScmChanges | null>;
  /**
   * The author (name + email) a commit records, or null when the commit cannot
   * be read or the host does not expose an email. Best-effort like the other
   * read lookups — a token-less or failing fetch returns null — and content is
   * immutable per SHA, so implementations cache aggressively.
   */
  abstract getCommitAuthor(sha: string): Promise<ScmCommitAuthor | null>;
  abstract probeError(branch?: string): Promise<string | null>;
  /**
   * Full content of a single file at a ref (commit SHA / branch). Returns null
   * when the file does not exist at that ref or the fetch fails. Content is
   * immutable per SHA, so implementations may cache aggressively.
   */
  abstract fetchFileAtRef(path: string, ref: string): Promise<ScmFileContent | null>;

  /**
   * The content of a git blob, read by its id, when it is at most
   * {@link MAX_FILE_BYTES} characters. Null when the host cannot read a blob by
   * id (this default), the blob is larger, or the fetch fails. A blob never
   * changes, so a caller may keep the answer under its id.
   */
  async fetchBlob(_blob: string): Promise<string | null> {
    return null;
  }

  /**
   * Recursive list of repo-relative file paths at a ref. Used to normalize
   * reporter paths to repo-relative and to validate patch paths. Returns null
   * on failure; may be capped by the provider.
   */
  abstract fetchTree(ref: string): Promise<string[] | null>;

  /**
   * An issue reduced to {@link ScmEntityRef}, or null when the host has no such
   * issue, the repository disabled issues, or the fetch fails. Best-effort like
   * the other reads: a token-less fetch still works against a public repo.
   */
  abstract fetchIssue(number: number): Promise<ScmEntityRef | null>;

  /**
   * A pull/merge request reduced to {@link ScmEntityRef}, or null when it does
   * not exist or the fetch fails. Best-effort, like {@link fetchIssue}.
   */
  abstract fetchPullRequest(number: number): Promise<ScmEntityRef | null>;

  // ── Pull-request feedback (optional capability) ────────────────────────────
  //
  // A provider that cannot post feedback inherits these no-ops rather than
  // declaring the methods and throwing, so `postRunPrFeedback` treats "this
  // host doesn't support it" and "nothing to post" the same way. Every
  // implementation swallows its own errors and reports failure by return value:
  // feedback is best-effort decoration on a run that has already been stored,
  // and must never surface as an ingest error.

  /** The open pull request whose source branch is `branch`, if there is one. */
  async findPullRequestForBranch(_branch: string): Promise<ScmPullRequest | null> {
    return null;
  }

  /**
   * Create the run-summary comment on a pull request, or edit the existing one.
   * `marker` identifies Piwi's own comment; implementations must only ever edit
   * a comment containing it. Returns true when something was posted.
   */
  async upsertPullRequestComment(_prNumber: number, _marker: string, _body: string): Promise<boolean> {
    return false;
  }

  /**
   * {@link upsertPullRequestComment} that also returns the host's id of the
   * comment, for the run's PR feedback record. Null when nothing was posted;
   * `id` is null when the host did not say.
   */
  async postPullRequestComment(prNumber: number, marker: string, body: string): Promise<ScmPostedComment | null> {
    return (await this.upsertPullRequestComment(prNumber, marker, body)) ? { id: null } : null;
  }

  /** Attach a status to a commit. Returns true when it was accepted. */
  async postCommitStatus(_sha: string, _status: ScmCommitStatus): Promise<boolean> {
    return false;
  }

  /**
   * The repository's default branch as the host reports it (`default_branch` on
   * GitHub/GitLab, `mainbranch.name` on Bitbucket), or `null` when it cannot be
   * read. Best-effort, like the other read capabilities: a token-less or failing
   * fetch returns null so the caller falls back to its next default-branch
   * source rather than surfacing an error.
   */
  async getDefaultBranch(): Promise<string | null> {
    return null;
  }

  // ── Write capability (auto-heal) ───────────────────────────────────────────
  //
  // Unlike the read/feedback methods above — which swallow errors and report
  // failure by return value — the write methods THROW on failure with the
  // provider's own message. Auto-heal records that message on a durable action
  // row and retries; a swallowed error would erase exactly what the operator
  // needs to see, and a half-completed branch/commit/PR sequence must never look
  // like a success. A provider with no write support inherits these throws.

  /** The head commit SHA of a branch, or null when the branch does not exist. */
  async getBranchHead(_branch: string): Promise<string | null> {
    throw new Error(`${this.provider} does not support reading a branch head`);
  }

  /** Create a branch at `fromSha`. Throws on failure. */
  async createBranch(_name: string, _fromSha: string): Promise<void> {
    throw new Error(`${this.provider} does not support creating branches`);
  }

  /** Commit `files` onto `branch` as one commit; returns the new commit SHA. Throws on failure. */
  async commitFiles(_branch: string, _message: string, _files: ScmFileEdit[]): Promise<string> {
    throw new Error(`${this.provider} does not support committing files`);
  }

  /** Open a pull/merge request; returns its number + URL. Throws on failure. */
  async createPullRequest(_input: CreatePullRequestInput): Promise<ScmPullRequest> {
    throw new Error(`${this.provider} does not support opening pull requests`);
  }

  // ── CI re-run (workflow / pipeline dispatch) ───────────────────────────────
  //
  // Like the auto-heal write methods, this THROWS on failure with the provider's
  // own message so the route can surface exactly what went wrong; the caller
  // has already checked the feature is enabled and a target is configured.

  /**
   * Dispatch a CI re-run of the given Playwright arguments, using this
   * provider's target in `settings`, on `request.ref` when given (else the
   * target's own ref). Returns the runs/pipeline URL to watch and the
   * provider's id for the pipeline it created, when it answers with one.
   * Throws when the provider is unsupported, has no configured target, or the
   * dispatch request fails.
   */
  async dispatchRerun(
    _settings: CiRerunSettings,
    _playwrightArgs: string,
    _request: RerunDispatchRequest = {},
  ): Promise<RerunDispatchResult> {
    throw new Error(`${this.provider} does not support CI re-run`);
  }

  /**
   * The repository's CODEOWNERS, compiled and ready to match, or `null` when
   * the repository has none.
   *
   * Implemented once here rather than per provider: every host serves the file
   * through `fetchFileAtRef`, which already caches, so this inherits caching
   * and needs no provider-specific request.
   */
  async fetchCodeowners(ref: string): Promise<CompiledCodeowners | null> {
    for (const path of CODEOWNERS_PATHS) {
      const file = await this.fetchFileAtRef(path, ref);
      if (file?.content?.trim()) return compileCodeowners(parseCodeowners(file.content));
    }
    return null;
  }
}
