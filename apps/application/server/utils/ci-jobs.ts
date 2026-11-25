/**
 * CI action listings: the jobs a target can dispatch and the fields one job
 * declares, read without starting anything, for the CI action editor. Each
 * kind of target's provider reads them (`./ci-providers/`): a repository
 * host's from its workflow or pipeline file at the commit the ref names now,
 * a CI server's from the CI server. An answer whose reads all succeeded is
 * kept five minutes, by project and target, and by person for a per-user
 * credential, whose listing is what that person's own account sees.
 */
import { TtlCache } from './ttl-cache';
import { readProjectRepositoryUrl } from './scm/project-repository';
import { configuredGitlabHosts } from './scm/gitlab-hosts';
import { ciProvider } from './ci-providers';
import { ciTargetDefinition } from '#shared/ci-targets';
import { isCiActionId, resolveCiListingTarget, type CiListingTarget } from '#shared/ci-actions';
import { ciActionsCredentialProblem, loadCredentialRecord } from '#shared/handlers/credentials';
import { MAX_CI_JOB_FIELDS, type CiJobFieldListing, type CiJobListing } from '#shared/ci-job-fields';
import type { CiServerUse } from './ci-server-dispatch';
import type { DbClient } from '../database';

const jobsCache = new TtlCache<CiJobListing>(5 * 60 * 1000);
const fieldsCache = new TtlCache<CiJobFieldListing>(5 * 60 * 1000);

/** Who a listing is kept for: everyone, or the person whose own token a per-user credential sends. */
async function listingViewer(db: DbClient, target: CiListingTarget, use: CiServerUse): Promise<string> {
  // Only a CI server credential is per user.
  const credentialId = target.type === 'ci-server' ? target.credentialId : null;
  if (credentialId == null) return '*';
  const record = await loadCredentialRecord(db, credentialId);
  return record?.perUser ? `user:${use.actor.userId ?? 'none'}` : '*';
}

const cacheKey = (viewer: string, projectId: number, target: CiListingTarget) =>
  `${viewer}:${projectId}:${JSON.stringify(target)}`;
/** What a job listing depends on: the target, whichever job is picked. */
const jobsKey = (viewer: string, projectId: number, target: CiListingTarget) =>
  `${viewer}:${projectId}:${JSON.stringify(ciTargetDefinition(target.type).withoutJob(target))}`;

/**
 * The jobs a target lists, for the CI action editor: a repository's
 * dispatchable workflows or custom pipelines, or a CI server's jobs. A GitLab
 * pipeline runs the CI file of its ref, so it lists none. `refresh` reads
 * again instead of answering from what was kept.
 */
export async function listCiJobs(
  db: DbClient,
  projectId: number,
  target: CiListingTarget,
  use: CiServerUse,
  options: { refresh?: boolean } = {},
): Promise<CiJobListing> {
  const key = jobsKey(await listingViewer(db, target, use), projectId, target);
  if (options.refresh) jobsCache.delete(key);
  const hit = jobsCache.get(key);
  if (hit) return hit;

  const { complete, ...listing } = await ciProvider(target.type).listJobs(db, projectId, target, use);
  // A list some read failed for is read again next time.
  if (listing.jobs && complete) jobsCache.set(key, listing);
  return listing;
}

/**
 * The fields the target's job declares, for the CI action editor: a GitHub
 * workflow's inputs, a GitLab CI file's variables, a Bitbucket custom
 * pipeline's variables, or a Jenkins job's parameters. `refresh` reads again
 * instead of answering from what was kept.
 */
export async function listCiJobFields(
  db: DbClient,
  projectId: number,
  target: CiListingTarget,
  use: CiServerUse,
  options: { refresh?: boolean } = {},
): Promise<CiJobFieldListing> {
  const key = cacheKey(await listingViewer(db, target, use), projectId, target);
  if (options.refresh) fieldsCache.delete(key);
  const hit = fieldsCache.get(key);
  if (hit) return hit;

  let listing = await ciProvider(target.type).listFields(db, projectId, target, use);
  if (listing.fields && listing.fields.length > MAX_CI_JOB_FIELDS) {
    listing = {
      fields: listing.fields.slice(0, MAX_CI_JOB_FIELDS),
      message: [listing.message, `Only the first ${MAX_CI_JOB_FIELDS} fields are listed.`].filter(Boolean).join(' '),
    };
  }
  if (listing.fields) fieldsCache.set(key, listing);
  return listing;
}

/**
 * A listing request's body (`{ target, name?, actionId?, refresh? }`, the
 * target as an action's, its job optional) as the target to list from, or why
 * it cannot be listed from: a target that names nothing to read, or a
 * credential the project may not name (refused as a save of the action would
 * refuse it). `actionId`, the action being edited, names it in the credential
 * log.
 */
export async function resolveCiListingRequest(
  db: DbClient,
  projectId: number,
  body: unknown,
): Promise<{ target: CiListingTarget; refresh: boolean; actionId?: string } | { error: string }> {
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const resolved = resolveCiListingTarget(raw.target);
  if ('error' in resolved) return resolved;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'This CI action';
  const problem = await ciActionsCredentialProblem(
    db,
    projectId,
    { actions: [{ name, target: resolved.target }] },
    [],
    configuredGitlabHosts(),
    await readProjectRepositoryUrl(db, projectId),
  );
  if (problem) return { error: problem };
  const actionId = typeof raw.actionId === 'string' && isCiActionId(raw.actionId) ? raw.actionId : undefined;
  return { target: resolved.target, refresh: raw.refresh === true, ...(actionId ? { actionId } : {}) };
}
