/**
 * The performance suite's dataset: a deterministic history shaped like a busy
 * self-hosted instance — one large project (a test suite reported ten times a
 * day for months, with flaky tests, failure clusters that open and close,
 * skipped and `fixme` tests, captured network requests and HTML reports) and a
 * handful of smaller ones for the project list.
 *
 * Every value is a pure function of the scale, the anchor time and the row's
 * indices, so two seeds of the same scale at the same anchor are identical.
 * Rows are yielded in batches, parents before children, as plain objects keyed
 * by column name; timestamps are `Date`s and JSON columns plain values, and the
 * writer turns them into each dialect's storage form.
 */
import { createHash } from 'node:crypto';

/** Bump when the shape of the data changes, so a cached seed is rebuilt. */
export const DATASET_VERSION = 2;

/**
 * Sizes. `large` matches the instance of the issue that started the suite
 * (1,500 runs, about 450,000 executions); `small` is for a quick local check.
 */
export const SCALES = {
  small: { runs: 80, tests: 60, networkRuns: 20, reportRuns: 30, sideProjects: 3, sideRuns: 12, sideTests: 20 },
  medium: { runs: 600, tests: 300, networkRuns: 60, reportRuns: 120, sideProjects: 8, sideRuns: 40, sideTests: 50 },
  large: { runs: 1500, tests: 300, networkRuns: 100, reportRuns: 200, sideProjects: 11, sideRuns: 60, sideTests: 60 },
};

/** The large project every page scenario opens. */
export const MAIN_PROJECT = { id: 1, name: 'checkout-web', label: 'Checkout web' };

const RUNS_PER_DAY = 10;
const WORKERS = 4;
const BATCH_ROWS = 2000;
const TESTS_PER_FILE = 8;
const BROWSER = { projectName: 'chromium', browserName: 'chromium' };

const AREAS = [
  'cart',
  'checkout',
  'payment',
  'account',
  'search',
  'catalog',
  'orders',
  'shipping',
  'promotions',
  'auth',
];
const VERBS = ['adds', 'removes', 'updates', 'shows', 'validates', 'applies', 'rejects', 'saves', 'filters', 'sorts'];
const OBJECTS = [
  'item',
  'coupon',
  'address',
  'card',
  'quantity',
  'order',
  'review',
  'wishlist entry',
  'gift card',
  'note',
];
const QUALIFIERS = [
  'for a guest',
  'for a signed-in user',
  'on mobile',
  'with an empty cart',
  'after a reload',
  'in a second tab',
  'with a slow network',
  'in French',
  'when stock runs out',
  'twice in a row',
];
const SIDE_PROJECTS = [
  'admin-console',
  'api-gateway',
  'billing-service',
  'design-system',
  'docs-site',
  'mobile-web',
  'partner-portal',
  'search-service',
  'storefront',
  'support-desk',
  'warehouse-ui',
];
const FEATURE_BRANCHES = Array.from({ length: 12 }, (_, i) => `feature/checkout-${101 + i}`);

/**
 * Failure stories: a cause that makes some tests fail for a stretch of runs.
 * `from`/`to` are fractions of the main project's history; a story still open
 * at the newest run shows as an open cluster.
 */
