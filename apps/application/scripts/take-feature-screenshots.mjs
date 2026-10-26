#!/usr/bin/env node
/**
 * Captures screenshots of user-facing features against a real dev server — the
 * standard closing step for UI work: every change that adds or visibly reworks
 * a screen gets a scene here, and the captured images go into the final report
 * (see the "Feature screenshots" rule in AGENTS.md).
 *
 * Usage (from application/):
 *   node scripts/take-feature-screenshots.mjs                 # all scenes
 *   node scripts/take-feature-screenshots.mjs <scene> …       # just these
 *   node scripts/take-feature-screenshots.mjs --tag docs      # every docs illustration
 *   node scripts/take-feature-screenshots.mjs --list          # scenes, tags and output files
 *   node scripts/take-feature-screenshots.mjs --check         # docs images vs. scenes, no capture
 *   node scripts/take-feature-screenshots.mjs --url http://localhost:3002
 *   node scripts/take-feature-screenshots.mjs --freeze-now 2026-08-02T09:00:00Z
 *   node scripts/take-feature-screenshots.mjs <scene> --out ../docs/public/screenshots
 *   node scripts/take-feature-screenshots.mjs --route /test-run-cases/37 --expand --height 2400
 *
 * Without --url the script boots its own dev server on port 3050 and tears it
 * down at the end; a missing dev DB is created and seeded first. With --url it
 * drives the server you point it at.
 *
 * `--route <path>` captures one page without registering a scene — the way to
 * look at any screen while verifying a change. It gets the same server, the
 * same hydration and settle waits, and writes `.screens/route-<slug>.png`.
 * `--expand` unfolds every collapsed section first; `--width` and `--height`
 * size the viewport (the dashboard scrolls inside a panel, so a taller viewport
 * is how more of a page gets into one image); `--name` picks the file stem.
 *
 * Every scene declares a `mode`: `web` (the default) captures the dashboard as
 * a browser serves it, `tour` the same with the demo's guided tour switched on
 * (`NUXT_PUBLIC_DEMO_TOUR=true`), for scenes of the tour itself, and `desktop`
 * captures the Tauri shell — the server runs with `NUXT_PUBLIC_DESKTOP=true`
 * and a mocked Tauri IPC bridge is injected into the page, so no shell build is
 * needed. A desktop scene can shape what the mock answers (linked folder,
 * inspection result). `demo` captures the built demo SPA (run
 * `npm run app:generate:demo` first), served from its `/demo/` sub-path with
 * its service worker answering from the in-browser seed, for what only the
 * demo build does, such as its assistant's prepared answers. A run covering
 * several modes boots one server per mode, web first. With `--url`, every
 * scene drives that one server, so point a tour scene at a server started with
 * `NUXT_PUBLIC_DEMO_TOUR=true`, and a demo scene at a served demo's base
 * (`http://localhost:4173/demo`).
 *
 * Output goes where the scene's `out` says: `screens` → `.screens/` (gitignored
 * report artifacts) and `docs` → `apps/docs/public/screenshots/` (committed
 * illustrations). `--out <dir>` overrides both.
 */

import { createRequire } from 'module';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { drawAnnotations, clearAnnotations } from './screenshot-annotations.mjs';
import { resolveChromium, startServer, waitForPortFree } from './lib/dev-server.mjs';
import { waitForHydration, settlePage } from './lib/page-waits.mjs';
import { SUSPECT_SCENE_CLUSTER, SUSPECT_SCENE_EXECUTION, withSceneChanges } from './lib/suspect-lines-scene.mjs';
import {
  COVERAGE_SCENE_EXECUTION,
  COVERAGE_SCENE_PROJECT,
  COVERAGE_SCENE_SUSPECT_LINES,
  SERVER_COVERAGE_SCENE_EXECUTION,
  coverageSceneSource,
} from './lib/coverage-scene.mjs';
import { ORDER_SCENE, orderSceneSource } from './lib/coverage-insights-scene.mjs';
import { READY_INSPECTION, bridgeScript } from './lib/desktop-bridge.mjs';
import { BUILT_DEMO_BASE, BUILT_DEMO_ROOT, serveBuiltDemo } from './lib/built-demo.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sharp = require('sharp');

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, '..');
const DOCS_SHOTS_DIR = join(APP_DIR, '..', 'docs', 'public', 'screenshots');

/** Where a scene's images land. `screens` is gitignored; `docs` is committed. */
const OUT_TARGETS = {
  screens: join(APP_DIR, '.screens'),
  docs: DOCS_SHOTS_DIR,
};

const DEFAULT_VIEWPORT = { width: 1280, height: 860 };

/**
 * A real Playwright 1.63 trace recorded with `snapshots: { dom, aria, screen }`,
 * ingested by the failing-step-evidence scene so the timeline can show the page
 * captured at the failing step. The seeded demo traces predate 1.63, so this
 * feature can only be driven from a genuine snapshot-bearing trace.
 */
const TRACE_SNAPSHOT_FIXTURE = join(APP_DIR, 'tests', 'fixtures', 'trace-aria-screen-1.63.zip');
const TRACE_SNAPSHOT_CASE = {
  title: 'checkout — cancel is gone after paying',
  location: 'tests/checkout.spec.ts:12:3',
  retries: 0,
};

/** POST to the server, retrying while the dev server compiles the API route on its first hit. */
async function postRetrying(request, base, path, options) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await request.post(`${base}${path}`, options);
      if (res.ok()) return res;
      last = new Error(`${path} → ${res.status()}`);
    } catch (error) {
      last = error;
    }
  }
  throw last ?? new Error(`could not POST ${path}`);
}

/**
 * Start a run, push one failing case with a marked failing step, and upload the
 * 1.63 trace fixture for it. Returns its executionId. Retries the pushes while
 * the dev server compiles the API routes on first hit.
 */
async function ingestTraceSnapshotCase(request, base) {
  const trace = readFileSync(TRACE_SNAPSHOT_FIXTURE);
  const traceHash = createHash('sha256').update(trace).digest('hex');
  const post = (path, options) => postRetrying(request, base, path, options);

  const started = await (
    await post('/api/test-runs/start', {
      data: { projectName: 'trace-snapshots', startTime: new Date().toISOString() },
    })
  ).json();
  const { runId, streamToken } = started;

  await post(`/api/test-runs/${runId}/events`, {
    data: {
      streamToken,
      testCases: [
        {
          type: 'complete',
          ...TRACE_SNAPSHOT_CASE,
          status: 'failed',
          duration: 2000,
          error:
            "TimeoutError: locator.click: Timeout 1500ms exceeded.\n  - waiting for getByRole('button', { name: 'Cancel' })",
          steps: [
            { title: 'Navigate to "data:text/html"', category: 'navigation', duration: 40, startTime: 0 },
            { title: 'Fill "a@b.test"', category: 'input', duration: 20, startTime: 50 },
            { title: 'Click "Pay now"', category: 'click', duration: 30, startTime: 80 },
            { title: 'Click "Cancel"', category: 'click', duration: 1500, startTime: 120, failed: true },
          ],
        },
      ],
    },
  });

  const upload = await post(`/api/test-runs/${runId}/case-files`, {
    multipart: {
      streamToken,
      testCase: JSON.stringify(TRACE_SNAPSHOT_CASE),
      trace_hash: traceHash,
      trace: { name: 'trace.zip', mimeType: 'application/zip', buffer: trace },
    },
  });
  return (await upload.json()).executionId;
}

/**
 * A test whose beforeEach hook failed, as the reporter records it from
 * Playwright 1.63 (taken from a real run): the hook and its fixtures under
 * `Before Hooks`, the failing click inside the hook, the capture's own
 * attachments and the teardown under `After Hooks`. Start times are offsets
 * from the test's start, in ms.
 */
const HOOK_FAILURE_CASE = { title: 'renames the profile', location: 'tests/profile.spec.ts:9:3', retries: 0 };
const HOOK_FAILURE_ERROR =
  "TimeoutError: locator.click: Timeout 1500ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Edit profile' })\n\n    at tests/profile.spec.ts:6:62";
const HOOK_FAILURE_TIMEOUT = { message: 'TimeoutError: locator.click: Timeout 1500ms exceeded.' };
const HOOK_FAILURE_STEPS = [
  {
    title: 'Before Hooks',
    category: 'hook',
    depth: 0,
    at: 0,
    duration: 1637,
    failed: true,
    error: HOOK_FAILURE_TIMEOUT,
  },
  {
    title: 'beforeEach hook',
    category: 'hook',
    depth: 1,
    at: 0,
    duration: 1637,
    failed: true,
    error: HOOK_FAILURE_TIMEOUT,
    location: 'tests/profile.spec.ts:4:8',
  },
  { title: 'Fixture "piwiCapture"', category: 'fixture', depth: 2, at: 6, duration: 0 },
  { title: 'Fixture "context"', category: 'fixture', depth: 2, at: 6, duration: 13 },
  { title: 'Create context', category: 'other', depth: 3, at: 7, duration: 6 },
  { title: 'Fixture "page"', category: 'fixture', depth: 2, at: 20, duration: 59 },
  { title: 'Create page', category: 'other', depth: 3, at: 20, duration: 59 },
  {
    title: 'Navigate',
    subtitle: '/account',
    category: 'navigation',
    depth: 2,
    at: 80,
    duration: 51,
    location: 'tests/profile.spec.ts:5:16',
  },
  {
    title: 'Click',
    subtitle: "getByRole('button', { name: 'Edit profile' })",
    category: 'action',
    depth: 2,
    at: 132,
    duration: 1505,
    failed: true,
    error: HOOK_FAILURE_TIMEOUT,
    params: { locator: "getByRole('button', { name: 'Edit profile' })" },
    location: 'tests/profile.spec.ts:6:62',
  },
  { title: 'After Hooks', category: 'hook', depth: 0, at: 1638, duration: 138 },
  { title: 'Fixture "page"', category: 'fixture', depth: 1, at: 1678, duration: 0 },
  { title: 'Fixture "context"', category: 'fixture', depth: 1, at: 1678, duration: 88 },
  { title: 'Close context', category: 'other', depth: 2, at: 1748, duration: 18 },
  { title: 'Fixture "piwiCapture"', category: 'fixture', depth: 1, at: 1766, duration: 4 },
  { title: 'Attach "piwi-locators"', category: 'attach', depth: 2, at: 1767, duration: 0 },
  { title: 'Attach "piwi-network"', category: 'attach', depth: 2, at: 1769, duration: 0 },
  { title: 'Worker Cleanup', category: 'hook', depth: 0, at: 1776, duration: 59 },
  { title: 'Fixture "browser"', category: 'fixture', depth: 1, at: 1777, duration: 56 },
];

/**
 * Report one run through the streaming API — start, one completed case, finish
 * — and return its id and the case's executionId. `metadata` is the run's
 * (its `scm` block is what the cluster page's "What changed" line reads).
 */
async function ingestRun(request, base, { projectName, metadata, testCase, startTime }) {
  const post = (path, options) => postRetrying(request, base, path, options);
  const started = await (
    await post('/api/test-runs/start', {
      data: { projectName, startTime: new Date(startTime).toISOString(), totalTests: 1, metadata },
    })
  ).json();
  const { runId, streamToken } = started;
  await post(`/api/test-runs/${runId}/events`, {
    data: { streamToken, testCases: [{ type: 'complete', ...testCase }] },
  });
  const failed = testCase.status !== 'passed';
  await post(`/api/test-runs/${runId}/finish`, {
    data: {
      streamToken,
      status: failed ? 'failed' : 'passed',
      duration: testCase.duration,
      totalTests: 1,
      passedTests: failed ? 0 : 1,
      failedTests: failed ? 1 : 0,
    },
  });
  const run = await (await request.get(`${base}/api/test-runs/${runId}`)).json();
  return { runId, executionId: run.testCases?.[0]?.executionId ?? null };
}

/** The hook-failure case, its steps placed at `startTime`. */
function hookFailureCase(startTime) {
  return {
    ...HOOK_FAILURE_CASE,
    status: 'failed',
    duration: 1835,
    error: HOOK_FAILURE_ERROR,
    steps: HOOK_FAILURE_STEPS.map(({ at, ...step }) => ({ ...step, startTime: startTime + at })),
  };
}

/** The hook-failure execution both widths of its scene open, reported once per session. */
let hookFailureExecution;

function reportHookFailure(request, base) {
  hookFailureExecution ??= (async () => {
    const startTime = Date.now() - 5_000;
    const { executionId } = await ingestRun(request, base, {
      projectName: 'profile-e2e',
      testCase: hookFailureCase(startTime),
      startTime,
    });
    if (!executionId) throw new Error('the hook-failure run has no execution');
    return executionId;
  })();
  return hookFailureExecution;
}

/**
 * A test that probes an optional dialog inside a `try`/`catch`, then fails on a
 * strict mode violation inside a `test.step`, as the reporter records it from
 * Playwright 1.63 (taken from a real run): the caught probe carries its error
 * and the reporter's `recovered` mark. Start times are offsets from the test's
 * start, in ms.
 */
const CAUGHT_ERROR_CASE = {
  title: 'saves the report and checks the download link',
  location: 'tests/downloads.spec.ts:3:5',
  retries: 0,
};
const CAUGHT_ERROR_PROBE = {
  message:
    "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('dialog').getByRole('button', { name: 'Confirm' })\nExpected: visible\nTimeout: 500ms\nError: element(s) not found",
  location: '/work/shop/tests/downloads.spec.ts:15:27',
};
const CAUGHT_ERROR_FATAL = {
  message:
    "Error: expect(locator).toBeEnabled() failed\n\nLocator: locator('.carousel').getByRole('link', { name: '' })\nExpected: enabled\nError: strict mode violation: locator('.carousel').getByRole('link', { name: '' }) resolved to 2 elements:\n    1) <a href=\"/files/1\"></a> aka getByRole('link').first()\n    2) <a href=\"/files/2\"></a> aka getByRole('link').nth(1)",
  location: '/work/shop/tests/downloads.spec.ts:26:77',
};
const CAUGHT_ERROR_STEPS = [
  {
    title: 'Set content',
    category: 'other',
    depth: 0,
    at: 0,
    duration: 23,
    location: '/work/shop/tests/downloads.spec.ts:4:14',
  },
  {
    title: 'Expect "toBeVisible"',
    subtitle: "getByRole('dialog').getByRole('button', { name: 'Confirm' })",
    category: 'assertion',
    depth: 0,
    at: 29,
    duration: 509,
    failed: true,
    recovered: true,
    error: CAUGHT_ERROR_PROBE,
    location: '/work/shop/tests/downloads.spec.ts:15:27',
  },
  {
    title: 'Click',
    subtitle: "getByRole('button', { name: 'Save' })",
    category: 'action',
    depth: 0,
    at: 539,
    duration: 32,
    location: '/work/shop/tests/downloads.spec.ts:22:52',
  },
  {
    title: 'Check the download link',
    category: 'test.step',
    depth: 0,
    at: 572,
    duration: 19,
    failed: true,
    error: CAUGHT_ERROR_FATAL,
    location: '/work/shop/tests/downloads.spec.ts:24:3',
  },
  {
    title: 'Expect "toBeEnabled"',
    subtitle: "locator('.carousel').getByRole('link', { name: '' })",
    category: 'assertion',
    depth: 1,
    at: 574,
    duration: 17,
    failed: true,
    error: CAUGHT_ERROR_FATAL,
    location: '/work/shop/tests/downloads.spec.ts:26:77',
  },
];

/** The caught-error execution both widths of its scene open, reported once per session. */
let caughtErrorExecution;

function reportCaughtError(request, base) {
  caughtErrorExecution ??= (async () => {
    const startTime = Date.now() - 5_000;
    const { executionId } = await ingestRun(request, base, {
      projectName: 'downloads-e2e',
      testCase: {
        ...CAUGHT_ERROR_CASE,
        status: 'failed',
        duration: 640,
        error: `${CAUGHT_ERROR_FATAL.message}\n\n    at tests/downloads.spec.ts:26:77`,
        steps: CAUGHT_ERROR_STEPS.map(({ at, ...step }) => ({ ...step, startTime: startTime + at })),
      },
      startTime,
    });
    if (!executionId) throw new Error('the caught-error run has no execution');
    return executionId;
  })();
  return caughtErrorExecution;
}

/**
 * A report test whose two last passing runs click *Load report* in 600 ms and
 * fetch the report in 300 ms, then a failure where both take several times as
 * long, though neither takes a third of the 9 s test: the timeline colors them
 * against their usual time. Start times are offsets from the test's start.
 */
const USUAL_DURATION_CASE = { title: 'opens the monthly report', location: 'tests/reports.spec.ts:8:3', retries: 0 };
const USUAL_DURATION_ERROR =
  'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "12 rows"\nReceived: "0 rows"\n\n    at tests/reports.spec.ts:14:52';

function usualDurationCase(startTime, { failed, duration, clickMs, reportId, reportMs }) {
  const steps = [
    { title: "page.goto('/reports')", category: 'navigation', at: 0, duration: 1200 },
    { title: "page.waitForLoadState('networkidle')", category: 'wait', at: 1300, duration: 2600 },
    { title: "getByRole('button', { name: 'Load report' }).click()", category: 'action', at: 4000, duration: clickMs },
    {
      title: 'Expect "toBe"',
      category: 'assertion',
      at: 4100 + clickMs,
      duration: 3,
      ...(failed ? { failed: true } : {}),
    },
  ];
  const requests = [
    { method: 'GET', url: 'https://reports.example.com/reports', duration: 180, at: 100, resourceType: 'document' },
    {
      method: 'GET',
      url: `https://reports.example.com/api/report/${reportId}`,
      duration: reportMs,
      at: 4100,
      resourceType: 'fetch',
    },
  ];
  return {
    ...USUAL_DURATION_CASE,
    status: failed ? 'failed' : 'passed',
    duration,
    startedAt: startTime,
    ...(failed ? { error: USUAL_DURATION_ERROR } : {}),
    steps: steps.map(({ at, ...step }) => ({ ...step, startTime: startTime + at })),
    networkRequests: requests.map(({ at, ...req }) => ({ ...req, status: 200, startTime: startTime + at })),
  };
}

/** The usual-duration execution its scene opens, reported once per session. */
let usualDurationExecution;

function reportUsualDuration(request, base) {
  usualDurationExecution ??= (async () => {
    const projectName = 'reports-e2e';
    for (const hoursAgo of [2, 1]) {
      const startTime = Date.now() - hoursAgo * 60 * 60_000;
      const passing = { failed: false, duration: 5000, clickMs: 600, reportId: hoursAgo, reportMs: 300 };
      await ingestRun(request, base, { projectName, testCase: usualDurationCase(startTime, passing), startTime });
    }
    const startTime = Date.now() - 15_000;
    const failing = { failed: true, duration: 9000, clickMs: 2500, reportId: 3, reportMs: 1600 };
    const { executionId } = await ingestRun(request, base, {
      projectName,
      testCase: usualDurationCase(startTime, failing),
      startTime,
    });
    if (!executionId) throw new Error('the usual-duration run has no execution');
    return executionId;
  })();
  return usualDurationExecution;
}

/**
 * A run on three workers with `retries: 2`, as Playwright schedules it: a
 * failed attempt ends its worker process, and the retry runs in the next free
 * worker. "applies a discount code" fails, then passes on a retry in the new
 * process of its lane; "pays with a saved card" fails all three attempts, the
 * last one picked up by worker 2's process, free by then. Offsets are ms from
 * the run's start; `retry` is the attempt's retry index.
 */
const RETRIED_RUN_CASES = [
  { title: 'shows the product list', worker: 0, at: 0, duration: 3200 },
  { title: 'applies a discount code', worker: 0, at: 3300, duration: 5500, failed: true },
  { title: 'updates the shipping address', worker: 3, at: 9800, duration: 3700 },
  { title: 'pays with a saved card', worker: 3, at: 13600, duration: 6200, failed: true, retry: 1 },
  { title: 'pays with a saved card', worker: 2, at: 20900, duration: 6200, failed: true, retry: 2 },
  { title: 'signs in with a password', worker: 1, at: 0, duration: 2500 },
  { title: 'pays with a saved card', worker: 1, at: 2600, duration: 5800, failed: true },
  { title: 'applies a discount code', worker: 4, at: 9300, duration: 4500, retry: 1 },
  { title: 'exports the invoice', worker: 4, at: 13900, duration: 2600 },
  { title: 'searches by SKU', worker: 4, at: 16600, duration: 2400 },
  { title: 'shows the order history', worker: 4, at: 19100, duration: 3100 },
  { title: 'filters by category', worker: 2, at: 0, duration: 4500 },
  { title: 'sorts by price', worker: 2, at: 4600, duration: 2400 },
  { title: 'adds a review', worker: 2, at: 7100, duration: 3900 },
  { title: 'removes an item', worker: 2, at: 11100, duration: 2900 },
  { title: 'checks out as a guest', worker: 2, at: 14100, duration: 3400 },
  { title: 'prints the receipt', worker: 2, at: 17600, duration: 3200 },
];

/** The retried run's id, reported once per session. */
let retriedRun;

function reportRetriedRun(request, base) {
  retriedRun ??= (async () => {
    const post = (path, options) => postRetrying(request, base, path, options);
    const startTime = Date.now() - 60_000;
    const titles = [...new Set(RETRIED_RUN_CASES.map((c) => c.title))];
    const { runId, streamToken } = await (
      await post('/api/test-runs/start', {
        data: {
          projectName: 'checkout-retries',
          startTime: new Date(startTime).toISOString(),
          totalTests: titles.length,
        },
      })
    ).json();
    const attempt = (c) => ({
      retry: c.retry ?? 0,
      status: c.failed ? 'failed' : 'passed',
      duration: c.duration,
      startedAt: startTime + c.at,
    });
    const testCases = RETRIED_RUN_CASES.map((c) => ({
      type: 'complete',
      title: c.title,
      location: `tests/checkout.spec.ts:${titles.indexOf(c.title) * 8 + 3}:5`,
      status: c.failed ? 'failed' : 'passed',
      duration: c.duration,
      error: c.failed ? "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('alert')" : null,
      retries: c.retry ?? 0,
      attempts: RETRIED_RUN_CASES.filter((o) => o.title === c.title && (o.retry ?? 0) <= (c.retry ?? 0))
        .map(attempt)
        .sort((a, b) => a.retry - b.retry),
      workerIndex: c.worker,
      startedAt: startTime + c.at,
      browser: { projectName: 'chromium', browserName: 'chromium' },
    }));
    await post(`/api/test-runs/${runId}/events`, { data: { streamToken, testCases } });
    await post(`/api/test-runs/${runId}/finish`, {
      data: {
        streamToken,
        status: 'failed',
        duration: 27100,
        totalTests: titles.length,
        passedTests: titles.length - 1,
        failedTests: 1,
        flakyTests: 1,
      },
    });
    return runId;
  })();
  return retriedRun;
}

/**
 * A run still going on three workers, 48 s in: each worker finished a few tests
 * and runs one more, and the reporter posted what it measured so far (the
 * machine's CPU every second, the run's memory and each worker's CPU and memory
 * every five, and the pages each worker holds open, one more after every test
 * on worker 1). Nothing finishes it, so the run page draws it live.
 */
async function reportLiveRunWithResources(request, base) {
  const post = (path, options) => postRetrying(request, base, path, options);
  const startTime = Date.now() - 48_000;
  const tests = [];
  for (let worker = 0; worker < 3; worker++) {
    let at = 1500 + worker * 400;
    for (let i = 0; i < 4; i++) {
      const duration = 7000 + ((worker * 5 + i * 3) % 7) * 900;
      tests.push({ worker, at, duration, title: `checkout step ${worker * 4 + i + 1}`, running: i === 3 });
      at += duration + 400;
    }
  }
  const { runId, streamToken } = await (
    await post('/api/test-runs/start', {
      data: { projectName: 'checkout-live', startTime: new Date(startTime).toISOString(), totalTests: 16 },
    })
  ).json();
  const browser = { projectName: 'chromium', browserName: 'chromium' };
  const testCases = tests.map((t, i) => ({
    type: t.running ? 'begin' : 'complete',
    title: t.title,
    location: `tests/checkout.spec.ts:${i * 8 + 3}:5`,
    ...(t.running ? {} : { status: 'passed', duration: t.duration, retries: 0 }),
    workerIndex: t.worker,
    startedAt: startTime + t.at,
    browser,
  }));
  await post(`/api/test-runs/${runId}/events`, { data: { streamToken, testCases } });

  const wave = (n) => (Math.sin(n * 1.7) + Math.sin(n * 0.45)) / 2;
  const cpuPct = Array.from({ length: 47 }, (_, i) => [(i + 1) * 1000, Math.round(58 + 14 * wave(i) + i * 0.5)]);
  const memoryBytes = Array.from({ length: 10 }, (_, i) => [i * 5000, Math.round((2.1 + i * 0.28) * 1024 ** 3)]);
  const pages = [0, 1, 2].map((worker) => {
    const done = tests.filter((t) => t.worker === worker && !t.running);
    // Worker 1 leaves each test's page open; the others close it.
    const points =
      worker === 1
        ? done.map((t, i) => [t.at, i + 1])
        : done.flatMap((t) => [
            [t.at, 1],
            [t.at + t.duration, 0],
          ]);
    return {
      worker,
      points: [...points, [tests.find((t) => t.worker === worker && t.running).at, worker === 1 ? 4 : 1]],
    };
  });
  const workers = [0, 1, 2].map((worker) => ({
    worker,
    cpuCores: Array.from({ length: 9 }, (_, i) => [
      (i + 1) * 5000,
      Math.round((0.6 + 0.3 * wave(i + worker) + (worker === 1 ? i * 0.12 : 0)) * 100) / 100,
    ]),
    memoryBytes: Array.from({ length: 9 }, (_, i) => [
      (i + 1) * 5000,
      Math.round((0.45 + (worker === 1 ? i * 0.11 : 0.02 * wave(i))) * 1024 ** 3),
    ]),
  }));
  await post(`/api/test-runs/${runId}/live-resources`, {
    data: {
      streamToken,
      shardIndex: null,
      reset: true,
      timeline: { startedAt: startTime, cpuPct, memoryBytes, pages, workers },
      memoryCapacityBytes: 16 * 1024 ** 3,
      memoryKind: 'pss',
    },
  });
  return runId;
}

/**
 * A cluster whose runs record their commits but no repository URL: a passing
 * run at one commit, then the hook failure at the next. Reported once per
 * session, so both widths of its scene show the same cluster in the same state.
 */
let noRepositoryCluster;

function reportNoRepositoryCluster(request, base) {
  noRepositoryCluster ??= (async () => {
    const scm = (commit, commitMessage) => ({
      scm: { commit, branch: 'main', author: 'Ada Lovelace', commitMessage },
    });
    const passedAt = Date.now() - 60 * 60_000;
    await ingestRun(request, base, {
      projectName: 'storefront-no-remote',
      metadata: scm('3f9c2e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e', 'feat: checkout with saved cards'),
      testCase: { ...HOOK_FAILURE_CASE, status: 'passed', duration: 1400, steps: [] },
      startTime: passedAt,
    });
    const failedAt = Date.now() - 5_000;
    const { runId } = await ingestRun(request, base, {
      projectName: 'storefront-no-remote',
      metadata: scm('b7e41d09c2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7', 'refactor(profile): rename the edit button'),
      testCase: hookFailureCase(failedAt),
      startTime: failedAt,
    });
    // The run's cluster is written when the run finishes; give it a moment.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
      const groups = await (await request.get(`${base}/api/test-runs/${runId}/failure-groups`)).json();
      const clusterId = groups.items?.[0]?.clusterId;
      if (clusterId) return clusterId;
    }
    throw new Error(`run ${runId} has no failure cluster`);
  })();
  return noRepositoryCluster;
}

/**
 * Two pushes of a branch with unit-test reports: the first uploads the back
 * end's and the front end's suites, the second the back end's only. Once the
 * second push's totals are stored, the first keeps only its totals and the
 * second carries the front end's suite from it. Reported once per session;
 * returns the project, both commits and the first push's run.
 */
let supersededBranch;

function reportSupersededBranch(request, base) {
  supersededBranch ??= (async () => {
    const post = (path, options) => postRetrying(request, base, path, options);
    const branch = 'feature/saved-cards';
    const first = '5ad1c0de9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b';
    const second = '7c3e9b1a2d4f6e8a0c2b4d6f8e0a2c4b6d8f0e2a';
    const blob = (path) => createHash('sha1').update(`branch-scene:${path}`).digest('hex');
    const files = {
      back: ['api/Cards/CardEndpoints.cs', 'api/Cards/CardStore.cs'],
      front: ['src/pages/cards/index.vue', 'src/components/CardForm.vue'],
    };
    const inventory = [...files.back, ...files.front, 'api/Cards/CardAudit.cs'].map((path) => [path, blob(path)]);
    const { runId } = await ingestRun(request, base, {
      projectName: 'shop-saved-cards',
      metadata: { scm: { commit: first, branch, author: 'Ada Lovelace', commitMessage: 'feat: save a card' } },
      testCase: { title: 'saves a card', location: 'tests/cards.spec.ts:4:5', status: 'passed', duration: 1200 },
      startTime: Date.now() - 10 * 60_000,
    });
    const run = await (await request.get(`${base}/api/test-runs/${runId}`)).json();
    const projectId = run.projectId;
    // The project's only runs are on the branch: name its default branch.
    await request.patch(`${base}/api/projects/${projectId}`, { data: { defaultBranch: 'main' } });
    const upload = (commit, suite, paths, lines) =>
      post(`/api/projects/${projectId}/coverage-reports`, {
        data: {
          v: 1,
          commit,
          branch,
          suite,
          inventory,
          files: paths.map((path) => ({ path, blob: blob(path), executable: [[1, 40]], lines })),
        },
      });
    await upload(first, 'unit-back', files.back, [[1, 24]]);
    await upload(first, 'unit-front', files.front, [[1, 18]]);
    // A report's time is kept to the second: the second push arrives later.
    await new Promise((r) => setTimeout(r, 1100));
    await upload(second, 'unit-back', files.back, [[1, 30]]);
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      const summary = await (
        await request.get(`${base}/api/projects/${projectId}/coverage-summary?commit=${first}`)
      ).json();
      if (summary.detailRemoved) return { projectId, branch, first, second, runId };
    }
    throw new Error(`${first} kept its coverage reports`);
  })();
  return supersededBranch;
}

/** Surfaces a scene can be captured against, in the order a run boots their servers. */
const MODES = ['web', 'tour', 'desktop', 'demo'];

/** Where the `demo` mode serves the built demo: off 3000 and 3050, where dev servers run. */
const DEMO_PORT = 4175;

/** Serves the built demo for the `demo` mode; its base is the demo's sub-path, which every scene route follows. */
async function startBuiltDemo() {
  if (!existsSync(join(BUILT_DEMO_ROOT, 'index.html'))) {
    throw new Error(
      `the demo mode serves the built demo, and ${BUILT_DEMO_ROOT} holds none: run "npm run app:generate:demo"`,
    );
  }
  const server = await serveBuiltDemo({ port: DEMO_PORT });
  const base = `http://localhost:${DEMO_PORT}${BUILT_DEMO_BASE.replace(/\/$/, '')}`;
  console.error(`Serving the built demo at ${base}/…`);
  return { base, stop: () => server.close() };
}

/** Cookie `@nuxtjs/color-mode` reads the stored light/dark preference from (`colorMode` in nuxt.config.ts). */
const COLOR_MODE_COOKIE = 'piwi-color-mode';

/** Stroke widths of the split seam, authored against a 1280px-wide capture. */
const SEAM_REFERENCE_WIDTH = 1280;
const SEAM_SHADOW_WIDTH = 4;
const SEAM_HIGHLIGHT_WIDTH = 1.5;

/**
 * Lay the dark capture over the light one, clipped to the triangle below the
 * top-right → bottom-left diagonal, and draw the seam along it. Both captures
 * must come from the same viewport and scroll position so they align exactly.
 */
