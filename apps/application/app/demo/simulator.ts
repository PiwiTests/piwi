/**
 * Demo run simulator.
 *
 * Replays the exact streaming protocol a Piwi reporter speaks during a live
 * Playwright run (setup → begin → events → finish) against the in-browser
 * demo API, so visitors can watch a run arrive in real time: initialization
 * status, live test results across parallel workers, failure clustering,
 * flaky retries, performance data, and the final summary.
 *
 * Scenarios target the seeded `e2e-checkout` project so history-based
 * features (test case history, timing vs average, regression context,
 * recurring failure clusters) light up with the pre-seeded data.
 *
 * All calls go through `$fetch`, whose base URL puts them in the service
 * worker's scope — the same path a real reporter's HTTP calls take through the
 * real server.
 */

import {
  DEMO_PROJECTS,
  storyByClusterId,
  buildTestSource,
  buildSourceFrames,
  buildWebAssertionError,
  authoredFailureSteps,
  authoredBeforeEachMs,
  storyEvidenceTimes,
  FAILURE_TEARDOWN_MS,
} from '#shared/demo/failure-stories.mjs';
import { demoLocks, demoTags, demoTestMeta, buildAiUsage } from '#shared/demo/demo-test-meta.mjs';
import { demoExecutionResources, demoResourceReport } from '#shared/demo/demo-resources.mjs';

export const DEMO_SIMULATOR_INSTANCE_ID = 'demo-simulator';

/** Project from the demo seed (scripts/generate-demo-seed.mjs) */
const DEMO_PROJECT_NAME = 'e2e-checkout';

/**
 * Id of {@link DEMO_PROJECT_NAME} in the demo seed — the project every scenario
 * targets. Used to gate the simulator on the acting demo user's project access
 * (affectations). Must match the `e2e-checkout` row id in
 * scripts/generate-demo-seed.mjs.
 */
export const DEMO_PROJECT_ID = 1;

// ── Simulated data types ───────────────────────────────────────────────────

interface SimStep {
  title: string;
  duration: number;
  category: string;
  /** Ms from the test start, on a test whose times are relative to its attempt. */
  at?: number;
  /** Playwright 1.63 step target (rendered locator or URL), carried separately. */
  subtitle?: string;
  /** Playwright 1.63 curated per-step arguments. */
  params?: Record<string, string | number | boolean>;
  /** Project-relative `file:line:col` of the call. */
  location?: string;
  /** The step the test failed on, with the first line of its error. */
  failed?: boolean;
  error?: { message: string };
}

interface SimAttempt {
  status: 'passed' | 'failed';
  /** Overrides the test duration for this attempt (e.g. a timeout) */
  duration?: number;
  error?: string;
  consoleLogs?: Array<Record<string, unknown>>;
  dialogs?: Array<Record<string, unknown>>;
  ariaSnapshot?: string;
  testAnnotations?: Array<{ type: string; description?: string }> | null;
  testSource?: string | null;
  testSourceFrames?: Array<{ file: string; line: number; snippet: string }> | null;
}

interface SimTest {
  /** Spec file the test lives in (source of the deterministic tags/AI usage). */
  file: string;
  title: string;
  location: string;
  duration: number;
  /** Executed in order; the last attempt is the final result */
  attempts: SimAttempt[];
  steps: SimStep[];
  stepEvents?: Array<Record<string, unknown>> | null;
  slowestStep: string;
  slowestStepDuration: number;
  wastedTimeMs?: number | null;
  networkRequests: Array<Record<string, unknown>>;
  webVitals: Record<string, unknown>;
  pageState?: Record<string, unknown> | null;
  browser?: Record<string, unknown> | null;
  tags?: string[];
  locks?: string[];
  testMeta?: { owner?: string | null; priority?: string | null; feature?: string | null } | null;
  suitePath?: string[];
  suiteConfig?: Array<{ mode: string; annotations: Array<{ type: string; description?: string }> }>;
  /**
   * The step (`at`), console, dialog and request times are ms from the
   * attempt's start, stamped onto it when the attempt runs: a story test
   * places its evidence where its story puts it in the execution.
   */
  relativeTimes?: boolean;
}

export interface DemoScenario {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** Time compression: virtual milliseconds elapse `speed`× faster on the wall clock */
  speed: number;
  workers: number;
  environment: string;
  /** Optional display label for the simulated test run */
  runLabel?: string;
  /** Interrupt the run after this many completed tests */
  stopAfter?: number;
  /** Enable sharding — tests are split across `shardCount` parallel shards */
  shardCount?: number;
  /** Overrides the default '1.51.0' reported to setup/begin/finish. */
  playwrightVersion?: string;
  /**
   * Send what each test cost and the run's resource report, as a reporter
   * with the capture fixtures does; `leaky` is a suite whose login fixture
   * leaves a browser context open in every test, `clean` one that closes
   * what it opens.
   */
  resources?: 'leaky' | 'clean';
  metadata: () => Record<string, unknown>;
  tests: () => SimTest[];
}

// ── Builders ───────────────────────────────────────────────────────────────

/** Random variation of ±pct around a base value */
function vary(base: number, pct = 0.15): number {
  return Math.round(base * (1 + (Math.random() * 2 - 1) * pct));
}

function randomCommitSha(): string {
  let sha = '';
  while (sha.length < 40) sha += Math.random().toString(16).slice(2);
  return sha.slice(0, 40);
}

/** The seeded e2e-checkout project — same source the seed generator reads. */
const CHECKOUT_PROJECT = DEMO_PROJECTS.find((p) => p.id === DEMO_PROJECT_ID)!;

/** Base durations, in the same order as CHECKOUT_PROJECT.cases (kept local — pacing is simulator-only). */
const CHECKOUT_DURATIONS = [6800, 7200, 5400, 3100, 2900, 2400, 2100, 2600, 3400, 1900, 4100, 2700];

/** Tests of the seeded e2e-checkout project — file/title/declaration line from the single source of truth. */
const CHECKOUT_TESTS: Array<{ file: string; title: string; duration: number; declLine: number; declColumn: number }> =
  CHECKOUT_PROJECT.cases.map((c, i) => ({
    file: c.file,
    title: c.title,
    duration: CHECKOUT_DURATIONS[i]!,
    declLine: c.declLine,
    declColumn: c.declColumn,
  }));

/** Suite map — derived from the same DEMO_PROJECTS suites the seed generator reads. */
const SUITE_MAP: Record<
  string,
  {
    suitePath: string[];
    suiteConfig: Array<{ mode: string; annotations: Array<{ type: string; description?: string }> }>;
  }
> = Object.fromEntries(
  Object.entries(CHECKOUT_PROJECT.suites).map(([file, def]) => [
    file,
    { suitePath: def.suitePath, suiteConfig: [{ mode: def.mode, annotations: def.annotations }] },
  ]),
);

