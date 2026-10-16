import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeErrorFingerprint } from '#shared/error-fingerprint';
import { resolveHealingForCase } from '~~/server/utils/locator-healing';
import { validatePatch } from '#shared/patch';
import { allDemoSourceFiles, getDemoChangesSince, getDemoDefaultRange } from '~~/app/demo/demo-scm';
import {
  FAILURE_STORIES,
  SCM_REPOS,
  SIMULATOR_ERRORS,
  storyCoverageFiles,
  storyForCase,
} from '#shared/demo/failure-stories.mjs';
import { parseAriaCandidates } from '#shared/locator-fingerprint';
import { parsePlaywrightError } from '#shared/error-parse';
import { extractStepLocatorUse, renderLocatorChain, tryParseLocatorChain } from '#shared/locator-chain';
import { computeDemoFingerprint } from '#shared/demo/demo-fingerprint.mjs';
import { firstRetryPassAfter, markingExperiments } from '#shared/handlers/flake-verified';
import { flakeLabTestState } from '#shared/flake-lab';
import { DEMO_EXAMPLES, type DemoExampleExpect } from '#shared/demo/demo-examples.mjs';
import { WEB_DASHBOARD_PROJECT_ID, webDashboardRequests } from '#shared/demo/demo-test-map.mjs';
import { resourceFingerprint } from '#shared/resource-fingerprint.mjs';
import type { WireResourceFinding } from '#shared/types';
import { GATEWAY_STATUSES, classifyRunHealth } from '#shared/handlers/run-health';
import { runBaseUrls } from '#shared/graph';
import { TOUR_PROFILES } from '~/utils/demo-tour/profiles';

// Root of the Nuxt app (tests/unit/ -> ../..).
const rootDir = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

interface Row {
  [key: string]: unknown;
}

let db: import('sql.js').Database;
// The regenerated seed script, as app:seed:dev and the demo SPA load it.
let seedSql: string;
// The seed's newest generation-time timestamp (seconds), which the load-time
// rebase maps to "now". Read back from the rebase statement itself.
let anchorSec: number;

function q(sql: string): Row[] {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0]!;
  return values.map((row) => Object.fromEntries(row.map((v, i) => [columns[i]!, v])));
}

// Regenerate into a throwaway directory unique to this test file, never the
// tracked public/demo/seed.sql — another test file's beforeAll regenerates
// concurrently (vitest runs files in parallel) and would otherwise race on
// the same path, producing a torn read and a SQL parse error.
function regenerate(outDir: string): string {
  execFileSync('node', ['scripts/generate-demo-seed.mjs'], {
    cwd: rootDir,
    stdio: 'ignore',
    env: { ...process.env, PIWI_DEMO_SEED_OUTPUT_DIR: outDir },
  });
  return readFileSync(join(outDir, 'seed.sql'), 'utf-8');
}

const tmpDirs: string[] = [];
function tempOutDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'piwi-demo-seed-consistency-'));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  seedSql = regenerate(tempOutDir());
  anchorSec = Number(/AS INTEGER\) - (\d+)\) AS delta_sec/.exec(seedSql)![1]);

  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  db = new SQL.Database();
  db.run(seedSql);
});

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe('demo seed generation is deterministic', () => {
  test('regenerating without source changes produces the same content hash', () => {
    const before = regenerate(tempOutDir());
    const after = regenerate(tempOutDir());
    // Compare content only, excluding the timestamp comment line (see the
    // generator's own hash-stability comment).
    const strip = (s: string) =>
      s
        .split('\n')
        .filter((l) => !l.startsWith('-- Generated at:'))
        .join('\n');
    expect(strip(after)).toBe(strip(before));
  });
});

describe('fingerprint mirror parity (demo mirror vs the real algorithm)', () => {
  const corpus = [
    ...FAILURE_STORIES.flatMap((s) => s.failingCases.map((fc) => fc.error)),
    // Adversarial cases beyond the seeded stories.
    '\x1b[31mError: expect(locator).toBeVisible() failed\x1b[39m',
    "TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('row', { name: 'Acme' }).getByRole('button', { name: 'Delete' })\n    at tests/x.spec.ts:1:1",
    'Error: expect(received).toBe(expected)\n\nExpected: 200\nReceived: 500\n    at tests/x.spec.ts:2:2',
    'Error: page.click: Target page, context or browser has been closed',
    "Error: strict mode violation: getByRole('button') resolved to 2 elements",
    "Error: strict mode violation: getByRole('row', { name: 'Alice' }) resolved to 2 elements:\n    1) <tr>…</tr> aka getByRole('row', { name: 'Alice', exact: true })",
    "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('row', { name: 'Bob' })\nExpected: visible\nReceived: <element(s) not found>\nTimeout: 5000ms\n\nCall log:\n  - waiting for getByRole('row', { name: 'Bob' })\n    at tests/x.spec.ts:3:3",
    'Some completely unstructured error with no recognizable shape at all',
  ];

  for (const [i, err] of corpus.entries()) {
    test(`corpus[${i}] matches real computeErrorFingerprint`, async () => {
      const [mine, real] = await Promise.all([computeDemoFingerprint(err), computeErrorFingerprint(err)]);
      expect(mine.fingerprint, 'fingerprint').toBe(real.fingerprint);
      expect(mine.errorType, 'errorType').toBe(real.errorType);
      expect(mine.signature, 'signature').toBe(real.signature);
    });
  }
});

