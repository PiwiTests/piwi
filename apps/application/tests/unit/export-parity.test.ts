import { describe, it, expect } from 'vitest';
import { renderExportHtml } from '../../shared/export/render-html';
import { renderExportMarkdown } from '../../shared/export/render-markdown';
import { caseFacts, clusterFacts, diagnosisFacts } from '../../shared/export/fields';
import type { ExportBundle, ExportCase, ExportRunTest } from '../../shared/export/types';

/**
 * The HTML report and the Markdown export must state the same facts — someone
 * pasting the Markdown into a ticket should not silently lose the browser, the
 * shard or the AI diagnosis category. Both read `fields.ts`, and these assert
 * neither renderer quietly stops emitting what it lists.
 */

const diagnosis = {
  status: 'completed',
  category: 'product-bug',
  confidence: 'high',
  summary: 'The pay button renders three times.',
  rootCause: 'The gallery duplicates its slot.',
  details: {
    severity: 'major',
    affectedArea: 'checkout',
    evidence: ['three matching buttons in the ARIA tree'],
    suggestedFix: { description: 'Scope the locator.', patch: '--- a\n+++ b\n' },
  },
};

const fullCase: ExportCase = {
  executionId: 533,
  testCaseId: 7,
  title: 'checkout shows the total',
  filePath: 'tests/checkout.spec.ts',
  location: 'tests/checkout.spec.ts:12:5',
  status: 'failed',
  slug: 'checkout-533',
  detail: {
    duration: 7800,
    retries: 1,
    startedAt: 1_760_000_000_000,
    error: 'TimeoutError: locator.click',
    testRun: { id: 43, project: { id: 1, name: 'web', label: 'Web' } },
    browser: { projectName: 'Chromium' },
    workerIndex: 0,
    shardIndex: 2,
    isNewRegression: true,
    isNewFlaky: true,
    wastedTimeMs: 3000,
    slowestStep: 'Compare against baseline',
    slowestStepDuration: 3000,
    steps: [{ title: 'click pay', category: 'action', duration: 120 }],
    consoleLogs: [{ type: 'error', text: 'total is undefined' }],
    networkRequests: [{ method: 'GET', status: 500, duration: 42, url: '/api/total' }],
    testSource: "await page.getByTestId('pay').click();",
    testSourceFrames: [{ file: 'tests/checkout.spec.ts', line: 12, snippet: 'click()' }],
    ariaSnapshot: '- button "Pay now"',
    pageState: { url: 'https://shop.example/checkout' },
    webVitals: { paint: { fcp: 120 } },
  },
  traces: [],
  diagnosis,
  assets: [
    {
      storagePath: 'p/shot.png',
      zipPath: 'evidence/checkout-533/screenshots/shot.png',
      kind: 'screenshot',
      name: 'shot.png',
      contentType: 'image/png',
      size: 4096,
    },
  ],
};

const clusterBundle: ExportBundle = {
  kind: 'cluster',
  generatedAt: '2026-01-01T00:00:00.000Z',
  piwiVersion: '0.19.0',
  sourceUrl: 'https://piwi.example.com/failure-clusters/3',
  title: 'strict mode violation',
  project: { id: 1, name: 'web', label: 'Web' },
  cluster: {
    signature: 'strict mode violation',
    errorType: 'strict-mode',
    selector: "getByRole('button')",
    status: 'open',
    occurrences: 12,
    affectedTests: 2,
    firstSeenAt: 1_759_000_000_000,
    lastSeenAt: 1_760_000_000_000,
    triageNote: 'looked at on Monday',
    diagnosis,
  },
  cases: [fullCase],
  truncatedCases: [{ testCaseId: 9, title: 'cart badge updates', filePath: 'tests/cart.spec.ts' }],
  omitted: [{ name: 'big.webm', kind: 'video', bytes: 90_000_000, reason: 'too-large' }],
};

const html = renderExportHtml(clusterBundle, { assetUrl: (a) => a.zipPath });
const markdown = renderExportMarkdown(clusterBundle);

/** Values are escaped in HTML, so compare against the decoded text. */
const htmlText = html
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const declaredFacts = [
  ...caseFacts(fullCase),
  ...clusterFacts(clusterBundle.cluster as Record<string, unknown>),
  ...diagnosisFacts(diagnosis),
].filter(([, v]) => v != null && v !== '') as [string, string][];

