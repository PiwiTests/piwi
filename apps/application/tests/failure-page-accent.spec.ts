import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * Green belongs to the page's one primary action. On a failing execution and on
 * a cluster with two affected tests, nothing in the evidence card or the
 * affected tests is drawn in the primary color: a failure is rose, a duration
 * that stands out is amber, a selected tab or row is neutral. A card's header
 * icon (`data-card-icon`) is the one exception, the same on every page. And the
 * page shows at most one solid primary button. The unit scan
 * `tests/unit/evidence-accent.test.ts` holds the components' sources to the
 * same rule.
 */

// The error names its locator, so its stack frame is not hashed: the two tests share one cluster.
const sharedError = (frame: string) =>
  `TimeoutError: locator.click: Timeout 3000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })\n    at ${frame}`;

function failingCase(title: string, location: string, startTime: number) {
  return {
    title,
    status: 'failed',
    duration: 6000,
    location,
    error: sharedError(location),
    retries: 0,
    workerIndex: 0,
    startedAt: startTime,
    steps: [
      { title: "page.goto('/checkout')", duration: 800, category: 'navigation', startTime },
      {
        title: 'Fill "ada@example.com"',
        duration: 400,
        category: 'input',
        startTime: startTime + 900,
        params: { locator: "getByLabel('Email')", value: 'ada@example.com' },
      },
      {
        title: "getByRole('button', { name: 'Pay' }).click()",
        duration: 3000,
        category: 'action',
        failed: true,
        startTime: startTime + 1400,
      },
    ],
    networkRequests: [
      {
        method: 'GET',
        url: 'http://localhost:3000/checkout',
        status: 200,
        duration: 180,
        startTime: startTime + 100,
        resourceType: 'document',
      },
      {
        method: 'POST',
        url: 'http://localhost:3000/api/quote',
        status: 200,
        duration: 4000,
        startTime: startTime + 1000,
        resourceType: 'fetch',
      },
    ],
    consoleLogs: [{ type: 'warning', text: 'the price quote is still pending', timestamp: startTime + 2500 }],
  };
}

/**
 * What under `selector` is drawn in the primary color: every element whose color,
 * background, border, ring (box shadow), fill or stroke changes when the primary
 * color does. Swapping the color catches each form of it (`text-primary`,
 * `bg-primary/5`, `ring-primary/40`) whatever the browser serializes them to.
 * Header icons and anything under the pointer or the focus are left out.
 */
async function primaryColored(page: Page, selector: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  return page.evaluate((sel) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const root = document.querySelector(sel);
    if (!root) throw new Error(`${sel} is not on the page`);
    const freeze = document.createElement('style');
    freeze.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
    document.head.append(freeze);

    const elements = [root, ...root.querySelectorAll('*')].filter((el) => !el.closest('[data-card-icon]'));
    const props = [
      'color',
      'background-color',
      'border-top-color',
      'border-right-color',
      'border-bottom-color',
      'border-left-color',
      'box-shadow',
      'fill',
      'stroke',
    ];
    const read = () =>
      elements.map((el) => {
        const style = getComputedStyle(el);
        return props.map((prop) => style.getPropertyValue(prop));
      });

    const html = document.documentElement;
    const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((n) => `--ui-color-primary-${n}`);
    const vars = ['--ui-primary', ...shades];
    const before = read();
    for (const name of vars) html.style.setProperty(name, 'rgb(255, 0, 255)');
    const after = read();
    for (const name of vars) html.style.removeProperty(name);
    freeze.remove();

    const found: string[] = [];
    elements.forEach((el, i) => {
      const changed = props.filter((_, j) => before[i]![j] !== after[i]![j]);
      if (!changed.length) return;
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const cls = (el.getAttribute('class') ?? '').slice(0, 80);
      found.push(`<${el.tagName.toLowerCase()} class="${cls}"> "${text}": ${changed.join(', ')}`);
    });
    return found;
  }, selector);
}

/** The visible solid primary buttons on the page. */
async function solidPrimaryButtons(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      [...document.querySelectorAll('button, a[href], [role="button"]')].filter(
        (el) => el.classList.contains('bg-primary') && el.getBoundingClientRect().width > 0,
      ).length,
  );
}

test.describe('Failure page accent', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90000);

  let executionId = 0;
  let clusterId = 0;

  test.beforeAll(async ({ request }) => {
    const startTime = Date.now();
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.FAILURE_PAGE_ACCENT,
        status: 'failed',
        startTime: new Date(startTime).toISOString(),
        duration: 12000,
        totalTests: 2,
        passedTests: 0,
        failedTests: 2,
        skippedTests: 0,
        testCases: [
          failingCase('checkout pays by card', 'tests/checkout.spec.ts:20:3', startTime),
          failingCase('checkout pays with a voucher', 'tests/voucher.spec.ts:12:3', startTime + 7000),
        ],
      },
      timeout: 20000,
    });
    const data = await res.json();
    const project = await (await request.get(`/api/projects/${data.projectId}`)).json();
    const run = await (await request.get(`/api/test-runs/${project.testRuns[0].id}`)).json();
    const cases = run.testCases as Array<{ title: string; executionId: number; failureClusterId?: number }>;
    const card = cases.find((c) => c.title === 'checkout pays by card')!;
    const voucher = cases.find((c) => c.title === 'checkout pays with a voucher')!;
    expect(card.failureClusterId).toBeTruthy();
    expect(voucher.failureClusterId).toBe(card.failureClusterId);
    executionId = card.executionId;
    clusterId = card.failureClusterId!;
  });

  test('the evidence card of a failing execution draws nothing in the primary color', async ({ page }) => {
    await page.goto(`/test-run-cases/${executionId}`);
    await waitForHydration(page);

    const card = page.locator('[data-shot="evidence-card"]');
    const tabs = card.getByRole('tablist', { name: 'Evidence sections' });
    const checks: Array<{ tab: string; content: string }> = [
      { tab: 'Timeline', content: "getByRole('button', { name: 'Pay' }).click()" },
      { tab: 'Network', content: '/api/quote' },
      { tab: 'Console', content: 'the price quote is still pending' },
    ];
    for (const { tab, content } of checks) {
      await tabs.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      await expect(card.getByText(content).filter({ visible: true }).first()).toBeVisible();
      expect(await primaryColored(page, '[data-shot="evidence-card"]'), `the ${tab} tab`).toEqual([]);
    }

    expect(await solidPrimaryButtons(page)).toBeLessThanOrEqual(1);
  });

  test('the affected tests and the evidence of a cluster draw nothing in the primary color', async ({ page }) => {
    await page.goto(`/failure-clusters/${clusterId}`);
    await waitForHydration(page);

    // A selected row, and the bulk bar a ticked test opens.
    const affected = page.locator('[data-shot="cluster-affected-tests"]');
    await affected.locator('[role="button"][aria-pressed="false"]').first().click();
    await expect(affected.locator('[role="button"][aria-pressed="true"]')).toHaveCount(1);
    const tick = affected.getByRole('checkbox').first();
    if (await tick.count()) {
      await tick.check();
      await expect(affected.getByText('1 selected')).toBeVisible();
    }
    await expect(page.locator('[data-shot="evidence-card"]').getByRole('table')).toBeVisible();

    expect(await primaryColored(page, '[data-shot="cluster-affected-tests"]')).toEqual([]);
    expect(await primaryColored(page, '[data-shot="evidence-card"]')).toEqual([]);
    expect(await solidPrimaryButtons(page)).toBeLessThanOrEqual(1);
  });
});
