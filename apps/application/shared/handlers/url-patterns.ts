import { and, asc, desc, eq, inArray, like } from 'drizzle-orm';
import { z } from 'zod';
import { urlMatches } from '@piwitests/core/function-match';
import { parsePathPrefix, type PathPrefixProblem } from '@piwitests/core/page-key';
import {
  graphNodes,
  locatorUsages,
  networkRequests,
  projects,
  projectUrlPatterns,
  testRuns,
  testRunsCases,
} from '../../server/database/schema';
import { projectRouteOrigins, runBaseUrls, urlOrigin } from '#shared/graph';
import type { DrizzleDB } from './db';
import { notPrivateRun } from '../run-eligibility';

/**
 * A project's URL patterns: the addresses its application is served at, which
 * the browser extension resolves the project of a page from. A pattern is a
 * glob over the whole URL with the extension's syntax (`urlMatches`: `*`
 * within one path segment, `**` across segments), so it starts with the scheme
 * or a wildcard. Two optional path prefixes relate the site's paths to the
 * tests': `pathPrefix`, the part of the site's path the tests never saw
 * (`/app`), which the extension removes before comparing the page with the
 * pages the tests recorded, and `testPathPrefix`, the part the tests ran under
 * and the site does not, which it puts in front.
 */

const PATH_PREFIX_MESSAGES: Record<PathPrefixProblem, string> = {
  'query-or-hash': 'A path prefix has no query or hash',
  'not-a-path': 'A path prefix is a plain path such as /app, with no wildcards, spaces or dot segments',
  'too-many-segments': 'A path prefix has at most 4 segments',
  'too-long': 'A path prefix has at most 200 characters',
};

/** A path prefix, normalized (`app/` → `/app`); empty means none. */
export const pathPrefixSchema = z
  .string()
  .nullish()
  .transform((value, ctx) => {
    const result = parsePathPrefix(value);
    if (result.ok) return result.prefix;
    ctx.addIssue({ code: 'custom', message: PATH_PREFIX_MESSAGES[result.problem] });
    return z.NEVER;
  });

export const MAX_URL_PATTERNS_PER_PROJECT = 100;
const MAX_ENVIRONMENT_LENGTH = 40;

export const urlPatternInputSchema = z.object({
  pattern: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((p) => /^(https?:\/\/|\*)/i.test(p), 'Start the pattern with http://, https:// or a wildcard'),
  environment: z.string().trim().max(MAX_ENVIRONMENT_LENGTH).nullish(),
  branch: z.string().trim().max(200).nullish(),
  pathPrefix: pathPrefixSchema,
  testPathPrefix: pathPrefixSchema,
});

export const urlPatternListSchema = z.object({
  items: z.array(urlPatternInputSchema).max(MAX_URL_PATTERNS_PER_PROJECT),
});

export type UrlPatternInput = z.input<typeof urlPatternInputSchema>;