async function compositeSplit(lightBuffer, darkBuffer) {
  const { width, height } = await sharp(lightBuffer).metadata();
  const scale = width / SEAM_REFERENCE_WIDTH;

  const clip = Buffer.from(
    `<svg width="${width}" height="${height}">` +
      `<polygon points="${width},0 ${width},${height} 0,${height}" fill="#fff"/>` +
      `</svg>`,
  );
  const darkTriangle = await sharp(darkBuffer)
    .ensureAlpha()
    .composite([{ input: clip, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const seam = Buffer.from(
    `<svg width="${width}" height="${height}">` +
      `<line x1="${width}" y1="0" x2="0" y2="${height}" stroke="rgba(0,0,0,0.35)" stroke-width="${SEAM_SHADOW_WIDTH * scale}"/>` +
      `<line x1="${width}" y1="0" x2="0" y2="${height}" stroke="rgba(255,255,255,0.85)" stroke-width="${SEAM_HIGHLIGHT_WIDTH * scale}"/>` +
      `</svg>`,
  );

  return sharp(lightBuffer)
    .composite([{ input: darkTriangle }, { input: seam }])
    .png()
    .toBuffer();
}

/** A scene's mode, defaulting to the web dashboard. */
function sceneMode(scene) {
  return scene.mode ?? 'web';
}

/**
 * Images in the docs screenshot directory that this harness does not produce,
 * so `--check` does not report them as orphans. Everything else in there must
 * have a scene.
 *
 *   - `demo-live-run-poster.png` is written by `record-demo-video.mjs`, with
 *     the video it stands in for;
 *   - `tested-elements-overlay.png` and the `picker-*.png` images are the
 *     browser extension's, written by its `tests/e2e/docs-screenshots.spec.ts`
 *     with `PIWI_DOCS_SHOTS=1`;
 *   - the `vscode-*.png` images are the VS Code extension's, written by
 *     `apps/vscode/scripts/take-screenshots.mjs`;
 *   - the `jetbrains-*.png` images are the JetBrains plugin's, written by
 *     `apps/jetbrains/scripts/take-screenshots.mjs`.
 */
const EXTERNAL_DOCS_IMAGES = new Set(['demo-live-run-poster.png', 'tested-elements-overlay.png']);
const EXTERNAL_DOCS_IMAGE_PREFIXES = ['picker-', 'vscode-', 'jetbrains-'];

/** The steps of the coupon report the repro-request scene shows. */
const REPRO_SCENE_STEPS = (() => {
  const origin = 'https://staging.shop.test';
  const byTestId = (id) => ({
    tagName: 'button',
    role: null,
    accessibleName: null,
    testId: id,
    text: null,
    alternatives: [{ locator: `getByTestId('${id}')`, method: 'getByTestId', score: 95 }],
  });
  const step = (action, extra) => ({
    action,
    target: null,
    value: null,
    redacted: false,
    pageUrl: `${origin}/cart`,
    timestamp: 1,
    ...extra,
  });
  return {
    v: 1,
    title: 'Coupon not applied to the total',
    origin,
    recordedAt: 1,
    note: null,
    steps: [
      step('goto', { value: `${origin}/cart` }),
      step('fill', {
        target: { ...byTestId('coupon'), tagName: 'input', role: 'textbox', accessibleName: 'Coupon' },
        value: 'SPRING10',
      }),
      step('click', { target: { ...byTestId('apply'), role: 'button', accessibleName: 'Apply' } }),
      step('assert', {
        target: { ...byTestId('cart-total'), tagName: 'p' },
        assertion: {
          matcher: 'toHaveText',
          expected: 'Total: 42',
          actual: 'Total: 40',
          negated: false,
          note: 'the coupon is ignored',
        },
      }),
    ],
  };
})();

/**
 * Scenes: one entry per user-facing feature (or state of it) worth showing.
 *
 * The common case is declarative — a route, an element to capture, done:
 *
 *   { name: 'locator-healing', tags: ['docs'], out: 'docs',
 *     route: '/test-run-cases/13',
 *     expand: ['[data-shot="alternative-locators"]'],
 *     of: '[data-shot="alternative-locators"]', pad: 12 }
 *
 * `run` takes over for anything irregular and calls `shoot(label?)` per capture.
 *
 * Context passed to `run`:
 *   page     — Playwright page, already at `route` with hydration settled
 *   base     — server origin, e.g. http://localhost:3050
 *   shoot    — (label?, opts?) => save `<file>[-<label>].png`; opts.of / opts.pad
 *              override the scene's, opts.clip / opts.fullPage / opts.mask pass
 *              through to Playwright
 *   goto     — (path) => navigate, wait for hydration, settle
 *   settle   — (opts?) => fonts loaded, network quiet, nothing still loading
 *   openTab  — (name, opts?) => click a tab and assert it actually opened
 *   expand   — (selector) => unfold a collapsible section, assert it unfolded
 *   annotate — (shapes) => draw the annotation overlay (see screenshot-annotations.mjs)
 *   clear    — () => remove the overlay, for a clean capture of the same page
 *
 * Scene options:
 *   description — one line, shown by --list
 *   mode        — 'web' (default), 'tour' or 'desktop'; picks the server the
 *                 scene runs against ('tour': the guided tour switched on), and
 *                 whether the mocked Tauri bridge is injected ('desktop')
 *   tags        — ['docs'] / ['desktop']; --tag selects on these
 *   out         — 'screens' (default) or 'docs'
 *   file        — output basename, default `<name>.png`
 *   outputs     — every file the scene writes; defaults to `file` plus the
 *                 `-annotated` variant when the scene annotates. --check reads it
 *   route       — initial path (default '/')
 *   prepare     — ({ base, request }) => put the server in the state the shot
 *                 needs, before the page loads; `request` is Playwright's API
 *                 client, so a scene can call an endpoint the UI does not
 *   viewport    — default 1280×860
 *   colorScheme — 'light' | 'dark'
 *   split       — capture the scene twice and composite a light/dark diagonal,
 *                 light above the top-right → bottom-left seam, dark below
 *   deviceScaleFactor — capture at N× (pair with `outputWidth` for crisp text)
 *   outputWidth — resize the written PNG to this width
 *   expand      — selectors of collapsible sections to unfold before capturing
 *   of          — selector (or array of them) to capture instead of the viewport
 *   pad         — padding in CSS px around `of`
 *   annotate    — annotation shapes; the scene then writes a `-annotated` image too
 *   charts      — wait for chart geometry to render before capturing
 *   link        — desktop mode: mocked linked folder for `desktop_get_project_link` (or null)
 *   inspection  — desktop mode: mocked `desktop_inspect_folder` answer (default READY_INSPECTION)
 *   importableRuns — desktop mode: archives `desktop_find_importable_runs` reports (default [])
 *   pickedFiles — desktop mode: archives the native import picker returns (default [])
 *   pickerHint  — show the hint to install Piwi Picker (`PickerInstallHint`); every
 *                 other scene captures as if Don't show again had been chosen,
 *                 so the hint never lands in an illustration by chance
 */
/**
 * Opens a cluster page's Diagnosis: it is the card under the situation block when
 * the next step comes from the diagnosis, and otherwise a folded section of More
 * ways to fix, which this unfolds.
 */
async function openDiagnosisSection(page) {
  const folded = page.locator('[data-shot="fix"] [data-shot="fix-diagnosis"] button[aria-expanded="false"]');
  if (await folded.count()) await folded.first().click();
  await page.locator('[data-shot="cluster-diagnosis"]').waitFor({ timeout: 90000 });
}

/** `run` for a scene of a cluster's Diagnosis: open it, then capture the scene's `of`. */
async function openClusterDiagnosis({ page, shoot, settle }) {
  await openDiagnosisSection(page);
  await settle();
  await shoot();
}

/**
 * `prepare` for a scene that needs a signed-in viewer, such as a project's
 * Members, which exist with authentication on only: signs in with
 * PIWI_SCREENS_LOGIN (`<username>:<password>`) through the context's request
 * client, whose cookies the page shares. Refuses with the way to run the scene
 * when the server has authentication off or no login is given.
 */
async function signInForScene({ base, request }) {
  const hint =
    'this scene needs a signed-in viewer: pass --url of a server with PIWI_AUTH_ENABLED=true and set PIWI_SCREENS_LOGIN=<username>:<password>';
  const login = process.env.PIWI_SCREENS_LOGIN ?? '';
  const separator = login.indexOf(':');
  if (separator < 1) throw new Error(hint);
  const res = await request.post(`${base}/api/auth/login`, {
    data: { username: login.slice(0, separator), password: login.slice(separator + 1) },
  });
  // With authentication off the server refuses any login.
  if (!res.ok()) throw new Error(`signing in as ${login.slice(0, separator)} failed (${res.status()}): ${hint}`);
}

/** Ticks the row checkboxes of the `count` newest runs in project 1's runs list that are not kept. */
async function selectNewestRuns(page, count) {
  const kept = await (await page.request.get(new URL('/api/projects/1/kept-runs', page.url()).href)).json();
  const keptIds = new Set((kept.items ?? []).map((r) => r.id));
  const boxes = page.locator('[data-shot="runs-table"] input[aria-label^="Select run #"]:visible');
  let ticked = 0;
  for (const box of await boxes.all()) {
    if (ticked === count) break;
    const id = Number((await box.getAttribute('aria-label'))?.replace('Select run #', ''));
    if (keptIds.has(id)) continue;
    await box.check();
    ticked++;
  }
}

/**
 * Selects project 1's three newest runs, deletes the selection and runs
 * `capture` while the second run is still being deleted. Every DELETE is
 * answered in the browser and none reaches the server: the second is held
 * until the capture is done, and the scene waits for the modal to close so no
 * request is left in flight when the context closes.
 */
async function captureRunsDeleteProgress(page, capture) {
  let deletes = 0;
  let releaseHeld = () => {};
  await page.route('**/api/test-runs/*', async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    deletes += 1;
    if (deletes === 2) await new Promise((resolve) => (releaseHeld = resolve));
    await route.fulfill({ json: { success: true } });
  });
  const dialog = page.getByRole('dialog');
  try {
    await selectNewestRuns(page, 3);
    await page.locator('[data-shot="runs-table"]').getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete 3 runs' }).click();
    await dialog.getByText('1 of 3 done', { exact: false }).waitFor();
    // The elapsed clock shows once a second has passed; a frozen clock never gets there.
    await dialog
      .getByText('running for', { exact: false })
      .waitFor({ timeout: 3000 })
      .catch(() => {});
    await capture();
  } finally {
    releaseHeld();
    await dialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  }
}

/**
 * Confirms the deletion of project 1 in its Delete modal, holds it mid-way and
 * runs `capture`: the progress poll answers with a deletion a third of the way
 * through its runs, and the DELETE request is held, then aborted before the
 * scene ends — a request still held when the context closes reaches the server.
 * Waits on the rendered steps, not on `settle()`, which the held request would
 * never let finish.
 */
async function captureProjectDeleteProgress(page, capture) {
  let abortHeld = async () => {};
  await page.route('**/api/projects/1', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    return new Promise((resolve) => {
      abortHeld = () => route.abort().then(resolve);
    });
  });
  await page.route('**/api/projects/1/deletion', (route) =>
    route.fulfill({ json: { progress: { phase: 'runs', totalRuns: 1280, runsDeleted: 412 } } }),
  );
  try {
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog');
    const input = dialog.getByRole('textbox');
    await input.fill((await input.getAttribute('placeholder')) ?? '');
    await dialog.getByRole('button', { name: 'Delete project' }).click();
    await dialog.getByText('412 of 1,280 deleted').waitFor();
    // The elapsed clock reads "Starting…" for its first second; a frozen clock keeps it there.
    await dialog
      .getByText('Running for', { exact: false })
      .waitFor({ timeout: 3000 })
      .catch(() => {});
    await capture();
  } finally {
    await abortHeld();
  }
}

/**
 * Classifies project 1's flaky tests from their recorded failures, so every row
 * shows the root cause the classifier derives rather than the seeded label.
 */
async function classifyFlakyTests({ base, request }) {
  const flaky = await (await request.get(`${base}/api/projects/1/flaky-tests`)).json();
  for (const test of flaky.items ?? []) {
    await request.post(`${base}/api/projects/1/flaky-classify`, { data: { testCaseId: test.testCaseId } });
  }
}

/** An agent's diagnosis and two fix attempts on cluster 2, once per server. */
async function prepareClusterActivity({ base, request }) {
  const activity = await (await request.get(`${base}/api/failure-clusters/2/activity`)).json();
  if (activity.items?.length) return;
  await request.post(`${base}/api/failure-clusters/2/agent-diagnosis`, {
    data: {
      model: 'claude-opus-5-5',
      diagnosis: {
        summary: 'The checkout total is computed before the coupon applies',
        confidenceScore: 78,
        severity: 'high',
        affectedArea: 'checkout',
        hypotheses: [
          {
            category: 'app-bug',
            rootCause: 'applyCoupon() runs after computeTotal(), so the total shown is the pre-discount one',
            likelihood: 78,
            evidence: ['expected 90.00, received 100.00'],
          },
        ],
        suggestedFix: {
          description: 'Compute the total once the coupon resolves',
          file: 'src/checkout.ts',
          code: null,
          patch: null,
        },
        investigationSteps: [],
        preventionTips: [],
      },
    },
  });
  await request.post(`${base}/api/failure-clusters/2/fix-attempts`, {
    data: { kind: 'patch', commit: '4f2a9c1', channel: 'editor' },
  });
  await request.post(`${base}/api/failure-clusters/2/fix-attempts`, {
    data: {
      kind: 'locator-edit',
      branch: 'fix/checkout',
      edit: { filePath: 'tests/checkout.spec.ts', line: 42, from: '#pay', to: "getByRole('button', { name: 'Pay' })" },
    },
  });
}

/** A global email channel, a weekly schedule on it and one *Run now*, once per server. */
async function prepareReportSchedule({ base, request }) {
  const schedules = await (await request.get(`${base}/api/reports/schedules`)).json();
  if (schedules.items?.length) return;
  const channels = await (await request.get(`${base}/api/channels`)).json();
  let channel = channels.items?.find((c) => c.type === 'email');
  if (!channel) {
    const created = await request.post(`${base}/api/channels`, {
      data: { name: 'Team mail', type: 'email', config: { address: 'team@example.com' } },
    });
    channel = (await created.json()).channel;
  }
  const schedule = await (
    await request.post(`${base}/api/reports/schedules`, {
      data: {
        name: 'Weekly executive report',
        dashboard: 'executive',
        cadence: 'weekly',
        anchor: 1,
        at: '08:00',
        channelIds: [channel.id],
      },
    })
  ).json();
  await request.post(`${base}/api/reports/schedules/${schedule.id}/run`);
}

/**
 * A Bug type's create screen as the fields endpoint returns it: Severity and a
 * Team are required, Found in is required with a Jira default, Components and
 * Fix versions are optional, Priority has a Jira default.
 */
const JIRA_SCREEN_FIELDS = [
  {
    id: 'parent',
    name: 'Parent',
    required: false,
    hasDefault: false,
    kind: 'issue',
    options: null,
    typeName: 'parent',
  },
  {
    id: 'customfield_10050',
    name: 'Severity',
    required: true,
    hasDefault: false,
    kind: 'option',
    options: [
      { id: '10100', label: 'Critical' },
      { id: '10101', label: 'Major' },
      { id: '10102', label: 'Minor' },
    ],
    typeName: 'select',
  },
  {
    id: 'customfield_10001',
    name: 'Team',
    required: true,
    hasDefault: false,
    kind: 'raw',
    options: null,
    typeName: 'atlassian-team',
  },
  {
    id: 'customfield_10080',
    name: 'Found in',
    required: true,
    hasDefault: true,
    kind: 'option',
    options: [
      { id: '10400', label: 'Production' },
      { id: '10401', label: 'Staging' },
    ],
    typeName: 'select',
  },
  {
    id: 'components',
    name: 'Components',
    required: false,
    hasDefault: false,
    kind: 'option-array',
    options: [
      { id: '10200', label: 'Checkout' },
      { id: '10201', label: 'Payments' },
    ],
    typeName: 'components',
  },
  {
    id: 'fixVersions',
    name: 'Fix versions',
    required: false,
    hasDefault: false,
    kind: 'option-array',
    options: [{ id: '10300', label: '2.5.0' }],
    typeName: 'fixVersions',
  },
  {
    id: 'priority',
    name: 'Priority',
    required: false,
    hasDefault: true,
    kind: 'option',
    options: [{ id: '3', label: 'Medium' }],
    typeName: 'priority',
  },
];

/** An open sample issue's transitions: Resolve leads to Done through a screen requiring a Resolution. */
const JIRA_OPEN_SAMPLE = {
  issue: { key: 'CHK-128', status: 'To Do' },
  transitions: [
    { id: '21', name: 'Start progress', toStatus: 'In Progress', toStatusCategory: 'indeterminate', fields: [] },
    {
      id: '31',
      name: 'Resolve',
      toStatus: 'Done',
      toStatusCategory: 'done',
      fields: [
        {
          id: 'resolution',
          name: 'Resolution',
          required: true,
          hasDefault: false,
          kind: 'option',
          options: [
            { id: '1', label: 'Fixed' },
            { id: '2', label: "Won't fix" },
            { id: '3', label: 'Duplicate' },
          ],
          typeName: 'resolution',
        },
        {
          id: 'fixVersions',
          name: 'Fix versions',
          required: false,
          hasDefault: false,
          kind: 'option-array',
          options: [{ id: '10300', label: '2.5.0' }],
          typeName: 'fixVersions',
        },
      ],
    },
  ],
};

/** A done sample issue's transitions: Reopen has no screen. */
const JIRA_DONE_SAMPLE = {
  issue: { key: 'CHK-97', status: 'Done' },
  transitions: [{ id: '11', name: 'Reopen', toStatus: 'To Do', toStatusCategory: 'new', fields: [] }],
};

/** The project defaults the required-fields scenes show: a Severity and a component. */
const JIRA_FIELD_DEFAULTS = {
  customfield_10050: { value: { id: '10101' }, label: 'Major' },
  components: { value: [{ id: '10200' }], label: 'Checkout' },
};

/**
 * One Slack channel subscribed to project 1, so the notifications settings
 * capture neither section empty. Reruns reuse the rows from the previous run
 * instead of duplicating them.
 */
async function prepareTeamSlackChannel({ base, request }) {
  const list = await (await request.get(`${base}/api/channels`)).json();
  if (list.items.some((c) => c.name === 'Team Slack')) return;
  const ch = await (
    await request.post(`${base}/api/channels`, {
      data: { name: 'Team Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' } },
    })
  ).json();
  await request.post(`${base}/api/subscriptions`, {
    data: { channelId: ch.channel.id, projectId: 1, events: ['run.failed', 'cluster.new'] },
  });
}

/** The db-managed connection the required-fields scenes bind; its dead port means no Jira is contacted. */
let jiraSceneConnectionId = 0;

async function prepareJiraSceneConnection({ base, request }) {
  const list = await (await request.get(`${base}/api/integrations/connections`)).json();
  const existing = list.connections?.find((c) => c.provider === 'jira' && c.managedBy === 'db' && c.name === 'Jira');
  if (existing) {
    jiraSceneConnectionId = existing.id;
    return;
  }
  const created = await request.post(`${base}/api/integrations/connections`, {
    data: {
      provider: 'jira',
      name: 'Jira',
      baseUrl: 'http://127.0.0.1:9',
      credentials: { email: 'you@example.com', apiToken: 'screenshot-token' },
    },
  });
  jiraSceneConnectionId = (await created.json()).connection.id;
}

/** The scene Jira connection, and PROJ-131 linked to cluster 1 when it is missing, so the cluster is tracked. */
async function prepareClusterOneTracked({ base, request }) {
  await prepareJiraSceneConnection({ base, request });
  const links = await (await request.get(`${base}/api/links?entityType=failure_cluster&entityId=1`)).json();
  if (links.items?.some((l) => l.key === 'PROJ-131')) return;
  await request.post(`${base}/api/links`, {
    data: {
      entityType: 'failure_cluster',
      entityId: 1,
      url: 'http://127.0.0.1:9/browse/PROJ-131',
      title: 'Pay button click times out',
    },
  });
}

/**
 * Answers the Jira pickers and the create screen in the page, so a scene shows
 * the required-fields UI for project CHK and its Bug type without a Jira.
 */
/** Jira-like icons for the scenes' fake site, by the path the pickers name them with. */
const JIRA_SCENE_ICONS = {
  '/icons/bug': '<rect width="16" height="16" rx="3" fill="#e5493a"/><circle cx="8" cy="8" r="3.5" fill="#fff"/>',
  '/icons/task':
    '<rect width="16" height="16" rx="3" fill="#4bade8"/><path d="M4.5 8.2l2.3 2.3 4.7-5" stroke="#fff" stroke-width="2" fill="none"/>',
  '/icons/epic':
    '<rect width="16" height="16" rx="3" fill="#904ee2"/><path d="M9.5 3L5 9h3l-1.5 4L11 7H8z" fill="#fff"/>',
  '/icons/person':
    '<circle cx="8" cy="8" r="8" fill="#ff8b00"/><circle cx="8" cy="6.2" r="2.6" fill="#fff"/><path d="M3.5 13.5a4.5 4.5 0 019 0z" fill="#fff"/>',
  '/icons/project':
    '<rect width="16" height="16" rx="3" fill="#36b37e"/><path d="M4 11l3-6 2 4 1.5-2L12 11z" fill="#fff"/>',
};
const jiraSceneIcon = (name) => `/rest/api/3/universal_avatar/view/type/scene/avatar/${name}`;

async function routeJiraScreen(page) {
  await page.route('**/api/integrations/connections/*/icon*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    const name = Object.keys(JIRA_SCENE_ICONS).find((key) => path.endsWith(key.slice('/icons/'.length)));
    if (!name) return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${JIRA_SCENE_ICONS[name]}</svg>`,
    });
  });
  await page.route('**/api/integrations/connections/*/projects', (route) =>
    route.fulfill({ json: { projects: [{ id: '1', key: 'CHK', name: 'Checkout', icon: jiraSceneIcon('project') }] } }),
  );
  await page.route('**/api/integrations/connections/*/projects/*/issue-types', (route) =>
    route.fulfill({
      json: {
        issueTypes: [
          { id: '10004', name: 'Bug', icon: jiraSceneIcon('bug') },
          { id: '10006', name: 'Task', icon: jiraSceneIcon('task') },
        ],
      },
    }),
  );
  await page.route('**/api/integrations/connections/*/projects/*/issue-types/*/fields', (route) =>
    route.fulfill({ json: { fields: JIRA_SCREEN_FIELDS } }),
  );
  await page.route('**/api/integrations/connections/*/assignable*', (route) =>
    route.fulfill({ json: { users: [{ id: 'acct-1', displayName: 'Dana Reyes', icon: jiraSceneIcon('person') }] } }),
  );
  await page.route('**/api/integrations/connections/*/issue-picker*', (route) =>
    route.fulfill({
      json: {
        issues: [
          { key: 'CHK-12', summary: 'Checkout reliability', icon: jiraSceneIcon('epic') },
          { key: 'CHK-31', summary: 'Checkout payment providers', icon: jiraSceneIcon('epic') },
        ],
      },
    }),
  );
}

// The evidence-footer scene seeds its own fixtures-free project; `prepare`
// records the execution id it submits so `run` can open that page.
let footerExecId = 0;

// The run-changes-fallback scenes share one project that never passed: an
// interrupted run, then two failed runs. Seeded once per server.
let neverGreenRuns = null;
async function prepareNeverGreenRuns({ base, request }) {
  if (neverGreenRuns) return;
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const testCase = (title, status, line, duration) => ({
    title,
    status,
    duration,
    location: `tests/checkout.spec.ts:${line}:3`,
    retries: 0,
    ...(status === 'failed' ? { error: 'Error: expect(locator).toBeVisible() failed' } : {}),
  });
  const submit = async (status, minutes, branch, environment, cases) => {
    const failed = cases.filter((c) => c.status === 'failed').length;
    const res = await request.post(`${base}/api/test-runs/submit`, {
      data: {
        projectName: 'checkout-never-green',
        status,
        startTime: minutesAgo(minutes),
        duration: 42_000,
        totalTests: cases.length,
        passedTests: cases.length - failed,
        failedTests: failed,
        skippedTests: 0,
        environment,
        metadata: { scm: { branch } },
        testCases: cases,
      },
    });
    return (await res.json()).runId;
  };
  const interrupted = await submit('interrupted', 600, 'main', 'staging', [
    testCase('cart keeps items', 'passed', 8, 900),
  ]);
  const firstFailed = await submit('failed', 300, 'main', 'staging', [
    testCase('cart keeps items', 'passed', 8, 900),
    testCase('coupon applies discount', 'failed', 21, 3200),
    testCase('guest checkout', 'passed', 34, 2100),
  ]);
  const latest = await submit('failed', 30, 'feature/coupons', 'staging', [
    testCase('cart keeps items', 'failed', 8, 5400),
    testCase('coupon applies discount', 'passed', 21, 2900),
    testCase('guest checkout', 'passed', 34, 2600),
  ]);
  neverGreenRuns = { interrupted, firstFailed, latest };
}

/** The project a costly flaky test makes a quarantine candidate in, once per server. */
let quarantineProposalsProjectId = null;
async function prepareQuarantineProposals({ base, request }) {
  if (quarantineProposalsProjectId) return;
  const projects = await (await request.get(`${base}/api/projects`)).json();
  const existing = (projects.items ?? projects).find((p) => p.name === 'quarantine-proposals');
  if (existing) {
    quarantineProposalsProjectId = existing.id;
    return;
  }
  // Six runs: the card payment times out then passes on retry in each one (a costly flake, so a candidate);
  // the coupon test flakes on half of them in 50 ms (cheap, so not proposed).
  for (let i = 0; i < 6; i++) {
    const testCases = [
      {
        title: 'pays with a saved card',
        status: 'failed',
        duration: 95_000,
        retries: 0,
        location: 'tests/checkout.spec.ts:12:3',
        error: 'TimeoutError: locator.click: Timeout 90000ms exceeded.',
      },
      {
        title: 'pays with a saved card',
        status: 'passed',
        duration: 4200,
        retries: 1,
        location: 'tests/checkout.spec.ts:12:3',
      },
      {
        title: 'applies a coupon',
        status: 'passed',
        duration: 900,
        retries: 0,
        location: 'tests/checkout.spec.ts:30:3',
      },
    ];
    if (i % 2 === 0) {
      testCases.push({
        title: 'applies a coupon',
        status: 'failed',
        duration: 50,
        retries: 1,
        location: 'tests/checkout.spec.ts:30:3',
        error: 'Error: expect(locator).toHaveText() failed',
      });
    }
    const res = await request.post(`${base}/api/test-runs/submit`, {
      data: {
        projectName: 'quarantine-proposals',
        status: 'passed',
        startTime: new Date(Date.now() - (6 - i) * 3_600_000).toISOString(),
        duration: 120_000,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        testCases,
      },
    });
    quarantineProposalsProjectId = (await res.json()).projectId;
  }
}

/**
 * The Dismiss action on both quarantine proposals: a candidate in the flaky
 * list with its reason popover open, then project 3's proposed release in the
 * quarantine view. Opens the popover without submitting, so the scene repeats.
 */
function screenshotLightboxScene(width, suffix) {
  return {
    name: `screenshot-lightbox${suffix}`,
    description: `An enlarged failure screenshot beside its details — the test, the failing step and the error raised on the page — at ${width} px`,
    tags: ['desktop'],
    route: '/test-run-cases/37',
    viewport: { width, height: width < 640 ? 844 : 900 },
    async run({ page, settle, shoot }) {
      const enlarge = page.getByRole('button', { name: 'Enlarge At the failure' }).first();
      await enlarge.waitFor({ timeout: 60_000 });
      await settle();
      await enlarge.click();
      await page.getByRole('complementary', { name: 'Screenshot details' }).waitFor();
      await settle();
      await shoot();
    },
  };
}

function markersPanelScene(width, suffix) {
  return {
    name: `markers-panel${suffix}`,
    description: `The timeline markers panel: the markers as a vertical list, then the edit form in place, at ${width} px`,
    tags: ['desktop'],
    route: '/projects/1',
    viewport: { width, height: 1000 },
    async run({ page, settle, shoot }) {
      const open = page.getByRole('button', { name: /Markers \(/ });
      await open.waitFor({ timeout: 60_000 });
      await settle();
      await open.click();
      await page.locator('[data-shot="markers-panel"]').waitFor();
      await settle();
      await shoot('list');
      await page.getByRole('button', { name: 'Edit Enabled strict CSP in production' }).click();
      await page.getByTestId('marker-form').waitFor();
      await settle();
      await shoot('form');
    },
  };
}

/** The connect wizard on Setup: each of its three paths, then local runs sent to the desktop app. */
function setupConnectScene(width, suffix) {
  return {
    name: `setup-connect${suffix}`,
    description: `Connect wizard on Setup: one command, a coding agent, by hand, and the desktop-app switch, at ${width} px`,
    tags: ['desktop'],
    route: '/setup',
    viewport: { width, height: 2400 },
    async run({ page, settle, shoot }) {
      const wizard = '[data-shot="get-started-wizard"]';
      await page.locator(wizard).waitFor({ timeout: 60_000 });
      await page.getByRole('textbox', { name: 'Project name' }).fill('checkout');
      await settle();
      await shoot('command', { of: wizard, pad: 12 });
      await page.getByRole('button', { name: 'Coding agent' }).click();
      await settle();
      await shoot('agent', { of: wizard, pad: 12 });
      await page.getByRole('button', { name: 'By hand' }).click();
      await settle();
      await shoot('manual', { of: wizard, pad: 12 });
      await page.getByRole('button', { name: 'One command' }).click();
      await page.getByRole('switch', { name: 'Local runs go to the desktop app' }).click();
      await settle();
      await shoot('prefer-desktop', { of: wizard, pad: 12 });
    },
  };
}

/** The seed's run from the editor whose one test stood paused at two breakpoints, and that test's execution. */
const PAUSED_SCENE_RUN = 74;
const PAUSED_SCENE_EXECUTION = 833;

/**
 * A test that stood paused at editor breakpoints: its Timeline tab, with a Paused band over the lanes for each stop,
 * the steps the stops held and a request the page made during one, then its run's workers timeline with the stops on
 * the test's bar, at `width` px in `colorScheme`.
 */
function pausedTestScene(width, colorScheme, suffix) {
  const name = `paused-test${suffix}`;
  return {
    name,
    description: `A test paused at two editor breakpoints: its Timeline tab with the Paused bands, then its run's workers timeline, at ${width} px (${colorScheme})`,
    route: `/test-run-cases/${PAUSED_SCENE_EXECUTION}`,
    viewport: { width, height: width < 640 ? 2600 : 1500 },
    colorScheme,
    outputs: [`${name}.png`, `${name}-workers.png`],
    async run({ page, goto, openTab, settle, shoot }) {
      await openTab('Timeline');
      await page.locator('[data-shot="evidence-card"] [data-timeline-paused]').first().waitFor({ timeout: 30_000 });
      await settle();
      await shoot(undefined, { of: '[data-shot="evidence-card"]', pad: 12 });
      await goto(`/test-runs/${PAUSED_SCENE_RUN}?tab=workers`);
      await page.locator('[data-shot="run-timeline"] [data-timeline-paused]').first().waitFor({ timeout: 30_000 });
      await settle();
      await shoot('workers', { of: '[data-shot="run-timeline"]', pad: 12 });
    },
  };
}

function quarantineDismissScene(width, suffix) {
  return {
    name: `quarantine-dismiss${suffix}`,
    description: `Dismiss on a quarantine candidate (flaky list) and on a proposed release (quarantine view), at ${width} px`,
    tags: ['desktop'],
    route: '/',
    viewport: { width, height: 1000 },
    prepare: prepareQuarantineProposals,
    async run({ page, goto, settle, shoot }) {
      await goto(`/projects/${quarantineProposalsProjectId}?tab=flaky-tests`);
      await page.locator('[data-testid="flaky-quarantine-proposed"]').first().waitFor({ timeout: 60_000 });
      await settle();
      await shoot('candidate', { of: '[data-shot="flaky-table"]', pad: 12 });
      await page.locator('[data-shot="flaky-table"] [data-testid="quarantine-dismiss"]').first().click();
      const reason = page.getByPlaceholder('e.g. the fix is in review');
      await reason.waitFor();
      await reason.fill('Card sandbox times out, payments team on it');
      await settle();
      await shoot('popover');
      await page.keyboard.press('Escape');
      await goto('/projects/3?tab=quarantine');
      await page
        .locator('[data-shot="quarantine-table"] [data-testid="quarantine-dismiss"]')
        .first()
        .waitFor({ timeout: 60_000 });
      await settle();
      await shoot('release', { of: '[data-shot="quarantine-table"]', pad: 12 });
    },
    outputs: [
      `quarantine-dismiss${suffix}-candidate.png`,
      `quarantine-dismiss${suffix}-popover.png`,
      `quarantine-dismiss${suffix}-release.png`,
    ],
  };
}

/**
 * Waits for the guided tour's prompt, which a first visit gets by itself on a
 * `tour` server (a scene's browser context starts with nothing stored), and for
 * it to finish sliding in.
 */
async function waitForTourPrompt(page) {
  const prompt = page.getByTestId('tour-prompt');
  await prompt.waitFor({ state: 'visible', timeout: 30_000 });
  await prompt.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished)));
}

/**
 * Starts a role's tour from the prompt, in `language` when given (its name in
 * the prompt's select, `Français`), and waits for the first stop to settle: the
 * popover rendered and the cutout on the stop's anchor. A stop whose anchor is
 * missing settles centered, with an empty `data-guide-anchor`.
 */
async function startTourFromPrompt(page, { profile, language }) {
  await waitForTourPrompt(page);
  if (language) {
    await page.getByTestId('tour-language').click();
    await page.getByRole('option', { name: language }).click();
  }
  await page.getByTestId(`tour-profile-${profile}`).click();
  const popover = page.locator('.driver-popover.piwi-guide[data-guide-settled]');
  await popover.waitFor({ timeout: 60_000 });
  const anchor = await popover.getAttribute('data-guide-anchor');
  if (anchor) await page.locator(`[data-tour="${anchor}"].driver-active-element`).waitFor();
}

/**
 * Walks the running tour with Next, calling `atStop` on each stop once it has
 * settled (its id, its anchor, empty for a stop shown centered), and ends the
 * tour on its last stop.
 */
async function walkTourStops(page, atStop) {
  let last = null;
  for (;;) {
    const popover = page.locator(
      `.driver-popover.piwi-guide[data-guide-settled]${last ? `:not([data-guide-stop="${last}"])` : ''}`,
    );
    await popover.waitFor({ timeout: 60_000 });
    const stop = await popover.evaluate((node) => ({
      id: node.dataset.guideStop,
      anchor: node.dataset.guideAnchor,
      isLast: Boolean(node.querySelector('.driver-popover-done-btn')),
    }));
    if (stop.anchor) await page.locator(`[data-tour="${stop.anchor}"].driver-active-element`).waitFor();
    await atStop(stop);
    if (stop.isLast) break;
    last = stop.id;
    await popover.locator('.driver-popover-next-btn').click();
  }
  await page.keyboard.press('Escape');
}

/** A fixed assistant answer holding one block of each kind, shared with `tests/assistant-panel.spec.ts`. */
const ASSISTANT_ANSWER = join(APP_DIR, 'tests', 'fixtures', 'assistant-answer.json');

/**
 * Answers the assistant's routes in the browser, so a scene shows the panel
 * whatever AI the server has: the status names a model, a question starts a
 * conversation, and asking streams the fixture's answer. Reloads `path`, since
 * the sidebar reads the status as the page mounts.
 */
