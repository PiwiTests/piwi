import { describe, test, expect } from 'vitest';
import { buildFailureClues, type FailureClueInput } from '#shared/failure-clues';
import { buildFailureTimeline, type FailureTimelineInput } from '#shared/failure-timeline';
import { parsePlaywrightError } from '#shared/error-parse';

const T0 = 1_700_000_000_000;

/** A failing execution with a navigate step and a failed click on `Pay`. */
function timelineInput(overrides: Partial<FailureTimelineInput> = {}): FailureTimelineInput {
  return {
    startedAt: T0,
    duration: 5_000,
    timeout: 30_000,
    status: 'failed',
    steps: [
      { title: "page.goto('/checkout')", category: 'action', duration: 1_000, startTime: T0 },
      {
        title: "locator.click getByRole('button', { name: 'Pay' })",
        category: 'action',
        duration: 3_500,
        startTime: T0 + 1_500,
        error: 'element is not enabled',
      },
    ],
    ...overrides,
  };
}

const PAY_ERROR = [
  'locator.click: Timeout 30000ms exceeded.',
  'Call log:',
  "  - waiting for getByRole('button', { name: 'Pay' })",
  '  - element is not enabled',
].join('\n');

/** A benign clue input: a valid timeline, no triggering signals. */
function baseInput(overrides: Partial<FailureClueInput> = {}): FailureClueInput {
  const timeline = buildFailureTimeline(timelineInput());
  return {
    execution: { id: 10, testCaseId: 1, status: 'failed', duration: 5_000, browser: 'chromium', startedAt: T0 },
    parsedError: parsePlaywrightError(PAY_ERROR),
    timeline,
    healing: null,
    ariaSnapshot: null,
    appState: null,
    environmentDiff: null,
    networkRequests: [],
    consoleLogs: [],
    browserPeers: [],
    workerExecutions: [],
    cluster: null,
    timeout: 30_000,
    slowRequestMs: 1_500,
    ...overrides,
  };
}

/** The ranked clue list (buildFailureClues now returns `{ clues, story }`). */
function runClues(input: FailureClueInput) {
  return buildFailureClues(input).clues;
}

function rules(input: FailureClueInput): string[] {
  return runClues(input).map((c) => c.rule);
}

describe('buildFailureClues — wrong-page from a navigation step params.url', () => {
  test('the last navigation step params.url stands in when app state carries no URL', () => {
    const timeline = buildFailureTimeline(
      timelineInput({
        steps: [
          {
            title: 'Navigate',
            subtitle: '/login',
            category: 'navigation',
            duration: 1_000,
            startTime: T0,
            params: { url: 'https://shop.example.com/login' },
          },
          {
            title: 'Expect "toBeVisible"',
            subtitle: "getByText('Dashboard')",
            category: 'assertion',
            duration: 3_500,
            startTime: T0 + 1_500,
            error: 'not visible',
            params: { locator: "getByText('Dashboard')" },
          },
        ],
      }),
    );
    const clue = runClues(baseInput({ appState: null, timeline })).find((c) => c.rule === 'wrong-page');
    expect(clue?.title).toBe('The test ended on /login');
  });

  test('a captured app-state URL still wins over the navigation step', () => {
    const timeline = buildFailureTimeline(
      timelineInput({
        steps: [
          {
            title: 'Navigate',
            subtitle: '/login',
            category: 'navigation',
            duration: 1_000,
            startTime: T0,
            params: { url: 'https://shop.example.com/login' },
          },
        ],
      }),
    );
    const clue = runClues(baseInput({ appState: { url: 'https://shop.example.com/error' }, timeline })).find(
      (c) => c.rule === 'wrong-page',
    );
    expect(clue?.title).toBe('The test ended on /error');
  });
});

describe('buildFailureClues — robustness', () => {
  test('empty input never throws and yields no clues', () => {
    const report = buildFailureClues({
      execution: { id: 1, testCaseId: 1 },
      parsedError: null,
      timeline: null,
      healing: null,
      ariaSnapshot: null,
      appState: null,
      environmentDiff: null,
      networkRequests: [],
      consoleLogs: [],
      browserPeers: [],
      workerExecutions: [],
      cluster: null,
      timeout: null,
    });
    expect(report.clues).toEqual([]);
    expect(report.story).toBeNull();
  });

  test('caps the ranked list at 8 clues', () => {
    // Fire many rules at once and assert the cap holds.
    const timeline = buildFailureTimeline(
      timelineInput({
        networkRequests: [{ method: 'GET', url: '/api/quote', status: 504, duration: 2_000, startTime: T0 + 2_000 }],
      }),
    );
    const input = baseInput({
      timeline,
      networkRequests: [
        {
          method: 'GET',
          url: '/api/quote',
          status: 504,
          duration: 2_000,
          startTime: T0 + 2_000,
          serverLogs: [{ level: 'error', message: 'upstream 500', timestamp: T0 + 3_000 }],
        },
      ],
      ariaSnapshot: 'button "Pay" [disabled]',
      appState: { url: 'https://app.test/login' },
      environmentDiff: { status: 'ok', entries: [{ key: 'viewport', label: 'Viewport' }] },
      browserPeers: [
        { browser: 'chromium', status: 'failed' },
        { browser: 'firefox', status: 'passed' },
      ],
      workerExecutions: [
        { id: 9, testCaseId: 2, title: 'prior test', status: 'failed', startedAt: T0 - 1_000 },
        { id: 10, testCaseId: 1, title: 'this test', status: 'failed', startedAt: T0 },
      ],
      cluster: { fixCommit: 'abc1234def', fixLandedRunId: 3, fixVerification: 'regressed' },
      consoleLogs: [{ type: 'error', text: 'Pay button stays disabled', timestamp: T0 + 3_000 }],
    });
    expect(runClues(input).length).toBeLessThanOrEqual(8);
  });

  test('ranks strong clues before weaker ones', () => {
    const input = baseInput({
      environmentDiff: { status: 'ok', entries: [{ key: 'colorScheme', label: 'Color scheme' }] }, // weak
      networkRequests: [{ method: 'POST', url: '/api/pay', status: 500, duration: 200, startTime: T0 + 4_500 }], // strong
    });
    const ordered = runClues(input);
    expect(ordered[0]!.strength).toBe('strong');
    expect(ordered[ordered.length - 1]!.strength).toBe('weak');
  });
});