/** Browser configs for multi-browser scenarios */
const BROWSER_CONFIGS: Record<string, Record<string, unknown>> = {
  chromium: { projectName: 'Chromium', browserName: 'chromium', channel: null, viewport: { width: 1280, height: 720 } },
  firefox: { projectName: 'Firefox', browserName: 'firefox', channel: null, viewport: { width: 1280, height: 720 } },
  webkit: { projectName: 'WebKit', browserName: 'webkit', channel: null, viewport: { width: 1280, height: 720 } },
};

/**
 * The seeded checkout-Pay-timeout cluster (see FAILURE_STORIES in
 * shared/demo/failure-stories.mjs) and the renamed-email-label cluster. Reusing
 * their exact error text — not a hand-copied approximation — means the
 * simulated failure fingerprints identically to the seeded one and joins the
 * same cluster (bumping its occurrence history) instead of splitting into a
 * lookalike duplicate.
 */
const CLUSTER1_STORY = storyByClusterId(1)!;
const CLUSTER2_STORY = storyByClusterId(2)!;

/**
 * A new environment-sensitive error, built with the same reporter-faithful
 * error builder the seed fixtures use. Deliberately not tied to a seeded
 * story/cluster — this scenario exists to demonstrate the environment-diff
 * card on a brand-new failure, not to join existing history.
 */
const ENV_DRIFT_ERROR = buildWebAssertionError({
  matcher: 'expect(locator).toBeVisible()',
  locator: "getByRole('button', { name: 'Retry payment' })",
  expected: 'visible',
  received: 'hidden',
  timeoutMs: 5000,
  callLog: [
    'Expect "toBeVisible" with timeout 5000ms',
    "waiting for getByRole('button', { name: 'Retry payment' })",
    '9 × locator resolved to <button hidden class="retry-btn">Retry payment</button>',
  ],
  frames: [{ file: 'tests/checkout/checkout.spec.ts', line: CHECKOUT_TESTS[3]!.declLine + 4, column: 11 }],
});

/** A new error signature — forms a brand-new failure cluster (shown as "New") */
const NEW_STRICT_MODE_ERROR =
  "Error: strict mode violation: getByTestId('place-order-button') resolved to 2 elements:\n" +
  '    1) <button data-testid="place-order-button" class="btn-primary">Place order</button>\n' +
  '    2) <button data-testid="place-order-button" class="btn-sticky-footer">Place order</button>\n' +
  '\n' +
  '    at tests/checkout/checkout.spec.ts:88:42';

/** A flaky assertion error — cart total read before the price recalculation settles */
const FLAKY_ASSERTION_ERROR =
  'Error: expect(locator).toHaveText(expected) failed\n' +
  '\n' +
  "Locator: getByTestId('cart-total')\n" +
  'Expected string: "$42.97"\n' +
  'Received string: "$0.00"\n' +
  'Timeout: 5000ms\n' +
  '\n' +
  '    at tests/checkout/cart.spec.ts:61:38';

const STRICT_MODE_ARIA_SNAPSHOT =
  '- heading "Checkout" [level=1]\n' +
  '- group "Payment details":\n' +
  '  - textbox "Card number"\n' +
  '  - textbox "Expiry date"\n' +
  '  - textbox "CVC"\n' +
  '- button "Place order"\n' +
  '- button "Place order"';

/**
 * The seeded checkout flow in the Playwright 1.63 step shape: a bare-verb title
 * with the target in `subtitle` and curated `params`. The static seed keeps
 * other suites in the 1.61 shape, so the demo renders both.
 */
const STEP_SHAPE: Array<
  Omit<SimStep, 'duration'> & { fraction: number; slowFraction: number; page?: string; arrival?: boolean }
> = [
  {
    title: 'Navigate',
    subtitle: '/checkout',
    category: 'navigation',
    fraction: 0.2,
    slowFraction: 0.1,
    params: { url: 'https://shop.example.com/checkout' },
  },
  {
    title: 'Fill "ada@example.com"',
    subtitle: "getByLabel('Email')",
    category: 'input',
    fraction: 0.12,
    slowFraction: 0.08,
    params: { locator: "getByLabel('Email')", value: 'ada@example.com' },
    location: 'tests/pages/checkout.page.ts:18:31',
    page: '/checkout',
    arrival: true,
  },
  {
    title: 'Fill "Ada Lovelace"',
    subtitle: "getByLabel('Name on card')",
    category: 'input',
    fraction: 0.25,
    slowFraction: 0.12,
    params: { locator: "getByLabel('Name on card')", value: 'Ada Lovelace' },
    location: 'tests/pages/checkout.page.ts:22:38',
    page: '/checkout',
    arrival: false,
  },
  {
    title: 'Click',
    subtitle: "getByRole('button', { name: 'Place order' })",
    category: 'action',
    fraction: 0.28,
    slowFraction: 0.55,
    params: { locator: "getByRole('button', { name: 'Place order' })" },
    location: 'tests/pages/checkout.page.ts:26:58',
    page: '/checkout',
    arrival: false,
  },
  {
    title: 'Expect "toBeVisible"',
    subtitle: "getByText('Order confirmed')",
    category: 'assertion',
    fraction: 0.15,
    slowFraction: 0.15,
    params: { locator: "getByText('Order confirmed')" },
    location: 'tests/pages/checkout.page.ts:30:40',
    page: '/orders/:id',
    arrival: true,
  },
];

function buildSteps(duration: number, slowStepBias = false): SimStep[] {
  return STEP_SHAPE.map((s) => ({
    title: s.title,
    subtitle: s.subtitle,
    category: s.category,
    params: s.params,
    location: s.location,
    duration: Math.round(duration * (slowStepBias ? s.slowFraction : s.fraction)),
  }));
}

/** The page each locator call ran on, as the capture fixtures send it (`locatorPages`), matching the seeded runs. */
function buildLocatorPages(): Array<Record<string, unknown>> {
  return STEP_SHAPE.filter((s) => s.location && s.page && s.params?.locator).map((s) => ({
    location: s.location,
    locator: s.params!.locator,
    origin: 'https://shop.example.com',
    page: s.page,
    arrival: !!s.arrival,
  }));
}

const SERVER_LOGS_OK = [
  { timestamp: Date.now() - 5000, level: 'info', category: 'http', message: 'GET /api/cart — 200 OK (70ms)' },
  { timestamp: Date.now() - 4000, level: 'debug', category: 'cache', message: 'Cart cache HIT for session abc123' },
];

const SERVER_LOGS_ERROR = [
  {
    timestamp: Date.now() - 5000,
    level: 'error',
    category: 'http',
    message: 'POST /api/payments/authorize — 500 Internal Server Error',
    stack:
      'Error: payment provider timeout\n    at PaymentGateway.charge (services/payment.ts:85)\n    at POST /payments/authorize (routes/payments.ts:42)',
  },
  {
    timestamp: Date.now() - 4000,
    level: 'warn',
    category: 'payment',
    message: 'Payment provider response time exceeded 5000ms threshold',
  },
];