async function openAssistantAnswer(page, goto, path = '/') {
  const fixture = JSON.parse(readFileSync(ASSISTANT_ANSWER, 'utf8'));
  const frames = fixture.answer.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  await page.route('**/api/assistant/**', (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname.endsWith('/assistant/status')) return route.fulfill({ json: fixture.status });
    if (pathname.endsWith('/assistant/conversations')) {
      return request.method() === 'POST'
        ? route.fulfill({ status: 201, json: fixture.conversation })
        : route.fulfill({ json: { items: [fixture.conversation] } });
    }
    if (pathname.endsWith('/messages')) {
      return route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: frames });
    }
    if (pathname.endsWith('/proposal')) {
      const { blockId, status } = request.postDataJSON();
      const block = fixture.answer.find((e) => e.event === 'block' && e.data.block.id === blockId)?.data.block;
      return route.fulfill({ json: { block: { ...block, outcome: { status, at: new Date().toISOString() } } } });
    }
    return route.fallback();
  });
  // The fixture's proposal resolves cluster 3, which the scene's server need not hold: its route answers here.
  await page.route('**/api/failure-clusters/3/status', (route) =>
    route.fulfill({ json: { id: 3, status: 'resolved' } }),
  );
  await goto(path);
  const launcher = page.getByRole('button', { name: 'Ask Piwi' });
  if (!(await launcher.isVisible())) await page.getByRole('button', { name: 'Open sidebar' }).first().click();
  await launcher.click();
  const panel = page.locator('[data-shot="assistant-panel"]');
  await panel.getByLabel('Your question').fill(fixture.question);
  await panel.getByLabel('Your question').press('Enter');
  await panel.locator('[data-assistant-read]').waitFor({ timeout: 30_000 });
  return panel;
}

// The nudges scene submits a timed-out failure in a project without capture
// fixtures; `prepareNudgeFailure` records its execution id.
let nudgeExecId = 0;
async function prepareNudgeFailure({ base, request }) {
  const projectName = 'nudge-demo-timeout';
  await request.post(`${base}/api/test-runs/submit`, {
    data: {
      projectName,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 31000,
      totalTests: 1,
      passedTests: 0,
      failedTests: 0,
      timedOutTests: 1,
      skippedTests: 0,
      testCases: [
        {
          title: 'checkout waits for the payment provider',
          status: 'timedOut',
          duration: 30000,
          location: 'tests/checkout.spec.ts:12:3',
          error: 'Test timeout of 30000ms exceeded.',
        },
      ],
    },
  });
  const { items } = await (await request.get(`${base}/api/projects`)).json();
  const project = items.find((p) => p.name === projectName);
  const detail = await (await request.get(`${base}/api/projects/${project.id}`)).json();
  const run = await (await request.get(`${base}/api/test-runs/${detail.testRuns[0].id}`)).json();
  nudgeExecId = run.testCases[0].executionId;
}

/**
 * Answers the nudges scene's reads in the browser: the assistant's status names
 * a model, so the Setup nudge's question can be asked, and the diagnosis context
 * of a cluster with a completed diagnosis reads no commits for want of an SCM
 * token, as on an instance with none set.
 */
async function routeNudgeScene(page, clusterId) {
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: { available: true, reason: null, provider: 'anthropic', model: 'claude-sonnet-4-5', toolMode: 'native' },
    }),
  );
  await page.route(`**/api/failure-clusters/${clusterId}/context**`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.scmChanges = null;
    json.coverage = {
      ...json.coverage,
      scm: {
        hasLastGreen: true,
        hasCommitRange: true,
        baseCommitUsed: null,
        provider: 'github',
        commitsCount: 0,
        filesCount: 0,
        patchedFilesCount: 0,
        patchesOmitted: false,
        patchesTruncated: false,
        baselineKind: 'run-green',
        repositoryUrl: 'https://github.com/acme/shop',
        range: { from: 'a1b2c3d', to: 'e4f5a6b' },
        compareUrl: 'https://github.com/acme/shop/compare/a1b2c3d...e4f5a6b',
        gitCommand: 'git log --oneline a1b2c3d..e4f5a6b',
        error: null,
        hasToken: false,
      },
    };
    await route.fulfill({ response, json });
  });
}