describe('failed-request-before-failure', () => {
  test('positive: a 5xx request that ended in the lead window', () => {
    const input = baseInput({
      networkRequests: [{ method: 'GET', url: '/api/quote', status: 504, duration: 1_500, startTime: T0 + 2_000 }],
    });
    const clue = runClues(input).find((c) => c.rule === 'failed-request-before-failure');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('strong');
    expect(clue!.detail).toContain('/api/quote');
    expect(clue!.detail).toContain('504');
    expect(clue!.citations[0]).toEqual({ section: 'networkRequests', index: 0 });
  });

  test('negative: a 200 request in the same window does not fire', () => {
    const input = baseInput({
      networkRequests: [{ method: 'GET', url: '/api/quote', status: 200, duration: 1_500, startTime: T0 + 2_000 }],
    });
    expect(rules(input)).not.toContain('failed-request-before-failure');
  });

  test('a request that failed without a response names the error the browser reported', () => {
    const input = baseInput({
      networkRequests: [
        {
          method: 'GET',
          url: '/api/quote',
          status: 0,
          duration: 1_500,
          startTime: T0 + 2_000,
          failure: 'net::ERR_CONNECTION_RESET',
        },
      ],
    });
    const clue = runClues(input).find((c) => c.rule === 'failed-request-before-failure');
    expect(clue!.title).toBe('GET /api/quote failed with net::ERR_CONNECTION_RESET');
  });

  test('a request with no response and no recorded error reads as aborted', () => {
    const input = baseInput({
      networkRequests: [{ method: 'GET', url: '/api/quote', status: 0, duration: 1_500, startTime: T0 + 2_000 }],
    });
    const clue = runClues(input).find((c) => c.rule === 'failed-request-before-failure');
    expect(clue!.title).toBe('GET /api/quote was aborted');
  });
});

describe('slow-request-overlapping-failure', () => {
  test('positive: a request slower than the threshold overlapping the failed step', () => {
    const input = baseInput({
      networkRequests: [{ method: 'GET', url: '/api/slow', status: 200, duration: 3_000, startTime: T0 + 1_800 }],
    });
    const clue = runClues(input).find((c) => c.rule === 'slow-request-overlapping-failure');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('medium');
    expect(clue!.detail).toContain('/api/slow');
  });

  test('negative: a fast request does not fire', () => {
    const input = baseInput({
      networkRequests: [{ method: 'GET', url: '/api/fast', status: 200, duration: 200, startTime: T0 + 1_800 }],
    });
    expect(rules(input)).not.toContain('slow-request-overlapping-failure');
  });

  describe('a failed step that is the test’s own HTTP call', () => {
    // A slow page request in flight while the test's own API call ran.
    const pageRequest = { method: 'GET', url: '/api/notifications', status: 200, duration: 3_000, startTime: T0 + 500 };

    function apiCallInput(subtitle: string, duration = 3_800) {
      const timeline = buildFailureTimeline(
        timelineInput({
          timeout: 4_000,
          duration: 4_000,
          networkRequests: [pageRequest],
          steps: [{ title: 'POST', subtitle, category: 'pw:api', duration, startTime: T0, error: 'server error' }],
        }),
      );
      return baseInput({ timeline, timeout: 4_000, networkRequests: [pageRequest], parsedError: null });
    }

    test('names the call, not a page request that happened to overlap it', () => {
      const clue = runClues(apiCallInput('https://app.test/api/seed?run=1')).find(
        (c) => c.rule === 'slow-request-overlapping-failure',
      );
      expect(clue!.title).toBe('POST /api/seed took 3.8 s');
      expect(clue!.detail).not.toContain('/api/notifications');
      expect(clue!.citations).toEqual([{ section: 'steps' }]);
    });

    test('reads the path of a URL shown without its scheme', () => {
      const { story } = buildFailureClues(apiCallInput('app.test/api/seed'));
      expect(story?.id).toBe('timing');
      expect(story!.sentence).toMatch(/waiting on \/api\/seed\.$/);
    });

    test('a fast call fires nothing, even with a slow page request in flight', () => {
      expect(rules(apiCallInput('https://app.test/api/seed', 200))).not.toContain('slow-request-overlapping-failure');
    });
  });
});

describe('console-mentions-target', () => {
  test('positive: a console error naming the failing locator', () => {
    const input = baseInput({
      consoleLogs: [{ type: 'error', text: 'The Pay button stays disabled after quote', timestamp: T0 + 3_000 }],
    });
    const clue = runClues(input).find((c) => c.rule === 'console-mentions-target');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('strong');
    expect(clue!.citations[0]).toEqual({ section: 'console', index: 0 });
    // The detail names the target as the locator wrote it.
    expect(clue!.detail).toContain('mentions "Pay"');
  });

  test('a console line that writes the name in another case still names the target', () => {
    const input = baseInput({
      consoleLogs: [{ type: 'error', text: 'PAY button: quote missing', timestamp: T0 + 3_000 }],
    });
    expect(rules(input)).toContain('console-mentions-target');
  });

  test('a warning that names the target is medium strength', () => {
    const input = baseInput({
      consoleLogs: [{ type: 'warning', text: 'Pay still pending', timestamp: T0 + 3_000 }],
    });
    const clue = runClues(input).find((c) => c.rule === 'console-mentions-target');
    expect(clue?.strength).toBe('medium');
  });

  test('negative: an unrelated console error does not fire', () => {
    const input = baseInput({
      consoleLogs: [{ type: 'error', text: 'favicon.ico failed to load', timestamp: T0 + 3_000 }],
    });
    expect(rules(input)).not.toContain('console-mentions-target');
  });
});

