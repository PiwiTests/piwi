#!/usr/bin/env node
/**
 * Generates public/demo/seed.sql – the SQLite seed file loaded by the
 * in-browser demo database.
 *
 * Run with:  node scripts/generate-demo-seed.mjs
 *
 * The script produces a self-contained SQL file with:
 *  1. CREATE TABLE statements (complete current schema)
 *  2. INSERT statements for realistic demo data
 *
 * All failure data derives from the story fixtures in
 * `shared/demo/failure-stories.mjs` — the same module the demo SCM history,
 * the run simulator and the consistency test consume — so every error string,
 * source snippet, line number, suspect commit and suggested-fix patch agrees
 * across the whole demo by construction. Fingerprints are computed with the
 * mirror of the real clustering algorithm (`shared/demo/demo-fingerprint.mjs`),
 * so live simulated failures join the seeded clusters.
 *
 * Generation is deterministic (seeded PRNG): re-running without changes
 * produces byte-identical SQL, keeping the demo staleness hash stable.
 *
 * It also writes public/demo/seed.version.json containing a SHA-256 hash of
 * the generated SQL content.  The Nuxt build reads this hash and exposes it
 * as runtime config so the demo SPA can detect stale IndexedDB data.
 */

import { writeFileSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

import {
  FAILURE_STORIES,
  DEMO_PROJECTS,
  SCM_REPOS,
  SOURCE_FILES,
  lineOf,
  buildWebAssertionError,
  buildTestSource,
  buildSourceFrames,
  storyByClusterId,
  FAILURE_TEARDOWN_MS,
  failingCallDuration,
  failingStep,
  authoredFailureSteps,
  authoredBeforeEachMs,
  storyEvidenceTimes,
} from '../shared/demo/failure-stories.mjs';
import { demoTestMeta, demoTags, demoLocks, buildAiUsage } from '../shared/demo/demo-test-meta.mjs';
import { computeDemoFingerprint } from '../shared/demo/demo-fingerprint.mjs';
import { demoExecutionResources, demoResourceReport } from '../shared/demo/demo-resources.mjs';
import { resourceFingerprint } from '../shared/resource-fingerprint.mjs';
import {
  WEB_DASHBOARD_PROJECT_ID,
  buildWebDashboardTestMap,
  webDashboardFinalPage,
  webDashboardPassingConsole,
  webDashboardRequests,
  webDashboardStepTitles,
} from '../shared/demo/demo-test-map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable so concurrent callers (e.g. two unit test files regenerating in
// their own beforeAll) can each write to an isolated directory instead of
// racing on the single tracked public/demo/seed.sql.
const OUTPUT_DIR = process.env.PIWI_DEMO_SEED_OUTPUT_DIR || join(__dirname, '../public/demo');
const OUTPUT = join(OUTPUT_DIR, 'seed.sql');

// Canonical demo identities and groups — shared with the runtime app (app/demo/demo-users.ts).
const DEMO_ACCESS = JSON.parse(readFileSync(join(__dirname, '../app/demo/demo-users.json'), 'utf-8'));
const DEMO_USERS = DEMO_ACCESS.users;
const DEMO_GROUPS = DEMO_ACCESS.groups;
/** The identity the demo opens as (`DEFAULT_DEMO_USER_ID`), an administrator. */
const DEFAULT_DEMO_USER = DEMO_USERS.find((u) => u.id === 1);

// ── Helpers ────────────────────────────────────────────────────────────────

function ts(isoDate) {
  return Math.floor(new Date(isoDate).getTime() / 1000);
}

function q(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insert(table, rows) {
  return rows
    .map((row) => {
      const cols = Object.keys(row).join(', ');
      const vals = Object.values(row).map(q).join(', ');
      return `INSERT INTO ${table} (${cols}) VALUES (${vals});`;
    })
    .join('\n');
}

// Deterministic PRNG (mulberry32) so regeneration is reproducible: identical
// inputs → identical seed.sql → identical staleness hash.
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x5eed);

// ── Schema (derived from Drizzle migrations) ────────────────────────────────
// Read migrations in journal order so the demo schema always matches the server
// schema automatically — no manual sync needed when columns are added.
// The --> statement-breakpoint markers are Drizzle meta-comments; strip them so
// sql.js only sees plain SQL statements.
const MIGRATIONS_DIR = join(__dirname, '../server/database/migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf-8'));

const SCHEMA = journal.entries
  .sort((a, b) => a.idx - b.idx)
  .map((entry) =>
    readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), 'utf-8')
      .replace(/--> statement-breakpoint/g, '')
      .trim(),
  )
  .join('\n\n');

// ── Fingerprints (real algorithm mirror) ───────────────────────────────────
// One fingerprint per story; every per-case error variant of a story MUST hash
// identically (frames are not part of the hash), or the seed aborts.

const storyFingerprints = new Map();
for (const story of FAILURE_STORIES) {
  const fps = await Promise.all(story.failingCases.map((fc) => computeDemoFingerprint(fc.error)));
  for (const fp of fps.slice(1)) {
    if (fp.fingerprint !== fps[0].fingerprint) {
      throw new Error(`Story ${story.key}: per-case error variants produce different fingerprints`);
    }
  }
  storyFingerprints.set(story.clusterId, fps[0]);
}

// ── Demo data ─────────────────────────────────────────────────────────────

// Tags
// Colors come from the curated TAG_COLOR_PALETTE (Tailwind 500 shades) so the
// demo shows the same tag styling users get. Keep them hex — TagBadge accepts
// any CSS color, but hex is what the tag editor stores.
const TAGS = [
  { id: 1, text: 'smoke', color: '#14b8a6', created_at: ts('2025-03-01'), updated_at: ts('2025-03-01') },
  { id: 2, text: 'regression', color: '#6366f1', created_at: ts('2025-03-01'), updated_at: ts('2025-03-01') },
  { id: 3, text: 'critical', color: '#ef4444', created_at: ts('2025-03-15'), updated_at: ts('2025-03-15') },
  { id: 4, text: 'performance', color: '#f59e0b', created_at: ts('2025-04-01'), updated_at: ts('2025-04-01') },
];

// Projects
const PROJECTS = [
  {
    id: 1,
    name: 'e2e-checkout',
    label: 'E2E Checkout',
    description: 'End-to-end tests for the checkout flow',
    created_at: ts('2025-03-01'),
    updated_at: ts('2025-04-25T08:30:00'),
    // Targets the checkout suite misses, so the demo report has missed targets in its risks.
    targets: { testPassRate: 99, maxFlakyTests: 2, maxMedianTimeToFixDays: 3 },
  },
  {
    id: 2,
    name: 'api-integration',
    label: 'API Integration',
    description: 'Integration tests for REST API endpoints',
    created_at: ts('2025-02-15'),
    updated_at: ts('2025-04-25T07:15:00'),
  },
  {
    id: 3,
    name: 'ui-components',
    label: 'UI Components',
    description: 'Visual regression tests for UI components',
    created_at: ts('2025-01-10'),
    updated_at: ts('2025-04-24T16:45:00'),
    // Targets the component suite meets.
    targets: { testPassRate: 60, maxOpenClusterAgeDays: 400 },
  },
  {
    id: 4,
    name: 'mobile-safari',
    label: 'Mobile Safari',
    description: 'Mobile Safari browser compatibility tests',
    created_at: ts('2025-04-01'),
    updated_at: ts('2025-04-20T12:00:00'),
    // Project-level declines with no evidence behind them, so the demo shows the
    // `declined` state: the Timeline tab offers no "Add marker" control here, and
    // with no graph rows the Test Map decline hides the Gaps tab (server probes
    // ride it, so they go too).
    capabilities: { markers: 'declined', 'test-map': 'declined' },
  },
  {
    id: 5,
    name: 'web-dashboard',
    label: 'Web Dashboard',
    description: 'Cross-browser tests for the SaaS admin dashboard',
    created_at: ts('2025-02-20'),
    updated_at: ts('2025-04-25T09:10:00'),
  },
];

// Record each project's default branch from its SCM repo, so branch-aware
// baselines, flakiness scoping and the default-branch resolver have real data.
for (const project of PROJECTS) {
  project.default_branch = SCM_REPOS[project.id]?.defaultBranch ?? 'main';
}

// Project-tag associations
const PROJECT_TAGS = [
  { project_id: 1, tag_id: 1 }, // e2e-checkout → smoke
  { project_id: 1, tag_id: 3 }, // e2e-checkout → critical
  { project_id: 2, tag_id: 2 }, // api-integration → regression
  { project_id: 3, tag_id: 1 }, // ui-components → smoke
  { project_id: 3, tag_id: 4 }, // ui-components → performance
  { project_id: 4, tag_id: 2 }, // mobile-safari → regression
  { project_id: 5, tag_id: 2 }, // web-dashboard → regression
  { project_id: 5, tag_id: 3 }, // web-dashboard → critical
];

// Where e2e-checkout's application runs, for the browser extension (millisecond timestamps).
const URL_PATTERN_TIME = new Date('2025-04-20T09:00:00Z').getTime();
const PROJECT_URL_PATTERNS = [
  {
    pattern: 'https://staging.checkout.example.com/**',
    environment: 'staging',
    branch: 'develop',
    path_prefix: null,
    test_path_prefix: null,
  },
  {
    pattern: 'https://checkout.example.com/**',
    environment: 'production',
    branch: null,
    path_prefix: null,
    test_path_prefix: null,
  },
  // A preview deployment serving the app under /app, where the tests ran at the root.
  {
    pattern: 'https://preview.checkout.example.com/app/**',
    environment: 'preview',
    branch: null,
    path_prefix: '/app',
    test_path_prefix: null,
  },
  // A local build served at the root, where the tests ran under /shop.
  {
    pattern: 'http://localhost:4173/**',
    environment: 'local',
    branch: null,
    path_prefix: null,
    test_path_prefix: '/shop',
  },
].map((p, position) => ({
  id: position + 1,
  project_id: 1,
  ...p,
  position,
  created_at: URL_PATTERN_TIME,
  updated_at: URL_PATTERN_TIME,
}));

// ── Bug reports (sent from Piwi Picker's Report a bug) ─────────────────────
// One open report on the checkout project, with the steps a tester recorded on
// staging, the value the page showed, and the evidence they chose to send.
const BUG_REPORT_TIME = Math.floor(new Date('2025-04-24T15:20:00Z').getTime() / 1000);
const bugTarget = (t) => ({ tagName: 'button', role: null, accessibleName: null, testId: null, text: null, ...t });
const BUG_REPORTS = [
  {
    id: 1,
    project_id: 1,
    title: 'Coupon not applied to the total',
    note: null,
    page_key: '/cart',
    path: '/cart',
    origin: 'https://staging.checkout.example.com',
    status: 'open',
    steps: {
      v: 1,
      title: 'Coupon not applied to the total',
      origin: 'https://staging.checkout.example.com',
      recordedAt: 0,
      note: null,
      steps: [
        { action: 'goto', target: null, value: '/cart', redacted: false, pageUrl: '/cart', timestamp: 1 },
        {
          action: 'fill',
          target: bugTarget({
            tagName: 'input',
            role: 'textbox',
            accessibleName: 'Coupon',
            alternatives: [{ locator: "getByLabel('Coupon')", method: 'getByLabel', score: 90 }],
          }),
          value: 'SPRING10',
          redacted: false,
          pageUrl: '/cart',
          timestamp: 2,
        },
        {
          action: 'click',
          target: bugTarget({
            role: 'button',
            accessibleName: 'Apply coupon',
            alternatives: [
              { locator: "getByRole('button', { name: 'Apply coupon' })", method: 'getByRole', score: 90 },
            ],
          }),
          value: null,
          redacted: false,
          pageUrl: '/cart',
          timestamp: 3,
        },
        {
          action: 'assert',
          target: bugTarget({
            tagName: 'p',
            testId: 'cart-total',
            text: 'Total: 40.00',
            alternatives: [{ locator: "getByTestId('cart-total')", method: 'getByTestId', score: 95 }],
          }),
          value: null,
          redacted: false,
          pageUrl: '/cart',
          timestamp: 4,
          assertion: {
            matcher: 'toHaveText',
            expected: 'Total: 36.00',
            actual: 'Total: 40.00',
            negated: false,
            note: 'The 10% coupon is accepted but the total does not change',
          },
        },
      ],
    },
    evidence: {
      console: [{ level: 'error', source: 'console', message: 'Coupon service failed: 500', page: '/cart', time: 4 }],
      consoleDropped: 0,
      requests: [{ method: 'POST', url: '/api/cart/coupon', status: 500, page: '/cart', time: 4 }],
      requestsDropped: 0,
      screenshots: [],
      screenshotNote: 'none was taken',
      outline:
        '- main:\n  - heading "Your cart" [level=1]\n  - textbox "Coupon": SPRING10\n  - button "Apply coupon"\n  - paragraph: "Total: 40.00"',
    },
    context: {
      origin: 'https://staging.checkout.example.com',
      pageKey: '/cart',
      path: '/cart',
      browser: 'Chrome 141',
      userAgent: null,
      viewport: { width: 1440, height: 900 },
      time: 0,
      extensionVersion: '0.41.0',
    },
    language: 'en',
    created_at: BUG_REPORT_TIME,
    updated_at: BUG_REPORT_TIME,
  },
];
const BUG_REPRODUCTIONS = [
  {
    id: 1,
    bug_report_id: 1,
    source: 'replay',
    verdict: 'reproduced',
    diverged_at: null,
    origin: 'http://localhost:3000',
    user_agent: null,
    created_at: BUG_REPORT_TIME + 3600,
  },
];

// ── Timeline markers (dated project events overlaid on the trend charts) ────
// Dated within project 1's run window (newest run 2025-04-25T08:30Z, ~8h apart)
// so they land on the charts. Timestamps are rebased to load time like the runs.

// App settings — the `ai` key marks the demo's simulated provider as configured,
// so the setup page's AI probe reports active, matching the settings surface.
const APP_SETTINGS = [
  {
    key: 'ai',
    value: {
      autoDiagnose: false,
      roles: {
        diagnosis: { provider: 'demo', model: 'demo-simulated', baseUrl: null, apiKey: null },
      },
    },
    updated_at: ts('2025-04-20T09:00:00'),
  },
];
// Runs kept forever: the v2.4.0 release run (by the release marker linked to
// it below), one older run kept by hand, and one the reporter kept at ingest.
function keepColumnsFor(projectId, runIndex, startTime) {
  if (projectId === 1 && runIndex === 0) {
    return { kept_at: startTime, kept_by: null, keep_source: 'marker', keep_reason: 'v2.4.0' };
  }
  if (projectId === 1 && runIndex === 17) {
    return {
      kept_at: startTime + 7200,
      kept_by: null,
      keep_source: 'user',
      keep_reason: 'Reference run for the Q2 audit',
    };
  }
  if (projectId === 2 && runIndex === 10) {
    return { kept_at: startTime, kept_by: null, keep_source: 'reporter', keep_reason: null };
  }
  return { kept_at: null, kept_by: null, keep_source: null, keep_reason: null };
}

const MARKERS = [
  {
    id: 1,
    project_id: 1,
    occurred_at: ts('2025-04-22T12:00:00Z'),
    label: 'Deployed checkout v2.4.0',
    description: 'Rolled out the new payment provider integration.',
    category: 'deploy',
    environment: null,
    source: 'manual',
    run_id: null,
    created_at: ts('2025-04-22T12:00:00Z'),
    updated_at: ts('2025-04-22T12:00:00Z'),
  },
  {
    id: 2,
    project_id: 1,
    occurred_at: ts('2025-04-20T09:00:00Z'),
    label: 'Enabled strict CSP in production',
    description: 'Tightened the content-security-policy header on the prod storefront.',
    category: 'config',
    environment: 'production',
    source: 'manual',
    run_id: null,
    created_at: ts('2025-04-20T09:00:00Z'),
    updated_at: ts('2025-04-20T09:00:00Z'),
  },
  {
    id: 3,
    project_id: 1,
    occurred_at: ts('2025-04-24T18:30:00Z'),
    label: 'Upstream payment API outage',
    description: 'Third-party sandbox was down for ~40 min; expect failed checkouts.',
    category: 'incident',
    environment: null,
    source: 'manual',
    run_id: null,
    created_at: ts('2025-04-24T18:30:00Z'),
    updated_at: ts('2025-04-24T18:30:00Z'),
  },
];

// ── Test suites & cases (from the fixture module) ──────────────────────────

const TEST_SUITES = [];
const TEST_CASES = [];
let tsId = 1;
let tcId = 1;
const suiteNow = ts('2025-03-01');
const suiteLookup = {}; // projectId → filePath → suiteId
const caseIdsByProject = {}; // projectId → [caseId] (in DEMO_PROJECTS order)
const caseById = new Map(); // caseId → { projectId, file, title, declLine, declColumn }
const caseIdByKey = new Map(); // `${projectId}\x00${file}\x00${title}` → caseId

// Cases that are prone to flake (retry-pass) — their `flaky_root_cause` is set
// coherently instead of at random. Tags and `piwi:` ownership come from the
// shared demo-test-meta module (the same rules the run simulator uses). A case
// whose failed attempts no dedicated block below writes carries the error its
// failed attempt reports, as the reporter would capture it.

const darkModeAssertion = "await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');";
const FLAKY_CASES = {
  1: { title: 'should apply discount code', rootCause: 'timing' },
  2: { title: 'GET /search handles empty query', rootCause: 'network' },
  3: { title: 'Table pagination works correctly', rootCause: 'timing' },
  4: { title: 'Pull to refresh triggers reload', rootCause: 'timing' },
  5: {
    title: 'toggles dark mode',
    rootCause: 'other',
    error: buildWebAssertionError({
      matcher: 'expect(locator).toHaveAttribute(expected)',
      locator: "locator('html')",
      expected: '"dark"',
      received: '"light"',
      timeoutMs: 5000,
      callLog: [
        'Expect "toHaveAttribute" with timeout 5000ms',
        "waiting for locator('html')",
        '  9 × locator resolved to <html lang="en" data-theme="light">…</html>',
        '    - unexpected value "light"',
      ],
      frames: [
        {
          file: 'tests/admin/settings.spec.ts',
          line: lineOf(SOURCE_FILES['tests/admin/settings.spec.ts'], darkModeAssertion),
          column: 40,
        },
      ],
    }),
  },
};

for (const proj of DEMO_PROJECTS) {
  suiteLookup[proj.id] = {};
  for (const [fp, def] of Object.entries(proj.suites)) {
    suiteLookup[proj.id][fp] = tsId;
    TEST_SUITES.push({
      id: tsId,
      project_id: proj.id,
      file_path: fp,
      suite_path: def.suitePath.join('\x1f'),
      mode: def.mode,
      annotations: JSON.stringify(def.annotations),
      created_at: suiteNow,
      updated_at: suiteNow,
    });
    tsId++;
  }

  caseIdsByProject[proj.id] = [];
  for (const c of proj.cases) {
    const flaky = FLAKY_CASES[proj.id]?.title === c.title ? FLAKY_CASES[proj.id] : null;
    TEST_CASES.push({
      id: tcId,
      project_id: proj.id,
      file_path: c.file,
      suite_path: proj.suites[c.file]?.suitePath.join('\x1f') ?? '',
      suite_id: suiteLookup[proj.id][c.file] ?? null,
      title: c.title,
      flaky_root_cause: flaky?.rootCause ?? null,
      tags: JSON.stringify(demoTags(c.file, proj.cases.indexOf(c))),
      locks: JSON.stringify(demoLocks(c.file, proj.cases.indexOf(c))),
      owner: demoTestMeta(c.file, proj.cases.indexOf(c))?.owner ?? null,
      priority: demoTestMeta(c.file, proj.cases.indexOf(c))?.priority ?? null,
      feature: demoTestMeta(c.file, proj.cases.indexOf(c))?.feature ?? null,
      link: null,
      created_at: suiteNow,
      updated_at: suiteNow,
    });
    caseIdsByProject[proj.id].push(tcId);
    caseById.set(tcId, { projectId: proj.id, ...c });
    caseIdByKey.set(`${proj.id}\x00${c.file}\x00${c.title}`, tcId);
    tcId++;
  }
}

/** Story cluster membership: caseId → story, per project. */
const storyByCaseId = new Map(); // caseId → { story, failingCase }
for (const story of FAILURE_STORIES) {
  for (const fc of story.failingCases) {
    const caseId = caseIdByKey.get(`${story.projectId}\x00${story.specFile}\x00${fc.title}`);
    if (!caseId) throw new Error(`Story ${story.key}: failing case not found: ${fc.title}`);
    storyByCaseId.set(caseId, { story, failingCase: fc });
  }
}

// ── Test runs + test_runs_cases ────────────────────────────────────────────

// Simple URL normalizer for seed data (mirrors shared/utils/route.ts)
function seedNormalizeUrl(url) {
  try {
    const parsed = new URL(url);
    let pathname = parsed.pathname;
    pathname = pathname.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:uuid');
    pathname = pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return url;
  }
}

const TEST_RUNS = [];
const TEST_RUNS_CASES = [];
// Content-addressed payloads (the page each locator call ran on), one per distinct content.
const CASE_PAYLOADS = [];
const casePayloadIds = new Map();

/**
 * The `piwi-locator-pages` payload the capture fixtures would have recorded for
 * a case of this project: each step with a call site and a page, on the
 * project's origin. Null when the project's steps record none.
 */
function locatorPagesPayloadId(proj) {
  if (!proj.baseUrl) return null;
  const origin = new URL(proj.baseUrl).origin;
  const entries = proj.stepTitles
    .filter((st) => st.location && st.page && st.params?.locator)
    .map((st) => ({ location: st.location, locator: st.params.locator, origin, page: st.page, arrival: !!st.arrival }));
  if (entries.length === 0) return null;
  const content = JSON.stringify(entries);
  const key = `${proj.id}\x00${content}`;
  if (!casePayloadIds.has(key)) {
    const id = CASE_PAYLOADS.length + 1;
    CASE_PAYLOADS.push({
      id,
      project_id: proj.id,
      hash: createHash('sha256').update(content).digest('hex'),
      content,
      size: content.length,
      created_at: ts('2025-04-01'),
    });
    casePayloadIds.set(key, id);
  }
  return casePayloadIds.get(key);
}
const NETWORK_REQUESTS = [];
const REPORTS = [];
const FAILURE_CLUSTERS = [];

let runId = 1;
let trcId = 1;
let reportId = 1;
let nrId = 1;

const clusterStats = {};
for (const story of FAILURE_STORIES) {
  clusterStats[story.clusterId] = {
    occurrences: 0,
    firstRunId: null,
    lastRunId: null,
    firstStartMs: null,
    lastStartMs: null,
    // Distinct runs this cluster failed in, newest first. `occurrences` counts
    // retries too, so it cannot be used to find the runs where it went quiet.
    failedRuns: [],
  };
}

// Runs per project. Failure scheduling is story-driven (see below), so there is
// no blanket failure rate — only the flaky (retry-pass) rate is a dial here.
const PROJECT_CONFIGS = {
  1: { numRuns: 20, baseDuration: 145000, baseAvg: 4200, baseP90: 8900, flakyRate: 0.18 },
  2: { numRuns: 18, baseDuration: 82000, baseAvg: 2100, baseP90: 4800, flakyRate: 0.12 },
  3: { numRuns: 15, baseDuration: 310000, baseAvg: 8500, baseP90: 18000, flakyRate: 0.2 },
  4: { numRuns: 8, baseDuration: 190000, baseAvg: 5800, baseP90: 12000, flakyRate: 0.15 },
  5: { numRuns: 12, baseDuration: 210000, baseAvg: 5200, baseP90: 11000, flakyRate: 0.15 },
};

// Base start time (most recent run is at this time, older runs go backwards)
const BASE_START_MS = new Date('2025-04-25T08:30:00Z').getTime();

const ENVIRONMENTS = ['production', 'staging', 'integration', 'development'];
// The Playwright baseURL of e2e-checkout's runs in each environment; developers'
// runs alternate between two local servers.
const CHECKOUT_BASE_URLS = {
  production: ['https://checkout.example.com'],
  staging: ['https://staging.checkout.example.com'],
  integration: ['https://integration.checkout.example.com'],
  development: ['http://localhost:3000', 'http://localhost:5173'],
};
const RUN_GREPS = {
  1: 'checkout|cart',
  2: 'auth|orders',
  3: 'button|modal',
  4: 'navigation',
  5: 'users|reports',
};

// Parallel-worker model for seeded runs: tests are pulled round-robin across a
// fixed pool of workers and run back-to-back per worker (matching the demo
// simulator), so the Workers timeline shows dense rows instead of large gaps.
const SEED_WORKER_COUNT = 4;
const SEED_WORKER_GAP_MS = 200;
/** How long after a test starts its first captured request fires. */
const SEED_FIRST_REQUEST_OFFSET_MS = 120;
/** Idle time between one captured request finishing and the next starting. */
const SEED_REQUEST_GAP_MS = 35;

/**
 * A framework segment's share `f` of a test lasting `durationMs`, clamped
 * between `min` and `max` ms so it stays visible without overflowing a short test.
 */
function segmentMs(durationMs, f, min, max) {
  return Math.max(min, Math.min(max, Math.round(durationMs * f)));
}

/** The `Before Hooks` parts of a test lasting `durationMs`: its context and page fixtures, then its beforeEach hook. */
function seedBeforeHooks(durationMs) {
  return {
    context: segmentMs(durationMs, 0.04, 40, 120),
    page: segmentMs(durationMs, 0.03, 30, 90),
    beforeEach: segmentMs(durationMs, 0.06, 60, 200),
  };
}

/**
 * Build realistic `step_events` for a seeded case: the `Before Hooks` and
 * `After Hooks` sections with the hooks and fixtures they ran (as the reporter
 * records them), framework-injected waits, and — for wait-heavy cases — an
 * explicit `Wait for timeout` sleep that counts as wasted time under the
 * default wasted-wait patterns. `beforeHooks` sizes the before hooks (a case
 * running authored steps passes the beforeEach hook that holds them, 0 when
 * its spec has none). Segment offsets are emitted as absolute epoch ms
 * anchored to the case's start so the timeline can place each segment. Returns
 * the events plus the total wasted ms (sum of the explicit timeout sleeps).
 */