const SCENES = [
  // ── Report artifacts (gitignored `.screens/`) ─────────────────────────────
  {
    name: 'sidebar-latest-run',
    description:
      "The sidebar's project status badges: one hovered (its title names the latest run it opens), then that run after a click",
    route: '/',
    viewport: { width: 1280, height: 900 },
    async run({ page, shoot, settle }) {
      const badge = page.locator('[data-shot="sidebar-latest-run"]').first();
      await badge.waitFor({ timeout: 60000 });
      await settle();
      await badge.hover();
      await shoot('hover');
      await badge.click();
      await page.waitForURL(/\/test-runs\/\d+/, { timeout: 60000 });
      await settle();
      await shoot('run');
    },
    outputs: ['sidebar-latest-run-hover.png', 'sidebar-latest-run-run.png'],
  },
  {
    name: 'page-not-found',
    description: 'The error page a link to a run that does not exist opens, inside the dashboard, wide then narrow',
    route: '/test-runs/2000000000',
    viewport: { width: 1280, height: 800 },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="error-page"]').waitFor({ timeout: 60000 });
      await settle();
      await shoot('wide');
      await page.setViewportSize({ width: 390, height: 800 });
      await settle();
      await shoot('narrow');
    },
    outputs: ['page-not-found-wide.png', 'page-not-found-narrow.png'],
  },
  {
    name: 'assistant-panel',
    description:
      'The assistant panel on an answer holding every kind of block (a fixed answer streamed into it): beside the page, whole at 1280 and 390 px, and the command palette offering Ask Piwi',
    route: '/',
    viewport: { width: 1280, height: 860 },
    async run({ page, shoot, settle, goto }) {
      const panel = await openAssistantAnswer(page, goto);
      await settle();
      await shoot('wide');
      // Tall enough for the whole answer, so one image shows every block.
      const tall = async (width) => {
        await page.setViewportSize({ width, height: 860 });
        const content = await panel.locator('[data-assistant-panel]').evaluate((node) => node.scrollHeight);
        await page.setViewportSize({ width, height: content + 260 });
        await panel.locator('[data-assistant-panel]').evaluate((node) => node.scrollTo({ top: 0 }));
        await settle();
      };
      await tall(1280);
      await shoot('blocks', { of: '[data-shot="assistant-panel"]' });
      await tall(390);
      await shoot('phone', { of: '[data-shot="assistant-panel"]' });
      await page.setViewportSize({ width: 1280, height: 860 });
      await panel.getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: /^Search…/ }).click();
      await page.getByPlaceholder('Type a command or search…').fill('Why does the cart test keep failing?');
      await page.getByRole('option', { name: /Ask Piwi/ }).waitFor();
      await settle();
      await shoot('palette');
    },
    outputs: [
      'assistant-panel-wide.png',
      'assistant-panel-blocks.png',
      'assistant-panel-phone.png',
      'assistant-panel-palette.png',
    ],
  },
  {
    name: 'assistant-demo',
    mode: 'demo',
    description:
      'The live demo’s assistant answering a prepared question with blocks computed from the seed (why a checkout test failed: the situation, the clues, the cluster, the diagnosed patch, the reproduce command and the ways to fix it): beside the page at 1280 px, and whole at 1280 and 390 px',
    route: '/test-run-cases/37',
    viewport: { width: 1280, height: 860 },
    async run({ page, shoot, settle }) {
      // The demo's guided tour asks a first-time visitor their role; this scene is about the panel.
      await page.evaluate(() =>
        localStorage.setItem('piwi-demo-tour', JSON.stringify({ decision: 'dismissed', decidedAt: Date.now() })),
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('[data-tour="situation"]').waitFor({ timeout: 90_000 });
      const launcher = page.getByRole('button', { name: 'Ask Piwi' });
      await launcher.click();
      const panel = page.locator('[data-shot="assistant-panel"]');
      await panel.locator('[data-assistant-empty]').getByRole('button', { name: 'Why did this test fail?' }).click();
      await panel.locator('[data-assistant-read]').waitFor({ timeout: 60_000 });
      await settle();
      await shoot('wide');
      // Tall enough for the whole answer, so one image shows every block: grown until the panel scrolls no more.
      const scroller = panel.locator('[data-assistant-panel]');
      const tall = async (width) => {
        await page.setViewportSize({ width, height: 860 });
        for (let attempt = 0; attempt < 5; attempt++) {
          const hidden = await scroller.evaluate((node) => node.scrollHeight - node.clientHeight);
          if (hidden <= 0) break;
          await page.setViewportSize({ width, height: page.viewportSize().height + hidden + 40 });
        }
        await scroller.evaluate((node) => node.scrollTo({ top: 0 }));
        await settle();
      };
      await tall(1280);
      await shoot('blocks', { of: '[data-shot="assistant-panel"]' });
      await tall(390);
      await shoot('phone', { of: '[data-shot="assistant-panel"]' });
    },
    outputs: ['assistant-demo-wide.png', 'assistant-demo-blocks.png', 'assistant-demo-phone.png'],
  },
  {
    name: 'assistant-proposal',
    description:
      'A change the assistant proposes, in the panel on the fixed answer: the card with Apply and Dismiss, then the same card applied, at 1280 and 390 px',
    route: '/',
    viewport: { width: 1280, height: 860 },
    async run({ page, shoot, settle, goto }) {
      const panel = await openAssistantAnswer(page, goto);
      const card = panel.locator('[data-assistant-block="proposal"]');
      const showCard = async (width) => {
        await page.setViewportSize({ width, height: 860 });
        await card.evaluate((node) => node.scrollIntoView({ block: 'center' }));
        await settle();
      };
      await showCard(1280);
      await shoot('wide', { of: '[data-shot="assistant-panel"]' });
      await showCard(390);
      await shoot('phone', { of: '[data-shot="assistant-panel"]' });
      await card.getByRole('button', { name: 'Apply', exact: true }).click();
      await card.getByText('Applied').waitFor();
      await showCard(390);
      await shoot('phone-applied', { of: '[data-shot="assistant-panel"]' });
      await showCard(1280);
      await shoot('wide-applied', { of: '[data-shot="assistant-panel"]' });
    },
    outputs: [
      'assistant-proposal-wide.png',
      'assistant-proposal-phone.png',
      'assistant-proposal-phone-applied.png',
      'assistant-proposal-wide-applied.png',
    ],
  },
  {
    name: 'assistant-nudges',
    description:
      'The three nudges in place, at 1280 and 390 px: Setup with undecided capabilities (Ask), a cluster diagnosis that read no commits for want of an SCM token, and a timed-out failure in a project without capture fixtures (Show me)',
    prepare: prepareNudgeFailure,
    route: '/',
    viewport: { width: 1280, height: 860 },
    async run({ page, shoot, settle, goto }) {
      const clusterId = 3;
      await routeNudgeScene(page, clusterId);
      const pages = [
        ['setup', '/setup'],
        ['cluster', `/failure-clusters/${clusterId}`],
        ['failure', `/test-run-cases/${nudgeExecId}`],
      ];
      for (const [width, height, suffix] of [
        [1280, 860, ''],
        [390, 844, '-phone'],
      ]) {
        await page.setViewportSize({ width, height });
        for (const [label, path] of pages) {
          // Each page view gets the browser's weekly budget afresh.
          await page.evaluate(() => localStorage.removeItem('piwi-nudges'));
          await goto(path);
          const nudge = page.locator('[data-shot="assistant-nudge"]');
          await nudge.waitFor({ timeout: 90_000 });
          // Centered by scrolling the panel that holds it, so the page header stays in place.
          await nudge.evaluate((node) => {
            let panel = node.parentElement;
            while (panel && !/(auto|scroll)/.test(getComputedStyle(panel).overflowY)) panel = panel.parentElement;
            if (!panel) return;
            const offset = node.getBoundingClientRect().top - panel.getBoundingClientRect().top;
            panel.scrollTop += offset - (panel.clientHeight - node.offsetHeight) / 2;
          });
          await settle();
          await shoot(`${label}${suffix}`);
        }
      }
    },
    outputs: [
      'assistant-nudges-setup.png',
      'assistant-nudges-cluster.png',
      'assistant-nudges-failure.png',
      'assistant-nudges-setup-phone.png',
      'assistant-nudges-cluster-phone.png',
      'assistant-nudges-failure-phone.png',
    ],
  },
  {
    name: 'guides',
    description:
      "The command palette's Guides group, then the first stop of the Flake Lab guide started from it, at 1280 and 390 px",
    route: '/',
    viewport: { width: 1280, height: 860 },
    async run({ page, shoot, settle }) {
      const input = page.getByPlaceholder('Type a command or search…');
      const guides = page.getByRole('group', { name: 'Guides' });
      const showGuides = async () => {
        await page.keyboard.press('Control+KeyK');
        await guides.waitFor({ timeout: 30_000 });
        // The group follows Go to: scroll the palette's list to it.
        await guides.evaluate((group) => group.scrollIntoView({ block: 'start' }));
        await settle();
      };
      const startFlakeLab = async () => {
        await input.fill('Run the Flake Lab');
        await guides.getByRole('option').first().filter({ hasText: 'Run the Flake Lab' }).waitFor();
        await page.waitForTimeout(300);
        await guides.getByRole('option').first().click();
        await page
          .locator('.piwi-guide[data-guide="guide-run-flake-lab"][data-guide-settled]')
          .waitFor({ timeout: 60_000 });
        await settle();
      };
      await showGuides();
      await shoot('palette');
      await startFlakeLab();
      await shoot('stop');
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 390, height: 844 });
      await showGuides();
      await shoot('palette-phone');
      await startFlakeLab();
      await shoot('stop-phone');
    },
    outputs: ['guides-palette.png', 'guides-stop.png', 'guides-palette-phone.png', 'guides-stop-phone.png'],
  },
  {
    name: 'user-menu-piwi-tools',
    description:
      "The user menu's Piwi tools submenu: where to get Piwi Picker, the VS Code extension, the JetBrains plugin, the desktop app and the reporter, and the docs",
    route: '/',
    viewport: { width: 1280, height: 900 },
    async run({ page, shoot, settle }) {
      const tools = page.getByRole('menuitem', { name: 'Piwi tools' });
      await settle();
      // Hydration can lag the first paint on a dev server; retry the click until the menu opens.
      for (let attempt = 0; attempt < 20 && !(await tools.isVisible()); attempt++) {
        await page.locator('[data-shot="user-menu"]').click();
        await tools.waitFor({ timeout: 3000 }).catch(() => {});
      }
      await tools.hover();
      await page.getByRole('menuitem', { name: /Piwi for JetBrains IDEs/ }).waitFor();
      await settle();
      await shoot();
    },
  },
  {
    name: 'open-in-ide-settings',
    description:
      'The Open in IDE dialog from the user menu: the Piwi plugin callout with its JetBrains Marketplace link, then the methods',
    route: '/',
    viewport: { width: 1280, height: 1000 },
    async run({ page, shoot, settle }) {
      const item = page.getByRole('menuitem', { name: 'Open in IDE…' });
      await settle();
      for (let attempt = 0; attempt < 20 && !(await item.isVisible()); attempt++) {
        await page.locator('[data-shot="user-menu"]').click();
        await item.waitFor({ timeout: 3000 }).catch(() => {});
      }
      await item.click();
      await page.getByRole('link', { name: 'JetBrains Marketplace' }).waitFor();
      await settle();
      await shoot();
    },
  },
  {
    name: 'analytics-scope-bar',
    description:
      'The Filters block on Analytics: Period, Runs and Tests groups, the period picker open with comparison and buckets',
    route: '/analytics?period=last-90d',
    viewport: { width: 1280, height: 1000 },
    async run({ page, shoot, settle }) {
      await page.getByTestId('analytics-period').waitFor({ timeout: 60000 });
      await page.getByTestId('analytics-scope-line').waitFor({ timeout: 60000 });
      await settle();
      await page.getByTestId('analytics-period').click();
      await page.getByText('Compare with').waitFor({ timeout: 15000 });
      await shoot();
    },
  },
  {
    name: 'analytics-scope-bar-mobile',
    description:
      'The Filters block at 375 px: folded to a summary of the active filters, then open, no horizontal scroll',
    route: '/analytics',
    viewport: { width: 375, height: 900 },
    async run({ page, shoot, settle }) {
      const summary = page.getByTestId('analytics-filters-summary');
      // The comparison in the summary comes from a client-side fetch, so the page has hydrated once it shows.
      await summary.filter({ hasText: ' vs ' }).waitFor({ timeout: 60000 });
      await settle();
      await shoot('folded', { of: '[data-shot="analytics-scope-bar"]', pad: 8 });
      await page.getByTestId('analytics-filters-toggle').click();
      await page.getByTestId('analytics-period').waitFor({ timeout: 15000 });
      await settle();
      await shoot('open', { of: '[data-shot="analytics-scope-bar"]', pad: 8 });
    },
    outputs: ['analytics-scope-bar-mobile-folded.png', 'analytics-scope-bar-mobile-open.png'],
  },
  {
    name: 'analytics-headline',
    description:
      'Analytics, the Overview dashboard: the headline tiles above the portfolio, and the pass rate over time',
    route: '/analytics',
    viewport: { width: 1280, height: 2400 },
    async run({ page, shoot, settle }) {
      await page.getByTestId('stat-test-pass-rate').waitFor({ timeout: 60000 });
      await page.locator('[data-shot="analytics-metric"] svg').first().waitFor({ timeout: 60000 });
      await settle();
      await shoot('tiles', { of: '[data-shot="analytics-headline"]', pad: 12 });
      await shoot('trend', { of: '[data-shot="analytics-metric"]', pad: 12 });
    },
    outputs: ['analytics-headline-tiles.png', 'analytics-headline-trend.png'],
  },
  ...[
    { name: 'analytics-handbacks', width: 1280, height: 3600, docs: true },
    { name: 'analytics-handbacks-mobile', width: 390, height: 7000, docs: false },
  ].map(({ name, width, height, docs }) => ({
    name,
    description: `Analytics, the Overview dashboard: the Hand-back outcomes section (locator heals, AI diagnoses, the CI gate, a verified flaky test), at ${width} px`,
    ...(docs ? { tags: ['docs'], out: 'docs' } : {}),
    route: '/analytics?period=last-30d',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="analytics-handbacks"] dl').waitFor({ timeout: 60000 });
      await settle();
      await shoot(undefined, { of: '[data-shot="analytics-handbacks"]', pad: 12 });
    },
  })),
  {
    name: 'ai-usage',
    description: "Settings → AI: the AI usage panel, tokens per model, then how each model's diagnoses fared",
    tags: ['docs'],
    out: 'docs',
    route: '/settings/ai',
    viewport: { width: 1280, height: 2600 },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="ai-usage-quality"]').waitFor({ timeout: 60000 });
      await settle();
      await shoot(undefined, { of: '[data-shot="ai-usage"]', pad: 12 });
    },
  },
  ...[
    { name: 'quality-report-preview', width: 1280, height: 1800 },
    { name: 'quality-report-preview-mobile', width: 375, height: 1400 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Export on the analytics page: the executive quality report previewed, at ${width} px`,
    route: '/analytics',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      const preview = page.getByTestId('report-view');
      await page.getByTestId('stat-test-pass-rate').waitFor({ timeout: 60000 });
      await settle();
      // Hydration can lag the first paint on a dev server; retry the click until the dialog opens.
      for (let attempt = 0; attempt < 20 && !(await preview.isVisible()); attempt++) {
        await page.getByRole('button', { name: 'Export' }).first().click();
        await preview.waitFor({ timeout: 3000 }).catch(() => {});
      }
      await preview.locator('svg').first().waitFor({ timeout: 60000 });
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'quality-report-download-menu', width: 1280, height: 1000 },
    { name: 'quality-report-download-menu-mobile', width: 375, height: 1000 },
  ].map(({ name, width, height }) => ({
    name,
    description: `The quality report preview with its download menu open (PDF, HTML, Markdown, Excel, JSON) and each section's Excel button, at ${width} px`,
    route: '/analytics',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      const preview = page.getByTestId('report-view');
      await page.getByTestId('stat-test-pass-rate').waitFor({ timeout: 60000 });
      await settle();
      for (let attempt = 0; attempt < 20 && !(await preview.isVisible()); attempt++) {
        await page.getByRole('button', { name: 'Export' }).first().click();
        await preview.waitFor({ timeout: 3000 }).catch(() => {});
      }
      await preview.locator('[data-testid^="report-section-xlsx-"]').first().waitFor({ timeout: 60000 });
      await settle();
      await page.getByTestId('report-download').click();
      await page.getByRole('menuitem', { name: 'Excel' }).waitFor();
      await shoot();
    },
  })),
  // A failure cluster's Activity: the fix attempts reported on it and the agent's writes.
  ...[
    { suffix: '', width: 1280 },
    { suffix: '-mobile', width: 375 },
  ].map(({ suffix, width }) => ({
    name: `cluster-activity${suffix}`,
    description: `A failure cluster’s Activity section with reported fix attempts, unfolded, at ${width} px`,
    prepare: prepareClusterActivity,
    route: '/failure-clusters/2',
    viewport: { width, height: 1400 },
    // The card is folded to one line by default.
    expand: ['[data-shot="cluster-activity"]'],
    of: '[data-shot="cluster-activity"]',
    pad: 8,
  })),
  // The Reports page and a snapshot: `prepare` makes a channel, a weekly
  // schedule and one run of it, so the page has a snapshot to list.
  ...[
    { name: 'report-schedules', width: 1280, height: 860, docs: true },
    { name: 'report-schedules-mobile', width: 375, height: 900, docs: false },
  ].map(({ name, width, height, docs }) => ({
    name,
    description: `The Reports page: report snapshots and schedules, at ${width} px`,
    ...(docs ? { tags: ['docs'], out: 'docs' } : {}),
    prepare: prepareReportSchedule,
    route: '/reports',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      await page.getByTestId('schedule-list').waitFor({ timeout: 60000 });
      await page.getByTestId('snapshot-list').waitFor({ timeout: 60000 });
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'report-snapshot', width: 1280, height: 1600 },
    { name: 'report-snapshot-mobile', width: 375, height: 1600 },
  ].map(({ name, width, height }) => ({
    name,
    description: `A report snapshot on /reports/:id, at ${width} px`,
    prepare: prepareReportSchedule,
    route: '/reports',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      await page.getByTestId('snapshot-list').getByRole('link').first().click({ timeout: 60000 });
      await page.getByTestId('report-view').locator('svg').first().waitFor({ timeout: 60000 });
      await settle();
      await shoot();
    },
  })),
  // The share scenes need share links on: run them with PIWI_SHARE_LINKS_ENABLED=true (the harness's own
  // server inherits the environment), or against a --url server that has it.
  ...[
    { name: 'report-share-link', width: 1280, height: 900 },
    { name: 'report-share-link-mobile', width: 375, height: 1000 },
  ].map(({ name, width, height }) => ({
    name,
    description: `A report snapshot's share dialog with a minted link and its badge, at ${width} px`,
    prepare: prepareReportSchedule,
    route: '/reports',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      await page.getByTestId('snapshot-list').getByRole('link').first().click({ timeout: 60000 });
      await page.getByTestId('report-view').locator('svg').first().waitFor({ timeout: 60000 });
      await page.getByRole('button', { name: 'Share', exact: true }).click();
      await page.getByRole('button', { name: 'Create link' }).click({ timeout: 30000 });
      await page.getByTestId('minted-badge').getByRole('img').waitFor({ timeout: 30000 });
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'live-dashboard-link', width: 1280, height: 900 },
    { name: 'live-dashboard-link-mobile', width: 375, height: 1000 },
  ].map(({ name, width, height }) => ({
    name,
    description: `The live dashboard links dialog of the seeded Checkout team dashboard, at ${width} px`,
    route: '/analytics/d/1',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="dashboard"]').waitFor({ timeout: 60000 });
      await page.getByRole('button', { name: 'More dashboard actions' }).click();
      await page.getByRole('menuitem', { name: 'Live dashboard links' }).click();
      await page.getByRole('button', { name: 'Create link' }).click({ timeout: 30000 });
      await page.getByTestId('minted-badge').getByRole('img').waitFor({ timeout: 30000 });
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'saved-dashboard', width: 1280, height: 1500, docs: true },
    { name: 'saved-dashboard-mobile', width: 375, height: 1600, docs: false },
  ].map(({ name, width, height, docs }) => ({
    name,
    description: `The seeded shared Checkout team dashboard on /analytics/d/1, at ${width} px`,
    ...(docs ? { tags: ['docs'], out: 'docs' } : {}),
    route: '/analytics/d/1',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="dashboard"]').waitFor({ timeout: 60000 });
      await page.locator('[data-shot="analytics-note"]').waitFor({ timeout: 60000 });
      await settle();
      await shoot();
    },
  })),
  // Trend depth: one scene per new widget, tab and control, at 1280 and 375 px.
  ...[
    { shot: 'analytics-suite-growth', route: '/analytics?projects=1', what: 'the suite growth widget' },
    { shot: 'analytics-flaky-debt', route: '/analytics?projects=1', what: 'the flaky debt widget' },
    { shot: 'analytics-time-to-fix', route: '/analytics?projects=1', what: 'the time to fix widget' },
    { shot: 'analytics-headline', route: '/analytics?projects=1', what: 'the headline tiles with their target marks' },
    { shot: 'analytics-ownership', route: '/analytics/d/engineering', what: 'the ownership widget' },
    { shot: 'analytics-movers', route: '/analytics/d/engineering', what: 'the movers widget' },
    {
      shot: 'analytics-environment-comparison',
      route: '/analytics/d/engineering?projects=2',
      what: 'the environment comparison widget',
    },
    { shot: 'test-case-trend', route: '/test-cases/1?tab=trend', what: 'the Trend tab of a test' },
    {
      shot: 'cluster-occurrence-trend',
      route: '/failure-clusters/3',
      what: 'a failure cluster’s occurrences over time, unfolded',
      // The card is folded to one line by default.
      expand: [`[data-shot="cluster-occurrence-trend"]`],
    },
    { shot: 'project-targets', route: '/projects/1?tab=settings&section=targets', what: 'the project targets form' },
    {
      shot: 'project-url-patterns',
      route: '/projects/1?tab=settings&section=browser-extension',
      what: 'the browser extension URL patterns of a project, with the origins its suite visited',
    },
  ].flatMap(({ shot, route, what, expand }) =>
    [
      { suffix: '', width: 1280 },
      { suffix: '-mobile', width: 375 },
    ].map(({ suffix, width }) => ({
      name: `${shot}${suffix}`,
      description: `${what[0].toUpperCase()}${what.slice(1)}, at ${width} px`,
      route,
      viewport: { width, height: 1800 },
      ...(expand && { expand }),
      of: `[data-shot="${shot}"]`,
      async run({ page, shoot, settle }) {
        const target = page.locator(`[data-shot="${shot}"]`).first();
        await target.waitFor({ timeout: 90000 });
        await target.scrollIntoViewIfNeeded();
        // Unfolding clicked the header: move the pointer off the chart so no tooltip shows.
        if (expand) await page.mouse.move(0, 0);
        await settle();
        await shoot();
      },
    })),
  ),
  ...[
    { name: 'project-settings', width: 1280, height: 1100 },
    { name: 'project-settings-mobile', width: 375, height: 1500 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Project → Settings: the section menu beside one section at a time, at ${width} px`,
    route: '/projects/1?tab=settings&section=source-control',
    viewport: { width, height },
    of: '[data-shot="project-settings"]',
  })),
  ...[
    { name: 'project-url-patterns-empty', width: 1280 },
    { name: 'project-url-patterns-empty-mobile', width: 375 },
  ].map(({ name, width }) => ({
    name,
    description: `The browser extension URLs of a project whose runs recorded no baseURL, saying why nothing is suggested, at ${width} px`,
    route: '/projects/2?tab=settings&section=browser-extension',
    viewport: { width, height: 1000 },
    of: '[data-shot="project-url-patterns"]',
    async run({ page, shoot, settle }) {
      const card = page.locator('[data-shot="project-url-patterns"]');
      await card.getByTestId('url-pattern-no-suggestions').waitFor({ timeout: 90000 });
      await card.scrollIntoViewIfNeeded();
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'chart-export-menu', width: 1280 },
    { name: 'chart-export-menu-mobile', width: 375 },
  ].map(({ name, width }) => ({
    name,
    description: `The export menu of a chart (copy as PNG, download Excel), at ${width} px`,
    route: '/analytics?projects=1',
    viewport: { width, height: 900 },
    async run({ page, shoot, settle }) {
      const card = page.locator('[data-shot="analytics-suite-growth"]');
      await card.waitFor({ timeout: 90000 });
      await card.scrollIntoViewIfNeeded();
      await settle();
      await card.getByTestId('chart-export').click();
      await page.getByRole('menuitem', { name: 'Download Excel' }).waitFor();
      await shoot();
    },
  })),
  ...[
    { name: 'execution-replay-export', width: 1280 },
    { name: 'execution-replay-export-mobile', width: 375 },
  ].map(({ name, width }) => ({
    name,
    description: `A failed execution's Export menu: the .piwibug bug report for Piwi Picker's Replay, with how many steps are done by hand and not replayed, and Copy steps, at ${width} px`,
    route: '/test-run-cases/37',
    viewport: { width, height: 900 },
    async run({ page, shoot, settle }) {
      const summary = page.getByTestId('export-piwibug-summary');
      await settle();
      // Hydration can lag the first paint on a dev server; retry the click until the menu opens.
      for (let attempt = 0; attempt < 20 && !(await summary.isVisible()); attempt++) {
        await page.getByRole('button', { name: 'Export' }).first().click();
        await summary.waitFor({ timeout: 3000 }).catch(() => {});
      }
      await page.waitForFunction(
        () =>
          !/Reading the steps/.test(
            document.querySelector('[data-testid="export-piwibug-summary"]')?.textContent ?? 'Reading the steps',
          ),
        undefined,
        { timeout: 60000 },
      );
      await shoot();
    },
  })),
  ...[
    { name: 'test-title-path', width: 1280 },
    { name: 'test-title-path-mobile', width: 390 },
  ].map(({ name, width }) => ({
    name,
    description: `Where the failing test lives: the execution's identity line, then a cluster's affected tests and evidence, name it by its title path (folders, file and line, describe blocks, title), at ${width} px`,
    outputs: [`${name}-execution.png`, `${name}-cluster-affected.png`, `${name}-cluster-evidence.png`],
    route: '/test-run-cases/37',
    viewport: { width, height: 900 },
    async run({ page, goto, shoot, settle }) {
      await page.locator('[data-shot="test-title-path"]').waitFor({ timeout: 60000 });
      await settle();
      await shoot('execution', { of: '[data-shot="situation-block"]', pad: 8 });
      await goto('/failure-clusters/5');
      await page.locator('[data-shot="evidence-subject"]').waitFor({ timeout: 60000 });
      await shoot('cluster-affected', { of: '[data-shot="cluster-affected-tests"]', pad: 8 });
      await page.locator('[data-shot="evidence-subject"]').scrollIntoViewIfNeeded();
      await shoot('cluster-evidence', { of: '[data-shot="evidence-subject"]', pad: 8 });
    },
  })),
  ...[
    { name: 'dashboard-editor', width: 1280, height: 1200, docs: true },
    { name: 'dashboard-editor-mobile', width: 375, height: 1400, docs: false },
  ].map(({ name, width, height, docs }) => ({
    name,
    description: `The dashboard editor on the seeded wasted-CI dashboard, a widget menu open, at ${width} px`,
    ...(docs ? { tags: ['docs'], out: 'docs' } : {}),
    route: '/analytics/d/2?edit=1',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      await page.getByTestId('add-widget-button-0').waitFor({ timeout: 60000 });
      await page.locator('[data-shot="analytics-metric-display"]').first().waitFor({ timeout: 60000 });
      await settle();
      await page.getByTestId('widget-menu-wasted-by-browser').click();
      await page.getByRole('menuitem', { name: 'Configure' }).waitFor();
      await shoot();
    },
  })),
  // *Rename…* on Manage dashboards: the seeded wasted-CI dashboard's name and description.
  ...[
    { name: 'dashboard-rename', width: 1280, height: 800 },
    { name: 'dashboard-rename-mobile', width: 375, height: 800 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Manage dashboards, then Rename… on a saved dashboard, at ${width} px`,
    route: '/analytics/dashboards',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      const dialog = page.getByTestId('rename-dashboard');
      await page.getByTestId('dashboard-row-2').waitFor({ timeout: 60000 });
      await settle();
      for (let attempt = 0; attempt < 20 && !(await dialog.isVisible()); attempt++) {
        await page
          .getByTestId('dashboard-row-2')
          .getByRole('button', { name: /^Actions:/ })
          .click();
        await page
          .getByRole('menuitem', { name: 'Rename…' })
          .click({ timeout: 3000 })
          .catch(() => {});
        await dialog.waitFor({ timeout: 3000 }).catch(() => {});
      }
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'report-schedule-form', width: 1280, height: 900 },
    { name: 'report-schedule-form-mobile', width: 375, height: 900 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Schedule… on the analytics page: the schedule form, at ${width} px`,
    route: '/analytics',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      const form = page.getByTestId('schedule-form');
      await page.getByTestId('stat-test-pass-rate').waitFor({ timeout: 60000 });
      await settle();
      for (let attempt = 0; attempt < 20 && !(await form.isVisible()); attempt++) {
        await page.locator('button[title="Schedule a quality report of this scope"]').first().click();
        await form.waitFor({ timeout: 3000 }).catch(() => {});
      }
      await page.getByTestId('schedule-name').fill('Weekly executive report');
      await settle();
      await shoot();
    },
  })),
  // *Send to* in the schedule form: each channel with who receives it (`-picker`,
  // the list open), then the recipients of the picked channel under it.
  ...[
    { name: 'report-schedule-recipients', width: 1280, height: 1000 },
    { name: 'report-schedule-recipients-mobile', width: 375, height: 1000 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Schedule… then Send to: who each channel reaches, and the picked channels' recipients, at ${width} px`,
    prepare: prepareReportSchedule,
    route: '/analytics',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      const form = page.getByTestId('schedule-form');
      await page.getByTestId('stat-test-pass-rate').waitFor({ timeout: 60000 });
      await settle();
      for (let attempt = 0; attempt < 20 && !(await form.isVisible()); attempt++) {
        await page.locator('button[title="Schedule a quality report of this scope"]').first().click();
        await form.waitFor({ timeout: 3000 }).catch(() => {});
      }
      await page.getByTestId('schedule-name').fill('Weekly executive report');
      await page.getByTestId('schedule-channels').click();
      const option = page.getByRole('option', { name: /Email to/ }).first();
      await option.waitFor({ timeout: 30000 });
      await settle();
      await shoot('picker');
      await option.click();
      await page.keyboard.press('Escape');
      await page.getByTestId('schedule-recipients').waitFor({ timeout: 30000 });
      await settle();
      await shoot();
    },
  })),
  // *Preview* in the schedule form, sending to the email channel `prepare` makes.
  ...[
    { name: 'report-schedule-preview', width: 1280, height: 1400 },
    { name: 'report-schedule-preview-mobile', width: 375, height: 1000 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Schedule… then Preview: the email the schedule would send now, at ${width} px`,
    prepare: prepareReportSchedule,
    route: '/analytics',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      const form = page.getByTestId('schedule-form');
      await page.getByTestId('stat-test-pass-rate').waitFor({ timeout: 60000 });
      await settle();
      for (let attempt = 0; attempt < 20 && !(await form.isVisible()); attempt++) {
        await page.locator('button[title="Schedule a quality report of this scope"]').first().click();
        await form.waitFor({ timeout: 3000 }).catch(() => {});
      }
      await page.getByTestId('schedule-name').fill('Weekly executive report');
      await page.getByTestId('schedule-channels').click();
      await page
        .getByRole('option', { name: /Email to/ })
        .first()
        .click();
      await page.keyboard.press('Escape');
      await page.getByTestId('schedule-preview-open').click();
      await page.getByTestId('schedule-preview-email').waitFor({ timeout: 60000 });
      await settle();
      await shoot();
    },
  })),
  {
    name: 'test-case-locators',
    description:
      'Test case page: the Locators section, from the latest execution, with how many tests share each chain',
    route: '/test-cases/1',
    viewport: { width: 1280, height: 1800 },
    async run({ page, shoot, settle }) {
      await page
        .locator('[data-shot="execution-locators"] ol')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot(undefined, { of: '[data-shot="test-case-locators"]', pad: 12 });
    },
  },
  ...['', '-mobile'].map((suffix) => ({
    name: `screen-views${suffix}`,
    description: suffix
      ? 'Screen tab at phone width: the views of the page at the failure, the strip wrapping onto two rows'
      : 'Screen tab: one strip of views of the page at the failure (Screenshot, DOM, Accessibility tree, Visual diff, Page diff, Video) over the files',
    route: '/test-run-cases/37',
    viewport: suffix ? { width: 390, height: 1400 } : { width: 1280, height: 1100 },
    of: '[data-shot="evidence-card"]',
    pad: suffix ? 8 : 12,
    async run({ page, shoot, settle }) {
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Screen', exact: true })
        .click();
      // The strip is whole once the diffs have reported.
      await page
        .getByRole('tablist', { name: 'Screen view' })
        .getByRole('tab', { name: 'Page diff' })
        .waitFor({ timeout: 30_000 });
      await settle();
      await shoot();
    },
  })),
  {
    name: 'screen-dom-picker',
    description: 'Screen tab: the DOM view → Open in picker, the locator picker over the same page',
    route: '/test-run-cases/37',
    viewport: { width: 1280, height: 1000 },
    async run({ page, shoot, settle }) {
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Screen', exact: true })
        .click();
      await page.getByRole('tablist', { name: 'Screen view' }).getByRole('tab', { name: 'DOM', exact: true }).click();
      await page.locator('iframe[title="DOM at the failure"]').waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: 'Open in picker' }).click();
      await page.getByText('Rendered from the failure-time DOM snapshot').waitFor({ timeout: 15000 });
      await page.getByText('Initializing picker').waitFor({ state: 'detached', timeout: 15000 });
      await settle();
      await shoot();
    },
  },
  {
    name: 'locator-usage-drawer',
    description: 'Who uses this? drawer: the call sites and tests that use a locator, with the command that runs them',
    route: '/test-run-cases/711',
    viewport: { width: 1280, height: 1000 },
    async run({ page, shoot, settle, openTab }) {
      await openTab('Locators');
      const card = page.locator('[data-shot="execution-locators"]');
      await card
        .getByRole('button', { name: /tests?$/ })
        .first()
        .click();
      const drawer = page.locator('[data-shot="locator-usage-drawer"]');
      await drawer.getByText(/ call sites?$/).waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: /^Run these/ }).click();
      await drawer.getByText('Run them').waitFor({ timeout: 15000 });
      await settle();
      await shoot();
    },
  },
  {
    name: 'project-locators',
    description:
      'Project Locators page: pasted locators checked against the locator index (exact, similar, unused), the tests reaching them, the branch select',
    route: `/projects/1/locators?q=${encodeURIComponent(
      ["getByLabel('Email')", "getByText('Order confirmed!')", "getByTestId('coupon')"].join('\n'),
    )}`,
    viewport: { width: 1280, height: 1400 },
    async run({ page, shoot, settle }) {
      await page
        .locator('[data-shot="locator-check-tests"]')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot();
    },
  },
  {
    name: 'project-locators-mobile',
    description: 'Project Locators page at phone width',
    route: `/projects/1/locators?q=${encodeURIComponent(["getByLabel('Email')", "getByTestId('coupon')"].join('\n'))}`,
    viewport: { width: 390, height: 1400 },
    async run({ page, shoot, settle }) {
      await page
        .locator('[data-shot="locator-check-tests"]')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot();
    },
  },
  {
    name: 'scenario-gaps-home-inbox',
    description: 'Home: the accepted-but-unwritten scenario-gaps inbox queue',
    route: '/',
    viewport: { width: 1280, height: 1400 },
    async run({ page, shoot, settle }) {
      await page
        .locator('[data-shot="gaps-inbox"]')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot(undefined, { of: '[data-shot="gaps-inbox"]', pad: 12 });
    },
  },
  {
    name: 'storage-analysis',
    description: 'Settings → Storage: usage KPIs, storage over time, by file kind and top projects',
    route: '/settings/storage',
    viewport: { width: 1280, height: 1700 },
    async run({ page, shoot, settle }) {
      // The dashboard fetches client-side; wait for a KPI to resolve before capture.
      await page
        .getByText('Total storage')
        .first()
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot(undefined, { of: '[data-shot="storage-analysis"]', pad: 12 });
    },
  },
  {
    name: 'localization-settings',
    description:
      'Settings → Localization: the per-viewer format override and the admin instance default, with a live preview',
    route: '/settings/localization',
    viewport: { width: 1280, height: 1100 },
    async run({ page, shoot, settle }) {
      // Both cards fetch the instance default client-side; wait for the preview
      // line to resolve before capturing.
      await page
        .getByText('Preview:')
        .first()
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot(undefined, { of: '[data-shot="localization-settings"]', pad: 12 });
    },
  },
  {
    name: 'user-api-keys',
    description: 'The API keys manager (shared ApiKeysManager) — here in the Users admin modal',
    route: '/settings/users',
    viewport: { width: 1100, height: 1000 },
    async run({ page, shoot, settle }) {
      // The screenshot server runs with auth off, so every user's keys are
      // manageable; open the first user's modal. The same component backs the
      // Account page (Settings → Account → API keys), which needs auth enabled.
      await page.getByRole('button', { name: 'Manage API keys' }).first().click();
      await page.getByRole('dialog').waitFor();
      await settle();
      await shoot(undefined, { of: '[role="dialog"]', pad: 0 });
    },
  },
  {
    name: 'permission-grid-mobile',
    description:
      'Settings → Permissions at phone width: the group and user column stays pinned while the projects scroll sideways',
    route: '/settings/permissions',
    viewport: { width: 390, height: 1100 },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="permission-grid"] table').waitFor({ timeout: 15000 });
      await settle();
      await shoot();
    },
  },
  ...[
    { name: 'settings-users', width: 1280, height: 900 },
    { name: 'settings-users-mobile', width: 390, height: 2000 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Settings → Users: each user's instance role and groups, changed in place, at ${width} px`,
    route: '/settings/users',
    viewport: { width, height },
    of: '[data-shot="users-table"]',
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="users-table"]').waitFor({ timeout: 90000 });
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'settings-user-project-roles', width: 1280, height: 900 },
    { name: 'settings-user-project-roles-mobile', width: 390, height: 1100 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Settings → Users → Project roles of the QA lead: All projects, one role per project, and the groups adding to them, at ${width} px`,
    route: '/settings/users',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      await page.getByRole('button', { name: 'Project roles of quinn-qa-lead' }).filter({ visible: true }).click();
      await page.locator('[data-shot="user-project-roles"]').waitFor({ timeout: 15000 });
      await settle();
      await shoot(undefined, { of: '[role="dialog"]', pad: 0 });
    },
  })),
  ...[
    { name: 'settings-roles', width: 1280, height: 1100 },
    { name: 'settings-roles-mobile', width: 390, height: 2600 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Settings → Roles: what each project role can do, read-only, at ${width} px`,
    route: '/settings/roles',
    viewport: { width, height },
    of: '[data-shot="roles-matrix"]',
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="roles-matrix"]').waitFor({ timeout: 90000 });
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'settings-groups', width: 1280, height: 800 },
    { name: 'settings-groups-mobile', width: 390, height: 1000 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Settings → Groups: each group with its description and member count, at ${width} px`,
    route: '/settings/groups',
    viewport: { width, height },
    of: '[data-shot="groups-table"]',
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="groups-table"]').waitFor({ timeout: 90000 });
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'settings-group-edit', width: 1280, height: 800 },
    { name: 'settings-group-edit-mobile', width: 390, height: 900 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Settings → Groups: editing the QA group, its name, description and members, at ${width} px`,
    route: '/settings/groups',
    viewport: { width, height },
    async run({ page, shoot, settle }) {
      await page.getByRole('button', { name: 'Edit QA' }).filter({ visible: true }).click();
      await page.locator('[data-shot="group-form"]').waitFor({ timeout: 15000 });
      await settle();
      await shoot(undefined, { of: '[role="dialog"]', pad: 0 });
    },
  })),
  ...[
    { name: 'project-members', width: 1280, height: 1000 },
    { name: 'project-members-mobile', width: 390, height: 1800 },
  ].map(({ name, width, height }) => ({
    name,
    description: `Project → Settings → Members: the groups and users holding a role on the project and where it comes from, at ${width} px. Members exist with authentication on: pass --url of an auth-enabled server and PIWI_SCREENS_LOGIN=<username>:<password> of an administrator or a Project admin of project 1`,
    route: '/projects/1?tab=settings&section=members',
    viewport: { width, height },
    of: '[data-shot="project-members"]',
    prepare: signInForScene,
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="project-members"] [data-member]').first().waitFor({ timeout: 90000 });
      await settle();
      await shoot();
    },
  })),

  // ── Docs illustrations (committed) ────────────────────────────────────────
  {
    name: 'scenario-gaps-feature-map',
    description:
      'Feature map of the web-dashboard project: one circle per feature, colored by its worst open gap, linked where features share nodes',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/5?tab=gaps',
    viewport: { width: 1280, height: 1100 },
    async run({ page, shoot, settle }) {
      await page
        .locator('[data-shot="feature-map"] svg')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot(undefined, { of: '[data-shot="feature-map"]', pad: 12 });
    },
  },
  {
    name: 'scenario-gaps-tab',
    description:
      'Gaps tab: the Users feature of the web-dashboard project, its top five gaps ranked with class, evidence and verbs',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/5?tab=gaps',
    viewport: { width: 1280, height: 1600 },
    async run({ page, shoot, settle }) {
      await page
        .locator('[data-shot="gaps-group-Users"]')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      // The feature holds more gaps than a docs figure shows: keep the top five.
      await page.addStyleTag({
        content:
          '[data-shot="gaps-group-Users"] [data-shot^="gap-"]:nth-child(n+6) { display: none !important; }' +
          ' [data-shot="gaps-group-Users"] [data-shot^="gap-"]:nth-child(5) { border-bottom-width: 0 !important; }',
      });
      await settle();
      await shoot(undefined, { of: '[data-shot="gaps-group-Users"]', pad: 12 });
    },
  },
  {
    name: 'scenario-gaps-map-health',
    description:
      'Map health on the Gaps tab: each input of the web-dashboard Test Map against what it could hold, and the step behind the one short',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/5?tab=gaps',
    viewport: { width: 1280, height: 2400 },
    async run({ page, shoot, settle }) {
      await page
        .locator('[data-shot="map-health-probes"]')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot(undefined, { of: '[data-shot="map-health-card"]', pad: 12 });
    },
  },
  {
    name: 'scenario-gaps-graph',
    description: 'Feature graph around a page one test reaches: what leads to it, what it contains, links to and loads',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/5?tab=gaps',
    viewport: { width: 1280, height: 1800 },
    async run({ page, shoot, settle }) {
      await page
        .locator('[data-shot="gaps-panel"]')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await page
        .locator('[data-shot^="gap-"]')
        .filter({ hasText: 'Only one test reaches page /settings/api' })
        .getByRole('button', { name: 'View', exact: false })
        .click();
      await page
        .locator('[data-shot="feature-graph"] svg')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot(undefined, { of: ['[data-shot="feature-graph-seed"]', '[data-shot="feature-graph-picture"]'] });
    },
  },
  {
    name: 'environment-incident',
    description:
      'Run header of an environment incident: not counted, the reason, the rule that decided and the action to clear it',
    tags: ['docs'],
    out: 'docs',
    route: '/test-runs/14',
    viewport: { width: 1280, height: 900 },
    async run({ page, shoot, settle }) {
      await page
        .locator('[data-shot="run-incident"]')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot(undefined, { of: '[data-shot="run-header"]', pad: 12 });
    },
  },
  {
    name: 'execution-locators',
    description: 'Execution Locators tab: every locator the test used, in order, with how many tests share each chain',
    tags: ['docs'],
    out: 'docs',
    route: '/test-run-cases/229',
    viewport: { width: 1280, height: 1400 },
    async run({ page, shoot, settle, openTab }) {
      await openTab('Locators');
      await page
        .locator('[data-shot="execution-locators"] ol')
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot(undefined, { of: '[data-shot="evidence-card"]', pad: 12 });
    },
  },
  {
    name: 'permission-grid',
    description:
      'Settings → Permissions: groups above users against every project, a role in each cell, the focused cell’s row and column highlighted',
    tags: ['docs'],
    out: 'docs',
    route: '/settings/permissions',
    viewport: { width: 1440, height: 900 },
    async run({ page, shoot, settle }) {
      // Jordan holds Maintainer on API Integration through the QA group: a faint, inherited role.
      const cell = page.getByRole('button', { name: 'Jordan (QA engineer) — API Integration', exact: true });
      await cell.waitFor({ timeout: 15000 });
      await settle();
      // The crosshair follows focus as well as the pointer. Focus survives the
      // capture's re-layout, where a stationary pointer would land on another cell.
      await cell.focus();
      await shoot(undefined, { of: '[data-shot="permission-grid"]', pad: 12 });
    },
  },
  {
    name: 'integrations-settings',
    description: 'Settings → Integrations: the Jira card with a connected system and a test button',
    tags: ['docs'],
    out: 'docs',
    // Run with the server's Jira env vars set (PIWI_JIRA_BASE_URL / PIWI_JIRA_EMAIL
    // / PIWI_JIRA_API_TOKEN) so the environment-managed Jira connection appears;
    // no network call is made just to render the page.
    route: '/settings/integrations',
    viewport: { width: 1280, height: 1000 },
    of: '[data-shot="integrations-settings"]',
    pad: 12,
  },
  {
    name: 'integrations-webhook-actions',
    description:
      'Settings → Integrations: Sync now on the Jira card, Disable webhook on a connection whose webhook is on, its confirmation and the sync toast',
    tags: ['desktop'],
    // The scene connection points at a dead port, so the sync reads nothing and says so.
    async prepare(ctx) {
      await prepareJiraSceneConnection(ctx);
      await ctx.request.post(`${ctx.base}/api/integrations/connections/${jiraSceneConnectionId}/webhook-token`);
    },
    route: '/settings/integrations',
    viewport: { width: 1280, height: 1000 },
    async run({ page, settle, shoot }) {
      const disable = page.getByRole('button', { name: 'Disable webhook' }).first();
      await disable.waitFor({ timeout: 60_000 });
      await settle();
      await shoot('card', { of: '[data-shot="integrations-settings"]', pad: 12 });
      await disable.click();
      await page.getByRole('dialog', { name: 'Disable the webhook' }).waitFor();
      await settle();
      await shoot('confirm');
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Sync now' }).first().click();
      await page.getByText('Statuses synced').first().waitFor({ timeout: 30_000 });
      await settle();
      await shoot('toast');
    },
  },
  {
    name: 'jira-connect-form',
    description:
      'Settings → Integrations: the Jira connect form with a pasted board URL, scoped-token steps and a sign-in check',
    tags: ['docs'],
    out: 'docs',
    // Run with PIWI_SECRET_KEY set, or the form opens on the "cannot store a token" notice.
    // The check endpoint would call the typed site, so the scene answers it with a
    // canned Cloud site and sign-in; no Atlassian host is contacted.
    route: '/settings/integrations',
    viewport: { width: 1280, height: 1700 },
    async run({ page, shoot, settle }) {
      await page.route('**/api/integrations/connections/check', async (route) => {
        const body = route.request().postDataJSON();
        const result = {
          baseUrl: body.baseUrl,
          site: {
            ok: true,
            reachable: true,
            deploymentType: 'Cloud',
            title: 'Jira',
            reportedUrl: null,
            cloudId: '8f1c2b7e-4d3a-4b6f-9a51-2c0e7d9b3f10',
          },
        };
        if (body.credentials?.apiToken) {
          result.auth = { ok: true, account: { id: 'acct-1', displayName: 'Piwi Bot' }, tokenKind: 'scoped' };
          result.projects = { ok: true, count: 3, keys: ['CHK', 'PAY', 'WEB'], hint: null };
        }
        await route.fulfill({ json: result });
      });
      await page.getByRole('button', { name: 'Connect Jira' }).first().click();
      const form = page.locator('[data-shot="jira-connection-form"]');
      await form.waitFor();
      await page.getByTestId('jira-site').fill('https://your-team.atlassian.net/jira/software/projects/CHK/boards/1');
      await page.getByTestId('jira-site-check').waitFor();
      await form.getByText('Scoped token', { exact: true }).click();
      await form.getByLabel('Account email').fill('piwi-bot@example.com');
      await form.getByLabel('API token', { exact: true }).fill('screenshot-token');
      await form.getByRole('button', { name: 'Check sign-in' }).click();
      await page.getByTestId('jira-credential-check').waitFor();
      await settle();
      await shoot(undefined, { of: '[data-shot="jira-connection-form"]', pad: 12 });
    },
  },
  {
    name: 'create-issue-modal',
    description: 'Create issue modal on a cluster: title, fields, include toggles and the fix-plan preview',
    tags: ['docs'],
    out: 'docs',
    // A db-managed Jira connection makes the entry points appear; its base URL
    // points at a dead local port so the dedupe search fails fast (no real Jira).
    async prepare({ base, request }) {
      const list = await (await request.get(`${base}/api/integrations/connections`)).json();
      if (!list.connections?.some((c) => c.provider === 'jira')) {
        await request.post(`${base}/api/integrations/connections`, {
          data: {
            provider: 'jira',
            name: 'Jira',
            baseUrl: 'http://127.0.0.1:9',
            credentials: { email: 'you@example.com', apiToken: 'screenshot-token' },
          },
        });
      }
    },
    // A cluster no scene links an issue to, so its Issue line keeps Create issue.
    route: '/failure-clusters/4',
    viewport: { width: 1280, height: 1100 },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="issue-line-create"]').first().click();
      await page.getByRole('dialog').waitFor();
      // The preview renders once the draft resolves.
      await page
        .getByText('What happened')
        .first()
        .waitFor({ timeout: 15000 })
        .catch(() => {});
      await settle();
      await shoot(undefined, { of: '[role="dialog"]', pad: 0 });
    },
  },
  {
    name: 'cluster-issue-line',
    description:
      "Cluster situation block: the latest failure's headline as the heading, the cluster's name under it, and the Issue line naming the cluster's Jira issue and its status",
    tags: ['docs'],
    out: 'docs',
    // Pin a Jira issue to the cluster so its key shows on the Issue line. The
    // scene connection's host makes the URL a Jira issue on any database.
    async prepare({ base, request }) {
      await prepareJiraSceneConnection({ base, request });
      const links = await (await request.get(`${base}/api/links?entityType=failure_cluster&entityId=10`)).json();
      if (!links.items?.some((l) => l.key === 'PROJ-128')) {
        await request.post(`${base}/api/links`, {
          data: {
            entityType: 'failure_cluster',
            entityId: 10,
            url: 'http://127.0.0.1:9/browse/PROJ-128',
            title: 'Checkout button is disabled',
          },
        });
      }
    },
    route: '/failure-clusters/10',
    viewport: { width: 1280, height: 900 },
    of: '[data-shot="situation-block"]',
    pad: 12,
  },
  {
    name: 'project-integration-binding',
    description: 'Project → Settings → Issue tracker: the binding form with policies and owner routes',
    tags: ['docs'],
    out: 'docs',
    // A db-managed Jira connection makes the binding form appear; its base URL
    // points at a dead local port so no real Jira is contacted.
    async prepare({ base, request }) {
      const list = await (await request.get(`${base}/api/integrations/connections`)).json();
      if (!list.connections?.some((c) => c.provider === 'jira')) {
        await request.post(`${base}/api/integrations/connections`, {
          data: {
            provider: 'jira',
            name: 'Jira',
            baseUrl: 'http://127.0.0.1:9',
            credentials: { email: 'you@example.com', apiToken: 'screenshot-token' },
          },
        });
      }
    },
    route: '/projects/2?tab=settings&section=issue-tracker',
    viewport: { width: 1280, height: 2000 },
    of: '[data-shot="project-integration-binding"]',
    pad: 12,
  },
  {
    name: 'project-integration-auto-create',
    description:
      'Project → Settings → Issue tracker: automatic creation with two rules, and the preview of what they file',
    tags: ['docs'],
    out: 'docs',
    // The binding is answered as bound to CHK / Bug with automatic creation on;
    // the preview runs for real against the seeded clusters of project 2.
    prepare: prepareJiraSceneConnection,
    route: '/projects/2?tab=settings&section=issue-tracker',
    viewport: { width: 1280, height: 1600 },
    async run({ page, goto, shoot, settle }) {
      await routeJiraScreen(page);
      await page.route('**/api/projects/2/integrations', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const binding = await (await route.fetch()).json();
        await route.fulfill({
          json: {
            ...binding,
            connectionId: jiraSceneConnectionId,
            projectKey: 'CHK',
            issueType: '10004',
            autoCreate: {
              enabled: true,
              rules: [
                {
                  branches: ['release/*'],
                  defaultBranch: false,
                  environments: [],
                  tags: [],
                  minOccurrences: 1,
                  minRuns: 1,
                  minDays: 0,
                  labels: ['release-blocker'],
                },
                {
                  branches: [],
                  defaultBranch: true,
                  environments: ['staging'],
                  tags: [],
                  minOccurrences: 3,
                  minRuns: 2,
                  minDays: 1,
                  labels: [],
                },
              ],
              skipFlaky: true,
              dailyCap: 5,
              routeUnmatchedToDefault: false,
            },
          },
        });
      });
      await goto('/projects/2?tab=settings&section=issue-tracker');
      const block = page.locator('[data-shot="binding-auto-create"]');
      await block.waitFor({ timeout: 20000 });
      await block.getByRole('button', { name: 'Preview' }).click();
      await block.getByText(/issues filed automatically in the last 24 hours/).waitFor({ timeout: 15000 });
      await settle();
      await shoot(undefined, { of: '[data-shot="binding-auto-create"]', pad: 12 });
    },
  },
  {
    name: 'create-issue-required-fields',
    description: 'Create issue modal asking for the fields Jira requires, one filled from the project default',
    tags: ['docs'],
    out: 'docs',
    // The draft is answered as for a project bound to CHK / Bug with a Severity
    // default; the pickers and the create screen come from routeJiraScreen.
    prepare: prepareJiraSceneConnection,
    route: '/failure-clusters/7',
    viewport: { width: 1280, height: 1100 },
    async run({ page, shoot, settle }) {
      await routeJiraScreen(page);
      await page.route('**/api/integrations/issue-draft*', async (route) => {
        const draft = await (await route.fetch()).json();
        await route.fulfill({
          json: {
            ...draft,
            connectionId: jiraSceneConnectionId,
            projectKey: 'CHK',
            issueType: '10004',
            fieldValues: JIRA_FIELD_DEFAULTS,
          },
        });
      });
      await page.locator('[data-shot="issue-line-create"]').first().click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('[data-shot="create-issue-fields"]').waitFor({ timeout: 15000 });
      await dialog.getByTestId('create-issue-missing').waitFor();
      await settle();
      await shoot(undefined, { of: '[role="dialog"]', pad: 0 });
    },
  },
  {
    name: 'create-issue-added-field',
    description: 'Create issue modal with a Parent added on demand, its issue search open',
    tags: ['desktop'],
    prepare: prepareJiraSceneConnection,
    route: '/failure-clusters/7',
    viewport: { width: 1280, height: 1100 },
    async run({ page, shoot, settle }) {
      await routeJiraScreen(page);
      await page.route('**/api/integrations/issue-draft*', async (route) => {
        const draft = await (await route.fetch()).json();
        await route.fulfill({
          json: {
            ...draft,
            connectionId: jiraSceneConnectionId,
            projectKey: 'CHK',
            issueType: '10004',
            fieldValues: JIRA_FIELD_DEFAULTS,
          },
        });
      });
      await page.locator('[data-shot="issue-line-create"]').first().click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('[data-shot="create-issue-fields"]').waitFor({ timeout: 15000 });
      await dialog.getByText('Unassigned').click();
      await page.getByRole('option', { name: 'Dana Reyes' }).click();
      await dialog.getByText('Add a field').click();
      await page.getByRole('option', { name: 'Parent', exact: true }).click();
      const parent = dialog.locator('[data-shot="create-issue-added-fields"] [data-field-id="parent"]');
      await parent.getByText('Search an issue').click();
      await page.keyboard.type('checkout');
      await page.getByRole('option', { name: 'CHK-12 — Checkout reliability' }).waitFor();
      await settle();
      await shoot(undefined, { of: '[role="dialog"]', pad: 0 });
    },
  },
  {
    name: 'binding-jira-fields',
    description:
      "Project → Settings → Issue tracker: the Jira fields the issue type requires, with the project's defaults",
    // The binding is answered as bound to CHK / Bug with a Severity and a
    // component default; the pickers and the create screen come from routeJiraScreen.
    prepare: prepareJiraSceneConnection,
    route: '/projects/2?tab=settings&section=issue-tracker',
    viewport: { width: 1280, height: 1600 },
    async run({ page, goto, shoot }) {
      await routeJiraScreen(page);
      await page.route('**/api/projects/2/integrations', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const binding = await (await route.fetch()).json();
        await route.fulfill({
          json: {
            ...binding,
            connectionId: jiraSceneConnectionId,
            projectKey: 'CHK',
            issueType: '10004',
            fieldDefaults: JIRA_FIELD_DEFAULTS,
          },
        });
      });
      await goto('/projects/2?tab=settings&section=issue-tracker');
      await page.locator('[data-shot="binding-jira-fields"] [data-field-id="customfield_10001"]').waitFor();
      await shoot(undefined, { of: '[data-shot="binding-jira-fields"]', pad: 12 });
    },
  },
  {
    name: 'binding-transition-fields',
    description:
      "Project → Settings → Issue tracker: the fix and reopen transitions checked against the project's issues, with the resolution the fix transition requires",
    // The binding is answered as bound to CHK / Bug with both transitions set;
    // the transitions of an open and a done sample issue are canned, so no Jira
    // is contacted.
    prepare: prepareJiraSceneConnection,
    route: '/projects/2?tab=settings&section=issue-tracker',
    viewport: { width: 1280, height: 1800 },
    async run({ page, goto, shoot }) {
      await routeJiraScreen(page);
      await page.route('**/api/integrations/connections/*/projects/*/transitions*', (route) => {
        const done = new URL(route.request().url()).searchParams.get('from') === 'done';
        route.fulfill({ json: done ? JIRA_DONE_SAMPLE : JIRA_OPEN_SAMPLE });
      });
      await page.route('**/api/projects/2/integrations', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const binding = await (await route.fetch()).json();
        await route.fulfill({
          json: {
            ...binding,
            connectionId: jiraSceneConnectionId,
            projectKey: 'CHK',
            issueType: '10004',
            policies: {
              ...binding.policies,
              commentOnFix: true,
              transitionOnFix: true,
              fixTransitionId: 'Done',
              fixTransitionFields: { resolution: { value: { id: '1' }, label: 'Fixed' } },
              commentOnRegression: true,
              reopenTransitionId: 'To Do',
              reopenTransitionFields: {},
            },
          },
        });
      });
      await goto('/projects/2?tab=settings&section=issue-tracker');
      await page.locator('[data-shot="transition-fields-open"] [data-field-id="resolution"]').waitFor();
      await page.locator('[data-shot="transition-fields-done"] [data-testid="transition-check"]').waitFor();
      await shoot(undefined, { of: '[data-shot="binding-sync-policies"]', pad: 12 });
    },
  },
  {
    name: 'locator-healing',
    description: 'Locator fix: ranked replacements and a recommended fix in the toolbox',
    tags: ['docs'],
    out: 'docs',
    // Execution 533 is a strict-mode locator-resolution failure with pre-captured
    // alternatives; its next step is "replace the locator", so the toolbox opens
    // the Locator fix section with the panel in full.
    route: '/test-run-cases/533',
    viewport: { width: 1280, height: 1300 },
    of: '[data-shot="alternative-locators"]',
    pad: 12,
  },
  {
    name: 'next-step-change',
    description: 'The Next line of a locator step: the call site, the edit it copies as a diff, its source and button',
    tags: ['docs'],
    out: 'docs',
    // Cluster 2's latest occurrence has a locator edit captured from the last
    // passing run, so its step replaces the locator and copies an apply command.
    route: '/failure-clusters/2',
    viewport: { width: 1280, height: 900 },
    of: '[data-shot="next-step"]',
    pad: 12,
  },
  {
    name: 'gather-evidence',
    description: 'Failing execution: the header, the headline and the evidence tabs on one screen (dark)',
    tags: ['docs'],
    out: 'docs',
    // Execution 37 carries an attachment, a trace and a visual diff, so the
    // evidence cards are populated rather than empty. The height takes in the
    // failing step's page views at the foot of the steps table.
    route: '/test-run-cases/37',
    viewport: { width: 1560, height: 1800 },
    colorScheme: 'dark',
  },
  {
    name: 'run-timeline',
    description: 'Per-worker run timeline: hook sections over each test, wasted waits switched on (dark)',
    tags: ['docs'],
    out: 'docs',
    route: '/test-runs/2?tab=workers',
    viewport: { width: 1600, height: 1000 },
    of: '[data-shot="run-timeline"]',
    pad: 12,
    colorScheme: 'dark',
    async run({ page, shoot, settle }) {
      await page.getByRole('switch', { name: 'Show waits' }).click();
      await settle();
      await shoot();
    },
  },
  pausedTestScene(1280, 'light', ''),
  pausedTestScene(1280, 'dark', '-dark'),
  pausedTestScene(390, 'light', '-phone'),
  pausedTestScene(390, 'dark', '-phone-dark'),
  {
    name: 'run-timeline-retries',
    description:
      'A run whose failed tests were retried: the timeline at rest, with the passing retry hovered, with the first attempt of the test that failed every attempt hovered, then at phone width',
    route: '/projects',
    viewport: { width: 1280, height: 700 },
    of: '[data-shot="run-timeline"]',
    pad: 12,
    async prepare({ request, base }) {
      this.runId = await reportRetriedRun(request, base);
    },
    async run({ page, goto, settle, shoot }) {
      await goto(`/test-runs/${this.runId}?tab=workers`);
      const bars = page.locator('[data-shot="run-timeline"] [data-timeline-test]');
      await bars.first().waitFor({ timeout: 60000 });
      await settle();
      await shoot();
      // The tooltip is fixed to the viewport and hangs below the timeline's box,
      // so a hovered capture clips to the two together.
      const shootWithTooltip = async (label) => {
        const boxes = [
          await page.locator('[data-shot="run-timeline"]').boundingBox(),
          await page.getByTestId('timeline-tooltip').boundingBox(),
        ];
        const viewport = page.viewportSize();
        const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 12);
        const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 12);
        const right = Math.min(viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + 12);
        const bottom = Math.min(viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + 12);
        await shoot(label, { of: false, clip: { x, y, width: right - x, height: bottom - y } });
      };
      const hoverBar = async (title, attempt) => {
        const box = await page
          .locator(`[data-shot="run-timeline"] [data-timeline-test][data-title="${title}"][data-attempt="${attempt}"]`)
          .first()
          .boundingBox();
        await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
        await page.getByTestId('timeline-tooltip-attempts').waitFor();
      };
      await hoverBar('applies a discount code', 2);
      await shootWithTooltip('passing-retry');
      await hoverBar('pays with a saved card', 1);
      await shootWithTooltip('failed-attempt');
      await page.mouse.move(0, 0);
      await page.setViewportSize({ width: 390, height: 700 });
      await settle();
      await hoverBar('pays with a saved card', 3);
      await shootWithTooltip('narrow');
      await page.mouse.move(0, 0);
    },
    outputs: [
      'run-timeline-retries.png',
      'run-timeline-retries-passing-retry.png',
      'run-timeline-retries-failed-attempt.png',
      'run-timeline-retries-narrow.png',
    ],
  },
  {
    name: 'run-timeline-resources',
    description:
      "The leaky run's workers timeline with the CPU, memory and open-pages tracks above the rows: hovered, with memory turned off, with each worker's open pages and each test's CPU under its row, then at phone width",
    // Web Dashboard's newest run is the seed's leaky one: its pages pile up test after test.
    route: '/test-runs/62?tab=workers',
    viewport: { width: 1280, height: 900 },
    of: '[data-shot="run-timeline"]',
    pad: 12,
    async run({ page, shoot, settle }) {
      const band = page.getByTestId('timeline-resource-band').first();
      await band.waitFor({ timeout: 60000 });
      await settle();
      const box = await band.boundingBox();
      await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.5);
      await page.getByTestId('timeline-resource-tooltip').waitFor();
      await shoot('hover');
      await page.mouse.move(0, 0);
      // The menu's two groups name some items alike: the tracks above the rows come first.
      const menuItem = (name, group) => page.getByRole('menuitemcheckbox', { name, exact: true })[group]();
      const choose = async (name, group) => {
        await page.getByTestId('timeline-resources-menu').click();
        await menuItem(name, group).click();
        await page.keyboard.press('Escape');
        await page.mouse.move(0, 0);
        await settle();
      };
      await choose('Memory', 'first');
      await shoot('toggled');
      // Back on, so the next visit starts from every track shown.
      await choose('Memory', 'first');
      await choose('Open pages', 'last');
      await shoot('worker-pages');
      await choose('CPU', 'last');
      await shoot('worker-cpu');
      await choose('Nothing', 'last');
      await page.setViewportSize({ width: 390, height: 900 });
      await settle();
      await shoot('narrow');
    },
    outputs: [
      'run-timeline-resources-hover.png',
      'run-timeline-resources-toggled.png',
      'run-timeline-resources-worker-pages.png',
      'run-timeline-resources-worker-cpu.png',
      'run-timeline-resources-narrow.png',
    ],
  },
  {
    name: 'run-timeline-resources-live',
    description:
      "A run still going: the CPU, memory and open-pages tracks drawn as the reporter sends them, with each worker's open pages under its row, then each running test's worker values on the Tests tab, at 1280 px and at phone width",
    route: '/projects',
    viewport: { width: 1280, height: 900 },
    of: '[data-shot="run-timeline"]',
    pad: 12,
    async prepare({ request, base }) {
      this.runId = await reportLiveRunWithResources(request, base);
    },
    async run({ page, goto, shoot, settle }) {
      await goto(`/test-runs/${this.runId}?tab=workers`);
      await page.getByTestId('timeline-resource-band').first().waitFor({ timeout: 60000 });
      await page.getByTestId('timeline-resources-menu').click();
      await page.getByRole('menuitemcheckbox', { name: 'Open pages', exact: true }).last().click();
      await page.keyboard.press('Escape');
      await page.mouse.move(0, 0);
      await settle();
      await shoot();
      await page.setViewportSize({ width: 390, height: 900 });
      await settle();
      await shoot('narrow');
      // Back to no strip, so the next visit starts as the timeline does by default.
      await page.getByTestId('timeline-resources-menu').click();
      await page.getByRole('menuitemcheckbox', { name: 'Nothing', exact: true }).click();
      // The Tests tab: each running test shows what its worker uses right now.
      const list = '[data-shot="failure-clusters"]';
      for (const [width, label] of [
        [1280, 'tests'],
        [390, 'tests-narrow'],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await goto(`/test-runs/${this.runId}?tab=test-cases`);
        await page.getByTestId('live-worker-resources').first().waitFor({ timeout: 60000 });
        // A wide list follows the live run to its newest rows; on a phone the
        // page scrolls instead, so the newest rows are put first there.
        const newestFirst = width < 640;
        if (newestFirst) await page.getByRole('button', { name: 'Sorted ascending' }).click();
        await settle();
        await shoot(label, { of: list });
        if (newestFirst) await page.getByRole('button', { name: 'Sorted descending' }).click();
      }
    },
    outputs: [
      'run-timeline-resources-live.png',
      'run-timeline-resources-live-narrow.png',
      'run-timeline-resources-live-tests.png',
      'run-timeline-resources-live-tests-narrow.png',
    ],
  },
  {
    name: 'run-timeline-resources-worker-strip',
    description: "The leaky run's timeline with each test's CPU under its worker's row, one test's strip hovered",
    route: '/test-runs/62?tab=workers',
    viewport: { width: 1280, height: 900 },
    // A whole-page capture: cropping to the timeline hides what is around it,
    // which moves the 10px strip out from under the pointer.
    async run({ page, shoot, settle }) {
      await page.getByTestId('timeline-resource-band').first().waitFor({ timeout: 60000 });
      await page.getByTestId('timeline-resources-menu').click();
      await page.getByRole('menuitemcheckbox', { name: 'CPU', exact: true }).last().click();
      await page.keyboard.press('Escape');
      await settle();
      const strip = page.getByTestId('timeline-worker-strip').nth(1);
      const box = await strip.boundingBox();
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
      await page.getByTestId('timeline-worker-strip-tooltip').waitFor();
      await shoot();
      // Back to no strip, so the next visit starts as the timeline does by default.
      await page.mouse.move(0, 0);
      await page.getByTestId('timeline-resources-menu').click();
      await page.getByRole('menuitemcheckbox', { name: 'Nothing', exact: true }).click();
    },
  },
  {
    name: 'run-timeline-resources-sharded',
    description:
      "A run sharded over two machines: each shard's CPU, memory and open-pages tracks above its own worker rows, the second shard's hovered",
    // The Web Dashboard run before the leaky one ran as two shards, each with its own resource report.
    route: '/test-runs/63?tab=workers',
    viewport: { width: 1280, height: 1000 },
    of: '[data-shot="run-timeline"]',
    pad: 12,
    async run({ page, shoot, settle }) {
      const band = page.getByTestId('timeline-resource-band').nth(1);
      await band.waitFor({ timeout: 60000 });
      await settle();
      const box = await band.boundingBox();
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
      await page.getByTestId('timeline-resource-tooltip').waitFor();
      await shoot();
    },
  },
  {
    name: 'ai-diagnosis',
    description:
      'Failure cluster page: the AI diagnosis, as the card under the situation block when the next step comes from it, else unfolded in More ways to fix (dark)',
    tags: ['docs'],
    out: 'docs',
    // Cluster 10 ships a stored, "diagnosis-verified" diagnosis in the demo seed.
    route: '/failure-clusters/10',
    viewport: { width: 1600, height: 1600 },
    of: '[data-shot="cluster-diagnosis"]',
    pad: 12,
    colorScheme: 'dark',
    run: openClusterDiagnosis,
    // The stored diagnosis renders with or without a provider, but run this
    // scene with the server's AI env vars set (PIWI_AI_PROVIDER / PIWI_AI_API_KEY
    // / PIWI_AI_MODEL) so the illustration shows the configured panel (Re-diagnose
    // and History, no "not configured" line); the model is never called because
    // cluster 10's diagnosis is already stored in the demo seed.
  },
  {
    name: 'flaky-detection',
    description: 'Flaky tests tab: composite score, failure rate, retry passes, flip counts',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/1?tab=flaky-tests',
    // Wide enough that the table lays out without its horizontal scroller —
    // the Root cause and Last flake columns the caption promises are the first
    // ones a narrower viewport cuts off.
    viewport: { width: 1800, height: 1000 },
    of: '[data-shot="flaky-table"]',
    pad: 12,
    prepare: classifyFlakyTests,
  },
  {
    name: 'run-changes',
    description: 'Run Changes tab: one baseline, new failures, fixed, slower/faster and commits since',
    tags: ['docs'],
    out: 'docs',
    route: '/test-runs/2?tab=changes',
    viewport: { width: 1280, height: 1560 },
    of: '[data-shot="run-changes"]',
    pad: 12,
  },
  {
    name: 'performance-trends',
    description: 'Performance tab: duration trend chart above the slowest-tests table',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/1?tab=performance',
    viewport: { width: 1400, height: 1480 },
    charts: true,
    of: ['[data-shot="performance-trend"]', '[data-shot="slowest-tests"]'],
    pad: 12,
  },
  {
    name: 'failure-clusters',
    description: 'Run page Tests tab grouped by failure cluster, failures first',
    tags: ['docs'],
    out: 'docs',
    // The run's Tests tab opens grouped by cluster on a red run; each group
    // header names the cluster and its triage status, with the failing rows
    // beneath and the passing tests folded away.
    route: '/test-runs/2',
    viewport: { width: 1280, height: 1000 },
    of: '[data-shot="failure-clusters"]',
    pad: 12,
  },
  {
    name: 'test-case-detail',
    description: 'Test history: facts line, duration trend with the execution strip, recent executions',
    tags: ['docs'],
    out: 'docs',
    route: '/test-cases/1',
    viewport: { width: 1280, height: 1600 },
    charts: true,
    of: '[data-shot="test-case-detail"]',
    pad: 8,
  },
  {
    name: 'home',
    description: 'Home overview, light/dark diagonal split (docs gallery hero)',
    tags: ['docs'],
    out: 'docs',
    route: '/',
    viewport: { width: 1280, height: 720 },
    // Captured at 2x and written at the width the featured tile actually gets,
    // so the hero is never upscaled and its text stays crisp.
    deviceScaleFactor: 2,
    outputWidth: 1152,
    split: true,
    async run({ page, shoot, settle }) {
      // The seeded data has partial runs, which the default filter hides. Include
      // them so the hero leads with the dashboard's own numbers; the choice rides
      // in a cookie, so the split's reloads keep it.
      const includePartial = page.getByRole('button', { name: 'Include partial runs' });
      if (await includePartial.count()) {
        await includePartial.first().click();
        await settle();
      }
      await shoot();
    },
  },
  {
    name: 'project-detail',
    description: 'Project detail: run trend bars over the filtered run history (docs gallery)',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/1',
    viewport: { width: 1280, height: 720 },
    charts: true,
  },
  {
    name: 'performance',
    description: 'Performance tab: per-run duration trend over the slowest tests (docs gallery)',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/1?tab=performance',
    viewport: { width: 1280, height: 720 },
    charts: true,
  },
  {
    name: 'projects',
    description: 'Projects list: every project with its latest run, status bar and tags (docs gallery)',
    tags: ['docs'],
    out: 'docs',
    route: '/projects',
    viewport: { width: 1280, height: 720 },
  },
  {
    name: 'failure-clusters-tab',
    description:
      'Failures tab: the failure inbox, one row per cluster of tests that failed for the same reason (docs gallery)',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/1?tab=failures',
    viewport: { width: 1280, height: 720 },
  },
  {
    name: 'flaky-tests',
    description:
      'Failures tab, Flaky view: each intermittent test scored and ranked by the CI time it wastes (docs gallery)',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/1?tab=flaky-tests',
    viewport: { width: 1280, height: 720 },
    prepare: classifyFlakyTests,
  },
  {
    name: 'flake-lab',
    description: "Flake Lab tab: the project's experiments, each with its test, conditions and verdict",
    tags: ['docs'],
    out: 'docs',
    route: '/projects/1?tab=flake-lab',
    viewport: { width: 1280, height: 800 },
  },
  {
    name: 'bug-report',
    description: "A bug report's page: the recorded steps, the evidence and why the suite missed it",
    tags: ['docs'],
    out: 'docs',
    route: '/bug-reports/1',
    viewport: { width: 1280, height: 900 },
  },
  {
    name: 'test-selections',
    description: 'Project selections: the built-in and defined selections, each with its tests and health',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/1/selections',
    viewport: { width: 1280, height: 800 },
  },
  {
    name: 'test-functions',
    description:
      'Test functions catalog: the page-object methods and helpers extracted from the suite, with their parameters',
    tags: ['docs'],
    out: 'docs',
    route: '/projects/5/test-functions',
    viewport: { width: 1280, height: 800 },
  },
  {
    name: 'notifications',
    description: 'Settings → Notifications: email status, the channels and what each one is subscribed to',
    tags: ['docs'],
    out: 'docs',
    route: '/settings/notifications',
    viewport: { width: 1280, height: 1250 },
    prepare: prepareTeamSlackChannel,
  },
  {
    name: 'mcp-client-setup',
    description: 'MCP page: the client setup card, one tab per agent with the command or config that connects it',
    tags: ['docs'],
    out: 'docs',
    route: '/mcp',
    viewport: { width: 1280, height: 800 },
    of: '[data-shot="mcp-client-setup"]',
    pad: 12,
  },

  // ── README tour ───────────────────────────────────────────────────────────
  // The README shows these six in a two-column grid, so every one is a whole
  // screen at the same size and theme; a crop of one panel would leave the
  // grid's rows uneven. `--tag readme` recaptures the set.
  ...[
    {
      name: 'tour-run-clusters',
      description: 'Run page: the Tests tab of a red run grouped by failure cluster',
      route: '/test-runs/2',
    },
    {
      name: 'tour-ai-diagnosis',
      description: 'Failure cluster page scrolled to its stored AI diagnosis',
      // Needs a configured provider, or the card offers "Re-diagnose (configure
      // AI)": start the server with PIWI_AI_PROVIDER=anthropic and any
      // PIWI_AI_API_KEY. The stored diagnosis means no model is ever called.
      route: '/failure-clusters/10',
      prepareShot: openDiagnosisSection,
      scrollTo: '[data-shot="diagnosis-result"]',
      scrollOffset: 16,
    },
    {
      name: 'tour-execution',
      description: 'Failing execution: headline, most likely cause, next step and the evidence tabs',
      route: '/test-run-cases/37',
    },
    {
      name: 'tour-locator-healing',
      description: 'Broken locator: ranked replacements from the last passing run',
      route: '/test-run-cases/533',
      scrollTo: '[data-shot="alternative-locators"]',
    },
    {
      name: 'tour-analytics',
      description: 'Analytics: headline numbers and the health of every project',
      route: '/analytics',
      scrollTo: '[data-shot="analytics-headline"]',
      scrollOffset: 64,
      charts: true,
    },
    {
      name: 'tour-test-history',
      description: "Test history: one test's executions across every run",
      route: '/test-cases/1',
      charts: true,
    },
  ].map(({ scrollTo, scrollOffset = 72, prepareShot, ...scene }) => ({
    ...scene,
    tags: ['docs', 'readme'],
    out: 'docs',
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 2,
    outputWidth: 1280,
    colorScheme: 'light',
    ...(scrollTo && {
      async run({ page, shoot, settle }) {
        if (prepareShot) await prepareShot(page);
        const target = page.locator(scrollTo).first();
        await target.waitFor({ timeout: 90000 });
        // The dashboard scrolls inside its content panel, not the document, so
        // scrollIntoView would shift the whole layout: scroll that panel until
        // the section sits `scrollOffset` px under its top, heading in view.
        await target.evaluate((node, offset) => {
          let panel = node.parentElement;
          while (
            panel &&
            !(panel.scrollHeight > panel.clientHeight && /auto|scroll/.test(getComputedStyle(panel).overflowY))
          )
            panel = panel.parentElement;
          panel?.scrollBy(0, node.getBoundingClientRect().top - panel.getBoundingClientRect().top - offset);
        }, scrollOffset);
        await settle();
        await shoot();
      },
    }),
  })),

  // ── Feature states (report artifacts) ─────────────────────────────────────
  {
    name: 'run-kept',
    description: 'Run page of a kept run: the Kept mark in the header and who kept it, in Details',
    // Seeded run #1 is the v2.4.0 release run, kept by its release marker.
    route: '/test-runs/1',
    viewport: { width: 1280, height: 520 },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="run-kept"]').waitFor();
      await shoot('header', { of: '[data-shot="run-header"]', pad: 8 });
      await page.getByRole('button', { name: 'Details' }).click();
      await settle();
      await shoot('details');
    },
  },
  {
    name: 'run-ingest-health',
    description:
      'Run page of a run stored incomplete: the ingest notes on the facts line, and the Ingest row in Details',
    // Seeded run #4 came in over the step and console caps through the batch upload.
    route: '/test-runs/4',
    viewport: { width: 1280, height: 620 },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="run-ingest-fact"]').waitFor();
      await shoot('header', { of: '[data-shot="run-header"]', pad: 8 });
      await page.getByRole('button', { name: 'Details' }).click();
      await page.locator('[data-shot="run-ingest-health"]').waitFor();
      await settle();
      await shoot('details');
    },
  },
  // Seeded run #63's backend restarted halfway through: the run header flags its
  // coverage, Details says what the backend lost, and its commit's combined
  // coverage notes the run.
  ...[
    { suffix: '', viewport: { width: 1280, height: 900 } },
    { suffix: '-mobile', viewport: { width: 390, height: 1800 } },
  ].flatMap(({ suffix, viewport }) => [
    {
      name: `run-coverage-incomplete${suffix}`,
      description: `Run page at ${viewport.width} px of a run whose backend restarted: the Coverage incomplete flag on the facts line, and the Coverage row in Details`,
      route: '/test-runs/63',
      viewport,
      async run({ page, shoot, settle }) {
        await page.locator('[data-shot="run-coverage-incomplete"]').waitFor({ timeout: 60_000 });
        await settle();
        await shoot('header', { of: '[data-shot="run-header"]', pad: 8 });
        await page.getByRole('button', { name: 'Details' }).click();
        await page.locator('[data-shot="run-coverage-gaps"]').waitFor();
        await settle();
        await shoot('details');
      },
    },
    {
      name: `coverage-restart-note${suffix}`,
      description: `A commit’s combined coverage at ${viewport.width} px whose only run’s backend restarted: the note naming the run`,
      route: '/projects/5/coverage',
      viewport,
      async run({ page, settle, shoot }) {
        await page.locator('[data-testid="coverage-notes"] [data-note="runs-incomplete"]').waitFor({ timeout: 60_000 });
        await settle();
        await shoot(undefined, { of: '[data-shot="coverage-headline"]', pad: 8 });
      },
    },
  ]),
  {
    name: 'run-keep-modal',
    description: 'Run page menu: Keep forever… asks for an optional reason',
    route: '/test-runs/2',
    viewport: { width: 1280, height: 720 },
    async run({ page, shoot, settle }) {
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Keep forever…' }).click();
      await page.getByRole('dialog', { name: 'Keep run #2 forever' }).waitFor();
      await settle();
      await shoot();
    },
  },
  {
    name: 'project-header',
    description:
      'Project page header: name, description and tags, the Runs and Failures lines, then the Filters block with what it hides',
    // Project 3 has runs on a feature branch and partial runs, so the note counts both.
    route: '/projects/3',
    viewport: { width: 1280, height: 720 },
    async run({ page, shoot, settle }) {
      await page.getByTestId('hidden-runs').waitFor();
      await page
        .getByTestId('project-state')
        .getByText(/open cluster|Nothing open/)
        .waitFor();
      await settle();
      await shoot();
    },
  },
  {
    name: 'project-header-mobile',
    description: 'The project header at phone width, the Filters block folded to its summary, then open',
    route: '/projects/3',
    viewport: { width: 390, height: 900 },
    async run({ page, shoot, settle }) {
      await page
        .getByTestId('project-state')
        .getByText(/open cluster|Nothing open/)
        .waitFor();
      await settle();
      await shoot('folded');
      await page.getByTestId('project-filters-toggle').click();
      await settle();
      await shoot('open');
    },
    outputs: ['project-header-mobile-folded.png', 'project-header-mobile-open.png'],
  },
  {
    name: 'project-delete-progress',
    description: 'Project menu › Delete: the modal following a running deletion, phase by phase with the run count',
    route: '/projects/1',
    viewport: { width: 1280, height: 720 },
    async run({ page, shoot }) {
      await captureProjectDeleteProgress(page, () => shoot(undefined, { of: '[role="dialog"]', pad: 0 }));
    },
  },
  {
    name: 'project-delete-progress-mobile',
    description: 'The project deletion progress modal at phone width',
    route: '/projects/1',
    viewport: { width: 390, height: 844 },
    async run({ page, shoot }) {
      await captureProjectDeleteProgress(page, () => shoot());
    },
  },
  {
    name: 'runs-selection',
    description: 'Project runs table: three runs selected, with Compare waiting for two and Delete for the selection',
    route: '/projects/1',
    viewport: { width: 1280, height: 1400 },
    async run({ page, shoot }) {
      await selectNewestRuns(page, 3);
      await shoot(undefined, { of: '[data-shot="runs-table"]', pad: 8 });
    },
  },
  {
    name: 'runs-delete-progress',
    description: 'Deleting three selected runs: one done, one running, one waiting, with the count and the clock',
    route: '/projects/1',
    viewport: { width: 1280, height: 720 },
    async run({ page, shoot }) {
      await captureRunsDeleteProgress(page, () => shoot(undefined, { of: '[role="dialog"]', pad: 0 }));
    },
  },
  {
    name: 'runs-delete-progress-mobile',
    description: 'The run deletion progress modal at phone width',
    route: '/projects/1',
    viewport: { width: 390, height: 844 },
    async run({ page, shoot }) {
      await captureRunsDeleteProgress(page, () => shoot());
    },
  },
  {
    name: 'kept-runs-table',
    description: 'Project runs table: lock on kept runs, and the Kept runs only view reaching past the loaded window',
    route: '/projects/1',
    viewport: { width: 1280, height: 1400 },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="kept-runs-toggle"]').waitFor();
      await shoot('all', { of: '[data-shot="runs-table"]', pad: 8 });
      await page.locator('[data-shot="kept-runs-toggle"]').click();
      await settle();
      await shoot('kept-only', { of: '[data-shot="runs-table"]', pad: 8 });
    },
  },
  {
    name: 'kept-runs-table-mobile',
    description: 'Project runs cards at phone width: the lock on kept runs and the Kept runs only toggle',
    route: '/projects/1',
    viewport: { width: 390, height: 1400 },
    async run({ page, shoot, settle }) {
      await page.locator('[data-shot="kept-runs-toggle"]').waitFor();
      await page.locator('[data-shot="kept-runs-toggle"]').click();
      await settle();
      await shoot(undefined, { of: '[data-shot="runs-table"]', pad: 4 });
    },
  },
  {
    name: 'kept-runs-storage',
    description: 'Settings › Storage cleanup card: how many runs are kept and what their files hold',
    route: '/settings/storage',
    viewport: { width: 1280, height: 1600 },
    async run({ page, shoot }) {
      await page.locator('[data-shot="kept-runs-note"]').waitFor();
      await shoot(undefined, { of: '[data-shot="cleanup-card"]', pad: 8 });
    },
  },

  {
    name: 'attempt-diff',
    description: 'Attempts tab: every attempt, and what differed between the failing and passing attempt',
    // Execution 21 is a flaky test that passed on retry, so the Attempts tab holds a diff.
    route: '/test-run-cases/21',
    viewport: { width: 1280, height: 1000 },
    of: '[data-shot="attempts-diff"]',
    pad: 12,
    async run({ shoot, openTab }) {
      await openTab('Attempts');
      await shoot();
    },
  },
  {
    name: 'execution-history',
    description: "Execution page: the History block, this test's recent executions as a strip",
    route: '/test-run-cases/229',
    viewport: { width: 1280, height: 1000 },
    of: '[data-shot="execution-history"]',
    pad: 12,
  },
  {
    name: 'run-trend',
    description: 'Test runs tab: per-run stacked result bars with day ticks and markers',
    route: '/projects/1',
    viewport: { width: 1400, height: 900 },
    charts: true,
    of: '[data-shot="run-trend"]',
    pad: 12,
  },
  {
    name: 'run-trend-marker-tooltip',
    description:
      'Run trend: hovering a timeline marker line shows its category, label, date, environment and description',
    tags: ['desktop'],
    route: '/projects/1',
    viewport: { width: 1400, height: 900 },
    charts: true,
    async run({ page, settle, shoot }) {
      const marker = page.locator('[data-shot="run-trend"] [data-testid="chart-marker"]').nth(4);
      await marker.waitFor({ timeout: 60_000 });
      await settle();
      const box = await marker.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.getByTestId('chart-marker-tooltip').waitFor();
      const boxes = [
        await page.locator('[data-shot="run-trend"]').boundingBox(),
        await page.getByTestId('chart-marker-tooltip').boundingBox(),
      ];
      const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 12);
      const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 12);
      const right = Math.max(...boxes.map((b) => b.x + b.width)) + 12;
      const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 12;
      await shoot('', { of: false, clip: { x, y, width: right - x, height: bottom - y } });
    },
  },
  markersPanelScene(1280, ''),
  markersPanelScene(390, '-mobile'),
  {
    name: 'run-skip-kinds',
    description: 'Run page: the count bar draws skipped and fixme in two greys; the Tests list filters by tag',
    route: '/test-runs/2',
    viewport: { width: 1280, height: 900 },
    async run({ page, shoot, settle }) {
      await shoot('header', { of: '[data-shot="run-header"]', pad: 12 });
      await page.getByRole('button', { name: '1 fixme' }).first().click();
      await settle();
      await shoot('fixme-filter');
      await page.getByRole('button', { name: '1 fixme' }).first().click();
      await page.getByRole('combobox', { name: 'Search tests' }).fill('tag:critical');
      await page.keyboard.press('Escape');
      await settle();
      await shoot('tag-filter');
    },
  },
  {
    name: 'run-skip-kinds-dark',
    description: 'Run page header in dark mode: the fixme grey stays the lighter, more visible one',
    route: '/test-runs/2',
    viewport: { width: 1280, height: 900 },
    colorScheme: 'dark',
    of: '[data-shot="run-header"]',
    pad: 12,
  },
  {
    name: 'run-skip-kinds-mobile',
    description:
      'Run page at phone width: the two skipped greys on the count bar, and the search box with the New regressions and Newly flaky toggles',
    route: '/test-runs/2',
    viewport: { width: 390, height: 1400 },
  },
  {
    name: 'run-count-bar-active',
    description:
      'Run page count bar: a selected segment carries a ring and the others fade, in the middle and at both ends, and a narrow one widens to its whole label',
    // Seeded run #2 has one test passed on retry: its segment is too narrow for the
    // whole label until it is selected.
    route: '/test-runs/2',
    viewport: { width: 1280, height: 900 },
    async run({ page, shoot, settle }) {
      const header = page.locator('[data-shot="run-header"]');
      const segment = (name) => header.getByRole('button', { name });
      await segment('3 failed').click();
      await settle();
      await shoot('middle', { of: '[data-shot="run-header"]', pad: 12 });
      await segment('3 failed').click();
      await segment('6 passed').click();
      await segment('1 fixme').click();
      await settle();
      await shoot('ends', { of: '[data-shot="run-header"]', pad: 12 });
      await segment('6 passed').click();
      await segment('1 fixme').click();
      await segment(/^1 (flaky, )?passed on retry$/).click();
      await settle();
      await shoot('narrow', { of: '[data-shot="run-header"]', pad: 12 });
    },
  },
  {
    name: 'catalog-filters',
    description:
      'Project Tests catalog: the search box and status chips, and the list header grouping by file and describe block with a filter on',
    route: '/projects/1?tab=tests',
    viewport: { width: 1280, height: 1100 },
    async run({ page, shoot, settle }) {
      await shoot('flat', { of: '[data-shot="test-cases-catalog"]', pad: 12 });
      await page.getByRole('combobox', { name: 'Group tests by' }).click();
      await page.getByRole('option', { name: 'File + Describe' }).click();
      await page.getByRole('button', { name: 'Skipped', exact: true }).click();
      await settle();
      await shoot('grouped-filtered', { of: '[data-shot="test-cases-catalog"]', pad: 12 });
      // Leave the group-by cookie as the next capture expects it.
      await page.getByRole('combobox', { name: 'Group tests by' }).click();
      await page.getByRole('option', { name: 'None' }).click();
    },
  },
  {
    name: 'test-search',
    description:
      'Run Tests tab search: the qualifiers on focus, a file: value completed, the matches marked in the list, and the same box on the project catalog',
    route: '/test-runs/2',
    viewport: { width: 1280, height: 900 },
    async run({ page, shoot, settle }) {
      const search = page.getByRole('combobox', { name: 'Search tests' });
      await page.keyboard.press('Control+f');
      await search.waitFor();
      await shoot('qualifiers');
      await page.keyboard.type('file:car');
      await page.getByRole('option').first().waitFor();
      await shoot('completion');
      await page.keyboard.press('Enter');
      await page.keyboard.type('discount');
      await page.keyboard.press('Escape');
      await settle();
      await shoot('highlighted');
      await page.goto(page.url().replace(/\/test-runs\/.*$/, '/projects/1?tab=tests&q=describe%3ACart'));
      await settle();
      await shoot('catalog', { of: '[data-shot="test-cases-catalog"]', pad: 12 });
    },
  },
  {
    name: 'test-search-mobile',
    description: 'Run Tests tab at phone width: the search box completing a describe: value',
    route: '/test-runs/2',
    viewport: { width: 390, height: 1100 },
    async run({ page, shoot }) {
      await page.getByRole('combobox', { name: 'Search tests' }).click();
      await page.keyboard.type('describe:');
      await page.getByRole('option').first().waitFor();
      await shoot();
    },
  },
  {
    name: 'runs-table-skip-kinds',
    description: 'Project runs table: each run bar splits its skipped tests into skipped and fixme',
    route: '/projects/1',
    viewport: { width: 1400, height: 1500 },
    of: '[data-shot="runs-table"]',
    pad: 12,
  },
  {
    name: 'run-live-activity',
    description: 'Run page while live: each still-running row shows the step its worker is on',
    route: '/projects',
    viewport: { width: 1280, height: 900 },
    async prepare({ request, base }) {
      // Start a streaming run; the events are pushed after the page subscribes
      // to the run stream (the in-memory bus only delivers to live subscribers).
      const started = await (
        await request.post(`${base}/api/test-runs/start`, {
          data: { projectName: 'web-dashboard', startTime: new Date().toISOString() },
        })
      ).json();
      this.runId = started.runId;
      this.streamToken = started.streamToken;
    },
    async run({ page, base, shoot, goto }) {
      await goto(`/test-runs/${this.runId}`);
      // The dev server compiles an API route on its first hit, which can take a
      // while; retry the push until it lands, then let the rows render. One
      // completed row sits above the running ones so the shot shows the live
      // step readout in contrast with a finished test.
      const events = [
        {
          type: 'begin',
          title: 'guest checkout keeps the cart',
          location: 'tests/checkout.spec.ts:5:3',
          workerIndex: 0,
          startedAt: Date.now() - 9_500,
          browser: { projectName: 'chromium' },
        },
        {
          type: 'complete',
          title: 'guest checkout keeps the cart',
          location: 'tests/checkout.spec.ts:5:3',
          status: 'passed',
          duration: 8_400,
          workerIndex: 0,
          startedAt: Date.now() - 9_500,
          browser: { projectName: 'chromium' },
        },
        {
          type: 'begin',
          title: 'purchase flow submits the order',
          location: 'tests/checkout.spec.ts:12:5',
          workerIndex: 0,
          startedAt: Date.now(),
          browser: { projectName: 'chromium' },
        },
        {
          type: 'step-begin',
          title: 'Click',
          subtitle: "getByRole('button', { name: 'Place order' })",
          location: 'tests/checkout.spec.ts:14:5',
          stepCategory: 'pw:api',
          parentTitle: 'purchase flow submits the order',
          workerIndex: 0,
          startedAt: Date.now(),
        },
        {
          type: 'begin',
          title: 'filters apply to the product grid',
          location: 'tests/catalog.spec.ts:8:3',
          workerIndex: 1,
          startedAt: Date.now(),
          browser: { projectName: 'chromium' },
        },
        {
          type: 'step-end',
          title: 'clicking "Apply filters"',
          location: 'tests/catalog.spec.ts:11:5',
          stepCategory: 'pw:api',
          status: 'passed',
          duration: 240,
          parentTitle: 'filters apply to the product grid',
          workerIndex: 1,
          startedAt: Date.now(),
        },
        {
          type: 'step-begin',
          title: 'waiting for the result count to be visible',
          location: 'tests/catalog.spec.ts:13:5',
          stepCategory: 'expect',
          parentTitle: 'filters apply to the product grid',
          workerIndex: 1,
          startedAt: Date.now(),
        },
      ];
      let pushed = false;
      for (let attempt = 0; attempt < 5 && !pushed; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          const res = await page.request.post(`${base}/api/test-runs/${this.runId}/events`, {
            data: { streamToken: this.streamToken, testCases: events },
          });
          pushed = res.ok();
        } catch {
          // Route still compiling — retry.
        }
      }
      if (!pushed) throw new Error(`could not push step events to run ${this.runId}`);
      // The card and grid layouts both carry the testid; wait for the visible
      // one (the grid row at this width, not the `md:hidden` card copy).
      await page.locator('[data-testid="live-step"]:visible').first().waitFor({ timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await shoot();
    },
  },

  {
    name: 'step-params',
    description: "Whole-test steps table: a step's muted subtitle and its parameters, opened from its title",
    route: '/projects',
    viewport: { width: 1280, height: 2400 },
    of: 'table',
    pad: 12,
    async run({ page, base, goto, shoot }) {
      // Find a failing execution whose steps carry the 1.63 params shape, then
      // open its Timeline tab on the whole test and open the first step's parameters.
      const projects = await (await page.request.get(`${base}/api/projects`)).json();
      const projectList = Array.isArray(projects) ? projects : (projects.items ?? projects.projects ?? []);
      let execId = null;
      outer: for (const project of projectList) {
        const detail = await (await page.request.get(`${base}/api/projects/${project.id}`)).json();
        for (const run of detail.testRuns ?? []) {
          const runDetail = await (await page.request.get(`${base}/api/test-runs/${run.id}`)).json();
          for (const c of runDetail.testCases ?? []) {
            if (c.status !== 'failed' || !c.executionId) continue;
            const exec = await (await page.request.get(`${base}/api/test-run-cases/${c.executionId}`)).json();
            if ((exec.steps ?? []).some((s) => s && s.params && Object.keys(s.params).length > 0)) {
              execId = c.executionId;
              break outer;
            }
          }
        }
      }
      if (!execId) throw new Error('no execution with 1.63 step params found for the step-params scene');
      await goto(`/test-run-cases/${execId}`);
      await page.getByRole('tab', { name: /^Timeline/ }).click();
      const whole = page.getByRole('button', { name: 'Whole test' });
      if (await whole.count()) await whole.click();
      await page.locator('table [data-testid="step-params-toggle"]:visible').first().click();
      await page.locator('table [data-testid="step-params"]:visible').first().waitFor({ timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      await shoot();
    },
  },

  {
    name: 'page-diff',
    description: 'Screen tab: the Page diff view, the structural diff of the failing page',
    // Execution 37 (checkout) has a green ARIA sample and a failing one that
    // renames the "Pay" button and disables it — a legible one-line diff.
    route: '/test-run-cases/37',
    viewport: { width: 1280, height: 1200 },
    of: '[data-shot="screen-evidence"]',
    pad: 12,
    async run({ page, shoot, settle }) {
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Screen', exact: true })
        .click();
      const toggle = page.getByRole('tablist', { name: 'Screen view' }).getByRole('tab', { name: 'Page diff' });
      await toggle.waitFor({ state: 'visible', timeout: 30_000 });
      await toggle.click();
      await settle();
      await shoot();
    },
  },
  ...[
    { view: 'Screenshot', suffix: '' },
    { view: 'DOM', suffix: '-dom' },
    { view: 'Accessibility tree', suffix: '-aria' },
  ].map(({ view, suffix }) => ({
    name: `failing-step-evidence${suffix}`,
    description: `Timeline tab: the page at the failing step on its ${view} view, in the step's block`,
    viewport: { width: 1280, height: 1600 },
    of: 'table',
    pad: 12,
    async prepare({ request, base }) {
      this.executionId = await ingestTraceSnapshotCase(request, base);
    },
    async run({ page, goto, settle, shoot }) {
      await goto(`/test-run-cases/${this.executionId}`);
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Timeline', exact: true })
        .click();
      const tab = page
        .locator('table')
        .getByRole('tablist', { name: 'Page at the failing step' })
        .getByRole('tab', { name: view, exact: true });
      await tab.waitFor({ state: 'visible', timeout: 30_000 });
      await tab.click();
      if (view === 'DOM') await page.locator('table iframe[title="DOM at the failure"]').waitFor({ timeout: 15000 });
      await settle();
      await shoot();
    },
  })),
  {
    name: 'failing-step-picker',
    description: "Timeline tab: Open in picker on the failing step's page, the picker over the DOM of that moment",
    viewport: { width: 1280, height: 1000 },
    async prepare({ request, base }) {
      this.executionId = await ingestTraceSnapshotCase(request, base);
    },
    async run({ page, goto, settle, shoot }) {
      await goto(`/test-run-cases/${this.executionId}`);
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Timeline', exact: true })
        .click();
      await page.locator('table').getByRole('button', { name: 'Open in picker' }).click();
      await page.getByRole('dialog').locator('iframe[title="DOM snapshot"]').waitFor({ timeout: 15000 });
      await page.getByText('Initializing picker').waitFor({ state: 'detached', timeout: 15000 });
      await settle();
      await shoot();
    },
  },
  {
    name: 'failing-step-evidence-mobile',
    description: "Failing step's page at phone width, on its Screenshot view",
    viewport: { width: 390, height: 1800 },
    of: '[data-shot="failing-step-evidence"]',
    pad: 12,
    async prepare({ request, base }) {
      this.executionId = await ingestTraceSnapshotCase(request, base);
    },
    async run({ page, goto, settle, shoot }) {
      await goto(`/test-run-cases/${this.executionId}`);
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Timeline', exact: true })
        .click();
      await page.locator('[data-shot="failing-step-evidence"]').waitFor({ state: 'visible', timeout: 30_000 });
      await settle();
      await shoot();
    },
  },
  {
    name: 'failing-step-evidence-fallback',
    description:
      "Failing step evidence on a pre-1.63 trace: the run's failure screenshot bound to the failing step, with the failure-time DOM and tree as views",
    route: '/projects',
    viewport: { width: 1280, height: 2000 },
    of: 'table',
    pad: 12,
    async run({ page, base, goto, settle, shoot }) {
      // Find a failed execution whose steps carry a failing step and whose case
      // has an image attachment — the seeded demo traces predate 1.63, so the
      // failing step falls back to the run's failure screenshot.
      const projects = await (await page.request.get(`${base}/api/projects`)).json();
      const projectList = Array.isArray(projects) ? projects : (projects.items ?? projects.projects ?? []);
      let execId = null;
      outer: for (const project of projectList) {
        const detail = await (await page.request.get(`${base}/api/projects/${project.id}`)).json();
        for (const run of detail.testRuns ?? []) {
          const runDetail = await (await page.request.get(`${base}/api/test-runs/${run.id}`)).json();
          for (const c of runDetail.testCases ?? []) {
            if (c.status !== 'failed' || !c.executionId) continue;
            const exec = await (await page.request.get(`${base}/api/test-run-cases/${c.executionId}`)).json();
            const hasFailedStep = (exec.steps ?? []).some((s) => s && s.failed);
            const hasImage = (exec.attachments ?? []).some(
              (a) => (a.contentType ?? '').startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(a.path ?? ''),
            );
            if (hasFailedStep && hasImage) {
              execId = c.executionId;
              break outer;
            }
          }
        }
      }
      if (!execId)
        throw new Error('no failed execution with a failing step and an image attachment for the fallback scene');
      await goto(`/test-run-cases/${execId}`);
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Timeline', exact: true })
        .click();
      await page
        .locator('table')
        .getByText('Page at the failing step')
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });
      await settle();
      await shoot();
    },
  },
  ...['', '-mobile'].map((suffix) => ({
    name: `hook-failure-timeline${suffix}`,
    description: suffix
      ? 'The hook-failure timeline at phone width: the Setup section as stacked cards'
      : 'Timeline tab of a test whose beforeEach failed: the Setup section open on the failing click, Teardown folded',
    route: '/projects',
    viewport: suffix ? { width: 375, height: 2400 } : { width: 1280, height: 1800 },
    of: '[data-shot="evidence-card"]',
    pad: suffix ? 8 : 12,
    async prepare({ request, base }) {
      this.executionId = await reportHookFailure(request, base);
    },
    async run({ page, goto, settle, shoot }) {
      await goto(`/test-run-cases/${this.executionId}`);
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Timeline', exact: true })
        .click();
      await page
        .locator('[data-shot="evidence-card"] button[aria-expanded="true"]:visible', { hasText: 'Setup' })
        .first()
        .waitFor({ timeout: 30_000 });
      await settle();
      await shoot();
    },
  })),
  ...['', '-mobile'].map((suffix) => ({
    name: `caught-error-timeline${suffix}`,
    description: suffix
      ? 'The timeline at phone width: a probe the test caught greyed out, the failing assertion in red'
      : 'Timeline tab of a test that caught a probe then failed: the probe greyed out as caught, the failing assertion red',
    route: '/projects',
    viewport: suffix ? { width: 375, height: 2400 } : { width: 1280, height: 1400 },
    of: '[data-shot="evidence-card"]',
    pad: suffix ? 8 : 12,
    async prepare({ request, base }) {
      this.executionId = await reportCaughtError(request, base);
    },
    async run({ page, goto, settle, shoot }) {
      await goto(`/test-run-cases/${this.executionId}`);
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Timeline', exact: true })
        .click();
      await page
        .locator('[data-shot="evidence-card"]')
        .getByText('Error caught, the test continued')
        .filter({ visible: true })
        .first()
        .waitFor({ timeout: 30_000 });
      await settle();
      await shoot();
    },
  })),
  // Suspect lines: cluster 5's newest failing run carries coverage. A dev
  // server cannot read the demo's canned repositories, so these scenes serve
  // the demo's own answers (`lib/suspect-lines-scene.mjs`, checked against the
  // demo handlers by a unit test): the What changed line, then the card's list
  // and the diff marking them, on the cluster page; the line on its execution.
  ...[
    { suffix: '', viewport: { width: 1280, height: 1600 }, pad: 12 },
    { suffix: '-mobile', viewport: { width: 375, height: 2600 }, pad: 8 },
  ].map(({ suffix, viewport, pad }) => ({
    name: `cluster-suspect-lines${suffix}`,
    description: `Cluster page with suspect lines: the What changed line names the first, the card lists them and marks them in the diff, at ${viewport.width} px`,
    route: '/',
    viewport,
    async run({ page, goto, settle, shoot }) {
      await serveSuspectLinesScene(page);
      await goto(`/failure-clusters/${SUSPECT_SCENE_CLUSTER.id}`);
      await page.locator('[data-shot="suspect-lines-sentence"]').waitFor({ timeout: 60_000 });
      await page.locator('[data-shot="suspect-lines"]').waitFor({ timeout: 60_000 });
      await page.locator('[data-suspect]').first().waitFor({ timeout: 30_000 });
      await settle();
      await shoot('line', { of: '[data-shot="situation-block"]', pad });
      await shoot('card', { of: '[data-shot="what-changed-card"]', pad });
    },
    outputs: [`cluster-suspect-lines${suffix}-line.png`, `cluster-suspect-lines${suffix}-card.png`],
  })),
  // The execution page's Coverage section: execution 711, whose run carries
  // server coverage of the web dashboard's ASP.NET Core API. A dev server
  // cannot read the demo's canned repositories, so these scenes serve the
  // demo's own suspect lines and sources (`lib/coverage-scene.mjs`, checked
  // against the demo handlers by a unit test). The users endpoints open on
  // their source, the lines the test ran marked and the executable lines it
  // did not run in the lighter mark.
  {
    name: 'execution-coverage',
    description:
      'Execution page, Source tab: the Coverage section with the users endpoints unfolded to their source, the lines the test ran and the executable lines it did not run marked',
    tags: ['docs'],
    out: 'docs',
    route: '/',
    viewport: { width: 1280, height: 2800 },
    async run({ page, goto, settle, shoot }) {
      await openCoverageScene(page, goto, settle);
      await shoot(undefined, { of: '[data-shot="execution-coverage"]', pad: 12 });
    },
  },
  ...[
    { suffix: 'wide', viewport: { width: 1280, height: 2800 }, pad: 12 },
    { suffix: 'mobile', viewport: { width: 390, height: 4400 }, pad: 8 },
  ].map(({ suffix, viewport, pad }) => ({
    name: `execution-coverage-${suffix}`,
    description: `Execution page at ${viewport.width} px with the Source tab's Coverage section, the users endpoints unfolded: the section, then the whole page`,
    route: '/',
    viewport,
    async run({ page, goto, settle, shoot }) {
      await openCoverageScene(page, goto, settle);
      await shoot('section', { of: '[data-shot="execution-coverage"]', pad });
      await shoot('page');
    },
    outputs: [`execution-coverage-${suffix}-section.png`, `execution-coverage-${suffix}-page.png`],
  })),
  // A passing test of the same run, `invites a user by email`: the backend
  // files it ran, recorded by line, and the session handler unfolded to the
  // lines it ran and the executable lines it did not.
  {
    name: 'server-coverage',
    description:
      'Execution page, Source tab: the server files one test ran, recorded by line, with the session handler unfolded to its source',
    tags: ['docs'],
    out: 'docs',
    route: '/',
    viewport: { width: 1280, height: 1600 },
    async run({ page, goto, settle, shoot }) {
      await serveCoverageSceneSource(page);
      await goto(`/test-run-cases/${SERVER_COVERAGE_SCENE_EXECUTION}?evidence=source`);
      const section = page.locator('[data-shot="execution-coverage"]');
      await section
        .getByRole('button', { name: 'Show the source of api/Auth/SessionAuthenticationHandler.cs' })
        .click({ timeout: 60_000 });
      await section.locator('[data-coverage-source] [data-not-executed]').first().waitFor({ timeout: 30_000 });
      await page.mouse.move(0, 0);
      await settle();
      await shoot(undefined, { of: '[data-shot="execution-coverage"]', pad: 12 });
    },
  },
  // The coverage insights, on the demo seed's order-dependent flake: Web
  // Dashboard's `toggles dark mode` fails its first attempt when `updates the
  // organization name` has not finished (`lib/coverage-insights-scene.mjs`).
  // Its failed attempt in run 68 against its last passing run, the preferences
  // endpoints unfolded to the lines only each ran; a dev server cannot read the
  // demo's canned repositories, so the scenes serve that source.
  {
    name: 'coverage-divergence',
    description:
      'Execution page, Source tab: a failed attempt compared with the test’s last passing run, the preferences endpoints unfolded to the lines only each run ran',
    tags: ['docs'],
    out: 'docs',
    route: '/',
    viewport: { width: 1280, height: 1800 },
    async run({ page, goto, settle, shoot }) {
      await openDivergenceScene(page, goto, settle);
      await shoot(undefined, { of: '[data-shot="execution-coverage-divergence"]', pad: 12 });
    },
  },
  ...[
    { suffix: 'wide', viewport: { width: 1280, height: 2000 }, pad: 12 },
    { suffix: 'mobile', viewport: { width: 390, height: 3600 }, pad: 8 },
  ].map(({ suffix, viewport, pad }) => ({
    name: `coverage-divergence-${suffix}`,
    description: `Execution page at ${viewport.width} px: the comparison with the last passing run, then the whole Coverage section`,
    route: '/',
    viewport,
    async run({ page, goto, settle, shoot }) {
      await openDivergenceScene(page, goto, settle);
      await shoot('part', { of: '[data-shot="execution-coverage-divergence"]', pad });
      await shoot('section', { of: '[data-shot="execution-coverage"]', pad });
    },
    outputs: [`coverage-divergence-${suffix}-part.png`, `coverage-divergence-${suffix}-section.png`],
  })),
  // The flake's test page: the Path variation card, which names the
  // organization test whose having finished first predicts the toggle's path.
  {
    name: 'path-variation',
    description:
      'Test page: the Path variation card of an order-dependent test, the earlier test that predicts its path and the varying code',
    tags: ['docs'],
    out: 'docs',
    route: '/',
    viewport: { width: 1280, height: 2400 },
    async run({ page, goto, settle, shoot }) {
      await openPathVariationScene(page, goto, settle);
      await shoot(undefined, { of: '[data-shot="test-path-variation"]', pad: 12 });
    },
  },
  ...[
    { suffix: 'wide', viewport: { width: 1280, height: 2400 }, pad: 12 },
    { suffix: 'mobile', viewport: { width: 390, height: 4400 }, pad: 8 },
  ].map(({ suffix, viewport, pad }) => ({
    name: `path-variation-${suffix}`,
    description: `Test page at ${viewport.width} px: the Path variation card`,
    route: '/',
    viewport,
    async run({ page, goto, settle, shoot }) {
      await openPathVariationScene(page, goto, settle);
      await shoot(undefined, { of: '[data-shot="test-path-variation"]', pad });
    },
  })),
  // The flaky list's Quarantine button on the toggle, hovered: what
  // quarantining it leaves to no other trusted test, its preferences endpoints.
  {
    name: 'quarantine-coverage-loss',
    description:
      'Flaky tests list: the Quarantine button of an order-dependent test with the code quarantining it leaves to no other trusted test',
    tags: ['docs'],
    out: 'docs',
    route: '/',
    viewport: { width: 1280, height: 1000 },
    async run({ page, goto, settle, shoot }) {
      const clip = await openQuarantineLossScene(page, goto, settle, 'hover');
      await shoot(undefined, { of: false, clip });
    },
  },
  ...[
    { suffix: 'wide', viewport: { width: 1280, height: 1000 }, reach: 'hover' },
    { suffix: 'mobile', viewport: { width: 390, height: 1400 }, reach: 'focus' },
  ].map(({ suffix, viewport, reach }) => ({
    name: `quarantine-coverage-loss-${suffix}`,
    description: `Flaky tests list at ${viewport.width} px, the toggle's Quarantine button reached by ${reach}: its coverage-loss preview`,
    route: '/',
    viewport,
    async run({ page, goto, settle, shoot }) {
      const clip = await openQuarantineLossScene(page, goto, settle, reach);
      await shoot(undefined, { of: false, clip });
    },
  })),
  // A file's coverage page: the web dashboard's users endpoints, which the
  // three users tests ran at one version. A dev server cannot read the demo's
  // canned repositories, so the scenes serve the demo's own source
  // (`lib/coverage-scene.mjs`). Line 37, which one test of the three ran, is
  // selected, so the tests panel lists that test.
  {
    name: 'coverage-file',
    description:
      'A file’s coverage page: the users endpoints with how many tests ran each line, the executable lines no test runs, and the test that ran the selected line',
    tags: ['docs'],
    out: 'docs',
    route: '/',
    viewport: { width: 1280, height: 1000 },
    async run({ page, goto, settle, shoot }) {
      await openFileCoverageScene(page, goto, settle);
      await shoot(undefined, { of: '[data-shot="coverage-file"]', pad: 12 });
    },
  },
  ...[
    { suffix: 'wide', viewport: { width: 1280, height: 1000 } },
    { suffix: 'mobile', viewport: { width: 390, height: 2200 } },
  ].map(({ suffix, viewport }) => ({
    name: `coverage-file-${suffix}`,
    description: `A file’s coverage page at ${viewport.width} px, line 37 selected: the whole page`,
    route: '/',
    viewport,
    async run({ page, goto, settle, shoot }) {
      await openFileCoverageScene(page, goto, settle);
      await shoot();
    },
  })),
  // The combined coverage of the web dashboard's covered commit: its two unit
  // reports and the Playwright run, the API files counted on the span table's
  // lines, and the two tracked files no suite names. `src/` is selected, so the
  // folder aside lists its least-covered files, and `src/components/` is open
  // to its files.
  {
    name: 'combined-coverage',
    description:
      'A project’s combined coverage page: the share of lines every suite ran at one commit, each suite’s share, and the folders with src/ open beside its least-covered files',
    tags: ['docs'],
    out: 'docs',
    route: `/projects/${COVERAGE_SCENE_PROJECT}/coverage?folder=src`,
    viewport: { width: 1280, height: 1400 },
    async run({ page, settle, shoot }) {
      const tree = page.locator('[data-testid="coverage-tree"]');
      await tree.locator('[data-entry="src/components"]').waitFor({ timeout: 60_000 });
      await tree.getByRole('button', { name: 'Open src/components' }).click();
      await tree.locator('[data-entry^="src/components/"]').first().waitFor({ timeout: 30_000 });
      await page.locator('[data-testid="coverage-least-covered"] li').first().waitFor({ timeout: 30_000 });
      await page.mouse.move(0, 0);
      await settle();
      await shoot(undefined, { of: '[data-shot="coverage-overview"]', pad: 12 });
    },
  },
  // The same commit's file view of the users endpoints, marked by suite: line
  // 40, which the back end's unit tests and the Playwright suite both ran, is
  // selected, and the lines no suite ran are one click away.
  {
    name: 'combined-coverage-file',
    description:
      'A file’s view marked by suite at the covered commit: each line by the kinds of suite that ran it, the controls that step through the lines not run, and the suites of the selected line',
    tags: ['docs'],
    out: 'docs',
    route: '/',
    viewport: { width: 1280, height: 1200 },
    async run({ page, goto, settle, shoot }) {
      await serveCoverageSceneSource(page);
      await goto(`/projects/${COVERAGE_SCENE_PROJECT}/coverage?file=api/Users/UsersEndpoints.cs&marks=suites&line=40`);
      const view = page.locator('[data-shot="coverage-file"]');
      await view.locator('[data-coverage-source] [data-line="40"][data-selected]').waitFor({ timeout: 60_000 });
      await view.getByTestId('coverage-unrun-next').waitFor({ timeout: 30_000 });
      await view.locator('[data-coverage-test]').first().waitFor({ timeout: 30_000 });
      // The source scrolls inside its own box: show ListUsers and UpdateUser, lines 28–65, and end the image there.
      const scroller = view.getByLabel('Source of api/Users/UsersEndpoints.cs');
      await scroller.evaluate((el) => {
        el.scrollTop = el.querySelector('[data-line="28"]').offsetTop - 4;
      });
      await settle();
      const box = await view.boundingBox();
      const last = await scroller.locator('[data-line="65"]').boundingBox();
      const top = box.y - 12;
      await shoot(undefined, {
        of: false,
        clip: { x: box.x - 12, y: top, width: box.width + 24, height: last.y + last.height + 4 - top },
      });
    },
  },
  // The pull-request comment's Uncovered changes section, rendered from
  // `renderChangeCoverage` with a change's patch coverage and laid out like a
  // code host's comment: no screen of the dashboard shows the comment.
  {
    name: 'uncovered-changes',
    description:
      'The pull-request comment’s Uncovered changes section: the patch coverage line, the changed files no test reaches by ticket, the changed lines no suite ran, and the files not counted',
    tags: ['docs'],
    out: 'docs',
    route: '/',
    viewport: { width: 900, height: 900 },
    async run({ page, settle, shoot }) {
      await page.setContent(await prCommentPage(await uncoveredChangesMarkdown()));
      await settle();
      await shoot(undefined, { of: '[data-shot="pr-comment"]', pad: 12 });
    },
  },
  // The Coverage trend widget of the Engineering dashboard on the web
  // dashboard alone: the thirty seeded days of combined coverage, each suite
  // as a dashed line.
  {
    name: 'combined-coverage-trend',
    description:
      'The Coverage trend widget: a month of combined line coverage, with each suite’s share as a dashed line',
    tags: ['docs'],
    out: 'docs',
    route: `/analytics/d/engineering?projects=${COVERAGE_SCENE_PROJECT}&period=last-30d`,
    viewport: { width: 1280, height: 1800 },
    async run({ page, settle, shoot }) {
      const widget = page.locator('[data-shot="analytics-coverage-trend"]');
      await widget.locator('svg path').first().waitFor({ timeout: 90_000 });
      await widget.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await settle();
      await shoot(undefined, { of: '[data-shot="analytics-coverage-trend"]', pad: 12 });
    },
  },
  // A branch's coverage after a second push: the notes above the numbers say
  // which suite it carries from the first push, and the first push keeps only
  // its totals (`reportSupersededBranch`). The wide notes image is the
  // Combined coverage card alone, the notes above its headline.
  ...[
    { suffix: '', viewport: { width: 1280, height: 1100 }, pad: 12, docs: true },
    { suffix: '-mobile', viewport: { width: 390, height: 2200 }, pad: 8, docs: false },
  ].flatMap(({ suffix, viewport, pad, docs }) => [
    {
      name: `coverage-notes${suffix}`,
      description: `A branch’s combined coverage at ${viewport.width} px: the notes callout naming the suite carried from the push before`,
      ...(docs ? { tags: ['docs'], out: 'docs' } : {}),
      route: '/projects',
      viewport,
      async prepare({ request, base }) {
        this.branch = await reportSupersededBranch(request, base);
      },
      async run({ page, goto, settle, shoot }) {
        await goto(`/projects/${this.branch.projectId}/coverage?branch=${encodeURIComponent(this.branch.branch)}`);
        await page.locator('[data-testid="coverage-notes"] [data-note="carried"]').waitFor({ timeout: 60_000 });
        await page.locator('[data-testid="coverage-tree"] [data-entry]').first().waitFor({ timeout: 60_000 });
        await settle();
        await shoot(undefined, { of: `[data-shot="${docs ? 'coverage-headline' : 'coverage-overview'}"]`, pad });
      },
    },
    {
      name: `coverage-totals-only${suffix}`,
      description: `A superseded push’s combined coverage at ${viewport.width} px: its stored totals, suites and the note that its files went`,
      route: '/projects',
      viewport,
      async prepare({ request, base }) {
        this.branch = await reportSupersededBranch(request, base);
      },
      async run({ page, goto, settle, shoot }) {
        await goto(`/projects/${this.branch.projectId}/coverage?commit=${this.branch.first}`);
        await page.locator('[data-testid="coverage-files-removed"]').waitFor({ timeout: 60_000 });
        await settle();
        await shoot(undefined, { of: '[data-shot="coverage-overview"]', pad });
      },
    },
  ]),
  {
    name: 'what-changed-coverage-hint',
    description:
      'Cluster What changed line for failing tests with no coverage in a project that records some: the diff summary, then the help hint on why',
    // Cluster 6 shares cluster 5's project, which records coverage, and its
    // tests recorded none; the demo's canned diff gives its line the summary
    // the hint sits on.
    route: '/',
    viewport: { width: 1280, height: 1100 },
    of: '[data-shot="situation-block"]',
    pad: 12,
    async run({ page, goto, settle, shoot }) {
      await serveSuspectLinesScene(page, 6);
      await goto('/failure-clusters/6');
      await page.getByRole('button', { name: 'Help: Suspect lines need coverage' }).waitFor({ timeout: 60_000 });
      await settle();
      await shoot();
    },
  },
  ...[
    { suffix: '', viewport: { width: 1280, height: 900 }, pad: 12 },
    { suffix: '-mobile', viewport: { width: 375, height: 1400 }, pad: 8 },
  ].map(({ suffix, viewport, pad }) => ({
    name: `execution-suspect-lines${suffix}`,
    description: `Execution situation block whose What changed line names the first of its suspect lines, at ${viewport.width} px`,
    route: '/',
    viewport,
    of: '[data-shot="situation-block"]',
    pad,
    async run({ page, goto, settle, shoot }) {
      await serveSuspectLinesScene(page);
      await goto(`/test-run-cases/${SUSPECT_SCENE_EXECUTION.id}`);
      await page.locator('[data-shot="suspect-lines-sentence"]').waitFor({ timeout: 60_000 });
      await settle();
      await shoot();
    },
  })),
  ...['', '-mobile'].map((suffix) => ({
    name: `what-changed-no-repository${suffix}`,
    description: suffix
      ? 'The cluster situation block at phone width, for runs without a repository URL: the range and its help hint'
      : 'Cluster situation block for runs that record commits but no repository URL: What changed keeps the range and a help hint',
    route: '/projects',
    viewport: suffix ? { width: 375, height: 1200 } : { width: 1280, height: 900 },
    of: '[data-shot="situation-block"]',
    pad: suffix ? 8 : 12,
    async prepare({ request, base }) {
      this.clusterId = await reportNoRepositoryCluster(request, base);
    },
    async run({ page, goto, settle, shoot }) {
      await goto(`/failure-clusters/${this.clusterId}`);
      await page.locator('[data-testid="what-changed-range"]').waitFor({ timeout: 60_000 });
      await settle();
      await shoot();
    },
  })),
  {
    name: 'timeline-type-filter',
    description: 'Timeline tab: the type chips with Network hidden, and the line naming the failed request it hides',
    // Execution 241 (the login API test) interleaves four requests with its
    // steps, the login a 500 — hiding Network names that failed request.
    route: '/test-run-cases/241',
    viewport: { width: 1280, height: 1200 },
    of: '[data-shot="evidence-card"]',
    pad: 12,
    async run({ page, openTab, settle, shoot }) {
      await openTab('Timeline');
      await page
        .getByRole('group', { name: 'Show on the timeline' })
        .getByRole('button', { name: /^Network/ })
        .click();
      await page.getByTestId('timeline-hidden-summary').waitFor({ state: 'visible', timeout: 10_000 });
      await settle();
      await shoot();
    },
  },
  ...[
    { suffix: '', viewport: { width: 1280, height: 1400 } },
    { suffix: '-dark', viewport: { width: 1280, height: 1400 }, colorScheme: 'dark' },
    { suffix: '-mobile', viewport: { width: 375, height: 2000 } },
  ].map(({ suffix, viewport, colorScheme }) => ({
    name: `evidence-source${suffix}`,
    description: `Source tab: the failing helper line and its caller, syntax-highlighted${suffix ? ` (${suffix.slice(1)})` : ''}`,
    // Execution 1 fails inside a helper whose snippet opens mid-JSDoc, so the
    // capture also shows the comment tail read as a comment.
    route: '/test-run-cases/1',
    viewport,
    colorScheme,
    of: '[data-shot="evidence-card"]',
    pad: suffix === '-mobile' ? 8 : 12,
    async run({ openTab, settle, shoot }) {
      await openTab(/^Source/);
      await settle();
      await shoot();
    },
  })),
  ...['', '-mobile'].map((suffix) => ({
    name: `timeline-durations${suffix}`,
    description: suffix
      ? 'The timeline at phone width: the step and request cards, only the 28 s Pay click and the 28.4 s request colored'
      : 'Timeline tab: durations colored only where they stand out (the 28 s Pay click, the 28.4 s request), the cut bar ending in an arrow',
    // Execution 37: five sub-second steps, then a Pay click the 30 s test
    // timeout stops after 28 s, and a 28.4 s request that outlasts the test,
    // which the window around the failure cuts.
    route: '/test-run-cases/37',
    viewport: suffix ? { width: 375, height: 2400 } : { width: 1280, height: 1400 },
    of: '[data-shot="evidence-card"]',
    pad: suffix ? 8 : 12,
    async run({ openTab, settle, shoot }) {
      await openTab('Timeline');
      await settle();
      await shoot();
    },
  })),
  ...['', '-mobile'].map((suffix) => ({
    name: `network-tab-durations${suffix}`,
    description: suffix
      ? 'The Network tab at phone width: the 28.4 s quote request in the same tone as on the Timeline, the others neutral'
      : 'Network tab of execution 37: only the 28.4 s quote request colored, as on the Timeline (timeline-durations)',
    // Execution 37: the quote request outlasts the 30 s test, every other
    // request is quick, so it is the one line in the warning tone.
    route: '/test-run-cases/37',
    viewport: suffix ? { width: 390, height: 1600 } : { width: 1280, height: 1000 },
    of: '[data-shot="evidence-card"]',
    pad: suffix ? 8 : 12,
    async run({ page, openTab, settle, shoot }) {
      await openTab(/^Network/);
      await page.locator('[data-shot="evidence-card"] [data-standout]').first().waitFor({ timeout: 30_000 });
      await settle();
      await shoot();
    },
  })),
  {
    name: 'timeline-usual-duration',
    description:
      'Timeline tab: a click and a request colored against their usual time (usually 600ms, usually 300ms), under a third of the test each',
    route: '/projects',
    viewport: { width: 1280, height: 1200 },
    of: '[data-shot="evidence-card"]',
    pad: 12,
    async prepare({ request, base }) {
      this.executionId = await reportUsualDuration(request, base);
    },
    async run({ page, goto, settle, shoot }) {
      await goto(`/test-run-cases/${this.executionId}`);
      await page
        .getByRole('tablist', { name: 'Evidence sections' })
        .getByRole('tab', { name: 'Timeline', exact: true })
        .click();
      await page
        .locator('[data-shot="evidence-card"] [data-testid="usual-duration"]')
        .filter({ visible: true })
        .first()
        .waitFor({ timeout: 30_000 });
      await settle();
      await shoot();
    },
  },
  {
    name: 'timeline-cited-row',
    description:
      'Execution #37: the timeline rows and the tabs Most likely cites, then its Console and its Network citation opened, the tab strip in view and the entry ringed',
    // Execution 37's story chains the 28.4 s quote request and the console
    // warning: both rows read "Cited by Most likely", and Screen, Network and Console carry the mark.
    route: '/test-run-cases/37',
    viewport: { width: 1280, height: 800 },
    outputs: ['timeline-cited-row.png', 'timeline-cited-row-console.png', 'timeline-cited-row-network.png'],
    async run({ page, openTab, settle, shoot }) {
      await openTab('Timeline');
      const card = page.locator('[data-shot="evidence-card"]');
      await card.locator('tr[data-cited]').first().scrollIntoViewIfNeeded();
      await settle();
      await shoot();

      // A citation rings its entry for two seconds: capture once the scroll has ended.
      const clues = page.locator('[data-shot="failure-clues"]');
      for (const section of ['Console', 'Network']) {
        if (!(await clues.isVisible())) {
          await page.locator('[data-shot="most-likely"]').getByRole('button', { name: 'All clues' }).click();
        }
        await clues.getByRole('button', { name: section, exact: true }).first().click();
        await card.locator('div[data-cited]').first().waitFor();
        await page.waitForTimeout(700);
        await shoot(section.toLowerCase());
      }
    },
  },
  {
    name: 'timeline-type-filter-mobile',
    description: 'Timeline tab at phone width: the type chips wrap, Network hidden, the hidden line under them',
    route: '/test-run-cases/241',
    viewport: { width: 375, height: 1800 },
    of: '[data-shot="evidence-card"]',
    pad: 12,
    async run({ page, openTab, settle, shoot }) {
      await openTab('Timeline');
      await page
        .getByRole('group', { name: 'Show on the timeline' })
        .getByRole('button', { name: /^Network/ })
        .click();
      await page.getByTestId('timeline-hidden-summary').waitFor({ state: 'visible', timeout: 10_000 });
      await settle();
      await shoot();
    },
  },
  {
    name: 'setup-companion-tools',
    description: 'Setup page: the companion-tools card below the capability ladder',
    route: '/setup',
    viewport: { width: 1280, height: 2600 },
    of: '[data-shot="companion-tools"]',
    pad: 12,
  },
  setupConnectScene(1280, ''),
  setupConnectScene(390, '-phone'),
  {
    name: 'home-empty-connect',
    description:
      'Home on an instance with no project yet: the connect wizard waiting for the first run, then the run reporting',
    tags: ['desktop'],
    route: '/settings',
    viewport: { width: 1280, height: 2000 },
    async run({ page, settle, shoot }) {
      let runs = [];
      for (const api of ['projects/overview', 'failure-clusters', 'gaps/inbox', 'flake-lab/inbox']) {
        await page.route(`**/api/${api}*`, (route) => route.fulfill({ json: { items: [] } }));
      }
      await page.route('**/api/test-runs/recent*', (route) => route.fulfill({ json: { items: runs } }));
      // A client-side navigation, so the routes above answer the page's first fetch, not the server render.
      await page.locator('a[href="/"]').first().click();
      const wizard = '[data-shot="get-started-wizard"]';
      await page.locator(wizard).waitFor({ timeout: 60_000 });
      await page.getByText('Waiting for the first run').waitFor();
      await settle();
      await shoot('waiting', { of: wizard, pad: 12 });
      runs = [
        {
          id: 1,
          projectName: 'checkout',
          status: 'running',
          startTime: new Date().toISOString(),
          passedTests: 3,
          failedTests: 0,
          skippedTests: 0,
          didNotRunTests: 0,
          flakyTests: 0,
          totalTests: 12,
        },
      ];
      await page.locator('a[href="/settings/account"], a[href="/projects"]').first().click();
      await page.locator('a[href="/"]').first().click();
      await page.getByText('A run of checkout is reporting now').waitFor({ timeout: 30_000 });
      await settle();
      await shoot('reporting', { of: '[data-shot="setup-run-status"]', pad: 16 });
    },
  },
  {
    name: 'setup-connect-desktop',
    description:
      'Connect wizard (desktop app): the one command with no URL, then with CI reporting to a team server and local runs kept in the app',
    tags: ['desktop'],
    mode: 'desktop',
    route: '/setup',
    viewport: { width: 1280, height: 2400 },
    async run({ page, settle, shoot }) {
      const wizard = '[data-shot="get-started-wizard"]';
      await page.locator(wizard).waitFor({ timeout: 60_000 });
      await settle();
      await shoot('', { of: wizard, pad: 12 });
      await page.getByRole('switch', { name: 'CI reports to a team server' }).click();
      await page.getByRole('textbox', { name: 'Team server URL' }).fill('https://piwi.acme.dev');
      await settle();
      await shoot('team-server', { of: wizard, pad: 12 });
    },
  },
  {
    name: 'mcp-tool-details',
    description: 'MCP page: one tool opened, its Markdown description and parameters',
    route: '/mcp',
    viewport: { width: 1280, height: 2400 },
    of: '[data-shot="mcp-tool-get_fix_plan"]',
    pad: 12,
    run: async ({ page, shoot, settle }) => {
      const tool = page.locator('[data-shot="mcp-tool-get_fix_plan"]');
      await tool.getByRole('button', { expanded: false }).click();
      await tool.getByRole('button', { expanded: true }).waitFor();
      await settle();
      await shoot();
    },
  },
  {
    name: 'mcp-agent-skills',
    description: 'MCP page: the agent-skills section with the install command',
    route: '/mcp',
    viewport: { width: 1280, height: 2400 },
    of: '[data-shot="mcp-agent-skills"]',
    pad: 12,
  },
  {
    name: 'mcp-desktop-tools',
    description: 'MCP page (desktop app): the local-only tools a hosted instance cannot offer',
    tags: ['desktop'],
    mode: 'desktop',
    route: '/mcp',
    viewport: { width: 1000, height: 1000 },
    of: '[data-shot="mcp-desktop-tools"]',
    pad: 12,
  },
  {
    name: 'mcp-tool-modules',
    description: 'MCP page: the tool catalog grouped by module with the Core tools only switch',
    route: '/mcp',
    viewport: { width: 1280, height: 6200 },
    of: '[data-shot="mcp-tool-modules"]',
    pad: 12,
  },

  // ── Flake suspects and the lab ───────────────────────────────────────────
  // Test case 9 is the checkout project's flaky test, whose seeded failures
  // wait on a slow `GET /api/cart`; a seeded Flake Lab experiment reproduced it
  // with a delay on that route.
  {
    name: 'flakiness-tab',
    description:
      'A flaky test’s Flakiness tab: suspects with their counts, conditions and lab results, context and experiments',
    tags: ['desktop'],
    route: '/test-cases/9?tab=flakiness',
    viewport: { width: 1280, height: 1400 },
    of: '[data-shot="flakiness-tab"]',
    pad: 12,
  },
  {
    name: 'flakiness-tab-dark',
    description: 'A flaky test’s Flakiness tab (dark)',
    tags: ['desktop'],
    route: '/test-cases/9?tab=flakiness',
    viewport: { width: 1280, height: 1400 },
    of: '[data-shot="flakiness-tab"]',
    pad: 12,
    colorScheme: 'dark',
  },
  {
    name: 'flakiness-tab-mobile',
    description: 'A flaky test’s Flakiness tab at phone width',
    tags: ['desktop'],
    route: '/test-cases/9?tab=flakiness',
    viewport: { width: 390, height: 2200 },
  },
  // Project 3's pagination test ran the whole lab: a reproduction, a verify
  // that still failed and one that held; its two modal tests are untested.
  {
    name: 'flake-lab-tab',
    description: 'A project’s Flake Lab tab: each flaky test’s lab state and next command, and the newest experiments',
    tags: ['desktop'],
    route: '/projects/3?tab=flake-lab',
    viewport: { width: 1280, height: 1400 },
    of: '[data-shot="flake-lab"]',
    pad: 12,
  },
  {
    name: 'flake-lab-tab-mobile',
    description: 'A project’s Flake Lab tab at phone width',
    tags: ['desktop'],
    route: '/projects/3?tab=flake-lab',
    viewport: { width: 390, height: 2400 },
  },
  {
    name: 'home-flake-lab-inbox',
    description:
      'Home’s Flake Lab queue: flaky tests whose fix waits for a verify, then those with an untested top suspect',
    tags: ['desktop'],
    route: '/',
    viewport: { width: 1280, height: 1600 },
    of: '[data-shot="flake-lab-inbox"]',
    pad: 12,
  },
  {
    name: 'home-flake-lab-inbox-mobile',
    description: 'Home’s Flake Lab queue at phone width',
    tags: ['desktop'],
    route: '/',
    viewport: { width: 390, height: 4000 },
    of: '[data-shot="flake-lab-inbox"]',
    pad: 8,
  },
  quarantineDismissScene(1280, ''),
  quarantineDismissScene(390, '-mobile'),
  screenshotLightboxScene(1280, ''),
  screenshotLightboxScene(390, '-mobile'),
  {
    name: 'flaky-list-suspects',
    description: 'The flaky list with each test’s top suspect and the reproduced badge',
    tags: ['desktop'],
    route: '/projects/1?tab=flaky-tests',
    viewport: { width: 1400, height: 1000 },
    of: '[data-shot="flaky-table"]',
    pad: 12,
  },
  {
    name: 'flaky-list-suspects-dark',
    description: 'The flaky list with each test’s top suspect and the reproduced badge (dark)',
    tags: ['desktop'],
    route: '/projects/1?tab=flaky-tests',
    viewport: { width: 1400, height: 1000 },
    of: '[data-shot="flaky-table"]',
    pad: 12,
    colorScheme: 'dark',
  },

  // ── Resources ──────────────────────────────────────────────────────────
  // Run 62 is Web Dashboard's newest run in the demo seed: a leaky one.
  {
    name: 'run-resources',
    description: 'Run Resources tab: findings, the open-pages pointer, the machine and the costliest tests',
    tags: ['desktop'],
    route: '/test-runs/62?tab=resources',
    viewport: { width: 1280, height: 2900 },
    charts: true,
    of: '[data-shot="run-resources"]',
    pad: 12,
  },
  {
    name: 'run-resources-narrow',
    description: 'Run Resources tab at phone width',
    tags: ['desktop'],
    route: '/test-runs/62?tab=resources',
    viewport: { width: 390, height: 3000 },
    charts: true,
    of: '[data-shot="run-resources"]',
  },
  {
    name: 'execution-resources',
    description: 'Execution Performance tab: what the costliest test of the leaky run cost',
    tags: ['desktop'],
    route: '/test-runs/62?tab=resources',
    viewport: { width: 1280, height: 1600 },
    of: '[data-shot="execution-resources"]',
    pad: 12,
    async run({ page, base, goto, openTab, shoot }) {
      const resources = await (await page.request.get(`${base}/api/test-runs/62/resources`)).json();
      await goto(`/test-run-cases/${resources.costliest[0].executionId}`);
      await openTab('Performance');
      await shoot();
    },
  },

  // ── Bug reports ──────────────────────────────────────────────────────────
  {
    name: 'bug-report-page',
    description: 'A bug report sent from Piwi Picker: what was expected, where it stands, and its steps',
    tags: ['desktop'],
    route: '/bug-reports/1',
    viewport: { width: 1280, height: 900 },
  },
  {
    name: 'bug-report-spec',
    description: 'A bug report’s Spec tab: the failing test to commit, rendered with the project’s settings',
    tags: ['desktop'],
    route: '/bug-reports/1?tab=spec',
    viewport: { width: 1280, height: 1100 },
    of: '[data-shot="bug-report-spec"]',
    pad: 12,
  },
  {
    name: 'bug-report-mobile',
    description: 'The same bug report at phone width',
    tags: ['desktop'],
    route: '/bug-reports/1',
    viewport: { width: 375, height: 1100 },
  },
  {
    name: 'bug-report-step-shots',
    description: 'A bug report’s evidence: the page as each step began, the step’s element outlined',
    tags: ['desktop'],
    viewport: { width: 1280, height: 1000 },
    async prepare({ base, request }) {
      // A report sent as Piwi Picker sends one, with a screenshot of each step: committed docs images stand in.
      const target = (role, name, testId = null) => ({
        tagName: role === 'textbox' ? 'input' : 'button',
        role,
        accessibleName: name,
        testId,
        text: null,
        alternatives: [
          testId
            ? { locator: `getByTestId('${testId}')`, method: 'getByTestId', score: 100 }
            : { locator: `getByRole('${role}', { name: '${name}' })`, method: 'getByRole', score: 90 },
        ],
      });
      const at = (step) => ({ redacted: false, pageUrl: '/cart', timestamp: step });
      const steps = [
        { action: 'goto', target: null, value: '/cart', ...at(0) },
        { action: 'click', target: target('button', 'Failure clusters'), value: null, ...at(1) },
        { action: 'fill', target: target('textbox', 'Search'), value: 'checkout', ...at(2) },
        { action: 'click', target: target('button', 'Network'), value: null, ...at(3) },
      ];
      // Each box is where the step's element is in its image, in the image's pixels.
      const images = [
        { step: 1, png: 'flaky-tests.png', box: { x: 472, y: 196, width: 146, height: 28 } },
        { step: 2, png: 'failure-clusters-tab.png', box: { x: 16, y: 72, width: 207, height: 32 } },
        { step: 3, png: 'execution-locators.png', box: { x: 580, y: 64, width: 114, height: 32 } },
      ];
      const form = new FormData();
      const stepShots = [];
      for (const image of images) {
        const source = join(__dirname, '..', '..', 'docs', 'public', 'screenshots', image.png);
        const { data, info } = await sharp(readFileSync(source))
          .jpeg({ quality: 60 })
          .toBuffer({ resolveWithObject: true });
        const file = `steps/${String(image.step + 1).padStart(3, '0')}.jpg`;
        stepShots.push({
          step: image.step,
          file,
          box: image.box,
          viewport: { width: info.width, height: info.height },
          takenAt: image.step,
        });
        form.append('stepShot', new Blob([data], { type: 'image/jpeg' }), file.replace(/^steps\//, ''));
      }
      const report = {
        v: 1,
        steps: {
          v: 1,
          title: 'Search results lose their filter',
          origin: 'https://shop.example',
          recordedAt: 0,
          note: null,
          steps,
        },
        evidence: {
          console: [],
          consoleDropped: 0,
          requests: [],
          requestsDropped: 0,
          screenshots: [],
          screenshotNote: 'none was taken',
          outline: null,
          stepShots,
        },
        context: { origin: 'https://shop.example', pageKey: '/cart', path: '/cart', time: Date.now() },
      };
      form.append('report', JSON.stringify(report));
      const sent = await request.post(`${base}/api/projects/1/bug-reports`, { multipart: form });
      this.reportId = (await sent.json()).id;
    },
    async run({ page, goto, shoot }) {
      await goto(`/bug-reports/${this.reportId}?tab=evidence`);
      await shoot(undefined, { of: '[data-shot="bug-report-step-shots"]', pad: 12 });
      await page.setViewportSize({ width: 390, height: 1600 });
      await shoot('mobile', { of: '[data-shot="bug-report-step-shots"]', pad: 12 });
    },
  },
  {
    name: 'bug-report-list',
    description: 'A project’s bug reports',
    tags: ['desktop'],
    route: '/projects/1/bug-reports',
    viewport: { width: 1280, height: 700 },
    of: '[data-shot="bug-report-list"]',
    pad: 12,
  },
  {
    name: 'picker-install-hint',
    description: 'A project with no bug report yet: the hint to install Piwi Picker, with the store of this browser',
    route: '/projects/2/bug-reports',
    viewport: { width: 1280, height: 700 },
    of: '[data-shot="bug-report-list"]',
    pad: 12,
    pickerHint: true,
  },

  // ── Failure headline (report artifacts) ──────────────────────────────────
  {
    name: 'failure-headline',
    description:
      'Failing execution: the situation block, the headline and the line under it (since when, not the latest), most likely, next step and the cluster',
    tags: ['desktop'],
    // Execution 37 is a new regression clustered with a sibling in its run, and
    // its test failed again in later runs: the line under the headline says so,
    // and the Cluster line names the sibling.
    route: '/test-run-cases/37',
    viewport: { width: 1280, height: 900 },
    of: '[data-shot="situation-block"]',
    pad: 12,
  },
  {
    name: 'failure-headline-mobile',
    description: 'The same situation block at phone width, "Not the latest" on a line of its own',
    tags: ['desktop'],
    route: '/test-run-cases/37',
    viewport: { width: 375, height: 812 },
    of: '[data-shot="situation-block"]',
    pad: 8,
  },

  // ── The change a Next step copies (report artifacts) ─────────────────────
  {
    name: 'next-step-locator',
    description: 'Cluster situation block whose Next line shows the locator edit it copies with Copy apply command',
    tags: ['desktop'],
    route: '/failure-clusters/2',
    viewport: { width: 1280, height: 900 },
    of: '[data-shot="situation-block"]',
    pad: 12,
  },
  {
    name: 'next-step-locator-mobile',
    description: 'The same block at phone width, the diff scrolling inside its box',
    tags: ['desktop'],
    route: '/failure-clusters/2',
    viewport: { width: 375, height: 1200 },
    of: '[data-shot="situation-block"]',
    pad: 8,
  },
  {
    name: 'next-step-copy-locator',
    description:
      'Execution situation block whose locator step has no line edit: the failing and recommended locator, Copy locator',
    tags: ['desktop'],
    // Execution 648's healing reads the failure-time ARIA snapshot, and its
    // locator lives in a helper, so the test's line has no locator call to rewrite.
    route: '/test-run-cases/648',
    viewport: { width: 1280, height: 900 },
    of: '[data-shot="situation-block"]',
    pad: 12,
  },

  // ── Not the latest execution (report artifacts) ──────────────────────────
  {
    name: 'execution-latest-passed',
    description:
      'Failing execution whose test passed in a later run: "Not the latest: passed in run #N" under the headline',
    tags: ['desktop'],
    // Execution 711 failed in cluster #10; the same test passed in a later run.
    route: '/test-run-cases/711',
    viewport: { width: 1280, height: 900 },
    of: '[data-shot="situation-block"]',
    pad: 12,
  },
  {
    name: 'execution-latest-passed-mobile',
    description: 'The same situation block at phone width',
    tags: ['desktop'],
    route: '/test-run-cases/711',
    viewport: { width: 390, height: 900 },
    of: '[data-shot="situation-block"]',
    pad: 8,
  },

  // ── The ticket on the execution page (report artifacts) ──────────────────
  {
    name: 'execution-issue-line',
    description: "Failing execution whose cluster is tracked: the Cluster line ends with the cluster's issue",
    tags: ['desktop'],
    prepare: prepareClusterOneTracked,
    route: '/test-run-cases/37',
    viewport: { width: 1280, height: 900 },
    of: '[data-shot="situation-block"]',
    pad: 12,
  },
  {
    name: 'execution-details-links',
    description: "Failing execution's Details open, scrolled to its links: by owner, then the cluster's, read-only",
    tags: ['desktop'],
    prepare: prepareClusterOneTracked,
    route: '/test-run-cases/37',
    viewport: { width: 1280, height: 800 },
    async run({ page, shoot, settle }) {
      await page.getByRole('button', { name: 'Details' }).first().click();
      const details = page.getByTestId('execution-details');
      await details.waitFor();
      await details.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await settle();
      await shoot();
    },
  },
  {
    name: 'execution-issue-line-untracked',
    description: 'Failing execution whose cluster has no issue: the Cluster line offers to create or link one',
    tags: ['desktop'],
    prepare: prepareJiraSceneConnection,
    route: '/test-run-cases/87',
    viewport: { width: 1280, height: 900 },
    of: '[data-shot="situation-block"]',
    pad: 12,
  },

  // ── Failure page clarity (report artifacts) ───────────────────────────────
  // The first screen of each detail page in its default state, at wide and phone
  // width, the visual side of the `app:measure` legibility numbers.
  // Full-viewport, nothing expanded.
  {
    name: 'execution-clarity',
    description: 'Execution page first screen, default state (1280×800 clarity baseline)',
    route: '/test-run-cases/37',
    viewport: { width: 1280, height: 800 },
  },
  {
    name: 'execution-clarity-mobile',
    description: 'The same execution page first screen at phone width',
    route: '/test-run-cases/37',
    viewport: { width: 390, height: 800 },
  },
  {
    name: 'cluster-clarity',
    description: 'Failure cluster page first screen, default state (1280×800 clarity baseline)',
    route: '/failure-clusters/10',
    viewport: { width: 1280, height: 800 },
  },
  {
    name: 'cluster-clarity-mobile',
    description: 'The same cluster page first screen at phone width',
    route: '/failure-clusters/10',
    viewport: { width: 390, height: 800 },
  },
  ...[{ suffix: '' }, { suffix: '-dark', colorScheme: 'dark' }].map(({ suffix, colorScheme }) => ({
    name: `cluster-affected-tests-selected${suffix}`,
    description: `Affected tests of cluster #1 with its second test selected: a neutral selected row${suffix ? ' (dark)' : ''}`,
    // Cluster #1 fails in two tests; the row clicked here picks the evidence below.
    route: '/failure-clusters/1',
    viewport: { width: 1280, height: 900 },
    colorScheme,
    of: '[data-shot="cluster-affected-tests"]',
    pad: 12,
    async run({ page, settle, shoot }) {
      const card = page.locator('[data-shot="cluster-affected-tests"]');
      const other = card.locator('[role="button"][aria-pressed="false"]').first();
      const title = (await other.innerText()).split('\n')[0].trim();
      await other.click();
      await card.locator('[role="button"][aria-pressed="true"]', { hasText: title }).waitFor();
      await settle();
      await shoot();
    },
  })),
  {
    name: 'retry-pass-clarity',
    description: 'Execution page first screen for a test that passed on retry (1280×800 clarity baseline)',
    // Execution 768 failed its first attempt and passed its retry.
    route: '/test-run-cases/768',
    viewport: { width: 1280, height: 800 },
  },
  {
    name: 'retry-pass-clarity-mobile',
    description: 'The same passed-on-retry execution first screen at phone width',
    route: '/test-run-cases/768',
    viewport: { width: 390, height: 800 },
  },
  {
    name: 'execution-retry-pass-flake-lab',
    description: 'Execution page first screen for a retry pass whose flake the Flake Lab reproduced (1280×800)',
    // Execution 21 passed on retry; its next step verifies the flake fix under the condition the lab found.
    route: '/test-run-cases/21',
    viewport: { width: 1280, height: 800 },
  },
  {
    name: 'did-not-run-clarity',
    description: 'Execution page first screen for a test that did not run (1280×800 clarity baseline)',
    // Execution 748 never ran: its run stopped at the max-failures limit.
    route: '/test-run-cases/748',
    viewport: { width: 1280, height: 800 },
  },
  {
    name: 'did-not-run-clarity-mobile',
    description: 'The same did-not-run execution first screen at phone width',
    route: '/test-run-cases/748',
    viewport: { width: 390, height: 800 },
  },
  {
    name: 'execution-did-not-run-blocked',
    description: 'Execution page first screen for a test an earlier failure of its serial group blocked (1280×800)',
    // Execution 7 did not run: Most likely links the test that blocked it, and Next opens that failure.
    route: '/test-run-cases/7',
    viewport: { width: 1280, height: 800 },
  },

  // ── Desktop shell (report artifacts) ──────────────────────────────────────
  {
    name: 'desktop-repro-request',
    description: 'A repro request from Piwi Picker, waiting in the desktop window for the developer (desktop shell)',
    tags: ['desktop'],
    mode: 'desktop',
    route: '/setup',
    viewport: { width: 1280, height: 1000 },
    link: { path: '/home/dev/shop', exists: true },
    async run({ page, shoot, settle }) {
      // The desktop event stream delivers the request; outside the shell the
      // repro endpoints do not exist, so the stream is answered here.
      const request = {
        id: 'a1b2c3d4e5f60718',
        title: 'Coupon not applied to the total',
        steps: REPRO_SCENE_STEPS,
        options: { headed: true, trace: true, project: null, repeatEach: 1 },
        bugReportId: 37,
        instanceUrl: 'https://piwi.acme.test',
        status: 'waiting',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        projectId: null,
        verdict: null,
        runId: null,
      };
      await page.route('**/api/desktop/events', (route) =>
        route.fulfill({
          contentType: 'text/event-stream',
          body: `data: ${JSON.stringify({ type: 'repro-request', request })}\n\n`,
        }),
      );
      await page.reload();
      await page.getByRole('dialog', { name: 'Run a bug report with Playwright' }).waitFor();
      await page.getByText('/home/dev/shop').first().waitFor();
      await settle();
      await shoot();
    },
  },
  {
    name: 'desktop-reproduce-section',
    description:
      "A failure's Reproduce section in the desktop shell, for a linked folder whose Playwright config starts no app (desktop shell)",
    tags: ['desktop'],
    mode: 'desktop',
    route: '/test-run-cases/682',
    viewport: { width: 1280, height: 1000 },
    link: { path: READY_INSPECTION.path, exists: true },
    inspection: { ...READY_INSPECTION, webServer: false },
    of: '[data-shot="fix-reproduce-body"]',
    pad: 12,
  },
  {
    name: 'desktop-nav',
    description: 'Back/forward pair in the sidebar header (desktop shell)',
    tags: ['desktop'],
    mode: 'desktop',
    route: '/projects',
    outputs: ['desktop-nav.png', 'desktop-nav-collapsed.png'],
    async run({ page, shoot, settle }) {
      // Navigate away and back — client-side, a reload would reset the router's
      // history markers — so both directions are enabled in the shot.
      await page.getByRole('link', { name: 'Analytics' }).click();
      await page.waitForURL('**/analytics');
      await settle();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.waitForURL('**/projects');
      await settle();
      await shoot();
      await page.getByRole('button', { name: /collapse sidebar/i }).click();
      await settle();
      await shoot('collapsed', { clip: { x: 0, y: 0, width: 320, height: 560 } });
    },
  },
  {
    name: 'ai-claude-cli',
    description: 'Settings → AI: use the local Claude Code CLI as the provider — no API key (desktop shell)',
    tags: ['desktop'],
    mode: 'desktop',
    route: '/settings/ai',
    viewport: { width: 1000, height: 1100 },
    of: '[data-shot="ai-model-providers"]',
    pad: 12,
    outputs: ['ai-claude-cli.png', 'ai-claude-cli-selected.png'],
    async run({ page, shoot, settle }) {
      // The status card sits at the top of the providers section and probes the
      // real `claude` on this machine (installed + signed-in; no tokens spent).
      // Wait for that probe to resolve before capturing.
      await page.getByText('billed to your Claude Code sign-in').first().waitFor();
      await page.getByText('Checking for the Claude CLI…').waitFor({ state: 'hidden' });
      await settle();
      await shoot();

      // Select the CLI as the diagnosis provider to reveal the no-API-key role
      // form (the provider select carries whatever config is stored).
      await page.getByRole('combobox').first().click();
      await page.getByRole('option', { name: 'Claude Code (local)' }).click();
      await page.getByText('it uses your Claude Code sign-in').first().waitFor();
      await settle();
      await shoot('selected');
    },
  },
  {
    name: 'project-from-folder',
    description: 'New-project modal: start from a local folder (desktop shell)',
    tags: ['desktop'],
    mode: 'desktop',
    link: null,
    inspection: { ...READY_INSPECTION, reporterConfigured: false, configuredProjectName: null },
    route: '/projects',
    outputs: ['project-from-folder-empty.png', 'project-from-folder-picked.png'],
    async run({ page, shoot, settle }) {
      await page.getByRole('button', { name: 'New project' }).click();
      await page.getByRole('heading', { name: 'Create new project' }).waitFor();
      await settle();
      await shoot('empty');
      await page.getByRole('button', { name: 'Choose folder…' }).click();
      await page.getByText(READY_INSPECTION.path).first().waitFor();
      await settle();
      await shoot('picked');
    },
  },
  {
    name: 'project-from-folder-mobile',
    description: 'The same modal at phone width',
    tags: ['desktop'],
    mode: 'desktop',
    link: null,
    inspection: { ...READY_INSPECTION, reporterConfigured: false, configuredProjectName: null },
    viewport: { width: 375, height: 812 },
    route: '/projects',
    async run({ page, shoot, settle }) {
      await page.getByRole('button', { name: 'New project' }).click();
      await page.getByRole('heading', { name: 'Create new project' }).waitFor();
      await page.getByRole('button', { name: 'Choose folder…' }).click();
      await page.getByText(READY_INSPECTION.path).first().waitFor();
      await settle();
      await shoot();
    },
  },
  {
    name: 'edit-local-folder',
    description: 'Project settings: linked folder with setup checks (desktop shell)',
    tags: ['desktop'],
    mode: 'desktop',
    link: { path: READY_INSPECTION.path, exists: true },
    route: '/projects/2/edit#local-folder',
    of: '#local-folder',
    pad: 8,
    outputs: ['edit-local-folder-ready.png'],
    async run({ page, shoot }) {
      await page.getByRole('button', { name: 'Unlink' }).waitFor();
      await shoot('ready');
    },
  },
  {
    name: 'edit-local-folder-needs-setup',
    description: 'The same card when the folder is missing Piwi wiring',
    tags: ['desktop'],
    mode: 'desktop',
    link: { path: READY_INSPECTION.path, exists: true },
    inspection: {
      ...READY_INSPECTION,
      reporterInstalled: false,
      reporterConfigured: false,
      configuredProjectName: null,
    },
    route: '/projects/2/edit#local-folder',
    of: '#local-folder',
    pad: 8,
    async run({ page, shoot }) {
      await page.getByRole('button', { name: 'Unlink' }).waitFor();
      await shoot();
    },
  },
  {
    name: 'project-folder-card',
    description: 'Project page: compact linked-folder status card (desktop shell)',
    tags: ['desktop'],
    mode: 'desktop',
    link: { path: READY_INSPECTION.path, exists: true },
    route: '/projects/2',
    async run({ page, shoot, settle }) {
      await page.getByText(READY_INSPECTION.path).first().waitFor();
      await settle();
      await shoot();
    },
  },
  {
    name: 'import-previous-runs',
    description: 'After linking a folder, offer to import the runs already in it (desktop shell)',
    tags: ['desktop'],
    mode: 'desktop',
    link: null,
    importableRuns: [
      {
        path: `${READY_INSPECTION.path}/blob-report/report-1.zip`,
        name: 'report-1.zip',
        size: 2_412_000,
        kind: 'blob',
      },
      {
        path: `${READY_INSPECTION.path}/blob-report/report-2.zip`,
        name: 'report-2.zip',
        size: 1_968_000,
        kind: 'blob',
      },
      {
        path: `${READY_INSPECTION.path}/test-results/checkout-chromium/trace.zip`,
        name: 'trace.zip',
        size: 826_000,
        kind: 'trace',
      },
    ],
    route: '/projects/2?tab=settings&section=local-folder',
    async run({ page, shoot, settle }) {
      await page.getByRole('button', { name: 'Choose folder…' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('heading', { name: 'Import previous runs' }).waitFor();
      await settle();
      await shoot();
    },
  },
  {
    name: 'import-runs-desktop',
    description: 'Import page: the browse button opens at the linked project folder (desktop shell)',
    tags: ['desktop'],
    mode: 'desktop',
    link: { path: READY_INSPECTION.path, exists: true },
    route: '/projects/2/import',
    async run({ page, shoot, settle }) {
      await page.getByText(`Opens in ${READY_INSPECTION.path}`).waitFor();
      await settle();
      await shoot();
    },
  },
  {
    name: 'notifications-settings',
    description: 'Notifications settings (auth off): SMTP status, channels, subscriptions; plus the project bell',
    route: '/settings/notifications',
    viewport: { width: 1280, height: 1250 },
    outputs: ['notifications-settings.png', 'notifications-settings-bell.png'],
    prepare: prepareTeamSlackChannel,
    async run({ page, shoot, goto, settle }) {
      await shoot();
      await goto('/projects/1');
      await page.getByTitle('Notification subscriptions for this project').click();
      await page.getByText('Browser notifications').waitFor();
      await settle();
      await shoot('bell');
    },
  },
  {
    name: 'channel-form',
    description: 'Notifications → Add channel: the Slack app steps with a checked URL, then that URL under Teams',
    route: '/settings/notifications',
    viewport: { width: 1280, height: 1100 },
    outputs: ['channel-form-slack.png', 'channel-form-teams.png'],
    async run({ page, shoot, settle }) {
      await page.getByRole('button', { name: 'Add channel' }).click();
      const form = page.locator('[data-shot="channel-form"]');
      await form.waitFor();
      const pick = async (label) => {
        await form.getByRole('combobox').first().click();
        await page.getByRole('option', { name: label, exact: true }).click();
      };
      await pick('Slack webhook');
      await page.getByTestId('slack-webhook-url').fill('https://hooks.slack.com/services/T000/B000/XXXX');
      await settle();
      await shoot('slack', { of: '[data-shot="channel-form"]', pad: 12 });
      // The URL stays when the type changes, so Teams offers to switch back.
      await pick('Microsoft Teams webhook');
      await page.getByTestId('channel-url-check').waitFor();
      await settle();
      await shoot('teams', { of: '[data-shot="channel-form"]', pad: 12 });
    },
  },
  // ── Capabilities opt-out ─────────────────────────────────────────────────
  {
    name: 'setup-ladder-declined',
    description: 'Setup ladder grouped by state, with a declined capability folded under Declined',
    // Decline one instance capability so the folded Declined group appears.
    async prepare({ base, request }) {
      await request.patch(`${base}/api/capabilities`, { data: { decisions: { notifications: 'declined' } } });
    },
    route: '/setup',
    viewport: { width: 1280, height: 1600 },
    async run({ page, shoot, settle }) {
      // Open the folded Declined group so the reconsider control shows.
      await page
        .getByRole('button', { name: /^Declined \(/ })
        .first()
        .click()
        .catch(() => {});
      await settle();
      await shoot('wide', { of: '[data-shot="setup-ladder"]', pad: 12 });
      await page.setViewportSize({ width: 400, height: 1800 });
      await settle();
      await shoot('narrow', { of: '[data-shot="setup-ladder"]', pad: 8 });
    },
  },
  ...[
    { name: 'extension-connect', width: 1280 },
    { name: 'extension-connect-mobile', width: 375 },
  ].map(({ name, width }) => ({
    name,
    description: `The page Piwi Picker opens to be allowed, with the connecting browser and its code, at ${width} px`,
    async prepare({ base, request }) {
      const res = await request.post(`${base}/api/extension/connect`, { data: { browser: 'Chrome', os: 'Windows' } });
      this.userCode = (await res.json()).userCode;
    },
    route: '/',
    viewport: { width, height: 900 },
    of: '[data-shot="extension-connect"]',
    async run({ shoot, settle, goto }) {
      await goto(`/extension/connect?code=${this.userCode}`);
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'mcp-oauth-consent', width: 1280 },
    { name: 'mcp-oauth-consent-mobile', width: 375 },
  ].map(({ name, width }) => ({
    name,
    description: `The consent page an MCP client's OAuth sign-in opens, with the client, where the answer goes and the account, at ${width} px. It exists with authentication on: pass --url of an auth-enabled server and PIWI_SCREENS_LOGIN=<username>:<password>`,
    async prepare({ base, request }) {
      await signInForScene({ base, request });
      const redirectUri = 'http://127.0.0.1:33418/callback';
      const client = await (
        await request.post(`${base}/oauth/register`, {
          data: { client_name: 'Claude Code (piwi)', redirect_uris: [redirectUri] },
        })
      ).json();
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
        state: 'screenshot',
      });
      const res = await request.get(`${base}/oauth/authorize?${query}`, { maxRedirects: 0 });
      this.consentPath = res.headers().location;
    },
    route: '/',
    viewport: { width, height: 900 },
    of: '[data-shot="mcp-oauth-consent"]',
    async run({ shoot, settle, goto }) {
      await goto(this.consentPath);
      await settle();
      await shoot();
    },
  })),
  {
    name: 'mcp-client-auth',
    description:
      'MCP page with authentication on: client setup signs in through OAuth, with the Use an API key switch. Pass --url of an auth-enabled server and PIWI_SCREENS_LOGIN=<username>:<password>',
    route: '/mcp',
    viewport: { width: 1280, height: 1400 },
    of: '[data-shot="mcp-client-setup"]',
    pad: 12,
    prepare: signInForScene,
  },
  {
    name: 'evidence-fixtures-footer',
    description: 'Execution page evidence card for a project with no captured fixtures: the footer names them',
    // Seed a fixtures-free failing run so the footer (undecided) shows.
    async prepare({ base, request }) {
      await request.post(`${base}/api/test-runs/submit`, {
        data: {
          projectName: 'capability-demo-fixtures-free',
          status: 'failed',
          startTime: new Date().toISOString(),
          duration: 2000,
          totalTests: 1,
          passedTests: 0,
          failedTests: 1,
          skippedTests: 0,
          testCases: [
            {
              title: 'cart totals the line items',
              status: 'failed',
              duration: 800,
              location: 'tests/cart.spec.ts:8:3',
              error:
                'Error: expect(received).toBe(expected)\n\nExpected: 3\nReceived: 2\n    at tests/cart.spec.ts:8:20',
            },
          ],
        },
      });
      const { items } = await (await request.get(`${base}/api/projects`)).json();
      const project = items.find((p) => p.name === 'capability-demo-fixtures-free');
      const detail = await (await request.get(`${base}/api/projects/${project.id}`)).json();
      const run = await (await request.get(`${base}/api/test-runs/${detail.testRuns[0].id}`)).json();
      footerExecId = run.testCases.find((c) => c.status === 'failed').executionId;
    },
    route: '/',
    viewport: { width: 1280, height: 1400 },
    async run({ page, shoot, settle, goto }) {
      await goto(`/test-run-cases/${footerExecId}`);
      await settle();
      await shoot('wide', { of: '[data-shot="evidence-card"]', pad: 12 });
      await page.setViewportSize({ width: 400, height: 1600 });
      await settle();
      await shoot('narrow', { of: '[data-shot="evidence-card"]', pad: 8 });
    },
  },
  {
    name: 'run-changes-fallback',
    description:
      'Run Changes tab in a project that never passed: compared with the last failed run, the run picker open, then the run with no eligible baseline and the first run',
    prepare: prepareNeverGreenRuns,
    route: '/',
    viewport: { width: 1280, height: 1100 },
    async run({ page, shoot, settle, goto }) {
      await goto(`/test-runs/${neverGreenRuns.latest}?tab=changes`);
      await page.locator('[data-shot="run-changes-baseline"]').waitFor({ timeout: 60000 });
      await settle();
      await shoot('failed-baseline', { of: '[data-shot="run-changes"]', pad: 12 });
      await page.getByTitle('Compare against one earlier run').click();
      await page.getByRole('option').first().waitFor({ timeout: 15000 });
      await shoot('picker');
      await page.keyboard.press('Escape');

      await goto(`/test-runs/${neverGreenRuns.firstFailed}?tab=changes`);
      await page.locator('[data-shot="run-changes-empty"]').waitFor({ timeout: 60000 });
      await settle();
      await shoot('no-baseline', { of: '[data-shot="run-changes-empty"]', pad: 24 });

      await goto(`/test-runs/${neverGreenRuns.interrupted}?tab=changes`);
      await page.locator('[data-shot="run-changes-empty"]').waitFor({ timeout: 60000 });
      await settle();
      await shoot('first-run', { of: '[data-shot="run-changes-empty"]', pad: 24 });

      await page.setViewportSize({ width: 390, height: 1200 });
      await goto(`/test-runs/${neverGreenRuns.latest}?tab=changes`);
      await page.locator('[data-shot="run-changes-baseline"]').waitFor({ timeout: 60000 });
      await settle();
      await shoot('narrow', { of: '[data-shot="run-changes-baseline"]', pad: 8 });
    },
    outputs: [
      'run-changes-fallback-failed-baseline.png',
      'run-changes-fallback-picker.png',
      'run-changes-fallback-no-baseline.png',
      'run-changes-fallback-first-run.png',
      'run-changes-fallback-narrow.png',
    ],
  },

  // ── Demo guided tour (report artifacts) ──────────────────────────────────
  // The demo's tour, which `mode: 'tour'` switches on for the dev server: the
  // prompt a first visit gets, then the developer tour's first stop.
  ...[
    { name: 'demo-tour-prompt', viewport: { width: 1280, height: 860 } },
    { name: 'demo-tour-prompt-mobile', viewport: { width: 390, height: 844 } },
  ].map(({ name, viewport }) => ({
    name,
    description: `Guided tour: the prompt a first visit gets, over the home page, at ${viewport.width} px`,
    mode: 'tour',
    route: '/',
    viewport,
    async run({ page, shoot, settle }) {
      await waitForTourPrompt(page);
      await settle();
      await shoot();
    },
  })),
  ...[
    { name: 'demo-tour-stop', what: 'at 1280 px' },
    { name: 'demo-tour-stop-mobile', viewport: { width: 390, height: 844 }, what: 'at 390 px' },
    { name: 'demo-tour-stop-fr', language: 'Français', what: 'in French' },
    { name: 'demo-tour-stop-dark', colorScheme: 'dark', what: 'in dark mode' },
  ].map(({ name, viewport = { width: 1280, height: 860 }, language, colorScheme, what }) => ({
    name,
    description: `Guided tour: the developer tour's first stop, its popover over the failing execution, ${what}`,
    mode: 'tour',
    route: '/',
    viewport,
    colorScheme,
    async run({ page, shoot, settle }) {
      await startTourFromPrompt(page, { profile: 'developer', language });
      await settle();
      await shoot();
    },
  })),
  {
    name: 'demo-tour-walk',
    description:
      'Guided tour: every stop of every role’s tour at 1280 px, one image per stop; the demo banner’s stops, which a dev server has no banner for, are left out',
    mode: 'tour',
    route: '/',
    viewport: { width: 1280, height: 860 },
    async run({ page, shoot, settle, goto }) {
      await waitForTourPrompt(page);
      const profiles = await page
        .locator('[data-testid^="tour-profile-"]')
        .evaluateAll((cards) => cards.map((card) => card.dataset.testid.replace('tour-profile-', '')));
      for (const profile of profiles) {
        // A started tour is never asked about again: forget it, so the next visit gets the prompt.
        await page.evaluate(() => localStorage.removeItem('piwi-demo-tour'));
        await goto('/');
        await startTourFromPrompt(page, { profile });
        await walkTourStops(page, async ({ id, anchor }) => {
          if (!anchor) {
            console.log(`   ${profile}/${id}: left out, its anchor is in the demo banner`);
            return;
          }
          await settle();
          await shoot(`${profile}-${id}`);
        });
      }
    },
  },
];

/** Output basename for a scene, before any `shoot()` label. */
function sceneFile(scene) {
  return scene.file ?? `${scene.name}.png`;
}

/** Every file a scene writes — what `--check` matches the docs directory against. */
function sceneOutputs(scene) {
  if (scene.outputs) return scene.outputs;
  const base = sceneFile(scene).replace(/\.png$/, '');
  return scene.annotate ? [`${base}.png`, `${base}-annotated.png`] : [`${base}.png`];
}

function outDirFor(scene, override) {
  if (override) return override;
  return OUT_TARGETS[scene.out ?? 'screens'];
}

/**
 * Serve the demo's suspect lines of cluster 5 and of its execution 496, and the
 * What changed of `clusterId` (cluster 5 or another of its project) with the
 * demo's canned changes, to the page.
 */
async function serveSuspectLinesScene(page, clusterId = SUSPECT_SCENE_CLUSTER.id) {
  await page.route(`**/api/failure-clusters/${SUSPECT_SCENE_CLUSTER.id}/suspect-lines`, (route) =>
    route.fulfill({ json: SUSPECT_SCENE_CLUSTER.answer }),
  );
  await page.route(`**/api/test-run-cases/${SUSPECT_SCENE_EXECUTION.id}/suspect-lines`, (route) =>
    route.fulfill({ json: SUSPECT_SCENE_EXECUTION.answer }),
  );
  await page.route(
    (url) => url.pathname === `/api/failure-clusters/${clusterId}/context`,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: withSceneChanges(await response.json()) });
    },
  );
}

/**
 * Open the order-dependent flake's failed attempt on its Source tab, with the
 * demo's source of the flake's files served, and unfold the preferences
 * endpoints in the comparison with the last passing run.
 */
async function openDivergenceScene(page, goto, settle) {
  await page.route(
    (url) => url.pathname === `/api/projects/${ORDER_SCENE.projectId}/source`,
    (route) => {
      const url = new URL(route.request().url());
      const source = orderSceneSource(url.searchParams.get('path'), url.searchParams.get('blob'));
      return source
        ? route.fulfill({ json: source })
        : route.fulfill({ status: 404, json: { message: 'Source not available' } });
    },
  );
  await goto(`/test-run-cases/${ORDER_SCENE.executionId}?evidence=source`);
  const part = page.locator('[data-shot="execution-coverage-divergence"]');
  await part.waitFor({ timeout: 60_000 });
  await part.getByRole('button', { name: `Show what each run ran in ${ORDER_SCENE.path}` }).click();
  await part.locator('[data-coverage-source] [data-executed]').first().waitFor({ timeout: 30_000 });
  await settle();
}

/** Open the order-dependent flake's test page and wait for its Path variation card's explanation. */
async function openPathVariationScene(page, goto, settle) {
  await goto(`/test-cases/${ORDER_SCENE.testCaseId}`);
  await page.locator('[data-shot="test-path-variation"] [data-testid="path-variation-explanation"]').waitFor({
    timeout: 60_000,
  });
  await settle();
}

/**
 * Open the project's flaky tests, reach the toggle's Quarantine button by
 * `hover` or `focus`, and wait for its coverage-loss preview; returns the clip
 * around the button's row and the preview.
 */
async function openQuarantineLossScene(page, goto, settle, reach) {
  await goto(`/projects/${ORDER_SCENE.projectId}?tab=flaky-tests`);
  const row = page
    .locator('[data-shot="flaky-table"] [data-tour="flaky-test-row"]')
    .filter({ hasText: 'toggles dark mode' })
    .first();
  await row.waitFor({ timeout: 60_000 });
  await settle();
  const button = row.getByRole('button', { name: 'Quarantine', exact: true });
  if (reach === 'focus') await button.focus();
  else await button.hover();
  const preview = page.locator('[data-shot="coverage-loss-preview"]').first();
  await preview.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(300);
  const boxes = [await row.boundingBox(), await preview.boundingBox()];
  const viewport = page.viewportSize();
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 12);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 24);
  const right = Math.min(viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + 12);
  const bottom = Math.min(viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + 24);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * The Uncovered changes section of a pull request that changed seven files
 * across two tickets, three of which no test reaches, with the head commit's
 * patch coverage: the bytes `renderChangeCoverage` posts.
 */
async function uncoveredChangesMarkdown() {
  const { renderChangeCoverage } = await import('../shared/pr-feedback.ts');
  return renderChangeCoverage({
    fileReach: true,
    totalFiles: 7,
    uncoveredFiles: 3,
    reachedFiles: 4,
    notCounted: { notObservable: 1, outOfScope: 2, deleted: 0 },
    ticketCount: 2,
    windowRuns: 30,
    patchCoverage: {
      commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      changedLines: 41,
      executedLines: 34,
      unitLines: 28,
      e2eLines: 19,
      undeterminedLines: 0,
      suites: [
        { name: 'unit-front', kind: 'unit', executedLines: 22 },
        { name: 'unit-back', kind: 'unit', executedLines: 6 },
        { name: 'e2e', kind: 'e2e', executedLines: 19 },
      ],
      areas: [
        { name: 'front', changedLines: 30, executedLines: 28 },
        { name: 'back', changedLines: 11, executedLines: 6 },
      ],
      files: 6,
    },
    tickets: [
      {
        ticket: 'PROJ-418',
        files: [
          {
            filePath: 'server/api/orders/[id].patch.ts',
            additions: 41,
            deletions: 3,
            reach: 'unreached',
            draftTitle: 'a scenario that exercises [id].patch.ts',
          },
          {
            filePath: 'server/utils/order-status.ts',
            additions: 12,
            deletions: 4,
            reach: 'unreached',
            lines: { changed: 5, ran: 0, undetermined: 0, notRun: [[14, 18]] },
            draftTitle: 'a scenario that moves an order to shipped',
          },
          {
            filePath: 'app/pages/orders/[id].vue',
            additions: 9,
            deletions: 2,
            reach: 'reached',
            lines: { changed: 9, ran: 7, undetermined: 0, notRun: [[31, 32]] },
          },
          {
            filePath: 'server/api/orders/index.get.ts',
            additions: 6,
            deletions: 1,
            reach: 'reached',
            lines: {
              changed: 6,
              ran: 4,
              undetermined: 0,
              notRun: [
                [18, 18],
                [24, 24],
              ],
            },
          },
        ],
      },
      {
        ticket: 'PROJ-421',
        files: [
          {
            filePath: 'app/components/RefundDialog.vue',
            additions: 28,
            deletions: 0,
            reach: 'unreached',
            draftTitle: 'a scenario that opens the refund dialog',
          },
        ],
      },
    ],
  });
}

/**
 * A comment's Markdown as a code host shows it: rendered with `marked`, a
 * line break kept as one, in a bordered card under its author line, in the
 * hosts' system font stack. The
 * emoji become drawn circles, since the capture browser may have no emoji font.
 */
async function prCommentPage(markdown) {
  const { marked } = await import('marked');
  const body = marked
    .parse(markdown, { gfm: true, breaks: true })
    .replaceAll('🟣', '<span class="emoji" role="img" aria-label="purple circle"></span>');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  body { width: fit-content; margin: 0; padding: 24px; background: #fff; color: #1f2328;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Inter, sans-serif; }
  .comment { display: flex; gap: 16px; width: 760px; }
  .avatar { flex: none; width: 40px; height: 40px; border-radius: 50%; background: #10b981; color: #fff;
    display: grid; place-items: center; font-weight: 600; font-size: 18px; }
  .card { flex: 1; min-width: 0; border: 1px solid #d1d9e0; border-radius: 6px; }
  .head { padding: 8px 16px; background: #f6f8fa; border-bottom: 1px solid #d1d9e0;
    border-radius: 6px 6px 0 0; color: #59636e; }
  .head strong { color: #1f2328; }
  .badge { margin-left: 6px; padding: 0 6px; border: 1px solid #d1d9e0; border-radius: 2em; font-size: 12px; }
  .body { padding: 16px; }
  .body > :first-child { margin-top: 0; }
  .body > :last-child { margin-bottom: 0; }
  h4 { margin: 0 0 16px; font-size: 1em; font-weight: 600; }
  p, ul { margin: 0 0 16px; }
  ul { padding-left: 2em; }
  li + li { margin-top: 4px; }
  code { padding: 0.2em 0.4em; border-radius: 6px; background: rgba(129, 139, 152, 0.12); font-size: 85%;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace; }
  .emoji { display: inline-block; width: 1em; height: 1em; border-radius: 50%; background: #a371f7;
    vertical-align: -0.125em; }
</style></head><body>
  <div class="comment" data-shot="pr-comment">
    <div class="avatar" aria-hidden="true">P</div>
    <div class="card">
      <div class="head"><strong>piwi-dashboard</strong><span class="badge">bot</span> commented 2 minutes ago</div>
      <div class="body">${body}</div>
    </div>
  </div>
</body></html>`;
}

/** Serve the demo's sources of the web dashboard's covered server files, by blob. */
async function serveCoverageSceneSource(page) {
  await page.route(
    (url) => url.pathname === `/api/projects/${COVERAGE_SCENE_PROJECT}/source`,
    (route) => {
      const url = new URL(route.request().url());
      const source = coverageSceneSource(url.searchParams.get('path'), url.searchParams.get('blob'));
      return source
        ? route.fulfill({ json: source })
        : route.fulfill({ status: 404, json: { message: 'Source not available' } });
    },
  );
}

/**
 * Open the users endpoints' coverage page with the demo's source served and
 * line 37 selected: the one line a single test of the three ran.
 */
async function openFileCoverageScene(page, goto, settle) {
  await serveCoverageSceneSource(page);
  await goto(`/projects/${COVERAGE_SCENE_PROJECT}/coverage?file=api/Users/UsersEndpoints.cs&line=37`);
  const view = page.locator('[data-shot="coverage-file"]');
  await view.locator('[data-coverage-source] [data-line="37"][data-selected]').waitFor({ timeout: 60_000 });
  await view.locator('[data-coverage-test]').first().waitFor({ timeout: 30_000 });
  await settle();
}

/**
 * Open execution 711 on its Source tab with the demo's suspect lines and
 * sources served, and unfold the users endpoints to their source.
 */
async function openCoverageScene(page, goto, settle) {
  await page.route(`**/api/test-run-cases/${COVERAGE_SCENE_EXECUTION}/suspect-lines`, (route) =>
    route.fulfill({ json: COVERAGE_SCENE_SUSPECT_LINES }),
  );
  await serveCoverageSceneSource(page);
  await goto(`/test-run-cases/${COVERAGE_SCENE_EXECUTION}?evidence=source`);
  const section = page.locator('[data-shot="execution-coverage"]');
  await section.locator('[data-coverage-mark="suspect"]').waitFor({ timeout: 60_000 });
  await section.getByRole('button', { name: 'Show the source of api/Users/UsersEndpoints.cs' }).click();
  await section.locator('[data-coverage-source] [data-not-executed]').first().waitFor({ timeout: 30_000 });
  await settle();
}

/** Attributes the region capture puts on the page, and takes off again. */
const REGION_ATTR = 'data-shot-region';
const KEEP_ATTR = 'data-shot-keep';

/**
 * Mark the nearest common ancestor of `selectors`, and the ancestor's children
 * that lead to one of them. Returns how many targets were resolved.
 *
 * A region is captured by screenshotting that ancestor with its other children
 * hidden, rather than by clipping the viewport: the dashboard scrolls inside a
 * panel instead of moving the document, so `locator.screenshot()` — which
 * scrolls the element into view and stitches one taller than the viewport — is
 * the only primitive that reliably gets the whole thing.
 */
function markRegion({ selectors, regionAttr, keepAttr }) {
  const targets = selectors.map((s) => document.querySelector(s));
  const missing = selectors.filter((_, i) => !targets[i]);
  if (missing.length > 0) return { missing };

  const ancestorsOf = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) chain.push(n);
    return chain;
  };
  const chains = targets.map(ancestorsOf);
  const common = chains[0].find((candidate) => chains.every((chain) => chain.includes(candidate)));
  // The common ancestor of a single target is the target itself; step up so the
  // capture has somewhere to put the padding.
  const region = targets.length === 1 ? (common.parentElement ?? common) : common;

  region.setAttribute(regionAttr, '');
  for (const child of region.children) {
    if (targets.some((t) => child === t || child.contains(t))) child.setAttribute(keepAttr, '');
  }
  // A grid item stretches to its row's height by default, which is what leaves
  // blank space under a shortened region. `align-self` fixes that, but in a
  // flex column the same property works on the horizontal axis and would
  // narrow the capture instead — so it is applied only for grid parents.
  const parentDisplay = region.parentElement ? getComputedStyle(region.parentElement).display : '';
  return { missing: [], gridParent: parentDisplay === 'grid' || parentDisplay === 'inline-grid' };
}

function unmarkRegion({ regionAttr, keepAttr }) {
  for (const el of document.querySelectorAll(`[${regionAttr}]`)) el.removeAttribute(regionAttr);
  for (const el of document.querySelectorAll(`[${keepAttr}]`)) el.removeAttribute(keepAttr);
}

/**
 * Fail when the capture target is taller than the viewport.
 *
 * An element screenshot of something that does not fit comes back the full
 * height of the element with everything past the viewport left blank, which
 * looks like a page that simply ends — the quiet kind of wrong this harness is
 * meant to rule out. The message names the viewport that would work.
 */
async function assertFitsViewport(page, locator, sceneName, what) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${what} has no bounding box — is it visible?`);
  const viewport = page.viewportSize();
  if (box.height <= viewport.height) return;
  throw new Error(
    `${what} is ${Math.ceil(box.height)}px tall and does not fit the ` +
      `${viewport.width}×${viewport.height} viewport — give scene "${sceneName}" ` +
      `viewport: { width: ${viewport.width}, height: ${Math.ceil(box.height) + 40} }`,
  );
}

/**
 * CSS applied for the capture only: hide everything in the region that is not
 * on the way to a target, and turn `pad` into the region's own padding so the
 * image gets breathing room outside the elements' borders.
 */
function regionStyle(pad, { gridParent = false } = {}) {
  const heightResets = 'height: auto !important; min-height: 0 !important; max-height: none !important;';
  return [
    `[${REGION_ATTR}] > *:not([${KEEP_ATTR}]) { display: none !important; }`,
    // Height resets shrink the region to what the hiding left behind; without
    // them a container stretched to fill its panel hands the capture its own
    // trailing blank space.
    `[${REGION_ATTR}] { padding: ${pad}px !important; margin: 0 !important; ${heightResets} }`,
    gridParent ? `[${REGION_ATTR}] { align-self: start !important; }` : '',
    `[${REGION_ATTR}] > [${KEEP_ATTR}] { ${heightResets} }`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Levenshtein distance, for suggesting what the user meant by an unknown scene. */
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[a.length][b.length];
}

function nearestScenes(name) {
  return SCENES.map((s) => ({ name: s.name, d: editDistance(name, s.name) }))
    .filter((s) => s.d <= Math.max(3, Math.floor(name.length / 2)) || s.name.includes(name))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((s) => s.name);
}

function listScenes() {
  const width = Math.max(...SCENES.map((s) => s.name.length));
  for (const scene of SCENES) {
    const tags = (scene.tags ?? []).join(',') || '—';
    const dir = scene.out ?? 'screens';
    console.log(`${scene.name.padEnd(width)}  ${sceneMode(scene).padEnd(7)} [${tags}]  ${scene.description}`);
    console.log(`${' '.repeat(width)}  → ${dir}/${sceneOutputs(scene).join(', ')}`);
  }
}

/**
 * Check the committed docs illustrations against the scene registry: every docs
 * scene must have its image on disk, and every image must have a scene (or be a
 * documented product of the marketing pipeline).
 */
function checkDocsImages() {
  const docsScenes = SCENES.filter((s) => (s.out ?? 'screens') === 'docs');
  const produced = new Map();
  for (const scene of docsScenes) {
    for (const file of sceneOutputs(scene)) produced.set(file, scene.name);
  }

  const onDisk = existsSync(DOCS_SHOTS_DIR) ? readdirSync(DOCS_SHOTS_DIR).filter((f) => f.endsWith('.png')) : [];

  const external = (file) =>
    EXTERNAL_DOCS_IMAGES.has(file) || EXTERNAL_DOCS_IMAGE_PREFIXES.some((prefix) => file.startsWith(prefix));
  const missing = [...produced.entries()].filter(([file]) => !onDisk.includes(file));
  const orphans = onDisk.filter((f) => !produced.has(f) && !external(f));
  const staleAllowlist = [...EXTERNAL_DOCS_IMAGES].filter((f) => !onDisk.includes(f));

  for (const [file, scene] of missing) {
    console.error(`missing: ${file} — scene "${scene}" produces it, but it is not committed`);
  }
  for (const file of orphans) {
    console.error(`orphan:  ${file} — no scene produces it; add one, or list it in EXTERNAL_DOCS_IMAGES`);
  }
  for (const file of staleAllowlist) {
    console.error(`stale:   ${file} — listed in EXTERNAL_DOCS_IMAGES but no longer on disk`);
  }

  const problems = missing.length + orphans.length + staleAllowlist.length;
  if (problems === 0) {
    console.log(
      `All good: ${produced.size} image(s) from ${docsScenes.length} scene(s), ` +
        `${onDisk.filter(external).length} from the other pipelines.`,
    );
    return true;
  }
  console.error(`\n${problems} problem(s) in ${DOCS_SHOTS_DIR}`);
  return false;
}

function parseArgs(argv) {
  const flags = {
    scenes: [],
    tag: null,
    url: null,
    out: null,
    freezeNow: null,
    list: false,
    check: false,
    route: null,
    width: null,
    height: null,
    expand: false,
    name: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') flags.list = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--tag') flags.tag = argv[++i];
    else if (arg === '--url') flags.url = argv[++i];
    else if (arg === '--out') flags.out = resolve(process.cwd(), argv[++i]);
    else if (arg === '--freeze-now') flags.freezeNow = argv[++i];
    else if (arg === '--route') flags.route = argv[++i];
    else if (arg === '--width') flags.width = Number(argv[++i]);
    else if (arg === '--height') flags.height = Number(argv[++i]);
    else if (arg === '--expand') flags.expand = true;
    else if (arg === '--name') flags.name = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    else flags.scenes.push(arg);
  }
  return flags;
}

/**
 * The one-off scene behind `--route`: one page, captured like a registered
 * scene but never listed and never checked against the docs images.
 */
function adHocScene(flags) {
  if (!flags.route.startsWith('/')) throw new Error(`--route needs an absolute path, got "${flags.route}"`);
  for (const [flag, value] of [
    ['--width', flags.width],
    ['--height', flags.height],
  ]) {
    if (value != null && !(Number.isInteger(value) && value > 0)) throw new Error(`${flag} needs a positive integer`);
  }
  const slug =
    flags.route
      .replace(/^\//, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '') || 'home';
  return {
    name: flags.name ?? `route-${slug}`,
    route: flags.route,
    viewport: { width: flags.width ?? DEFAULT_VIEWPORT.width, height: flags.height ?? DEFAULT_VIEWPORT.height },
    expandAll: flags.expand,
    out: 'screens',
  };
}

function selectScenes(flags) {
  const badMode = SCENES.filter((s) => s.mode != null && !MODES.includes(s.mode));
  if (badMode.length) {
    throw new Error(
      `scene(s) with an unknown mode: ${badMode.map((s) => `${s.name} (${s.mode})`).join(', ')} — use one of ${MODES.join(', ')}`,
    );
  }
  const unknown = flags.scenes.filter((w) => !SCENES.some((s) => s.name === w));
  if (unknown.length) {
    const hints = unknown
      .map((u) => {
        const near = nearestScenes(u);
        return near.length ? `${u} (did you mean ${near.join(', ')}?)` : u;
      })
      .join('; ');
    throw new Error(`unknown scene(s): ${hints} — see --list`);
  }
  let scenes = flags.scenes.length ? SCENES.filter((s) => flags.scenes.includes(s.name)) : SCENES;
  if (flags.tag) {
    scenes = scenes.filter((s) => (s.tags ?? []).includes(flags.tag));
    if (scenes.length === 0) {
      const known = [...new Set(SCENES.flatMap((s) => s.tags ?? []))].join(', ');
      throw new Error(`no scenes tagged "${flags.tag}" — known tags: ${known}`);
    }
  }
  return scenes;
}

/** Run one scene in its own context; returns the number of images written. */
async function captureScene(browser, scene, { base, outDir, freezeNow }) {
  const context = await browser.newContext({
    viewport: scene.viewport ?? DEFAULT_VIEWPORT,
    colorScheme: scene.colorScheme,
    deviceScaleFactor: scene.deviceScaleFactor,
  });
  if (freezeNow) await context.clock.setFixedTime(freezeNow);
  if (sceneMode(scene) === 'desktop') await context.addInitScript(bridgeScript(scene));
  if (!scene.pickerHint) await context.addInitScript(() => localStorage.setItem('piwi-picker-hint-dismissed', 'true'));
  const page = await context.newPage();
  // A dev server compiles routes on first hit — well past the 30s default.
  page.setDefaultNavigationTimeout(90_000);

  const settle = (opts = {}) => settlePage(page, { charts: scene.charts, ...opts });

  const goto = async (path) => {
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await settle();
  };

  /** Unfold a collapsible section, and fail loudly if it has no toggle to click. */
  const expand = async (selector) => {
    const toggle = page.locator(`${selector} [role="button"][aria-expanded]`).first();
    await toggle.waitFor({ state: 'visible', timeout: 20_000 });
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    await page
      .locator(`${selector} [role="button"][aria-expanded="true"]`)
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 });
    await settle();
  };

  /**
   * Unfold every collapsed section on the page. Each click shrinks the set of
   * folded toggles (and may reveal new ones), so the first match is clicked
   * until none is left, with a ceiling so a toggle that never flips cannot
   * loop forever.
   */
  const expandAll = async () => {
    const folded = page.locator('main [role="button"][aria-expanded="false"]');
    for (let i = 0; i < 40 && (await folded.count()) > 0; i++) {
      await folded.first().click();
      await page.waitForTimeout(100);
    }
    await settle();
  };

  /**
   * Open a tab by its visible name and assert it really opened. A renamed or
   * removed tab then fails here instead of capturing whatever screen was
   * already on display.
   */
  const openTab = async (name, { panel } = {}) => {
    const tab = page.getByRole('tab', { name }).first();
    await tab.waitFor({ state: 'visible', timeout: 20_000 });
    await tab.click();
    await page.getByRole('tab', { name, selected: true }).first().waitFor({ timeout: 10_000 });
    if (panel) await page.locator(panel).first().waitFor({ state: 'visible', timeout: 20_000 });
    await settle();
  };

  // Annotations are drawn inside whatever the scene captures, so they stay in
  // register with the content when the capture scrolls to it.
  const annotationHost = typeof scene.of === 'string' ? scene.of : null;
  const annotate = (shapes, opts = {}) => drawAnnotations(page, shapes, { container: annotationHost, ...opts });
  const clear = () => clearAnnotations(page);

  /** Take one screenshot of whatever the scene targets, as a buffer. */
  const capture = async (opts = {}) => {
    const { of: ofOpt, pad: padOpt, ...pwOpts } = opts;
    const of = ofOpt ?? scene.of;
    const pad = padOpt ?? scene.pad ?? 0;
    const common = { animations: 'disabled', caret: 'hide', ...pwOpts };

    if (of && !pad && !Array.isArray(of)) {
      const target = page.locator(of).first();
      await assertFitsViewport(page, target, scene.name, of);
      return target.screenshot(common);
    }
    if (of) {
      const selectors = Array.isArray(of) ? of : [of];
      const { missing, gridParent } = await page.evaluate(markRegion, {
        selectors,
        regionAttr: REGION_ATTR,
        keepAttr: KEEP_ATTR,
      });
      if (missing.length > 0) throw new Error(`capture target(s) not found: ${missing.join(', ')}`);
      // Applied as a real stylesheet rather than screenshot's `style` option so
      // the region can be measured in its captured shape before shooting it.
      const styleTag = await page.addStyleTag({ content: regionStyle(pad, { gridParent }) });
      const region = page.locator(`[${REGION_ATTR}]`);
      try {
        await assertFitsViewport(page, region, scene.name, selectors.join(' + '));
        return await region.screenshot(common);
      } finally {
        await styleTag.evaluate((node) => node.remove());
        await page.evaluate(unmarkRegion, { regionAttr: REGION_ATTR, keepAttr: KEEP_ATTR });
      }
    }
    return page.screenshot(common);
  };

  /** Store a theme preference and reload so the app boots already in it. */
  const setColorMode = async (mode) => {
    await page.evaluate(
      ([key, value]) => {
        document.cookie = `${key}=${value}; path=/; max-age=31536000; samesite=lax`;
      },
      [COLOR_MODE_COOKIE, mode],
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await settle();
  };

  let written = 0;
  const shoot = async (label, opts = {}) => {
    const stem = sceneFile(scene).replace(/\.png$/, '');
    const file = join(outDir, `${stem}${label ? `-${label}` : ''}.png`);

    let image;
    if (scene.split) {
      await setColorMode('light');
      const light = await capture(opts);
      await setColorMode('dark');
      const dark = await capture(opts);
      image = await compositeSplit(light, dark);
    } else {
      image = await capture(opts);
    }

    // Resizing re-encodes anyway, so pay for the palette here: a dashboard
    // screenshot is mostly flat fills and quantizes to a third of the bytes
    // with no visible loss. Scenes that skip this keep Playwright's own bytes.
    if (scene.outputWidth) {
      image = await sharp(image)
        .resize({ width: scene.outputWidth })
        .png({ palette: true, compressionLevel: 9 })
        .toBuffer();
    }
    writeFileSync(file, image);
    written++;
    console.log(`-> ${file.replace(`${APP_DIR}/`, '').replace(`${APP_DIR}`, '')}`);
  };

  try {
    if (scene.prepare) await scene.prepare({ base, request: context.request });
    await goto(scene.route ?? '/');
    for (const selector of scene.expand ?? []) await expand(selector);
    if (scene.expandAll) await expandAll();
    if (scene.run) {
      await scene.run({ page, base, shoot, goto, settle, openTab, expand, annotate, clear });
    }
    // A declarative scene captures itself; one with `run` has already shot what
    // it wanted, unless it only set up the page for a declarative capture.
    if (!scene.run) await shoot();
    if (scene.annotate) {
      await annotate(scene.annotate);
      await shoot('annotated');
      await clear();
    }
    return written;
  } finally {
    await context.close();
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.list) {
    listScenes();
    return;
  }
  if (flags.check) {
    if (!checkDocsImages()) process.exit(1);
    return;
  }

  const scenes = flags.route ? [adHocScene(flags)] : selectScenes(flags);
  const freezeNow = flags.freezeNow ? new Date(flags.freezeNow) : null;
  if (freezeNow && Number.isNaN(freezeNow.getTime())) {
    throw new Error(`--freeze-now needs an ISO timestamp, got "${flags.freezeNow}"`);
  }

  for (const scene of scenes) mkdirSync(outDirFor(scene, flags.out), { recursive: true });
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  // Each mode needs a differently-configured server, so each mode present in
  // the run gets its own; --url drives whatever is already there.
  const byMode = MODES.map((mode) => [mode, scenes.filter((s) => sceneMode(s) === mode)]).filter(
    ([, group]) => group.length > 0,
  );

  const failures = [];
  let written = 0;
  try {
    for (const [mode, group] of byMode) {
      const server = flags.url
        ? { base: flags.url, stop: () => {} }
        : mode === 'demo'
          ? await startBuiltDemo()
          : await startServer({ mode });
      try {
        for (const scene of group) {
          try {
            written += await captureScene(browser, scene, {
              base: server.base,
              outDir: outDirFor(scene, flags.out),
              freezeNow,
            });
          } catch (err) {
            failures.push(scene.name);
            console.error(`scene ${scene.name} failed: ${err.message}`);
          }
        }
      } finally {
        server.stop();
        if (!flags.url) await waitForPortFree(server.base);
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length) throw new Error(`scenes failed: ${failures.join(', ')}`);
  console.log(`All done! ${written} image(s) from ${scenes.length} scene(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