describe('cluster ↔ case ↔ file coherence', () => {
  test('every failing execution error matches its story, and its case is really in that file', () => {
    const rows = q(`
      select trc.error, trc.line, trc.column, trc.failure_cluster_id, tc.file_path, tc.title
      from test_runs_cases trc
      join test_cases tc on tc.id = trc.test_case_id
      where trc.failure_cluster_id is not null
    `);
    expect(rows.length).toBeGreaterThan(0);

    const storyByCluster = new Map(FAILURE_STORIES.map((s) => [s.clusterId, s]));
    for (const r of rows) {
      const story = storyByCluster.get(r.failure_cluster_id as number)!;
      expect(story, `cluster ${r.failure_cluster_id} has a story`).toBeTruthy();
      expect(r.file_path, `case file for cluster ${r.failure_cluster_id}`).toBe(story.specFile);

      const failingCase = story.failingCases.find((fc) => fc.title === r.title);
      expect(failingCase, `story ${story.key} declares case "${r.title}"`).toBeTruthy();
      expect(r.error, `error text for "${r.title}"`).toBe(failingCase!.error);
      expect(r.line, `declared line for "${r.title}"`).not.toBeNull();

      // The error's final stack frame must reference the same file the case lives in.
      const frames = [...(r.error as string).matchAll(/at (\S+):(\d+):(\d+)/g)];
      const last = frames[frames.length - 1];
      expect(last?.[1], `last frame file for "${r.title}"`).toBe(story.specFile);
    }
  });

  interface FailingRow {
    id: number;
    started_at: number;
    duration: number;
    timeout: number;
    error: string;
    steps: string;
    console_logs: string | null;
    failure_cluster_id: number;
  }
  const failingStoryRows = () =>
    q(`select id, started_at, duration, timeout, error, steps, console_logs, failure_cluster_id
      from test_runs_cases where failure_cluster_id is not null`) as unknown as FailingRow[];
  const lastStepOf = (r: FailingRow) =>
    (JSON.parse(r.steps) as Array<Record<string, unknown> & { startTime: number; duration: number }>).at(-1)!;
  const canonical = (locator: string) => {
    const chain = tryParseLocatorChain(locator);
    return chain ? renderLocatorChain(chain) : locator;
  };
  // The step action Playwright reports for each call the stories fail on.
  const STEP_ACTION: Record<string, string> = { click: 'click', fill: 'fill', waitForSelector: 'waitFor' };

  test('every failing story execution ends on the step its error names', () => {
    const rows = failingStoryRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const parsed = parsePlaywrightError(r.error);
      const last = lastStepOf(r);
      expect(last.failed, `trc ${r.id}: last step failed`).toBe(true);
      if (parsed.locator) {
        const use = extractStepLocatorUse(last);
        expect(use?.locator, `trc ${r.id}: locator`).toBe(canonical(parsed.locator));
        const action = parsed.assertion ? `expect.${parsed.assertion}` : STEP_ACTION[parsed.action ?? ''];
        expect(use?.action, `trc ${r.id}: action`).toBe(action);
      } else if (parsed.action === 'goto') {
        expect(last.title, `trc ${r.id}: navigation`).toBe('Navigate');
        expect((last.params as { url?: string }).url, `trc ${r.id}: url`).toBe(parsed.url);
      } else {
        expect(last.title, `trc ${r.id}: assertion`).toBe(`Expect "${parsed.assertion}"`);
      }
    }
  });

  test('a test-timeout error runs its execution to that timeout and stores it', () => {
    const rows = failingStoryRows().filter((r) => parsePlaywrightError(r.error).kind === 'test-timeout');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const { timeoutMs } = parsePlaywrightError(r.error);
      expect(r.timeout, `trc ${r.id}: stored timeout`).toBe(timeoutMs);
      expect(r.duration, `trc ${r.id}: duration`).toBeGreaterThanOrEqual(timeoutMs!);
      const last = lastStepOf(r);
      expect(last.startTime + last.duration - r.started_at, `trc ${r.id}: failing step ends at the timeout`).toBe(
        timeoutMs,
      );
    }
  });

  test('an action or expect timeout is the duration of the failing step', () => {
    const rows = failingStoryRows().filter((r) =>
      ['action-timeout', 'assertion-timeout', 'navigation'].includes(parsePlaywrightError(r.error).kind),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const { timeoutMs } = parsePlaywrightError(r.error);
      expect(lastStepOf(r).duration, `trc ${r.id}: failing step duration`).toBe(timeoutMs);
      expect(r.timeout, `trc ${r.id}: room for the call's own timeout`).toBeGreaterThan(timeoutMs!);
    }
  });

  test("every story's own request and console entry happen inside its execution", () => {
    const rows = failingStoryRows();
    for (const r of rows) {
      const story = FAILURE_STORIES.find((s) => s.clusterId === r.failure_cluster_id)!;
      const end = r.started_at + r.duration;
      for (const declared of story.evidence.failingNetwork ?? []) {
        const [req] = q(`select start_time from network_requests
          where test_runs_case_id = ${r.id} and method = '${declared.method}' and url = '${declared.url}'`);
        expect(req, `trc ${r.id}: ${declared.method} ${declared.url}`).toBeTruthy();
        expect(req!.start_time as number, `trc ${r.id}: request start`).toBeGreaterThanOrEqual(r.started_at);
        expect(req!.start_time as number, `trc ${r.id}: request start`).toBeLessThanOrEqual(end);
      }
      for (const entry of JSON.parse(r.console_logs ?? '[]') as Array<{ timestamp: number }>) {
        expect(entry.timestamp, `trc ${r.id}: console entry`).toBeGreaterThanOrEqual(r.started_at);
        expect(entry.timestamp, `trc ${r.id}: console entry`).toBeLessThanOrEqual(end);
      }
    }
  });

  test('an execution running its authored steps never sleeps, and its before hooks hold its beforeEach steps', () => {
    const rows = q(`select trc.id, trc.steps, trc.step_events, trc.wasted_time_ms, trc.failure_cluster_id, tc.title
      from test_runs_cases trc join test_cases tc on tc.id = trc.test_case_id
      where trc.failure_cluster_id is not null`);
    let checked = 0;
    for (const r of rows) {
      const story = FAILURE_STORIES.find((s) => s.clusterId === r.failure_cluster_id)!;
      const before = story.failingCases.find((fc) => fc.title === r.title)?.before;
      if (!before) continue;
      checked++;
      expect(r.wasted_time_ms ?? 0, `trc ${r.id}: wasted time`).toBe(0);
      const events = JSON.parse(r.step_events as string) as Array<{
        title: string;
        startedAt: number;
        duration: number;
        status: string;
      }>;
      expect(
        events.filter((e) => e.status === 'wasted'),
        `trc ${r.id}: sleeps`,
      ).toEqual([]);
      const hooks = events.find((e) => e.title === 'Before Hooks')!;
      const hooksEnd = hooks.startedAt + hooks.duration;
      const steps = JSON.parse(r.steps as string) as Array<{ startTime: number; duration: number }>;
      const inHook = before.filter((step) => step.hook === 'beforeEach').length;
      // The fixtures come first; the beforeEach steps end with the before hooks and the body follows.
      expect(steps[0]!.startTime, `trc ${r.id}: first step after the fixtures`).toBeGreaterThan(hooks.startedAt);
      if (inHook > 0) {
        const last = steps[inHook - 1]!;
        expect(last.startTime + last.duration, `trc ${r.id}: beforeEach steps end with the hooks`).toBe(hooksEnd);
      }
      expect(steps[inHook]!.startTime, `trc ${r.id}: the body starts after the hooks`).toBeGreaterThanOrEqual(hooksEnd);
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('cluster fingerprint matches the real recomputation of its sample_error', async () => {
    const rows = q('select id, fingerprint, sample_error from failure_clusters');
    expect(rows.length).toBe(FAILURE_STORIES.length);
    for (const r of rows) {
      const real = await computeErrorFingerprint(r.sample_error as string);
      expect(real.fingerprint, `cluster ${r.id}`).toBe(r.fingerprint);
    }
  });

  test('cluster occurrences and first/last run ids are internally consistent', () => {
    const clusters = q('select id, occurrences, first_seen_run_id, last_seen_run_id from failure_clusters');
    for (const c of clusters) {
      const trcCount = q(`select count(*) as n from test_runs_cases where failure_cluster_id = ${c.id as number}`)[0]!
        .n as number;
      expect(trcCount, `cluster ${c.id} occurrences`).toBe(c.occurrences);
      expect(c.first_seen_run_id, `cluster ${c.id} first_seen_run_id`).not.toBeNull();
      expect(c.last_seen_run_id, `cluster ${c.id} last_seen_run_id`).not.toBeNull();
    }
  });

  // A fix is only ever recorded from a run that came back green, so a landing
  // run the cluster failed in is a contradiction the UI would faithfully show.
  test('a recorded fix landed in a run where the cluster did not fail', () => {
    const fixed = q(`
      select id, fix_landed_run_id, fix_verification, time_to_resolution_ms
      from failure_clusters where fix_verification is not null`);
    expect(fixed.length, 'demo should carry recorded fixes').toBeGreaterThan(0);

    for (const c of fixed) {
      expect(c.fix_landed_run_id, `cluster ${c.id} fix_landed_run_id`).not.toBeNull();
      expect(c.time_to_resolution_ms, `cluster ${c.id} time_to_resolution_ms`).toBeGreaterThan(0);

      const failedInLandingRun = q(`
        select count(*) as n from test_runs_cases
        where failure_cluster_id = ${c.id as number} and test_run_id = ${c.fix_landed_run_id as number}`)[0]!
        .n as number;
      expect(failedInLandingRun, `cluster ${c.id} failed in the run its fix supposedly landed in`).toBe(0);
    }
  });

  // Run ids descend as time advances in the seed, so "later" means a lower id.
  test('only a regressed cluster fails after its fix landed', () => {
    const fixed = q(`
      select id, fix_landed_run_id, fix_verification from failure_clusters where fix_verification is not null`);
    const verdicts = new Set(fixed.map((c) => c.fix_verification));
    // All three verdicts read very differently; the demo is only useful if it
    // shows what each one looks like.
    expect(verdicts).toEqual(new Set(['regressed', 'stopped-failing', 'diagnosis-verified']));

    for (const c of fixed) {
      const failuresAfter = q(`
        select count(*) as n from test_runs_cases
        where failure_cluster_id = ${c.id as number} and test_run_id < ${c.fix_landed_run_id as number}`)[0]!
        .n as number;
      if (c.fix_verification === 'regressed') {
        expect(failuresAfter, `regressed cluster ${c.id} should fail again after the fix`).toBeGreaterThan(0);
      } else {
        expect(failuresAfter, `cluster ${c.id} kept failing after a fix that supposedly held`).toBe(0);
      }
    }
  });
});

describe('captured-source format fidelity', () => {
  test('test_source has the failing-line marker with the correct gutter, and frames are well-formed', () => {
    const rows = q(`
      select id, test_source, test_source_frames, line
      from test_runs_cases
      where status = 'failed' and test_source is not null
    `);
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      const src = r.test_source as string;
      const lines = src.split('\n');
      // At least one line carries the '> ' failing-line marker with a
      // right-aligned 4-wide line-number gutter, e.g. "> NNNN | code".
      expect(
        lines.some((l) => /^> {1,4}\d+ \| /.test(l)),
        `trc ${r.id} has a > marker`,
      ).toBe(true);

      if (r.test_source_frames) {
        const frames = JSON.parse(r.test_source_frames as string) as Array<{
          file: string;
          line: number;
          snippet: string;
        }>;
        expect(frames.length, `trc ${r.id} frame count`).toBeLessThanOrEqual(4);
        expect(frames.length, `trc ${r.id} has frames`).toBeGreaterThan(0);
        for (const f of frames) {
          expect(
            f.snippet.split('\n').some((l) => /^> {1,4}\d+ \| /.test(l)),
            `trc ${r.id} frame ${f.file}`,
          ).toBe(true);
        }
      }
    }
  });

  test('every failing execution error ends in an "at file:line:col" frame (column always present)', () => {
    const rows = q(`select id, error from test_runs_cases where status = 'failed'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const frames = [...(r.error as string).matchAll(/at (\S+):(\d+):(\d+)/g)];
      expect(frames.length, `trc ${r.id} has at least one frame`).toBeGreaterThan(0);
    }
  });
});

describe('suggested-fix patches and SCM references', () => {
  test('every story patch applies cleanly against the demo-scm source files', () => {
    const files = allDemoSourceFiles();
    for (const story of FAILURE_STORIES) {
      const result = validatePatch(story.diagnosis.fix.patch, files);
      expect(['applies', 'applies-with-offset'], `${story.key}: ${result.errors.join('; ')}`).toContain(result.status);
    }
  });

  test('the checkout story patch applies at its stated lines, hunk after hunk', () => {
    const story = FAILURE_STORIES.find((s) => s.key === 'checkout-pay-timeout')!;
    const patch = story.diagnosis.fix.patch;
    expect(patch.match(/^@@ /gm)?.length, 'hunks').toBeGreaterThan(1);
    const result = validatePatch(patch, allDemoSourceFiles());
    expect(result.status, result.errors.join('; ')).toBe('applies');
  });

  test('no story patch, seeded diagnosis or demo AI template recommends networkidle', () => {
    for (const story of FAILURE_STORIES) {
      expect(story.diagnosis.fix.patch, story.key).not.toContain('networkidle');
      expect(story.diagnosis.fix.description, story.key).not.toContain('networkidle');
    }
    const stored = [
      ...q('select cluster_id, summary, root_cause, details from failure_diagnoses'),
      ...q('select cluster_id, summary, root_cause, details from failure_diagnosis_versions'),
    ];
    expect(stored.length).toBeGreaterThan(0);
    for (const d of stored) {
      expect(`${d.summary} ${d.root_cause} ${d.details}`, `diagnosis of cluster ${d.cluster_id}`).not.toMatch(
        /networkidle|network-idle/i,
      );
    }
    const template = readFileSync(join(rootDir, 'app/demo/api/ai.ts'), 'utf-8');
    expect(template).not.toMatch(/networkidle|network-idle/i);
  });

  test('a seeded diagnosis of a count assertion quotes the counts its error shows', () => {
    const diagnoses = q('select cluster_id, summary from failure_diagnoses');
    let checked = 0;
    for (const d of diagnoses) {
      const story = FAILURE_STORIES.find((s) => s.clusterId === d.cluster_id)!;
      for (const fc of story.failingCases) {
        const counts = /toHaveCount[\s\S]*?Expected: (\d+)\nReceived: (\d+)/.exec(fc.error);
        if (!counts) continue;
        checked++;
        expect(d.summary, `cluster ${d.cluster_id} expected count`).toContain(counts[1]);
        expect(d.summary, `cluster ${d.cluster_id} received count`).toContain(counts[2]);
      }
    }
    expect(checked, 'a count-assertion story carries a stored diagnosis').toBeGreaterThan(0);
  });

  test('every story suspect commit exists in its project SCM history', () => {
    for (const story of FAILURE_STORIES) {
      const repo = SCM_REPOS[story.projectId as keyof typeof SCM_REPOS];
      expect(
        repo.commits.some((c) => c.sha === story.suspectSha),
        `${story.key} suspect commit`,
      ).toBe(true);
    }
  });

  test('every run metadata.scm.commit exists in that project SCM history', () => {
    const rows = q('select id, project_id, metadata from test_runs');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const meta = JSON.parse(r.metadata as string) as { scm?: { commit?: string } };
      const repo = SCM_REPOS[r.project_id as keyof typeof SCM_REPOS];
      expect(
        repo.commits.some((c) => c.sha === meta.scm?.commit),
        `run ${r.id} scm commit`,
      ).toBe(true);
    }
  });

  test('every seeded diagnosis autoSelectedCommits SHA exists in that cluster project SCM history', () => {
    const clusters = q('select id, project_id from failure_clusters');
    const diagnoses = q('select cluster_id, details from failure_diagnoses');
    for (const d of diagnoses) {
      const cluster = clusters.find((r) => r.id === d.cluster_id)!;
      const details = JSON.parse(d.details as string) as { autoSelectedCommits: string[] };
      const repo = SCM_REPOS[cluster.project_id as keyof typeof SCM_REPOS];
      for (const sha of details.autoSelectedCommits) {
        expect(
          repo.commits.some((c) => c.sha === sha),
          `diagnosis for cluster ${d.cluster_id} sha ${sha}`,
        ).toBe(true);
      }
    }
  });
});

describe('evidence rules', () => {
  test('no console log entry echoes the first line of the case error', () => {
    const rows = q(`
      select id, error, console_logs from test_runs_cases
      where status = 'failed' and console_logs is not null
    `);
    for (const r of rows) {
      const logs = JSON.parse(r.console_logs as string) as Array<{ text: string }>;
      const firstLine = (r.error as string).split('\n')[0];
      expect(
        logs.some((l) => l.text === firstLine),
        `trc ${r.id} console log echoes the error`,
      ).toBe(false);
    }
  });

  test('the API project (2) has no web_vitals/page_state on any execution', () => {
    const rows = q(`
      select trc.id, trc.web_vitals, trc.page_state
      from test_runs_cases trc join test_cases tc on tc.id = trc.test_case_id
      where tc.project_id = 2 and trc.status != 'didnotrun'
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.web_vitals, `trc ${r.id} web_vitals`).toBeNull();
      expect(r.page_state, `trc ${r.id} page_state`).toBeNull();
    }
  });

  test('every executed test_runs_cases row has a browser_name', () => {
    const rows = q(`select count(*) as n from test_runs_cases where browser_name is null`);
    expect(rows[0]!.n).toBe(0);
  });

  test('server logs only appear on requests a story declares as failing, or the Test Map model logs on purpose', () => {
    const rows = q(`
      select nr.id, nr.test_runs_case_id, nr.method, nr.url, nr.server_logs, trc.failure_cluster_id,
        tc.title, tc.project_id
      from network_requests nr join test_runs_cases trc on trc.id = nr.test_runs_case_id
        join test_cases tc on tc.id = trc.test_case_id
      where nr.server_logs is not null
    `);
    const storyByCluster = new Map(FAILURE_STORIES.map((s) => [s.clusterId, s]));
    for (const r of rows) {
      const story = r.failure_cluster_id ? storyByCluster.get(r.failure_cluster_id as number) : null;
      const declared = story?.evidence.failingNetwork ?? [];
      // A web-dashboard journey's request carrying a backend log feeds *passed with errors*.
      const modeled =
        r.project_id === WEB_DASHBOARD_PROJECT_ID &&
        webDashboardRequests(r.title as string).some((m) => m.serverLogs && m.method === r.method && m.url === r.url);
      expect(
        modeled || declared.some((d) => d.method === r.method && d.url === r.url),
        `network request ${r.method} ${r.url} (trc ${r.test_runs_case_id}) has server_logs but isn't a declared failing request`,
      ).toBe(true);
    }
  });
});

