/**
 * The `ci_dispatches` reads and writes the server's dispatch
 * (`server/utils/ci-rerun.ts`) and the demo's share: storing a dispatch before
 * it is sent, with the guard against the same one twice, settling it with the
 * provider's answer, and reading dispatches as the API answers them. Matching
 * a run to a dispatch is the server's (`server/utils/ci-dispatches.ts`).
 */
import { and, desc, eq, gte, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import { ciDispatches, testRuns, type CiDispatchRow } from '../../server/database/schema';
import type { CiActionKind } from '#shared/ci-actions';
import type { CiRerunProvider } from '#shared/ci-rerun';
import type { CiServerPreset } from '#shared/ci-server';
import {
  CI_DISPATCH_GUARD_MS,
  CI_DISPATCH_MATCH_WINDOW_MS,
  ciDispatchState,
  type CiDispatchOrigin,
  type CiDispatchRun,
  type CiDispatchState,
  type CiDispatchView,
} from '#shared/ci-dispatches';
import type { DrizzleDB } from './db';

/** A dispatch as it is stored before it is sent. */
export interface NewCiDispatch {
  id: string;
  projectId: number;
  actionId: string | null;
  actionName: string | null;
  origin: CiDispatchOrigin;
  kind: CiActionKind;
  sourceRunId: number | null;
  clusterId: number | null;
  testCaseId: number | null;
  provider: CiRerunProvider;
  preset: CiServerPreset | null;
  ref: string | null;
  inputs: Record<string, string>;
  args: string;
  files: string[] | null;
  tests: number | null;
  byUserId: number | null;
  byName: string | null;
}

/** The inputs as one string, keys sorted, so two dispatches that send the same values compare equal. */
function inputsKey(inputs: unknown): string {
  const record =
    inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? (inputs as Record<string, unknown>) : {};
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((k) => [k, record[k]]),
  );
}

const epoch = (d: Date | number | null | undefined) => (d instanceof Date ? d.getTime() : Number(d ?? 0));

/**
 * Store a dispatch about to be sent, unless the same one (action, kind,
 * arguments, branch, a branch left to the target counting as any, and inputs) was stored less than {@link CI_DISPATCH_GUARD_MS}
 * before, refused ones aside: the row is then removed and the earlier dispatch
 * returned. The row goes in first, so of two requests that race, the earlier
 * one alone is sent.
 */