function buildNetworkRequests(opts: { slow?: boolean; paymentError?: boolean } = {}): Array<Record<string, unknown>> {
  return withStartTimes([
    {
      method: 'GET',
      url: 'https://shop.example.com/api/cart',
      status: 200,
      duration: vary(70),
      resourceType: 'fetch',
      serverLogs: SERVER_LOGS_OK,
    },
    {
      method: 'GET',
      url: 'https://shop.example.com/api/products/featured',
      status: 200,
      duration: vary(115),
      resourceType: 'fetch',
    },
    {
      method: 'GET',
      url: 'https://shop.example.com/api/shipping/options',
      status: 200,
      duration: vary(95),
      resourceType: 'fetch',
    },
    {
      method: 'POST',
      url: 'https://shop.example.com/api/orders',
      status: 201,
      duration: vary(opts.slow ? 2200 : 185),
      resourceType: 'fetch',
    },
    ...(opts.slow
      ? [
          {
            method: 'GET',
            url: 'https://shop.example.com/api/recommendations',
            status: 200,
            duration: vary(2900),
            resourceType: 'fetch',
          },
        ]
      : []),
    ...(opts.paymentError
      ? [
          {
            method: 'POST',
            url: 'https://shop.example.com/api/payments/authorize',
            status: 500,
            duration: vary(450),
            resourceType: 'fetch',
            serverLogs: SERVER_LOGS_ERROR,
          },
        ]
      : [
          {
            method: 'POST',
            url: 'https://shop.example.com/api/payments/authorize',
            status: 200,
            duration: vary(320),
            resourceType: 'fetch',
          },
        ]),
  ]);
}

/**
 * Stamp sequential start times onto simulated requests from `from`, the way the
 * fixtures record `request.timing().startTime`: each one starts shortly after
 * the previous one finished. A request's backend log entries keep their spacing
 * and the first one sits mid-request, so the backend lane lines up with it.
 */
function withStartTimes(
  requests: Array<Record<string, unknown>>,
  from: number = Date.now(),
): Array<Record<string, unknown>> {
  let startTime = from;
  return requests.map((req) => {
    const duration = Number(req.duration ?? 0);
    const logs = req.serverLogs as Array<{ timestamp: number }> | undefined;
    const first = logs?.length ? Math.min(...logs.map((l) => l.timestamp)) : 0;
    const at = startTime + Math.round(duration / 2);
    const stamped = {
      ...req,
      startTime,
      ...(logs?.length ? { serverLogs: logs.map((l) => ({ ...l, timestamp: at + (l.timestamp - first) })) } : {}),
    };
    startTime += duration + vary(40);
    return stamped;
  });
}

/**
 * A relative-times test's steps, console entries, dialogs and requests (with
 * their backend log entries) stamped onto its attempt, which started at
 * `startedAt` (epoch ms).
 */
function stampAttemptTimes(test: SimTest, a: SimAttempt, startedAt: number) {
  const at = (ms: unknown) => startedAt + Number(ms ?? 0);
  return {
    steps: test.steps.map(({ at: offset, ...step }) => ({ ...step, startTime: at(offset) })),
    consoleLogs: a.consoleLogs?.map((entry) => ({ ...entry, timestamp: at(entry.timestamp) })),
    dialogs: a.dialogs?.map((dialog) => ({ ...dialog, closedAt: at(dialog.closedAt) })),
    networkRequests: test.networkRequests.map((req) => ({
      ...req,
      startTime: at(req.startTime),
      ...(Array.isArray(req.serverLogs)
        ? {
            serverLogs: (req.serverLogs as Array<Record<string, unknown>>).map((log) => ({
              ...log,
              timestamp: at(log.timestamp),
            })),
          }
        : {}),
    })),
  };
}

function buildWebVitals(slow = false): Record<string, unknown> {
  const factor = slow ? 2.4 : 1;
  return {
    navigation: {
      url: 'https://shop.example.com/checkout',
      ttfb: vary(110 * factor),
      domInteractive: vary(820 * factor),
      domContentLoaded: vary(1150 * factor),
      loadComplete: vary(1750 * factor),
    },
    paint: {
      firstPaint: vary(680 * factor),
      firstContentfulPaint: vary(890 * factor),
    },
    vitals: {
      lcp: vary(1450 * factor),
      cls: Math.round((slow ? 0.18 : 0.04) * (0.8 + Math.random() * 0.4) * 10000) / 10000,
      inp: vary(140 * factor),
    },
  };
}

