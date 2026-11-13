import { describe, test, expect } from 'vitest';
import { bugContextFrom } from '@piwitests/core/bug-report';
import type { LocatorIndex } from '@piwitests/core/locator-index';
import { computeMissedBy, describeMissedBy } from '../../shared/bug-report-missed-by';
import { couponBugReport } from '../utils/bug-report-sample';

function index(overrides: Partial<LocatorIndex> = {}): LocatorIndex {
  return {
    projectId: 1,
    projectName: 'shop',
    branch: null,
    defaultBranch: 'main',
    branches: [],
    builtAt: null,
    generatedAt: '2026-09-27T00:00:00Z',
    testIdAttributes: null,
    pages: ['/cart', '/checkout'],
    tests: [
      { id: 1, title: 'adds to cart', file: 'tests/cart.spec.ts', suite: [], status: 'passed' },
      { id: 2, title: 'shows the total', file: 'tests/cart.spec.ts', suite: [], status: 'passed' },
      { id: 3, title: 'removes an item', file: 'tests/cart-edit.spec.ts', suite: [], status: 'passed' },
      { id: 4, title: 'pays', file: 'tests/checkout.spec.ts', suite: [], status: 'passed' },
    ],
    locators: [
      {
        locator: "getByRole('button', { name: 'Apply' })",
        lastSeenAt: '2026-09-27T00:00:00Z',
        uses: [
          { test: 0, actions: ['click'], callSites: [], projects: [], branches: [], pages: [0] },
          { test: 2, actions: ['click'], callSites: [], projects: [], branches: [], pages: [0] },
        ],
      },
      {
        locator: "getByTestId('cart-total')",
        lastSeenAt: '2026-09-27T00:00:00Z',
        uses: [
          { test: 1, actions: ['expect.toBeVisible'], callSites: [], projects: [], branches: [], pages: [0] },
          { test: 3, actions: ['expect.toHaveText'], callSites: [], projects: [], branches: [], pages: [1] },
        ],
      },
    ],
    truncated: false,
    ...overrides,
  };
}

describe('computeMissedBy', () => {
  test('counts the tests on the page, those that reach the marked element, and what they assert', () => {
    const report = couponBugReport();
    const missed = computeMissedBy(index(), { steps: report.steps, pageKey: '/cart' });
    expect(missed.page).toBe('/cart');
    expect(missed.visiting.map((t) => t.testCaseId).sort()).toEqual([1, 2, 3]);
    const [target] = missed.targets;
    // The checkout test asserts the text of an element with the same test id, on another page.
    expect(target!.reaching.map((t) => t.testCaseId)).toEqual([2]);
    expect(target!.asserting.map((t) => t.testCaseId)).toEqual([2]);
    expect(target!.assertingSame).toEqual([]);
    expect(missed.mainFile).toBe('tests/cart.spec.ts');
    expect(describeMissedBy(missed)).toBe(
      '3 tests visit /cart; 1 reaches the element marked, and none asserts its text.',
    );
  });

  test('removes the URL mapping’s path prefix from the pages the steps ran on', () => {
    const { steps } = couponBugReport();
    const prefixed = { ...steps, steps: steps.steps.map((step) => ({ ...step, pageUrl: `/app${step.pageUrl}` })) };
    const missed = computeMissedBy(index(), { steps: prefixed, pageKey: '/cart', pathPrefix: '/app' });
    expect(missed.page).toBe('/cart');
    expect(missed.visiting.map((t) => t.testCaseId).sort()).toEqual([1, 2, 3]);
    // Without the prefix, the page the steps ran on is one no test visits.
    expect(computeMissedBy(index(), { steps: prefixed, pageKey: '/cart' }).page).toBe('/app/cart');
  });

  test('keys the marked step’s page through the mapping when the report finished outside its prefix', () => {
    const { steps } = couponBugReport();
    const prefixed = { ...steps, steps: steps.steps.map((step) => ({ ...step, pageUrl: `/app${step.pageUrl}` })) };
    const context = bugContextFrom({
      url: 'https://shop.test/login',
      userAgent: null,
      viewport: null,
      time: 0,
      extensionVersion: null,
      pathPrefix: '/app',
    });
    const missed = computeMissedBy(index(), { steps: prefixed, ...context });
    expect(missed.page).toBe('/cart');
    expect(missed.visiting.map((t) => t.testCaseId).sort()).toEqual([1, 2, 3]);
  });

  test('puts the URL mapping’s tests’ prefix in front of the pages the steps ran on', () => {
    const shifted = index({ pages: ['/app/cart', '/app/checkout'] });
    const missed = computeMissedBy(shifted, {
      steps: couponBugReport().steps,
      pageKey: '/app/cart',
      testPathPrefix: '/app',
    });
    expect(missed.page).toBe('/app/cart');
    expect(missed.visiting.map((t) => t.testCaseId).sort()).toEqual([1, 2, 3]);
  });

  test('says when no run recorded pages', () => {
    const missed = computeMissedBy(index({ pages: undefined }), { steps: couponBugReport().steps, pageKey: '/cart' });
    expect(missed.pagesKnown).toBe(false);
    expect(describeMissedBy(missed)).toContain('unknown');
  });

  test('without an index, nothing is known', () => {
    const missed = computeMissedBy(null, { steps: couponBugReport().steps, pageKey: '/cart' });
    expect(missed.visiting).toEqual([]);
    expect(missed.targets).toEqual([]);
  });
});

describe('detectReportedBugEscapes', () => {
  test('one blind spot per page, naming each open report', async () => {
    const { detectReportedBugEscapes } = await import('../../shared/handlers/scenario-gaps');
    const gaps = detectReportedBugEscapes([
      { id: 37, title: 'Coupon not applied', pageKey: '/cart' },
      { id: 38, title: 'Total rounds down', pageKey: '/cart' },
      { id: 39, title: 'No page', pageKey: null },
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      detector: 'escaped-defect',
      class: 'blind-spot',
      key: 'page:/cart',
      title: '2 reported bugs escaped the suite on /cart',
    });
    expect(gaps[0]!.evidence[0]).toContain('Bug report #37');
  });
});