const STORIES = [
  [
    'timeout',
    "getByRole('button', { name: 'Place order' })",
    'Locator.click: Timeout 15000ms exceeded.',
    0.02,
    0.12,
    3,
  ],
  ['assertion', "getByTestId('cart-total')", 'expect(locator).toHaveText(expected) failed', 0.08, 0.2, 2],
  [
    'strict-mode',
    "getByRole('link', { name: 'Checkout' })",
    'strict mode violation: resolved to 2 elements',
    0.15,
    0.22,
    4,
  ],
  ['navigation', null, 'page.goto: net::ERR_CONNECTION_REFUSED at http://shop.local/checkout', 0.25, 0.27, 6],
  ['assertion', "getByText('Free shipping')", 'expect(locator).toBeVisible() failed', 0.3, 0.45, 2],
  ['timeout', "getByLabel('Card number')", 'Locator.fill: Timeout 10000ms exceeded.', 0.4, 0.5, 3],
  ['assertion', null, 'expect(received).toBe(expected) // Object.is equality: Expected 3, Received 2', 0.48, 0.55, 1],
  ['crash', null, 'Target page, context or browser has been closed', 0.52, 0.53, 5],
  [
    'timeout',
    "getByRole('dialog', { name: 'Confirm address' })",
    'expect(locator).toBeVisible() timed out',
    0.6,
    0.7,
    2,
  ],
  [
    'assertion',
    "getByTestId('order-status')",
    "expect(locator).toHaveText('Paid') failed: received 'Pending'",
    0.66,
    0.74,
    3,
  ],
  ['strict-mode', "getByRole('row', { name: /Total/ })", 'strict mode violation: resolved to 3 elements', 0.72, 0.8, 2],
  ['navigation', null, 'page.waitForURL: Timeout 30000ms exceeded waiting for **/confirmation', 0.78, 0.83, 4],
  ['assertion', "getByLabel('Promo code')", 'expect(locator).toHaveValue(expected) failed', 0.84, 0.9, 1],
  ['timeout', "getByRole('button', { name: 'Apply coupon' })", 'Locator.click: Timeout 5000ms exceeded.', 0.88, 1, 2],
  ['assertion', "getByTestId('tax-line')", "expect(locator).toContainText('VAT') failed", 0.93, 1, 3],
  ['crash', null, 'browserContext.newPage: Protocol error (Target.createTarget)', 0.97, 1, 1],
].map(([errorType, selector, message, from, to, tests], index) => ({
  index,
  errorType,
  selector,
  message,
  from,
  to,
  tests,
}));

/** Errors of the first attempt of a flaky test, one per flaky test (by index). */
const FLAKY_ERRORS = [
  "Locator.click: Timeout 5000ms exceeded waiting for getByRole('button', { name: 'Continue' })",
  'page.waitForResponse: Timeout 15000ms exceeded while waiting for /api/cart',
  "expect(locator).toHaveCount(expected) failed: expected 3, received 2 for getByTestId('cart-line')",
];

// ─── Deterministic randomness ────────────────────────────────────────────────