function buildPageState(): Record<string, unknown> {
  return {
    url: 'https://shop.example.com/checkout',
    hash: null,
    historyState: '{"step":"payment"}',
    localStorage: [
      { key: 'cart', length: 182 },
      { key: 'theme', length: 5 },
    ],
    sessionStorage: [{ key: 'checkout-session', length: 36 }],
    cookies: [
      { name: 'sid', domain: '.shop.example.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'ab_variant', domain: '.shop.example.com', path: '/', httpOnly: false, secure: true },
    ],
  };
}

/**
 * Stamp timestamps onto a story's themed console evidence, each entry
 * `offsets[i]` ms after the test started. A real browser console never echoes
 * the Playwright/Node assertion text back at itself, so — like the seed
 * generator — this only ever surfaces what the story declares as plausible
 * page console output, never a copy of `error`.
 */
function themedConsoleLogs(
  entries: Array<{ type: string; text: string; location: string | null }> | undefined,
  startedAt: number,
  offsets: number[],
): Array<Record<string, unknown>> | undefined {
  if (!entries?.length) return undefined;
  return entries.map((e, i) => ({
    type: e.type,
    text: e.text,
    location: e.location,
    timestamp: startedAt + (offsets[i] ?? 0),
  }));
}

interface BaseTestOptions {
  durationFactor?: number;
  slowNetwork?: boolean;
  slowSteps?: boolean;
  waitHeavy?: boolean;
}

/** The `Before Hooks` section: the context and page fixtures, then a `beforeEach` hook. */
function beforeHooksEvent(
  offset: number,
  contextDur: number,
  pageDur: number,
  beforeEachDur: number,
): Record<string, unknown> {
  return {
    title: 'Before Hooks',
    category: 'hook',
    startedAt: offset,
    duration: contextDur + pageDur + beforeEachDur,
    status: 'passed',
    location: null,
    hooks: [
      { title: 'Fixture "context"', category: 'fixture', duration: contextDur },
      { title: 'Fixture "page"', category: 'fixture', duration: pageDur },
      { title: 'beforeEach hook', category: 'hook', duration: beforeEachDur },
    ],
  };
}

/** The `After Hooks` section: an `afterEach` hook, then the page fixture's teardown. */
function afterHooksEvent(offset: number, duration: number): Record<string, unknown> {
  const afterEachDur = Math.round(duration * 0.6);
  return {
    title: 'After Hooks',
    category: 'hook',
    startedAt: offset,
    duration,
    status: 'passed',
    location: null,
    hooks: [
      { title: 'afterEach hook', category: 'hook', duration: afterEachDur },
      { title: 'Fixture "page"', category: 'fixture', duration: duration - afterEachDur },
    ],
  };
}

/**
 * Builds a realistic set of fine-grained step events for a test: before/after
 * hooks, fixture setup, framework-injected waits, and a single deliberate
 * waitForTimeout sleep that shows up as wasted time.
 *
 * startedAt values are stored as ms offsets from 0 (i.e. relative to the
 * test's own startedAt). workerLoop remaps them to absolute epoch ms before
 * posting, so events from different tests never pile up on the same spot.
 */
function buildStepEvents(testDuration: number): Array<Record<string, unknown>> {
  let offset = 0;
  const events: Array<Record<string, unknown>> = [];

  const beforeHookDur = vary(130, 0.2);
  const contextDur = vary(75, 0.2);
  const pageDur = vary(55, 0.2);
  events.push(beforeHooksEvent(offset, contextDur, pageDur, beforeHookDur));
  offset += contextDur + pageDur + beforeHookDur;

  // Framework-injected navigation wait — not wasted
  const loadStateDur = vary(420, 0.25);
  events.push({
    title: 'Wait for load state',
    category: 'wait',
    startedAt: offset,
    duration: loadStateDur,
    status: 'passed',
    location: null,
  });
  offset += loadStateDur;

  // Explicit sleep added by the test author — counts as wasted
  const timeoutDur = vary(500, 0.2);
  events.push({
    title: 'Wait for timeout',
    category: 'wait',
    startedAt: offset,
    duration: timeoutDur,
    status: 'wasted',
    location: 'tests/checkout/checkout.spec.ts:34:5',
  });
  offset += timeoutDur;

  // Wait for selector — framework-injected, not wasted
  const selectorDur = vary(Math.round(testDuration * 0.08), 0.25);
  events.push({
    title: 'Wait for selector',
    category: 'wait',
    startedAt: offset,
    duration: selectorDur,
    status: 'passed',
    location: null,
  });
  offset += selectorDur;

  const afterHookDur = vary(90, 0.2);
  events.push(afterHooksEvent(Math.max(offset, testDuration - afterHookDur), afterHookDur));

  return events;
}

/**
 * Builds step events for a wait-heavy test: three explicit `waitForTimeout`
 * sleeps interspersed with framework waits, producing a noticeable wasted-time
 * total without overcrowding the timeline. startedAt values are 0-based
 * offsets remapped to absolute epoch ms in workerLoop.
 */
function buildWaitHeavyStepEvents(testDuration: number, file: string, line: number): Array<Record<string, unknown>> {
  let offset = 0;
  const events: Array<Record<string, unknown>> = [];

  const beforeHookDur = vary(140, 0.2);
  const contextDur = vary(80, 0.2);
  const pageDur = vary(60, 0.2);
  events.push(beforeHooksEvent(offset, contextDur, pageDur, beforeHookDur));
  offset += contextDur + pageDur + beforeHookDur;

  // Framework-injected load wait — not wasted
  const firstLoadDur = vary(380, 0.2);
  events.push({
    title: 'Wait for load state',
    category: 'wait',
    startedAt: offset,
    duration: firstLoadDur,
    status: 'passed',
    location: null,
  });
  offset += firstLoadDur;

  // Three explicit sleeps spread through the test — all wasted
  const sleeps = [vary(500, 0.15), vary(1000, 0.15), vary(500, 0.15)];
  for (let i = 0; i < sleeps.length; i++) {
    events.push({
      title: 'Wait for timeout',
      category: 'wait',
      startedAt: offset,
      duration: sleeps[i]!,
      status: 'wasted',
      location: `${file}:${line + i * 6}:5`,
    });
    offset += sleeps[i]!;

    // Framework wait between each explicit sleep
    if (i < sleeps.length - 1) {
      const fwDur = vary(Math.round(testDuration * 0.12), 0.2);
      events.push({
        title: 'Wait for load state',
        category: 'wait',
        startedAt: offset,
        duration: fwDur,
        status: 'passed',
        location: null,
      });
      offset += fwDur;
    }
  }

  // Final response wait — not wasted
  const navDur = vary(340, 0.2);
  events.push({
    title: 'Wait for response',
    category: 'wait',
    startedAt: offset,
    duration: navDur,
    status: 'passed',
    location: null,
  });
  offset += navDur;

  const afterHookDur = vary(95, 0.2);
  events.push(afterHooksEvent(Math.max(offset, testDuration - afterHookDur), afterHookDur));

  return events;
}

/**
 * Step events for a test running a story's authored steps: its fixtures and
 * the beforeEach hook that runs the authored navigation, a framework load
 * wait, and the after hooks at the end of the attempt. The test never sleeps,
 * so nothing is wasted. startedAt values are 0-based offsets remapped to
 * absolute epoch ms in workerLoop.
 */
function buildStoryStepEvents(
  attemptDuration: number,
  hooks: { context: number; page: number; beforeEach: number },
): Array<Record<string, unknown>> {
  const offset = hooks.context + hooks.page + hooks.beforeEach;
  const afterHookDur = vary(90, 0.2);
  return [
    beforeHooksEvent(0, hooks.context, hooks.page, hooks.beforeEach),
    {
      title: 'Wait for load state',
      category: 'wait',
      startedAt: offset,
      duration: vary(420, 0.25),
      status: 'passed',
      location: null,
    },
    afterHooksEvent(attemptDuration - afterHookDur, afterHookDur),
  ];
}

function baseTests(opts: BaseTestOptions = {}): SimTest[] {
  return CHECKOUT_TESTS.map((t, i) => {
    const duration = vary(Math.round(t.duration * (opts.durationFactor ?? 1)), 0.12);
    const steps = buildSteps(duration, opts.slowSteps);
    const slowest = steps.reduce((a, b) => (a.duration > b.duration ? a : b));
    const suite = SUITE_MAP[t.file];
    const stepEvents = opts.waitHeavy
      ? buildWaitHeavyStepEvents(duration, t.file, t.declLine)
      : buildStepEvents(duration);
    const wastedTimeMs = stepEvents
      .filter((e) => e.category === 'wait' && e.title === 'Wait for timeout')
      .reduce((sum, e) => sum + (e.duration as number), 0);

    return {
      file: t.file,
      title: t.title,
      location: `${t.file}:${t.declLine}:${t.declColumn}`,
      duration,
      attempts: [{ status: 'passed' as const }],
      steps,
      stepEvents,
      slowestStep: slowest.title,
      slowestStepDuration: slowest.duration,
      wastedTimeMs: wastedTimeMs > 0 ? wastedTimeMs : null,
      networkRequests: buildNetworkRequests({ slow: opts.slowNetwork }),
      webVitals: buildWebVitals(opts.slowNetwork),
      pageState: buildPageState(),
      // Same deterministic tags/ownership the seed generator assigns, so
      // owner/priority/tag filters see simulated runs like seeded ones.
      tags: demoTags(t.file, i),
      locks: demoLocks(t.file, i),
      testMeta: demoTestMeta(t.file, i),
      suitePath: suite?.suitePath,
      suiteConfig: suite?.suiteConfig,
    };
  });
}

function buildMetadata(opts: {
  branch: string;
  author: string;
  commitMessage: string;
  relatedIssue?: string;
  customData?: Record<string, unknown>;
  ciInfo?: string | Record<string, string>;
}): Record<string, unknown> {
  const buildNumber = String(1340 + Math.floor(Math.random() * 60));
  return {
    ci: {
      provider: 'GitHub Actions',
      buildNumber,
      jobName: 'e2e-checkout',
      workflow: 'CI',
      buildUrl: `https://github.com/acme/shop/actions/runs/${buildNumber}`,
    },
    scm: {
      commit: randomCommitSha(),
      branch: opts.branch,
      author: opts.author,
      commitMessage: opts.commitMessage,
      remoteUrl: 'https://github.com/acme/shop.git',
    },
    htmlReport: {
      projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
    },
    ...(opts.relatedIssue ? { relatedIssue: opts.relatedIssue } : {}),
    ...(opts.customData ? { customData: opts.customData } : {}),
    ...(opts.ciInfo ? { ciInfo: opts.ciInfo } : {}),
  };
}

// ── Scenarios ──────────────────────────────────────────────────────────────

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'passing',
    label: 'Passing run',
    description: 'All 12 checkout tests pass across 4 parallel workers',
    icon: 'i-lucide-circle-check-big',
    speed: 1.5,
    workers: 4,
    environment: 'staging',
    runLabel: 'release-v2.3.1',
    metadata: () =>
      buildMetadata({
        branch: 'main',
        author: 'Alice Chen',
        commitMessage: 'feat: add gift wrapping option at checkout',
        customData: { deployId: 'deploy-2026-06-11.3', region: 'eu-west-1' },
      }),
    tests: () => baseTests(),
  },
  {
    id: 'failures',
    label: 'Run with failures',
    description: 'A recurring timeout cluster plus a brand-new failure',
    icon: 'i-lucide-circle-x',
    speed: 3,
    workers: 4,
    environment: 'production',
    metadata: () =>
      buildMetadata({
        branch: 'feature/payment-form-rework',
        author: 'Bob Smith',
        commitMessage: 'feat: rework payment form validation',
        relatedIssue: 'https://github.com/acme/shop/issues/421',
      }),
    tests: () => {
      const tests = baseTests();
      // Two tests hit the timeout cluster already known from previous runs —
      // same error text as the seeded cluster 1, so this joins it rather than
      // splitting into a lookalike duplicate.
      for (const i of [0, 1]) {
        const failingCase = CLUSTER1_STORY.failingCases[i]!;
        // The story's own steps once the fixtures are set up: the beforeEach
        // navigation, the checkout fields, then the Pay click the test timeout
        // stops, with the story's evidence placed around it. Every time is in
        // ms from the attempt's start, which workerLoop stamps on.
        const scale = vary(1000, 0.1) / 1000;
        const context = vary(75, 0.2);
        const page = vary(55, 0.2);
        const placed = authoredFailureSteps(failingCase, { scale, startMs: context + page })!;
        const payClick = placed.at(-1)!;
        const failedDuration = payClick.at + payClick.duration + FAILURE_TEARDOWN_MS;
        const times = storyEvidenceTimes(CLUSTER1_STORY, payClick);
        const slowest = placed.reduce((a, b) => (a.duration > b.duration ? a : b));
        tests[i]!.relativeTimes = true;
        tests[i]!.steps = placed;
        tests[i]!.slowestStep = slowest.title;
        tests[i]!.slowestStepDuration = slowest.duration;
        tests[i]!.stepEvents = buildStoryStepEvents(failedDuration, {
          context,
          page,
          beforeEach: authoredBeforeEachMs(failingCase, { scale }),
        });
        tests[i]!.wastedTimeMs = null;
        tests[i]!.pageState = { ...tests[i]!.pageState, ...CLUSTER1_STORY.evidence.pageInteraction };
        tests[i]!.attempts = [
          {
            status: 'failed',
            duration: failedDuration,
            error: failingCase.error,
            consoleLogs: themedConsoleLogs(CLUSTER1_STORY.evidence.consoleOnFail, 0, times.console),
            // The first holder also leaves a confirm dialog open at the failure
            // moment — it blocks the page until dismissed, so the Pay action
            // never resolves. Feeds the dialogs lane and the dialog clue.
            dialogs:
              i === 0 && CLUSTER1_STORY.evidence.dialogOnFail
                ? [{ ...CLUSTER1_STORY.evidence.dialogOnFail, closedAt: times.dialogClosedAt }]
                : undefined,
            testAnnotations: [{ type: 'fixme', description: `Known issue — see cluster ${CLUSTER1_STORY.clusterId}` }],
            testSource: buildTestSource(CLUSTER1_STORY, failingCase, CHECKOUT_TESTS[i]!.declLine),
            testSourceFrames: buildSourceFrames(failingCase),
          },
        ];
        // Merge in the story's own themed evidence (a slow quote request, not
        // a payment failure — the Pay button times out because the quote
        // never resolves in time, not because payment itself errors). The
        // quote starts where the story puts it, and the payment authorization
        // the Pay click would send never goes out.
        const own = CLUSTER1_STORY.evidence.failingNetwork ?? [];
        const skipped = [...own, ...(CLUSTER1_STORY.evidence.unreachedNetwork ?? [])];
        const base = buildNetworkRequests().filter(
          (r) => !skipped.some((o) => o.method === r.method && o.url === r.url),
        );
        tests[i]!.networkRequests = [
          ...withStartTimes(base, 0),
          ...own.map((o, k) => ({ ...o, startTime: times.requests[k]! })),
        ];
      }
      // One test fails with a new error signature — a brand-new cluster
      tests[2]!.attempts = [
        {
          status: 'failed',
          duration: vary(4800),
          error: NEW_STRICT_MODE_ERROR,
          ariaSnapshot: STRICT_MODE_ARIA_SNAPSHOT,
          testAnnotations: [{ type: 'fixme', description: 'Duplicate test IDs — needs unique data-testid' }],
        },
      ];
      return tests;
    },
  },
  {
    id: 'flaky',
    label: 'Flaky retries',
    description: 'Two tests fail, then pass on retry — the run stays green',
    icon: 'i-lucide-repeat-2',
    speed: 1.5,
    workers: 4,
    environment: 'staging',
    metadata: () =>
      buildMetadata({
        branch: 'main',
        author: 'Carol White',
        commitMessage: 'chore: update dependencies',
      }),
    tests: () => {
      const tests = baseTests();
      for (const i of [8, 11]) {
        tests[i]!.attempts = [
          {
            status: 'failed',
            duration: vary(5600, 0.08),
            error: FLAKY_ASSERTION_ERROR,
            testAnnotations: [{ type: 'slow' }],
          },
          { status: 'passed', duration: vary(2600), testAnnotations: [{ type: 'slow' }] },
        ];
      }
      return tests;
    },
  },
  {
    id: 'regression',
    label: 'Performance regression',
    description: 'Everything passes, but ~2× slower with degraded endpoints',
    icon: 'i-lucide-trending-down',
    speed: 3.5,
    workers: 4,
    environment: 'staging',
    metadata: () =>
      buildMetadata({
        branch: 'main',
        author: 'David Lee',
        commitMessage: 'perf: switch cart pricing to new rules engine',
      }),
    tests: () => baseTests({ durationFactor: 2.3, slowNetwork: true, slowSteps: true }),
  },
  {
    id: 'interrupted',
    label: 'Interrupted run',
    description: 'The CI job is killed partway through the suite',
    icon: 'i-lucide-octagon-x',
    speed: 1.5,
    workers: 4,
    environment: 'integration',
    stopAfter: 7,
    metadata: () =>
      buildMetadata({
        branch: 'develop',
        author: 'Eva Brown',
        commitMessage: 'ci: bump runner image to ubuntu-26.04',
      }),
    tests: () => baseTests(),
  },
  {
    id: 'cross-browser',
    label: 'Cross-browser run',
    description: 'Tests spread across Chromium, Firefox, and WebKit in parallel',
    icon: 'i-lucide-smartphone',
    speed: 2,
    workers: 3,
    environment: 'staging',
    metadata: () =>
      buildMetadata({
        branch: 'main',
        author: 'Alice Chen',
        commitMessage: 'feat: cross-browser checkout flow',
      }),
    tests: () => {
      const browserKeys = ['chromium', 'firefox', 'webkit'];
      return baseTests().map((t, i) => ({
        ...t,
        browser: BROWSER_CONFIGS[browserKeys[i % browserKeys.length]!],
      }));
    },
  },
  {
    id: 'sharded',
    label: 'Sharded run (2 shards)',
    description: 'Tests split across 2 parallel CI shards that merge into one run, each with its own machine',
    icon: 'i-lucide-layers',
    speed: 2.5,
    workers: 3,
    shardCount: 2,
    environment: 'ci',
    resources: 'clean',
    metadata: () =>
      buildMetadata({
        branch: 'main',
        author: 'Fiona Mehta',
        commitMessage: 'feat: deploy pipeline v2',
        ciInfo: { provider: 'GitHub Actions', runId: '12345678', workflow: 'ci.yml' },
      }),
    tests: () => baseTests({ durationFactor: 0.8 }),
  },
  {
    id: 'wait-heavy',
    label: 'Wait-heavy run',
    description: 'Tests peppered with explicit waitForTimeout sleeps — wasted-time breakdown per test',
    icon: 'i-lucide-hourglass',
    speed: 4,
    workers: 4,
    environment: 'staging',
    metadata: () =>
      buildMetadata({
        branch: 'feature/checkout-refactor',
        author: 'George Tan',
        commitMessage: 'wip: add temporary waits while debugging flaky checkout',
      }),
    tests: () => baseTests({ waitHeavy: true }),
  },
  {
    id: 'healing',
    label: 'Locator healing',
    description: 'A renamed field fails and joins the known cluster — watch the stale-aware recommendation',
    icon: 'i-lucide-wand-sparkles',
    speed: 2,
    workers: 4,
    environment: 'staging',
    metadata: () =>
      buildMetadata({
        branch: 'feature/contact-method',
        author: 'Carol White',
        commitMessage: 'feat: replace the email field with a contact-method selector',
      }),
    tests: () => {
      const tests = baseTests();
      // "should complete checkout with Apple Pay" — the seeded renamed-label
      // cluster's member case. Reusing its exact error (same embedded call
      // site as the seeded locator snapshot) means the healing lookup finds
      // the same stale-flagged recommendation immediately.
      const i = tests.findIndex((t) => t.title === CLUSTER2_STORY.failingCases[0]!.title);
      const failingCase = CLUSTER2_STORY.failingCases[0]!;
      tests[i]!.attempts = [
        {
          status: 'failed',
          duration: vary(10400, 0.05),
          error: failingCase.error,
          ariaSnapshot: CLUSTER2_STORY.aria ?? undefined,
          testAnnotations: [{ type: 'fixme', description: `Known issue — see cluster ${CLUSTER2_STORY.clusterId}` }],
          testSource: buildTestSource(CLUSTER2_STORY, failingCase, CHECKOUT_TESTS[i]!.declLine),
          testSourceFrames: buildSourceFrames(failingCase),
        },
      ];
      return tests;
    },
  },
  {
    id: 'leaky',
    label: 'Leaky run',
    description: 'A login fixture leaves a browser context open in every test, and the machine runs short of CPU',
    icon: 'i-lucide-droplets',
    speed: 2,
    workers: 4,
    environment: 'staging',
    resources: 'leaky',
    metadata: () =>
      buildMetadata({
        branch: 'feature/login-fixture',
        author: 'Dana Lee',
        commitMessage: 'test: log in through a fixture instead of the UI',
      }),
    tests: () => baseTests(),
  },
  {
    id: 'env-drift',
    label: 'Environment drift',
    description: 'A dark-mode, newer-Playwright run surfaces a visibility bug the light-mode baseline never hit',
    icon: 'i-lucide-moon',
    speed: 2,
    workers: 4,
    environment: 'production',
    playwrightVersion: '1.52.0',
    metadata: () =>
      buildMetadata({
        branch: 'main',
        author: 'Priya Singh',
        commitMessage: 'style: ship the dark theme rollout',
      }),
    tests: () => {
      const tests = baseTests();
      // Same browser identity (projectName) as the seeded light-mode passes,
      // so environment-diff baseline pinning (by browser_name) compares this
      // failure against them and surfaces exactly the colorScheme + Playwright
      // version drift as the diff.
      const darkChromium = { ...BROWSER_CONFIGS.chromium, colorScheme: 'dark' };
      for (const t of tests) t.browser = darkChromium;
      tests[3]!.attempts = [
        {
          status: 'failed',
          duration: vary(5200),
          error: ENV_DRIFT_ERROR,
          testAnnotations: [{ type: 'fixme', description: 'Dark-mode visibility regression — see environment diff' }],
        },
      ];
      return tests;
    },
  },
];