describe('executions as the reporter stores them', () => {
  test('every retry pass has its failed attempt stored as its own execution, with an error', () => {
    const passes = q(`select id, test_run_id, test_case_id, browser_name from test_runs_cases
      where status = 'passed' and retries > 0`);
    expect(passes.length).toBeGreaterThan(0);
    for (const p of passes) {
      const failed = q(`select id, error from test_runs_cases
        where test_run_id = ${p.test_run_id as number} and test_case_id = ${p.test_case_id as number}
          and browser_name is ${p.browser_name == null ? 'null' : `'${p.browser_name as string}'`}
          and retries = 0 and status in ('failed', 'timedOut') and error is not null`);
      expect(failed.length, `retry pass ${p.id} has its failed attempt`).toBe(1);
    }
  });

  test('a test that did not run carries no steps, start time, worker or step events', () => {
    const rows = q(`select id, steps, started_at, worker_index, step_events, slowest_step
      from test_runs_cases where status = 'didnotrun'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(JSON.parse((r.steps as string | null) ?? '[]'), `trc ${r.id} steps`).toEqual([]);
      expect(r.started_at, `trc ${r.id} started_at`).toBeNull();
      expect(r.worker_index, `trc ${r.id} worker_index`).toBeNull();
      expect(r.step_events, `trc ${r.id} step_events`).toBeNull();
      expect(r.slowest_step, `trc ${r.id} slowest_step`).toBeNull();
    }
  });
});

describe('media wiring', () => {
  test('every demo/** files row references a file that exists on disk', () => {
    const rows = q(`select id, path from files where path like 'demo/%'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const abs = `${rootDir}/public/${r.path as string}`;
      expect(existsSync(abs), `files #${r.id}: ${r.path}`).toBe(true);
      expect(statSync(abs).size, `files #${r.id}: ${r.path} is non-empty`).toBeGreaterThan(0);
    }
  });

  test('trace/video/screenshot attachments are wired to the most recent failing execution of their case', () => {
    const attachments = q(`
      select f.id, f.type, f.test_runs_case_id, trc.test_case_id, trc.failure_cluster_id
      from files f join test_runs_cases trc on trc.id = f.test_runs_case_id
      where f.path like 'demo/traces/%' or f.path like 'demo/videos/%'
    `);
    expect(attachments.length).toBeGreaterThan(0);
    for (const a of attachments) {
      const maxId = q(
        `select max(id) as m from test_runs_cases where test_case_id = ${a.test_case_id as number} and failure_cluster_id = ${a.failure_cluster_id as number}`,
      )[0]!.m as number;
      expect(a.test_runs_case_id, `files #${a.id} (${a.type})`).toBe(maxId);
    }
  });

  test('the visual diff overlay references a baseline that is a real passing execution', () => {
    const rows = q(`select id, metadata from files where type = 'visual-diff'`);
    expect(rows.length).toBe(1);
    const meta = JSON.parse(rows[0]!.metadata as string) as {
      baselineTestRunsCaseId: number;
      baselineRunId: number;
    };
    const baseline = q(
      `select id, test_run_id, status from test_runs_cases where id = ${meta.baselineTestRunsCaseId}`,
    )[0];
    expect(baseline, 'baseline execution exists').toBeTruthy();
    expect(baseline!.status).toBe('passed');
    expect(baseline!.test_run_id).toBe(meta.baselineRunId);
  });
});