export async function claimCiDispatch(
  db: DrizzleDB,
  row: NewCiDispatch,
  now = new Date(),
): Promise<{ claimed: true } | { claimed: false; existing: CiDispatchView }> {
  await db.insert(ciDispatches).values({ ...row, state: 'dispatched', createdAt: now, updatedAt: now });
  const recent = await db
    .select()
    .from(ciDispatches)
    .where(
      and(
        eq(ciDispatches.projectId, row.projectId),
        eq(ciDispatches.kind, row.kind),
        row.actionId == null ? isNull(ciDispatches.actionId) : eq(ciDispatches.actionId, row.actionId),
        gte(ciDispatches.createdAt, new Date(now.getTime() - CI_DISPATCH_GUARD_MS)),
        ne(ciDispatches.state, 'refused'),
        ne(ciDispatches.id, row.id),
      ),
    );
  const key = inputsKey(row.inputs);
  const earlier = recent
    .filter(
      (d) =>
        d.args === row.args &&
        // A dispatch with no branch goes to the target's default, which the provider names once it answers.
        (row.ref == null || d.ref == null || d.ref === row.ref) &&
        inputsKey(d.inputs) === key &&
        (epoch(d.createdAt) < now.getTime() || (epoch(d.createdAt) === now.getTime() && d.id < row.id)),
    )
    .sort((a, b) => epoch(a.createdAt) - epoch(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (!earlier) return { claimed: true };
  await db.delete(ciDispatches).where(eq(ciDispatches.id, row.id));
  return { claimed: false, existing: (await ciDispatchViews(db, [earlier]))[0]! };
}

/** What the provider answered a dispatch: its link and its id for the run, or the error that refused it. */
export type CiDispatchAnswer = { url: string; ref: string | null; providerRunId: string | null } | { refused: string };

/** Record the provider's answer on a stored dispatch. */
export async function settleCiDispatch(db: DrizzleDB, id: string, answer: CiDispatchAnswer): Promise<void> {
  const set =
    'refused' in answer
      ? { state: 'refused' as const, detail: answer.refused.slice(0, 2000) }
      : { url: answer.url, ref: answer.ref, providerRunId: answer.providerRunId };
  await db
    .update(ciDispatches)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(ciDispatches.id, id));
}

/** Dispatches as the API answers them, each with its run as that run stands. */
export async function ciDispatchViews(
  db: DrizzleDB,
  rows: CiDispatchRow[],
  now = Date.now(),
): Promise<CiDispatchView[]> {
  const runIds = [...new Set(rows.map((r) => r.runId).filter((id): id is number => id != null))];
  const runs = runIds.length
    ? await db
        .select({
          id: testRuns.id,
          status: testRuns.status,
          totalTests: testRuns.totalTests,
          passedTests: testRuns.passedTests,
          failedTests: testRuns.failedTests,
        })
        .from(testRuns)
        .where(inArray(testRuns.id, runIds))
    : [];
  const runById = new Map<number, CiDispatchRun>(runs.map((r) => [r.id, r]));
  return rows.map((r) => {
    const at = epoch(r.createdAt);
    return {
      id: r.id,
      actionId: r.actionId ?? null,
      actionName: r.actionName ?? null,
      kind: r.kind as CiActionKind,
      origin: r.origin as CiDispatchOrigin,
      provider: r.provider as CiRerunProvider,
      ...(r.preset ? { preset: r.preset as CiServerPreset } : {}),
      url: r.url ?? null,
      args: r.args,
      ref: r.ref ?? null,
      tests: r.tests ?? null,
      state: ciDispatchState(r.state as CiDispatchState, at, now),
      detail: r.detail ?? null,
      runId: r.runId ?? null,
      run: r.runId != null ? (runById.get(r.runId) ?? null) : null,
      at,
      byName: r.byName ?? null,
      byUserId: r.byUserId ?? null,
    };
  });
}

/** One dispatch as the API answers it, or null. */
export async function getCiDispatch(db: DrizzleDB, id: string): Promise<CiDispatchView | null> {
  return (await findCiDispatch(db, id))?.dispatch ?? null;
}

/** One dispatch as the API answers it, with its project, or null. */
export async function findCiDispatch(
  db: DrizzleDB,
  id: string,
): Promise<{ projectId: number; dispatch: CiDispatchView } | null> {
  const [row] = await db.select().from(ciDispatches).where(eq(ciDispatches.id, id));
  const dispatch = row ? (await ciDispatchViews(db, [row]))[0] : undefined;
  return row && dispatch ? { projectId: row.projectId, dispatch } : null;
}

/** Which of a project's dispatches a list answers: the open ones, those taken, or all, of one cluster or test, at most `limit`. */
export interface CiDispatchListFilter {
  /** `open`: dispatched and still within the matching window, or running; `taken`: every one but a refused one. */
  state: 'open' | 'taken' | 'all';
  clusterId?: number | null;
  testCaseId?: number | null;
  limit: number;
}

/** A project's dispatches, newest first, as the API answers them. */
export async function listCiDispatches(
  db: DrizzleDB,
  projectId: number,
  filter: CiDispatchListFilter,
  now = Date.now(),
): Promise<CiDispatchView[]> {
  const conditions: SQL[] = [eq(ciDispatches.projectId, projectId)];
  if (filter.clusterId != null) conditions.push(eq(ciDispatches.clusterId, filter.clusterId));
  if (filter.testCaseId != null) conditions.push(eq(ciDispatches.testCaseId, filter.testCaseId));
  if (filter.state === 'open') {
    conditions.push(
      or(
        eq(ciDispatches.state, 'running'),
        and(
          eq(ciDispatches.state, 'dispatched'),
          gte(ciDispatches.createdAt, new Date(now - CI_DISPATCH_MATCH_WINDOW_MS)),
        ),
      )!,
    );
  } else if (filter.state === 'taken') {
    conditions.push(ne(ciDispatches.state, 'refused'));
  }
  const rows = await db
    .select()
    .from(ciDispatches)
    .where(and(...conditions))
    .orderBy(desc(ciDispatches.createdAt), desc(ciDispatches.id))
    .limit(filter.limit);
  return ciDispatchViews(db, rows, now);
}

/** A cluster's last CI re-run that the provider took, or null when it has none (or no cluster is given). */
export async function clusterLastDispatch(db: DrizzleDB, clusterId: number | null): Promise<CiDispatchView | null> {
  if (clusterId == null) return null;
  const [row] = await db
    .select()
    .from(ciDispatches)
    .where(and(eq(ciDispatches.clusterId, clusterId), ne(ciDispatches.state, 'refused')))
    .orderBy(desc(ciDispatches.createdAt))
    .limit(1);
  return row ? ((await ciDispatchViews(db, [row]))[0] ?? null) : null;
}

/** A test's last Flake Lab dispatch that the provider took, or null when it has none. */
export async function testLastFlakeLabDispatch(db: DrizzleDB, testCaseId: number): Promise<CiDispatchView | null> {
  const [row] = await db
    .select()
    .from(ciDispatches)
    .where(
      and(
        eq(ciDispatches.testCaseId, testCaseId),
        eq(ciDispatches.kind, 'flakeLab'),
        ne(ciDispatches.state, 'refused'),
      ),
    )
    .orderBy(desc(ciDispatches.createdAt))
    .limit(1);
  return row ? ((await ciDispatchViews(db, [row]))[0] ?? null) : null;
}

/** The action that started a run, and the inputs it sent, when the run was matched to a dispatch. */
export async function runDispatchAction(
  db: DrizzleDB,
  runId: number | null,
): Promise<{ actionId: string; inputs: Record<string, string> } | null> {
  if (runId == null) return null;
  const [row] = await db
    .select({ actionId: ciDispatches.actionId, inputs: ciDispatches.inputs })
    .from(ciDispatches)
    .where(eq(ciDispatches.runId, runId))
    .orderBy(desc(ciDispatches.createdAt))
    .limit(1);
  if (!row?.actionId) return null;
  const inputs = row.inputs && typeof row.inputs === 'object' ? (row.inputs as Record<string, string>) : {};
  return { actionId: row.actionId, inputs };
}