describe('page-structure-changed', () => {
  test('medium when the locator resolved (a rename is context, not cause)', () => {
    // The base PAY_ERROR resolves the locator then fails on "not enabled", so the
    // structure change cannot be the cause and stays medium.
    const input = baseInput({
      pageDiff: {
        locatorChange: { type: 'renamed', role: 'button', name: 'Pay now', oldName: 'Pay' },
      },
    });
    const clue = runClues(input).find((c) => c.rule === 'page-structure-changed');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('medium');
    expect(clue!.detail).toContain('"Pay"');
    expect(clue!.citations[0]!.section).toBe('pageDiff');
  });

  test('strong when the locator never resolved (a rename can be the cause)', () => {
    const notFound = [
      'locator.click: Timeout 10000ms exceeded.',
      'Call log:',
      "  - waiting for getByRole('button', { name: 'Pay' })",
    ].join('\n');
    const input = baseInput({
      parsedError: parsePlaywrightError(notFound),
      pageDiff: {
        locatorChange: { type: 'renamed', role: 'button', name: 'Pay now', oldName: 'Pay' },
      },
    });
    const clue = runClues(input).find((c) => c.rule === 'page-structure-changed');
    expect(clue!.strength).toBe('strong');
  });

  test('positive: a removed node the locator names', () => {
    const input = baseInput({
      pageDiff: { locatorChange: { type: 'removed', role: 'button', name: 'Refresh', oldName: null } },
    });
    expect(rules(input)).toContain('page-structure-changed');
  });

  test('negative: a moved node is not a broken-locator signal', () => {
    const input = baseInput({
      pageDiff: { locatorChange: { type: 'moved', role: 'button', name: 'Pay', oldName: null } },
    });
    expect(rules(input)).not.toContain('page-structure-changed');
  });

  test('negative: no locator change means no clue', () => {
    expect(rules(baseInput({ pageDiff: { locatorChange: null } }))).not.toContain('page-structure-changed');
    expect(rules(baseInput())).not.toContain('page-structure-changed');
  });
});

describe('backend-error-attached', () => {
  test('positive: a request in the window with an error-level server log', () => {
    const input = baseInput({
      networkRequests: [
        {
          method: 'POST',
          url: '/api/pay',
          status: 200,
          duration: 300,
          startTime: T0 + 2_000,
          serverLogs: [{ level: 'error', message: 'NullPointer in PaymentService', timestamp: T0 + 2_100 }],
        },
      ],
    });
    const clue = runClues(input).find((c) => c.rule === 'backend-error-attached');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('strong');
    expect(clue!.citations[0]).toEqual({ section: 'serverLogs', index: 0 });
  });

  test('negative: only info-level server logs do not fire', () => {
    const input = baseInput({
      networkRequests: [
        {
          method: 'POST',
          url: '/api/pay',
          status: 200,
          duration: 300,
          startTime: T0 + 2_000,
          serverLogs: [{ level: 'info', message: 'handled payment', timestamp: T0 + 2_100 }],
        },
      ],
    });
    expect(rules(input)).not.toContain('backend-error-attached');
  });
});

describe('element-renamed', () => {
  test('positive: healing reports an element-match rename', () => {
    const input = baseInput({
      healing: {
        source: 'element-match',
        failingLocator: { method: 'getByRole', args: {} },
        fromPriorSuccess: null,
        fromElementMatch: [{ locator: "getByTestId('pay')", method: 'getByTestId', args: {}, score: 100 }],
        fromAriaSnapshot: null,
        recommendation: {
          recommended: { locator: "getByTestId('pay')", method: 'getByTestId', args: {}, score: 100 },
          durable: null,
          preservesConvention: false,
          hasDurableAlternative: false,
          suggestAddTestId: false,
        },
        capturedAt: null,
      },
    });
    const clue = runClues(input).find((c) => c.rule === 'element-renamed');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('strong');
    expect(clue!.citations[0]).toEqual({ section: 'locatorHealing' });
  });

  test('negative: a prior-run healing with no stale flag does not fire', () => {
    const input = baseInput({
      healing: {
        source: 'prior-run',
        failingLocator: { method: 'getByRole', args: {} },
        fromPriorSuccess: [{ locator: "getByTestId('pay')", method: 'getByTestId', args: {}, score: 100 }],
        fromElementMatch: null,
        fromAriaSnapshot: null,
        recommendation: {
          recommended: { locator: "getByTestId('pay')", method: 'getByTestId', args: {}, score: 100 },
          durable: null,
          preservesConvention: true,
          hasDurableAlternative: false,
          suggestAddTestId: false,
        },
        capturedAt: null,
      },
    });
    expect(rules(input)).not.toContain('element-renamed');
  });
});