describe('HTML and Markdown state the same facts', () => {
  it.each(declaredFacts)('both render the %s label', (label) => {
    expect(htmlText).toContain(label);
    expect(markdown).toContain(label);
  });

  it.each(declaredFacts)('both render the %s value (%s)', (_label, value) => {
    expect(htmlText).toContain(value);
    expect(markdown).toContain(value);
  });

  it.each([
    ['error text', 'TimeoutError: locator.click'],
    ['diagnosis summary', 'The pay button renders three times.'],
    ['root cause', 'The gallery duplicates its slot.'],
    ['diagnosis evidence', 'three matching buttons in the ARIA tree'],
    ['suggested fix description', 'Scope the locator.'],
    ['step title', 'click pay'],
    ['console message', 'total is undefined'],
    ['network url', '/api/total'],
    ['test source', 'getByTestId'],
    ['call-stack frame', 'tests/checkout.spec.ts:12'],
    ['aria snapshot', 'Pay now'],
    ['page state', 'shop.example/checkout'],
    ['web vitals', 'fcp'],
    ['representative error', 'strict mode violation'],
    ['truncated member', 'cart badge updates'],
    ['omitted evidence', 'big.webm'],
    ['omission reason', 'larger than the per-file inline limit'],
    ['evidence file name', 'shot.png'],
  ])('both include the %s', (_what, needle) => {
    expect(htmlText).toContain(needle);
    expect(markdown).toContain(needle);
  });

  it.each(['Steps', 'Console', 'Network', 'Test source', 'Call stack', 'ARIA snapshot', 'Page state', 'Web vitals'])(
    'both carry the %s section',
    (section) => {
      expect(htmlText).toContain(section);
      expect(markdown).toContain(section);
    },
  );
});

describe('format-specific behavior', () => {
  it('embeds the screenshot in HTML but only names it in Markdown', () => {
    expect(html).toContain('<img class="shot" src="evidence/checkout-533/screenshots/shot.png"');
    expect(markdown).not.toContain('<img');
    expect(markdown).toContain('shot.png');
  });

  it('escapes Markdown table cells so a piped URL cannot break the row', () => {
    const piped = renderExportMarkdown({
      ...clusterBundle,
      cases: [
        {
          ...fullCase,
          detail: { ...fullCase.detail, networkRequests: [{ method: 'GET', status: 200, url: '/a|b' }] },
        },
      ],
    });
    expect(piped).toContain('/a\\|b');
  });
});

describe('HTML and Markdown state the same reading of a failure', () => {
  const richCase: ExportCase = {
    ...fullCase,
    detail: {
      ...fullCase.detail,
      title: 'checkout shows the total',
      suitePath: ['Checkout', 'Total'],
      verdict: {
        headline: 'Clicked a button that never enabled',
        detail: 'element is not enabled',
        owner: { name: '@pay' },
      },
      quarantined: true,
      tags: ['smoke'],
      steps: [{ title: 'Click', subtitle: "getByRole('button')", category: 'action', duration: 120, failed: true }],
    },
  };
  const cluster: ExportBundle = {
    ...clusterBundle,
    cases: [richCase],
    cluster: {
      ...(clusterBundle.cluster as Record<string, unknown>),
      latestHeadline: { parts: [{ kind: 'text', text: 'Expected 26 rows, found 51' }], detail: 'rows in the table' },
      clusterState: { sentence: 'Fixed in run #62 and verified, still marked open.' },
      owner: { name: '@admin' },
      occurrenceSeries: [
        { runId: 1, startedAt: '2026-10-27T00:00:00Z', occurrences: 0 },
        { runId: 2, startedAt: '2026-10-28T00:00:00Z', occurrences: 3 },
      ],
    },
  };
  const decode = (s: string) =>
    s
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  const htmlOut = decode(renderExportHtml(cluster, { assetUrl: () => null }));
  const mdOut = renderExportMarkdown(cluster);

  it.each([
    ['full name', 'Checkout › Total › checkout shows the total'],
    ['headline', 'Clicked a button that never enabled'],
    ['headline detail', 'element is not enabled'],
    ['owner', 'Owner @pay'],
    ['quarantine', 'Quarantined'],
    ['tag', 'smoke'],
    ['step target', "Click getByRole('button')"],
    ['failed step', 'action · failed'],
    ['cluster headline', 'Expected 26 rows, found 51'],
    ['cluster headline detail', 'rows in the table'],
    ['cluster state', 'Fixed in run #62 and verified, still marked open.'],
    ['cluster owner', 'Owner @admin'],
    ['recent runs', 'Failed in 1 of the last 2 runs'],
  ])('both state the %s', (_what, needle) => {
    expect(htmlOut.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).toContain(needle);
    expect(mdOut.replace(/\s+/g, ' ')).toContain(needle);
  });
});