// ── Simulation engine ──────────────────────────────────────────────────────

export interface SimulationHooks {
  /** Run row created (status 'initializing') — good time to navigate to it */
  onRunCreated?: (runId: number, projectId: number) => void;
  onProgress?: (completed: number, failed: number, total: number) => void;
  onFinished?: (runId: number, status: string) => void;
}

export interface SimulationController {
  /** Request the run to stop after in-flight tests complete (→ 'interrupted') */
  stopped: boolean;
}

const INIT_DELAY_MS = 1800;
const WORKER_GAP_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives one scenario through the reporter protocol. Resolves when the run
 * has finished (or was interrupted via the controller).
 */
/**
 * Run a sharded simulation: split the scenario's tests across `scenario.shardCount`
 * parallel shards that share the same runLabel, each with its own stream token.
 * The server merges them into a single run.
 */
async function runShardedSimulation(
  scenario: DemoScenario,
  hooks: SimulationHooks = {},
  ctl: SimulationController = { stopped: false },
): Promise<{ runId: number; status: string }> {
  const shardCount = scenario.shardCount ?? 2;
  const allTests = scenario.tests();
  const runLabel = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Split tests round-robin across shards
  const shardedTests = Array.from({ length: shardCount }, () => [] as SimTest[]);
  for (let i = 0; i < allTests.length; i++) {
    shardedTests[i % shardCount]!.push(allTests[i]!);
  }

  // Create shard-specific scenarios (override tests + workers per shard)
  const shardScenarios = shardedTests.map((tests) => {
    const { shardCount: _, ...rest } = scenario;
    return {
      ...rest,
      workers: Math.max(1, Math.ceil(scenario.workers / shardCount)),
      tests: () => tests,
    };
  });

  // Signal that the shared run is being created
  const sharedHooks: SimulationHooks = {
    ...hooks,
    onRunCreated: (runId, projectId) => {
      // Only fire once (first shard to call setup creates the run)
      if (!createdFired) {
        createdFired = true;
        hooks.onRunCreated?.(runId, projectId);
      }
    },
    onFinished: undefined, // we aggregate below
  };
  let createdFired = false;

  const results = await Promise.all(
    shardScenarios.map((s, i) =>
      runSingleSimulation(s as DemoScenario, sharedHooks, ctl, {
        shardIndex: i + 1,
        shardTotal: shardCount,
        runLabel,
        workerOffset: i * Math.max(1, Math.ceil(scenario.workers / shardCount)),
      }),
    ),
  );

  // Aggregate status: failed if any shard failed
  const anyFailed = results.some((r) => r.status === 'failed');
  const finalStatus = anyFailed ? 'failed' : 'passed';
  const runId = results.find((r) => r.runId)?.runId ?? 0;
  hooks.onFinished?.(runId, finalStatus);
  return { runId, status: finalStatus };
}

