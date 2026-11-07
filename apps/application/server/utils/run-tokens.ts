import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { H3Event } from 'h3';
import { projects, runRequests, users, type Project, type User } from '../database/schema';
import { getDatabase, type DbClient } from '../database';
import { apiError } from './api-error';
import { getUserAccessCached, isAuthEnabled } from './auth';
import { hashToken } from './token-hash';
import { isOptInCapabilityOn } from '#shared/handlers/capabilities';
import { can } from '#shared/permissions';

/**
 * Run tokens: the credential **Run** gives the target that claimed a request, for the one run it starts. The reporter
 * presents it to `/api/test-runs/setup` or `/api/test-runs/start` in place of an API key; nothing else takes it. It
 * starts one run, of the request's project, with origin `request` and the request's id as its ref, owned by the
 * requester, and is spent by that start. The run's own stream token takes over from there.
 */

/** The prefix of a run token, apart from an API key's, so `extractApiKey` never reads one. */
export const RUN_TOKEN_PREFIX = 'pdq_';

/** How long a run token starts a run after **Run**, in milliseconds. */
export const RUN_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

/** A new run token, and the digest the request keeps in its place. */
export function newRunToken(): { token: string; digest: string } {
  const token = `${RUN_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  return { token, digest: hashToken(token) };
}

/** What a spent run token grants: one run of the request's project, for its requester. */
export interface RunTokenGrant {
  requestId: string;
  projectId: number;
  requester: User;
}

function presentedRunToken(event: H3Event): string | null {
  const authorization = getRequestHeader(event, 'authorization') ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : null;
  const value = bearer ?? getRequestHeader(event, 'x-api-key') ?? null;
  return value?.startsWith(RUN_TOKEN_PREFIX) ? value : null;
}

/** Whether a request presents a run token, which `spendRunToken` reads in place of the usual authentication. */
export function presentsRunToken(event: H3Event): boolean {
  return presentedRunToken(event) !== null;
}

const INVALID = 'Invalid, used or expired run token';

/**
 * The run token a request presents, spent: null when it presents none, and the route authenticates as usual. Every
 * check runs before the spend, so a refused start leaves the token to a retry: a sharded run (422), a token past its
 * lifetime, spent, or of a request no longer starting or running or whose requester stopped it (401), and a requester
 * who may no longer ask for runs of the project or a project with **Run on my machine** turned off (403). The spend is
 * one conditional update, so the token starts one run however many requests present it.
 */
export async function spendRunToken(
  event: H3Event,
  body: { shardTotal?: unknown },
  now = new Date(),
): Promise<RunTokenGrant | null> {
  const token = presentedRunToken(event);
  if (!token) return null;
  if (!isAuthEnabled(event)) throw apiError({ statusCode: 403, message: 'Run on my machine needs sign-in turned on' });
  if (typeof body.shardTotal === 'number' && body.shardTotal > 1) {
    throw apiError({ statusCode: 422, message: 'A requested run is not sharded' });
  }
  const db = await getDatabase();
  const spendable = and(
    eq(runRequests.runTokenDigest, hashToken(token)),
    isNotNull(runRequests.runTokenExpiresAt),
    gt(runRequests.runTokenExpiresAt, now),
    inArray(runRequests.state, ['starting', 'running']),
    isNull(runRequests.stopRequestedAt),
  );
  const [found] = await db
    .select({ id: runRequests.id, projectId: runRequests.projectId, requesterId: runRequests.requesterId })
    .from(runRequests)
    .where(spendable);
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
  const [spent] = await db
    .update(runRequests)
    .set({ runTokenDigest: null, updatedAt: now })
    .where(and(eq(runRequests.id, found.id), spendable))
    .returning({ id: runRequests.id });
  if (!spent) throw apiError({ statusCode: 401, message: INVALID });
  event.context.access = access;
  return { requestId: found.id, projectId: found.projectId, requester };
}

/** Record the run a run token started on its request, for the requester's page to follow. */
export async function bindRunToRequest(db: DbClient, grant: RunTokenGrant, runId: number): Promise<void> {
  await db.update(runRequests).set({ runId, updatedAt: new Date() }).where(eq(runRequests.id, grant.requestId));
}

/** The project a run token's run reports into: the request's, whatever project name the reporter sends. */
export async function grantedProject(db: DbClient, grant: RunTokenGrant): Promise<Project> {
  const [project] = await db.select().from(projects).where(eq(projects.id, grant.projectId));
  if (!project) throw apiError({ statusCode: 404, message: 'Project not found' });
  return project;
}
