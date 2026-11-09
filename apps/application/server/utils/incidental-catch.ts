/**
 * *Incidental catch*, read from a recorded fix: the change that fixed a failure
 * cluster names its cause, and when none of the tests that caught it is about
 * that cause, they caught it by accident. A refactor of those tests would lose
 * the catch, so the gap asks for a test of the cause itself.
 *
 * The cause is the diagnosed patch's files the fixing change touched, else the
 * files the fixing change touched, when there are few enough to name a cause.
 * A fixing change that touched a test file raises nothing: the fix came with
 * its test, or the failure was the test's own.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { graphEdges, graphNodes, testCases } from '../database/schema';
import type { DbClient } from '../database';
import { detectIncidentalCatch, rankGap, upsertScenarioGaps } from '#shared/handlers/scenario-gaps';
import { filePageTarget, fileRouteTarget, pageKeyMatchesTarget, routeKeyMatchesTarget } from '#shared/graph';

/** A fixing change touching more files than this names no single cause. */
const MAX_CAUSE_FILES = 3;

/** File names too common to say what a file is about. */
const GENERIC_WORDS = new Set([
  'index',
  'main',
  'util',
  'utils',
  'helper',
  'helpers',
  'common',
  'shared',
  'types',
  'service',
  'services',
  'component',
  'components',
  'source',
  'app',
  'lib',
]);

/** True when two repo paths name one file: equal, or one a path suffix of the other (a monorepo prefix). */
function samePath(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** True when a path belongs to a test suite: a spec or test file, or a file under a tests folder. */
export function isTestFilePath(path: string): boolean {
  return (
    /\.(spec|test|e2e)\.[cm]?[jt]sx?$/i.test(path) ||
    /(^|\/)(tests?|e2e|__tests__|specs?)\//i.test(path) ||
    /(^|\/)[^/]+\.Tests?\//.test(path)
  );
}

/** The lower-case words of a text, camelCase and PascalCase split. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The words a file's name is about: its base name's, else its folder's when the name is generic. */
export function causeWords(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const base = (parts.at(-1) ?? '').replace(/\.[^.]+$/, '').replace(/\.(post|get|put|patch|delete)$/i, '');
  const own = words(base).filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
  if (own.length > 0) return own;
  return words(parts.at(-2) ?? '').filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
}

/** True when a test's identity text names one of the words: the same word, or one sharing its first five letters. */
export function identityNames(identity: string, causeTerms: readonly string[]): boolean {
  const tokens = words(identity);
  return causeTerms.some((w) =>
    tokens.some((t) => t === w || (w.length >= 5 && t.length >= 5 && t.slice(0, 5) === w.slice(0, 5))),
  );
}

export interface FixCatchInput {
  projectId: number;
  runId: number;
  clusterId: number;
  /** The tests the cluster covers: the ones that caught it. */
  caseIds: number[];
  /** The diagnosed patch's files, when the fix verified the diagnosis. */
  diagnosedFiles: string[];
  /** The files the fixing change touched; null when the range could not be read. */
  changedFiles: string[] | null;
}

/**
 * Raise *incidental catch* for a recorded fix whose cause none of the catching
 * tests is about, by name (title, suite, tags, feature, file) or by reach (the
 * route or page the cause file serves). Returns whether it raised the gap.
 */
export async function recordIncidentalCatch(db: DbClient, input: FixCatchInput): Promise<boolean> {
  const changed = input.changedFiles ?? [];
  if (changed.length === 0 || input.caseIds.length === 0) return false;
  if (changed.some(isTestFilePath)) return false;
  const diagnosed = changed.filter((file) => input.diagnosedFiles.some((d) => samePath(file, d)));
  const causes = diagnosed.length > 0 ? diagnosed : changed;
  if (causes.length > MAX_CAUSE_FILES) return false;

  const tests = await db
    .select({
      id: testCases.id,
      title: testCases.title,
      suitePath: testCases.suitePath,
      tags: testCases.tags,
      feature: testCases.feature,
      filePath: testCases.filePath,
    })
    .from(testCases)
    .where(and(eq(testCases.projectId, input.projectId), inArray(testCases.id, input.caseIds)));
  if (tests.length === 0) return false;
  const identities = tests.map((t) =>
    [
      t.title,
      t.suitePath.replace(/\x1f/g, ' '),
      ...(Array.isArray(t.tags) ? (t.tags as string[]) : []),
      t.feature ?? '',
      t.filePath,
    ].join(' '),
  );
  const named = causes.some((file) => {
    const terms = causeWords(file);
    return terms.length > 0 && identities.some((identity) => identityNames(identity, terms));
  });
  if (named || (await testsReachCauses(db, input.projectId, input.caseIds, causes))) return false;

  const gaps = detectIncidentalCatch([
    {
      clusterId: input.clusterId,
      causeFile: causes[0]!,
      catcherTitle: tests[0]!.title,
      causeInAffectedIdentity: false,
    },
  ]).map((gap) => rankGap(gap, {}));
  await upsertScenarioGaps(db, input.projectId, gaps, { runId: input.runId });
  return true;
}

/** True when one of the tests reaches a route or page a cause file serves. */
async function testsReachCauses(
  db: DbClient,
  projectId: number,
  caseIds: number[],
  causes: string[],
): Promise<boolean> {
  const routeTargets = causes.map(fileRouteTarget).filter((t) => t != null);
  const pageTargets = causes.map(filePageTarget).filter((t) => t != null);
  if (routeTargets.length === 0 && pageTargets.length === 0) return false;
  const nodes = await db
    .select({ kind: graphNodes.kind, key: graphNodes.key })
    .from(graphNodes)
    .where(
      and(eq(graphNodes.projectId, projectId), isNull(graphNodes.branch), inArray(graphNodes.kind, ['route', 'page'])),
    );
  const served = nodes.filter((n) =>
    n.kind === 'route'
      ? routeTargets.some((t) => routeKeyMatchesTarget(t, n.key))
      : pageTargets.some((t) => pageKeyMatchesTarget(t, n.key)),
  );
  if (served.length === 0) return false;
  const reached = await db
    .select({ toKind: graphEdges.toKind, toKey: graphEdges.toKey })
    .from(graphEdges)
    .where(
      and(
        eq(graphEdges.projectId, projectId),
        eq(graphEdges.kind, 'reaches'),
        eq(graphEdges.fromKind, 'test'),
        isNull(graphEdges.branch),
        inArray(
          graphEdges.fromKey,
          caseIds.map((id) => String(id)),
        ),
      ),
    );
  return reached.some((e) => served.some((n) => n.kind === e.toKind && n.key === e.toKey));
}