describe('cluster 6 (strict-mode) coherence', () => {
  test('the locator snapshot, its recommended alternative, and the ARIA snapshot all agree on the element name', () => {
    const story = FAILURE_STORIES.find((s) => s.clusterId === 6)!;
    const snapshotRows = q(`
      select element_attrs, alternatives from locator_snapshots
      where location = '${story.captureLocation}'
    `);
    expect(snapshotRows.length).toBe(1);
    const attrs = JSON.parse(snapshotRows[0]!.element_attrs as string) as { accessibleName: string };
    const alternatives = JSON.parse(snapshotRows[0]!.alternatives as string) as Array<{ locator: string }>;

    expect(story.aria).toContain(attrs.accessibleName);
    expect(alternatives.some((a) => a.locator.includes(attrs.accessibleName))).toBe(true);
    expect(story.diagnosis.fix.patch).toContain(attrs.accessibleName);
  });
});

describe('authored DOM snapshots (served as trace-extracted)', () => {
  const authored = FAILURE_STORIES.filter((s) => s.domSnapshot);

  test('the locator-centric stories carry an authored failure-time page', () => {
    expect(authored.map((s) => s.clusterId).sort((a, b) => a - b)).toEqual([1, 2, 6, 9]);
    for (const story of authored) {
      expect(story.domSnapshot.viewport.width).toBeGreaterThan(0);
      expect(story.domSnapshot.viewport.height).toBeGreaterThan(0);
      expect(story.domSnapshot.html).toContain('<!DOCTYPE html>');
    }
  });

  test('every named ARIA candidate appears in the authored page', () => {
    for (const story of authored) {
      const candidates = parseAriaCandidates(story.aria);
      expect(candidates.length).toBeGreaterThan(0);
      for (const c of candidates) {
        // Row names are concatenated cell texts — the cells appear, the
        // concatenation does not.
        if (!c.name || c.role === 'row') continue;
        expect(story.domSnapshot.html, `cluster ${story.clusterId}: ${c.role} "${c.name}"`).toContain(c.name);
      }
    }
  });

  test('cluster 9 keeps the hidden Export CSV button in the DOM but out of the ARIA tree', () => {
    const story = FAILURE_STORIES.find((s) => s.clusterId === 9)!;
    expect(story.domSnapshot.html).toContain('class="export-btn" hidden');
    expect(story.domSnapshot.html).toContain('Export CSV');
    expect(story.aria).not.toContain('Export CSV');
  });

  test('storyForCase resolves each authored story from its failing case identity', () => {
    for (const story of authored) {
      for (const fc of story.failingCases) {
        expect(storyForCase(story.projectId, story.specFile, fc.title)).toBe(story);
      }
    }
    expect(storyForCase(999, 'tests/nowhere.spec.ts', 'no such test')).toBeNull();
  });
});