function buildSeedStepEvents(caseStartMs, caseDuration, location, waitHeavy, beforeHooks = null) {
  const events = [];
  let offset = 0;
  const seg = (title, category, duration, status, loc = null, hooks = null) => {
    const event = { title, category, startedAt: caseStartMs + offset, duration, status, location: loc };
    if (hooks) event.hooks = hooks;
    events.push(event);
    offset += duration;
  };
  const frac = (f, min, max) => segmentMs(caseDuration, f, min, max);

  const { context, page, beforeEach } = beforeHooks ?? seedBeforeHooks(caseDuration);
  seg('Before Hooks', 'hook', context + page + beforeEach, 'passed', null, [
    { title: 'Fixture "context"', category: 'fixture', duration: context },
    { title: 'Fixture "page"', category: 'fixture', duration: page },
    ...(beforeEach > 0 ? [{ title: 'beforeEach hook', category: 'hook', duration: beforeEach }] : []),
  ]);
  // Framework-injected navigation wait — not wasted.
  seg('Wait for load state', 'wait', frac(0.1, 80, 600), 'passed');

  let wastedMs = 0;
  if (waitHeavy) {
    // Explicit author sleep — wasted under DEFAULT_WASTED_WAIT_PATTERNS.
    const timeoutDur = frac(0.18, 400, 2500);
    seg('Wait for timeout', 'wait', timeoutDur, 'wasted', location);
    wastedMs += timeoutDur;
  }
  // Wait for selector — framework-injected, not wasted.
  seg('Wait for selector', 'wait', frac(0.06, 40, 500), 'passed');
  // Teardown closes the test, after its body.
  const afterHooks = frac(0.05, 50, 160);
  const afterEach = Math.round(afterHooks * 0.6);
  offset = Math.max(offset, caseDuration - afterHooks);
  seg('After Hooks', 'hook', afterHooks, 'passed', null, [
    { title: 'afterEach hook', category: 'hook', duration: afterEach },
    { title: 'Fixture "page"', category: 'fixture', duration: afterHooks - afterEach },
  ]);

  return { stepEvents: events, wastedMs };
}

/** Shape one themed step into the stored flat form, carrying its optional target/params. */
function shapeStep(src, duration, startTime) {
  const step = { title: src.title, duration, category: src.category, startTime };
  // Playwright 1.63 shape (some projects only): the target in `subtitle`,
  // curated arguments in `params`.
  if (src.subtitle) step.subtitle = src.subtitle;
  if (src.params) step.params = src.params;
  if (src.location) step.location = src.location;
  return step;
}

/** `file:line` of a `file:line:col` location. */
const fileLineOf = (location) => location?.replace(/:\d+$/, '') ?? null;

/**
 * The project as one of its tests runs it: a web-dashboard test runs the steps
 * of its own spec, from the Test Map model, and a failing one stops at the call
 * its error names; every other test runs its project's themed steps.
 */
function stepsProjectFor(proj, title, failing = null) {
  let own = proj.id === WEB_DASHBOARD_PROJECT_ID ? webDashboardStepTitles(title) : null;
  if (!own) return proj;
  const failingAt = failing ? fileLineOf(failing.call.location) : null;
  const stop = failingAt ? own.findIndex((st) => fileLineOf(st.location) === failingAt) : -1;
  if (stop >= 0) own = own.slice(0, stop + 1);
  return { ...proj, stepTitles: own };
}

/**
 * Scale a project's themed step titles to a case duration, laying each step's
 * absolute `startTime` end-to-end from `caseStartMs` so the failure timeline
 * places them on a real clock rather than estimating from durations. A themed
 * step with `children` becomes a `test.step`-style parent whose children lay
 * end-to-end inside its window, so the timeline's per-test waterfall nests them
 * by containment — the flat, pre-order shape Playwright's own step tree stores.
 */
function buildSteps(proj, caseDuration, caseStartMs) {
  const total = proj.stepTitles.reduce((s, st) => s + st.weight, 0);
  let cursor = caseStartMs;
  const out = [];
  for (const st of proj.stepTitles) {
    const duration = Math.round((st.weight / total) * caseDuration);
    const startTime = cursor;
    cursor += duration;
    out.push(shapeStep(st, duration, startTime));

    if (Array.isArray(st.children) && st.children.length > 0 && duration > 0) {
      const childTotal = st.children.reduce((s, c) => s + (c.weight || 1), 0);
      let childCursor = startTime;
      st.children.forEach((child, i) => {
        // Distribute the parent's window across its children; the last child
        // ends exactly at the parent's end so containment stays clean.
        const last = i === st.children.length - 1;
        const childDur = last
          ? Math.max(1, startTime + duration - childCursor)
          : Math.max(1, Math.round(((child.weight || 1) / childTotal) * duration));
        out.push(shapeStep(child, childDur, childCursor));
        childCursor += childDur;
      });
    }
  }
  return out;
}

/** A placed story step (`at`, ms from the test start) in the stored form, with its absolute `startTime`. */
function storedStep({ at, ...step }, caseStartMs) {
  const { title, duration, category, ...rest } = step;
  return { title, duration, category, startTime: caseStartMs + at, ...rest };
}

/**
 * The steps of a failing story case and how long it ran, from its error: the
 * failing call ends the steps, and lasts until the test timeout, for its own
 * action or expect timeout, or as long as the step it stands in for when it
 * failed without one. A case with authored steps runs those, stretched by how
 * fast this run drew it, once its fixtures are set up, and its beforeEach hook
 * (`beforeHooks`) holds the authored steps its spec runs there; any other runs
 * the project's themed steps with the failing call in place of the last one,
 * and a `test.step` around that one grows to hold it. `drawnMs` is the
 * duration drawn for the case, kept when the error says nothing about time.
 */
function storyFailureLayout(proj, failing, drawnMs, avgMs, caseStartMs) {
  const scale = drawnMs / avgMs;
  const { context, page } = seedBeforeHooks(drawnMs);
  const authored = authoredFailureSteps(failing, { scale, startMs: context + page });
  if (authored) {
    const step = authored.at(-1);
    return {
      steps: authored.map((s) => storedStep(s, caseStartMs)),
      step,
      durationMs: step.at + step.duration + FAILURE_TEARDOWN_MS,
      beforeHooks: { context, page, beforeEach: authoredBeforeEachMs(failing, { scale }) },
    };
  }
  const steps = buildSteps(proj, drawnMs, caseStartMs);
  const last = steps[steps.length - 1];
  const at = last.startTime - caseStartMs;
  const duration = failingCallDuration(failing.call, at, last.duration);
  steps[steps.length - 1] = storedStep(failingStep(failing, at, duration), caseStartMs);
  const end = last.startTime + duration;
  for (const parent of steps.slice(0, -1)) {
    const holdsLast =
      parent.category === 'test.step' &&
      parent.startTime <= last.startTime &&
      parent.startTime + parent.duration >= last.startTime + last.duration;
    if (holdsLast) parent.duration = Math.max(parent.duration, end - parent.startTime);
  }
  return {
    steps,
    step: { at, duration },
    durationMs: duration === last.duration ? drawnMs : at + duration + FAILURE_TEARDOWN_MS,
    beforeHooks: null,
  };
}

/**
 * Re-anchor a story's backend log entries onto the request that produced them.
 * The stories carry one illustrative epoch clock shared by every run, so used
 * verbatim the entries land wherever that clock sits relative to each run
 * (minutes to days away from the request). Keep their spacing and put the first
 * one mid-request, so the timeline's backend lane lines up with its request.
 */
function anchorServerLogs(logs, requestStartMs, requestDurationMs) {
  if (!logs?.length) return null;
  const first = Math.min(...logs.map((l) => l.timestamp));
  const at = requestStartMs + Math.round((requestDurationMs ?? 0) / 2);
  return logs.map((l) => ({ ...l, timestamp: at + (l.timestamp - first) }));
}

/** Themed network requests for one case (jittered durations; story overrides on failures). */
function buildNetwork(proj, storyEntry) {
  const base = proj.network.map((req) => ({
    ...req,
    duration: Math.max(8, Math.round(req.duration * (0.75 + rng() * 0.5))),
  }));
  const overrides = storyEntry?.story.evidence.failingNetwork ?? [];
  for (const over of overrides) {
    const idx = base.findIndex((r) => r.method === over.method && r.url === over.url);
    if (idx >= 0) base[idx] = { ...over };
    else base.push({ ...over });
  }
  return base.map((req) => ({ ...req, serverTraces: buildServerTraces(req) }));
}

/**
 * The requests one execution makes. A web-dashboard test makes the requests of its
 * Test Map journey, plus the requests its failure story adds; the themed list is
 * still built so the random stream the rest of the seed reads is unchanged.
 */
function executionRequests(proj, storyEntry, title) {
  const themed = buildNetwork(proj, storyEntry);
  if (proj.id !== WEB_DASHBOARD_PROJECT_ID) return themed;
  const journey = webDashboardRequests(title);
  const story = storyEntry?.story.evidence.failingNetwork ?? [];
  const fromStory = themed.filter((req) => story.some((o) => o.method === req.method && o.url === req.url));
  return [...journey, ...fromStory];
}

/**
 * Synthesize a small server-side span tree for a captured request so the demo
 * shows the X-Piwi-Trace waterfall. Pure arithmetic (no rng) to keep the seed
 * reproducible; span ids are scoped per request. Returns null for static assets.
 */
function buildServerTraces(req) {
  const rt = req.resourceType;
  if (rt && !['fetch', 'xhr', 'document', 'other'].includes(rt)) return null;
  const dur = Math.max(4, Math.round(req.duration ?? 20));
  const status = req.status ?? 200;
  const isErr = status >= 500;
  let path;
  try {
    path = new URL(req.url).pathname;
  } catch {
    path = req.url;
  }
  const spans = [
    {
      id: 'root',
      name: `${req.method} ${path}`,
      kind: 'server',
      startMs: 0,
      durMs: dur,
      status: isErr ? 'error' : 'ok',
      attrs: { 'http.method': req.method, 'http.route': path, 'http.status_code': status },
    },
  ];
  const isApi = !rt || rt === 'fetch' || rt === 'xhr';
  if (isApi && dur >= 12) {
    const leaf = path.split('/').filter(Boolean).slice(-1)[0] || 'rows';
    spans.push({
      id: 'db',
      parentId: 'root',
      name: `SELECT ${leaf}`,
      kind: 'db',
      startMs: Math.round(dur * 0.12),
      durMs: Math.round(dur * 0.4),
    });
  }
  if (isErr) {
    spans.push({
      id: 'handler',
      parentId: 'root',
      name: 'unhandled exception',
      kind: 'internal',
      startMs: Math.round(dur * 0.75),
      durMs: Math.max(2, Math.round(dur * 0.2)),
      status: 'error',
    });
  }
  return spans;
}

/** Themed web vitals; failing pages render slower. */
function buildWebVitals(proj, failing) {
  if (!proj.webVitals) return null;
  const slow = failing ? 1.6 : 1;
  const url = proj.pageState?.url ?? proj.baseUrl ?? 'https://example.com/';
  return {
    navigation: {
      url,
      ttfb: Math.round((90 + rng() * 120) * slow),
      domInteractive: Math.round((700 + rng() * 600) * slow),
      domContentLoaded: Math.round((1000 + rng() * 800) * slow),
      loadComplete: Math.round((1500 + rng() * 1000) * slow),
    },
    paint: {
      firstPaint: Math.round((600 + rng() * 400) * slow),
      firstContentfulPaint: Math.round((800 + rng() * 500) * slow),
    },
    vitals: {
      lcp: Math.round((1200 + rng() * 1400) * slow),
      cls: Math.round(rng() * 0.2 * 10000) / 10000,
      // INP is frequently absent in short tests — mirror that in the seed.
      inp: rng() < 0.6 ? Math.round(80 + rng() * 250) : null,
    },
  };
}

/**
 * Themed page state; failing stories may drop localStorage keys (e.g. an
 * unresolved quote) and say what the page was doing (a focused field).
 */
function buildPageState(proj, storyEntry, title) {
  if (!proj.pageState) return null;
  const drop = new Set(storyEntry?.story.evidence.pageStateDropKeys ?? []);
  // A web-dashboard test ends on the last page of its Test Map journey.
  const finalPage = proj.id === WEB_DASHBOARD_PROJECT_ID ? webDashboardFinalPage(title) : null;
  return {
    url: finalPage ?? proj.pageState.url,
    hash: null,
    historyState: null,
    localStorage: proj.pageState.localStorage.filter((e) => !drop.has(e.key)),
    sessionStorage: proj.pageState.sessionStorage,
    cookies: proj.pageState.cookies,
    ...storyEntry?.story.evidence.pageInteraction,
  };
}

// Serial-group cascade: in one checkout run the first cart test fails, and the
// serial `Cart` describe skips the rest — the tests it blocked link back to it.
// It rides a story-free run so it neither collides with a cluster failure nor
// perturbs the deterministic rng stream the rest of the seed depends on.
const CASCADE_BLOCKER_LOCATION = 'tests/checkout/cart.spec.ts:4:3';
const CASCADE_BLOCKER_ERROR =
  'Error: expect(locator).toHaveText(expected)\n\n' +
  "Locator: getByTestId('cart-count')\n" +
  'Expected string: "1"\n' +
  'Received string: "0"\n' +
  '    at tests/checkout/cart.spec.ts:4:3';
const CASCADE_BLOCKED_TITLES = [
  'should remove item from cart',
  'should update item quantity',
  'should apply discount code',
  'should display cart total correctly',
];

/** The test timeout a story's error reports for a case, in ms; null when its error is no test timeout. */
function storyTestTimeoutOf(caseId) {
  const call = storyByCaseId.get(caseId)?.failingCase.call;
  return call?.timeout === 'test' ? call.timeoutMs : null;
}

/**
 * Effective per-test timeout (ms), stable per test case across runs. Most tests
 * keep a healthy 20s budget that timeout-hygiene never flags (its headroom
 * stays under the 20s floor); the designated slow case keeps a tripled 90s
 * budget it no longer needs, and one non-slow case per project is deliberately
 * oversized at 120s — so the demo shows both opportunity kinds (stale
 * test.slow() and oversized-timeout). A case whose story error is a test
 * timeout keeps the timeout that error reports, and one whose failing call
 * timed out on its own gets a test timeout that leaves room for it.
 */
function caseTimeoutOf(caseId, isSlowCase, oversizedCaseId) {
  const reported = storyTestTimeoutOf(caseId);
  if (reported) return reported;
  const base = isSlowCase ? 90000 : caseId === oversizedCaseId ? 120000 : 20000;
  const callTimeout = storyByCaseId.get(caseId)?.failingCase.call.timeoutMs ?? 0;
  return callTimeout >= base ? 2 * callTimeout : base;
}

for (const proj of DEMO_PROJECTS) {
  const cfg = PROJECT_CONFIGS[proj.id];
  const caseIds = caseIdsByProject[proj.id];
  const commits = SCM_REPOS[proj.id].commits;
  // Newest runs use the newest commits: run index i (0 = newest) maps onto the
  // commit list in windows, so a story starts failing exactly when its suspect
  // commit lands and "What changed" genuinely correlates.
  const commitWindow = Math.ceil(cfg.numRuns / commits.length);
  const commitIdxForRun = (i) => Math.min(Math.floor(i / commitWindow), commits.length - 1);

  const projectStories = FAILURE_STORIES.filter((s) => s.projectId === proj.id);
  const flakyCaseId = FLAKY_CASES[proj.id]
    ? caseIdByKey.get(
        `${proj.id}\x00${proj.cases.find((c) => c.title === FLAKY_CASES[proj.id].title)?.file}\x00${FLAKY_CASES[proj.id].title}`,
      )
    : null;
  // The project's oversized case: its second case, or the next one whose
  // timeout no story error reports.
  const oversizedCaseId = caseIds.find((id, k) => k >= 1 && id !== flakyCaseId && !storyTestTimeoutOf(id));

  // Decide which stories fire on which runs (deterministic). A story is
  // eligible once its suspect commit has landed (and, for environment-driven
  // stories, only on runs whose browser profile matches); it always fires on
  // the first eligible run (the regression's first appearance), then keeps
  // firing with its configured chance.
  const browserForRun = (i) => proj.browsers[proj.browserRotation[i % proj.browserRotation.length]] ?? proj.browsers[0];
  const eligible = (story, i) => {
    const suspectIdx = commits.findIndex((c) => c.sha === story.suspectSha);
    if (suspectIdx === -1 || commitIdxForRun(i) > suspectIdx) return false;
    const scheme = story.firing.requiresColorScheme;
    if (scheme && browserForRun(i).colorScheme !== scheme) return false;
    return true;
  };
  const firingByRun = new Map(); // runIndex → story[]
  for (const story of projectStories) {
    const eligibleRuns = [];
    for (let i = 0; i < cfg.numRuns; i++) if (eligible(story, i)) eligibleRuns.push(i);
    const oldestEligible = eligibleRuns[eligibleRuns.length - 1];
    for (const i of eligibleRuns) {
      if (i === oldestEligible || rng() < story.firing.chance) {
        if (!firingByRun.has(i)) firingByRun.set(i, []);
        firingByRun.get(i).push(story);
      }
    }
  }

  for (let i = 0; i < cfg.numRuns; i++) {
    // Runs go from newest (i=0) to oldest (i=numRuns-1)
    const startMs = BASE_START_MS - i * (8 * 60 * 60 * 1000 + Math.floor(rng() * 3600000));
    const startTime = Math.floor(startMs / 1000);
    const duration = Math.round(cfg.baseDuration + (rng() - 0.5) * 0.2 * cfg.baseDuration);
    const avgTestDuration = Math.round(cfg.baseAvg + (rng() - 0.5) * 0.15 * cfg.baseAvg);
    const p90TestDuration = Math.round(cfg.baseP90 + (rng() - 0.5) * 0.15 * cfg.baseP90);
    const browser = browserForRun(i);
    const commit = commits[commitIdxForRun(i)];

    const firingStories = firingByRun.get(i) ?? [];
    const failingCaseIds = new Set();
    for (const story of firingStories) {
      for (const fc of story.failingCases) {
        failingCaseIds.add(caseIdByKey.get(`${proj.id}\x00${story.specFile}\x00${fc.title}`));
      }
    }

    let status = failingCaseIds.size > 0 ? 'failed' : 'passed';
    // Occasionally a failure cuts the suite short: trailing (non-failing) tests
    // never execute and the run is interrupted.
    const didNotRunCaseIds = new Set();
    // Why each did-not-run case never executed, keyed by case id. The serial
    // cascade (a `previous-failure`, with a `blocked_by`) is stitched in by a
    // post-processing pass so it can't perturb this loop's rng stream.
    const reasonByCase = new Map();
    const blockedByByCase = new Map();
    if (failingCaseIds.size > 0 && rng() < 0.15) {
      status = 'interrupted';
      for (let j = caseIds.length - 1; j >= 0 && didNotRunCaseIds.size < 3; j--) {
        if (!failingCaseIds.has(caseIds[j])) didNotRunCaseIds.add(caseIds[j]);
      }
      for (const id of didNotRunCaseIds) reasonByCase.set(id, 'max-failures');
    }

    const flakyThisRun =
      status !== 'interrupted' && flakyCaseId && !failingCaseIds.has(flakyCaseId) && rng() < cfg.flakyRate;
    const flakyTests = flakyThisRun ? 1 : 0;
    const failedTests = failingCaseIds.size;
    const didNotRunTests = didNotRunCaseIds.size;
    const passedTests = caseIds.length - failedTests - didNotRunTests;

    const environment = ENVIRONMENTS[i % ENVIRONMENTS.length];
    const baseUrls = proj.id === 1 ? CHECKOUT_BASE_URLS[environment] : null;
    const metadata = {
      ci: {
        provider: 'GitHub Actions',
        buildNumber: String(1200 - i),
        jobName: 'test',
        workflow: 'CI',
        buildUrl: `https://github.com/${SCM_REPOS[proj.id].repositoryUrl.split('/').slice(-2).join('/')}/actions/runs/${5100 + proj.id * 100 - i}`,
      },
      scm: {
        commit: commit.sha,
        branch: commit.branch,
        author: commit.author,
        commitMessage: commit.message,
      },
      ...(baseUrls
        ? {
            htmlReport: {
              projects: [
                { name: 'chromium', use: { baseURL: baseUrls[Math.floor(i / ENVIRONMENTS.length) % baseUrls.length] } },
              ],
            },
          }
        : {}),
      // One run that came in over the ingest caps through the batch upload,
      // so the run page shows what ingest left out.
      ...(proj.id === 1 && i === 3
        ? {
            ingestHealth: {
              stepsDropped: 1240,
              consoleEntriesDropped: 312,
              submitFallback: { path: 'upload', reason: 'finish-failed' },
            },
          }
        : {}),
    };

    TEST_RUNS.push({
      id: runId,
      project_id: proj.id,
      status,
      start_time: startTime,
      duration,
      total_tests: caseIds.length,
      passed_tests: passedTests,
      failed_tests: failedTests,
      skipped_tests: 0,
      did_not_run_tests: didNotRunTests,
      flaky_tests: flakyTests,
      avg_test_duration: avgTestDuration,
      p90_test_duration: p90TestDuration,
      environment,
      branch: commit.branch && commit.branch !== 'HEAD' ? commit.branch : null,
      label: proj.id === 1 && i === 0 ? 'v2.4.0 release' : null,
      metadata,
      // `runOrigin(metadata)`: the metadata carries a CI record.
      origin: 'ci',
      stream_token: null,
      instance_id: null,
      // Newest runs are on a newer Playwright than older ones so the
      // environment-diff card has a real version drift to show for failures
      // whose last pass predates the bump.
      playwright_version: i < 2 ? '1.52.0' : '1.51.0',
      reporter_version: '0.7.0',
      is_full_run: i % 5 !== 4 ? 1 : 0,
      filter_details: i % 5 === 4 ? JSON.stringify({ grep: RUN_GREPS[proj.id] }) : null,
      ...keepColumnsFor(proj.id, i, startTime),
      created_at: startTime,
      updated_at: startTime + Math.floor(duration / 1000),
    });

    // Add an HTML report for the first few runs of each project
    if (i < 3) {
      REPORTS.push({
        id: reportId++,
        test_run_id: runId,
        type: 'report',
        subtype: 'html',
        label: 'HTML Report',
        path: `reports/${proj.id}/${runId}/index.html`,
        size: Math.floor(rng() * 500000) + 100000,
        created_at: startTime,
      });
    }

    // Per-worker virtual clock (ms since run start). Tests run back-to-back on
    // their assigned worker, so timeline rows are dense rather than gappy.
    const runStartMs = startTime * 1000;
    const workerCursorMs = new Array(SEED_WORKER_COUNT).fill(0);

    for (let j = 0; j < caseIds.length; j++) {
      const caseId = caseIds[j];
      const caseDef = caseById.get(caseId);
      const isFailedCase = failingCaseIds.has(caseId);
      const isDidNotRunCase = didNotRunCaseIds.has(caseId);
      const isFlakyCase = flakyThisRun && caseId === flakyCaseId;

      const storyEntry = isFailedCase ? storyByCaseId.get(caseId) : null;
      const story = storyEntry?.story ?? null;
      const noPage = Boolean(story?.evidence.noPageArtifacts);
      // The story behind this case regardless of pass/fail — passing executions
      // seed its green ARIA baseline so a later failure has a page to diff against.
      const storyForCase = storyByCaseId.get(caseId)?.story ?? null;

      const caseStatus = isFailedCase ? 'failed' : isDidNotRunCase ? 'didnotrun' : 'passed';
      const drawnDuration = isDidNotRunCase
        ? 0
        : Math.max(500, Math.round(avgTestDuration + (rng() - 0.5) * 0.3 * avgTestDuration));

      const workerIndex = j % SEED_WORKER_COUNT;
      const caseStartMs = runStartMs + workerCursorMs[workerIndex];

      // A failing case runs its story: its steps end on the call its error
      // names, and its duration follows that error.
      const failure = isFailedCase
        ? storyFailureLayout(
            stepsProjectFor(proj, caseDef.title, storyEntry.failingCase),
            storyEntry.failingCase,
            drawnDuration,
            avgTestDuration,
            caseStartMs,
          )
        : null;
      const caseDuration = failure ? failure.durationMs : drawnDuration;

      if (story) {
        const stats = clusterStats[story.clusterId];
        stats.occurrences++;
        // Runs are generated newest-first, so the last write wins for "first".
        if (stats.lastRunId === null) {
          stats.lastRunId = runId;
          stats.lastStartMs = startMs;
        }
        stats.firstRunId = runId;
        stats.firstStartMs = startMs;
        // Several cases in the same run share a cluster; record the run once.
        if (stats.failedRuns[stats.failedRuns.length - 1]?.runId !== runId) {
          stats.failedRuns.push({ runId, startMs });
        }
      }

      // A test that did not run reports no steps, start time or worker.
      const steps =
        failure?.steps ??
        (isDidNotRunCase ? [] : buildSteps(stepsProjectFor(proj, caseDef.title), caseDuration, caseStartMs));
      // Where the story puts its own requests, console entries and dialog.
      const evidenceTimes = failure ? storyEvidenceTimes(story, failure.step) : null;
      const slowestStep = steps.length > 0 ? steps.reduce((a, b) => (a.duration > b.duration ? a : b)) : null;

      // Test annotations — failures link to their cluster, the designated slow
      // case is always marked slow (so timeout hygiene can surface it as a stale
      // test.slow() once its durations no longer justify the tripled budget),
      // and one checkout case carries a smoke marker.
      let testAnnotations = null;
      if (isFailedCase && story) {
        testAnnotations = [{ type: 'fixme', description: `Known issue — see cluster ${story.clusterId}` }];
      } else if (flakyCaseId && caseId === flakyCaseId) {
        testAnnotations = [{ type: 'slow' }];
      } else if (proj.id === 1 && j === 0) {
        testAnnotations = [{ type: 'smoke' }];
      }

      // Timeline step events: every executed case shows hooks/fixtures/waits;
      // ~1/3 of long-enough cases also carry an explicit wasted `Wait for timeout`,
      // except a case running its authored steps, which never sleeps.
      // Did-not-run cases never executed, so they have no step events.
      const waitHeavy = !isDidNotRunCase && !failure?.beforeHooks && caseDuration >= 1500 && j % 3 === 0;
      const { stepEvents, wastedMs } = isDidNotRunCase
        ? { stepEvents: null, wastedMs: 0 }
        : buildSeedStepEvents(
            caseStartMs,
            caseDuration,
            `${caseDef.file}:${caseDef.declLine}:${caseDef.declColumn}`,
            waitHeavy,
            failure?.beforeHooks,
          );

      // Themed browser console. Failing cases carry only what the story says a
      // real browser would log (never an echo of the Playwright error); some
      // passing cases carry the project's benign noise.
      let consoleLogs = null;
      if (isFailedCase && story?.evidence.consoleOnFail && !noPage) {
        consoleLogs = story.evidence.consoleOnFail.map((entry, idx) => ({
          type: entry.type,
          text: entry.text,
          timestamp: caseStartMs + evidenceTimes.console[idx],
          location: entry.location,
        }));
      } else if (!isFailedCase && !isDidNotRunCase && proj.consolePassing && rng() < 0.3) {
        consoleLogs = proj.consolePassing.map((entry, idx) => ({
          type: entry.type,
          text: entry.text,
          timestamp: caseStartMs + 200 + idx * 60,
          location: entry.location,
        }));
      }
      // A web-dashboard test's own console lines, on every passing execution, after the draw above.
      const ownConsole =
        !isFailedCase && !isDidNotRunCase && proj.id === WEB_DASHBOARD_PROJECT_ID
          ? webDashboardPassingConsole(caseDef.title)
          : null;
      if (ownConsole) {
        consoleLogs = [
          ...(consoleLogs ?? []),
          ...ownConsole.map((entry, idx) => ({ ...entry, timestamp: caseStartMs + 400 + idx * 60 })),
        ];
      }

      // A dialog left open at the failure moment, when the story carries one —
      // closes just before the failure so it lands in the failure window.
      const dialogs =
        isFailedCase && !noPage && story?.evidence.dialogOnFail
          ? [{ ...story.evidence.dialogOnFail, closedAt: caseStartMs + evidenceTimes.dialogClosedAt }]
          : null;

      const isSlowCase = Boolean(flakyCaseId) && caseId === flakyCaseId;
      const caseTimeout = caseTimeoutOf(caseId, isSlowCase, oversizedCaseId);

      const trcIdVal = trcId++;
      TEST_RUNS_CASES.push({
        id: trcIdVal,
        test_run_id: runId,
        test_case_id: caseId,
        status: caseStatus,
        duration: caseDuration,
        timeout: caseTimeout,
        error: isFailedCase ? storyEntry.failingCase.error : null,
        failure_cluster_id: story?.clusterId ?? null,
        retries: isFlakyCase ? 1 : 0,
        // A flaky case has one failed attempt before the passing final one; a
        // plain case has a single attempt; a test the run never reached has
        // none. Mirrors what the reporter collects.
        attempts: isDidNotRunCase
          ? null
          : JSON.stringify(
              isFlakyCase
                ? [
                    { retry: 0, status: 'failed', duration: Math.round(caseDuration / 2), startedAt: caseStartMs },
                    { retry: 1, status: 'passed', duration: caseDuration, startedAt: caseStartMs + caseDuration },
                  ]
                : [{ retry: 0, status: caseStatus, duration: caseDuration, startedAt: caseStartMs }],
            ),
        // Regression/new-flaky signals are computed after generation from the
        // actual per-case history (see below), like the server does.
        is_new_regression: 0,
        is_new_flaky: 0,
        line: caseDef.declLine,
        column: caseDef.declColumn,
        browser,
        browser_name: browser.projectName ?? null,
        test_annotations: testAnnotations,
        tags: JSON.stringify(demoTags(caseDef.file, j)),
        locks: JSON.stringify(demoLocks(caseDef.file, j)),
        test_meta: demoTestMeta(caseDef.file, j),
        steps,
        locator_pages_payload_id:
          steps.length > 0
            ? locatorPagesPayloadId(stepsProjectFor(proj, caseDef.title, isFailedCase ? storyEntry.failingCase : null))
            : null,
        step_events: stepEvents,
        wasted_time_ms: wastedMs,
        slowest_step: slowestStep?.title ?? null,
        slowest_step_duration: slowestStep?.duration ?? null,
        web_vitals: isDidNotRunCase || noPage ? null : buildWebVitals(proj, isFailedCase),
        page_state: isDidNotRunCase || noPage ? null : buildPageState(proj, storyEntry, caseDef.title),
        ai_usage: isDidNotRunCase || noPage ? null : await buildAiUsage(caseDef),
        console_logs: consoleLogs,
        dialogs,
        aria_snapshot:
          isFailedCase && !noPage
            ? story?.aria
            : !isDidNotRunCase && !isFailedCase
              ? (storyForCase?.baselineAria ?? null)
              : null,
        test_source: isFailedCase ? buildTestSource(story, storyEntry.failingCase, caseDef.declLine) : null,
        test_source_frames: isFailedCase ? buildSourceFrames(storyEntry.failingCase) : null,
        worker_index: isDidNotRunCase ? null : workerIndex,
        started_at: isDidNotRunCase ? null : caseStartMs,
        did_not_run_reason: isDidNotRunCase ? (reasonByCase.get(caseId) ?? null) : null,
        blocked_by: isDidNotRunCase ? (blockedByByCase.get(caseId) ?? null) : null,
        created_at: caseStartMs,
      });

      // Advance this worker's clock so the next test it picks up runs after it.
      workerCursorMs[workerIndex] += caseDuration + SEED_WORKER_GAP_MS;

      if (!isDidNotRunCase) {
        // Requests fire one after another from shortly after the test starts,
        // so the execution page can order them by start time. A failing case's
        // own requests sit where its story puts them, around the failing step,
        // and the requests the failure stops short of never go out.
        const storyRequests = isFailedCase ? (story.evidence.failingNetwork ?? []) : [];
        const unreached = isFailedCase ? (story.evidence.unreachedNetwork ?? []) : [];
        const storyIndex = (req) => storyRequests.findIndex((o) => o.method === req.method && o.url === req.url);
        let requestStartMs = caseStartMs + SEED_FIRST_REQUEST_OFFSET_MS;
        for (const req of executionRequests(proj, storyEntry, caseDef.title)) {
          if (unreached.some((o) => o.method === req.method && o.url === req.url)) continue;
          const own = storyIndex(req);
          const startTime =
            own >= 0
              ? Math.max(caseStartMs + SEED_FIRST_REQUEST_OFFSET_MS, caseStartMs + evidenceTimes.requests[own])
              : requestStartMs;
          if (own < 0) requestStartMs += (req.duration ?? 0) + SEED_REQUEST_GAP_MS;
          NETWORK_REQUESTS.push({
            id: nrId++,
            test_runs_case_id: trcIdVal,
            test_run_id: runId,
            method: req.method,
            url: req.url,
            normalized_url: req.normalizedUrl ?? seedNormalizeUrl(req.url),
            status: req.status,
            duration: req.duration ?? null,
            start_time: startTime,
            resource_type: req.resourceType ?? null,
            content_type: req.contentType ?? (req.resourceType === 'document' ? 'text/html' : 'application/json'),
            server_logs: anchorServerLogs(req.serverLogs, startTime, req.duration),
            server_traces: req.serverTraces ?? null,
          });
        }
      }
    }

    runId++;
  }
}