describe('element-present-but-blocked', () => {
  test('positive: a not-enabled state with the element in the ARIA snapshot', () => {
    const input = baseInput({
      ariaSnapshot: '- button "Pay" [disabled]\n- textbox "Card number"',
    });
    const clue = runClues(input).find((c) => c.rule === 'element-present-but-blocked');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('strong');
    expect(clue!.citations.map((c) => c.section)).toContain('ariaSnapshot');
    expect(clue!.detail).toMatch(/^The button "Pay" is in the accessibility tree/);
  });

  test('the ARIA snapshot matches whatever case it writes the name in', () => {
    const input = baseInput({ ariaSnapshot: '- button "pay" [disabled]' });
    const clue = runClues(input).find((c) => c.rule === 'element-present-but-blocked');
    expect(clue).toBeTruthy();
    expect(clue!.detail).toContain('The button "Pay"');
  });

  test('negative: the element is absent from the ARIA snapshot', () => {
    const input = baseInput({
      ariaSnapshot: '- heading "Sign in"\n- textbox "Email"',
    });
    expect(rules(input)).not.toContain('element-present-but-blocked');
  });
});

describe('wrong-page', () => {
  test('positive: the page ended on /login', () => {
    const input = baseInput({ appState: { url: 'https://app.test/login?next=/checkout' } });
    const clue = runClues(input).find((c) => c.rule === 'wrong-page');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('strong');
    expect(clue!.detail).toContain('/login');
    expect(clue!.citations[0]).toEqual({ section: 'appState' });
  });

  test('positive: the page drifted away from the last navigation target', () => {
    const input = baseInput({ appState: { url: 'https://app.test/session-expired' } });
    const clue = runClues(input).find((c) => c.rule === 'wrong-page');
    expect(clue).toBeTruthy();
  });

  test('negative: the page stayed on the navigated route', () => {
    const input = baseInput({ appState: { url: 'https://app.test/checkout' } });
    expect(rules(input)).not.toContain('wrong-page');
  });

  test('negative: a click after the last navigation moved the page on', () => {
    const timeline = buildFailureTimeline(
      timelineInput({
        steps: [
          { title: 'Navigate', category: 'navigation', params: { url: '/login' }, duration: 500, startTime: T0 },
          { title: 'Click', category: 'action', duration: 300, startTime: T0 + 600 },
          { title: 'Fill', category: 'input', duration: 2_000, startTime: T0 + 1_000, error: 'Timeout' },
        ],
      }),
    );
    const input = baseInput({ timeline, appState: { url: 'https://app.test/checkout' } });
    expect(rules(input)).not.toContain('wrong-page');
  });

  test('negative: an API request is not a navigation', () => {
    const timeline = buildFailureTimeline(
      timelineInput({
        steps: [
          { title: 'Navigate', category: 'navigation', params: { url: '/account' }, duration: 500, startTime: T0 },
          { title: 'POST', category: 'api', params: { url: '/api/seed' }, duration: 30, startTime: T0 + 600 },
          { title: 'Expect "toBe"', category: 'assertion', duration: 2, startTime: T0 + 700, error: 'boom' },
        ],
      }),
    );
    const input = baseInput({ timeline, appState: { url: 'https://app.test/account' } });
    expect(rules(input)).not.toContain('wrong-page');
  });
});

describe('worker-pollution', () => {
  test('positive: the previous execution on the worker failed', () => {
    const input = baseInput({
      workerExecutions: [
        { id: 9, testCaseId: 2, title: 'leaves a modal open', status: 'failed', startedAt: T0 - 2_000 },
        { id: 10, testCaseId: 1, title: 'this test', status: 'failed', startedAt: T0 },
      ],
    });
    const clue = runClues(input).find((c) => c.rule === 'worker-pollution');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('medium');
    expect(clue!.detail).toContain('leaves a modal open');
    expect(clue!.citations[0]).toEqual({ section: 'runContext' });
  });

  test('negative: the previous execution on the worker passed', () => {
    const input = baseInput({
      workerExecutions: [
        { id: 9, testCaseId: 2, title: 'passing test', status: 'passed', startedAt: T0 - 2_000 },
        { id: 10, testCaseId: 1, title: 'this test', status: 'failed', startedAt: T0 },
      ],
    });
    expect(rules(input)).not.toContain('worker-pollution');
  });
});

describe('timeout-budget', () => {
  test('positive: the failed step used most of the timeout', () => {
    // Failed step 3500ms of a 4000ms timeout → 87%.
    const input = baseInput({ timeout: 4_000 });
    const clue = runClues(input).find((c) => c.rule === 'timeout-budget');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('medium');
    expect(clue!.citations[0]).toEqual({ section: 'steps' });
  });

  test('negative: a small share of a generous timeout does not fire', () => {
    const input = baseInput({ timeout: 30_000 });
    expect(rules(input)).not.toContain('timeout-budget');
  });
});

describe('environment-changed', () => {
  test('positive: a non-empty same-environment diff', () => {
    const input = baseInput({
      environmentDiff: { status: 'ok', entries: [{ key: 'viewport', label: 'Viewport' }] },
    });
    const clue = runClues(input).find((c) => c.rule === 'environment-changed');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('medium');
    expect(clue!.citations[0]).toEqual({ section: 'environmentDiff' });
  });

  test('the environment label is a content change, so it stays medium', () => {
    const input = baseInput({
      environmentDiff: { status: 'ok', entries: [{ key: 'environment', label: 'Environment label' }] },
    });
    const clue = runClues(input).find((c) => c.rule === 'environment-changed');
    expect(clue?.strength).toBe('medium');
  });

  test('a tool-version or color-scheme diff alone stays weak', () => {
    const input = baseInput({
      environmentDiff: {
        status: 'ok',
        entries: [
          { key: 'playwrightVersion', label: 'Playwright version' },
          { key: 'colorScheme', label: 'Color scheme' },
        ],
      },
    });
    const clue = runClues(input).find((c) => c.rule === 'environment-changed');
    expect(clue?.strength).toBe('weak');
  });

  test('negative: an identical environment does not fire', () => {
    const input = baseInput({ environmentDiff: { status: 'ok', entries: [] } });
    expect(rules(input)).not.toContain('environment-changed');
  });
});