export interface UrlPatternItem {
  id: number;
  pattern: string;
  environment: string | null;
  branch: string | null;
  pathPrefix: string | null;
  testPathPrefix: string | null;
  position: number;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function cleanPrefix(value: string | null | undefined): string | null {
  const result = parsePathPrefix(value);
  return result.ok ? result.prefix : null;
}

export async function listProjectUrlPatterns(db: DrizzleDB, projectId: number): Promise<UrlPatternItem[]> {
  return db
    .select({
      id: projectUrlPatterns.id,
      pattern: projectUrlPatterns.pattern,
      environment: projectUrlPatterns.environment,
      branch: projectUrlPatterns.branch,
      pathPrefix: projectUrlPatterns.pathPrefix,
      testPathPrefix: projectUrlPatterns.testPathPrefix,
      position: projectUrlPatterns.position,
    })
    .from(projectUrlPatterns)
    .where(eq(projectUrlPatterns.projectId, projectId))
    .orderBy(asc(projectUrlPatterns.position), asc(projectUrlPatterns.id));
}

export type UrlPatternWriteResult =
  | { ok: true; items: UrlPatternItem[] }
  | { ok: false; reason: 'not-found' | 'duplicate' | 'too-many'; pattern?: string };

async function projectExists(db: DrizzleDB, projectId: number): Promise<boolean> {
  const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  return !!row;
}

/** Replaces the project's list with `items`, in that order. */
export async function replaceProjectUrlPatterns(
  db: DrizzleDB,
  projectId: number,
  items: UrlPatternInput[],
): Promise<UrlPatternWriteResult> {
  if (!(await projectExists(db, projectId))) return { ok: false, reason: 'not-found' };
  const seen = new Set<string>();
  for (const item of items) {
    const pattern = item.pattern.trim();
    if (seen.has(pattern)) return { ok: false, reason: 'duplicate', pattern };
    seen.add(pattern);
  }
  const now = new Date();
  await db.delete(projectUrlPatterns).where(eq(projectUrlPatterns.projectId, projectId));
  if (items.length > 0) {
    await db.insert(projectUrlPatterns).values(
      items.map((item, position) => ({
        projectId,
        pattern: item.pattern.trim(),
        environment: clean(item.environment),
        branch: clean(item.branch),
        pathPrefix: cleanPrefix(item.pathPrefix),
        testPathPrefix: cleanPrefix(item.testPathPrefix),
        position,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  return { ok: true, items: await listProjectUrlPatterns(db, projectId) };
}

/** Appends one pattern; refuses one the project already has. */
export async function addProjectUrlPattern(
  db: DrizzleDB,
  projectId: number,
  input: UrlPatternInput,
): Promise<UrlPatternWriteResult> {
  if (!(await projectExists(db, projectId))) return { ok: false, reason: 'not-found' };
  const existing = await listProjectUrlPatterns(db, projectId);
  const pattern = input.pattern.trim();
  if (existing.some((p) => p.pattern === pattern)) return { ok: false, reason: 'duplicate', pattern };
  if (existing.length >= MAX_URL_PATTERNS_PER_PROJECT) return { ok: false, reason: 'too-many' };
  const now = new Date();
  await db.insert(projectUrlPatterns).values({
    projectId,
    pattern,
    environment: clean(input.environment),
    branch: clean(input.branch),
    pathPrefix: cleanPrefix(input.pathPrefix),
    testPathPrefix: cleanPrefix(input.testPathPrefix),
    position: existing.reduce((max, p) => Math.max(max, p.position + 1), 0),
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true, items: await listProjectUrlPatterns(db, projectId) };
}

export interface VisibleUrlPattern {
  projectId: number;
  projectName: string;
  projectLabel: string;
  pattern: string;
  environment: string | null;
  branch: string | null;
  pathPrefix: string | null;
  testPathPrefix: string | null;
}

/**
 * Every pattern of the projects in `scope`, ordered by project then by each
 * project's own order: the order the extension tries them in.
 */
export async function listVisibleUrlPatterns(db: DrizzleDB, scope: 'all' | Set<number>): Promise<VisibleUrlPattern[]> {
  if (scope !== 'all' && scope.size === 0) return [];
  const rows = await db
    .select({
      projectId: projectUrlPatterns.projectId,
      projectName: projects.name,
      projectLabel: projects.label,
      pattern: projectUrlPatterns.pattern,
      environment: projectUrlPatterns.environment,
      branch: projectUrlPatterns.branch,
      pathPrefix: projectUrlPatterns.pathPrefix,
      testPathPrefix: projectUrlPatterns.testPathPrefix,
    })
    .from(projectUrlPatterns)
    .innerJoin(projects, eq(projects.id, projectUrlPatterns.projectId))
    .where(scope === 'all' ? undefined : inArray(projectUrlPatterns.projectId, [...scope]))
    .orderBy(asc(projectUrlPatterns.projectId), asc(projectUrlPatterns.position), asc(projectUrlPatterns.id));
  return rows.map((r) => ({ ...r, projectLabel: r.projectLabel || r.projectName }));
}

export type UrlPatternSuggestionSource = 'base-url' | 'navigation' | 'network' | 'test-map' | 'locator-pages';

export interface UrlPatternSuggestion {
  pattern: string;
  origin: string;
  /** The environment most of the runs that visited this origin were reported with; null when none was. */
  environment: string | null;
  sources: UrlPatternSuggestionSource[];
  /** How many recorded URLs pointed at this origin: the order suggestions are shown in. */
  hits: number;
}

export interface UrlPatternSuggestions {
  items: UrlPatternSuggestion[];
  /** Origins the suite visited that a saved pattern already covers, left out of `items`. */
  covered: number;
}

const SUGGESTION_RUNS = 20;
const SUGGESTION_RUNS_PER_ENVIRONMENT = 5;
const SUGGESTION_RUN_WINDOW = 1000;
const SUGGESTION_ENVIRONMENTS = 20;
const SUGGESTION_ROWS = 2000;
const NAVIGATION_RUNS = 6;
const NAVIGATION_RUNS_PER_ENVIRONMENT = 2;
const NAVIGATION_CASES_PER_RUN = 20;
const PAGE_LOAD_RUNS = 12;
const PAGE_LOAD_RUNS_PER_ENVIRONMENT = 4;

function runEnvironment(environment: string | null): string | null {
  const trimmed = environment?.trim();
  return trimmed && trimmed.length <= MAX_ENVIRONMENT_LENGTH ? trimmed : null;
}

/**
 * The runs whose `baseURL` feeds the suggestions: the newest ones, plus the
 * newest few of every environment among the project's latest runs, so an
 * environment that runs rarely (a nightly production suite) is still suggested
 * beside one that runs on every push.
 */
async function suggestionRunIds(db: DrizzleDB, projectId: number): Promise<number[]> {
  const recent = await db
    .select({ id: testRuns.id, environment: testRuns.environment })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), notPrivateRun(testRuns.origin)))
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(SUGGESTION_RUN_WINDOW);
  const perEnvironment = new Map<string, number>();
  const ids: number[] = [];
  for (const [index, run] of recent.entries()) {
    const environment = runEnvironment(run.environment) ?? '';
    const count = perEnvironment.get(environment);
    const room =
      count === undefined ? perEnvironment.size < SUGGESTION_ENVIRONMENTS : count < SUGGESTION_RUNS_PER_ENVIRONMENT;
    if (index >= SUGGESTION_RUNS && !room) continue;
    ids.push(run.id);
    perEnvironment.set(environment, (count ?? 0) + 1);
  }
  return ids;
}

/**
 * The absolute address a navigation step opened (`page.goto`), or null: its
 * `params.url`, its subtitle, or a URL spelled in its title, whichever the
 * Playwright version that ran it recorded. A path under the `baseURL` is null.
 */
export function stepNavigationUrl(step: unknown): string | null {
  if (!step || typeof step !== 'object') return null;
  const s = step as { category?: unknown; title?: unknown; subtitle?: unknown; params?: { url?: unknown } | null };
  if (s.category !== 'navigation') return null;
  const inTitle = typeof s.title === 'string' ? /https?:\/\/[^\s"'`)]+/i.exec(s.title)?.[0] : undefined;
  for (const candidate of [s.params?.url, s.subtitle, inTitle]) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate.trim())) return candidate.trim();
  }
  return null;
}

function stepList(steps: unknown): unknown[] {
  if (typeof steps !== 'string') return Array.isArray(steps) ? steps : [];
  try {
    const parsed: unknown = JSON.parse(steps);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The newest `perEnvironment` runs of each environment, `max` in all: the runs
 * that recorded no `baseURL` whose `page.goto` steps and page loads feed the
 * suggestions.
 */
function newestRunsPerEnvironment<T extends { environment: string | null }>(
  runs: T[],
  max: number,
  perEnvironmentMax: number,
): T[] {
  const perEnvironment = new Map<string, number>();
  const picked: T[] = [];
  for (const run of runs) {
    if (picked.length >= max) break;
    const environment = runEnvironment(run.environment) ?? '';
    const count = perEnvironment.get(environment) ?? 0;
    if (count >= perEnvironmentMax) continue;
    picked.push(run);
    perEnvironment.set(environment, count + 1);
  }
  return picked;
}

/**
 * One `https://host/**` pattern per origin the project's suite visited: the
 * Playwright `baseURL` of its runs and its own route origins, then, for a run
 * that recorded no `baseURL`, the full addresses its tests opened with
 * `page.goto` and the pages it loaded (its `document` network requests), the
 * URL of each page node of the Test Map, and each absolute page its locators
 * ran on. An origin a run visited carries the environment the run was
 * reported with. Origins an existing pattern already covers are left out and
 * counted in `covered`.
 */
export async function suggestUrlPatterns(db: DrizzleDB, projectId: number): Promise<UrlPatternSuggestions> {
  const byOrigin = new Map<
    string,
    { sources: Set<UrlPatternSuggestionSource>; hits: number; environments: Map<string, number> }
  >();
  const add = (url: unknown, source: UrlPatternSuggestionSource, environment: string | null = null) => {
    const origin = typeof url === 'string' ? urlOrigin(url) : null;
    if (!origin || !/^https?:\/\//.test(origin)) return;
    let entry = byOrigin.get(origin);
    if (!entry) byOrigin.set(origin, (entry = { sources: new Set(), hits: 0, environments: new Map() }));
    entry.sources.add(source);
    entry.hits++;
    if (environment) entry.environments.set(environment, (entry.environments.get(environment) ?? 0) + 1);
  };

  const [project] = await db
    .select({ routeOrigins: projects.routeOrigins })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return { items: [], covered: 0 };
  for (const origin of projectRouteOrigins(project.routeOrigins)) add(origin, 'base-url');

  const runIds = await suggestionRunIds(db, projectId);
  const runs =
    runIds.length === 0
      ? []
      : await db
          .select({ id: testRuns.id, environment: testRuns.environment, metadata: testRuns.metadata })
          .from(testRuns)
          .where(inArray(testRuns.id, runIds))
          .orderBy(desc(testRuns.startTime), desc(testRuns.id));
  const withoutBaseUrl: typeof runs = [];
  for (const run of runs) {
    // One vote per run and origin, whatever the number of Playwright projects pointing at it.
    const origins = new Set(
      runBaseUrls(run.metadata)
        .map(urlOrigin)
        .filter((origin) => origin !== null && /^https?:\/\//.test(origin)),
    );
    if (origins.size === 0) withoutBaseUrl.push(run);
    for (const origin of origins) add(origin, 'base-url', runEnvironment(run.environment));
  }

  const navigated = await Promise.all(
    newestRunsPerEnvironment(withoutBaseUrl, NAVIGATION_RUNS, NAVIGATION_RUNS_PER_ENVIRONMENT).map(async (run) => {
      const cases = await db
        .select({ steps: testRunsCases.steps })
        .from(testRunsCases)
        .where(eq(testRunsCases.testRunId, run.id))
        .orderBy(asc(testRunsCases.id))
        .limit(NAVIGATION_CASES_PER_RUN);
      const origins = new Set<string | null>();
      for (const c of cases) for (const step of stepList(c.steps)) origins.add(urlOrigin(stepNavigationUrl(step)));
      return { environment: runEnvironment(run.environment), origins };
    }),
  );
  for (const run of navigated) for (const origin of run.origins) add(origin, 'navigation', run.environment);

  // A page load keeps the full address when the test opened a path: the case of
  // a run merged from blob reports, which Playwright writes without the baseURL.
  // More runs than for `page.goto`: without the capture fixtures, only a failed
  // test's trace records them.
  const loadRuns = newestRunsPerEnvironment(withoutBaseUrl, PAGE_LOAD_RUNS, PAGE_LOAD_RUNS_PER_ENVIRONMENT);
  if (loadRuns.length > 0) {
    const environments = new Map(loadRuns.map((run) => [run.id, runEnvironment(run.environment)]));
    const loads = await db
      .selectDistinct({ testRunId: networkRequests.testRunId, url: networkRequests.url })
      .from(networkRequests)
      .where(
        and(inArray(networkRequests.testRunId, [...environments.keys()]), eq(networkRequests.resourceType, 'document')),
      )
      .orderBy(desc(networkRequests.testRunId))
      .limit(SUGGESTION_ROWS);
    const origins = new Map<number, Set<string>>();
    for (const load of loads) {
      const origin = urlOrigin(load.url);
      if (!origin) continue;
      let seen = origins.get(load.testRunId);
      if (!seen) origins.set(load.testRunId, (seen = new Set()));
      seen.add(origin);
    }
    for (const [runId, seen] of origins) for (const origin of seen) add(origin, 'network', environments.get(runId));
  }

  const pageNodes = await db
    .select({ attrs: graphNodes.attrs })
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, 'page')))
    .limit(SUGGESTION_ROWS);
  for (const node of pageNodes) add((node.attrs as { url?: unknown } | null)?.url, 'test-map');

  const pages = await db
    .selectDistinct({ page: locatorUsages.page })
    .from(locatorUsages)
    .where(and(eq(locatorUsages.projectId, projectId), like(locatorUsages.page, 'http%')))
    .limit(SUGGESTION_ROWS);
  for (const row of pages) add(row.page, 'locator-pages');

  const existing = await listProjectUrlPatterns(db, projectId);
  const uncovered = [...byOrigin.entries()].filter(
    ([origin]) => !existing.some((p) => urlMatches(p.pattern, `${origin}/`)),
  );
  const items = uncovered
    .map(([origin, entry]) => ({
      pattern: `${origin}/**`,
      origin,
      environment: mostFrequent(entry.environments),
      sources: [...entry.sources].sort(),
      hits: entry.hits,
    }))
    .sort((a, b) => b.hits - a.hits || a.origin.localeCompare(b.origin));
  return { items, covered: byOrigin.size - uncovered.length };
}

/** The key with the highest count; on a tie, the one counted first (the newest run's). */
function mostFrequent(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) [best, bestCount] = [key, count];
  }
  return best;
}
