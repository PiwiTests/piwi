import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import type { H3Event } from 'h3';
import { projects, runRequests, testRuns, users, type Project, type User } from '../database/schema';
import { getDatabase, type DbClient } from '../database';
import { apiError } from './api-error';
import { getUserAccessCached, isAuthEnabled } from './auth';
import { hashToken } from './token-hash';
import { isOptInCapabilityOn } from '#shared/handlers/capabilities';
import { can } from '#shared/permissions';
import { REQUEST_TOKEN_PREFIX } from '@piwitests/core/run-request';

/**
 * Request tokens: the credential **Run** gives the target that claimed a request, for the one run it starts. The
 * reporter presents it to `/api/test-runs/setup` or `/api/test-runs/start` in place of an API key; nothing else takes
 * it. It starts one run, of the request's project, with origin `request` and the request's id as its ref, owned by
 * the requester, and is spent as that run is stored. The run's own stream token takes over from there.
 */

/** How long a request token starts a run after **Run**, in milliseconds. */
export const REQUEST_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

/** A new request token, and the digest the request keeps in its place. */
export function newRequestToken(): { token: string; digest: string } {
  const token = `${REQUEST_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  return { token, digest: hashToken(token) };
}

/** What a request token grants: one run of the request's project, for its requester. */
export interface RequestTokenGrant {
  requestId: string;
  projectId: number;
  requester: User;
  /** The token's digest, which the spend matches. */
  digest: string;
}

function presentedRequestToken(event: H3Event): string | null {
  const authorization = getRequestHeader(event, 'authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : null;
  const value = bearer ?? getRequestHeader(event, 'x-api-key') ?? null;
  return value?.startsWith(REQUEST_TOKEN_PREFIX) ? value : null;
}

/** Whether a request presents a request token, which `checkRequestToken` reads in place of the usual authentication. */
export function presentsRequestToken(event: H3Event): boolean {
  return presentedRequestToken(event) !== null;
}

const INVALID = 'Invalid, used or expired request token';

/**
 * A request token still able to start a run: unspent and within its lifetime, of a request starting or running, held
 * by a target still connected, and not stopped by its requester.
 */
function spendable(digest: string, now: Date): SQL | undefined {
  return and(
    eq(runRequests.requestTokenDigest, digest),
    isNotNull(runRequests.requestTokenExpiresAt),
    gt(runRequests.requestTokenExpiresAt, now),
    inArray(runRequests.state, ['starting', 'running']),
    isNotNull(runRequests.targetId),
    isNull(runRequests.stopRequestedAt),
  );
}

/**
 * The run a presented request token may start: null when the request presents none, and the route authenticates as
 * usual. Refused before anything is stored: a sharded run (422), a token that is not `spendable` (401), and a
 * requester who may no longer ask for runs of the project or a project with **Run on my machine** turned off (403).
 * The token is spent by `spendRequestToken`, once the run is stored.
 */
export async function checkRequestToken(
  event: H3Event,
  body: { shardTotal?: unknown },
  now = new Date(),
): Promise<RequestTokenGrant | null> {
  const token = presentedRequestToken(event);
  if (!token) return null;
  if (!isAuthEnabled(event)) throw apiError({ statusCode: 403, message: 'Run on my machine needs sign-in turned on' });
  if (Number(body.shardTotal) > 1) throw apiError({ statusCode: 422, message: 'A requested run is not sharded' });
  const db = await getDatabase();
  const digest = hashToken(token);
  const [found] = await db
    .select({ id: runRequests.id, projectId: runRequests.projectId, requesterId: runRequests.requesterId })
    .from(runRequests)
    .where(spendable(digest, now));
  if (!found) throw apiError({ statusCode: 401, message: INVALID });
  const [requester] = await db.select().from(users).where(eq(users.id, found.requesterId));
  if (!requester) throw apiError({ statusCode: 401, message: INVALID });
  const access = await getUserAccessCached(db, requester);
  if (
    !can(access, 'run:request', found.projectId) ||
    !(await isOptInCapabilityOn(db, found.projectId, 'machine-runs'))
  ) {
    throw apiError({
      statusCode: 403,
      message: 'Run on my machine is off for this project, or you cannot run its tests',
    });
  }
  event.context.access = access;
  return { requestId: found.id, projectId: found.projectId, requester, digest };
}

/**
 * Spend the request token on the run it started, now stored, and record the run on its request, in one conditional
 * update: the token starts one run however many starts present it at once. A start that lost the race has its run
 * deleted and is refused (401); a start that failed before its run was stored leaves the token to a retry.
 */
export async function spendRequestToken(
  db: DbClient,
  grant: RequestTokenGrant,
  runId: number,
  now = new Date(),
): Promise<void> {
  const [spent] = await db
    .update(runRequests)
    .set({ requestTokenDigest: null, runId, updatedAt: now })
    .where(and(eq(runRequests.id, grant.requestId), spendable(grant.digest, now)))
    .returning({ id: runRequests.id });
  if (spent) return;
  await db.delete(testRuns).where(eq(testRuns.id, runId));
  throw apiError({ statusCode: 401, message: INVALID });
}

/** The project a request token's run reports into: the request's, whatever project name the reporter sends. */
export async function grantedProject(db: DbClient, grant: RequestTokenGrant): Promise<Project> {
  const [project] = await db.select().from(projects).where(eq(projects.id, grant.projectId));
  if (!project) throw apiError({ statusCode: 404, message: 'Project not found' });
  return project;
}