describe('browser-specific', () => {
  test('positive: the same test passed on another browser', () => {
    const input = baseInput({
      execution: { id: 10, testCaseId: 1, status: 'failed', duration: 5_000, browser: 'chromium', startedAt: T0 },
      browserPeers: [
        { browser: 'chromium', status: 'failed' },
        { browser: 'firefox', status: 'passed' },
      ],
    });
    const clue = runClues(input).find((c) => c.rule === 'browser-specific');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('medium');
    expect(clue!.detail).toContain('firefox');
    expect(clue!.citations[0]).toEqual({ section: 'browserDistribution' });
  });

  test('negative: the test failed on every browser', () => {
    const input = baseInput({
      browserPeers: [
        { browser: 'chromium', status: 'failed' },
        { browser: 'firefox', status: 'failed' },
      ],
    });
    expect(rules(input)).not.toContain('browser-specific');
  });
});

describe('fixed-before is no longer a clue', () => {
  test('a regressed cluster does not add a clue (the fact moves to the verdict)', () => {
    const input = baseInput({
      cluster: { fixCommit: 'abc1234def567', fixLandedRunId: 3, fixVerification: 'regressed' },
    });
    expect(rules(input)).not.toContain('fixed-before');
  });
});

describe('lock-holder-failed', () => {
  test('positive: the previous holder of the same lock failed', () => {
    const input = baseInput({
      execution: { id: 10, testCaseId: 1, status: 'failed', duration: 5_000, startedAt: T0 + 10_000, locks: ['db'] },
      lockHolders: [
        {
          id: 9,
          title: 'writes an order',
          status: 'failed',
          startedAt: T0,
          duration: 4_000,
          shardIndex: null,
          locks: ['db'],
        },
        {
          id: 10,
          title: 'this test',
          status: 'failed',
          startedAt: T0 + 10_000,
          duration: 5_000,
          shardIndex: null,
          locks: ['db'],
        },
      ],
    });
    const clue = runClues(input).find((c) => c.rule === 'lock-holder-failed');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('strong');
    expect(clue!.detail).toContain('db');
    expect(clue!.detail).toContain('writes an order');
    expect(clue!.citations[0]).toEqual({ section: 'runContext' });
  });

  test('negative: a prior holder that passed does not fire', () => {
    const input = baseInput({
      execution: { id: 10, testCaseId: 1, status: 'failed', duration: 5_000, startedAt: T0 + 10_000, locks: ['db'] },
      lockHolders: [
        {
          id: 9,
          title: 'writes an order',
          status: 'passed',
          startedAt: T0,
          duration: 4_000,
          shardIndex: null,
          locks: ['db'],
        },
        {
          id: 10,
          title: 'this test',
          status: 'failed',
          startedAt: T0 + 10_000,
          duration: 5_000,
          shardIndex: null,
          locks: ['db'],
        },
      ],
    });
    expect(rules(input)).not.toContain('lock-holder-failed');
  });

  test('negative: a failed holder of a different lock does not fire', () => {
    const input = baseInput({
      execution: { id: 10, testCaseId: 1, status: 'failed', duration: 5_000, startedAt: T0 + 10_000, locks: ['db'] },
      lockHolders: [
        { id: 9, title: 'other', status: 'failed', startedAt: T0, duration: 4_000, shardIndex: null, locks: ['api'] },
        {
          id: 10,
          title: 'this test',
          status: 'failed',
          startedAt: T0 + 10_000,
          duration: 5_000,
          shardIndex: null,
          locks: ['db'],
        },
      ],
    });
    expect(rules(input)).not.toContain('lock-holder-failed');
  });
});

describe('lock-cross-shard', () => {
  test('positive: the same lock was held on another shard at the same time', () => {
    const input = baseInput({
      execution: {
        id: 10,
        testCaseId: 1,
        status: 'failed',
        duration: 5_000,
        startedAt: T0,
        locks: ['db'],
        shardIndex: 1,
      },
      lockHolders: [
        { id: 10, title: 'this test', status: 'failed', startedAt: T0, duration: 5_000, shardIndex: 1, locks: ['db'] },
        {
          id: 20,
          title: 'on shard 2',
          status: 'passed',
          startedAt: T0 + 1_000,
          duration: 3_000,
          shardIndex: 2,
          locks: ['db'],
        },
      ],
    });
    const clue = runClues(input).find((c) => c.rule === 'lock-cross-shard');
    expect(clue).toBeTruthy();
    expect(clue!.strength).toBe('medium');
    expect(clue!.detail).toContain('db');
    expect(clue!.citations[0]).toEqual({ section: 'runContext' });
  });

  test('negative: non-overlapping holders on another shard do not fire', () => {
    const input = baseInput({
      execution: {
        id: 10,
        testCaseId: 1,
        status: 'failed',
        duration: 2_000,
        startedAt: T0,
        locks: ['db'],
        shardIndex: 1,
      },
      lockHolders: [
        { id: 10, title: 'this test', status: 'failed', startedAt: T0, duration: 2_000, shardIndex: 1, locks: ['db'] },
        {
          id: 20,
          title: 'later on shard 2',
          status: 'passed',
          startedAt: T0 + 5_000,
          duration: 3_000,
          shardIndex: 2,
          locks: ['db'],
        },
      ],
    });
    expect(rules(input)).not.toContain('lock-cross-shard');
  });

  test('negative: an overlapping holder on the same shard does not fire', () => {
    const input = baseInput({
      execution: {
        id: 10,
        testCaseId: 1,
        status: 'failed',
        duration: 5_000,
        startedAt: T0,
        locks: ['db'],
        shardIndex: 1,
      },
      lockHolders: [
        { id: 10, title: 'this test', status: 'failed', startedAt: T0, duration: 5_000, shardIndex: 1, locks: ['db'] },
        {
          id: 21,
          title: 'same shard',
          status: 'passed',
          startedAt: T0 + 1_000,
          duration: 1_000,
          shardIndex: 1,
          locks: ['db'],
        },
      ],
    });
    expect(rules(input)).not.toContain('lock-cross-shard');
  });
});

