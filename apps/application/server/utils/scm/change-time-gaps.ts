/**
 * The change-time detectors of a pull request: *new error path*, *intent without
 * a test* and *new control*, run on the patches and the title of its change when
 * a run of it finishes. Their gaps carry the pull request's number; each run of it
 * reads the whole change again, so a gap it no longer raises closes.
 */

import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { graphEdges, graphNodes, scenarioGaps, testCases } from '../../database/schema';
import type { DbClient } from '../../database';
import type { ChangedFile } from './ScmProvider';
import {
  detectIntentWithoutTest,
  detectNewControl,
  detectNewErrorPath,
  observedRouteStatuses,
  rankGap,
  upsertScenarioGaps,
  type ExposureInputs,
  type IntentInput,
  type NewControlInput,
  type NewErrorPathInput,
} from '#shared/handlers/scenario-gaps';
import { filePageTarget, fileRouteTarget, pageKeyMatchesTarget, routeKeyMatchesTarget } from '#shared/graph';
import { addedControls, addedErrorStatuses, intentMatchedByTests, intentWords } from '#shared/change-time';

/** The detectors this module runs, the ones its closing pass owns. */
export const CHANGE_TIME_DETECTORS = ['new-error-path', 'intent-without-test', 'new-control'];

export interface ChangeTimeInput {
  projectId: number;
  runId: number;
  prNumber: number;
  /** The pull request's title, the intent of the change; null when the host did not say. */
  title: string | null;
  /** The ticket the change names, when it names exactly one. */
  ticket: string | null;
  /** The changed files, with their patches unless the diff left them out. */
  files: ChangedFile[];
  exposure: ExposureInputs;
}

/**
 * Raise the change-time gaps of a pull request's change and close the ones of
 * its earlier runs this change no longer raises. Returns the keys raised.
 */
export async function computeChangeTimeGaps(db: DbClient, input: ChangeTimeInput): Promise<string[]> {
  const files = input.files.filter((f) => f.status !== 'removed' && f.status !== 'deleted');
  const nodes = await db
    .select({ kind: graphNodes.kind, key: graphNodes.key })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.projectId, input.projectId),
        isNull(graphNodes.branch),
        isNull(graphNodes.prunedAt),
        inArray(graphNodes.kind, ['route', 'page']),
      ),
    );
  const routeKeys = nodes.filter((n) => n.kind === 'route').map((n) => n.key);
  const pageKeys = nodes.filter((n) => n.kind === 'page').map((n) => n.key);

  const errorPaths = await newErrorPathInputs(db, input, files, routeKeys);
  const controls = await newControlInputs(db, input.projectId, files, pageKeys);
  const intents = input.title ? await intentInputs(db, input, files) : [];

  const gaps = [
    ...detectNewErrorPath(errorPaths),
    ...detectIntentWithoutTest(intents),
    ...detectNewControl(controls),
  ].map((gap) => rankGap(gap, input.exposure));
  if (gaps.length > 0)
    await upsertScenarioGaps(db, input.projectId, gaps, { runId: input.runId, prNumber: input.prNumber });

  const raised = gaps.map((g) => g.key);
  const now = new Date();
  await db
    .update(scenarioGaps)
    .set({ status: 'closed', closedAt: now, closedByRunId: input.runId, updatedAt: now })
    .where(
      and(
        eq(scenarioGaps.projectId, input.projectId),
        eq(scenarioGaps.prNumber, input.prNumber),
        inArray(scenarioGaps.detector, CHANGE_TIME_DETECTORS),
        inArray(scenarioGaps.status, ['open', 'snoozed']),
        ...(raised.length > 0 ? [notInArray(scenarioGaps.key, raised)] : []),
      ),
    );
  return raised;
}

/** The statuses the patch of a route's handler adds that no run of the route answered with. */
async function newErrorPathInputs(
  db: DbClient,
  input: ChangeTimeInput,
  files: ChangedFile[],
  routeKeys: string[],
): Promise<NewErrorPathInput[]> {
  const added: Array<{ routeKey: string; filePath: string; statuses: number[] }> = [];
  for (const file of files) {
    const target = file.patch ? fileRouteTarget(file.filename) : null;
    if (!target) continue;
    const statuses = addedErrorStatuses(file.patch!);
    if (statuses.length === 0) continue;
    for (const routeKey of routeKeys.filter((k) => routeKeyMatchesTarget(target, k))) {
      added.push({ routeKey, filePath: file.filename, statuses });
    }
  }
  if (added.length === 0) return [];
  const observed = await observedRouteStatuses(
    db,
    input.projectId,
    added.map((a) => a.routeKey),
    [input.runId],
  );
  return added.flatMap((a) =>
    a.statuses
      .filter((status) => !observed.get(a.routeKey)?.has(status))
      .map((addedStatus) => ({ routeKey: a.routeKey, addedStatus, filePath: a.filePath })),
  );
}

/** The controls the patch of a page's template adds, with whether a test reaches the page. */
async function newControlInputs(
  db: DbClient,
  projectId: number,
  files: ChangedFile[],
  pageKeys: string[],
): Promise<NewControlInput[]> {
  const candidates: Array<{ pageKey: string; filePath: string; controls: string[] }> = [];
  for (const file of files) {
    const target = file.patch ? filePageTarget(file.filename) : null;
    if (!target) continue;
    const controls = addedControls(file.patch!);
    const pageKey = pageKeys.find((k) => pageKeyMatchesTarget(target, k));
    if (controls.length > 0 && pageKey) candidates.push({ pageKey, filePath: file.filename, controls });
  }
  if (candidates.length === 0) return [];
  const reached = new Set(
    (
      await db
        .selectDistinct({ key: graphEdges.toKey })
        .from(graphEdges)
        .where(
          and(
            eq(graphEdges.projectId, projectId),
            eq(graphEdges.kind, 'reaches'),
            eq(graphEdges.toKind, 'page'),
            isNull(graphEdges.branch),
            inArray(
              graphEdges.toKey,
              candidates.map((c) => c.pageKey),
            ),
          ),
        )
    ).map((r) => r.key),
  );
  return candidates.flatMap((c) =>
    c.controls.map((control) => ({
      pageKey: c.pageKey,
      control,
      filePath: c.filePath,
      pageReached: reached.has(c.pageKey),
    })),
  );
}

/** The pull request's title as an intent, matched against every test's title, tags and feature. */
async function intentInputs(db: DbClient, input: ChangeTimeInput, files: ChangedFile[]): Promise<IntentInput[]> {
  const words = intentWords(input.title!);
  if (words.length === 0) return [];
  const tests = await db
    .select({
      title: testCases.title,
      tags: testCases.tags,
      feature: testCases.feature,
      suitePath: testCases.suitePath,
    })
    .from(testCases)
    .where(eq(testCases.projectId, input.projectId));
  const texts = tests.map((t) =>
    [
      t.suitePath.replace(/\x1f/g, ' '),
      t.title,
      ...(Array.isArray(t.tags) ? (t.tags as string[]) : []),
      t.feature ?? '',
    ].join(' '),
  );
  return [
    {
      title: input.title!,
      ticket: input.ticket,
      matchedByTest: intentMatchedByTests(words, texts),
      files: files.map((f) => f.filename).slice(0, 20),
    },
  ];
}
