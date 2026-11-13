import { describe, expect, test } from 'vitest';
import type { LocatorIndex } from '@piwitests/core/locator-index';
import { resolveHealingForCase } from '~~/server/utils/locator-healing';
import {
  predictDiffBreaks,
  predictPatchBreaks,
  toPrLocatorBreaks,
  toRunLocatorBreak,
  type RunLocatorBreak,
} from '#shared/handlers/locator-breaks';
import { buildPrComment, renderLocatorBreaks, type PrSummaryInput } from '#shared/pr-feedback';
import { buildHealEdit } from '#shared/heal-edit';
import { selectHealEdits } from '~~/server/utils/heal/policy';

const use = (test: number, site: string) => ({
  test,
  actions: ['click'],
  callSites: [site],
  projects: ['chromium'],
  branches: ['main'],
});

const INDEX: LocatorIndex = {
  projectId: 1,
  projectName: 'Acme Mugs',
  branch: null,
  defaultBranch: 'main',
  branches: [],
  builtAt: null,
  generatedAt: '2026-09-27T00:00:00Z',
  testIdAttributes: null,
  tests: [
    { id: 11, title: 'pays', file: 'tests/checkout.spec.ts', suite: [], status: 'passed' },
    { id: 12, title: 'pays twice', file: 'tests/checkout.spec.ts', suite: [], status: 'passed' },
    { id: 13, title: 'counts', file: 'tests/cart.spec.ts', suite: [], status: 'passed' },
  ],
  locators: [
    {
      locator: "getByRole('button', { name: 'Pay now' })",
      lastSeenAt: '',
      uses: [use(0, 'tests/checkout.spec.ts:31:5'), use(1, 'tests/checkout.spec.ts:31:5')],
    },
    { locator: "getByText('Total')", lastSeenAt: '', uses: [use(2, 'tests/cart.spec.ts:9:5')] },
  ],
  truncated: false,
};

const PATCH = '@@ -12,3 +12,3 @@\n   <button class="pay" @click="pay">\n-    Pay now\n+    Pay\n   </button>';

describe('predicting from provider patches', () => {
  test('a GitHub-style patch per file gives the break and its rewrite', () => {
    const breaks = predictPatchBreaks(
      [
        { filename: 'src/components/CheckoutButton.vue', status: 'modified', patch: PATCH },
        { filename: 'tests/checkout.spec.ts', status: 'modified', patch: "@@ -1 +1 @@\n-'Total'\n+'Sum'" },
        { filename: 'src/big.vue', status: 'modified' },
      ],
      INDEX,
    ).map(toRunLocatorBreak);
    expect(breaks).toEqual([
      {
        locator: "getByRole('button', { name: 'Pay now' })",
        rewrite: "getByRole('button', { name: 'Pay' })",
        replacements: [['Pay now', 'Pay']],
        anchor: {
          file: 'src/components/CheckoutButton.vue',
          line: 13,
          oldLine: 13,
          kind: 'text',
          before: 'Pay now',
          after: 'Pay',
        },
        confidence: 'likely',
        callSites: ['tests/checkout.spec.ts:31:5'],
        testCaseIds: [11, 12],
      },
    ]);
  });

  test('a whole git diff reads the same way', () => {
    const diff = `diff --git a/src/components/CheckoutButton.vue b/src/components/CheckoutButton.vue\n--- a/src/components/CheckoutButton.vue\n+++ b/src/components/CheckoutButton.vue\n${PATCH}`;
    expect(predictDiffBreaks(diff, INDEX).map((b) => b.rewrite)).toEqual(["getByRole('button', { name: 'Pay' })"]);
  });
});

const PAY_BREAK: RunLocatorBreak = {
  locator: "getByRole('button', { name: 'Pay now' })",
  rewrite: "getByRole('button', { name: 'Pay' })",
  replacements: [['Pay now', 'Pay']],
  anchor: {
    file: 'src/components/CheckoutButton.vue',
    line: 14,
    oldLine: 14,
    kind: 'text',
    before: 'Pay now',
    after: 'Pay',
  },
  confidence: 'likely',
  callSites: ['tests/pages/checkout.page.ts:31:16'],
  testCaseIds: [11, 12],
};