describe('HTML and Markdown state the same run', () => {
  const tests: ExportRunTest[] = [
    {
      executionId: 1,
      testCaseId: 1,
      title: 'pays',
      suitePath: ['Checkout'],
      filePath: 'tests/pay.spec.ts',
      location: 'tests/pay.spec.ts:4:3',
      browser: 'chromium',
      repetition: null,
      status: 'failed',
      flaky: false,
      retries: 1,
      duration: 30_000,
      error: 'TimeoutError: Timeout 5000ms exceeded',
      failureClusterId: 3,
    },
    {
      executionId: 2,
      testCaseId: 2,
      title: 'adds to cart',
      suitePath: [],
      filePath: 'tests/cart.spec.ts',
      location: 'tests/cart.spec.ts:8:3',
      browser: 'firefox',
      repetition: null,
      status: 'passed',
      flaky: true,
      retries: 1,
      duration: 900,
      error: null,
      failureClusterId: null,
    },
    {
      executionId: 3,
      testCaseId: 3,
      title: 'logs in',
      suitePath: [],
      filePath: 'tests/login.spec.ts',
      location: 'tests/login.spec.ts:2:3',
      browser: 'chromium',
      repetition: null,
      status: 'failed',
      flaky: false,
      retries: 0,
      duration: 1200,
      error: 'Error: boom',
      failureClusterId: null,
    },
  ];
  const run: ExportBundle = {
    kind: 'run',
    generatedAt: '2026-01-01T00:00:00.000Z',
    piwiVersion: '0.62.0',
    sourceUrl: null,
    title: 'Run #7',
    project: { id: 1, name: 'web', label: 'Web' },
    cluster: null,
    run: {
      detail: {
        id: 7,
        status: 'failed',
        branch: 'main',
        environment: 'staging',
        startTime: '2026-10-28T13:04:00Z',
        duration: 64_000,
        totalTests: 3,
        passedTests: 1,
        failedTests: 2,
        flakyTests: 1,
      },
      tests,
      groups: [
        {
          clusterId: 3,
          title: 'Timeout 5000ms exceeded',
          status: 'open',
          isNew: true,
          executionIds: [1],
          diagnosis: 'The pay button waits on a slow quote.',
        },
      ],
    },
    cases: [{ ...fullCase, executionId: 1 }],
    truncatedCases: [{ testCaseId: 3, title: 'logs in', filePath: 'tests/login.spec.ts' }],
    omitted: [],
  };
  const htmlText = renderExportHtml(run, { assetUrl: () => null })
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const md = renderExportMarkdown(run).replace(/\s+/g, ' ');

  it.each([
    ['headline', '2 of 3 tests failed, 1 flaky'],
    ['branch', 'main'],
    ['root cause', 'Timeout 5000ms exceeded'],
    ['diagnosis', 'The pay button waits on a slow quote.'],
    ['failing test error', 'TimeoutError: Timeout 5000ms exceeded'],
    ['failure no cluster holds', 'Not grouped'],
    ['flaky test', 'adds to cart'],
    ['full name in the list of tests', 'Checkout › pays'],
    ['tests by outcome', '2 failed (67%)'],
    ['detail section', 'Failures in detail'],
    ['failing test past the cap', 'Other failing tests (1, evidence not included)'],
  ])('both state the %s', (_what, needle) => {
    expect(htmlText).toContain(needle);
    expect(md).toContain(needle);
  });
});