describe('cluster 9 (assertion-captured healing) coherence', () => {
  test('the expect()-captured snapshot sits at the failing call site; the resolved-but-hidden failure is not healed', async () => {
    const story = FAILURE_STORIES.find((s) => s.clusterId === 9)!;
    const rows = q(`
      select * from locator_snapshots
      where location = '${story.captureLocation}'
    `);
    expect(rows.length).toBe(1);
    const raw = rows[0]!;

    // The seeded row is keyed at the expect() call site — the same line the
    // failing case's innermost stack frame points at.
    const failing = story.failingCases[0]!;
    expect(story.captureLocation).toBe(`${story.specFile}:${failing.failingLine}:${failing.column}`);

    const row = {
      id: raw.id,
      testCaseId: raw.test_case_id,
      location: raw.location,
      usedMethod: raw.used_method,
      usedArgs: raw.used_args,
      usedArgsFp: raw.used_args_fp,
      elementTag: raw.element_tag,
      elementAttrs: raw.element_attrs,
      elementText: raw.element_text,
      alternatives: raw.alternatives,
      lastSeenRunId: raw.last_seen_run_id,
      lastSeenAt: null,
    } as unknown as import('~~/server/database/schema').LocatorSnapshotRow;

    // The stored row describes the element the failing assertion targets.
    expect(row.usedMethod).toBe('getByRole');
    const alternatives = JSON.parse(row.alternatives) as Array<{ locator: string }>;
    expect(alternatives.some((a) => a.locator === "locator('.export-btn')")).toBe(true);

    // The call log says the locator resolved (to a hidden button) — the CSS is
    // the bug, not the selector — so the healing gate declines to suggest a
    // replacement even though a snapshot sits at the exact call site.
    const healing = await resolveHealingForCase({ error: failing.error, ariaSnapshot: story.aria }, [row], null);
    expect(healing.applicable).toBe(false);
    expect(healing.reason).toBe('The locator resolved; this is not a locator problem.');
    expect(healing.recommendation).toBeNull();
    expect(healing.failingLocator?.method).toBe('getByRole');
  });
});

describe('evidence timing survives the load-time rebase', () => {
  interface StepRow {
    id: number;
    started_at: number;
    duration: number;
    steps: string;
  }

  // Executed cases only: a didnotrun case has no steps and no span.
  function executedCasesWithSteps(): StepRow[] {
    return q(`
      select id, started_at, duration, steps from test_runs_cases
      where status != 'didnotrun' and duration > 0
        and steps is not null and json_valid(steps) and json_array_length(steps) > 0
    `) as unknown as StepRow[];
  }

  // The rebase shifts started_at and the JSON step timestamps together. If it
  // ever shifts one without the other, every step's absolute startTime lands
  // ~months away from its execution window and the Perfetto export (which
  // clamps each step into that window) collapses them all to the left edge.
  test('every executed step starts within its execution window', () => {
    const rows = executedCasesWithSteps();
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      const start = Number(r.started_at);
      const end = start + Number(r.duration);
      const steps = (JSON.parse(r.steps) as Array<{ startTime?: number }>).filter(
        (s) => typeof s.startTime === 'number',
      );
      for (const s of steps) {
        const t = s.startTime!;
        // A generous rounding slack still catches a months-scale desync.
        expect(t, `trc ${r.id}: step startTime before window`).toBeGreaterThanOrEqual(start - 1000);
        expect(t, `trc ${r.id}: step startTime past window`).toBeLessThanOrEqual(end + 1000);
      }
    }
  });

  test('steps spread across the window instead of collapsing to the start', () => {
    const rows = executedCasesWithSteps();
    // The largest step offset, as a fraction of its case duration, across all
    // multi-step executed cases. In the collapsed-to-left failure mode every
    // offset is 0; a healthy seed lays steps end-to-end across the span.
    let maxFraction = 0;
    for (const r of rows) {
      const start = Number(r.started_at);
      const duration = Number(r.duration);
      const steps = (JSON.parse(r.steps) as Array<{ startTime?: number }>).filter(
        (s) => typeof s.startTime === 'number',
      );
      if (steps.length < 2) continue;
      for (const s of steps) maxFraction = Math.max(maxFraction, (s.startTime! - start) / duration);
    }
    expect(maxFraction).toBeGreaterThan(0.5);
  });

  // The failure timeline takes its origin from the earliest timestamp of any
  // lane, so a dialog left on generation time drags the origin ~months back and
  // squashes every other item against the right edge.
  test('every seeded dialog closes within its execution window', () => {
    const rows = q(`
      select id, started_at, duration, dialogs from test_runs_cases
      where dialogs is not null and json_valid(dialogs) and json_array_length(dialogs) > 0
    `);
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      const start = Number(r.started_at);
      const end = start + Number(r.duration);
      for (const d of JSON.parse(String(r.dialogs)) as Array<{ closedAt?: number }>) {
        expect(typeof d.closedAt, `trc ${r.id}: dialog without closedAt`).toBe('number');
        expect(d.closedAt!, `trc ${r.id}: dialog closedAt before window`).toBeGreaterThanOrEqual(start);
        expect(d.closedAt!, `trc ${r.id}: dialog closedAt past window`).toBeLessThanOrEqual(end);
      }
    }
  });

  // Catches a timestamp column (or JSON field) added to the generator without a
  // matching rebase statement: after the rebase every timestamp sits near load
  // time, so a value still inside the generation era was never shifted.
  test('no generation-time timestamp survives the rebase', () => {
    const minSec = anchorSec - 2 * 365 * 86_400;
    const isGenerationEra = (n: number) =>
      (n >= minSec && n <= anchorSec) || (n >= minSec * 1000 && n <= anchorSec * 1000 + 999);
    const tables = q(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`).map((r) =>
      String(r.name),
    );
    const stale = new Map<string, string>();
    for (const table of tables) {
      for (const row of q(`select * from "${table}"`)) {
        for (const [column, value] of Object.entries(row)) {
          // Integer columns, and digit runs embedded in JSON/text (bounded so a
          // hex SHA or an identifier never contributes a false match).
          const candidates =
            typeof value === 'number'
              ? [value]
              : typeof value === 'string'
                ? (value.match(/(?<![\w.])\d{10}(?:\d{3})?(?![\w.])/g) ?? []).map(Number)
                : [];
          const hit = candidates.find(isGenerationEra);
          if (hit !== undefined && !stale.has(`${table}.${column}`)) stale.set(`${table}.${column}`, String(hit));
        }
      }
    }
    expect(Object.fromEntries(stale)).toEqual({});
  });

  test('every backend log entry sits within its request span', () => {
    const rows = q(`
      select id, start_time, duration, server_logs from network_requests
      where server_logs is not null and json_valid(server_logs) and json_array_length(server_logs) > 0
    `);
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      const start = Number(r.start_time);
      const end = start + Number(r.duration);
      for (const log of JSON.parse(String(r.server_logs)) as Array<{ timestamp: number }>) {
        expect(log.timestamp, `request ${r.id}: backend log before request`).toBeGreaterThanOrEqual(start);
        expect(log.timestamp, `request ${r.id}: backend log after response`).toBeLessThanOrEqual(end);
      }
    }
  });
});

describe('simulator ↔ seed fingerprint parity', () => {
  test('the simulator error strings are identity-equal to the story fixtures they claim to reuse', () => {
    const c1 = FAILURE_STORIES.find((s) => s.clusterId === 1)!;
    const c2 = FAILURE_STORIES.find((s) => s.clusterId === 2)!;
    expect(SIMULATOR_ERRORS.checkoutPayTimeout).toBe(c1.failingCases[0]!.error);
    expect(SIMULATOR_ERRORS.checkoutPayTimeoutPaypal).toBe(c1.failingCases[1]!.error);
    expect(SIMULATOR_ERRORS.emailLabelRenamed).toBe(c2.failingCases[0]!.error);
  });

  test("the simulator's known errors fingerprint identically to their seeded clusters", async () => {
    const cluster1 = q(`select fingerprint from failure_clusters where id = 1`)[0]!.fingerprint as string;
    const cluster2 = q(`select fingerprint from failure_clusters where id = 2`)[0]!.fingerprint as string;

    const timeoutFp = await computeErrorFingerprint(SIMULATOR_ERRORS.checkoutPayTimeout);
    expect(timeoutFp.fingerprint).toBe(cluster1);

    const paypalFp = await computeErrorFingerprint(SIMULATOR_ERRORS.checkoutPayTimeoutPaypal);
    expect(paypalFp.fingerprint).toBe(cluster1);

    const renamedFp = await computeErrorFingerprint(SIMULATOR_ERRORS.emailLabelRenamed);
    expect(renamedFp.fingerprint).toBe(cluster2);
  });
});

/** Finished flake-lab experiments, newest first, in the shape the verified-fix rule reads. */
function seededExperiments(testCaseId?: number) {
  return q(`
    select id, test_case_id, kind, verdict, commit_sha, finished_at from flake_experiments
    where finished_at is not null ${testCaseId == null ? '' : `and test_case_id = ${testCaseId}`}
    order by finished_at desc, id desc
  `).map((r) => ({
    id: Number(r.id),
    testCaseId: Number(r.test_case_id),
    kind: String(r.kind),
    verdict: (r.verdict as string | null) ?? null,
    commit: (r.commit_sha as string | null) ?? null,
    finishedAt: new Date(Number(r.finished_at)),
  }));
}

/** A test's executions, in the shape the retry-pass rule reads. */
function seededExecutions(testCaseId: number) {
  return q(`
    select trc.test_run_id, trc.status, trc.browser_name, tr.start_time
    from test_runs_cases trc join test_runs tr on tr.id = trc.test_run_id
    where trc.test_case_id = ${testCaseId}
  `).map((r) => ({
    testCaseId,
    runId: Number(r.test_run_id),
    runStartedAt: new Date(Number(r.start_time) * 1000),
    browserKey: String(r.browser_name ?? ''),
    status: String(r.status),
  }));
}

describe('flake lab experiments', () => {
  test('every experiment has finished by load time, with its arms', () => {
    const rows = q(`
      select e.id, e.finished_at, (select count(*) from flake_arms a where a.experiment_id = e.id) as arms
      from flake_experiments e
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Number(r.finished_at), `experiment ${r.id} finishes in the future`).toBeLessThanOrEqual(Date.now());
      expect(Number(r.arms), `experiment ${r.id} has a control and an arm`).toBeGreaterThanOrEqual(2);
    }
  });

  // The Flaky view lists a test under Verified fixed only while no run started
  // after its verify experiment retry-passed; the demo keeps one such test.
  test('a verified fix holds: the test retry-passed before it, and never after', () => {
    const marks = markingExperiments(seededExperiments());
    expect(marks.size).toBeGreaterThan(0);

    for (const [testCaseId, mark] of marks) {
      const executions = seededExecutions(testCaseId);
      expect(firstRetryPassAfter(executions, new Date(0)), `test ${testCaseId} never retry-passed`).not.toBeNull();
      expect(firstRetryPassAfter(executions, mark.finishedAt), `test ${testCaseId} flaked after its fix`).toBeNull();
    }
  });
});