describe('the pull-request section', () => {
  test('lists only the likely breaks none of whose tests ran', () => {
    const possible: RunLocatorBreak = {
      ...PAY_BREAK,
      locator: "getByText('Pay')",
      confidence: 'possible',
      testCaseIds: [13],
    };
    expect(toPrLocatorBreaks([PAY_BREAK, possible], new Set([11, 13]), 'main')).toEqual({
      breaks: [],
      possible: 0,
      baseBranch: 'main',
    });
    const section = toPrLocatorBreaks([PAY_BREAK, possible], new Set([99]), 'main');
    expect(section.breaks.map((b) => b.locator)).toEqual(["getByRole('button', { name: 'Pay now' })"]);
    expect(section.possible).toBe(1);
  });

  test('renders the change, the locator, its tests, call site and rewrite', () => {
    const text = renderLocatorBreaks(toPrLocatorBreaks([PAY_BREAK], new Set(), 'main'))!;
    expect(text).toContain('#### 🟠 Locators this change breaks · 1 not run here');
    expect(text).toContain('`src/components/CheckoutButton.vue:14` `Pay now` → `Pay`');
    expect(text).toContain("`getByRole('button', { name: 'Pay now' })` · 2 tests · `tests/pages/checkout.page.ts:31`");
    expect(text).toContain("→ `getByRole('button', { name: 'Pay' })`");
    expect(renderLocatorBreaks({ breaks: [], possible: 3, baseBranch: null })).toBeNull();
  });

  test('comes after Uncovered changes in the comment', () => {
    const input: PrSummaryInput = {
      runId: 1,
      runUrl: 'https://piwi.example/test-runs/1',
      projectName: 'Acme',
      status: 'passed',
      totalTests: 3,
      passedTests: 3,
      failedTests: 0,
      flakyTests: 0,
      durationMs: 1000,
      newRegressions: [],
      preExisting: [],
      flaky: [],
      newClusters: [],
      wastedMinutes: null,
      hasBaseline: true,
      changeCoverage: {
        totalFiles: 1,
        uncoveredFiles: 0,
        reachedFiles: 1,
        ticketCount: 0,
        windowRuns: 30,
        fileReach: false,
        notCounted: { notObservable: 0, outOfScope: 0, deleted: 0 },
        tickets: [],
      },
      locatorBreaks: toPrLocatorBreaks([PAY_BREAK], new Set(), 'main'),
    };
    const body = buildPrComment(input);
    expect(body.indexOf('Uncovered changes')).toBeLessThan(body.indexOf('Locators this change breaks'));
  });
});

describe('diff-rename healing', () => {
  const error = (loc: string) =>
    `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay now' })\n    at ${loc}`;
  const source = `  30 |   constructor(page) {\n> 31 |     this.pay = page.getByRole("button", { name: "Pay now" });\n     |                     ^\n  32 |   }`;

  test('is offered first when the run broke this chain at this call site', async () => {
    const r = await resolveHealingForCase(
      {
        error: error('/repo/tests/pages/checkout.page.ts:31:16'),
        testSource: source,
        locatorBreaks: [PAY_BREAK],
      },
      [],
      null,
    );
    expect(r.source).toBe('diff-rename');
    expect(r.recommendation?.recommended?.locator).toBe("getByRole('button', { name: 'Pay' })");
    expect(r.recommendation?.recommended?.score).toBe(95);
    expect(r.diffRename).toEqual({
      before: 'Pay now',
      after: 'Pay',
      file: 'src/components/CheckoutButton.vue',
      line: 14,
    });
    // The edit replaces the string inside the author's quotes.
    expect(r.edit?.newLine).toBe('    this.pay = page.getByRole("button", { name: "Pay" });');
  });

  test('is skipped for another call site or another chain', async () => {
    const elsewhere = await resolveHealingForCase(
      { error: error('/repo/tests/other.spec.ts:8:3'), testSource: source, locatorBreaks: [PAY_BREAK] },
      [],
      null,
    );
    expect(elsewhere.source).not.toBe('diff-rename');
    const other = await resolveHealingForCase(
      {
        error: error('/repo/tests/pages/checkout.page.ts:31:16'),
        locatorBreaks: [{ ...PAY_BREAK, locator: "getByText('Pay now')" }],
      },
      [],
      null,
    );
    expect(other.source).not.toBe('diff-rename');
  });

  test('is skipped for a possible break, a bare string that happened to match', async () => {
    const r = await resolveHealingForCase(
      {
        error: error('/repo/tests/pages/checkout.page.ts:31:16'),
        testSource: source,
        locatorBreaks: [{ ...PAY_BREAK, confidence: 'possible' }],
      },
      [],
      null,
    );
    expect(r.source).not.toBe('diff-rename');
  });

  test('an auto-heal pull request can use it', async () => {
    const r = await resolveHealingForCase(
      { error: error('tests/pages/checkout.page.ts:31:16'), testSource: source, locatorBreaks: [PAY_BREAK] },
      [],
      null,
    );
    const edits = selectHealEdits(
      [
        {
          executionId: 5,
          testCaseId: 11,
          title: 'pays',
          filePath: 'tests/checkout.spec.ts',
          clusterId: null,
          owner: null,
        },
      ],
      new Map([[5, r]]),
      { minScore: 80 },
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      source: 'diff-rename',
      newLine: '    this.pay = page.getByRole("button", { name: "Pay" });',
    });
  });

  test('buildHealEdit rewrites literals when given replacements', () => {
    expect(
      buildHealEdit({
        location: 'tests/a.spec.ts:3:1',
        sourceLine: { line: 3, text: "await page.getByText('Apply coupon').click();" },
        failingMethod: 'getByText',
        recommendedLocator: "getByText('Use coupon')",
        literalReplacements: [['Apply coupon', 'Use coupon']],
      })?.newLine,
    ).toBe("await page.getByText('Use coupon').click();");
  });
});