describe('dialog-open-on-failure', () => {
  // The failed click ends at T0 + 5000; a dialog closing near it is in the
  // failure window.
  test('flags a dialog that closed around the failure moment', () => {
    const input = baseInput({
      dialogs: [{ type: 'confirm', message: 'Stay signed in?', closedAt: T0 + 4_800 }],
    });
    const clue = runClues(input).find((c) => c.rule === 'dialog-open-on-failure');
    expect(clue).toBeDefined();
    expect(clue!.strength).toBe('strong');
    expect(clue!.title).toContain('confirm');
    expect(clue!.citations).toContainEqual({ section: 'dialogs', index: 0 });
  });

  test('ignores a dialog closed long before the failure window', () => {
    const input = baseInput({
      dialogs: [{ type: 'alert', message: 'Welcome', closedAt: T0 - 60_000 }],
    });
    expect(rules(input)).not.toContain('dialog-open-on-failure');
  });

  test('no dialogs, no clue', () => {
    expect(rules(baseInput())).not.toContain('dialog-open-on-failure');
  });
});

describe('the story pass', () => {
  test('blocked-by-pending-request chains the blocked element, the slow request and the console line', () => {
    const quote = {
      method: 'POST',
      url: 'https://shop.example.com/api/checkout/quote',
      status: 200,
      duration: 3_000,
      startTime: T0 + 1_600,
    };
    const warning = {
      type: 'warning',
      text: 'price quote still pending after 20s — Pay stays disabled',
      timestamp: T0 + 3_500,
    };
    const timeline = buildFailureTimeline(timelineInput({ networkRequests: [quote], consoleLogs: [warning] }));
    const { story } = buildFailureClues(
      baseInput({ timeline, ariaSnapshot: 'button "Pay"', networkRequests: [quote], consoleLogs: [warning] }),
    );
    expect(story?.id).toBe('blocked-by-pending-request');
    expect(story!.clueIds).toContain('element-present-but-blocked');
    expect(story!.clueIds).toContain('slow-request-overlapping-failure');
    expect(story!.clueIds).toContain('console-mentions-target');
    expect(story!.strength).toBe('strong');
    expect(story!.sentence.toLowerCase()).toContain('/api/checkout/quote');
    // The element keeps the name the locator gave it.
    expect(story!.sentence).toMatch(/^The button "Pay" stayed disabled because /);
  });

  test('renamed chains element-renamed and page-structure-changed', () => {
    const healing = {
      source: 'element-match',
      recommendation: { recommended: { locator: "getByRole('button', { name: 'Pay now' })" } },
    } as unknown as FailureClueInput['healing'];
    const { story } = buildFailureClues(
      baseInput({
        healing,
        pageDiff: { locatorChange: { type: 'renamed', role: 'button', name: 'Pay now', oldName: 'Pay' } },
      }),
    );
    expect(story?.id).toBe('renamed');
    expect(story!.sentence).toContain('renamed from "Pay" to "Pay now"');
  });

  test('removed fires when a node is gone and healing found no rename', () => {
    const { story } = buildFailureClues(
      baseInput({
        pageDiff: { locatorChange: { type: 'removed', role: 'button', name: 'Refresh', oldName: null } },
      }),
    );
    expect(story?.id).toBe('removed');
    expect(story!.sentence).toContain('"Refresh"');
  });

  test('wrong-page chains the wrong page and a failed request', () => {
    const failed = {
      method: 'GET',
      url: 'https://app.test/api/session',
      status: 500,
      duration: 100,
      startTime: T0 + 4_700,
    };
    const timeline = buildFailureTimeline(timelineInput({ networkRequests: [failed] }));
    const { story } = buildFailureClues(
      baseInput({ timeline, appState: { url: 'https://app.test/login' }, networkRequests: [failed] }),
    );
    expect(story?.id).toBe('wrong-page');
  });

  test('polluted-worker fires from the previous worker execution failing', () => {
    const { story } = buildFailureClues(
      baseInput({
        workerExecutions: [
          { id: 9, testCaseId: 2, title: 'prior test', status: 'failed', startedAt: T0 - 1_000 },
          { id: 10, testCaseId: 1, title: 'this test', status: 'failed', startedAt: T0 },
        ],
      }),
    );
    expect(story?.id).toBe('polluted-worker');
    expect(story!.sentence).toContain('prior test');
  });

  test('backend-error chains the server log and the request', () => {
    const req = {
      method: 'POST',
      url: 'https://app.test/api/pay',
      status: 500,
      duration: 200,
      startTime: T0 + 4_600,
      serverLogs: [{ level: 'error', message: 'charge failed: card declined', timestamp: T0 + 4_650 }],
    };
    const timeline = buildFailureTimeline(timelineInput({ networkRequests: [req] }));
    const { story } = buildFailureClues(baseInput({ timeline, networkRequests: [req] }));
    expect(story?.id).toBe('backend-error');
    expect(story!.sentence).toContain('card declined');
  });

  test('timing chains the timeout budget and the slow request', () => {
    const slow = {
      method: 'GET',
      url: 'https://app.test/api/report',
      status: 200,
      duration: 4_000,
      startTime: T0 + 1_600,
    };
    const timeline = buildFailureTimeline(
      timelineInput({
        timeout: 4_000,
        duration: 4_000,
        networkRequests: [slow],
        steps: [
          {
            title: "page.waitForResponse('/api/report')",
            category: 'action',
            duration: 3_800,
            startTime: T0,
            error: 'timed out',
          },
        ],
      }),
    );
    const { story } = buildFailureClues(
      baseInput({ timeline, timeout: 4_000, networkRequests: [slow], parsedError: null, ariaSnapshot: null }),
    );
    expect(story?.id).toBe('timing');
  });

  test('no combination yields a null story', () => {
    const { story } = buildFailureClues(
      baseInput({ environmentDiff: { status: 'ok', entries: [{ key: 'viewport' }] } }),
    );
    expect(story).toBeNull();
  });
});

