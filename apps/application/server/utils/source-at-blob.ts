/**
 * The source of a file at a git blob: the version a coverage's line numbers
 * refer to. It is read through the project's source control provider, by the
 * blob's id where the provider reads blobs (a local clone, GitHub, GitLab),
 * else as the file at a run's commit, kept only when its git blob id is the
 * one asked. A blob is served whole, up to the size a fetched file is capped
 * at, or not at all. Sources are kept an hour per project and blob id (a blob
 * never changes), and a source that could not be read two minutes.
 */
import { desc, eq } from 'drizzle-orm';
import { gitBlobId } from '#shared/utils/hash';
import { testRuns } from '../database/schema';
import type { DbClient } from '../database';
import type { RunMetadata } from './run-json-types';
import { createScmProvider } from './scm';
import { normalizeGitUrl } from './scm/git-url';
import { isValidGitRef } from './scm/refs';
import type { ScmProvider } from './scm/ScmProvider';
import { TtlCache } from './ttl-cache';

/** A file's source at a blob. */
export interface SourceAtBlob {
  /** The repository-relative path asked for. */
  path: string;
  /** The git blob id, lowercase. */
  blob: string;
  content: string;
}

const SOURCE_TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 2 * 60 * 1000;
const sources = new TtlCache<string>(SOURCE_TTL_MS, 100);
const misses = new TtlCache<true>(MISS_TTL_MS, 500);

/** The project's runs read, newest first, for a repository when the run asked for records none. */
const RECENT_RUNS = 20;

/** Where to read a project's source: its repository, and the commit of the run to fall back on. */
interface SourceRepository {
  repositoryUrl: string;
  commit: string | null;
}

function repositoryOf(metadata: unknown): SourceRepository | null {
  const scm = (metadata as RunMetadata | null)?.scm;
  const repositoryUrl = normalizeGitUrl(scm?.remoteUrl ?? null);
  if (!repositoryUrl) return null;
  const commit = scm?.commit && isValidGitRef(scm.commit) ? scm.commit : null;
  return { repositoryUrl, commit };
}

/**
 * The repository of a project's run and the run's commit; for a run that
 * records no repository, the project's newest run that records one, with the
 * run's own commit. Without a run of the project, the newest run that records
 * a repository, with its commit. Null when none of them does.
 */
async function sourceRepository(
  db: DbClient,
  projectId: number,
  runId: number | null,
): Promise<SourceRepository | null> {
  /** The commit of the run asked for, when it is a run of the project. */
  let runCommit: string | null | undefined;
  if (runId != null) {
    const [run] = await db
      .select({ projectId: testRuns.projectId, metadata: testRuns.metadata })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    if (run?.projectId === projectId) {
      const own = repositoryOf(run.metadata);
      if (own) return own;
      const commit = (run.metadata as RunMetadata | null)?.scm?.commit;
      runCommit = commit && isValidGitRef(commit) ? commit : null;
    }
  }
  const recent = await db
    .select({ metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId))
    .orderBy(desc(testRuns.id))
    .limit(RECENT_RUNS);
  for (const run of recent) {
    const found = repositoryOf(run.metadata);
    if (found) return runCommit === undefined ? found : { ...found, commit: runCommit };
  }
  return null;
}

/** The file at `commit`, when its git blob id is `blob`; null otherwise. */
async function fileWithBlob(provider: ScmProvider, path: string, commit: string, blob: string): Promise<string | null> {
  const file = await provider.fetchFileAtRef(path, commit);
  if (!file || file.truncated) return null;
  const id = await gitBlobId(file.content, blob.length === 64 ? 'sha256' : 'sha1');
  return id === blob ? file.content : null;
}

/**
 * The source of `path` at `blob` in a project's repository, read as the
 * module header says; `runId` names the run whose commit the fallback reads.
 * Null when the provider cannot serve it.
 */
export async function getSourceAtBlob(
  db: DbClient,
  projectId: number,
  input: { path: string; blob: string; runId?: number | null },
): Promise<SourceAtBlob | null> {
  const blob = input.blob.toLowerCase();
  const key = `${projectId}\x00${blob}`;
  const known = sources.get(key);
  if (known !== undefined) return { path: input.path, blob, content: known };
  const missKey = `${key}\x00${input.path}\x00${input.runId ?? ''}`;
  if (misses.get(missKey)) return null;

  let content: string | null = null;
  try {
    const repository = await sourceRepository(db, projectId, input.runId ?? null);
    const provider = repository ? await createScmProvider(repository.repositoryUrl, db, projectId) : null;
    if (provider) {
      content = await provider.fetchBlob(blob);
      if (content === null && repository?.commit) {
        content = await fileWithBlob(provider, input.path, repository.commit, blob);
      }
    }
  } catch {
    content = null;
  }

  if (content === null) {
    misses.set(missKey, true);
    return null;
  }
  sources.set(key, content);
  return { path: input.path, blob, content };
}

/** Forget every kept source; for tests. */
export function clearSourceAtBlobCache(): void {
  sources.deleteWhere(() => true);
  misses.deleteWhere(() => true);
}