// ── Serial-group cascade (post-processing, rng-free) ────────────────────────
// Rewrite one story-free-cart checkout run so the first `Cart` test fails and
// the serial group skips the rest — each blocked test linking back (`blocked_by`)
// to the failure. Applied after generation so it can't perturb the deterministic
// rng stream the rest of the seed depends on.
{
  const cartKey = (title) => caseIdByKey.get(`1\x00tests/checkout/cart.spec.ts\x00${title}`);
  const blockerCaseId = cartKey('should add item to cart');
  const blockedCaseIds = CASCADE_BLOCKED_TITLES.map(cartKey);
  const cartCaseIds = new Set([blockerCaseId, ...blockedCaseIds]);

  // Project 1 runs, newest first — the newest run has the smallest id.
  const proj1RunIds = TEST_RUNS.filter((r) => r.project_id === 1)
    .map((r) => r.id)
    .sort((a, b) => a - b);

  for (const targetRunId of proj1RunIds) {
    const cartRows = TEST_RUNS_CASES.filter(
      (row) => row.test_run_id === targetRunId && cartCaseIds.has(row.test_case_id),
    );
    // Only a run where every cart test cleanly passed can host the cascade.
    if (cartRows.length !== cartCaseIds.size) continue;
    if (!cartRows.every((row) => row.status === 'passed' && row.retries === 0)) continue;

    for (const row of cartRows) {
      if (row.test_case_id === blockerCaseId) {
        row.status = 'failed';
        row.error = CASCADE_BLOCKER_ERROR;
        row.attempts = JSON.stringify([
          { retry: 0, status: 'failed', duration: row.duration, startedAt: row.started_at },
        ]);
      } else {
        row.status = 'didnotrun';
        row.duration = 0;
        row.did_not_run_reason = 'previous-failure';
        row.blocked_by = CASCADE_BLOCKER_LOCATION;
        row.attempts = JSON.stringify([{ retry: 0, status: 'didnotrun', duration: 0, startedAt: null }]);
        // A test that never ran reports no start time, worker or steps, and
        // produced no live evidence.
        row.started_at = null;
        row.worker_index = null;
        row.steps = [];
        row.locator_pages_payload_id = null;
        row.slowest_step = null;
        row.slowest_step_duration = null;
        row.dialogs = null;
        row.aria_snapshot = null;
        row.step_events = null;
        row.wasted_time_ms = 0;
        row.web_vitals = null;
        row.page_state = null;
        row.ai_usage = null;
        row.console_logs = null;
        row.test_source_frames = null;
      }
    }

    // Drop the network the blocked (never-run) tests would not have produced.
    const blockedTrcIds = new Set(cartRows.filter((row) => row.test_case_id !== blockerCaseId).map((row) => row.id));
    for (let k = NETWORK_REQUESTS.length - 1; k >= 0; k--) {
      if (blockedTrcIds.has(NETWORK_REQUESTS[k].test_runs_case_id)) NETWORK_REQUESTS.splice(k, 1);
    }

    // Reflect the new outcomes on the run's counters.
    const run = TEST_RUNS.find((r) => r.id === targetRunId);
    run.failed_tests += 1;
    run.did_not_run_tests += blockedCaseIds.length;
    run.passed_tests -= cartCaseIds.size;
    if (run.status === 'passed') run.status = 'failed';
    break;
  }
}

// ── Intentional skips (post-processing, rng-free) ───────────────────────────
// Two checkout tests show the two kinds of skip the status bars tell apart: the
// CVV test is switched off with `test.fixme()` in the newest runs, and the
// expired-card test skips itself with `test.skip(condition, reason)` on the
// environments that have no card sandbox. Only clean passes are rewritten, so no
// failure story, flaky retry or cascade is touched.
{
  const checkoutKey = (title) => caseIdByKey.get(`1\x00tests/checkout/checkout.spec.ts\x00${title}`);
  const fixmeCaseId = checkoutKey('should show error for invalid CVV');
  const skipCaseId = checkoutKey('should show error for expired card');
  const FIXME_NEWEST_RUNS = 6;
  const NO_SANDBOX_ENVIRONMENTS = new Set(['staging', 'development']);
  const SKIP_REASON = 'Needs the card network sandbox (CARD_SANDBOX_URL)';

  // Project 1 runs, newest first — the newest run has the smallest id.
  const proj1Runs = TEST_RUNS.filter((r) => r.project_id === 1).sort((a, b) => a.id - b.id);
  const skippedTrcIds = new Set();
  for (const [index, run] of proj1Runs.entries()) {
    const annotationsFor = (caseId) => {
      if (caseId === fixmeCaseId && index < FIXME_NEWEST_RUNS) return [{ type: 'fixme' }];
      if (caseId === skipCaseId && NO_SANDBOX_ENVIRONMENTS.has(run.environment)) {
        return [{ type: 'skip', description: SKIP_REASON }];
      }
      return null;
    };
    for (const row of TEST_RUNS_CASES) {
      if (row.test_run_id !== run.id) continue;
      const annotations = annotationsFor(row.test_case_id);
      if (!annotations || row.status !== 'passed' || row.retries !== 0) continue;
      row.status = 'skipped';
      row.duration = 0;
      row.test_annotations = annotations;
      row.attempts = JSON.stringify([{ retry: 0, status: 'skipped', duration: 0, startedAt: row.started_at }]);
      // A skipped test ran no steps and produced no live evidence.
      row.steps = [];
      row.locator_pages_payload_id = null;
      row.slowest_step = null;
      row.slowest_step_duration = null;
      row.step_events = null;
      row.wasted_time_ms = 0;
      row.web_vitals = null;
      row.page_state = null;
      row.ai_usage = null;
      row.console_logs = null;
      row.dialogs = null;
      row.aria_snapshot = null;
      skippedTrcIds.add(row.id);
      run.passed_tests -= 1;
      run.skipped_tests += 1;
    }
  }
  for (let k = NETWORK_REQUESTS.length - 1; k >= 0; k--) {
    if (skippedTrcIds.has(NETWORK_REQUESTS[k].test_runs_case_id)) NETWORK_REQUESTS.splice(k, 1);
  }
}

// ── Flaky attempts (rng-free helpers) ───────────────────────────────────────

/** Set a seeded request's duration, and the server spans drawn from it. */
function setRequestDuration(nr, ms) {
  nr.duration = ms;
  nr.server_traces = buildServerTraces({
    method: nr.method,
    url: nr.url,
    status: nr.status,
    duration: ms,
    resourceType: nr.resource_type,
  });
}

/**
 * Split a flaky execution into its failed first attempt and the passing retry,
 * the way the reporter stores attempts: the failed attempt becomes its own row,
 * running the same steps at half the pace up to the failing assertion, and the
 * retry starts once it is over. The failed attempt repeats the retry's
 * `requests`; `failedMs` gives a request's duration on the failed attempt and
 * `retryMs` on the retry (undefined keeps it). Returns the failed attempt's requests.
 */
function splitFlakyExecution(row, { error, requests, failedMs, retryMs }) {
  const failedDuration = Math.round(row.duration / 2);
  const failedRow = {
    ...row,
    id: trcId++,
    status: 'failed',
    duration: failedDuration,
    error,
    failure_cluster_id: null,
    retries: 0,
    is_new_regression: 0,
    is_new_flaky: 0,
    console_logs: null,
    dialogs: null,
    aria_snapshot: null,
    web_vitals: null,
    steps: row.steps.map((step, i) => ({
      ...step,
      startTime: row.started_at + Math.round((step.startTime - row.started_at) / 2),
      duration: Math.round(step.duration / 2),
      ...(i === row.steps.length - 1 ? { failed: true, error: { message: error.split('\n')[0] } } : {}),
    })),
    step_events:
      row.step_events?.map((e) => ({
        ...e,
        startedAt: row.started_at + Math.round((e.startedAt - row.started_at) / 2),
        duration: Math.round((e.duration ?? 0) / 2),
      })) ?? null,
    created_at: row.started_at,
  };
  TEST_RUNS_CASES.push(failedRow);
  const shift = failedDuration + SEED_WORKER_GAP_MS;
  row.started_at += shift;
  row.created_at = row.started_at;
  row.steps = row.steps.map((step) => ({ ...step, startTime: step.startTime + shift }));
  row.step_events = row.step_events?.map((e) => ({ ...e, startedAt: e.startedAt + shift })) ?? null;
  row.console_logs = row.console_logs?.map((e) => ({ ...e, timestamp: e.timestamp + shift })) ?? null;
  failedRow.attempts = JSON.stringify([
    { retry: 0, status: 'failed', duration: failedDuration, startedAt: failedRow.started_at },
  ]);
  row.attempts = JSON.stringify([
    { retry: 0, status: 'failed', duration: failedDuration, startedAt: failedRow.started_at },
    { retry: 1, status: 'passed', duration: row.duration, startedAt: row.started_at },
  ]);

  const copies = [];
  let requestStartMs = failedRow.started_at + SEED_FIRST_REQUEST_OFFSET_MS;
  for (const nr of requests) {
    const copy = { ...nr, id: nrId++, test_runs_case_id: failedRow.id, start_time: requestStartMs };
    const failed = failedMs(copy);
    if (failed != null) setRequestDuration(copy, failed);
    requestStartMs += (copy.duration ?? 0) + SEED_REQUEST_GAP_MS;
    NETWORK_REQUESTS.push(copy);
    copies.push(copy);
    nr.start_time += shift;
    const retry = retryMs(nr);
    if (retry != null) setRequestDuration(nr, retry);
  }
  return copies;
}

// ── Flake suspect (post-processing, rng-free) ───────────────────────────────
// The checkout project's flaky test fails when `GET /api/cart` is slow: the
// total it asserts is read before the cart answers. Each of its flaky runs
// gets the failed first attempt as its own execution row, the way the
// reporter stores attempts, with the cart request slow on it; its passes keep
// the cart fast, bar a few slow ones that passed anyway. The flake profile
// then ranks "GET /api/cart slower" first, and the Attempts diff of each
// flaky run links its slower-request row to that suspect.
const FLAKE_SUSPECT_MIN_FLAKY_RUNS = 7;
/** What the flake-lab experiment below needs from this block: the test, the cart's delay and a failure commit. */
const FLAKE_DEMO = { caseId: null, failedCartMs: [], failureCommit: null };
const FLAKE_SUSPECT_SLOW_PASSES = 2;
const FLAKE_SUSPECT_ERROR =
  'Error: expect(locator).toHaveText(expected) failed\n\n' +
  "Locator:  getByTestId('cart-total')\n" +
  'Expected: "$85.50"\n' +
  'Received: "$95.00"\n' +
  'Timeout:  5000ms\n' +
  '    at tests/checkout/cart.spec.ts:31:5';
{
  const flaky = FLAKY_CASES[1];
  const caseDef = DEMO_PROJECTS.find((p) => p.id === 1).cases.find((c) => c.title === flaky.title);
  const flakyCaseId = caseIdByKey.get(`1\x00${caseDef.file}\x00${flaky.title}`);
  FLAKE_DEMO.caseId = flakyCaseId;
  const isCart = (nr) => nr.method === 'GET' && /\/api\/cart$/.test(nr.url);

  // Project 1 runs, newest first — the newest run has the smallest id.
  const proj1Runs = TEST_RUNS.filter((r) => r.project_id === 1).sort((a, b) => a.id - b.id);
  const rowOf = (run) => TEST_RUNS_CASES.find((row) => row.test_run_id === run.id && row.test_case_id === flakyCaseId);

  // Enough flaky runs for a suspect: turn the newest clean passes flaky until there are.
  let flakyCount = proj1Runs.filter((run) => rowOf(run)?.retries === 1).length;
  for (const run of proj1Runs) {
    if (flakyCount >= FLAKE_SUSPECT_MIN_FLAKY_RUNS) break;
    const row = rowOf(run);
    if (!row || row.status !== 'passed' || row.retries !== 0) continue;
    row.retries = 1;
    row.attempts = JSON.stringify([
      { retry: 0, status: 'failed', duration: Math.round(row.duration / 2), startedAt: row.started_at },
      { retry: 1, status: 'passed', duration: row.duration, startedAt: row.started_at + row.duration },
    ]);
    run.flaky_tests += 1;
    flakyCount++;
  }

  let slowPasses = 0;
  for (const [index, run] of proj1Runs.entries()) {
    const row = rowOf(run);
    if (!row || row.status !== 'passed') continue;
    const requests = NETWORK_REQUESTS.filter((nr) => nr.test_runs_case_id === row.id);
    if (row.retries !== 1) {
      // A clean pass: the cart answers fast, bar a few slow ones that passed anyway.
      const slow = index % 5 === 3 && slowPasses < FLAKE_SUSPECT_SLOW_PASSES;
      if (slow) slowPasses++;
      for (const nr of requests) {
        if (isCart(nr)) setRequestDuration(nr, slow ? 1800 + index * 10 : 60 + ((index * 37) % 140));
      }
      continue;
    }

    // A flaky run: the failed first attempt waited on a slow cart, the retry did not.
    FLAKE_DEMO.failureCommit ??= run.metadata?.scm?.commit ?? null;
    const failedRequests = splitFlakyExecution(row, {
      error: FLAKE_SUSPECT_ERROR,
      requests,
      failedMs: (nr) => (isCart(nr) ? 1700 + ((index * 137) % 700) : undefined),
      retryMs: (nr) => (isCart(nr) ? 60 + ((index * 37) % 140) : undefined),
    });
    for (const nr of failedRequests) if (isCart(nr)) FLAKE_DEMO.failedCartMs.push(nr.duration);
  }
}

// ── Verified flake fix (post-processing, rng-free) ──────────────────────────
// The UI project's pagination test flaked on main while its second page of
// rows was slow: each of its flaky runs gets the failed first attempt as its
// own execution row, with `GET /api/table/rows` slow on it and
// `GET /api/table/count` slow beside it. The count was also slow on two clean
// passes, so the flake profile ranks the rows first and the count second. The
// test passes in every run after its last flake; the flake-lab experiments
// below reproduce it with the rows delay, rule the count out, and verify the fix.
const FLAKE_FIX_ERROR =
  'Error: expect(locator).toHaveText(expected) failed\n\n' +
  "Locator:  getByTestId('page-indicator')\n" +
  'Expected: "Page 2 of 8"\n' +
  'Received: "Page 1 of 8"\n' +
  'Timeout:  5000ms\n' +
  '    at tests/ui/table.spec.ts:17:5';
const FLAKE_FIX_SLOW_COUNT_PASSES = 2;
/** What the experiments below need from this block: the test, its failed attempts' delays, and its last flake. */
const FLAKE_FIX_DEMO = { caseId: null, failedRowsMs: [], failedCountMs: [], failureCommit: null, lastFlakeMs: null };
{
  const flaky = FLAKY_CASES[3];
  const caseDef = DEMO_PROJECTS.find((p) => p.id === 3).cases.find((c) => c.title === flaky.title);
  const flakyCaseId = caseIdByKey.get(`3\x00${caseDef.file}\x00${flaky.title}`);
  FLAKE_FIX_DEMO.caseId = flakyCaseId;
  const ROWS_URL = 'https://design.example.com/api/table/rows?page=2&size=25';
  const COUNT_URL = 'https://design.example.com/api/table/count';
  const isRows = (nr) => nr.url === ROWS_URL;
  const isCount = (nr) => nr.url === COUNT_URL;

  // Project 3 runs, newest first — the newest run has the smallest id.
  const proj3Runs = TEST_RUNS.filter((r) => r.project_id === 3).sort((a, b) => a.id - b.id);
  let slowCountPasses = 0;
  for (const [index, run] of proj3Runs.entries()) {
    const row = TEST_RUNS_CASES.find((r) => r.test_run_id === run.id && r.test_case_id === flakyCaseId);
    if (!row || row.status !== 'passed') continue;

    // The table fetches its rows and the page count after the page's own requests.
    const requests = NETWORK_REQUESTS.filter((nr) => nr.test_runs_case_id === row.id);
    let requestStartMs = Math.max(
      row.started_at + SEED_FIRST_REQUEST_OFFSET_MS,
      ...requests.map((nr) => nr.start_time + (nr.duration ?? 0) + SEED_REQUEST_GAP_MS),
    );
    for (const url of [ROWS_URL, COUNT_URL]) {
      const nr = {
        id: nrId++,
        test_runs_case_id: row.id,
        test_run_id: run.id,
        method: 'GET',
        url,
        normalized_url: seedNormalizeUrl(url),
        status: 200,
        duration: null,
        start_time: requestStartMs,
        resource_type: 'fetch',
        content_type: 'application/json',
        server_logs: null,
        server_traces: null,
      };
      setRequestDuration(nr, isRows(nr) ? 90 + ((index * 53) % 120) : 40 + ((index * 29) % 80));
      requestStartMs += nr.duration + SEED_REQUEST_GAP_MS;
      NETWORK_REQUESTS.push(nr);
      requests.push(nr);
    }

    if (row.retries !== 1) {
      // A clean pass; on main, the count was slow twice without breaking it.
      const slow = run.branch === 'main' && index % 3 === 1 && slowCountPasses < FLAKE_FIX_SLOW_COUNT_PASSES;
      if (slow) {
        slowCountPasses++;
        setRequestDuration(requests.find(isCount), 1100 + index * 10);
      }
      continue;
    }

    // A flaky run: the failed first attempt read the page indicator before the rows arrived.
    FLAKE_FIX_DEMO.failureCommit ??= run.metadata?.scm?.commit ?? null;
    FLAKE_FIX_DEMO.lastFlakeMs ??= run.start_time * 1000;
    const failedRequests = splitFlakyExecution(row, {
      error: FLAKE_FIX_ERROR,
      requests,
      failedMs: (nr) =>
        isRows(nr) ? 1300 + ((index * 211) % 500) : isCount(nr) ? 900 + ((index * 97) % 300) : undefined,
      retryMs: () => undefined,
    });
    for (const nr of failedRequests) {
      if (isRows(nr)) FLAKE_FIX_DEMO.failedRowsMs.push(nr.duration);
      if (isCount(nr)) FLAKE_FIX_DEMO.failedCountMs.push(nr.duration);
    }
  }
}

// ── Failed attempts of the other retry passes (post-processing, rng-free) ───
// The reporter stores every attempt as its own execution. Each remaining test
// that passed on retry gets its failed first attempt as its own row, with the
// error its flaky case declares, so its attempts link to real executions.
{
  const attemptKey = (row) => `${row.test_run_id}|${row.test_case_id}|${row.browser_name}`;
  const failedAttempts = new Set(
    TEST_RUNS_CASES.filter((row) => ['failed', 'timedOut'].includes(row.status) && row.retries === 0).map(attemptKey),
  );
  const retryPasses = TEST_RUNS_CASES.filter(
    (row) => row.status === 'passed' && row.retries > 0 && !failedAttempts.has(attemptKey(row)),
  );
  for (const row of retryPasses) {
    const { projectId } = caseById.get(row.test_case_id);
    const error = FLAKY_CASES[projectId]?.error;
    if (!error)
      throw new Error(`Retry pass ${row.id}: give FLAKY_CASES[${projectId}] the error its failed attempt reports`);
    splitFlakyExecution(row, {
      error,
      requests: NETWORK_REQUESTS.filter((nr) => nr.test_runs_case_id === row.id),
      failedMs: () => undefined,
      retryMs: () => undefined,
    });
  }
}

// ── Worker lanes without holes (post-processing, rng-free) ──────────────────
// A skipped or did-not-run test never ran on a worker — Playwright reports it
// with no worker index — so it leaves its lane, and the tests after it on that
// worker move up into the time it held, with every timestamp they carry. The
// lanes then read as a real run's: back to back, SEED_WORKER_GAP_MS apart.
{
  const requestsByCase = new Map();
  for (const req of NETWORK_REQUESTS) {
    const list = requestsByCase.get(req.test_runs_case_id);
    if (list) list.push(req);
    else requestsByCase.set(req.test_runs_case_id, [req]);
  }
  const shiftAll = (list, key, delta) => (list ? list.map((e) => ({ ...e, [key]: e[key] + delta })) : list);
  const shiftCase = (row, delta) => {
    row.started_at += delta;
    row.created_at += delta;
    row.attempts = JSON.stringify(shiftAll(JSON.parse(row.attempts), 'startedAt', delta));
    row.steps = shiftAll(row.steps, 'startTime', delta);
    row.step_events = shiftAll(row.step_events, 'startedAt', delta);
    row.console_logs = shiftAll(row.console_logs, 'timestamp', delta);
    row.dialogs = shiftAll(row.dialogs, 'closedAt', delta);
    for (const req of requestsByCase.get(row.id) ?? []) {
      req.start_time += delta;
      req.server_logs = shiftAll(req.server_logs, 'timestamp', delta);
    }
  };

  const lanes = new Map();
  const runStart = new Map();
  for (const row of TEST_RUNS_CASES) {
    if (row.started_at !== null) {
      runStart.set(row.test_run_id, Math.min(runStart.get(row.test_run_id) ?? Infinity, row.started_at));
    }
    if (row.status === 'skipped' || row.status === 'didnotrun') {
      row.worker_index = null;
      continue;
    }
    const key = `${row.test_run_id}|${row.worker_index}`;
    const lane = lanes.get(key);
    if (lane) lane.push(row);
    else lanes.set(key, [row]);
  }
  for (const lane of lanes.values()) {
    lane.sort((a, b) => a.started_at - b.started_at);
    let cursor = runStart.get(lane[0].test_run_id);
    for (const row of lane) {
      if (row.started_at > cursor) shiftCase(row, cursor - row.started_at);
      cursor = row.started_at + (row.duration ?? 0) + SEED_WORKER_GAP_MS;
    }
  }
}