export async function runSimulation(
  scenario: DemoScenario,
  hooks: SimulationHooks = {},
  ctl: SimulationController = { stopped: false },
): Promise<{ runId: number; status: string }> {
  if (scenario.shardCount && scenario.shardCount > 1) {
    return runShardedSimulation(scenario, hooks, ctl);
  }

  return runSingleSimulation(scenario, hooks, ctl);
}

async function runSingleSimulation(
  scenario: DemoScenario,
  hooks: SimulationHooks = {},
  ctl: SimulationController = { stopped: false },
  shardOverride?: { shardIndex: number; shardTotal: number; runLabel: string; workerOffset?: number },
): Promise<{ runId: number; status: string }> {
  const tests = scenario.tests();
  const startTime = new Date();
  const runLabel = shardOverride?.runLabel;
  const instanceId = runLabel ? `${DEMO_SIMULATOR_INSTANCE_ID}|${runLabel}` : DEMO_SIMULATOR_INSTANCE_ID;

  const setup = await $fetch<{ runId: number; projectId: number; setupToken: string }>('/api/test-runs/setup', {
    method: 'POST',
    body: {
      projectName: DEMO_PROJECT_NAME,
      startTime: startTime.toISOString(),
      environment: scenario.environment,
      label: scenario.runLabel || null,
      instanceId,
      playwrightVersion: scenario.playwrightVersion ?? '1.51.0',
      reporterVersion: '0.7.0',
      shardIndex: shardOverride?.shardIndex,
      shardTotal: shardOverride?.shardTotal,
    },
  });
  const runId = setup.runId;
  hooks.onRunCreated?.(runId, setup.projectId);

  // Let the 'initializing' state be visible for a moment, like a real global setup
  await sleep(INIT_DELAY_MS / scenario.speed);

  const metadata = scenario.metadata();
  const begin = await $fetch<{ streamToken: string }>(`/api/test-runs/${runId}/begin`, {
    method: 'POST',
    body: {
      setupToken: setup.setupToken,
      // Matches the real reporter (stream-manager.ts), which reports the planned
      // suite size up front so the dashboard shows the real total from the first
      // render; the per-status counters build up from the streamed events, and
      // the total is not incremented per row.
      totalTests: tests.length,
      metadata,
      playwrightVersion: scenario.playwrightVersion ?? '1.51.0',
      reporterVersion: '0.7.0',
      shardIndex: shardOverride?.shardIndex,
      shardTotal: shardOverride?.shardTotal,
    },
  });
  const streamToken = begin.streamToken;

  const virtualStart = startTime.getTime();
  const stopAfter = scenario.stopAfter ?? Infinity;
  const durations: number[] = [];
  let completed = 0;
  let failedCount = 0;
  let flakyCount = 0;
  let queueIndex = 0;
  let virtualEnd = virtualStart;

  // What each execution cost, when the scenario sends it, and the tests each
  // worker ran (their virtual spans), for the run's report.
  const testsByWorker = new Map<number, Array<[number, number]>>();
  let artifactBytes = 0;
  let executionSeq = 0;
  function executionResources(durationMs: number, openAtStart: number) {
    if (!scenario.resources) return null;
    const resources = demoExecutionResources({
      seq: executionSeq++,
      durationMs,
      openAtStart,
      leaky: scenario.resources === 'leaky',
    });
    artifactBytes += Object.values(resources.artifactBytes ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
    return resources;
  }

  async function postEvents(events: Array<Record<string, unknown>>): Promise<void> {
    await $fetch(`/api/test-runs/${runId}/events`, {
      method: 'POST',
      body: { streamToken, testCases: events },
    });
  }

  // Each simulated worker pulls tests from a shared queue, mirroring how
  // Playwright distributes tests across parallel workers. Timestamps and
  // durations are reported on a virtual clock so the persisted data stays
  // realistic even though events stream `speed`× faster.
  async function workerLoop(workerIndex: number): Promise<void> {
    let virtualNow = virtualStart + INIT_DELAY_MS;
    // The executions this worker ran so far: in a leaky run each left its page open.
    let ranInWorker = 0;

    while (!ctl.stopped && completed < stopAfter) {
      const test = tests[queueIndex++];
      if (!test) return;

      let finalDuration = test.duration;

      for (let attempt = 0; attempt < test.attempts.length; attempt++) {
        const a = test.attempts[attempt]!;
        const attemptDuration = a.duration ?? test.duration;
        const startedAt = virtualNow;

        await postEvents([
          {
            type: 'begin',
            title: test.title,
            location: test.location,
            workerIndex,
            shardIndex: shardOverride?.shardIndex ?? null,
            startedAt,
            browser: test.browser ?? null,
            suitePath: test.suitePath ?? null,
            suiteConfig: test.suiteConfig ?? null,
          },
        ]);

        // Stream a few of the test's steps live (transient SSE events, like the
        // real reporter) so the demo run page shows the in-row live step readout.
        // Wait steps are the least interesting to watch; the persisted stepEvents
        // still carry them for the timeline. Each live step carries the Playwright
        // category the reporter streams: `expect` for an assertion, `pw:api` otherwise.
        const liveSteps = (test.steps ?? [])
          .filter((s) => s.category !== 'wait')
          .slice(0, 3)
          .map((s) => ({ ...s, category: s.category === 'assertion' ? 'expect' : 'pw:api' }));

        let attemptRemaining = attemptDuration;
        let stepCursor = virtualNow;
        if (liveSteps.length === 0) {
          await sleep(attemptDuration / scenario.speed);
          virtualNow += attemptDuration;
        } else {
          for (const s of liveSteps) {
            const seg = Math.min(Math.max(s.duration, 1), attemptRemaining);
            await postEvents([
              {
                type: 'step-begin',
                title: s.title,
                location: test.location,
                stepCategory: s.category,
                parentTitle: test.title,
                workerIndex,
                startedAt: stepCursor,
              },
            ]);
            await sleep(seg / scenario.speed);
            virtualNow += seg;
            attemptRemaining -= seg;
            await postEvents([
              {
                type: 'step-end',
                title: s.title,
                location: test.location,
                status: 'passed',
                duration: seg,
                stepCategory: s.category,
                parentTitle: test.title,
                workerIndex,
                startedAt: stepCursor,
              },
            ]);
            stepCursor += seg;
            if (attemptRemaining <= 0) break;
          }
          if (attemptRemaining > 0) {
            await sleep(attemptRemaining / scenario.speed);
            virtualNow += attemptRemaining;
          }
        }

        const stamped = test.relativeTimes
          ? stampAttemptTimes(test, a, startedAt)
          : {
              steps: test.steps,
              consoleLogs: a.consoleLogs,
              dialogs: a.dialogs,
              networkRequests: test.networkRequests,
            };

        await postEvents([
          {
            type: 'complete',
            title: test.title,
            location: test.location,
            status: a.status,
            duration: attemptDuration,
            // The effective per-test timeout the real reporter always sends
            // (Playwright's default unless a test overrides it).
            timeout: 30000,
            error: a.error ?? null,
            retries: attempt,
            attempts: test.attempts.slice(0, attempt + 1).map((att, i) => ({
              retry: i,
              status: att.status,
              duration: att.duration ?? test.duration,
              startedAt: startedAt - (attempt - i) * (test.duration + WORKER_GAP_MS),
            })),
            steps: stamped.steps,
            // Remap 0-based step event offsets to absolute epoch ms anchored to
            // this test's actual startedAt, so each test's segments appear in
            // the correct position on the WorkersTimeline.
            stepEvents: test.stepEvents
              ? test.stepEvents.map((e) => ({ ...e, startedAt: startedAt + (e.startedAt as number) }))
              : null,
            slowestStep: test.slowestStep,
            slowestStepDuration: test.slowestStepDuration,
            wastedTimeMs: test.wastedTimeMs ?? null,
            networkRequests: stamped.networkRequests,
            webVitals: test.webVitals,
            pageState: test.pageState ?? null,
            locatorPages: test.steps?.length ? buildLocatorPages() : null,
            aiUsage: (await buildAiUsage({ file: test.file, title: test.title })) ?? null,
            tags: test.tags,
            locks: test.locks,
            testMeta: test.testMeta,
            consoleLogs: stamped.consoleLogs ?? null,
            dialogs: stamped.dialogs ?? null,
            ariaSnapshot: a.ariaSnapshot ?? null,
            testSource: a.testSource ?? null,
            testSourceFrames: a.testSourceFrames ?? null,
            browser: test.browser ?? null,
            workerIndex,
            shardIndex: shardOverride?.shardIndex ?? null,
            startedAt,
            suitePath: test.suitePath ?? null,
            suiteConfig: test.suiteConfig ?? null,
            testAnnotations: a.testAnnotations ?? null,
            resources: executionResources(attemptDuration, ranInWorker),
          },
        ]);

        ranInWorker++;
        const spans = testsByWorker.get(workerIndex) ?? [];
        spans.push([startedAt, startedAt + attemptDuration]);
        testsByWorker.set(workerIndex, spans);
        virtualNow += WORKER_GAP_MS;
        finalDuration = attemptDuration;
      }

      const finalAttempt = test.attempts[test.attempts.length - 1]!;
      completed++;
      durations.push(finalDuration);
      if (finalAttempt.status === 'failed') {
        failedCount++;
      } else if (test.attempts.length > 1) {
        flakyCount++;
      }
      virtualEnd = Math.max(virtualEnd, virtualNow);
      hooks.onProgress?.(completed, failedCount, tests.length);
    }
  }

  await Promise.all(
    Array.from({ length: scenario.workers }, (_, i) => workerLoop(i + (shardOverride?.workerOffset ?? 0))),
  );

  const interrupted = ctl.stopped || completed < tests.length;
  const status = interrupted ? 'interrupted' : failedCount > 0 ? 'failed' : 'passed';

  // The real reporter materializes tests that never ran (maxFailures, CI kill)
  // as `didnotrun` complete events so the run page shows what was planned but
  // never executed — mirror that before finishing the run.
  if (interrupted) {
    // A run cut short after failures stopped on its failure budget; one stopped
    // for any other reason (a CI kill) is a plain interruption.
    const unrunReason = failedCount > 0 ? 'max-failures' : 'interrupted';
    const unrunTests = tests.slice(queueIndex);
    for (const t of unrunTests) {
      await postEvents([
        {
          type: 'complete',
          title: t.title,
          location: t.location,
          status: 'didnotrun',
          duration: 0,
          timeout: 30000,
          retries: 0,
          workerIndex: null,
          shardIndex: shardOverride?.shardIndex ?? null,
          startedAt: null,
          browser: t.browser ?? null,
          suitePath: t.suitePath ?? null,
          suiteConfig: t.suiteConfig ?? null,
          tags: t.tags,
          locks: t.locks,
          testMeta: t.testMeta,
          didNotRunReason: unrunReason,
        },
      ]);
    }
  }

  await $fetch(`/api/test-runs/${runId}/finish`, {
    method: 'POST',
    body: {
      streamToken,
      status,
      duration: virtualEnd - virtualStart,
      totalTests: tests.length,
      passedTests: completed - failedCount,
      failedTests: failedCount,
      skippedTests: 0,
      // Tests that never ran because the run was cut short (interrupted/maxFailures).
      didNotRunTests: tests.length - completed,
      flakyTests: flakyCount,
      durations,
      metadata,
      playwrightVersion: scenario.playwrightVersion ?? '1.51.0',
      reporterVersion: '0.7.0',
      ...(shardOverride ? { shardIndex: shardOverride.shardIndex, shardTotal: shardOverride.shardTotal } : {}),
      ...(scenario.resources
        ? {
            resourceReport: demoResourceReport({
              leaky: scenario.resources === 'leaky',
              wallMs: virtualEnd - virtualStart,
              workers: [...testsByWorker.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([worker, spans]) => ({ worker, tests: spans.length, spans })),
              fixtureFile: 'tests/checkout/fixtures.ts',
              handleTest: { title: CHECKOUT_TESTS.at(-1)!.title, file: CHECKOUT_TESTS.at(-1)!.file },
              artifactBytes,
              shardIndex: shardOverride?.shardIndex ?? null,
            }),
          }
        : {}),
    },
  });

  hooks.onFinished?.(runId, status);
  return { runId, status };
}