// Every docs page's demo example and every stop of the demo's guided tour opens
// the entity it names, in the state its sentence promises (the `expect`
// vocabulary of `shared/demo/demo-examples.mjs`).
const EXPECT_KEYS = new Set([
  'testCase',
  'execution',
  'project',
  'cluster',
  'run',
  'diagnosis',
  'fixLanded',
  'issue',
  'lab',
  'resources',
  'incident',
  'gaps',
  'suspects',
  'coverage',
  'fileCoverage',
  'insight',
]);
const ROUTE_ENTITIES = [
  { pattern: /^\/test-cases\/(\d+)(?:[?#]|$)/, key: 'testCase' },
  { pattern: /^\/test-run-cases\/(\d+)(?:[?#]|$)/, key: 'execution' },
  { pattern: /^\/projects\/(\d+)(?:\/coverage)?(?:[?#]|$)/, key: 'project' },
  { pattern: /^\/failure-clusters\/(\d+)(?:[?#]|$)/, key: 'cluster' },
  { pattern: /^\/test-runs\/(\d+)(?:[?#]|$)/, key: 'run' },
] as const;

/** The seeded entity a demo route opens, by its `expect` key and the id in the route; null when it opens none. */
function routeEntity(route: string): { key: (typeof ROUTE_ENTITIES)[number]['key']; id: number } | null {
  for (const { pattern, key } of ROUTE_ENTITIES) {
    const match = pattern.exec(route);
    if (match) return { key, id: Number(match[1]) };
  }
  return null;
}

/**
 * Checks `want` against the seed: the entity `route` opens is the one it names,
 * and every state it promises holds. `label` names the example or the stop.
 */
function expectHoldsInSeed(label: string, route: string, want: DemoExampleExpect): void {
  expect(
    Object.keys(want).filter((k) => !EXPECT_KEYS.has(k)),
    `${label}: expect keys outside the vocabulary`,
  ).toEqual([]);

  const opened = routeEntity(route);
  if (opened) {
    expect(want[opened.key]?.id, `${label}: the route opens the ${opened.key} it expects`).toBe(opened.id);
  }

  if (want.testCase) {
    const [row] = q(`select title from test_cases where id = ${want.testCase.id}`);
    expect(row?.title, `${label}: test case ${want.testCase.id}`).toBe(want.testCase.title);
  }
  if (want.execution) {
    const [row] = q(`
      select tc.title from test_runs_cases trc join test_cases tc on tc.id = trc.test_case_id
      where trc.id = ${want.execution.id}
    `);
    expect(row?.title, `${label}: execution ${want.execution.id}'s test`).toBe(want.execution.title);
  }
  if (want.project) {
    const [row] = q(`select name from projects where id = ${want.project.id}`);
    expect(row?.name, `${label}: project ${want.project.id}`).toBe(want.project.name);
  }
  if (want.run) {
    const [row] = q(
      `select p.name from test_runs r join projects p on p.id = r.project_id where r.id = ${want.run.id}`,
    );
    expect(row?.name, `${label}: run ${want.run.id}'s project`).toBe(want.run.project);
  }
  if (want.resources) {
    expect(want.run, `${label}: resources needs a run`).toBeTruthy();
    const parts = q(`select report from test_run_resource_reports where run_id = ${want.run!.id}`).map(
      (row) => JSON.parse(String(row.report)) as { counts: { leaked: number } },
    );
    const leaks = parts.reduce((sum, part) => sum + part.counts.leaked, 0);
    expect(leaks, `${label}: the run's report names a leak`).toBeGreaterThan(0);
  }
  if (want.incident) {
    expect(want.run, `${label}: incident needs a run`).toBeTruthy();
    const [row] = q(
      `select json_extract(metadata, '$.incident.rule') as rule from test_runs where id = ${want.run!.id}`,
    );
    expect(row?.rule, `${label}: the run is flagged as an incident`).toBeTruthy();
  }
  if (want.gaps) {
    expect(want.project, `${label}: gaps needs a project`).toBeTruthy();
    for (const detector of want.gaps.detectors) {
      const open = q(
        `select id from scenario_gaps where project_id = ${want.project!.id} and status = 'open' and detector = '${detector}'`,
      );
      expect(open.length, `${label}: an open ${detector} gap`).toBeGreaterThan(0);
    }
  }
  if (want.cluster) {
    expect(q(`select id from failure_clusters where id = ${want.cluster.id}`), `${label}: cluster exists`).toHaveLength(
      1,
    );
    const story = FAILURE_STORIES.find((s) => s.clusterId === want.cluster!.id);
    expect(story?.key, `${label}: cluster ${want.cluster.id}'s story`).toBe(want.cluster.story);
  }
  if (want.diagnosis) {
    expect(want.cluster, `${label}: diagnosis needs a cluster`).toBeTruthy();
    const [{ stored, withPatch }] = q(`
      select count(*) as stored,
        sum(case when status = 'completed' and json_extract(details, '$.suggestedFix.patch') is not null then 1 else 0 end) as withPatch
      from failure_diagnoses where cluster_id = ${want.cluster!.id}
    `) as Array<{ stored: number; withPatch: number | null }>;
    if (want.diagnosis === 'with-patch')
      expect(Number(withPatch), `${label}: a stored diagnosis with a patch`).toBeGreaterThan(0);
    else expect(Number(stored), `${label}: no stored diagnosis`).toBe(0);
  }
  if (want.fixLanded) {
    expect(want.cluster, `${label}: fixLanded needs a cluster`).toBeTruthy();
    const [row] = q(`select fix_landed_at from failure_clusters where id = ${want.cluster!.id}`);
    expect(row?.fix_landed_at, `${label}: the fix landed`).not.toBeNull();
  }
  if (want.issue) {
    expect(want.cluster, `${label}: issue needs a cluster`).toBeTruthy();
    // The newest tracker link wins, as clusterKnownIssues reads it.
    const [row] = q(`
      select key, provider, status_text from entity_links
      where failure_cluster_id = ${want.cluster!.id} and key is not null
        and (provider = 'jira' or connection_id is not null)
      order by id desc limit 1
    `);
    expect(row?.key, `${label}: cluster ${want.cluster!.id}'s tracked issue`).toBe(want.issue.key);
    expect(row?.provider, `${label}: ${want.issue.key} is a Jira issue`).toBe('jira');
    expect(row?.status_text, `${label}: ${want.issue.key}'s status`).toBe(want.issue.status);
  }
  if (want.suspects) {
    expect(want.cluster, `${label}: suspects needs a cluster`).toBeTruthy();
    const story = FAILURE_STORIES.find((s) => s.clusterId === want.cluster!.id)!;
    const { path, granularity } = want.suspects;
    const covered = story.failingCases
      .flatMap((fc) => storyCoverageFiles(story, fc.frames.at(-1)!.file, fc.title))
      .filter((entry) => (typeof entry === 'string' ? entry : entry.path) === path);
    expect(covered.length, `${label}: the failing tests' coverage names ${path}`).toBeGreaterThan(0);
    if (granularity === 'lines') {
      expect(
        covered.every((entry) => typeof entry !== 'string' && entry.lines.length > 0),
        `${label}: the failing tests' coverage of ${path} names lines`,
      ).toBe(true);
    }
    const range = getDemoDefaultRange(story.projectId);
    const changed = range ? getDemoChangesSince(story.projectId, range.from)?.files.map((f) => f.filename) : [];
    expect(changed, `${label}: the canned changes change ${path}`).toContain(path);
    const recorded = q(`
      select id from test_runs_cases
      where failure_cluster_id = ${want.cluster!.id} and coverage_payload_id is not null
    `);
    expect(recorded.length, `${label}: the cluster's executions recorded coverage`).toBeGreaterThan(0);
  }
  if (want.coverage) {
    expect(want.execution, `${label}: coverage needs an execution`).toBeTruthy();
    const [execution] = q(`
      select trc.test_run_id as runId, cp.content as content from test_runs_cases trc
      join case_payloads cp on cp.id = trc.coverage_payload_id
      where trc.id = ${want.execution!.id}
    `);
    expect(execution, `${label}: the execution recorded coverage`).toBeTruthy();
    const ids = (JSON.parse(String(execution!.content)) as number[]).join(',');
    const fragments = q(`select runtime, path, lines from coverage_fragments where id in (${ids})`);
    const server = fragments.filter((f) => f.runtime === 'server');
    expect(server.length, `${label}: server files`).toBe(want.coverage.serverFiles);
    expect(
      server.every((f) => f.lines),
      `${label}: every server file names its lines`,
    ).toBe(true);
    expect(fragments.filter((f) => f.runtime === 'browser').length, `${label}: browser files`).toBe(
      want.coverage.browserFiles,
    );
    if (want.coverage.runCoverage) {
      // The run's own coverage of each file, at a version whose executable lines are stored.
      const run = new Set(
        q(`
          select rc.path from run_coverage rc
          join coverage_executable ce
            on ce.project_id = rc.project_id and ce.runtime = rc.runtime and ce.path = rc.path and ce.blob = rc.blob
          where rc.run_id = ${execution!.runId} and ce.lines is not null
        `).map((r) => String(r.path)),
      );
      for (const f of server) expect(run.has(String(f.path)), `${label}: run coverage of ${f.path}`).toBe(true);
    }
  }
  if (want.fileCoverage) {
    expect(want.project, `${label}: fileCoverage needs a project`).toBeTruthy();
    const { path, tests, executable } = want.fileCoverage;
    const fragments = q(
      `select id, blob, lines from coverage_fragments where project_id = ${want.project!.id} and path = '${path}'`,
    );
    expect(fragments.length, `${label}: coverage of ${path}`).toBeGreaterThan(0);
    expect(
      fragments.every((f) => f.blob && f.lines),
      `${label}: every coverage of ${path} names lines at a blob`,
    ).toBe(true);
    const [row] = q(`
      select count(distinct test_case_id) as tests from test_coverage
      where branch = '' and fragment_id in (${fragments.map((f) => f.id).join(',')})
    `);
    expect(Number(row?.tests), `${label}: the tests that recorded ${path}`).toBe(tests);
    if (executable) {
      const blobs = [...new Set(fragments.map((f) => `'${String(f.blob)}'`))].join(',');
      const recorded = q(`
        select id from coverage_executable
        where project_id = ${want.project!.id} and path = '${path}' and blob in (${blobs}) and lines is not null
      `);
      expect(recorded.length, `${label}: a run recorded the executable lines of ${path}`).toBeGreaterThan(0);
    }
  }
  if (want.insight === 'divergence') {
    expect(want.execution, `${label}: divergence needs an execution`).toBeTruthy();
    const [row] = q(`
      select trc.test_case_id as testCaseId, trc.status, trc.started_at as startedAt from test_runs_cases trc
      where trc.id = ${want.execution!.id} and trc.coverage_payload_id is not null
    `);
    expect(row?.status, `${label}: the execution failed with coverage`).toBe('failed');
    const passes = q(`
      select id from test_runs_cases where test_case_id = ${row!.testCaseId} and status = 'passed'
        and coverage_payload_id is not null and started_at < ${row!.startedAt}
    `);
    expect(passes.length, `${label}: an earlier passing execution with coverage`).toBeGreaterThan(0);
  }
  if (want.insight === 'path-variation') {
    expect(want.testCase, `${label}: path-variation needs a test case`).toBeTruthy();
    const covered = q(`
      select id from test_runs_cases where test_case_id = ${want.testCase!.id} and coverage_payload_id is not null
    `);
    expect(covered.length, `${label}: executions with coverage`).toBeGreaterThanOrEqual(8);
  }
  if (want.lab) {
    expect(want.testCase, `${label}: lab needs a test case`).toBeTruthy();
    const testCaseId = want.testCase!.id;
    const experiments = seededExperiments(testCaseId);
    const mark = markingExperiments(experiments).get(testCaseId);
    const fix = mark
      ? { flakedAgainAt: firstRetryPassAfter(seededExecutions(testCaseId), mark.finishedAt) ? 'yes' : null }
      : null;
    expect(flakeLabTestState(experiments, fix), `${label}: the test's lab state`).toBe(want.lab);
  }
}

describe('demo examples hold in the seed', () => {
  test('ids are unique', () => {
    const ids = DEMO_EXAMPLES.map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  test.each(DEMO_EXAMPLES.map((e) => [e.id, e] as const))('%s', (id, example) => {
    expect(
      routeEntity(example.route),
      `${id}: route ${example.route} opens a test case, an execution, a project, a cluster or a run`,
    ).toBeTruthy();
    expectHoldsInSeed(id, example.route, example.expect);
  });
});

// A stop whose route opens a seeded entity names it, and the seed holds what it
// expects; a stop on a page that shows no single entity (Home, Analytics,
// Setup…) expects nothing.
describe('guided tour stops hold in the seed', () => {
  const routed = TOUR_PROFILES.flatMap((profile) =>
    profile.stops.flatMap((stop) => (stop.route ? [[`${profile.id}/${stop.id}`, stop.route, stop] as const] : [])),
  );

  test.each(routed)('%s', (name, route, stop) => {
    const opened = routeEntity(route);
    if (!opened) {
      expect(stop.expect, `${name}: ${route} opens no seeded entity, so the stop expects nothing`).toBeUndefined();
      return;
    }
    expect(stop.expect, `${name}: ${route} opens a seeded ${opened.key}, so the stop names it`).toBeDefined();
    expectHoldsInSeed(name, route, stop.expect!);
  });
});

// The seeded resource findings are what recordRunResourceFindings would write
// from the seeded reports: one per identity, with the runs that showed it.
describe('resource findings match the seeded reports', () => {
  test('each finding is the identity of the findings its runs reported, and counts those runs', () => {
    const runs = q(`select run_id, report from test_run_resource_reports`) as Array<{ run_id: number; report: string }>;
    expect(runs.length).toBeGreaterThan(0);
    const runsByFingerprint = new Map<string, number[]>();
    for (const run of runs.map((row) => ({
      id: row.run_id,
      report: JSON.parse(row.report) as { findings: WireResourceFinding[] },
    }))) {
      for (const finding of run.report.findings) {
        const fingerprint = resourceFingerprint(finding);
        runsByFingerprint.set(fingerprint, [...(runsByFingerprint.get(fingerprint) ?? []), run.id]);
      }
    }
    const findings = q(
      `select id, fingerprint, occurrences, first_seen_run_id, last_seen_run_id from resource_findings`,
    ) as Array<{
      id: number;
      fingerprint: string;
      occurrences: number;
      first_seen_run_id: number;
      last_seen_run_id: number;
    }>;
    expect(findings.map((f) => f.fingerprint).sort()).toEqual([...runsByFingerprint.keys()].sort());
    for (const finding of findings) {
      const runIds = runsByFingerprint.get(finding.fingerprint)!;
      expect(finding.occurrences, finding.fingerprint).toBe(runIds.length);
      expect(finding.first_seen_run_id, finding.fingerprint).toBe(Math.max(...runIds));
      expect(finding.last_seen_run_id, finding.fingerprint).toBe(Math.min(...runIds));
      const occurrences = q(`select run_id from resource_occurrences where finding_id = ${finding.id}`) as Array<{
        run_id: number;
      }>;
      expect(occurrences.map((o) => o.run_id).sort(), finding.fingerprint).toEqual([...runIds].sort());
    }
  });
});

describe('environment incidents', () => {
  // The seeded flag is written by hand; the classifier must reach the same
  // verdict from the seeded failures, and flag no other run.
  // The failed requests of an execution's network capture, as the classifier reads them.
  const failedRequestsOf = (executionId: number) =>
    q(`select url, status, failure from network_requests where test_runs_case_id = ${executionId}
       and (failure is not null or status in (${GATEWAY_STATUSES.join(', ')}))`).map((r) => ({
      url: r.url as string | null,
      status: r.status as number,
      failure: r.failure as string | null,
    }));

  test('the classifier flags the seeded incident run, with its reason, and no other run', () => {
    const runs = q('select id, passed_tests, failed_tests, metadata from test_runs order by id');
    const flagged: number[] = [];
    for (const run of runs) {
      const rows = q(
        `select id, test_case_id, status, error from test_runs_cases where test_run_id = ${run.id as number}`,
      );
      const passed = new Set(rows.filter((r) => r.status === 'passed').map((r) => r.test_case_id));
      const failures = rows
        .filter((r) => r.status === 'failed' && !passed.has(r.test_case_id))
        .map((r) => ({ error: r.error as string, failedRequests: failedRequestsOf(r.id as number) }));
      const metadata = JSON.parse((run.metadata as string) ?? 'null');
      const verdict = classifyRunHealth({
        runId: run.id as number,
        executedTests: (run.passed_tests as number) + (run.failed_tests as number),
        failedTests: run.failed_tests as number,
        failures,
        baseUrls: runBaseUrls(metadata),
      });
      if (verdict) {
        flagged.push(run.id as number);
        expect(metadata?.incident, `run ${run.id as number} carries the flag`).toMatchObject({
          rule: verdict.rule,
          reason: verdict.reason,
          host: verdict.host,
        });
      } else {
        expect(metadata?.incident, `run ${run.id as number} carries no flag`).toBeUndefined();
      }
    }
    expect(flagged).toHaveLength(1);
    const markers = q(`select run_id from markers where category = 'incident' and run_id is not null`);
    expect(markers.map((m) => m.run_id)).toEqual(flagged);
  });

  test("the incident run's network capture holds each failing test's refused navigation", () => {
    const rows = q(`
      select trc.id from test_runs_cases trc join test_runs r on r.id = trc.test_run_id
      where json_extract(r.metadata, '$.incident') is not null and trc.status = 'failed'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(failedRequestsOf(row.id as number), `trc ${row.id as number}`).toEqual([
        expect.objectContaining({ status: 0, failure: 'net::ERR_CONNECTION_REFUSED' }),
      ]);
    }
  });

  test('the incident run gets no regression signal', () => {
    const rows = q(`
      select count(*) as n from test_runs_cases trc join test_runs r on r.id = trc.test_run_id
      where json_extract(r.metadata, '$.incident') is not null and trc.is_new_regression = 1`);
    expect(rows[0]!.n).toBe(0);
  });
});

describe('the seed loaded through libsql, as app:seed:dev and the server load it', () => {
  // libsql bundles an older SQLite than sql.js, and the load-time rebase
  // rewrites the JSON arrays element by element: every element must come back
  // an object, or REST and MCP read a string spelled out character by character.
  test('every JSON array element stays an object through the rebase', async () => {
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url: ':memory:' });
    try {
      await client.executeMultiple(seedSql);
      const columns: Array<[string, string]> = [
        ['test_runs_cases', 'steps'],
        ['test_runs_cases', 'step_events'],
        ['test_runs_cases', 'attempts'],
        ['test_runs_cases', 'console_logs'],
        ['test_runs_cases', 'dialogs'],
        ['network_requests', 'server_logs'],
      ];
      for (const [table, column] of columns) {
        const res = await client.execute(`select t.id, e.type from ${table} t, json_each(t.${column}) e
          where t.${column} is not null and json_valid(t.${column}) and e.type <> 'object'`);
        expect(res.rows, `${table}.${column}: elements that are not objects`).toEqual([]);
      }
      // A test the serial cascade never ran keeps its attempt, with no start time.
      const res = await client.execute(`select attempts from test_runs_cases
        where status = 'didnotrun' and attempts is not null limit 1`);
      expect(JSON.parse(String(res.rows[0]!.attempts))).toEqual([
        { retry: 0, status: 'didnotrun', duration: 0, startedAt: null },
      ]);
    } finally {
      client.close();
    }
  }, 60_000);
});