describe('known-flake-suspect', () => {
  const slowCart = {
    kind: 'slow-route' as const,
    label: 'GET /api/cart slower (≥1.6 s)',
    counts: { failuresWith: 7, failures: 8, passesWith: 3, passes: 44 },
    route: 'GET /api/cart',
    thresholdMs: 1_600,
    executionIds: [10, 11],
  };

  test('positive: this failure shows the route the history ranks as a suspect', () => {
    const input = baseInput({
      networkRequests: [
        { method: 'GET', url: 'https://shop.test/api/user', status: 200, duration: 90, startTime: T0 + 100 },
        { method: 'GET', url: 'https://shop.test/api/cart', status: 200, duration: 2_100, startTime: T0 + 200 },
      ],
      flakeSuspects: [slowCart],
    });
    const clue = runClues(input).find((c) => c.rule === 'known-flake-suspect')!;
    expect(clue.strength).toBe('weak');
    expect(clue.title).toBe('A known flake suspect: GET /api/cart slower (≥1.6 s)');
    expect(clue.detail).toBe(
      "GET /api/cart took 2.1 s; it is slow (1.6 s or more) in 7 of this test's 8 failures and 3 of its 44 passes.",
    );
    expect(clue.citations).toEqual([{ section: 'networkRequests', index: 1 }]);
  });

  test('a neighbor suspect names the other test', () => {
    const input = baseInput({
      flakeSuspects: [
        {
          kind: 'alongside',
          label: 'resets catalog alongside',
          counts: { failuresWith: 5, failures: 8, passesWith: 4, passes: 44 },
          title: 'resets catalog',
          executionIds: [10],
        },
      ],
    });
    const clue = runClues(input).find((c) => c.rule === 'known-flake-suspect')!;
    expect(clue.detail).toBe(
      '"resets catalog" was running at the same time; it runs alongside in 5 of this test\'s 8 failures and 4 of its 44 passes.',
    );
    expect(clue.citations).toEqual([{ section: 'recurrenceFlakiness' }]);
  });

  test('strong: a lab run reproduced the suspect', () => {
    const input = baseInput({
      networkRequests: [
        { method: 'GET', url: 'https://shop.test/api/cart', status: 200, duration: 2_100, startTime: T0 + 200 },
      ],
      flakeSuspects: [
        {
          ...slowCart,
          reproduced: {
            label: 'delay GET /api/cart 1.8 s',
            matchingFailures: 3,
            runs: 4,
            controlMatchingFailures: 0,
            controlRuns: 10,
            pValue: 0.011,
          },
        },
      ],
    });
    const clue = runClues(input).find((c) => c.rule === 'known-flake-suspect')!;
    expect(clue.strength).toBe('strong');
    expect(clue.title).toBe('A reproduced flake cause: GET /api/cart slower (≥1.6 s)');
    expect(clue.detail).toBe(
      "GET /api/cart took 2.1 s; it is slow (1.6 s or more) in 7 of this test's 8 failures and 3 of its 44 passes; a lab run reproduced it: 3 of 4 under delay GET /api/cart 1.8 s, against 0 of 10 without, p = 0.011.",
    );
  });

  test('several suspects: the reproduced one is named over higher-ranked untested ones', () => {
    const load = {
      kind: 'load' as const,
      label: '3 or more other tests running at once',
      counts: { failuresWith: 8, failures: 8, passesWith: 10, passes: 44 },
      executionIds: [10],
    };
    const neighbor = {
      kind: 'alongside' as const,
      label: 'resets catalog alongside',
      counts: { failuresWith: 6, failures: 8, passesWith: 4, passes: 44 },
      title: 'resets catalog',
      executionIds: [10],
    };
    const reproduced = {
      label: 'delay GET /api/cart 1.8 s',
      matchingFailures: 3,
      runs: 4,
      controlMatchingFailures: 0,
      controlRuns: 10,
      pValue: 0.011,
    };
    const input = baseInput({
      networkRequests: [
        { method: 'GET', url: 'https://shop.test/api/cart', status: 200, duration: 2_100, startTime: T0 + 200 },
      ],
      flakeSuspects: [load, neighbor, { ...slowCart, reproduced }],
    });
    const clue = runClues(input).find((c) => c.rule === 'known-flake-suspect')!;
    expect(clue.strength).toBe('strong');
    expect(clue.title).toBe('A reproduced flake cause: GET /api/cart slower (≥1.6 s)');

    // Without a reproduced one, the highest-ranked suspect this failure shows is named.
    const untested = baseInput({ flakeSuspects: [{ ...load, executionIds: [99] }, neighbor, slowCart] });
    expect(runClues(untested).find((c) => c.rule === 'known-flake-suspect')!.title).toBe(
      'A known flake suspect: resets catalog alongside',
    );
  });

  test('negative: the suspect is not shown by this execution', () => {
    const input = baseInput({ flakeSuspects: [{ ...slowCart, executionIds: [11, 12] }] });
    expect(rules(input)).not.toContain('known-flake-suspect');
  });

  test('negative: a test with no suspects', () => {
    expect(rules(baseInput({ flakeSuspects: [] }))).not.toContain('known-flake-suspect');
  });
});

