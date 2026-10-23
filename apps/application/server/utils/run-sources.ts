/**
 * The source files a patch changes, read through the project's SCM provider
 * at the commit of the run the failure was seen in, and a patch validated
 * against them with `validatePatch`, so its badge means the same wherever it
 * shows: on a diagnosis or in an assistant's answer.
 */
import { eq } from 'drizzle-orm';
import { validatePatch, type PatchValidation } from '#shared/patch';
import { MAX_PATCH_FILES_CHECKED, patchTargetFiles } from '#shared/handlers/agent-diagnosis';
import { testRuns } from '../database/schema';
import type { DbClient } from '../database';
import { createScmProvider } from './scm';
import { normalizeGitUrl } from './scm/git-url';
import type { RunMetadata } from './run-json-types';

/** Read the files a patch names at the commit of a run; null without SCM. */
export async function loadRunSources(
  db: DbClient,
  runId: number,
  paths: string[],
): Promise<Map<string, string> | null> {
  const [run] = await db
    .select({ projectId: testRuns.projectId, metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  const scm = (run?.metadata as RunMetadata | null)?.scm;
  const repositoryUrl = normalizeGitUrl(scm?.remoteUrl ?? null);
  if (!run || !repositoryUrl || !scm?.commit) return null;
  const provider = await createScmProvider(repositoryUrl, db, run.projectId);
  if (!provider) return null;
  const files = new Map<string, string>();
  for (const path of paths) {
    const file = await provider.fetchFileAtRef(path, scm.commit).catch(() => null);
    if (file && !file.truncated) files.set(path, file.content);
  }
  return files;
}

/** A patch validated against the files it changes at a run's commit; null when the run's files cannot be read (no SCM). */
export async function validatePatchAtRun(db: DbClient, runId: number, patch: string): Promise<PatchValidation | null> {
  const paths = patchTargetFiles(patch).slice(0, MAX_PATCH_FILES_CHECKED);
  const sources = await loadRunSources(db, runId, paths).catch(() => null);
  return sources ? validatePatch(patch, sources) : null;
}
