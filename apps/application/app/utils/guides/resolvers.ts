/**
 * The entities an authored guide's stop can open a page of: a project, a run,
 * an execution, a failure cluster, a test or a saved dashboard. A guide cannot
 * carry a seeded id, so each stop on an entity's page names one of these
 * resolvers, which finds the entity on this instance, with the user's access,
 * through API routes the demo serves too. A resolver that finds nothing
 * answers `null`, and the stop shows centered with its anchor's `shownWhen`.
 */

/** Reads an API route as the dashboard does (`$fetch` in the app, a stub in the tests). */
export type GuideApiGet = <T>(path: string, query?: Record<string, string | number>) => Promise<T>;

export interface GuideResolver {
  /** What it finds, in one sentence. */
  describes: string;
  /** The page patterns of `app/pages` whose `[id]` the id it finds fills. */
  pages: readonly string[];
  /** The id, or `null` when the instance holds no such entity. */
  find: (get: GuideApiGet) => Promise<number | string | null>;
}

interface RecentRun {
  id: number;
  status: string;
  startTime: string | null;
}

interface FailureGroup {
  cases: { executionId: number }[];
  locatorHealing: unknown;
}

/** How many failed runs a resolver reads the failure groups of before it gives up. */
const FAILED_RUNS_READ = 5;

/** Runs still reporting, which have no final outcome yet. */
const ACTIVE_RUN_STATUSES = new Set(['initializing', 'running', 'finalizing']);

/** The finished runs the user reads, newest first (ties by id). */
async function finishedRuns(get: GuideApiGet): Promise<RecentRun[]> {
  const { items } = await get<{ items: RecentRun[] }>('/api/test-runs/recent');
  const time = (run: RecentRun) => (run.startTime ? Date.parse(run.startTime) : 0);
  return items.filter((run) => !ACTIVE_RUN_STATUSES.has(run.status)).sort((a, b) => time(b) - time(a) || b.id - a.id);
}

/** The first execution of the newest failed runs' failure groups that `pick` accepts. */
async function failedExecution(get: GuideApiGet, pick: (group: FailureGroup) => boolean): Promise<number | null> {
  const failed = (await finishedRuns(get)).filter((run) => run.status === 'failed').slice(0, FAILED_RUNS_READ);
  for (const run of failed) {
    const { items } = await get<{ items: FailureGroup[] }>(`/api/test-runs/${run.id}/failure-groups`);
    const execution = items.find((group) => pick(group) && group.cases.length > 0)?.cases[0]?.executionId;
    if (execution !== undefined) return execution;
  }
  return null;
}

/** The flakiest test across the projects the user reads, as the analytics leaderboard ranks them. */
async function flakiestTest(get: GuideApiGet): Promise<{ testCaseId: number; projectId: number } | null> {
  const rows = await get<{ testCaseId: number; projectId: number }[]>('/api/widgets/flaky-leaderboard');
  return rows[0] ?? null;
}

export const GUIDE_RESOLVERS = {
  project: {
    describes: 'The project updated last of those the user reads.',
    pages: ['/projects/[id]', '/projects/[id]/locators'],
    find: async (get) => (await get<{ items: { id: number }[] }>('/api/projects')).items[0]?.id ?? null,
  },
  'latest-run': {
    describes: 'The newest finished run the user reads.',
    pages: ['/test-runs/[id]'],
    find: async (get) => (await finishedRuns(get))[0]?.id ?? null,
  },
  'failed-execution': {
    describes:
      'A failed execution of the newest failed run: the first test of the cluster with the most failures in it.',
    pages: ['/test-run-cases/[id]'],
    find: (get) => failedExecution(get, () => true),
  },
  'locator-fix': {
    describes: 'A failed execution of a recent failed run whose broken locator has a replacement.',
    pages: ['/test-run-cases/[id]'],
    find: (get) => failedExecution(get, (group) => Boolean(group.locatorHealing)),
  },
  'open-cluster': {
    describes: 'The open failure cluster seen last.',
    pages: ['/failure-clusters/[id]'],
    find: async (get) =>
      (await get<{ items: { id: number }[] }>('/api/failure-clusters', { limit: 1 })).items[0]?.id ?? null,
  },
  'flaky-test': {
    describes: 'The flakiest test across the projects the user reads.',
    pages: ['/test-cases/[id]'],
    find: async (get) => (await flakiestTest(get))?.testCaseId ?? null,
  },
  'flaky-project': {
    describes: 'The project of the flakiest test.',
    pages: ['/projects/[id]'],
    find: async (get) => (await flakiestTest(get))?.projectId ?? null,
  },
  dashboard: {
    describes: 'The first saved dashboard the user can edit.',
    pages: ['/analytics/d/[id]'],
    find: async (get) =>
      (await get<{ items: { id: string | number; kind: string; canEdit: boolean }[] }>('/api/dashboards')).items.find(
        (dashboard) => dashboard.kind === 'saved' && dashboard.canEdit,
      )?.id ?? null,
  },
} satisfies Record<string, GuideResolver>;

export type GuideResolverId = keyof typeof GUIDE_RESOLVERS;

/**
 * Runs each resolver once, in parallel, and answers each one's id; a resolver
 * that finds nothing, or whose route fails, answers `null`.
 */
export async function resolveGuideIds(
  ids: Iterable<GuideResolverId>,
  get: GuideApiGet,
): Promise<Partial<Record<GuideResolverId, number | string | null>>> {
  const unique = [...new Set(ids)];
  const found = await Promise.all(unique.map((id) => GUIDE_RESOLVERS[id].find(get).catch(() => null)));
  return Object.fromEntries(unique.map((id, i) => [id, found[i]]));
}