describe('a test that stood paused at a breakpoint', () => {
  /**
   * Run 76's shape: a navigation held 4 s at a breakpoint, then the failing assertion held 6 s at another before it
   * ran its own 1 s, of an 8 s timeout. The page answered each stop with a request that lasted the stop.
   */
  const stops = [
    { title: 'Navigate /b', category: 'pause', startedAt: T0 + 150, duration: 4_000, status: 'breakpoint' },
    {
      title: 'Expect "toBeVisible"',
      category: 'pause',
      startedAt: T0 + 4_300,
      duration: 6_000,
      status: 'breakpoint',
    },
  ];
  const duringStops = [
    { method: 'POST', url: '/stop', status: 200, duration: 3_950, startTime: T0 + 160 },
    { method: 'POST', url: '/stop', status: 200, duration: 5_950, startTime: T0 + 4_310 },
  ];

  function pausedTimeline(overrides: Partial<FailureTimelineInput> = {}) {
    return buildFailureTimeline({
      startedAt: T0,
      duration: 1_500,
      timeout: 8_000,
      status: 'failed',
      steps: [
        { title: 'Navigate', subtitle: '/a', category: 'navigation', duration: 100, startTime: T0 },
        { title: 'Navigate', subtitle: '/b', category: 'navigation', duration: 4_150, startTime: T0 + 100 },
        {
          title: 'Expect "toBeVisible"',
          subtitle: "locator('#receipt')",
          category: 'assertion',
          duration: 7_000,
          startTime: T0 + 4_280,
          error: 'element(s) not found',
        },
      ],
      stepEvents: stops,
      networkRequests: duringStops,
      ...overrides,
    });
  }

  function pausedInput(overrides: Partial<FailureClueInput> = {}): FailureClueInput {
    return baseInput({
      execution: { id: 10, testCaseId: 1, status: 'failed', duration: 1_500, browser: 'chromium', startedAt: T0 },
      timeline: pausedTimeline(),
      timeout: 8_000,
      networkRequests: duringStops,
      parsedError: null,
      ...overrides,
    });
  }

  test('reads the failed step’s own time against the timeout, its stop left out', () => {
    const timeline = pausedTimeline();
    expect(timeline.failedStep).toMatchObject({ duration: 7_000, paused: 6_000 });
    expect(rules(pausedInput())).not.toContain('timeout-budget');
    expect(buildFailureClues(pausedInput()).story).toBeNull();
  });

  test('cites no request that was in flight only while the failed step stood stopped', () => {
    expect(rules(pausedInput())).not.toContain('slow-request-overlapping-failure');
    // One in flight once the step ran on is still cited.
    const slow = { method: 'GET', url: '/api/receipt', status: 200, duration: 2_500, startTime: T0 + 9_000 };
    const input = pausedInput({
      timeline: pausedTimeline({ networkRequests: [...duringStops, slow] }),
      networkRequests: [...duringStops, slow],
    });
    const clue = runClues(input).find((c) => c.rule === 'slow-request-overlapping-failure');
    expect(clue?.citations).toEqual([{ section: 'networkRequests', index: 2 }]);
  });

  test('times the test’s own HTTP call without its stop', () => {
    const steps = [{ title: 'POST', subtitle: 'https://app.test/api/seed', category: 'pw:api', duration: 6_400 }];
    const call = (paused: boolean) =>
      buildFailureTimeline({
        startedAt: T0,
        duration: 2_000,
        status: 'failed',
        steps: [{ ...steps[0], startTime: T0, error: 'server error' }],
        stepEvents: paused ? [{ ...stops[1], startedAt: T0 + 10, duration: 4_500 }] : [],
      });
    const clue = (paused: boolean) =>
      runClues(baseInput({ timeline: call(paused), timeout: 8_000, parsedError: null })).find(
        (c) => c.rule === 'slow-request-overlapping-failure',
      );
    expect(clue(false)?.title).toBe('POST /api/seed took 6.4 s');
    expect(clue(true)?.title).toBe('POST /api/seed took 1.9 s');
  });

  test('reaches back past a stop for a request that failed in the test’s last seconds, and says it stood paused', () => {
    // A 500 just before the navigation's 4 s stop: 9.9 s before the failure on the clock, 3.9 s of the test's time.
    const failed = { method: 'GET', url: '/api/cart', status: 500, duration: 50, startTime: T0 + 50 };
    const timeline = pausedTimeline({
      steps: [
        { title: 'Navigate', subtitle: '/b', category: 'navigation', duration: 4_150, startTime: T0 },
        {
          title: 'Click',
          subtitle: "getByRole('button')",
          category: 'action',
          duration: 15_000,
          startTime: T0 + 4_200,
          error: 'element is not enabled',
        },
      ],
      stepEvents: [stops[0], { ...stops[1], startedAt: T0 + 4_250, duration: 10_000 }],
      networkRequests: [failed],
    });
    expect(timeline.window.start).toBe(0);
    const clue = runClues(baseInput({ timeline, networkRequests: [failed], parsedError: null })).find(
      (c) => c.rule === 'failed-request-before-failure',
    );
    expect(clue?.detail).toBe('GET /api/cart returned 500, 19.1 s before the failure, 14.0 s of it paused.');
  });
});