/** A uniform number in [0, 1) that depends only on its integer arguments. */
function rand(...keys) {
  let h = 0x811c9dc5;
  for (const k of keys) {
    h = Math.imul(h ^ (k & 0xffff), 0x01000193);
    h = Math.imul(h ^ (k >>> 16), 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const pick = (list, ...keys) => list[Math.floor(rand(...keys) * list.length)];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const hex = (n, ...keys) =>
  Array.from({ length: n }, (_, i) => Math.floor(rand(...keys, i) * 16).toString(16)).join('');

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** One project's tests and the role each plays in the history. */
function buildTests(projectIndex, count) {
  const tests = [];
  for (let t = 0; t < count; t++) {
    const file = Math.floor(t / TESTS_PER_FILE);
    const area = AREAS[file % AREAS.length];
    const describe = `${area[0].toUpperCase()}${area.slice(1)} ${Math.floor((t % TESTS_PER_FILE) / 4) === 0 ? 'basics' : 'edge cases'}`;
    const r = rand(projectIndex, t, 1);
    tests.push({
      index: t,
      filePath: `tests/${area}/${area}-${String(Math.floor(file / AREAS.length) + 1).padStart(2, '0')}.spec.ts`,
      describe,
      title: `${pick(VERBS, projectIndex, t, 2)} ${pick(OBJECTS, projectIndex, t, 3)} ${pick(QUALIFIERS, projectIndex, t, 4)}`,
      line: 12 + (t % TESTS_PER_FILE) * 17,
      // Mostly quick tests with a long tail of slow ones.
      baseDuration: Math.round(400 + 14_000 * r * r * r),
      kind: t % 50 === 7 ? 'skip' : t % 97 === 13 ? 'fixme' : t % 23 === 5 ? 'flaky' : 'normal',
      flakeRate: 0.02 + 0.12 * rand(projectIndex, t, 5),
      tags: t % 11 === 0 ? ['smoke'] : t % 17 === 0 ? ['critical', 'payments'] : null,
      owner: t % 5 === 0 ? `@team-${area}` : null,
      priority: t % 13 === 0 ? 'critical' : t % 7 === 0 ? 'high' : null,
    });
  }
  return tests;
}

/** Which tests each story makes fail, fixed per story. */
function storyTests(story, tests) {
  const eligible = tests.filter((t) => t.kind === 'normal');
  const chosen = new Set();
  for (let k = 0; chosen.size < Math.min(story.tests, eligible.length) && k < 1000; k++) {
    chosen.add(eligible[Math.floor(rand(900 + story.index, k) * eligible.length)].index);
  }
  return chosen;
}

function stepsFor(test, duration, keys) {
  const nav = Math.round(duration * 0.3);
  const act = Math.round(duration * 0.5);
  return [
    { title: `Navigate to "/${test.filePath.split('/')[1]}"`, category: 'pw:api', duration: nav },
    {
      title: `Click getByRole('button', { name: '${pick(['Add', 'Save', 'Continue', 'Apply'], ...keys)}' })`,
      category: 'pw:api',
      duration: act,
    },
    { title: 'expect(locator).toBeVisible()', category: 'expect', duration: Math.max(1, duration - nav - act) },
  ];
}

function errorText(message, selector, filePath, line) {
  const call = selector ? `\n\nCall log:\n  - waiting for ${selector}\n` : '\n';
  return `Error: ${message}${call}\n    at ${filePath}:${line + 6}:${11}`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// ─── The generator ───────────────────────────────────────────────────────────

/**
 * Yield `{ table, rows }` batches for `scale` anchored at `now`, parents first.
 * The last value, `{ manifest }`, names the entities the scenarios open.
 */
export function* datasetBatches({ scale = 'large', now = new Date() } = {}) {
  const size = SCALES[scale];
  if (!size) throw new Error(`unknown scale "${scale}" (expected ${Object.keys(SCALES).join(', ')})`);
  const anchor = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  const at = (ms) => new Date(ms);

  const ids = { suite: 0, testCase: 0, run: 0, execution: 0, network: 0, file: 0, payload: 0, cluster: 0 };
  const manifest = { scale, version: DATASET_VERSION, projectId: MAIN_PROJECT.id, counts: {} };
  const count = (table, n) => (manifest.counts[table] = (manifest.counts[table] ?? 0) + n);
  let pending = new Map();
  function* flush(force = false) {
    for (const [table, rows] of pending) {
      if (rows.length && (force || rows.length >= BATCH_ROWS)) {
        count(table, rows.length);
        yield { table, rows };
        pending.set(table, []);
      }
    }
  }
  const push = (table, row) => {
    if (!pending.has(table)) pending.set(table, []);
    pending.get(table).push(row);
  };

  // Projects, newest-updated first like a live instance.
  const projectDefs = [
    { ...MAIN_PROJECT, runs: size.runs, tests: size.tests, main: true },
    ...SIDE_PROJECTS.slice(0, size.sideProjects).map((name, i) => ({
      id: i + 2,
      name,
      label: null,
      runs: size.sideRuns,
      tests: size.sideTests,
      main: false,
    })),
  ];
  const historyStart = anchor - (size.runs / RUNS_PER_DAY) * 86_400_000;
  for (const p of projectDefs) {
    push('projects', {
      id: p.id,
      name: p.name,
      label: p.label,
      description: p.main ? 'End-to-end suite of the storefront checkout.' : null,
      default_branch: 'main',
      // The locator index is built at ingest; a stamp keeps startup from rebuilding it.
      locator_index_built_at: at(anchor),
      created_at: at(historyStart),
      updated_at: at(anchor - p.id * 60_000),
    });
  }
  const tagTexts = ['team-checkout', 'critical-path', 'nightly', 'smoke'];
  tagTexts.forEach((text, i) =>
    push('tags', {
      id: i + 1,
      text,
      color: ['primary', 'error', 'neutral', 'success'][i],
      created_at: at(historyStart),
      updated_at: at(historyStart),
    }),
  );
  push('project_tags', { project_id: MAIN_PROJECT.id, tag_id: 1 });
  push('project_tags', { project_id: MAIN_PROJECT.id, tag_id: 2 });
  for (const p of projectDefs.slice(1)) push('project_tags', { project_id: p.id, tag_id: 3 + (p.id % 2) });
  yield* flush(true);

  for (const project of projectDefs) {
    const pIndex = project.id;
    const tests = buildTests(pIndex, project.tests);
    const runs = project.runs;
    const interval = project.main ? 86_400_000 / RUNS_PER_DAY : (30 * 86_400_000) / runs;
    const firstStart = anchor - runs * interval;

    // Suites and test cases.
    const suiteIds = new Map();
    for (const t of tests) {
      const key = `${t.filePath}\u0000${t.describe}`;
      if (!suiteIds.has(key)) {
        suiteIds.set(key, ++ids.suite);
        push('test_suites', {
          id: ids.suite,
          project_id: project.id,
          file_path: t.filePath,
          suite_path: t.describe,
          mode: 'default',
          created_at: at(firstStart),
          updated_at: at(anchor),
        });
      }
      t.id = ++ids.testCase;
      push('test_cases', {
        id: t.id,
        project_id: project.id,
        file_path: t.filePath,
        suite_path: t.describe,
        suite_id: suiteIds.get(key),
        title: t.title,
        flaky_root_cause: t.kind === 'flaky' ? pick(['timing', 'network', 'assertion'], pIndex, t.index, 6) : null,
        tags: t.tags,
        owner: t.owner,
        priority: t.priority,
        created_at: at(firstStart),
        updated_at: at(anchor),
      });
    }
    yield* flush(true);

    // Stories become clusters; the side projects get the first two, over their whole history.
    const stories = (project.main ? STORIES : STORIES.slice(0, 2).map((s) => ({ ...s, from: 0, to: 1 }))).map((s) => ({
      ...s,
      fromRun: Math.floor(s.from * runs),
      toRun: Math.min(runs - 1, Math.ceil(s.to * runs)),
      testIds: storyTests(s, tests),
    }));
    const flakyTests = tests.filter((t) => t.kind === 'flaky');
    const flakyClusters = FLAKY_ERRORS.map((message, i) => ({
      index: 100 + i,
      errorType: 'timeout',
      selector: null,
      message,
    }));
    const clusters = [...stories, ...flakyClusters].map((s) => ({
      story: s,
      id: ++ids.cluster,
      occurrences: 0,
      firstSeen: null,
      lastSeen: null,
    }));
    const clusterOf = (story) => clusters.find((c) => c.story === story);

    // Content-addressed evidence of each story's failures.
    const payloadIds = new Map();
    for (const s of stories) {
      for (const [kind, content] of [
        [
          'aria',
          `- main:\n  - heading "Checkout" [level=1]\n  - button "${s.selector ?? 'Continue'}" [disabled]\n  - text: Total ${(s.index + 1) * 13}.99 EUR\n`,
        ],
        [
          'source',
          `  ${s.index + 10} |   await page.goto('/checkout');\n> ${s.index + 11} |   await expect(page.${s.selector ?? "getByRole('main')"}).toBeVisible();\n`,
        ],
      ]) {
        payloadIds.set(`${s.index}:${kind}`, ++ids.payload);
        push('case_payloads', {
          id: ids.payload,
          project_id: project.id,
          hash: sha(`${project.id}:${content}`),
          content,
          size: content.length,
          created_at: at(firstStart),
        });
      }
    }
    yield* flush(true);

    // What each test does in run `r`: a pure function, so the clusters (inserted
    // before the executions that reference them) are counted in a first pass.
    const planRun = (r) => {
      const partial = r % 20 === 13;
      return (partial ? tests.filter((t) => t.index % 10 === 0) : tests).map((t) => {
        if (t.kind === 'skip' || t.kind === 'fixme') return { test: t, outcome: 'skipped', attempts: ['skipped'] };
        const story = stories.find((s) => r >= s.fromRun && r <= s.toRun && s.testIds.has(t.index));
        if (story && rand(pIndex, r, t.index, 13) < 0.85) {
          const cluster = clusterOf(story);
          return { test: t, outcome: 'failed', story, attempts: [cluster, cluster] };
        }
        if (t.kind === 'flaky' && rand(pIndex, r, t.index, 14) < t.flakeRate) {
          const cluster = clusters[stories.length + (flakyTests.indexOf(t) % flakyClusters.length)];
          return { test: t, outcome: 'flaky', attempts: [cluster, 'passed'] };
        }
        return { test: t, outcome: 'passed', attempts: ['passed'] };
      });
    };

    const runIdByIndex = Array.from({ length: runs }, (_, r) => ids.run + r + 1);
    let newestFailingRun = null;
    let newestFailingTest = null;
    for (let r = 0; r < runs; r++) {
      for (const { test: t, outcome, attempts } of planRun(r)) {
        for (const attempt of attempts) {
          if (typeof attempt === 'string') continue;
          attempt.occurrences++;
          attempt.firstSeen ??= runIdByIndex[r];
          attempt.lastSeen = runIdByIndex[r];
        }
        if (outcome === 'failed') {
          newestFailingRun = runIdByIndex[r];
          newestFailingTest = t;
        }
      }
    }
    for (const c of clusters) {
      if (c.firstSeen == null) continue;
      const s = c.story;
      const open = s.index >= 100 || s.toRun >= runs - 1;
      const message = errorText(s.message, s.selector, 'tests/checkout/checkout-01.spec.ts', 20);
      push('failure_clusters', {
        id: c.id,
        project_id: project.id,
        fingerprint: sha(`${project.id}:${s.errorType}:${s.message}:${s.selector ?? ''}`),
        signature: s.message,
        error_type: s.errorType,
        selector: s.selector,
        sample_error: message,
        fingerprint_sample: message,
        first_seen_run_id: c.firstSeen,
        last_seen_run_id: c.lastSeen,
        status: open ? 'open' : 'resolved',
        occurrences: c.occurrences,
        title: s.message.split(':')[0],
        created_at: at(firstStart),
        updated_at: at(anchor),
      });
    }
    yield* flush(true);

    // Runs, oldest first, each with its executions.
    for (let r = 0; r < runs; r++) {
      const runId = ++ids.run;
      const start = firstStart + r * interval + Math.floor(rand(pIndex, r, 10) * 600_000);
      const onMain = rand(pIndex, r, 11) < 0.75;
      const branch = onMain ? 'main' : pick(FEATURE_BRANCHES, pIndex, r, 12);
      const partial = r % 20 === 13;
      const workerCursor = new Array(WORKERS).fill(0);
      const durations = [];
      const counters = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };
      const withNetwork = project.main && r >= runs - size.networkRuns;

      for (const { test: t, outcome, story, attempts } of planRun(r)) {
        counters.total++;
        const worker = t.index % WORKERS;
        const duration =
          outcome === 'skipped' ? 0 : Math.round(t.baseDuration * (0.8 + 0.4 * rand(pIndex, r, t.index, 15)));

        attempts.forEach((attempt, retry) => {
          const executionId = ++ids.execution;
          const started = start + workerCursor[worker];
          workerCursor[worker] += duration + 40;
          if (duration) durations.push(duration);
          const cluster = typeof attempt === 'string' ? null : attempt;
          const status = cluster ? 'failed' : attempt;
          const s = cluster?.story;
          push('test_runs_cases', {
            id: executionId,
            test_run_id: runId,
            test_case_id: t.id,
            status,
            duration,
            timeout: 30_000,
            error: s ? errorText(s.message, s.selector, t.filePath, t.line) : null,
            failure_cluster_id: cluster?.id ?? null,
            retries: retry,
            line: t.line,
            column: 3,
            steps: outcome === 'skipped' ? null : stepsFor(t, duration, [pIndex, r, t.index]),
            slowest_step: outcome === 'skipped' ? null : `Click getByRole('button')`,
            slowest_step_duration: outcome === 'skipped' ? null : Math.round(duration * 0.5),
            browser: BROWSER,
            browser_name: BROWSER.projectName,
            test_annotations: t.kind === 'skip' ? [{ type: 'skip' }] : t.kind === 'fixme' ? [{ type: 'fixme' }] : null,
            tags: t.tags,
            worker_index: worker,
            started_at: started,
            expected_status: outcome === 'skipped' ? 'skipped' : 'passed',
            aria_snapshot_payload_id: cluster && story ? (payloadIds.get(`${story.index}:aria`) ?? null) : null,
            test_source_payload_id: cluster && story ? (payloadIds.get(`${story.index}:source`) ?? null) : null,
            created_at: at(started + duration),
          });

          if (withNetwork && outcome !== 'skipped') {
            const requests = [
              ['GET', `/${t.filePath.split('/')[1]}`, '/:page', 200, 'document'],
              ['GET', '/api/cart', '/api/cart', 200, 'fetch'],
              ['POST', '/api/events', '/api/events', 202, 'fetch'],
            ];
            if (cluster) requests.push(['POST', '/api/checkout', '/api/checkout', 500, 'fetch']);
            requests.forEach(([method, path, normalized, httpStatus, type], k) =>
              push('network_requests', {
                id: ++ids.network,
                test_runs_case_id: executionId,
                test_run_id: runId,
                method,
                url: `http://shop.local${path}`,
                normalized_url: normalized,
                status: httpStatus,
                duration: Math.round(20 + 400 * rand(pIndex, r, t.index, retry, k, 16)),
                start_time: started + k * 150,
                resource_type: type,
                content_type: type === 'document' ? 'text/html' : 'application/json',
              }),
            );
          }
        });

        if (outcome === 'passed') counters.passed++;
        else if (outcome === 'flaky') {
          counters.passed++;
          counters.flaky++;
        } else if (outcome === 'failed') counters.failed++;
        else counters.skipped++;
      }

      durations.sort((a, b) => a - b);
      const wall = Math.max(...workerCursor) + 4_000;
      const commit = hex(40, pIndex, r, 17);
      push('test_runs', {
        id: runId,
        project_id: project.id,
        status: counters.failed > 0 ? 'failed' : 'passed',
        start_time: at(start),
        duration: wall,
        total_tests: counters.total,
        passed_tests: counters.passed,
        failed_tests: counters.failed,
        skipped_tests: counters.skipped,
        did_not_run_tests: 0,
        flaky_tests: counters.flaky,
        avg_test_duration: durations.length
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : null,
        p90_test_duration: percentile(durations, 0.9),
        shards_finished: 0,
        is_full_run: partial ? 0 : 1,
        filter_details: partial ? { grep: '@smoke' } : null,
        environment: rand(pIndex, r, 18) < 0.8 ? 'staging' : 'production',
        branch,
        label: project.main && r % 150 === 149 ? `v2.${Math.floor(r / 150)}.0 release` : null,
        metadata: {
          ci: {
            provider: 'GitHub Actions',
            buildNumber: String(10_000 + r),
            workflow: 'E2E',
            jobName: 'test',
            buildUrl: `https://github.com/acme/${project.name}/actions/runs/${9_000_000 + r}`,
          },
          scm: {
            commit,
            branch,
            author: pick(['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson'], pIndex, r, 19),
            commitMessage: `${pick(['fix', 'feat', 'refactor', 'chore'], pIndex, r, 20)}: ${pick(OBJECTS, pIndex, r, 21)} ${pick(QUALIFIERS, pIndex, r, 22)}`,
            remoteUrl: `https://github.com/acme/${project.name}`,
          },
          htmlReport: { projects: [{ name: 'chromium', use: { baseURL: 'http://shop.local' } }] },
        },
        // `runOrigin(metadata)`: the metadata carries a CI record.
        origin: 'ci',
        // `runCommit(metadata)`.
        commit_sha: commit,
        instance_id: `ci-${project.name}`,
        playwright_version: r < runs * 0.7 ? '1.54.2' : '1.55.1',
        reporter_version: '0.46.0',
        kept_at: project.main && r % 500 === 250 ? at(start + 3_600_000) : null,
        keep_source: project.main && r % 500 === 250 ? 'user' : null,
        created_at: at(start),
        updated_at: at(start + wall),
      });

      if (r >= runs - size.reportRuns || !project.main) {
        push('files', {
          id: ++ids.file,
          test_run_id: runId,
          type: 'report',
          subtype: 'html',
          label: 'HTML Report',
          path: `reports/${project.id}/${runId}/index.html`,
          size: 400_000 + Math.floor(rand(pIndex, r, 23) * 900_000),
          created_at: at(start + wall),
        });
      }
      // Runs before their executions: a batch boundary never splits a run's parent row away.
      if (pending.get('test_runs_cases')?.length >= BATCH_ROWS) {
        yield* flushRunsFirst();
      }
    }
    yield* flushRunsFirst();

    if (project.main) {
      // The newest run with a failure: the run page opens on its failure views.
      manifest.runId = newestFailingRun ?? runIdByIndex[runs - 1];
      // The test the suite's trace is recorded for (`lib/trace.mjs`), dated an
      // hour before the history so its import is the test's oldest execution.
      const t = newestFailingTest ?? tests.find((x) => x.kind === 'normal');
      manifest.trace = {
        title: `${t.filePath}:${t.line} › ${t.describe} › ${t.title}`,
        filePath: t.filePath,
        line: t.line,
        wallTime: firstStart - 3_600_000,
      };
      for (let k = 0; k < 8; k++) {
        const r = Math.floor(((k + 0.5) / 8) * runs);
        push('markers', {
          id: k + 1,
          project_id: project.id,
          occurred_at: at(firstStart + r * interval),
          label: k % 2 ? `Deploy ${k}` : `Release 2.${k}`,
          description: null,
          category: k % 2 ? 'deploy' : 'release',
          environment: k % 3 === 0 ? 'production' : null,
          source: 'manual',
          run_id: runIdByIndex[r],
          created_at: at(firstStart + r * interval),
          updated_at: at(firstStart + r * interval),
        });
      }
      flakyTests.slice(0, 2).forEach((t, k) =>
        push('quarantined_tests', {
          id: k + 1,
          project_id: project.id,
          test_case_id: t.id,
          reason: 'Flaky on the staging cart service',
          source: 'manual',
          quarantined_at_run_id: runIdByIndex[Math.max(0, runs - 200)],
          created_at: at(anchor - 20 * 86_400_000),
        }),
      );
    }
    yield* flush(true);
  }

  yield { manifest };

  function* flushRunsFirst() {
    for (const table of ['test_runs', 'test_runs_cases', 'network_requests', 'files']) {
      const rows = pending.get(table);
      if (rows?.length) {
        count(table, rows.length);
        yield { table, rows };
        pending.set(table, []);
      }
    }
  }
}
