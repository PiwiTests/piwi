import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { DEMO_PROJECTS, INCIDENT_HOST, incidentNavigationError, incidentUrl } from '#shared/demo/failure-stories.mjs';
import { streamSimulation, type StreamedRun } from './demo-simulator-harness';

/**
 * The simulator's menu and what its scenarios stream: every scenario is listed under one of the menu's groups, and the
 * scenarios that stand for a feature send what that feature reads (a failure budget, an unreachable staging host, the
 * shards' progress, each live step's target).
 */

let simulator: typeof import('~~/app/demo/simulator');

// The simulator's module graph is large: loaded before the tests, its import
// never counts against the first test's timeout when the whole suite runs.
beforeAll(async () => {
  simulator = await import('~~/app/demo/simulator');
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Complete {
  title: string;
  location: string;
  status: string;
  error: string | null;
  didNotRunReason?: string;
  steps?: unknown[];
  networkRequests?: Array<{ url: string; status: number; resourceType: string; failure?: string }>;
}

/** Each test's last `complete` event: the result that decides it. */
function finalResults(run: StreamedRun): Complete[] {
  const last = new Map<string, Complete>();
  for (const e of run.events) if (e.type === 'complete') last.set(e.title as string, e as unknown as Complete);
  return [...last.values()];
}

describe("the simulator's menu", () => {
  test('lists every scenario under one of its groups, and every group holds one at least', () => {
    const { DEMO_SCENARIOS, DEMO_SCENARIO_GROUPS } = simulator;
    const groups = DEMO_SCENARIO_GROUPS.map((g) => g.id) as string[];
    for (const scenario of DEMO_SCENARIOS) expect(groups, scenario.id).toContain(scenario.group);
    for (const group of groups)
      expect(
        DEMO_SCENARIOS.some((s) => s.group === group),
        group,
      ).toBe(true);
  });

  test('tells scenarios apart by id, label and icon', () => {
    const { DEMO_SCENARIOS } = simulator;
    for (const key of ['id', 'label', 'icon'] as const) {
      const values = DEMO_SCENARIOS.map((s) => s[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
  });

  test("links a run's Resources tab only from a scenario that sends resources", async () => {
    for (const scenario of simulator.DEMO_SCENARIOS) {
      const to = scenario.result?.link ? await scenario.result.link.to(1) : '';
      if (to.includes('tab=resources')) expect(scenario.resources, scenario.id).toBeDefined();
    }
  });
});

describe('every scenario', () => {
  test("names each test's browser, so it compares with the seeded history kept per browser", () => {
    for (const scenario of simulator.DEMO_SCENARIOS) {
      for (const test of scenario.tests()) {
        expect(test.browser?.projectName, `${scenario.id}: ${test.title}`).toEqual(expect.any(String));
      }
    }
  });
});

describe('every simulated run', () => {
  test("lists the Playwright projects its tests ran, and only those, as the run's config", async () => {
    for (const scenario of simulator.DEMO_SCENARIOS) {
      const run = await streamSimulation(simulator, scenario.id);
      const ran = new Set(
        run.events
          .filter((e) => e.type === 'complete')
          .map((e) => (e.browser as { projectName?: string } | null)?.projectName),
      );
      const metadata = run.finish!.metadata as { htmlReport: { projects: Array<{ name: string }> } };
      expect(metadata.htmlReport.projects.map((p) => p.name).sort(), scenario.id).toEqual([...ran].sort());
    }
  });

  test("lists each project with its tests' browser and viewport, as the reporter records the config's", async () => {
    for (const scenario of simulator.DEMO_SCENARIOS) {
      const run = await streamSimulation(simulator, scenario.id);
      const metadata = run.finish!.metadata as {
        htmlReport: { projects: Array<{ name: string; use: { browserName?: string; viewport?: unknown } }> };
      };
      for (const project of metadata.htmlReport.projects) {
        const browser = run.events.find(
          (e) => e.type === 'complete' && (e.browser as { projectName?: string } | null)?.projectName === project.name,
        )!.browser as { browserName: string; viewport: unknown };
        expect(project.use, `${scenario.id}: ${project.name}`).toMatchObject({
          browserName: browser.browserName,
          viewport: browser.viewport,
        });
      }
    }
  });
});

describe('every attempt', () => {
  test('carries a fixme annotation only when skipped, as Playwright adds it only to a test it skips', () => {
    for (const scenario of simulator.DEMO_SCENARIOS) {
      for (const test of scenario.tests()) {
        for (const attempt of test.attempts) {
          if (attempt.status === 'skipped') continue;
          const types = (attempt.testAnnotations ?? []).map((a) => a.type);
          expect(types, `${scenario.id}: ${test.title}`).not.toContain('fixme');
        }
      }
    }
  });
});

describe("the 'staging-down' scenario", () => {
  test("fails every test on its first navigation to the staging host, as the seeded incident run's tests fail", async () => {
    const run = await streamSimulation(simulator, 'staging-down');
    const results = finalResults(run);
    const checkout = DEMO_PROJECTS.find((p) => p.id === 1)!;

    expect(results).toHaveLength(checkout.cases.length);
    for (const r of results) {
      const test = checkout.cases.find((c) => c.title === r.title)!;
      expect(r.status, r.title).toBe('failed');
      expect(r.error, r.title).toBe(incidentNavigationError(test));
      expect(r.steps, r.title).toEqual([]);
      expect(r.networkRequests, r.title).toEqual([
        expect.objectContaining({
          url: incidentUrl(test.file),
          status: 0,
          resourceType: 'document',
          failure: 'net::ERR_CONNECTION_REFUSED',
        }),
      ]);
    }
  });

  test("names the staging host as the run's baseURL, which the incident rule reads", async () => {
    const run = await streamSimulation(simulator, 'staging-down');
    const metadata = run.finish!.metadata as { htmlReport: { projects: Array<{ use?: { baseURL?: string } }> } };
    expect(metadata.htmlReport.projects.map((p) => p.use?.baseURL)).toEqual([`https://${INCIDENT_HOST}`]);
  });
});

describe("the 'env-drift' scenario", () => {
  test("fails in the seeded runs' Chromium profile but for its dark color scheme", async () => {
    const run = await streamSimulation(simulator, 'env-drift');
    const failed = run.events.find((e) => e.type === 'complete' && e.status === 'failed')!;
    const chromium = DEMO_PROJECTS.find((p) => p.id === 1)!.browsers.find((b) => b.projectName === 'Chromium')!;

    expect(failed.browser).toEqual({ ...chromium, colorScheme: 'dark' });
  });

  test('reports a newer Playwright than every other scenario', async () => {
    const version = (v: unknown) => String(v).split('.').map(Number) as [number, number, number];
    const newer = (a: unknown, b: unknown) => {
      const [x, y] = [version(a), version(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    };
    const drift = await streamSimulation(simulator, 'env-drift');
    const passing = await streamSimulation(simulator, 'passing');

    expect(newer(drift.finish!.playwrightVersion, passing.finish!.playwrightVersion)).toBeGreaterThan(0);
    for (const scenario of simulator.DEMO_SCENARIOS.filter((s) => s.id !== 'env-drift' && s.playwrightVersion)) {
      expect(newer(drift.finish!.playwrightVersion, scenario.playwrightVersion), scenario.id).toBeGreaterThan(0);
    }
  });
});

describe('a sharded simulation', () => {
  test("reports the run's progress over every shard's tests", async () => {
    const progress: Array<[number, number]> = [];
    await streamSimulation(simulator, 'sharded', {
      hooks: { onProgress: (completed, _failed, total) => progress.push([completed, total]) },
    });
    const total = simulator.DEMO_SCENARIOS.find((s) => s.id === 'sharded')!.tests().length;

    expect(progress.every(([, t]) => t === total)).toBe(true);
    expect(progress.map(([c]) => c)).toEqual([...progress.map(([c]) => c)].sort((a, b) => a - b));
    expect(progress.at(-1)).toEqual([total, total]);
  });

  test("lists the run's projects from every shard, though each shard runs one browser", async () => {
    const begun = new Map<number, string[]>();
    const run = await streamSimulation(simulator, 'sharded-cross-browser', {
      onRequest: (url, body) => {
        if (!url.endsWith('/begin')) return;
        const metadata = body!.metadata as { htmlReport: { projects: Array<{ name: string }> } };
        begun.set(body!.shardIndex as number, metadata.htmlReport.projects.map((p) => p.name).sort());
      },
    });
    const ranByShard = new Map<number, Set<string>>();
    for (const e of run.events.filter((e) => e.type === 'complete')) {
      const shard = e.shardIndex as number;
      if (!ranByShard.has(shard)) ranByShard.set(shard, new Set());
      ranByShard.get(shard)!.add((e.browser as { projectName: string }).projectName);
    }

    const shards = [...ranByShard.entries()].sort(([a], [b]) => a - b);
    expect(shards.map(([, names]) => [...names])).toEqual([['Chromium'], ['Firefox']]);
    expect([...begun.keys()].sort()).toEqual([1, 2]);
    for (const names of begun.values()) expect(names).toEqual(['Chromium', 'Firefox']);
  });
});

describe('live steps', () => {
  test('carry the target of the step, as the reporter streams it', async () => {
    const run = await streamSimulation(simulator, 'passing');
    const steps = run.events.filter((e) => e.type === 'step-begin' || e.type === 'step-end');

    expect(steps.length).toBeGreaterThan(0);
    expect(steps.filter((e) => typeof e.subtitle === 'string' && e.subtitle).length).toBe(steps.length);
  });
});