// ── Resources: a leaky run and its history (post-processing, rng-free) ──────
// Web Dashboard's newest run is a leaky one: its login fixture opens a browser
// context per test and never closes it, so every test after the first finds
// the earlier tests' pages still open in its worker. The three runs before it
// close what they open, but one of their tests has left a server running in its
// worker for a while. The run before the newest ran as two CI shards, each on
// its own machine with its own workers, so it carries one report per shard.
// Each run carries what its executions cost and its report, as the reporter
// sends them, and the findings' history is written as the server records it
// on finish.
const TEST_RUN_RESOURCE_REPORTS = [];
const RESOURCE_FINDINGS = [];
const RESOURCE_OCCURRENCES = [];
{
  const webRuns = TEST_RUNS.filter((run) => run.project_id === 5).sort((a, b) => b.start_time - a.start_time);
  const reportByRun = new Map();
  for (const [index, run] of webRuns.slice(0, 4).entries()) {
    const leaky = index === 0;
    const rows = TEST_RUNS_CASES.filter(
      (row) => row.test_run_id === run.id && row.worker_index !== null && row.status !== 'didnotrun',
    );
    if (index === 1) {
      // Two shards: the first half of the workers ran on shard 1, the rest on
      // shard 2, each shard numbering its own workers from 0 as Playwright does.
      const workers = [...new Set(rows.map((row) => row.worker_index))].sort((a, b) => a - b);
      const half = Math.ceil(workers.length / 2);
      for (const row of rows) {
        const position = workers.indexOf(row.worker_index);
        row.shard_index = position < half ? 1 : 2;
        row.worker_index = position < half ? position : position - half;
      }
      run.shard_total = 2;
      run.shard_index = 1;
      run.shards_finished = 2;
    }
    const shards = new Map();
    for (const row of rows) {
      const shard = row.shard_index ?? null;
      const lanes = shards.get(shard) ?? new Map();
      const lane = lanes.get(row.worker_index) ?? [];
      lane.push(row);
      lanes.set(row.worker_index, lane);
      shards.set(shard, lanes);
    }
    const parts = [];
    for (const [shard, lanes] of [...shards.entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
      let artifactBytes = 0;
      for (const lane of lanes.values()) {
        lane.sort((a, b) => a.started_at - b.started_at);
        lane.forEach((row, position) => {
          row.resources = demoExecutionResources({
            seq: row.id,
            durationMs: row.duration ?? 0,
            openAtStart: position,
            leaky,
          });
          artifactBytes += Object.values(row.resources.artifactBytes).reduce((sum, n) => sum + n, 0);
        });
      }
      const report = demoResourceReport({
        leaky,
        // The server left running belongs to one worker, so to one shard.
        handle: shard === null || shard === 1,
        wallMs: run.duration,
        workers: [...lanes.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([worker, lane]) => ({
            worker,
            tests: lane.length,
            spans: lane.map((row) => [row.started_at, row.started_at + (row.duration ?? 0)]),
          })),
        fixtureFile: 'tests/admin/fixtures.ts',
        handleTest: { title: 'exports the monthly report as CSV', file: 'tests/admin/reports.spec.ts' },
        artifactBytes,
        shardIndex: shard,
      });
      parts.push(report);
      TEST_RUN_RESOURCE_REPORTS.push({
        id: TEST_RUN_RESOURCE_REPORTS.length + 1,
        run_id: run.id,
        shard: shard ?? 0,
        report,
        updated_at: run.updated_at,
      });
    }
    reportByRun.set(run.id, { findings: parts.flatMap((part) => part.findings) });
  }

  // The history, oldest run first, as recordRunResourceFindings writes it.
  const byFingerprint = new Map();
  for (const run of webRuns.slice(0, 4).reverse()) {
    for (const finding of reportByRun.get(run.id).findings) {
      const fingerprint = resourceFingerprint(finding);
      let row = byFingerprint.get(fingerprint);
      if (!row) {
        row = {
          id: RESOURCE_FINDINGS.length + 1,
          project_id: run.project_id,
          fingerprint,
          verdict: finding.verdict,
          kind: finding.kind,
          place: finding.where,
          site: finding.site ?? null,
          first_seen_run_id: run.id,
          last_seen_run_id: run.id,
          first_seen_at: run.start_time,
          last_seen_at: run.start_time,
          occurrences: 0,
          status: 'open',
          clean_runs: 0,
          created_at: run.start_time,
          updated_at: run.start_time,
        };
        byFingerprint.set(fingerprint, row);
        RESOURCE_FINDINGS.push(row);
      }
      row.last_seen_run_id = run.id;
      row.last_seen_at = run.start_time;
      row.occurrences++;
      row.updated_at = run.start_time;
      RESOURCE_OCCURRENCES.push({
        id: RESOURCE_OCCURRENCES.length + 1,
        finding_id: row.id,
        run_id: run.id,
        branch: run.branch,
        count: finding.count,
        tests: finding.tests,
        held_ms: finding.heldMs ?? null,
        after_test_cpu_ms: finding.afterTestCpuMs ?? null,
        pages: finding.pages ?? null,
      });
    }
  }
}

// ── Environment incident (post-processing, rng-free) ────────────────────────
// One checkout run against staging where the staging host refused every
// connection: almost every test fails navigating to it, so the run carries the
// incident flag the server's classifier writes (`metadata.incident`, rule
// `host-unreachable`) and one auto `incident` marker, and is left out of flaky
// scores, baselines and regression signals. Its failures join no cluster.
const INCIDENT_HOST = 'staging.checkout.example.com';
const INCIDENT_PASSED_CASES = 1;
const incidentRunIds = new Set();
const INCIDENT_MARKERS = [];
{
  const proj1Runs = TEST_RUNS.filter((r) => r.project_id === 1).sort((a, b) => a.id - b.id);
  const oldestId = proj1Runs[proj1Runs.length - 1].id;
  const rowsOf = (runId) => TEST_RUNS_CASES.filter((row) => row.test_run_id === runId);
  const target = proj1Runs
    .slice(3)
    .find(
      (r) =>
        r.id !== oldestId &&
        r.environment === 'staging' &&
        r.status === 'passed' &&
        r.flaky_tests === 0 &&
        r.kept_at === null &&
        r.is_full_run === 1 &&
        rowsOf(r.id).every((row) => ['passed', 'skipped'].includes(row.status) && row.retries === 0),
    );
  if (!target) throw new Error('No checkout run on staging can host the incident');

  const rows = rowsOf(target.id)
    .filter((row) => row.status === 'passed')
    .sort((a, b) => a.started_at - b.started_at);
  const failing = rows.slice(INCIDENT_PASSED_CASES);
  const failingIds = new Set(failing.map((row) => row.id));
  for (let k = NETWORK_REQUESTS.length - 1; k >= 0; k--) {
    if (failingIds.has(NETWORK_REQUESTS[k].test_runs_case_id)) NETWORK_REQUESTS.splice(k, 1);
  }
  for (const row of failing) {
    const caseDef = caseById.get(row.test_case_id);
    const path = `/${caseDef.file.replace(/^tests\//, '').replace(/\.spec\.ts$/, '')}`;
    const url = `https://${INCIDENT_HOST}${path}`;
    row.status = 'failed';
    row.duration = 120 + (row.id % 7) * 15;
    row.error =
      `Error: page.goto: net::ERR_CONNECTION_REFUSED at ${url}\n` +
      `Call log:\n  - navigating to "${url}", waiting until "load"\n\n` +
      `    at ${caseDef.file}:${caseDef.declLine}:${caseDef.declColumn}`;
    row.attempts = JSON.stringify([{ retry: 0, status: 'failed', duration: row.duration, startedAt: row.started_at }]);
    // The page never loaded: no steps past the navigation, no page evidence.
    row.steps = [];
    row.locator_pages_payload_id = null;
    row.step_events = null;
    row.wasted_time_ms = 0;
    row.slowest_step = null;
    row.slowest_step_duration = null;
    row.web_vitals = null;
    row.page_state = null;
    row.ai_usage = null;
    row.console_logs = null;
    row.dialogs = null;
    row.aria_snapshot = null;
    // The network capture holds the one navigation the test tried: refused.
    NETWORK_REQUESTS.push({
      id: nrId++,
      test_runs_case_id: row.id,
      test_run_id: target.id,
      method: 'GET',
      url,
      normalized_url: seedNormalizeUrl(url),
      status: 0,
      duration: row.duration - 20,
      start_time: row.started_at + 10,
      resource_type: 'document',
      content_type: null,
      server_logs: null,
      server_traces: null,
      failure: 'net::ERR_CONNECTION_REFUSED',
    });
  }

  const executed = rows.length;
  target.status = 'failed';
  target.failed_tests = failing.length;
  target.passed_tests = executed - failing.length;
  target.label = null;
  target.metadata.htmlReport = { projects: [{ name: 'chromium', use: { baseURL: `https://${INCIDENT_HOST}` } }] };
  const reason =
    `${failing.length} of ${executed} tests failed, ${failing.length} of them navigating or connecting to ` +
    `${INCIDENT_HOST} (connection refused).`;
  target.metadata.incident = {
    rule: 'host-unreachable',
    reason,
    host: INCIDENT_HOST,
    projects: [],
    failedTests: failing.length,
    executedTests: executed,
    hostFailures: failing.length,
    decidedBy: 'rule',
    decidedAt: new Date((target.start_time + 600) * 1000).toISOString(),
    firstRunId: target.id,
  };
  incidentRunIds.add(target.id);
  INCIDENT_MARKERS.push({
    project_id: 1,
    occurred_at: target.start_time,
    label: `Environment incident: ${INCIDENT_HOST}`,
    description: reason,
    category: 'incident',
    environment: 'staging',
    source: 'auto',
    run_id: target.id,
    created_at: target.start_time + 600,
    updated_at: target.start_time + 600,
  });
}

// ── Regression / new-flaky signals ──────────────────────────────────────────
// Mirror the server's computeRegressionSignals: walk each case's final
// executions (one per run: an earlier attempt of a retried test is not one) in
// chronological order; a failure right after a pass is a new regression, and a
// retry-pass right after a clean pass is newly flaky.
{
  const retried = new Set(
    TEST_RUNS_CASES.filter((trc) => trc.retries > 0).map((trc) => `${trc.test_run_id}:${trc.test_case_id}`),
  );
  const byCase = new Map();
  for (const trc of TEST_RUNS_CASES) {
    // An environment incident gets no regression signals and is no one's baseline.
    if (incidentRunIds.has(trc.test_run_id)) continue;
    if (trc.retries === 0 && retried.has(`${trc.test_run_id}:${trc.test_case_id}`)) continue;
    if (!byCase.has(trc.test_case_id)) byCase.set(trc.test_case_id, []);
    byCase.get(trc.test_case_id).push(trc);
  }
  for (const rows of byCase.values()) {
    rows.sort((a, b) => a.started_at - b.started_at);
    let prev = null;
    for (const trc of rows) {
      if (trc.status === 'didnotrun') continue;
      if (prev) {
        if (trc.status === 'failed' && prev.status === 'passed') trc.is_new_regression = 1;
        if (trc.status === 'passed' && trc.retries > 0 && prev.status === 'passed' && prev.retries === 0) {
          trc.is_new_flaky = 1;
        }
      }
      prev = trc;
    }
  }
}

// ── Demo media (screenshots, trace, video, visual diff) ────────────────────
// Real binaries live in public/demo/{screenshots,traces,videos} (committed to
// the repo; regenerate with scripts/take-demo-screenshots.mjs and
// scripts/record-demo-media.mjs). Each failure story declares its themed
// evidence files; they are wired to the MOST RECENT failing execution of each
// member case — max(test_runs_cases.id), matching how the cluster detail
// handler picks its evidence row (`recentTestRunsCaseId` in
// shared/handlers/failure-clusters.ts).

const ATTACHMENTS = [];
let attachmentId = reportId;

function fileSize(relPath) {
  try {
    return statSync(new URL(`../public/${relPath}`, import.meta.url)).size;
  } catch {
    console.warn(`⚠ Missing ${relPath} — run the demo media scripts to regenerate it.`);
    return 0;
  }
}

function attach(trc, { type, subtype, label, relPath, metadata = undefined }) {
  ATTACHMENTS.push({
    id: attachmentId++,
    test_runs_case_id: trc.id,
    test_run_id: trc.test_run_id,
    type,
    subtype,
    label,
    path: relPath,
    size: fileSize(relPath),
    ...(metadata !== undefined ? { metadata } : {}),
    created_at: Math.floor(trc.started_at / 1000),
  });
}

/** Most recent execution of a case, optionally filtered. */
function latestTrc(caseId, filter = () => true) {
  let best = null;
  for (const trc of TEST_RUNS_CASES) {
    if (trc.test_case_id !== caseId) continue;
    if (!filter(trc)) continue;
    if (!best || trc.id > best.id) best = trc;
  }
  return best;
}

for (const story of FAILURE_STORIES) {
  const media = story.media ?? {};
  const memberCaseIds = story.failingCases.map((fc) =>
    caseIdByKey.get(`${story.projectId}\x00${story.specFile}\x00${fc.title}`),
  );

  if (media.screenshot) {
    for (const caseId of memberCaseIds) {
      const trc = latestTrc(caseId, (t) => t.failure_cluster_id === story.clusterId);
      if (trc) {
        attach(trc, {
          type: 'attachment',
          subtype: 'screenshot',
          label: 'image/png',
          relPath: `demo/screenshots/${media.screenshot}`,
        });
      }
    }
  }

  const anchorTrc = latestTrc(memberCaseIds[0], (t) => t.failure_cluster_id === story.clusterId);
  if (anchorTrc && media.trace) {
    attach(anchorTrc, { type: 'trace', subtype: 'trace', label: 'trace', relPath: `demo/traces/${media.trace}` });
  }
  if (anchorTrc && media.video) {
    attach(anchorTrc, {
      type: 'attachment',
      subtype: 'video',
      label: 'video/webm',
      relPath: `demo/videos/${media.video}`,
    });
  }
}

// Screenshots on a few PASSING executions, so evidence isn't failure-only and
// the visual diff has a real baseline execution to point at.
const PASSING_SCREENSHOTS = [
  {
    file: 'checkout-order-confirmed.png',
    projectId: 1,
    specFile: 'tests/checkout/checkout.spec.ts',
    title: 'should complete checkout with credit card',
  },
  {
    file: 'checkout-form-filled.png',
    projectId: 1,
    specFile: 'tests/checkout/checkout.spec.ts',
    title: 'should complete checkout with PayPal',
  },
  {
    file: 'cart-summary.png',
    projectId: 1,
    specFile: 'tests/checkout/cart.spec.ts',
    title: 'should display cart total correctly',
  },
  {
    file: 'mobile-form-keyboard.png',
    projectId: 4,
    specFile: 'tests/mobile/forms.spec.ts',
    title: 'Text input shows keyboard on focus',
  },
  { file: 'login-form.png', projectId: 5, specFile: 'tests/admin/login.spec.ts', title: 'signs in with SSO redirect' },
];
const passingShotTrcs = new Map(); // file → trc (for the visual-diff baseline below)
for (const shot of PASSING_SCREENSHOTS) {
  const caseId = caseIdByKey.get(`${shot.projectId}\x00${shot.specFile}\x00${shot.title}`);
  const trc = latestTrc(caseId, (t) => t.status === 'passed');
  if (trc) {
    attach(trc, {
      type: 'attachment',
      subtype: 'screenshot',
      label: 'image/png',
      relPath: `demo/screenshots/${shot.file}`,
    });
    passingShotTrcs.set(shot.file, trc);
  }
}

// ── Demo visual diff ───────────────────────────────────────────────────────
// A real pixelmatch overlay comparing the checkout failure screenshot with the
// passing-state screenshot of the SAME page, generated here (same code path as
// the server) and written to public/demo/screenshots/. The metrics ride the
// files.metadata column so the demo router serves the visual-diff endpoint
// data-driven; the baseline pointers reference the real passing execution the
// baseline screenshot is attached to.
{
  const story = FAILURE_STORIES.find((s) => s.media?.visualDiffBaseline);
  const failingShot = story?.media.screenshot;
  const baselineShot = story?.media.visualDiffBaseline;
  const failingCaseId = story
    ? caseIdByKey.get(`${story.projectId}\x00${story.specFile}\x00${story.failingCases[0].title}`)
    : null;
  const failingTrc = failingCaseId ? latestTrc(failingCaseId, (t) => t.failure_cluster_id === story.clusterId) : null;
  const baselineTrc = baselineShot ? passingShotTrcs.get(baselineShot) : null;

  if (story && failingTrc && baselineTrc) {
    const failingRel = `demo/screenshots/${failingShot}`;
    const baselineRel = `demo/screenshots/${baselineShot}`;
    const overlayRel = 'demo/screenshots/visual-diff-checkout.png';
    try {
      const { default: sharp } = await import('sharp');
      const { default: pixelmatch } = await import('pixelmatch');

      const loadRaw = async (rel) => {
        const abs = new URL(`../public/${rel}`, import.meta.url);
        const { data, info } = await sharp(readFileSync(abs)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return { data: new Uint8Array(data), width: info.width, height: info.height };
      };
      const failing = await loadRaw(failingRel);
      const baseline = await loadRaw(baselineRel);

      const width = Math.max(failing.width, baseline.width);
      const height = Math.max(failing.height, baseline.height);
      const pad = (img) => {
        if (img.width === width && img.height === height) return img.data;
        const out = new Uint8Array(width * height * 4);
        for (let y = 0; y < img.height; y++) {
          out.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * width * 4);
        }
        return out;
      };
      const overlay = new Uint8Array(width * height * 4);
      const changedPixels = pixelmatch(pad(failing), pad(baseline), overlay, width, height, {
        threshold: 0.1,
        includeAA: false,
      });
      const overlayPng = await sharp(Buffer.from(overlay), { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
      // Write beside the other seed artifacts so concurrent generators (e.g. the
      // unit tests) stay inside their PIWI_DEMO_SEED_OUTPUT_DIR instead of
      // rewriting the committed binary.
      const visualDiffPath = join(OUTPUT_DIR, 'screenshots/visual-diff-checkout.png');
      mkdirSync(dirname(visualDiffPath), { recursive: true });
      writeFileSync(visualDiffPath, overlayPng);

      ATTACHMENTS.push({
        id: attachmentId++,
        test_runs_case_id: failingTrc.id,
        test_run_id: failingTrc.test_run_id,
        type: 'visual-diff',
        subtype: 'overlay',
        label: 'Visual diff vs last pass',
        path: overlayRel,
        size: overlayPng.length,
        metadata: {
          changedPixels,
          changedPixelRatio: Math.round((changedPixels / (width * height)) * 10000) / 10000,
          width,
          height,
          dimensionMismatch: failing.width !== baseline.width || failing.height !== baseline.height,
          baselineTestRunsCaseId: baselineTrc.id,
          baselineRunId: baselineTrc.test_run_id,
          failingPath: failingRel,
          baselinePath: baselineRel,
        },
        created_at: Math.floor(failingTrc.started_at / 1000),
      });
    } catch (error) {
      console.warn(`⚠ Could not generate the demo visual diff: ${error}`);
    }
  }
}

// ── Build failure_clusters rows ────────────────────────────────────────────

// Runs are generated newest-first (index 0 is the newest, ids descend as time
// advances), so the first row encountered holds the project's *newest* run and
// the last row its *oldest* — despite the loop-order names below.
const newestRunByProject = {};
const oldestRunByProject = {};
for (const run of TEST_RUNS) {
  if (!(run.project_id in newestRunByProject)) newestRunByProject[run.project_id] = run.id;
  oldestRunByProject[run.project_id] = run.id;
}

const CLUSTER_TRIAGE = {
  1: {
    status: 'open',
    triage_note:
      'Root cause identified: the new payment-provider SDK delays form interactivity on loaded CI runners. A fix landed and the cluster was closed, then regressed — reopened automatically. The fix did not hold; investigating the loaded-runner path again.',
  },
  3: {
    status: 'open',
    triage_note:
      'Investigating — the auth service returns 500 on valid logins since the auth-flow refactor. Server logs show a null dereference in the login handler; fix in review.',
  },
  6: {
    status: 'ignored',
    triage_note:
      'Known issue — three buttons match the unscoped role query on the gallery page. The page intentionally demos multiple variants; the spec needs a name-scoped locator. Not an app bug.',
  },
  10: {
    status: 'open',
    triage_note:
      'Capped the API default page size to the requested pageSize so the users table renders 25 rows again; verified once the count assertion turned green.',
  },
};

/**
 * Clusters whose fix landed, so the demo shows the loop closing rather than
 * only the failures. All three verdicts appear, because they mean different
 * things: one is corroborated against the diagnosed change, one merely stopped
 * failing (the weaker and more common case), and one did not hold.
 *
 * Cluster 1 is the regression on purpose — it is the cluster a human already
 * marked resolved, so the demo shows triage and evidence disagreeing, which is
 * the reason they are two separate indicators.
 */
const CLUSTER_FIXES = {
  1: { verification: 'regressed', openHours: 14 },
  6: { verification: 'stopped-failing', openHours: 9 },
  10: { verification: 'diagnosis-verified', openHours: 26 },
};

/**
 * The run a fix landed in — a run where the cluster did **not** fail.
 *
 * Runs are generated newest-first, so ids descend as time advances: the run
 * after run 4 is run 3. That inversion is the whole subtlety here.
 *
 * A fix that held landed in the run straight after the cluster's newest
 * failure. A regression is the opposite shape — the cluster went quiet and the
 * failure returned — so its landing run comes from a gap between two failures.
 *
 * Returns null when the cluster still fails in the project's newest run: there
 * is no later run in which anything could have been observed to pass, and
 * claiming a fix anyway is how the demo would end up showing a cluster that is
 * failing and fixed at the same time.
 */
function fixLandedRun(stats, verification, newestRunIdOfProject) {
  if (verification === 'regressed') {
    for (let i = 0; i < stats.failedRuns.length - 1; i++) {
      const newer = stats.failedRuns[i];
      const older = stats.failedRuns[i + 1];
      // More than one id apart means a run in between with no failure.
      if (older.runId - newer.runId > 1) {
        return { runId: newer.runId + 1, startMs: Math.round((newer.startMs + older.startMs) / 2) };
      }
    }
    return null;
  }

  if (stats.lastRunId === null || stats.lastRunId <= newestRunIdOfProject) return null;
  return { runId: stats.lastRunId - 1, startMs: stats.lastStartMs };
}

/** The resolution columns for a cluster, or nothing when no fix can be placed. */
function buildClusterFix(story, stats) {
  const fix = CLUSTER_FIXES[story.clusterId];
  if (!fix) return {};

  const landed = fixLandedRun(stats, fix.verification, newestRunByProject[story.projectId]);
  if (!landed) throw new Error(`Cluster ${story.clusterId} has no run a fix could have landed in`);

  return {
    fix_landed_run_id: landed.runId,
    fix_landed_at: Math.floor(landed.startMs / 1000),
    fix_commit: `demo${String(story.clusterId).padStart(3, '0')}`,
    time_to_resolution_ms: fix.openHours * 3600 * 1000,
    fix_verification: fix.verification,
  };
}

// Semantic vectors for a single pair so the demo shows "Fixed before": the open
// cluster 9 (a report export that never becomes visible) resembles the resolved
// cluster 10 (a table assertion that was diagnosis-verified). Both carry the same
// model+recipe tag and near-parallel vectors, so their cosine clears the memory
// threshold even though their error text differs. Everything else uses the
// deterministic fingerprint path with no vector.
const DEMO_EMBED_TAG = 'text-embedding-3-small#v2';
const DEMO_CLUSTER_EMBEDDINGS = {
  10: [0.91, 0.12, 0.44, 0.21, 0.68, 0.33, 0.52, 0.6],
  9: [0.62, 0.4, 0.52, 0.34, 0.5, 0.48, 0.47, 0.44],
};

for (const story of FAILURE_STORIES) {
  const stats = clusterStats[story.clusterId];
  const fp = storyFingerprints.get(story.clusterId);
  const triage = CLUSTER_TRIAGE[story.clusterId] || {};
  const embedding = DEMO_CLUSTER_EMBEDDINGS[story.clusterId];
  const createdAt = stats.firstStartMs ? Math.floor(stats.firstStartMs / 1000) : ts('2025-04-20T09:00:00');
  const updatedAt = stats.lastStartMs ? Math.floor(stats.lastStartMs / 1000) : createdAt;
  FAILURE_CLUSTERS.push({
    id: story.clusterId,
    project_id: story.projectId,
    fingerprint: fp.fingerprint,
    signature: fp.signature,
    error_type: fp.errorType,
    selector: fp.selector,
    sample_error: story.failingCases[0].error,
    status: triage.status || 'open',
    triage_note: triage.triage_note || null,
    // A cluster that never fired falls back to the project's run span: first
    // seen = oldest run (highest id), last seen = newest run (lowest id).
    first_seen_run_id: stats.firstRunId ?? oldestRunByProject[story.projectId],
    last_seen_run_id: stats.lastRunId ?? newestRunByProject[story.projectId],
    occurrences: stats.occurrences || 1,
    ...buildClusterFix(story, stats),
    ...(embedding ? { embedding: JSON.stringify(embedding), embedding_model: DEMO_EMBED_TAG } : {}),
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

// ── Demo inbox state — assignee + snooze so the inbox queues are exercisable ──
// The failure inbox's Mine queue matches the signed-in user; assigning an open
// cluster to the default demo user (Avery) gives that queue a row. One open
// cluster is snoozed "until it recurs" so the snooze state, its "Unsnooze"
// action on the cluster page, and the fact that a snoozed cluster leaves every
// queue are all demonstrable. A far-future deadline keeps it snoozed regardless
// of the time-shift applied to the rest of the seed.
{
  const clusterById = new Map(FAILURE_CLUSTERS.map((c) => [c.id, c]));
  const assignMine = clusterById.get(7);
  if (assignMine) assignMine.assignee = DEFAULT_DEMO_USER.name;
  const snoozed = clusterById.get(9);
  if (snoozed) {
    snoozed.snoozed_until = Math.floor(Date.UTC(9999, 0, 1) / 1000);
    snoozed.snooze_mode = 'until-recurs';
  }
}

// ── Demo merge suggestions ─────────────────────────────────────────────────
// Two pending pairs (one LLM-judged, one embedding) so the list and both
// actions are exercisable, plus one rejected pair that demonstrates a
// dismissed suggestion. Each pair shares a project; cluster_a_id <
// cluster_b_id as the unique pair index requires.
const MERGE_SUGGESTIONS = [
  {
    id: 1,
    project_id: 2,
    cluster_a_id: 3,
    cluster_b_id: 4,
    score: 0.87,
    method: 'llm',
    llm_confidence: 'high',
    llm_reason:
      'Both failures surface HTTP 5xx responses from the same service tier; the error signatures differ only by endpoint.',
    status: 'pending',
    created_at: ts('2025-04-24T10:00:00'),
    updated_at: ts('2025-04-24T10:00:00'),
  },
  {
    id: 2,
    project_id: 3,
    cluster_a_id: 5,
    cluster_b_id: 6,
    score: 0.74,
    method: 'embedding',
    llm_confidence: null,
    llm_reason: null,
    status: 'pending',
    created_at: ts('2025-04-23T14:30:00'),
    updated_at: ts('2025-04-23T14:30:00'),
  },
  {
    id: 3,
    project_id: 1,
    cluster_a_id: 1,
    cluster_b_id: 2,
    score: 0.58,
    method: 'llm',
    llm_confidence: 'low',
    llm_reason:
      'One failure is a click timeout, the other a renamed field — different root-cause families despite sharing the checkout spec.',
    status: 'rejected',
    created_at: ts('2025-04-22T09:00:00'),
    updated_at: ts('2025-04-22T09:00:00'),
  },
];

// ── Demo quarantine ───────────────────────────────────────────────────────
// Three entries covering the states the tab exists to distinguish: one that has
// earned its way out, one part-way through its streak, and one still failing.
// Without all three the exit ramp looks like a list that only grows.
const QUARANTINED_TESTS = [];
{
  // Runs after the anchor count toward the streak; 4 seeded passes land the
  // entry at "4 / 5" — part-way through the exit ramp, not yet ready.
  const PARTIAL_QUARANTINE_STREAK_RUNS = 4;
  const quarantineSpec = [
    { projectId: 1, streakState: 'ready', reason: 'Times out on CI only — see cluster 1' },
    { projectId: 2, streakState: 'partial', reason: 'Search index warm-up races the assertion' },
    { projectId: 3, streakState: 'failing', reason: 'Pagination flakes under parallel load' },
  ];

  let qId = 1;
  for (const spec of quarantineSpec) {
    const flaky = FLAKY_CASES[spec.projectId];
    if (!flaky) continue;
    const proj = DEMO_PROJECTS.find((candidate) => candidate.id === spec.projectId);
    const caseDef = proj?.cases.find((candidate) => candidate.title === flaky.title);
    if (!caseDef) continue;
    const caseId = caseIdByKey.get(`${spec.projectId}\x00${caseDef.file}\x00${caseDef.title}`);
    if (!caseId) continue;

    // The streak counts executions on runs after the anchor (id > anchor), and
    // ids descend as time advances in the seed, so an anchor on the newest run
    // makes every seeded execution count (release-ready) and an anchor on the
    // oldest run counts none (still failing). The partial entry anchors a few
    // runs short of the oldest so only a handful of passes accumulate.
    const anchorRunId =
      spec.streakState === 'failing'
        ? (oldestRunByProject[spec.projectId] ?? null)
        : spec.streakState === 'partial'
          ? Number(oldestRunByProject[spec.projectId]) - PARTIAL_QUARANTINE_STREAK_RUNS || null
          : (newestRunByProject[spec.projectId] ?? null);

    QUARANTINED_TESTS.push({
      id: qId++,
      project_id: spec.projectId,
      test_case_id: caseId,
      reason: spec.reason,
      source: spec.streakState === 'ready' ? 'proposed' : 'manual',
      quarantined_at_run_id: anchorRunId,
      created_by: null,
      created_at: ts('2025-04-20T09:00:00'),
      released_at: null,
      released_reason: null,
    });
  }

  // A quarantined test whose cluster's fix has verified — the inbox's
  // "Quarantine ready" queue: the failures stopped, so the quarantine is safe to
  // lift. Anchored at that cluster's newest run so the demo shows it release-ready.
  {
    const story = FAILURE_STORIES.find((s) => s.clusterId === 10);
    const failing = story?.failingCases?.[0];
    const caseId = story && failing && caseIdByKey.get(`${story.projectId}\x00${story.specFile}\x00${failing.title}`);
    if (caseId) {
      QUARANTINED_TESTS.push({
        id: qId++,
        project_id: story.projectId,
        test_case_id: caseId,
        reason: 'Held while the pagination fix was verified; the fix landed and held.',
        source: 'manual',
        quarantined_at_run_id: newestRunByProject[story.projectId] ?? null,
        created_by: null,
        created_at: ts('2025-04-20T09:00:00'),
        released_at: null,
        released_reason: null,
      });
    }
  }
}

// ── Demo AI diagnoses ─────────────────────────────────────────────────────
// Five clusters ship with a stored diagnosis; the rest are intentionally left
// undiagnosed so a demo visitor can trigger a live (simulated) streaming
// diagnosis themselves. Patches and suspect commits come from the story
// fixtures, so `patchValidation` genuinely reports "applies" and every cited
// commit exists in the canned SCM history.

const storyFix = (clusterId) => {
  const story = FAILURE_STORIES.find((s) => s.clusterId === clusterId);
  return {
    description: story.diagnosis.fix.description,
    file: story.diagnosis.fix.file,
    code: null,
    patch: story.diagnosis.fix.patch,
  };
};
const storySuspect = (clusterId) => [FAILURE_STORIES.find((s) => s.clusterId === clusterId).suspectSha];

// Two-stage pipeline token accounting shared by all seeded diagnoses.
const demoPipeline = (input, output) => [
  {
    role: 'research',
    model: 'demo-research',
    inputTokens: Math.round(input * 0.6),
    outputTokens: 180,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
  {
    role: 'diagnosis',
    model: 'demo-simulated',
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: Math.round(input * 0.4),
    cacheReadInputTokens: Math.round(input * 0.5),
  },
];
// A patch that cleanly applies against the seeded source files (app/demo/demo-scm.ts).
const appliesPatch = { status: 'applies', filesChecked: 1, filesInPatch: 1, errors: [] };

/** A diagnosis is written shortly after its cluster's latest occurrence. */
const diagnosisTs = (clusterId, minutes) => {
  const cluster = FAILURE_CLUSTERS.find((c) => c.id === clusterId);
  return cluster.updated_at + minutes * 60;
};

const FAILURE_DIAGNOSES = [
  {
    id: 1,
    cluster_id: 1,
    scope: 'cluster',
    status: 'completed',
    provider: 'demo',
    model: 'demo-simulated',
    category: 'infrastructure',
    confidence: 'high',
    summary:
      'Checkout Pay click times out: the Pay button stays disabled until the price quote answers, and on CI the quote takes 28 s, so the click is still waiting when the 30 s test timeout hits.',
    root_cause:
      'The Pay button stays disabled until POST /api/checkout/quote answers. On failing runs that request takes 28.4 s, so locator.click waits on a disabled button until the 30 000 ms test timeout interrupts it. The helper clicks without waiting for the quote, and the test has no time budget for a quote that slow. The suspect commit also gates the form on a third-party payment SDK, which adds to the wait on a loaded CI runner, so the failure comes and goes with CI load.',
    details: JSON.stringify({
      confidenceScore: 82,
      severity: 'high',
      affectedArea: 'checkout / payment',
      hypotheses: [
        {
          category: 'infrastructure',
          likelihood: 82,
          rootCause:
            'The checkout quote answers in 28 s on loaded CI runners; the Pay button stays disabled until then, so the click is still waiting when the 30 s test timeout hits.',
          evidence: [
            'POST /api/checkout/quote takes 28.4 s on failing runs [networkRequests]',
            'The call log shows the button resolved but disabled at click time [executionError]',
            'The console warns the quote is still pending after 20 s [console]',
          ],
        },
        {
          category: 'test-bug',
          likelihood: 38,
          rootCause: 'The payment helper clicks Pay without waiting for the quote response it depends on.',
          evidence: ['Nothing in fillPaymentDetails waits on the quote request before the click [testSource]'],
        },
      ],
      evidence: [
        'The test timeout interrupts locator.click in both affected tests [executionError]',
        'POST /api/checkout/quote takes 28.4 s on failing runs [networkRequests]',
        'The SCM diff gates the form on a third-party payment SDK [scmInvestigation]',
        'The full call stack from the trace pins the timeout inside the checkout flow helper [traceCallStack]',
        'Recurs on high-load CI runs [recurrenceFlakiness]',
      ],
      investigationSteps: [
        'Time POST /api/checkout/quote on a low-load runner to confirm CI load is the driver',
        'Check why the quote endpoint takes longer than 20 s under load',
      ],
      preventionTips: [
        'Wait on the request a control depends on (page.waitForResponse) before interacting with it',
        'Mark flows that wait on slow backend calls with test.slow() instead of raising the global timeout',
      ],
      suggestedFix: storyFix(1),
      patchValidation: appliesPatch,
      pipeline: demoPipeline(1240, 380),
      autoSelectedCommits: storySuspect(1),
      selectedCommitShas: null,
      additionalContext: null,
    }),
    error: null,
    input_tokens: 1984,
    output_tokens: 560,
    duration_ms: 2850,
    created_at: diagnosisTs(1, 42),
    updated_at: diagnosisTs(1, 42),
  },
  {
    id: 2,
    cluster_id: 3,
    scope: 'cluster',
    status: 'completed',
    provider: 'demo',
    model: 'demo-simulated',
    category: 'app-bug',
    confidence: 'high',
    summary: 'POST /auth/login returns HTTP 500 — the login handler dereferences a null user after the auth refactor.',
    root_cause:
      'The assertion fails because the endpoint responds 500 instead of 200. A recent auth refactor changed verifyCredentials to return null (rather than throw) for a missing user, and the login handler then reads user.id on the null path — an unhandled exception that surfaces as a 500.',
    details: JSON.stringify({
      confidenceScore: 90,
      severity: 'blocker',
      affectedArea: 'authentication / login',
      hypotheses: [
        {
          category: 'app-bug',
          likelihood: 90,
          rootCause:
            'The login handler dereferences a null user after the auth refactor, throwing and returning HTTP 500.',
          evidence: [
            'Expected 200 / Received 500 in two separate auth test cases [executionError]',
            'Backend server logs show an unhandled TypeError on the request [serverLogs]',
            'The failure started after the auth refactor commit [scmInvestigation]',
          ],
        },
      ],
      evidence: [
        'Received 500 where 200 was expected across two auth tests [executionError]',
        'Server logs capture the 5xx and the null-dereference stack on the failing request [serverLogs]',
        'Began appearing after the "simplify auth flow" commit [scmInvestigation]',
      ],
      investigationSteps: [
        'Inspect the server stack trace behind the 500 on POST /auth/login',
        'Confirm the null-user branch in the refactored handler',
      ],
      preventionTips: [
        'Add integration tests that exercise the auth endpoint with missing/invalid users',
        'Add error monitoring on 5xx responses for the /auth/login route',
      ],
      suggestedFix: storyFix(3),
      patchValidation: appliesPatch,
      pipeline: demoPipeline(980, 310),
      autoSelectedCommits: storySuspect(3),
      selectedCommitShas: null,
      additionalContext: null,
    }),
    error: null,
    input_tokens: 1568,
    output_tokens: 490,
    duration_ms: 2100,
    created_at: diagnosisTs(3, 35),
    updated_at: diagnosisTs(3, 35),
  },
  {
    id: 3,
    cluster_id: 6,
    scope: 'cluster',
    status: 'completed',
    provider: 'demo',
    model: 'demo-simulated',
    category: 'test-flakiness',
    confidence: 'medium',
    summary:
      "Strict-mode violation — getByRole('button') matches multiple button variants rendered on the components page.",
    root_cause:
      "getByRole('button') resolves to 3 elements because the components page now renders primary, disabled and loading variants side by side (added in a recent commit). Playwright's strict mode throws on the ambiguous match; the locator needs scoping by name or container.",
    details: JSON.stringify({
      confidenceScore: 66,
      severity: 'medium',
      affectedArea: 'UI components / button',
      hypotheses: [
        {
          category: 'test-bug',
          likelihood: 66,
          rootCause:
            "getByRole('button') matches 3 rendered button variants; the locator must be scoped by name or container.",
          evidence: [
            'Strict-mode violation resolving to multiple elements [executionError]',
            'The ARIA snapshot shows several button nodes on the page [ariaSnapshot]',
            'Locator healing offers a scoped, higher-stability alternative [locatorHealing]',
          ],
        },
      ],
      evidence: [
        'Deterministic strict-mode violation, not intermittent [recurrenceFlakiness]',
        'Three button elements rendered by design (primary, disabled, loading) [ariaSnapshot]',
        'A name-scoped locator disambiguates the match [locatorHealing]',
      ],
      investigationSteps: [
        'Confirm the page intentionally renders multiple button variants',
        'Pick a scoping strategy (name filter or container) with the component owner',
      ],
      preventionTips: [
        'Scope locators to a container when multiple matches are expected',
        'Add data-testid attributes to disambiguate similar components',
      ],
      suggestedFix: storyFix(6),
      patchValidation: appliesPatch,
      pipeline: demoPipeline(870, 290),
      autoSelectedCommits: storySuspect(6),
      selectedCommitShas: null,
      additionalContext: null,
    }),
    error: null,
    input_tokens: 1392,
    output_tokens: 470,
    duration_ms: 1950,
    created_at: diagnosisTs(6, 55),
    updated_at: diagnosisTs(6, 55),
  },
  {
    id: 4,
    cluster_id: 7,
    scope: 'cluster',
    status: 'completed',
    provider: 'demo',
    model: 'demo-simulated',
    category: 'infrastructure',
    confidence: 'high',
    summary:
      'Mobile page navigation times out — page.goto exceeds 30s on Mobile Safari because the landing page ships a heavy hero image.',
    root_cause:
      'page.goto exceeds the 30 000 ms navigation timeout during the initial load. A recent commit added a full-bleed, unoptimized hero image; on throttled mobile CI networks the load never completes inside the default timeout.',
    details: JSON.stringify({
      confidenceScore: 78,
      severity: 'high',
      affectedArea: 'mobile navigation',
      hypotheses: [
        {
          category: 'infrastructure',
          likelihood: 78,
          rootCause: 'Heavy unoptimized assets push mobile page load past the goto timeout on CI networks.',
          evidence: [
            'Timeout occurs on the main navigation load, not a later interaction [executionError]',
            'Only affects the Mobile Safari browser profile [browserDistribution]',
          ],
        },
        {
          category: 'environment',
          likelihood: 34,
          rootCause: 'CI network throttling specific to the mobile project profile.',
          evidence: ['The hero image request alone takes ~28s on failing runs [networkRequests]'],
        },
      ],
      evidence: [
        'page.goto TimeoutError on the main navigation load [executionError]',
        'Only the Mobile Safari profile is affected [browserDistribution]',
        'The SCM diff adds a large full-bleed hero image [scmInvestigation]',
      ],
      investigationSteps: [
        'Measure page weight and largest-contentful-paint on the mobile profile',
        'Compare goto timing on local mobile emulation vs CI',
      ],
      preventionTips: [
        'Set browser-specific navigation timeouts via Playwright config projects',
        'Optimize landing-page assets for mobile (responsive images, lazy-loading)',
      ],
      suggestedFix: storyFix(7),
      patchValidation: appliesPatch,
      pipeline: demoPipeline(1100, 340),
      autoSelectedCommits: storySuspect(7),
      selectedCommitShas: null,
      additionalContext: null,
    }),
    error: null,
    input_tokens: 1760,
    output_tokens: 520,
    duration_ms: 2650,
    created_at: diagnosisTs(7, 48),
    updated_at: diagnosisTs(7, 48),
  },
  {
    id: 5,
    cluster_id: 10,
    scope: 'cluster',
    status: 'completed',
    provider: 'demo',
    model: 'demo-simulated',
    category: 'app-bug',
    confidence: 'high',
    summary:
      'Users table renders 51 rows instead of 26: 50 users under the header instead of 25, because server-driven pagination shipped with the API default page size.',
    root_cause:
      'The row-count assertion fails deterministically: the table renders 51 rows, the header plus 50 users, where the test expects 26, the header plus 25, because the users endpoint now returns 50 rows per page. The server-driven pagination change replaced the dashboard page size (25) with the API default (50), so the table renders two pages worth of rows and the test correctly catches the regression.',
    details: JSON.stringify({
      confidenceScore: 88,
      severity: 'medium',
      affectedArea: 'users table / pagination',
      hypotheses: [
        {
          category: 'app-bug',
          likelihood: 88,
          rootCause:
            'listUsers now queries with PAGE_SIZE 50 — the API default — instead of the dashboard page size 25.',
          evidence: [
            'Expected 26 rows (header + 25), received 51 — exactly two pages plus the header [executionError]',
            'The users API request returns 50 records [networkRequests]',
            'The pagination change shipped in the suspect commit [scmInvestigation]',
          ],
        },
        {
          category: 'test-bug',
          likelihood: 20,
          rootCause: 'The new page size is intentional and the expected count is stale.',
          evidence: ['No product note accompanies the page-size change [scmInvestigation]'],
        },
      ],
      evidence: [
        'Deterministic 26-vs-51 row count mismatch [executionError]',
        'GET /api/users?page=1 returns 50 records on failing runs [networkRequests]',
        'The "server-driven pagination" commit changed PAGE_SIZE from 25 to 50 [scmInvestigation]',
      ],
      investigationSteps: [
        'Confirm the intended dashboard page size with the design system (table density assumes 25)',
        'Check other tables consuming the same endpoint for the same regression',
      ],
      preventionTips: [
        'Keep page-size constants in one shared module consumed by both API and UI',
        'Assert on user-visible pagination controls in addition to raw row counts',
      ],
      suggestedFix: storyFix(10),
      patchValidation: appliesPatch,
      pipeline: demoPipeline(1010, 330),
      autoSelectedCommits: storySuspect(10),
      selectedCommitShas: null,
      additionalContext: null,
    }),
    error: null,
    input_tokens: 1620,
    output_tokens: 505,
    duration_ms: 2240,
    created_at: diagnosisTs(10, 38),
    updated_at: diagnosisTs(10, 38),
  },
];

// Diagnosis version history — a snapshot of an earlier, lower-confidence take on
// cluster 1 that the network capture of the slow price quote superseded. Powers
// the "previous versions" dropdown on the cluster diagnosis panel.
const FAILURE_DIAGNOSIS_VERSIONS = [
  {
    id: 1,
    diagnosis_id: 1,
    cluster_id: 1,
    scope: 'cluster',
    test_runs_case_id: null,
    status: 'completed',
    provider: 'demo',
    model: 'demo-simulated',
    category: 'test-bug',
    confidence: 'medium',
    summary: 'Earlier take: likely a missing explicit wait in the payment helper before the Pay click.',
    root_cause:
      'Initial assessment attributed the timeout purely to a missing explicit wait in the payment helper, before the network capture showed the 28 s price quote the Pay button waits on.',
    details: JSON.stringify({
      confidenceScore: 58,
      severity: 'medium',
      affectedArea: 'checkout / payment',
      hypotheses: [
        {
          category: 'test-bug',
          likelihood: 58,
          rootCause: 'The helper clicks the Pay button without waiting for it to become interactive.',
          evidence: ['No waitFor precedes the click [testSource]'],
        },
      ],
      evidence: ['Intermittent timeouts on locator.click [recurrenceFlakiness]'],
      investigationSteps: ['Check CI load at failure time'],
      preventionTips: ['Await the target before interacting'],
      suggestedFix: {
        description: 'Add an explicit wait before clicking the Pay button.',
        file: 'tests/helpers/payment.ts',
        code: null,
        patch: null,
      },
    }),
    error: null,
    input_tokens: 640,
    output_tokens: 210,
    duration_ms: 1700,
    context_sha: null,
    created_at: diagnosisTs(1, -540),
  },
];

// ── Entity links ────────────────────────────────────────────────────────────
const ENTITY_LINKS = [
  {
    id: 1,
    test_run_id: 1,
    test_runs_case_id: null,
    test_case_id: null,
    url: 'https://example.atlassian.net/browse/PROJ-123',
    provider: 'jira',
    key: 'PROJ-123',
    title: 'Checkout flow improvements',
    status_text: null,
    status_color: null,
    metadata: null,
    unfurled_at: null,
    created_by: null,
    // entity_links.created_at/updated_at are timestamp_ms columns — store ms.
    created_at: ts('2025-04-25T08:30:00') * 1000,
    updated_at: ts('2025-04-25T08:30:00') * 1000,
  },
  {
    id: 2,
    test_run_id: null,
    test_runs_case_id: null,
    test_case_id: 1,
    url: 'https://github.com/example/shop-web/issues/456',
    provider: 'github-issue',
    key: '#456',
    title: 'Fix credit card checkout timeout',
    status_text: 'open',
    status_color: 'neutral',
    metadata: null,
    unfurled_at: null,
    created_by: null,
    created_at: ts('2025-04-24T10:00:00') * 1000,
    updated_at: ts('2025-04-24T10:00:00') * 1000,
  },
  {
    id: 3,
    test_run_id: null,
    test_runs_case_id: 5,
    test_case_id: null,
    url: 'https://linear.app/team/issue/TEAM-789/paypal-issue',
    provider: 'linear',
    key: 'TEAM-789',
    title: 'PayPal sandbox timeout investigation',
    status_text: null,
    status_color: null,
    metadata: null,
    unfurled_at: null,
    created_by: null,
    created_at: ts('2025-04-25T09:00:00') * 1000,
    updated_at: ts('2025-04-25T09:00:00') * 1000,
  },
  {
    // The Jira issue the login 500 (cluster 3) is tracked in, filed from Piwi
    // through the demo's Jira connection (`app/demo/api/integrations.ts`) and
    // In Progress, as its triage note says. Its key stays under the DEMO-1xx
    // keys the demo files, and no connection row backs it: a dev server seeded
    // from the demo never polls a Jira it cannot reach.
    id: 4,
    failure_cluster_id: 3,
    url: 'https://demo.atlassian.net/browse/DEMO-42',
    provider: 'jira',
    key: 'DEMO-42',
    title: 'Login returns 500 when verifyCredentials finds no user',
    status_text: 'In Progress',
    status_color: 'warning',
    metadata: { statusCategory: 'indeterminate', assignee: 'David Lee' },
    unfurled_at: null,
    connection_id: null,
    external_id: '10042',
    origin: 'created',
    created_by: 4,
    created_at: ts('2025-04-24T12:00:00') * 1000,
    updated_at: ts('2025-04-25T08:00:00') * 1000,
  },
];

// ── Users, groups & role bindings ───────────────────────────────────────────
// Seed the canonical demo identities and groups so the access model is usable
// in the demo (the "act as" switcher in the banner picks one of these).
const USERS = [...DEMO_USERS]
  .sort((a, b) => a.id - b.id)
  .map((u) => ({
    id: u.id,
    username: u.username,
    password: '', // demo identities are switched client-side, never logged in
    role: u.instanceRole,
    name: u.name,
    email: u.email,
    email_verified: 1,
    created_at: ts('2025-02-01'),
    updated_at: ts('2025-02-01'),
  }));

const accessCreatedAt = new Date('2025-02-10').getTime(); // timestamp_ms columns
const GROUPS = DEMO_GROUPS.map((g) => ({
  id: g.id,
  name: g.name,
  description: g.description,
  created_by: null,
  created_at: accessCreatedAt,
  updated_at: accessCreatedAt,
}));
const GROUP_MEMBERS = DEMO_GROUPS.flatMap((g) =>
  g.memberIds.map((userId) => ({ group_id: g.id, user_id: userId, added_by: null, created_at: accessCreatedAt })),
);

const ROLE_BINDINGS = [];
let roleBindingId = 1;
function bindRole(subject, binding) {
  ROLE_BINDINGS.push({
    id: roleBindingId++,
    user_id: subject.userId ?? null,
    group_id: subject.groupId ?? null,
    project_id: binding.projectId,
    role: binding.role,
    created_by: null,
    created_at: accessCreatedAt,
  });
}
for (const g of DEMO_GROUPS) for (const b of g.bindings) bindRole({ groupId: g.id }, b);
for (const u of DEMO_USERS) {
  // Administrators open every project without a binding.
  if (u.instanceRole === 'administrator') continue;
  for (const b of u.bindings) bindRole({ userId: u.id }, b);
}

// ── Locator healing snapshots ───────────────────────────────────────────────
// One row per (test_case_id, location) — the same schema as the live server.
// Locations are the real call sites in the fixture sources: the failing
// locators' rows sit exactly where the error's innermost stack frame points
// (`extractErrorLocation` takes the first frame), so the healing ladder's
// exact-location rung hits. `last_seen_*` comes from the actual generated run
// history: a failing locator was last captured on the case's most recent
// PASSING execution; locators that still succeed update on every execution.
function locatorSig(method, strings) {
  return createHash('sha256')
    .update(`${method} ${JSON.stringify(strings)}`, 'utf-8')
    .digest('hex');
}

/** `file:line:col` for a call in an authored fixture source. */
function callSite(file, needle, column, nth = 0) {
  return `${file}:${lineOf(SOURCE_FILES[file], needle, nth)}:${column}`;
}

/** last_seen fields from a case's most recent execution matching `filter`. */
function lastSeen(projectId, specFile, title, filter) {
  const caseId = caseIdByKey.get(`${projectId}\x00${specFile}\x00${title}`);
  const trc = latestTrc(caseId, filter);
  return trc
    ? { last_seen_run_id: trc.test_run_id, last_seen_at: trc.started_at }
    : { last_seen_run_id: null, last_seen_at: BASE_START_MS };
}
const seenOnPass = (pid, file, title) => lastSeen(pid, file, title, (t) => t.status === 'passed');
const seenOnRun = (pid, file, title) => lastSeen(pid, file, title, (t) => t.status !== 'didnotrun');

// Shared alternative lists — each sorted descending by stability score.
const ALT_CHECKOUT_PAY = [
  { locator: "getByTestId('checkout-pay')", method: 'getByTestId', args: { testId: 'checkout-pay' }, score: 100 },
  {
    locator: "getByRole('button', { name: 'Pay now' })",
    method: 'getByRole',
    args: { role: 'button', name: 'Pay now' },
    score: 90,
  },
  { locator: "getByText('Pay now')", method: 'getByText', args: { text: 'Pay now' }, score: 75 },
  { locator: "locator('#checkout-pay')", method: 'locator', args: { selector: '#checkout-pay' }, score: 65 },
];

const ALT_CHECKOUT_EMAIL = [
  { locator: "getByTestId('email-input')", method: 'getByTestId', args: { testId: 'email-input' }, score: 100 },
  { locator: "getByLabel('Email address')", method: 'getByLabel', args: { label: 'Email address' }, score: 85 },
  {
    locator: "getByPlaceholder('your@email.com')",
    method: 'getByPlaceholder',
    args: { placeholder: 'your@email.com' },
    score: 80,
  },
  { locator: "locator('#checkout-email')", method: 'locator', args: { selector: '#checkout-email' }, score: 65 },
];

// Alternatives for the email field that later fails on a label rename (cluster
// #2's showcase). Unlike ALT_CHECKOUT_EMAIL this field has NO data-testid of its
// own — so capture generates an ancestor-scoped alternative (72) from the
// per-field `email-field` wrapper. When the label changes, the two name-based
// alternatives (90/85) go stale and healing recommends the anchored one.
const ALT_CHECKOUT_EMAIL_RENAMED = [
  {
    locator: "getByRole('textbox', { name: 'Email address' })",
    method: 'getByRole',
    args: { role: 'textbox', name: 'Email address' },
    score: 90,
  },
  { locator: "getByLabel('Email address')", method: 'getByLabel', args: { label: 'Email address' }, score: 85 },
  {
    locator: "getByTestId('email-field').getByRole('textbox')",
    method: 'getByRole',
    args: { role: 'textbox', anchorTestId: 'email-field' },
    score: 72,
  },
  { locator: "locator('#checkout-email')", method: 'locator', args: { selector: '#checkout-email' }, score: 65 },
];

const ALT_CARD_NUMBER = [
  { locator: "getByTestId('card-number')", method: 'getByTestId', args: { testId: 'card-number' }, score: 100 },
  { locator: "getByLabel('Card number')", method: 'getByLabel', args: { label: 'Card number' }, score: 85 },
  {
    locator: "getByPlaceholder('1234 5678 9012 3456')",
    method: 'getByPlaceholder',
    args: { placeholder: '1234 5678 9012 3456' },
    score: 80,
  },
  { locator: "locator('#card-number')", method: 'locator', args: { selector: '#card-number' }, score: 65 },
];

const ALT_CARD_EXPIRY = [
  { locator: "getByTestId('card-expiry')", method: 'getByTestId', args: { testId: 'card-expiry' }, score: 100 },
  { locator: "getByLabel('Expiry date')", method: 'getByLabel', args: { label: 'Expiry date' }, score: 85 },
  { locator: "getByPlaceholder('MM / YY')", method: 'getByPlaceholder', args: { placeholder: 'MM / YY' }, score: 80 },
];

const ALT_PAYPAL_BTN = [
  { locator: "getByTestId('paypal-btn')", method: 'getByTestId', args: { testId: 'paypal-btn' }, score: 100 },
  {
    locator: "getByRole('button', { name: 'Continue with PayPal' })",
    method: 'getByRole',
    args: { role: 'button', name: 'Continue with PayPal' },
    score: 90,
  },
  {
    locator: "getByText('Continue with PayPal')",
    method: 'getByText',
    args: { text: 'Continue with PayPal' },
    score: 75,
  },
  { locator: "locator('.paypal-button')", method: 'locator', args: { selector: '.paypal-button' }, score: 30 },
];

const ALT_CART_REMOVE = [
  { locator: "getByTestId('remove-item-btn')", method: 'getByTestId', args: { testId: 'remove-item-btn' }, score: 100 },
  {
    locator: "getByRole('button', { name: 'Remove' })",
    method: 'getByRole',
    args: { role: 'button', name: 'Remove' },
    score: 90,
  },
  { locator: "getByText('Remove')", method: 'getByText', args: { text: 'Remove' }, score: 75 },
  { locator: "locator('.cart-item-remove')", method: 'locator', args: { selector: '.cart-item-remove' }, score: 30 },
];

const ALT_FULL_NAME = [
  { locator: "getByTestId('fullname-input')", method: 'getByTestId', args: { testId: 'fullname-input' }, score: 100 },
  { locator: "getByLabel('Full name')", method: 'getByLabel', args: { label: 'Full name' }, score: 85 },
  {
    locator: "getByPlaceholder('John Smith')",
    method: 'getByPlaceholder',
    args: { placeholder: 'John Smith' },
    score: 80,
  },
  { locator: "locator('#full-name')", method: 'locator', args: { selector: '#full-name' }, score: 65 },
];

const ALT_SAVE_ADDRESS = [
  {
    locator: "getByTestId('save-address-btn')",
    method: 'getByTestId',
    args: { testId: 'save-address-btn' },
    score: 100,
  },
  {
    locator: "getByRole('button', { name: 'Save address' })",
    method: 'getByRole',
    args: { role: 'button', name: 'Save address' },
    score: 90,
  },
  { locator: "getByText('Save address')", method: 'getByText', args: { text: 'Save address' }, score: 75 },
];

// Button strict-mode: the test called getByRole('button') without a name filter,
// resolving to 3 elements (Primary / Disabled / Loading…). Alternatives narrow
// the selector to the primary variant — the same one the diagnosis patch and
// the ARIA snapshot name.
const ALT_BUTTON_STRICT = [
  { locator: "getByTestId('primary-btn')", method: 'getByTestId', args: { testId: 'primary-btn' }, score: 100 },
  {
    locator: "getByRole('button', { name: 'Primary' })",
    method: 'getByRole',
    args: { role: 'button', name: 'Primary' },
    score: 90,
  },
  { locator: "getByText('Primary')", method: 'getByText', args: { text: 'Primary' }, score: 75 },
  { locator: "locator('.btn-primary')", method: 'locator', args: { selector: '.btn-primary' }, score: 30 },
];

const PAY_CLICK_SITE = storyByClusterId(1).captureLocation;
const EMAIL_FILL_SITE = storyByClusterId(2).captureLocation;
const BUTTON_CLICK_SITE = storyByClusterId(6).captureLocation;
const EXPORT_ASSERT_SITE = storyByClusterId(9).captureLocation;

const ALT_EXPORT_CSV = [
  {
    locator: "getByRole('button', { name: 'Export CSV' })",
    method: 'getByRole',
    args: { role: 'button', name: 'Export CSV' },
    score: 90,
  },
  { locator: "getByText('Export CSV')", method: 'getByText', args: { text: 'Export CSV' }, score: 75 },
  { locator: "locator('.export-btn')", method: 'locator', args: { selector: '.export-btn' }, score: 40 },
];

let lsId = 1;
const LOCATOR_SNAPSHOTS = [
  // ── Cluster #1: checkout Pay button (test_case_ids 1 & 2) ─────────────────
  // The click lives in the shared payment helper, so both checkout cases carry
  // a snapshot keyed at the SAME helper call site — exactly where the error's
  // innermost frame points, so the exact-location rung matches immediately.
  ...[
    ['should complete checkout with credit card', 1],
    ['should complete checkout with PayPal', 2],
  ].map(([title, testCaseId]) => ({
    id: lsId++,
    test_case_id: testCaseId,
    location: PAY_CLICK_SITE,
    used_method: 'getByRole',
    used_args: ['button', { name: 'Pay' }],
    used_args_fp: locatorSig('getByRole', ['button', 'Pay']),
    element_tag: 'button',
    element_attrs: {
      id: 'checkout-pay',
      'data-testid': 'checkout-pay',
      accessibleName: 'Pay now',
      center: { x: 640, y: 820 },
    },
    element_text: 'Pay now',
    alternatives: ALT_CHECKOUT_PAY,
    ...seenOnPass(1, 'tests/checkout/checkout.spec.ts', title),
  })),

  // ── Cluster #2: renamed email label (test_case_id 3) ──────────────────────
  // The last passing run captured the email field at its call site; the field
  // has an id and sits inside a per-field `email-field` wrapper (so an
  // ancestor-scoped locator is unique) but no data-testid of its own. When the
  // label later changes, healing flags the name-based alternatives as stale and
  // recommends the surviving `getByTestId('email-field').getByRole('textbox')`.
  {
    id: lsId++,
    test_case_id: 3,
    location: EMAIL_FILL_SITE,
    used_method: 'getByLabel',
    used_args: ['Email address'],
    used_args_fp: locatorSig('getByLabel', ['Email address']),
    element_tag: 'input',
    element_attrs: {
      type: 'email',
      id: 'checkout-email',
      accessibleName: 'Email address',
      center: { x: 640, y: 300 },
      // Captured when the checkout step had four form fields; at failure time
      // the step is restructured (email replaced), so the same-role count no
      // longer matches and no confident rename is possible → stale.
      rolePosition: { role: 'textbox', count: 4, index: 0 },
      ancestors: [
        {
          tag: 'div',
          depth: 1,
          testId: 'email-field',
          role: null,
          ariaLabel: null,
          scopedRoleCount: 1,
          testIdCount: 1,
        },
        {
          tag: 'form',
          depth: 2,
          testId: 'checkout-form',
          role: null,
          ariaLabel: null,
          scopedRoleCount: 4,
          testIdCount: 1,
        },
      ],
    },
    element_text: '',
    alternatives: ALT_CHECKOUT_EMAIL_RENAMED,
    ...seenOnPass(1, 'tests/checkout/checkout.spec.ts', 'should complete checkout with Apple Pay'),
  },

  // ── Additional captures from the credit-card checkout flow (test_case_id 1) ─
  // Shows that the reporter captures every locator action in a run, not just
  // the one that later fails — these populate the test-case detail page. The
  // email fill sits in the spec; the card fields live in the shared helper.
  {
    id: lsId++,
    test_case_id: 1,
    location: callSite('tests/checkout/checkout.spec.ts', "getByLabel('Email address')", 10, 0),
    used_method: 'getByLabel',
    used_args: ['Email address'],
    used_args_fp: locatorSig('getByLabel', ['Email address']),
    element_tag: 'input',
    element_attrs: {
      type: 'email',
      id: 'checkout-email',
      'data-testid': 'email-input',
      placeholder: 'your@email.com',
      autocomplete: 'email',
      accessibleName: 'Email address',
      center: { x: 640, y: 540 },
      // Structural context captured by newer reporters — powers the
      // renamed-element positional match at heal time.
      rolePosition: { role: 'textbox', count: 5, index: 0 },
      ancestors: [
        {
          tag: 'form',
          depth: 2,
          testId: 'checkout-form',
          id: 'checkout',
          role: null,
          ariaLabel: null,
          scopedRoleCount: 5,
          testIdCount: 1,
          idCount: 1,
          roleCount: 1,
        },
      ],
    },
    element_text: '',
    alternatives: ALT_CHECKOUT_EMAIL,
    ...seenOnRun(1, 'tests/checkout/checkout.spec.ts', 'should complete checkout with credit card'),
  },
  {
    id: lsId++,
    test_case_id: 1,
    location: callSite('tests/helpers/payment.ts', "getByLabel('Card number')", 14),
    used_method: 'getByLabel',
    used_args: ['Card number'],
    used_args_fp: locatorSig('getByLabel', ['Card number']),
    element_tag: 'input',
    element_attrs: {
      type: 'text',
      id: 'card-number',
      'data-testid': 'card-number',
      placeholder: '1234 5678 9012 3456',
      autocomplete: 'cc-number',
      center: { x: 640, y: 620 },
    },
    element_text: '',
    alternatives: ALT_CARD_NUMBER,
    ...seenOnRun(1, 'tests/checkout/checkout.spec.ts', 'should complete checkout with credit card'),
  },
  {
    id: lsId++,
    test_case_id: 1,
    location: callSite('tests/helpers/payment.ts', "getByLabel('Expiry date')", 14),
    used_method: 'getByLabel',
    used_args: ['Expiry date'],
    used_args_fp: locatorSig('getByLabel', ['Expiry date']),
    element_tag: 'input',
    element_attrs: {
      type: 'text',
      id: 'card-expiry',
      'data-testid': 'card-expiry',
      placeholder: 'MM / YY',
      autocomplete: 'cc-exp',
      center: { x: 480, y: 660 },
    },
    element_text: '',
    alternatives: ALT_CARD_EXPIRY,
    ...seenOnRun(1, 'tests/checkout/checkout.spec.ts', 'should complete checkout with credit card'),
  },

  // ── Additional captures from the PayPal checkout flow (test_case_id 2) ─────
  {
    id: lsId++,
    test_case_id: 2,
    location: callSite('tests/checkout/checkout.spec.ts', "getByLabel('Email address')", 10, 1),
    used_method: 'getByLabel',
    used_args: ['Email address'],
    used_args_fp: locatorSig('getByLabel', ['Email address']),
    element_tag: 'input',
    element_attrs: {
      type: 'email',
      id: 'checkout-email',
      'data-testid': 'email-input',
      placeholder: 'your@email.com',
      autocomplete: 'email',
      center: { x: 640, y: 540 },
    },
    element_text: '',
    alternatives: ALT_CHECKOUT_EMAIL,
    ...seenOnRun(1, 'tests/checkout/checkout.spec.ts', 'should complete checkout with PayPal'),
  },
  {
    id: lsId++,
    test_case_id: 2,
    location: callSite('tests/checkout/checkout.spec.ts', "getByRole('button', { name: 'Continue with PayPal' })", 16),
    used_method: 'getByRole',
    used_args: ['button', { name: 'Continue with PayPal' }],
    used_args_fp: locatorSig('getByRole', ['button', 'Continue with PayPal']),
    element_tag: 'button',
    element_attrs: {
      'data-testid': 'paypal-btn',
      class: 'paypal-button btn',
      accessibleName: 'Continue with PayPal',
      center: { x: 640, y: 740 },
    },
    element_text: 'Continue with PayPal',
    alternatives: ALT_PAYPAL_BTN,
    ...seenOnRun(1, 'tests/checkout/checkout.spec.ts', 'should complete checkout with PayPal'),
  },

  // ── Cart add-to-cart (test_case_id 6 — should add item to cart) ──────────
  {
    id: lsId++,
    test_case_id: 6,
    location: 'tests/checkout/cart.spec.ts:6:14',
    used_method: 'getByRole',
    used_args: ['button', { name: 'Add to cart' }],
    used_args_fp: locatorSig('getByRole', ['button', 'Add to cart']),
    element_tag: 'button',
    element_attrs: {
      id: 'add-to-cart-btn',
      'data-testid': 'add-to-cart-btn',
      class: 'btn btn-primary add-to-cart',
      accessibleName: 'Add to cart',
      center: { x: 580, y: 390 },
    },
    element_text: 'Add to cart',
    alternatives: [
      {
        locator: "getByTestId('add-to-cart-btn')",
        method: 'getByTestId',
        args: { testId: 'add-to-cart-btn' },
        score: 100,
      },
      {
        locator: "getByRole('button', { name: 'Add to cart' })",
        method: 'getByRole',
        args: { role: 'button', name: 'Add to cart' },
        score: 90,
      },
      { locator: "getByText('Add to cart')", method: 'getByText', args: { text: 'Add to cart' }, score: 75 },
      { locator: "locator('#add-to-cart-btn')", method: 'locator', args: { selector: '#add-to-cart-btn' }, score: 65 },
    ],
    ...seenOnRun(1, 'tests/checkout/cart.spec.ts', 'should add item to cart'),
  },

  // ── Cart remove (test_case_id 7 — should remove item from cart) ──────────
  {
    id: lsId++,
    test_case_id: 7,
    location: 'tests/checkout/cart.spec.ts:13:14',
    used_method: 'getByRole',
    used_args: ['button', { name: 'Remove' }],
    used_args_fp: locatorSig('getByRole', ['button', 'Remove']),
    element_tag: 'button',
    element_attrs: {
      'data-testid': 'remove-item-btn',
      class: 'btn-icon cart-item-remove',
      'aria-label': 'Remove item',
      accessibleName: 'Remove',
      center: { x: 980, y: 320 },
    },
    element_text: 'Remove',
    alternatives: ALT_CART_REMOVE,
    ...seenOnRun(1, 'tests/checkout/cart.spec.ts', 'should remove item from cart'),
  },

  // ── Shipping address form (test_case_id 11 — should fill and save shipping address) ─
  {
    id: lsId++,
    test_case_id: 11,
    location: 'tests/checkout/address.spec.ts:6:10',
    used_method: 'getByLabel',
    used_args: ['Full name'],
    used_args_fp: locatorSig('getByLabel', ['Full name']),
    element_tag: 'input',
    element_attrs: {
      type: 'text',
      id: 'full-name',
      'data-testid': 'fullname-input',
      placeholder: 'John Smith',
      autocomplete: 'name',
      center: { x: 640, y: 280 },
    },
    element_text: '',
    alternatives: ALT_FULL_NAME,
    ...seenOnRun(1, 'tests/checkout/address.spec.ts', 'should fill and save shipping address'),
  },
  {
    id: lsId++,
    test_case_id: 11,
    location: 'tests/checkout/address.spec.ts:7:10',
    used_method: 'getByLabel',
    used_args: ['Street address'],
    used_args_fp: locatorSig('getByLabel', ['Street address']),
    element_tag: 'input',
    element_attrs: {
      type: 'text',
      id: 'street-address',
      'data-testid': 'street-address',
      placeholder: '123 Main St',
      autocomplete: 'street-address',
      center: { x: 640, y: 340 },
    },
    element_text: '',
    alternatives: [
      {
        locator: "getByTestId('street-address')",
        method: 'getByTestId',
        args: { testId: 'street-address' },
        score: 100,
      },
      { locator: "getByLabel('Street address')", method: 'getByLabel', args: { label: 'Street address' }, score: 85 },
      {
        locator: "getByPlaceholder('123 Main St')",
        method: 'getByPlaceholder',
        args: { placeholder: '123 Main St' },
        score: 80,
      },
      { locator: "locator('#street-address')", method: 'locator', args: { selector: '#street-address' }, score: 65 },
    ],
    ...seenOnRun(1, 'tests/checkout/address.spec.ts', 'should fill and save shipping address'),
  },
  {
    id: lsId++,
    test_case_id: 11,
    location: 'tests/checkout/address.spec.ts:9:14',
    used_method: 'getByRole',
    used_args: ['button', { name: 'Save address' }],
    used_args_fp: locatorSig('getByRole', ['button', 'Save address']),
    element_tag: 'button',
    element_attrs: {
      'data-testid': 'save-address-btn',
      class: 'btn btn-primary',
      accessibleName: 'Save address',
      center: { x: 640, y: 540 },
    },
    element_text: 'Save address',
    alternatives: ALT_SAVE_ADDRESS,
    ...seenOnRun(1, 'tests/checkout/address.spec.ts', 'should fill and save shipping address'),
  },

  // ── Cluster #6: button strict-mode violation (test_case_id 27) ────────────
  // The snapshot is keyed at the getByRole call site. The error's frame carries
  // a column (as real captures do), so the ladder resolves via the
  // file:line rung (path-suffix tolerant) and then the locator signature.
  // The captured element is the PRIMARY variant — the same one the ARIA
  // snapshot, the diagnosis patch and the alternatives all name.
  {
    id: lsId++,
    test_case_id: 27,
    location: BUTTON_CLICK_SITE,
    used_method: 'getByRole',
    used_args: ['button'],
    used_args_fp: locatorSig('getByRole', ['button']),
    element_tag: 'button',
    element_attrs: {
      'data-testid': 'primary-btn',
      class: 'btn btn-primary',
      accessibleName: 'Primary',
      center: { x: 320, y: 280 },
    },
    element_text: 'Primary',
    alternatives: ALT_BUTTON_STRICT,
    ...seenOnPass(3, 'tests/ui/button.spec.ts', 'Button primary variant renders correctly'),
  },

  // ── Cluster #9: Export CSV button hidden in dark mode ─────────────────────
  // The locator is never acted on — it only appears in expect(…).toBeVisible()
  // — so this snapshot comes from the reporter's ASSERTION capture, keyed at
  // the expect() call site. On the failing (dark-mode) page the hidden button
  // is absent from the ARIA snapshot, so healing flags the name-derived
  // alternatives as stale, recommends the surviving class selector, and
  // advises adding a data-testid.
  {
    id: lsId++,
    test_case_id: caseIdByKey.get(`5\x00tests/admin/reports.spec.ts\x00exports the monthly report as CSV`),
    location: EXPORT_ASSERT_SITE,
    used_method: 'getByRole',
    used_args: ['button', { name: 'Export CSV' }],
    used_args_fp: locatorSig('getByRole', ['button', 'Export CSV']),
    element_tag: 'button',
    element_attrs: {
      class: 'export-btn',
      accessibleName: 'Export CSV',
      center: { x: 1180, y: 96 },
      // Three buttons at capture time (Toggle theme, Refresh data, Export
      // CSV); only two remain visible on the failing dark-mode page, so the
      // positional rename-rescue is correctly disqualified (count mismatch).
      rolePosition: { role: 'button', count: 3, index: 2 },
    },
    element_text: 'Export CSV',
    alternatives: ALT_EXPORT_CSV,
    ...seenOnPass(5, 'tests/admin/reports.spec.ts', 'exports the monthly report as CSV'),
  },
];

// ── Load-time timestamp rebase ─────────────────────────────────────────────
// Every timestamp above is anchored to a fixed generation-time window, so a
// committed seed would show runs that drift ever further into the past. To keep
// the demo feeling live, the seed shifts every timestamp forward when it runs —
// the first time a visitor opens the demo AND every time they reset the data —
// so the newest run always lands near "now". SQLite evaluates
// `strftime('%s','now')` at seed-run time, so the offset is computed relative to
// the actual moment of the visit, not to when the seed file was built.
//
// `ANCHOR_SEC` is the newest timestamp in the dataset (in seconds). Mapping it
// to the current time and shifting everything else by the same delta keeps the
// data's internal spacing intact and guarantees nothing lands in the future.
// ── Code reach (the source files each test executed) ─────────────────────────
// A nightly code-reach sample on the main project: each test reaches the
// components and modules its stories name, stamped with the project's latest run.
const CODE_REACH_FILES = [
  'src/components/CheckoutForm.vue',
  'src/lib/cart.ts',
  'src/lib/payment-provider.ts',
  'src/pages/index.vue',
  'src/components/ContactFields.vue',
  'src/services/orders.ts',
  'src/components/RevenueChart.vue',
  'src/pages/reports/monthly.vue',
];
const CODE_REACH = [];
{
  const mainProject = DEMO_PROJECTS[0].id;
  const latestRun = TEST_RUNS.filter((r) => r.project_id === mainProject).reduce((a, b) => (b.id > a.id ? b : a));
  let crId = 1;
  for (const [i, caseId] of (caseIdsByProject[mainProject] ?? []).entries()) {
    const first = i % CODE_REACH_FILES.length;
    const files = [
      ...new Set([
        CODE_REACH_FILES[first],
        CODE_REACH_FILES[(first + 3) % CODE_REACH_FILES.length],
        'src/pages/index.vue',
      ]),
    ];
    for (const file of files.sort()) {
      CODE_REACH.push({
        id: crId++,
        project_id: mainProject,
        test_case_id: caseId,
        branch: '',
        file,
        origin: 'client',
        last_seen_run_id: latestRun.id,
        last_seen_at: latestRun.start_time * 1000,
      });
    }
  }
}

// ── Coverage (the suspect lines of a story's cluster) ─────────────────────────
// A story with `coverage` gets it on every execution of the newest run its
// cluster fails in: the browser files each test reached, by spec file, stored
// as the reporter's ingest stores them (one fragment per file, a payload of
// fragment ids per execution). Joined with the demo's canned changes, the
// cluster and its executions get suspect lines.
const COVERAGE_FRAGMENTS = [];
{
  const fragmentIds = new Map();
  const fragmentId = (projectId, path, seenAt) => {
    const key = `${projectId}\x00${path}`;
    if (!fragmentIds.has(key)) {
      const id = COVERAGE_FRAGMENTS.length + 1;
      // The hash of `canonicalCoverageFile` for a file with no blob, functions or lines.
      const canonical = JSON.stringify(['browser', path, '', '', '']);
      COVERAGE_FRAGMENTS.push({
        id,
        project_id: projectId,
        hash: createHash('sha256').update(canonical).digest('hex'),
        runtime: 'browser',
        path,
        blob: null,
        functions: null,
        lines: null,
        created_at: seenAt,
        last_seen_at: seenAt,
      });
      fragmentIds.set(key, id);
    }
    return fragmentIds.get(key);
  };
  const coveragePayloadId = (projectId, ids, createdAt) => {
    const content = JSON.stringify([...ids].sort((a, b) => a - b));
    const key = `${projectId}\x00coverage\x00${content}`;
    if (!casePayloadIds.has(key)) {
      const id = CASE_PAYLOADS.length + 1;
      CASE_PAYLOADS.push({
        id,
        project_id: projectId,
        hash: createHash('sha256').update(content).digest('hex'),
        content,
        size: content.length,
        created_at: createdAt,
      });
      casePayloadIds.set(key, id);
    }
    return casePayloadIds.get(key);
  };
  const fileOfCase = new Map(TEST_CASES.map((tc) => [tc.id, tc.file_path]));
  for (const story of FAILURE_STORIES) {
    if (!story.coverage) continue;
    const failingRunIds = new Set(
      TEST_RUNS_CASES.filter((trc) => trc.failure_cluster_id === story.clusterId && trc.status === 'failed').map(
        (trc) => trc.test_run_id,
      ),
    );
    // The generator numbers a project's runs newest first, so the newest is the latest start.
    const run = TEST_RUNS.filter((r) => failingRunIds.has(r.id)).reduce(
      (newest, r) => (!newest || r.start_time > newest.start_time ? r : newest),
      null,
    );
    if (!run) continue;
    for (const trc of TEST_RUNS_CASES) {
      if (trc.test_run_id !== run.id || (trc.status !== 'failed' && trc.status !== 'passed')) continue;
      const files = story.coverage[fileOfCase.get(trc.test_case_id)];
      if (!files?.length) continue;
      const ids = files.map((path) => fragmentId(story.projectId, path, run.start_time));
      trc.coverage_payload_id = coveragePayloadId(story.projectId, ids, run.start_time);
    }
  }
}

function collectAnchorSec() {
  let max = 0;
  // Fold a candidate timestamp into the running max, normalizing to seconds.
  const bump = (v, unit) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    const s = unit === 'ms' ? Math.floor(v / 1000) : v;
    if (s > max) max = s;
  };

  // Tables whose created_at/updated_at are second-precision.
  for (const rows of [TAGS, PROJECTS, USERS, TEST_SUITES, TEST_CASES, FAILURE_CLUSTERS, FAILURE_DIAGNOSES]) {
    for (const r of rows) {
      bump(r.created_at, 's');
      bump(r.updated_at, 's');
    }
  }
  for (const r of MERGE_SUGGESTIONS) {
    bump(r.created_at, 's');
    bump(r.updated_at, 's');
  }
  for (const r of APP_SETTINGS) bump(r.updated_at, 's');
  for (const r of FAILURE_DIAGNOSIS_VERSIONS) bump(r.created_at, 's');
  for (const r of TEST_RUNS) {
    bump(r.start_time, 's');
    bump(r.created_at, 's');
    bump(r.updated_at, 's');
    bump(r.kept_at, 's');
  }
  for (const r of REPORTS) bump(r.created_at, 's');
  for (const r of ATTACHMENTS) bump(r.created_at, 's');

  // Millisecond-precision columns.
  for (const r of GROUPS) {
    bump(r.created_at, 'ms');
    bump(r.updated_at, 'ms');
  }
  for (const r of GROUP_MEMBERS) bump(r.created_at, 'ms');
  for (const r of ROLE_BINDINGS) bump(r.created_at, 'ms');
  for (const r of LOCATOR_SNAPSHOTS) bump(r.last_seen_at, 'ms');
  for (const r of CODE_REACH) bump(r.last_seen_at, 'ms');
  for (const r of ENTITY_LINKS) {
    bump(r.created_at, 'ms');
    bump(r.updated_at, 'ms');
  }
  for (const r of TEST_RUNS_CASES) {
    bump(r.started_at, 'ms');
    bump(r.created_at, 'ms');
    for (const e of r.steps || []) bump(e.startTime, 'ms');
    for (const e of r.step_events || []) bump(e.startedAt, 'ms');
    for (const e of r.console_logs || []) bump(e.timestamp, 'ms');
    for (const e of r.dialogs || []) bump(e.closedAt, 'ms');
    for (const e of JSON.parse(r.attempts ?? '[]')) bump(e.startedAt, 'ms');
  }
  for (const r of NETWORK_REQUESTS) {
    for (const e of r.server_logs || []) bump(e.timestamp, 'ms');
  }
  return max;
}

const ANCHOR_SEC = collectAnchorSec();

// ── Hand-back outcomes and diagnosis ratings (rng-free) ────────────────────
// What became of what Piwi handed back over the last weeks, so the Analytics
// page's Hand-back outcomes section and the AI usage panel have something to
// read: locator heals adopted and verified, auto-heal pull requests merged and
// one closed, diagnoses rated and confirmed by the fix, failed gates with one
// pull request merged anyway that then failed again, and a flaky test Flake
// Lab proved fixed. Every row is placed before the anchor, so the rebase lands
// it in the past.
const HANDBACK_OUTCOMES = [];
{
  const anchorMs = ANCHOR_SEC * 1000;
  const DAY_MS = 86_400_000;
  const daysAgo = (days, hours = 0) => anchorMs - days * DAY_MS - hours * 3_600_000;
  const add = (row) => {
    const key = row.suggestion_key ?? '';
    HANDBACK_OUTCOMES.push({
      id: HANDBACK_OUTCOMES.length + 1,
      project_id: row.project_id ?? 1,
      kind: row.kind,
      subject_type: row.subject_type,
      subject_id: row.subject_id,
      suggestion_key: key,
      outcome: row.outcome,
      channel: row.channel ?? 'inferred',
      actor_user_id: null,
      actor_api_key_id: null,
      run_id: null,
      commit_sha: row.commit_sha ?? null,
      details: row.details ?? null,
      dedupe_key: [row.kind, `${row.subject_type}:${row.subject_id}`, key, row.outcome, ''].join('|'),
      created_at: Math.round(row.at),
    });
  };

  // Locator heals: 12 call sites given a replacement, 8 of them now use it, 6 passed since.
  const shopCases = TEST_CASES.filter((c) => c.project_id === 1).slice(0, 12);
  shopCases.forEach((testCase, i) => {
    const key = `heal-${i + 1}`;
    const details = {
      location: `${testCase.file_path}:${20 + i}:5`,
      failingLocator: "getByRole('button', { name: 'Submit' })",
      recommendedLocator: "getByRole('button', { name: 'Place order' })",
      recommendedSig: `demo-sig-${i + 1}`,
      failingRunId: 0,
    };
    const base = 24 - i * 2;
    add({
      kind: 'locator-heal',
      subject_type: 'test-case',
      subject_id: testCase.id,
      suggestion_key: key,
      outcome: 'suggested',
      details,
      at: daysAgo(base),
    });
    if (i < 8) {
      add({
        kind: 'locator-heal',
        subject_type: 'test-case',
        subject_id: testCase.id,
        suggestion_key: key,
        outcome: 'applied',
        details: { ...details, label: 'matched-recommendation' },
        at: daysAgo(base - 1),
      });
    }
    if (i < 6) {
      add({
        kind: 'locator-heal',
        subject_type: 'test-case',
        subject_id: testCase.id,
        suggestion_key: key,
        outcome: 'verified',
        details,
        at: daysAgo(base - 1, -6),
      });
    }
  });

  // Auto-heal pull requests: 5 opened, 3 merged (2 verified on main since), 1 closed.
  for (let n = 1; n <= 5; n++) {
    const details = { prNumber: 40 + n, testCaseIds: [shopCases[n - 1].id] };
    const key = `heal:v1:1:demo-${n}`;
    add({
      kind: 'auto-heal-pr',
      subject_type: 'heal-action',
      subject_id: n,
      suggestion_key: key,
      outcome: 'suggested',
      details,
      at: daysAgo(22 - n * 3),
    });
    if (n <= 3)
      add({
        kind: 'auto-heal-pr',
        subject_type: 'heal-action',
        subject_id: n,
        suggestion_key: key,
        outcome: 'applied',
        details,
        at: daysAgo(21 - n * 3),
      });
    if (n <= 2)
      add({
        kind: 'auto-heal-pr',
        subject_type: 'heal-action',
        subject_id: n,
        suggestion_key: key,
        outcome: 'verified',
        details,
        at: daysAgo(20 - n * 3),
      });
    if (n === 4)
      add({
        kind: 'auto-heal-pr',
        subject_type: 'heal-action',
        subject_id: n,
        suggestion_key: key,
        outcome: 'rejected',
        details,
        at: daysAgo(8),
      });
  }

  // Diagnoses: the fixes of clusters 1 and 10 changed the files their diagnosis
  // named; cluster 1 then failed again.
  for (const clusterId of [1, 10]) {
    const cluster = FAILURE_CLUSTERS.find((c) => c.id === clusterId);
    const diagnosis = FAILURE_DIAGNOSES.find((d) => d.cluster_id === clusterId);
    const details = { diagnosisId: diagnosis.id, provider: diagnosis.provider, model: diagnosis.model };
    // The live key carries the version's start time, which the rebase would leave stale here.
    const key = `${diagnosis.id}@demo`;
    add({
      kind: 'diagnosis',
      subject_type: 'cluster',
      subject_id: clusterId,
      suggestion_key: key,
      outcome: 'verified',
      commit_sha: cluster.fix_commit,
      details,
      at: cluster.fix_landed_at * 1000,
    });
    if (cluster.fix_verification === 'regressed') {
      add({
        kind: 'diagnosis',
        subject_type: 'cluster',
        subject_id: clusterId,
        suggestion_key: key,
        outcome: 'regressed',
        details,
        at: cluster.updated_at * 1000,
      });
    }
  }

  // The gate: 6 failed evaluations; the pull request of the third was merged
  // anyway, and the failure it caught came back on main.
  for (let n = 1; n <= 6; n++) {
    const details = { prNumber: 60 + n, verdict: 'failed', rules: ['maxNewFailures'] };
    add({
      kind: 'gate',
      subject_type: 'gate-evaluation',
      subject_id: n,
      outcome: 'suggested',
      details,
      at: daysAgo(26 - n * 4),
    });
    if (n === 3) {
      add({
        kind: 'gate',
        subject_type: 'gate-evaluation',
        subject_id: n,
        outcome: 'rejected',
        details,
        at: daysAgo(13),
      });
      add({
        kind: 'gate',
        subject_type: 'gate-evaluation',
        subject_id: n,
        outcome: 'regressed',
        details: { ...details, clusterId: 1 },
        at: daysAgo(11),
      });
    }
  }

  // Flake Lab: a verify run proved one flaky test fixed (not the one whose flake the lab reproduced).
  const verifiedFlake = TEST_CASES.filter((c) => c.project_id === 1 && c.id !== FLAKE_DEMO.caseId).at(-1);
  add({
    kind: 'flake-verify',
    subject_type: 'test-case',
    subject_id: verifiedFlake.id,
    suggestion_key: 'verify-1',
    outcome: 'verified',
    channel: 'cli',
    at: daysAgo(6),
  });
}

// Ratings on the diagnoses, and earlier versions of them, so the AI usage
// panel has a helpful share over enough ratings, and one version an agent
// recorded with the model it ran on.
{
  const RATINGS = { 1: 'up', 3: 'up', 6: 'down', 7: 'up', 10: 'up' };
  for (const d of FAILURE_DIAGNOSES) d.feedback = RATINGS[d.cluster_id] ?? null;
  FAILURE_DIAGNOSIS_VERSIONS[0].feedback = 'down';
  const stalePatch = {
    status: 'stale-file',
    filesChecked: 1,
    filesInPatch: 1,
    errors: ['The file changed since the diagnosis was written.'],
  };
  const EARLIER = [
    { clusterId: 3, minutes: -720, feedback: 'up', patch: appliesPatch },
    { clusterId: 3, minutes: -1440, feedback: 'down', patch: stalePatch },
    { clusterId: 6, minutes: -600, feedback: 'down', patch: stalePatch },
    { clusterId: 7, minutes: -480, feedback: 'up', patch: appliesPatch },
    { clusterId: 7, minutes: -960, feedback: 'up', patch: appliesPatch },
    { clusterId: 10, minutes: -300, feedback: 'up', patch: appliesPatch },
    { clusterId: 10, minutes: -900, feedback: null, patch: null },
  ];
  for (const v of EARLIER) {
    const current = FAILURE_DIAGNOSES.find((d) => d.cluster_id === v.clusterId);
    FAILURE_DIAGNOSIS_VERSIONS.push({
      id: FAILURE_DIAGNOSIS_VERSIONS.length + 1,
      diagnosis_id: current.id,
      cluster_id: v.clusterId,
      scope: 'cluster',
      test_runs_case_id: null,
      status: 'completed',
      provider: 'demo',
      model: 'demo-simulated',
      category: current.category,
      confidence: 'medium',
      summary: `Earlier take: ${current.summary}`,
      root_cause: current.root_cause,
      details: JSON.stringify({ ...JSON.parse(current.details), patchValidation: v.patch }),
      error: null,
      input_tokens: 900,
      output_tokens: 260,
      duration_ms: 2100,
      context_sha: null,
      feedback: v.feedback,
      created_at: diagnosisTs(v.clusterId, v.minutes),
    });
  }
  const agentBase = FAILURE_DIAGNOSES.find((d) => d.cluster_id === 3);
  const agentDetails = JSON.parse(agentBase.details);
  FAILURE_DIAGNOSIS_VERSIONS.push({
    id: FAILURE_DIAGNOSIS_VERSIONS.length + 1,
    diagnosis_id: agentBase.id,
    cluster_id: 3,
    scope: 'cluster',
    test_runs_case_id: null,
    status: 'completed',
    provider: 'agent',
    model: 'demo-agent',
    category: agentBase.category,
    confidence: 'high',
    summary: `Recorded by an agent: ${agentBase.summary}`,
    root_cause: agentBase.root_cause,
    details: JSON.stringify({
      ...agentDetails,
      patchValidation: undefined,
      suggestedFix: { ...agentDetails.suggestedFix, patchValidation: appliesPatch },
      recordedBy: { channel: 'mcp', userId: null, apiKeyId: null },
    }),
    error: null,
    input_tokens: null,
    output_tokens: null,
    duration_ms: null,
    context_sha: null,
    feedback: 'up',
    created_at: diagnosisTs(3, -200),
  });
}

// ── Flake-lab experiment (rng-free) ─────────────────────────────────────────
// Two days before the anchor, someone ran `piwi flake` on the checkout
// project's flaky test: the control stayed clean in 10 runs and delaying
// `GET /api/cart` to the failures' median reproduced it 3 times in 4. The arm
// carries the suspect id the flake profile gives the slow cart, so the
// Flakiness tab shows "reproduced 3/4" on that suspect and the flaky list its
// badge. The p-value is the one-sided Fisher exact test of 3/4 against 0/10.
const FLAKE_EXPERIMENTS = [];
const FLAKE_ARMS = [];
{
  const sorted = [...FLAKE_DEMO.failedCartMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const delayMs = Math.round(medianMs / 100) * 100;
  const route = 'GET /api/cart';
  const finishedAt = ANCHOR_SEC * 1000 - 2 * 24 * 60 * 60 * 1000;
  FLAKE_EXPERIMENTS.push({
    id: 1,
    project_id: 1,
    test_case_id: FLAKE_DEMO.caseId,
    kind: 'reproduce',
    commit_sha: FLAKE_DEMO.failureCommit,
    failure_commit_sha: FLAKE_DEMO.failureCommit,
    source: 'cli',
    machine: 'dev-laptop',
    playwright_project: 'chromium',
    verdict: 'reproduced',
    reproducing_arm_id: 2,
    verifies_arm_id: null,
    created_at: finishedAt - 3 * 60 * 1000,
    finished_at: finishedAt,
  });
  const arm = (id, position, fields) => ({
    id,
    experiment_id: 1,
    position,
    discarded_rounds: 0,
    other_failures: 0,
    ...fields,
  });
  FLAKE_ARMS.push(
    arm(1, 0, {
      arm_key: 'control',
      suspect_id: null,
      label: 'control',
      conditions: [],
      runs: 10,
      matching_failures: 0,
      stopped_early: 0,
      p_value: null,
      verdict: null,
    }),
    arm(2, 1, {
      arm_key: 'suspect-1',
      suspect_id: `slow-route:${route}`,
      label: `delay ${route} ${Number((delayMs / 1000).toFixed(1))} s`,
      conditions: [{ kind: 'delay', route, ms: delayMs, match: 'all' }],
      runs: 4,
      matching_failures: 3,
      stopped_early: 1,
      p_value: 4 / 364,
      verdict: 'reproduced',
    }),
  );
}

// ── Flake-lab experiments that verify a fix (rng-free) ──────────────────────
// Hours after the pagination test's last flake, the desktop app's "Reproduce
// this flake" delayed each suspect to its failures' median: the rows delay
// reproduced it 3 times in 5 against a clean control (p = 10/455, the one-sided
// Fisher exact test of 3/5 against 0/10), while the count delay failed once
// with the same error and twice with another (p = 10/20), so the count is ruled
// out. A first fix still failed its verify rerun; the second held for the 5
// runs a 3-in-5 rate needs, after the test's last retry-pass, so the test reads
// verified fixed, leaves the flaky ranking and its quarantine is proposed for release.
const FLAKE_FIX_COMMITS = {
  first: 'd1ce0f7a3b9e2c4d6f8a0b1c2d3e4f5a6b7c8d9e',
  second: '9b1d4e6f2a7c3e5d8f0a1b2c3d4e5f6a7b8c9d0e',
};
{
  const medianMs = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const delayArm = (route, failedMs) => {
    const ms = Math.round(medianMs(failedMs) / 100) * 100;
    return {
      label: `delay ${route} ${Number((ms / 1000).toFixed(1))} s`,
      suspect_id: `slow-route:${route}`,
      conditions: [{ kind: 'delay', route, ms, match: 'all' }],
    };
  };
  const rows = delayArm('GET /api/table/rows', FLAKE_FIX_DEMO.failedRowsMs);
  const count = delayArm('GET /api/table/count', FLAKE_FIX_DEMO.failedCountMs);
  const hour = 60 * 60 * 1000;
  const after = (hours) => FLAKE_FIX_DEMO.lastFlakeMs + hours * hour;
  if (after(28) > ANCHOR_SEC * 1000) throw new Error('The verified-fix experiments would finish after the seed anchor');

  const experiment = (id, fields) => ({
    id,
    project_id: 3,
    test_case_id: FLAKE_FIX_DEMO.caseId,
    failure_commit_sha: FLAKE_FIX_DEMO.failureCommit,
    playwright_project: 'Chromium',
    ...fields,
  });
  const arm = (id, experimentId, position, fields) => ({
    id,
    experiment_id: experimentId,
    position,
    discarded_rounds: 0,
    other_failures: 0,
    stopped_early: 0,
    p_value: null,
    verdict: null,
    ...fields,
  });
  const control = (id, experimentId, runs) =>
    arm(id, experimentId, 0, {
      arm_key: 'control',
      suspect_id: null,
      label: 'control',
      conditions: [],
      runs,
      matching_failures: 0,
    });

  FLAKE_EXPERIMENTS.push(
    experiment(2, {
      kind: 'reproduce',
      commit_sha: FLAKE_FIX_DEMO.failureCommit,
      source: 'desktop',
      machine: 'design-laptop',
      verdict: 'reproduced',
      reproducing_arm_id: 4,
      verifies_arm_id: null,
      created_at: after(5),
      finished_at: after(5) + 6 * 60 * 1000,
    }),
    experiment(3, {
      kind: 'verify',
      commit_sha: FLAKE_FIX_COMMITS.first,
      source: 'cli',
      machine: 'design-laptop',
      verdict: 'still-fails',
      reproducing_arm_id: 7,
      verifies_arm_id: 4,
      created_at: after(22),
      finished_at: after(22) + 2 * 60 * 1000,
    }),
    experiment(4, {
      kind: 'verify',
      commit_sha: FLAKE_FIX_COMMITS.second,
      source: 'cli',
      machine: 'design-laptop',
      verdict: 'verified',
      reproducing_arm_id: 9,
      verifies_arm_id: 4,
      created_at: after(27),
      finished_at: after(27) + 3 * 60 * 1000,
    }),
  );
  FLAKE_ARMS.push(
    control(3, 2, 10),
    arm(4, 2, 1, {
      arm_key: 'suspect-1',
      ...rows,
      runs: 5,
      matching_failures: 3,
      stopped_early: 1,
      p_value: 10 / 455,
      verdict: 'reproduced',
    }),
    arm(5, 2, 2, {
      arm_key: 'suspect-2',
      ...count,
      runs: 10,
      matching_failures: 1,
      other_failures: 2,
      p_value: 10 / 20,
      verdict: 'not-reproduced',
    }),
    control(6, 3, 5),
    arm(7, 3, 1, {
      arm_key: 'verify',
      ...rows,
      runs: 2,
      matching_failures: 1,
      stopped_early: 1,
      verdict: 'still-fails',
    }),
    control(8, 4, 5),
    arm(9, 4, 1, {
      arm_key: 'verify',
      ...rows,
      runs: 5,
      matching_failures: 0,
      verdict: 'verified',
    }),
  );
}
// Delta between load time and the seed's anchor, computed by SQLite when the
// seed runs. Referenced from a temp table so every statement shares one value
// (a second-precision drift between statements would otherwise desync the ms
// columns from their JSON-embedded counterparts and skew the timeline).
const D = '(SELECT delta_sec FROM _rebase)';
const D_MS = `(SELECT delta_sec FROM _rebase) * 1000`;

// Shift a JSON array column's per-element ms timestamp (`$.field`) in place,
// preserving element order (json_each iterates in array order). Elements that
// carry no `$.field` (a did-not-run attempt's null `startedAt`) keep their
// value, so a shift never writes a null key. An untouched object goes through
// json(): SQLite 3.45 (libsql, which app:seed:dev and the server use) drops
// the JSON subtype of a bare `value` in a CASE branch, and json_group_array
// would then store the object as a quoted string.
const shiftJsonMs = (table, column, field) =>
  `UPDATE ${table} SET ${column} = (SELECT json_group_array(` +
  `CASE WHEN json_extract(value, '$.${field}') IS NOT NULL ` +
  `THEN json_set(value, '$.${field}', json_extract(value, '$.${field}') + ${D_MS}) ` +
  `WHEN type IN ('object', 'array') THEN json(value) ELSE value END) ` +
  `FROM json_each(${table}.${column})) ` +
  `WHERE ${column} IS NOT NULL AND json_valid(${column});`;

const REBASE_SQL = [
  '-- ── Rebase every timestamp to load time (see generator for rationale) ──────',
  `CREATE TEMP TABLE _rebase AS SELECT (CAST(strftime('%s', 'now') AS INTEGER) - ${ANCHOR_SEC}) AS delta_sec;`,
  '',
  '-- Second-precision timestamp columns',
  `UPDATE tags SET created_at = created_at + ${D}, updated_at = updated_at + ${D};`,
  `UPDATE projects SET created_at = created_at + ${D}, updated_at = updated_at + ${D};`,
  `UPDATE markers SET occurred_at = occurred_at + ${D}, created_at = created_at + ${D}, updated_at = updated_at + ${D};`,
  `UPDATE project_url_patterns SET created_at = created_at + ${D_MS}, updated_at = updated_at + ${D_MS};`,
  `UPDATE bug_reports SET created_at = created_at + ${D}, updated_at = updated_at + ${D};`,
  `UPDATE bug_reproductions SET created_at = created_at + ${D};`,
  `UPDATE users SET created_at = created_at + ${D}, updated_at = updated_at + ${D};`,
  `UPDATE app_settings SET updated_at = updated_at + ${D};`,
  `UPDATE test_selections SET created_at = created_at + ${D}, updated_at = updated_at + ${D};`,
  `UPDATE test_suites SET created_at = created_at + ${D}, updated_at = updated_at + ${D};`,
  `UPDATE test_cases SET created_at = created_at + ${D}, updated_at = updated_at + ${D};`,
  // kept_at is nullable; NULL + delta stays NULL.
  `UPDATE test_runs SET start_time = start_time + ${D}, created_at = created_at + ${D}, updated_at = updated_at + ${D}, kept_at = kept_at + ${D};`,
  `UPDATE files SET created_at = created_at + ${D};`,
  `UPDATE case_payloads SET created_at = created_at + ${D};`,
  `UPDATE coverage_fragments SET created_at = created_at + ${D}, last_seen_at = last_seen_at + ${D};`,
  // fix_landed_at is nullable; NULL + delta stays NULL, so no guard is needed.
  `UPDATE failure_clusters SET created_at = created_at + ${D}, updated_at = updated_at + ${D}, fix_landed_at = fix_landed_at + ${D};`,
  `UPDATE test_run_resource_reports SET updated_at = updated_at + ${D};`,
  `UPDATE resource_findings SET first_seen_at = first_seen_at + ${D}, last_seen_at = last_seen_at + ${D}, created_at = created_at + ${D}, updated_at = updated_at + ${D}, fixed_at = fixed_at + ${D};`,
  `UPDATE quarantined_tests SET created_at = created_at + ${D}, released_at = released_at + ${D};`,
  `UPDATE failure_diagnoses SET created_at = created_at + ${D}, updated_at = updated_at + ${D};`,
  `UPDATE failure_diagnosis_versions SET created_at = created_at + ${D};`,
  `UPDATE cluster_merge_suggestions SET created_at = created_at + ${D}, updated_at = updated_at + ${D};`,
  '',
  '-- Millisecond timestamp columns',
  `UPDATE test_runs_cases SET started_at = started_at + ${D_MS}, created_at = created_at + ${D_MS};`,
  `UPDATE network_requests SET start_time = start_time + ${D_MS};`,
  `UPDATE groups SET created_at = created_at + ${D_MS}, updated_at = updated_at + ${D_MS};`,
  `UPDATE group_members SET created_at = created_at + ${D_MS};`,
  `UPDATE role_bindings SET created_at = created_at + ${D_MS};`,
  `UPDATE analytics_dashboards SET created_at = created_at + ${D_MS}, updated_at = updated_at + ${D_MS}, last_viewed_at = last_viewed_at + ${D_MS};`,
  `UPDATE entity_links SET created_at = created_at + ${D_MS}, updated_at = updated_at + ${D_MS};`,
  `UPDATE locator_snapshots SET last_seen_at = last_seen_at + ${D_MS};`,
  `UPDATE handback_outcomes SET created_at = created_at + ${D_MS};`,
  `UPDATE code_reach SET last_seen_at = last_seen_at + ${D_MS};`,
  // Test Map tables are defined after ANCHOR_SEC is computed, so they add no
  // candidates to it; they are all stamped at BASE_START_MS, which the run
  // timestamps already bound. Nullable columns stay NULL.
  `UPDATE probes SET probed_at = probed_at + ${D_MS};`,
  `UPDATE flake_experiments SET created_at = created_at + ${D_MS}, finished_at = finished_at + ${D_MS};`,
  `UPDATE test_functions SET created_at = created_at + ${D_MS}, updated_at = updated_at + ${D_MS};`,
  `UPDATE graph_nodes SET last_seen_at = last_seen_at + ${D_MS}, created_at = created_at + ${D_MS}, pruned_at = pruned_at + ${D_MS};`,
  `UPDATE graph_edges SET last_seen_at = last_seen_at + ${D_MS}, created_at = created_at + ${D_MS};`,
  `UPDATE scenario_gaps SET created_at = created_at + ${D_MS}, updated_at = updated_at + ${D_MS}, accepted_at = accepted_at + ${D_MS}, covered_at = covered_at + ${D_MS}, closed_at = closed_at + ${D_MS}, snoozed_until = snoozed_until + ${D_MS};`,
  '',
  '-- ISO timestamps embedded in JSON columns',
  `UPDATE test_runs SET metadata = json_set(metadata, '$.incident.decidedAt', ` +
    `strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(metadata, '$.incident.decidedAt'), '+' || ${D} || ' seconds')) ` +
    `WHERE json_valid(metadata) AND json_extract(metadata, '$.incident.decidedAt') IS NOT NULL;`,
  '',
  '-- Millisecond timestamps embedded in JSON columns',
  shiftJsonMs('test_runs_cases', 'steps', 'startTime'),
  shiftJsonMs('test_runs_cases', 'step_events', 'startedAt'),
  shiftJsonMs('test_runs_cases', 'console_logs', 'timestamp'),
  shiftJsonMs('test_runs_cases', 'dialogs', 'closedAt'),
  shiftJsonMs('test_runs_cases', 'attempts', 'startedAt'),
  shiftJsonMs('network_requests', 'server_logs', 'timestamp'),
  `UPDATE test_run_resource_reports SET report = json_set(report, '$.timeline.startedAt', ` +
    `json_extract(report, '$.timeline.startedAt') + ${D_MS}) ` +
    `WHERE json_valid(report) AND json_extract(report, '$.timeline.startedAt') IS NOT NULL;`,
  '',
  'DROP TABLE _rebase;',
];

// ── Feature graph + scenario gaps ──────────────────────────────────────────
// A slice of the Test Map for the checkout project: a couple of observed nodes,
// their reaches edges, one pull-request-stamped run and the ranked gaps that
// fall out — enough for the gaps endpoints and the uncovered-changes section to
// render against real data.
const gapRun = TEST_RUNS.filter((r) => r.project_id === 1).reduce((a, b) => (b.id > a.id ? b : a));
gapRun.metadata.scm.remoteUrl = SCM_REPOS[1].repositoryUrl;
gapRun.metadata.scm.prNumber = 418;
gapRun.metadata.scm.baseBranch = SCM_REPOS[1].defaultBranch ?? 'main';

/** The function catalog: the web-dashboard model's page objects and helpers. */
const TEST_FUNCTIONS = [];
const GRAPH_NODES = [
  {
    project_id: 1,
    kind: 'route',
    key: 'POST /api/orders',
    attrs: null,
    origin: 'observed',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'route',
    key: 'GET /api/cart',
    attrs: null,
    origin: 'observed',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'page',
    key: '/checkout',
    attrs: { url: 'https://shop.demo/checkout' },
    origin: 'observed',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  // M2 breadth: a control no test targets, and a page linked but never visited.
  {
    project_id: 1,
    kind: 'control',
    key: 'button:Export invoices',
    attrs: { role: 'button' },
    origin: 'observed',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'page',
    key: '/billing/plans',
    attrs: { url: 'https://shop.demo/billing/plans' },
    origin: 'observed',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  // M3 declared surface: an OpenAPI-declared route with documented error codes
  // that no test reaches — a "declared, never hit" blind spot.
  {
    project_id: 1,
    kind: 'route',
    key: 'DELETE /api/orders/:id',
    attrs: { declared: true, responses: [200, 401, 404, 409] },
    origin: 'openapi',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  // M3 server probes: a handler and the dependency it calls — never probed.
  {
    project_id: 1,
    kind: 'handler',
    key: 'src/api/orders.post.ts',
    attrs: null,
    origin: 'observed',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'dependency',
    key: 'payments-svc',
    attrs: null,
    origin: 'observed',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  // Features, from the `piwi:feature` tag on the tests: the feature map draws
  // one circle per feature and links the ones sharing a node.
  {
    project_id: 1,
    kind: 'feature',
    key: 'Checkout',
    attrs: { source: 'tag' },
    origin: 'observed',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'feature',
    key: 'Billing',
    attrs: { source: 'tag' },
    origin: 'observed',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'feature',
    key: 'Orders',
    attrs: { source: 'tag' },
    origin: 'observed',
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
];

const GRAPH_EDGES = [
  {
    project_id: 1,
    from_kind: 'test',
    from_key: '1',
    to_kind: 'route',
    to_key: 'POST /api/orders',
    kind: 'reaches',
    confidence: 1,
    origin: 'observed',
    evidence: { method: 'POST', status: 201 },
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'test',
    from_key: '1',
    to_kind: 'route',
    to_key: 'GET /api/cart',
    kind: 'reaches',
    confidence: 1,
    origin: 'observed',
    evidence: { method: 'GET', status: 200 },
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'test',
    from_key: '2',
    to_kind: 'route',
    to_key: 'GET /api/cart',
    kind: 'reaches',
    confidence: 1,
    origin: 'observed',
    evidence: { method: 'GET', status: 200 },
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'test',
    from_key: '1',
    to_kind: 'page',
    to_key: '/checkout',
    kind: 'reaches',
    confidence: 1,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'commit',
    from_key: gapRun.metadata.scm.commit,
    to_kind: 'file',
    to_key: 'src/api/orders.post.ts',
    kind: 'changes',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'ticket',
    from_key: 'PROJ-418',
    to_kind: 'file',
    to_key: 'src/api/orders.post.ts',
    kind: 'changes',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  // M2 breadth edges: the checkout page contains a control nobody targets and
  // links to a page nobody visits, and a probe showed the order route unnoticed.
  {
    project_id: 1,
    from_kind: 'page',
    from_key: '/checkout',
    to_kind: 'control',
    to_key: 'button:Export invoices',
    kind: 'contains',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'page',
    from_key: '/checkout',
    to_kind: 'page',
    to_key: '/billing/plans',
    kind: 'links',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'test',
    from_key: '1',
    to_kind: 'route',
    to_key: 'POST /api/orders',
    kind: 'checks',
    confidence: 0,
    origin: 'observed',
    evidence: { fault: 'status-500', outcome: 'not-noticed', level: 'client' },
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  // M3 server probes: the order route is handled by a file that calls a
  // dependency no probe has ever checked — an unprobed-dependency gap.
  {
    project_id: 1,
    from_kind: 'route',
    from_key: 'POST /api/orders',
    to_kind: 'handler',
    to_key: 'src/api/orders.post.ts',
    kind: 'handled-by',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'handler',
    from_key: 'src/api/orders.post.ts',
    to_kind: 'dependency',
    to_key: 'payments-svc',
    kind: 'calls',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  // Feature → node groups edges. Checkout and Orders share the order route,
  // Checkout and Billing share the cart route, so the feature map links them.
  {
    project_id: 1,
    from_kind: 'feature',
    from_key: 'Checkout',
    to_kind: 'route',
    to_key: 'POST /api/orders',
    kind: 'groups',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'feature',
    from_key: 'Checkout',
    to_kind: 'route',
    to_key: 'GET /api/cart',
    kind: 'groups',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'feature',
    from_key: 'Checkout',
    to_kind: 'page',
    to_key: '/checkout',
    kind: 'groups',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'feature',
    from_key: 'Billing',
    to_kind: 'page',
    to_key: '/billing/plans',
    kind: 'groups',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'feature',
    from_key: 'Billing',
    to_kind: 'control',
    to_key: 'button:Export invoices',
    kind: 'groups',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'feature',
    from_key: 'Billing',
    to_kind: 'route',
    to_key: 'GET /api/cart',
    kind: 'groups',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'feature',
    from_key: 'Orders',
    to_kind: 'route',
    to_key: 'DELETE /api/orders/:id',
    kind: 'groups',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
  {
    project_id: 1,
    from_kind: 'feature',
    from_key: 'Orders',
    to_kind: 'route',
    to_key: 'POST /api/orders',
    kind: 'groups',
    confidence: null,
    origin: 'observed',
    evidence: null,
    first_seen_run_id: gapRun.id,
    last_seen_run_id: gapRun.id,
    last_seen_at: BASE_START_MS,
    created_at: BASE_START_MS,
  },
];

// One probe outcome behind the not-noticed checks edge, for the probe ledger.
const PROBES = [
  {
    project_id: 1,
    test_case_id: 1,
    node_id: null,
    route_key: 'POST /api/orders',
    level: 'client',
    fault: 'status-500',
    applied: 1,
    outcome: 'not-noticed',
    handled: 'n/a',
    run_id: gapRun.id,
    evidence: { mutation: 'status-500' },
    probed_at: BASE_START_MS,
  },
];

const SCENARIO_GAPS = [
  {
    project_id: 1,
    kind: 'gap',
    detector: 'declared-never-hit',
    class: 'blind-spot',
    key: 'route:DELETE /api/orders/:id',
    title: 'Declared route DELETE /api/orders/:id — never reached',
    evidence: ['Declared in OpenAPI · 0 tests in 30 runs · documents 200, 401, 404, 409 — observed reach.'],
    factors: { churn: 0.4, age: 0.5, escapeHistory: 0.1, priority: 0.4 },
    status: 'open',
    created_at: BASE_START_MS,
    updated_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'finding',
    detector: 'not-handled',
    class: 'unhandled',
    key: 'dependency:payments-svc @ POST /api/orders',
    title: 'payments-svc (via POST /api/orders): unhandled failure',
    evidence: [
      'A server probe made payments-svc (via POST /api/orders) fail; the application did not handle it (should complete checkout with credit card) — an error-state scenario is missing.',
    ],
    factors: { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.3 },
    score: 0.3,
    test_case_id: 1,
    status: 'open',
    created_at: BASE_START_MS,
    updated_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'gap',
    detector: 'unprobed-dependency',
    class: 'false-comfort',
    key: 'dependency:payments-svc',
    title: 'payments-svc is never probed',
    evidence: ['Called by 1 route · no probe has checked what happens when it fails — schedule a dependency probe.'],
    factors: { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.1 },
    status: 'open',
    created_at: BASE_START_MS,
    updated_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'gap',
    detector: 'changed-unreached',
    class: 'blind-spot',
    key: 'src/api/orders.post.ts',
    title: 'src/api/orders.post.ts changed but not reached',
    evidence: [`+41 −3 · no test in run #${gapRun.id} · 0 in 30 runs — observed reach.`],
    factors: { churn: 0.9, age: 0.8, escapeHistory: 1, priority: 0.7 },
    ticket: 'PROJ-418',
    test_run_id: gapRun.id,
    pr_number: 418,
    status: 'open',
    created_at: BASE_START_MS,
    updated_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'gap',
    detector: 'single-covering-test',
    class: 'fragile',
    key: 'route:POST /api/orders',
    title: 'Only one test reaches route POST /api/orders',
    evidence: [
      'Only should complete checkout with credit card reaches this — observed reach. A second scenario would make it resilient.',
    ],
    factors: { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.4 },
    test_case_id: 1,
    status: 'open',
    created_at: BASE_START_MS,
    updated_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'gap',
    detector: 'success-only',
    class: 'blind-spot',
    key: 'GET /api/cart',
    title: 'GET /api/cart: no error path under test',
    evidence: ['Observed 412 times over the last 30 runs, always 200 — observed reach, no error path exercised.'],
    factors: { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.1 },
    status: 'open',
    created_at: BASE_START_MS,
    updated_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'gap',
    detector: 'not-noticed',
    class: 'false-comfort',
    key: 'route:POST /api/orders',
    title: 'Tests pass when POST /api/orders breaks',
    evidence: [
      'A probe (status-500) on POST /api/orders did not make any test fail — assert the effect the request should have.',
    ],
    factors: { churn: 0.9, age: 0.8, escapeHistory: 1, priority: 0.7 },
    status: 'open',
    created_at: BASE_START_MS,
    updated_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'gap',
    detector: 'control-nobody-exercises',
    class: 'blind-spot',
    key: 'control:button:Export invoices',
    title: 'No test exercises control button:Export invoices',
    evidence: ['On 1 page · no locator targets it — observed reach.'],
    factors: { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.1 },
    status: 'open',
    created_at: BASE_START_MS,
    updated_at: BASE_START_MS,
  },
  {
    project_id: 1,
    kind: 'gap',
    detector: 'reachable-unvisited',
    class: 'blind-spot',
    key: 'page:/billing/plans',
    title: '/billing/plans is linked but never visited',
    evidence: ['Linked from 1 page · never navigated to — observed reach.'],
    factors: { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.1 },
    status: 'open',
    created_at: BASE_START_MS,
    updated_at: BASE_START_MS,
  },
  {
    // Accepted ten days before the gap run but no test was written — past the
    // one-week cutoff of the Home "accepted gaps not yet written" inbox queue.
    // Its subject route has no reaches edge, so it stays in the queue until the
    // test lands.
    project_id: 1,
    kind: 'gap',
    detector: 'single-covering-test',
    class: 'fragile',
    key: 'route:GET /api/orders/:id/receipt',
    title: 'Only one test reaches route GET /api/orders/:id/receipt',
    evidence: ['Only views an order receipt reaches this — observed reach. A second scenario would make it resilient.'],
    factors: { churn: 0.3, age: 0.4, escapeHistory: 0.1, priority: 0.4 },
    status: 'accepted',
    accepted_at: BASE_START_MS - 10 * 86_400_000,
    created_at: BASE_START_MS - 12 * 86_400_000,
    updated_at: BASE_START_MS - 10 * 86_400_000,
  },
];

// A gap's score as the detectors rank it (`scoreGap` in shared/handlers/scenario-gaps.ts):
// the detector's confidence × the geometric mean of the four exposure factors. A finding
// keeps its own score, severity × exposure.
const SEEDED_GAP_CONFIDENCE = {
  'declared-never-hit': 0.7,
  'unprobed-dependency': 0.4,
  'changed-unreached': 0.9,
  'single-covering-test': 0.5,
  'success-only': 1,
  'not-noticed': 0.8,
  'control-nobody-exercises': 0.4,
  'reachable-unvisited': 0.5,
};
for (const gap of SCENARIO_GAPS) {
  if (gap.kind !== 'gap') continue;
  const { churn, age, escapeHistory, priority } = gap.factors;
  const exposure = Math.pow(churn * age * escapeHistory * priority, 1 / 4);
  gap.score = Math.round(SEEDED_GAP_CONFIDENCE[gap.detector] * exposure * 10000) / 10000;
}

// The web-dashboard Test Map: a whole admin console against a ten-test suite, from
// the model in shared/demo/demo-test-map.mjs.
{
  const proj = DEMO_PROJECTS.find((p) => p.id === WEB_DASHBOARD_PROJECT_ID);
  const caseIds = new Map(proj.cases.map((c) => [c.title, caseIdByKey.get(`${proj.id}\x00${c.file}\x00${c.title}`)]));
  const features = new Map(proj.cases.map((c, i) => [c.title, demoTestMeta(c.file, i)?.feature ?? null]));
  const runIds = TEST_RUNS.filter((r) => r.project_id === proj.id)
    .map((r) => r.id)
    .sort((a, b) => a - b);
  const map = buildWebDashboardTestMap({ caseIds, runIds, features, at: BASE_START_MS });
  GRAPH_NODES.push(...map.nodes);
  GRAPH_EDGES.push(...map.edges);
  PROBES.push(...map.probes);
  SCENARIO_GAPS.push(...map.gaps);
  TEST_FUNCTIONS.push(...map.functions);
}

// The v2.4.0 release marker, linked to the run it keeps.
const releaseRun = TEST_RUNS.find((r) => r.keep_source === 'marker');
const RELEASE_MARKERS = releaseRun
  ? [
      {
        id: MARKERS.length + 1,
        project_id: releaseRun.project_id,
        occurred_at: releaseRun.start_time,
        label: releaseRun.keep_reason,
        description: 'Tagged and shipped from this run.',
        category: 'release',
        environment: null,
        source: 'manual',
        run_id: releaseRun.id,
        created_at: releaseRun.start_time,
        updated_at: releaseRun.start_time,
      },
    ]
  : [];

// Two earlier checkout releases, so the release-cycle periods have cycles to
// resolve: v2.2.0 and v2.3.0 on older checkout runs (the runs go newest first).
const checkoutRuns = TEST_RUNS.filter((r) => r.project_id === 1);
const EARLIER_RELEASES = [
  { index: 15, label: 'v2.2.0' },
  { index: 7, label: 'v2.3.0' },
]
  .filter(({ index }) => checkoutRuns[index])
  .map(({ index, label }, i) => ({
    id: MARKERS.length + RELEASE_MARKERS.length + i + 1,
    project_id: 1,
    occurred_at: checkoutRuns[index].start_time,
    label,
    description: 'Tagged and shipped.',
    category: 'release',
    environment: null,
    source: 'manual',
    run_id: null,
    created_at: checkoutRuns[index].start_time,
    updated_at: checkoutRuns[index].start_time,
  }));

// ── Test selections ─────────────────────────────────────────────────────────
// A `smoke` selection in every project (the first test of each spec file
// carries the tag), so a test filter by selection key resolves across projects.
const SELECTIONS = PROJECTS.map((project, i) => ({
  id: i + 1,
  project_id: project.id,
  key: 'smoke',
  name: 'Smoke tests',
  description: 'The first test of every spec file, tagged @smoke.',
  definition: JSON.stringify({ include: [{ tags: ['smoke'] }] }),
  version: 1,
  created_by: 1,
  created_at: ts('2025-04-01T09:00:00Z'),
  updated_at: ts('2025-04-01T09:00:00Z'),
}));

// ── Saved dashboards ────────────────────────────────────────────────────────
// A shared checkout dashboard over the smoke tests and a two-week sprint, and a
// private one breaking wasted CI minutes down by browser. Definitions follow
// `DashboardDefinition` (shared/analytics/dashboards.ts); a sprint period is a
// cadence from its start date, so it needs no rebase.
const DASHBOARD_SCOPE = {
  comparison: { kind: 'previous' },
  granularity: 'auto',
  defaultBranchOnly: true,
  fullRunsOnly: true,
};
const SAVED_DASHBOARDS = [
  {
    id: 1,
    name: 'Checkout team',
    description: 'The checkout smoke tests, sprint by sprint.',
    owner_id: 1,
    visibility: 'shared',
    definition: JSON.stringify({
      v: 1,
      scope: {
        ...DASHBOARD_SCOPE,
        period: { kind: 'sprint', offset: 0, start: '2025-01-06', lengthDays: 14 },
        comparison: { kind: 'previous-unit' },
        projectIds: [1],
        selection: 'smoke',
      },
      bands: [
        {
          title: 'This sprint',
          description: 'The smoke tests of the checkout suite against the previous sprint.',
          widgets: [
            {
              key: 'headline',
              type: 'stats',
              size: 'full',
              options: { metrics: ['test-pass-rate', 'flaky-tests', 'wasted-ci-minutes', 'open-failure-causes'] },
            },
            {
              key: 'pass-rate',
              type: 'metric',
              size: 'full',
              title: 'Smoke pass rate',
              options: { metric: 'test-pass-rate', display: 'line' },
            },
            { key: 'flaky', type: 'list', size: 'half', options: { source: 'flaky-tests', limit: 5 } },
            { key: 'releases', type: 'markers', size: 'half', options: { categories: ['release', 'deploy'] } },
          ],
        },
        {
          title: 'Notes',
          widgets: [
            {
              key: 'note',
              type: 'text',
              size: 'full',
              options: {
                markdown:
                  '**Sprint goal**: keep the smoke tests green on `main`.\n\n- Payment provider rollout: watch the PayPal flow\n- Ask in #checkout-quality before quarantining a test',
              },
            },
          ],
        },
      ],
    }),
    created_at: BASE_START_MS - 10 * 24 * 60 * 60 * 1000,
    updated_at: BASE_START_MS - 2 * 24 * 60 * 60 * 1000,
    updated_by: 1,
    last_viewed_at: BASE_START_MS - 60 * 60 * 1000,
  },
  {
    id: 2,
    name: 'Wasted CI by browser',
    description: null,
    owner_id: 1,
    visibility: 'private',
    definition: JSON.stringify({
      v: 1,
      scope: { ...DASHBOARD_SCOPE, period: { kind: 'rolling', days: 30 } },
      bands: [
        {
          title: 'Where the minutes go',
          widgets: [
            {
              key: 'wasted-by-browser',
              type: 'metric',
              size: 'full',
              title: 'Wasted CI minutes by browser',
              options: { metric: 'wasted-ci-minutes', display: 'bar', breakdown: 'browser', top: 5 },
            },
            {
              key: 'wasted-by-project',
              type: 'metric',
              size: 'half',
              options: { metric: 'wasted-ci-minutes', display: 'table', breakdown: 'project' },
            },
            { key: 'wasted', type: 'wasted-time', size: 'half' },
          ],
        },
      ],
    }),
    created_at: BASE_START_MS - 5 * 24 * 60 * 60 * 1000,
    updated_at: BASE_START_MS - 5 * 24 * 60 * 60 * 1000,
    updated_by: 1,
    last_viewed_at: null,
  },
];

// ── Assemble SQL ───────────────────────────────────────────────────────────
const lines = [
  '-- Piwi Dashboard demo seed',
  '-- Generated by scripts/generate-demo-seed.mjs',
  `-- Generated at: ${new Date().toISOString()}`,
  '',
  'PRAGMA journal_mode = WAL;',
  '',
  SCHEMA,
  '',
  'BEGIN TRANSACTION;',
  '',
  '-- Tags',
  insert('tags', TAGS),
  '',
  '-- Projects',
  insert('projects', PROJECTS),
  '',
  '-- Users (demo identities for the "act as" switcher)',
  insert('users', USERS),
  '',
  '-- Groups and role bindings (who holds which project role)',
  insert('groups', GROUPS),
  insert('group_members', GROUP_MEMBERS),
  insert('role_bindings', ROLE_BINDINGS),
  '',
  '-- App settings (the `ai` key marks the demo provider as configured)',
  insert('app_settings', APP_SETTINGS),
  '',
  '-- Project-tag associations',
  insert('project_tags', PROJECT_TAGS),
  '',
  '-- Project URL patterns (browser extension)',
  insert('project_url_patterns', PROJECT_URL_PATTERNS),
  '',
  '-- Bug reports (Piwi Picker)',
  insert('bug_reports', BUG_REPORTS),
  insert('bug_reproductions', BUG_REPRODUCTIONS),
  '',
  '-- Timeline markers',
  insert('markers', MARKERS),
  '',
  '-- Test suites',
  insert('test_suites', TEST_SUITES),
  '',
  '-- Test cases',
  insert('test_cases', TEST_CASES),
  '',
  '-- Test runs',
  insert('test_runs', TEST_RUNS),
  '',
  '-- Release markers linked to a run (they keep that run forever)',
  insert('markers', RELEASE_MARKERS),
  insert('markers', EARLIER_RELEASES),
  insert(
    'markers',
    INCIDENT_MARKERS.map((m, i) => ({
      id: MARKERS.length + RELEASE_MARKERS.length + EARLIER_RELEASES.length + i + 1,
      ...m,
    })),
  ),
  '',
  '-- Test selections',
  insert('test_selections', SELECTIONS),
  '',
  '-- Saved dashboards',
  insert('analytics_dashboards', SAVED_DASHBOARDS),
  '',
  '-- Files (reports)',
  insert('files', REPORTS),
  '',
  '-- Failure clusters',
  insert('failure_clusters', FAILURE_CLUSTERS),
  '',
  '-- Demo AI diagnoses',
  insert('failure_diagnoses', FAILURE_DIAGNOSES),
  '',
  '-- Demo merge suggestions (reference failure_clusters)',
  insert('cluster_merge_suggestions', MERGE_SUGGESTIONS),
  '',
  '-- Diagnosis version history (references failure_diagnoses + failure_clusters)',
  insert('failure_diagnosis_versions', FAILURE_DIAGNOSIS_VERSIONS),
  '',
  '-- Hand-back outcomes (references projects)',
  insert('handback_outcomes', HANDBACK_OUTCOMES),
  '',
  '-- Content-addressed case payloads (referenced by test_runs_cases, so must come first)',
  insert('case_payloads', CASE_PAYLOADS),
  '',
  '-- Coverage fragments (the files an execution coverage payload names)',
  insert('coverage_fragments', COVERAGE_FRAGMENTS),
  '',
  '-- Test run cases',
  insert('test_runs_cases', TEST_RUNS_CASES),
  '',
  '-- Files (screenshot/trace/video attachments — reference test_runs_cases, so must come after)',
  insert('files', ATTACHMENTS),
  '',
  '-- Entity links (may reference test_runs_cases, so must come after)',
  insert('entity_links', ENTITY_LINKS),
  '',
  '-- Network requests (child table, references test_runs_cases)',
  insert('network_requests', NETWORK_REQUESTS),
  '',
  '-- Quarantined tests (references test_cases)',
  insert('quarantined_tests', QUARANTINED_TESTS),
  '',
  '-- Locator healing snapshots (references test_cases)',
  insert('locator_snapshots', LOCATOR_SNAPSHOTS),
  '',
  '-- Code reach (references test_cases and test_runs)',
  insert('code_reach', CODE_REACH),
  '',
  '-- Probe ledger (Test Map, checked axis)',
  insert('probes', PROBES),
  '',
  '-- Flake-lab experiments and their arms (references test_cases)',
  insert('flake_experiments', FLAKE_EXPERIMENTS),
  insert('flake_arms', FLAKE_ARMS),
  insert('test_run_resource_reports', TEST_RUN_RESOURCE_REPORTS),
  insert('resource_findings', RESOURCE_FINDINGS),
  insert('resource_occurrences', RESOURCE_OCCURRENCES),
  '',
  '-- Function catalog (page-object methods and helpers the suite owns)',
  insert('test_functions', TEST_FUNCTIONS),
  '',
  '-- Feature graph nodes (Test Map)',
  insert('graph_nodes', GRAPH_NODES),
  '',
  '-- Feature graph edges (references nothing by FK; endpoints are typed keys)',
  insert('graph_edges', GRAPH_EDGES),
  '',
  '-- Scenario gaps (references test_cases; test_run_id is not an FK)',
  insert('scenario_gaps', SCENARIO_GAPS),
  '',
  ...REBASE_SQL,
  '',
  'COMMIT;',
];

// Compute the hash from all lines *excluding* the timestamp comment so that
// identical data produces the same hash even across regenerations.  Without
// this, the "New demo data" staleness indicator always appears because every
// `app:seed:demo` run changes the timestamp comment.
const hashLines = lines.filter((l) => !l.startsWith('-- Generated at:'));
const content = hashLines.join('\n');
const hash = createHash('sha256').update(content, 'utf-8').digest('hex');

const versionInfo = { hash, generatedAt: new Date().toISOString() };
const VERSION_OUTPUT = join(OUTPUT_DIR, 'seed.version.json');

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(OUTPUT, content, 'utf-8');
writeFileSync(VERSION_OUTPUT, JSON.stringify(versionInfo, null, 2) + '\n', 'utf-8');

console.log(`✅  Demo seed written to ${OUTPUT}`);
console.log(`✅  Version file written to ${VERSION_OUTPUT}`);
console.log(`   Hash       : ${hash}`);
console.log(`   Projects   : ${PROJECTS.length}`);
console.log(`   Users      : ${USERS.length}`);
console.log(`   Groups     : ${GROUPS.length}`);
console.log(`   Bindings   : ${ROLE_BINDINGS.length}`);
console.log(`   Tags       : ${TAGS.length}`);
console.log(`   Suites     : ${TEST_SUITES.length}`);
console.log(`   TestCases  : ${TEST_CASES.length}`);
console.log(`   TestRuns   : ${TEST_RUNS.length}`);
console.log(`   TRC rows   : ${TEST_RUNS_CASES.length}`);
console.log(`   NR rows    : ${NETWORK_REQUESTS.length}`);
console.log(`   Reports    : ${REPORTS.length}`);
console.log(`   Attachments: ${ATTACHMENTS.length}`);
console.log(`   Clusters   : ${FAILURE_CLUSTERS.length}`);
console.log(`   Diagnoses  : ${FAILURE_DIAGNOSES.length}`);
console.log(`   DiagVersions: ${FAILURE_DIAGNOSIS_VERSIONS.length}`);
console.log(`   Links      : ${ENTITY_LINKS.length}`);
console.log(`   LocatorSnap: ${LOCATOR_SNAPSHOTS.length}`);
console.log(`   CodeReach  : ${CODE_REACH.length}`);
console.log(`   CovFrags   : ${COVERAGE_FRAGMENTS.length}`);
