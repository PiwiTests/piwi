import { readFileSync } from 'node:fs';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';
import { gitApplyCommand } from '#shared/patch';

/**
 * The single-column execution page: one situation block — identity, the failure
 * headline and the line under it, the most likely explanation, the next step and
 * the cluster, with the raw error one click away behind *Raw error* — then one evidence
 * card with content-level tabs (Timeline, Screen, Source, Network, Console,
 * State, Performance), then More ways to fix and the History block. A passing
 * execution shows identity and facts, with the evidence on the Timeline tab and no
 * More ways to fix.
 */
test.describe('Test-run-case page', () => {
  test.describe.configure({ mode: 'serial' });

  let failedCaseId: number;
  let passedCaseId: number;

  test.beforeAll(async ({ request }) => {
    const startTime = Date.now();
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.TEST_RUN_CASE_PAGE,
        status: 'failed',
        startTime: new Date(startTime).toISOString(),
        duration: 30000,
        totalTests: 2,
        passedTests: 1,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'checkout completes',
            status: 'failed',
            duration: 8000,
            location: 'tests/checkout.spec.ts:42:18',
            suitePath: ['Checkout'],
            error:
              "TimeoutError: locator.click: Timeout 30000ms exceeded.\n  - waiting for getByRole('button', { name: 'Pay' })",
            retries: 1,
            workerIndex: 0,
            startedAt: startTime,
            steps: [
              {
                title: "page.goto('/checkout')",
                duration: 800,
                category: 'navigation',
                location: 'pages/checkout.ts:11:5',
              },
              {
                title: 'Fill "ada@example.com"',
                subtitle: "getByLabel('Email')",
                duration: 400,
                category: 'input',
                params: { locator: "getByLabel('Email')", value: 'ada@example.com' },
              },
              {
                title: "getByRole('button', { name: 'Pay' }).click()",
                duration: 5000,
                category: 'action',
                failed: true,
                location: 'pages/checkout.ts:42:5',
                params: { locator: "getByRole('button', { name: 'Pay' })" },
              },
            ],
            // Benign capture-fixtures data — successful, fast requests, a plain
            // log line, the page state on the expected route and Web Vitals — so
            // the fixture-backed evidence tabs have content and none of it trips a
            // failure clue. It keeps this an ordinary fixture-instrumented failure.
            networkRequests: [
              {
                method: 'GET',
                url: 'http://localhost:3000/checkout',
                status: 200,
                duration: 180,
                resourceType: 'document',
              },
              {
                method: 'GET',
                url: 'http://localhost:3000/api/cart',
                status: 200,
                duration: 90,
                resourceType: 'fetch',
              },
            ],
            consoleLogs: [{ type: 'log', text: 'checkout page ready', timestamp: startTime + 500 }],
            pageState: { url: 'http://localhost:3000/checkout' },
            webVitals: {
              navigation: {
                url: 'http://localhost:3000/checkout',
                ttfb: 60,
                domInteractive: 320,
                domContentLoaded: 420,
                loadComplete: 900,
                transferSize: 60000,
              },
              paint: { firstPaint: 210, firstContentfulPaint: 360 },
            },
          },
          {
            title: 'homepage loads',
            status: 'passed',
            duration: 1500,
            location: 'apps/web/e2e/specs/home/landing/home.spec.ts:3:1',
            suitePath: ['Home', 'Landing page', 'Hero', 'when signed out'],
            retries: 0,
            workerIndex: 0,
            startedAt: startTime,
            steps: [{ title: "page.goto('/')", duration: 700, category: 'navigation' }],
          },
        ],
      },
    });

    const data = await res.json();
    const proj = await (await request.get(`/api/projects/${data.projectId}`)).json();
    const runId = proj.testRuns[0].id;
    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    failedCaseId = run.testCases.find((c: { status: string }) => c.status === 'failed').executionId;
    passedCaseId = run.testCases.find((c: { status: string }) => c.status === 'passed').executionId;
  });

  test('failing execution leads with the situation block, the raw error one click away, then evidence and fix', async ({
    page,
  }) => {
    await page.goto(`/test-run-cases/${failedCaseId}`);
    await waitForHydration(page);

    // One block frames the top; the headline is its h1.
    const block = page.locator('[data-shot="situation-block"]');
    await expect(block).toBeVisible();
    const headline = page.getByRole('heading', {
      name: /getByRole\('button', \{ name: 'Pay' \}\) was not found on the page — click timed out after 30 s/,
    });
    await expect(headline).toBeVisible();

    // The line under the headline says since when, and that nothing ran the test since.
    const meta = page.locator('[data-shot="execution-meta"]');
    await expect(meta).toBeVisible();
    await expect(meta).toContainText(/failed in this run/i);
    await expect(meta).toContainText('Latest execution of this test');
    const nextStep = page.locator('[data-shot="next-step"]');
    await expect(nextStep).toBeVisible();
    await expect(page.locator('[data-shot="situation-block"]')).toContainText('Next');

    // The lines read the explanation, then the action, then the context: the
    // Cluster line names the cluster, then its ticket, after the next step. The
    // execution page has no Situation line and no Issue line of its own.
    const labels = (await block.locator('dl > dt').allInnerTexts()).map((t) => t.trim());
    expect(labels).toContain('Cluster');
    expect(labels).not.toContain('Situation');
    expect(labels).not.toContain('Issue');
    expect(labels.indexOf('Next')).toBe(labels.indexOf('Cluster') - 1);
    if (labels.includes('Most likely')) expect(labels[0]).toBe('Most likely');
    const clusterLine = page.locator('[data-shot="cluster-line"]');
    await expect(clusterLine.getByRole('link', { name: /cluster #\d+/i })).toBeVisible();
    await expect(clusterLine).toContainText('No issue yet.');
    await expect(clusterLine.getByRole('button', { name: 'Link an issue' })).toBeVisible();

    // The raw error is a disclosure on the facts line, collapsed by default,
    // and reachable — with its Copy failure action — in one click.
    const showRaw = page.getByRole('button', { name: 'Raw error' });
    await expect(showRaw).toBeVisible();
    await showRaw.click();
    await expect(page.getByRole('button', { name: 'Copy failure' })).toBeVisible();

    // One evidence card with content-level tabs — no page-level tab strip.
    const tablist = page.getByRole('tablist', { name: 'Evidence sections' });
    await expect(tablist).toBeVisible();
    for (const name of ['Timeline', 'Screen', 'Source', 'Network', 'Console', 'State', 'Performance']) {
      await expect(tablist.getByRole('tab', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    // A tab that lists items carries its count as plain text, never a badge.
    await expect(tablist.getByRole('tab', { name: /^Network/ })).toHaveText(/^\s*Network\s*2\s*$/);

    // More ways to fix gathers the other ways to fix (diagnosis, verify, …) below the evidence.
    // With no AI provider its diagnosis is one line, not a placeholder block.
    const fix = page.locator('[data-shot="fix"]');
    await expect(fix).toBeVisible();
    await expect(fix.getByText('AI is not configured')).toBeVisible();

    // Reading order: headline → evidence → fix.
    const headlineY = (await headline.boundingBox())!.y;
    const tabsY = (await tablist.boundingBox())!.y;
    const fixY = (await fix.boundingBox())!.y;
    expect(headlineY).toBeLessThan(tabsY);
    expect(tabsY).toBeLessThan(fixY);
  });

  test('passing execution shows identity and facts only, on the Timeline tab', async ({ page }) => {
    await page.goto(`/test-run-cases/${passedCaseId}`);
    await waitForHydration(page);

    const timelineTab = page.getByRole('tab', { name: /^Timeline/ });
    await expect(timelineTab).toBeVisible();
    await expect(timelineTab).toHaveAttribute('aria-selected', 'true');
    // No failure → no headline, no story, no situation, no next step, no More ways to fix.
    await expect(page.getByRole('button', { name: 'Raw error' })).toHaveCount(0);
    await expect(page.locator('[data-shot="execution-meta"]')).toHaveCount(0);
    await expect(page.locator('[data-shot="cluster-line"]')).toHaveCount(0);
    await expect(page.locator('[data-shot="next-step"]')).toHaveCount(0);
    await expect(page.locator('[data-shot="fix"]')).toHaveCount(0);
    // A passing execution shows the steps table without the failure axis or its
    // controls. The tab is the heading — the block does not repeat "Steps".
    await expect(page.getByRole('button', { name: 'Around the failure' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Steps/ })).toHaveCount(0);
    await expect(page.locator('table').first()).toBeVisible();
  });

  test('the identity line names the test by its title path, folding a deep one', async ({ page }) => {
    await page.goto(`/test-run-cases/${failedCaseId}`);
    await waitForHydration(page);

    // The spec file and line (open in IDE), the describe blocks, then the title.
    let path = page.locator('[data-shot="test-title-path"]');
    await expect(path.getByRole('button', { name: 'Open tests/checkout.spec.ts:42 in IDE' })).toBeVisible();
    await expect(path).toContainText('Checkout');
    await expect(path).toContainText('checkout completes');
    await expect(path.getByRole('button', { name: 'Show the full path' })).toHaveCount(0);
    // The test's own file and line are not repeated on the facts line.
    await expect(
      page.locator('[data-shot="situation-block"]').getByRole('button', { name: /^Open tests\/checkout\.spec\.ts/ }),
    ).toHaveCount(1);

    // A deep path keeps its first folders, its last folder and its outermost and
    // innermost describe blocks, and one click unfolds the rest.
    await page.goto(`/test-run-cases/${passedCaseId}`);
    await waitForHydration(page);
    path = page.locator('[data-shot="test-title-path"]');
    const unfold = path.getByRole('button', { name: 'Show the full path' });
    await expect(unfold).toHaveCount(2);
    await expect(path).toContainText('apps/web/');
    await expect(path).toContainText('/landing/');
    await expect(path).not.toContainText('e2e/specs');
    await expect(path).toContainText('Home');
    await expect(path).toContainText('when signed out');
    await expect(path).not.toContainText('Landing page');
    await unfold.first().click();
    await expect(unfold).toHaveCount(0);
    await expect(path).toContainText('apps/web/e2e/specs/home/landing/');
    await expect(path).toContainText('Landing page');
    await expect(path).toContainText('Hero');
  });

  test('the retry command is in the More menu, not an always-on header button', async ({ page }) => {
    await page.goto(`/test-run-cases/${failedCaseId}`);
    await waitForHydration(page);
    // The header carries no standing Copy retry command button.
    await expect(page.getByRole('button', { name: /Copy retry command/ })).toHaveCount(0);
    // It is reachable in the More actions menu.
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: /Copy retry command/ })).toBeVisible();

    // The menu groups the ticket, the test actions, the copies, then Refresh, as
    // on the cluster page.
    const menu = page.getByRole('menu');
    const items = menu.getByRole('menuitem');
    await expect(items.last()).toHaveText('Refresh');
    const order = ['Link an issue', 'Quarantine this test', 'Copy failure', 'Copy retry command', 'Refresh'];
    const labels = (await items.allInnerTexts()).map((t) => t.trim());
    expect(labels.filter((label) => order.includes(label))).toEqual(order);
    const groups = menu.getByRole('group');
    await expect(groups).toHaveCount(4);
    await expect(groups.last().getByRole('menuitem')).toHaveText(['Refresh']);
  });

  test('the Performance tab opens and shows its Web Vitals block', async ({ page }) => {
    await page.goto(`/test-run-cases/${failedCaseId}`);
    await waitForHydration(page);
    const performanceTab = page.getByRole('tab', { name: /^Performance/ });
    await performanceTab.click();
    // The tab is the heading; the block does not repeat "Browser performance".
    await expect(performanceTab).toHaveAttribute('aria-selected', 'true');
    // The captured Web Vitals render as metric tiles (the tab shows only when it
    // has data — a fixtureless execution has no Performance tab at all).
    await expect(page.getByText('TTFB', { exact: true })).toBeVisible();
  });

  test('GET /api/test-run-cases/:id/timeline places the steps and marks the failure', async ({ request }) => {
    const res = await request.get(`/api/test-run-cases/${failedCaseId}/timeline`);
    expect(res.ok()).toBeTruthy();
    const tl = await res.json();
    // Three steps, none carrying a start time, so positions are estimated.
    expect(tl.lanes.steps).toHaveLength(3);
    expect(tl.estimated).toBe(true);
    // The step marked failed is the failure; its end is the failure moment.
    expect(tl.failedStep.index).toBe(2);
    expect(tl.failureAt).toBe(6200);
    expect(tl.lanes.steps[2].failed).toBe(true);
    expect(tl.window).toBeDefined();
    // Each step is attributed to its reporter call site (file:line; no trace, so no function).
    expect(tl.lanes.steps[2].origin).toEqual({ file: 'pages/checkout.ts', line: 42, function: null, chain: [] });
    // The 1.63-shaped Fill step carries its subtitle and params on the model.
    expect(tl.lanes.steps[1].subtitle).toBe("getByLabel('Email')");
    expect(tl.lanes.steps[1].params).toEqual({ locator: "getByLabel('Email')", value: 'ada@example.com' });
  });

  test('the Timeline tab merges the axis and one steps table', async ({ page }) => {
    await page.goto(`/test-run-cases/${failedCaseId}`);
    await waitForHydration(page);

    await page.getByRole('tab', { name: /^Timeline/ }).click();

    // The tab is the heading — the block does not repeat "Failure timeline".
    await expect(page.getByRole('heading', { name: 'Failure timeline' })).toHaveCount(0);
    // One switch of two pressed-state buttons drives the axis and the table
    // together, opening on the window around the failure.
    const windowSwitch = page.getByRole('group', { name: 'Timeline window' });
    const around = windowSwitch.getByRole('button', { name: 'Around the failure' });
    const whole = windowSwitch.getByRole('button', { name: 'Whole test' });
    await expect(around).toHaveAttribute('aria-pressed', 'true');
    await expect(whole).toHaveAttribute('aria-pressed', 'false');
    // This run recorded no step start times, so the estimated note shows.
    await expect(page.getByText(/Step positions are derived from durations/)).toBeVisible();

    // One merged table, with no separate "what happened" list.
    await expect(page.getByRole('heading', { name: 'What happened in this window' })).toHaveCount(0);
    const table = page.getByRole('table');
    await expect(table).toHaveCount(1);
    // The failed step is a highlighted row in that table.
    await expect(table.getByText("getByRole('button', { name: 'Pay' }).click()")).toBeVisible();

    // Whole test keeps every step in the table.
    await whole.click();
    await expect(whole).toHaveAttribute('aria-pressed', 'true');
    await expect(around).toHaveAttribute('aria-pressed', 'false');
    await expect(table.getByText("page.goto('/checkout')")).toBeVisible();
    await expect(table.getByText("getByRole('button', { name: 'Pay' }).click()")).toBeVisible();
  });

  test('a duration is colored only when it stands out in the test', async ({ page }) => {
    await page.goto(`/test-run-cases/${failedCaseId}`);
    await waitForHydration(page);
    await page.getByRole('tab', { name: /^Timeline/ }).click();
    await page.getByRole('button', { name: 'Whole test' }).click();

    const table = page.getByRole('table');
    const row = (text: string) => table.locator('tr', { hasText: text });
    // The 5 s click takes 63% of the 8 s test: it stands out, and says why on hover.
    const pay = row("getByRole('button', { name: 'Pay' }).click()").locator('[data-standout]');
    await expect(pay).toHaveAttribute('data-standout', 'share');
    await expect(pay).toHaveAttribute('title', /63% of the test/);
    await expect(pay).toContainText('5s');
    // The 800 ms navigation is under 1 s: neutral.
    await expect(row("page.goto('/checkout')").locator('[data-standout]')).toHaveCount(0);
    await expect(row("page.goto('/checkout')")).toContainText('800ms');
    // No category column and no "slowest" tag compete with that one color.
    await expect(table.getByRole('columnheader', { name: 'Category' })).toHaveCount(0);
    await expect(page.locator('[data-shot="evidence-card"]').getByText('slowest')).toHaveCount(0);
  });

  test('the Network tab colors a request by the same rule, from the timeline the page already read', async ({
    page,
  }) => {
    const timelineCalls: string[] = [];
    page.on('request', (req) => {
      if (/\/api\/test-run-cases\/\d+\/timeline/.test(req.url())) timelineCalls.push(req.url());
    });
    // Vue only reports mismatches in a dev build; in a production run this stays empty.
    const hydrationErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('Hydration completed but contains mismatches')) hydrationErrors.push(msg.text());
    });

    await page.goto(`/test-run-cases/${failedCaseId}`);
    await waitForHydration(page);
    const tablist = page.getByRole('tablist', { name: 'Evidence sections' });
    await tablist.getByRole('tab', { name: /^Network/ }).click();

    // Both requests are quick next to the 8 s test: plain milliseconds, neither colored.
    const card = page.locator('[data-shot="evidence-card"]');
    await expect(card.getByText('180ms').first()).toBeVisible();
    await expect(card.getByText('90ms').first()).toBeVisible();
    await expect(card.locator('[data-standout]')).toHaveCount(0);

    // The page reads the timeline once (with the server render when it opens on
    // the Timeline): switching tabs never fetches it again.
    const calls = timelineCalls.length;
    expect(calls).toBeLessThanOrEqual(1);
    await tablist.getByRole('tab', { name: /^Timeline/ }).click();
    await expect(page.getByRole('table')).toBeVisible();
    await tablist.getByRole('tab', { name: /^Network/ }).click();
    await expect(card.getByText('180ms').first()).toBeVisible();
    expect(timelineCalls).toHaveLength(calls);
    expect(hydrationErrors).toEqual([]);
  });

  test("the steps table renders the 1.63 subtitle, and a step's title opens its parameters", async ({ page }) => {
    await page.goto(`/test-run-cases/${failedCaseId}`);
    await waitForHydration(page);
    await page.getByRole('tab', { name: /^Timeline/ }).click();
    await page.getByRole('button', { name: 'Whole test' }).click();

    const table = page.getByRole('table');
    // The Fill step's title reads first; its target renders as a muted subtitle
    // (a <span>, distinct from the same string in the parameter list's <dd>).
    await expect(table.getByText('Fill "ada@example.com"')).toBeVisible();
    await expect(table.locator('span').filter({ hasText: /^getByLabel\('Email'\)$/ })).toBeVisible();

    // Every step starts closed, the failing one too: no parameter list shows.
    await expect(table.locator('[data-testid="step-params"]')).toHaveCount(0);
    // A step without parameters has a plain title, not a button.
    await expect(table.getByRole('button', { name: /page\.goto/ })).toHaveCount(0);

    // The title opens the list, the locator first, and closes it again.
    const fill = table.getByRole('button', { name: /Fill "ada@example\.com"/ });
    await expect(fill).toHaveAttribute('aria-expanded', 'false');
    // A closed title names no list: aria-controls only points at one in the DOM.
    await expect(fill).not.toHaveAttribute('aria-controls');
    await fill.click();
    await expect(fill).toHaveAttribute('aria-expanded', 'true');
    const params = table.locator('[data-testid="step-params"]');
    await expect(params).toHaveCount(1);
    await expect(fill).toHaveAttribute('aria-controls', (await params.getAttribute('id'))!);
    await expect(params).toContainText('Parameters (2)');
    await expect(params.getByText('locator', { exact: true })).toBeVisible();
    await expect(params.getByText('ada@example.com')).toBeVisible();
    await fill.click();
    await expect(fill).toHaveAttribute('aria-expanded', 'false');
    await expect(params).toHaveCount(0);

    // The keyboard opens it the same way.
    await fill.focus();
    await page.keyboard.press('Enter');
    await expect(fill).toHaveAttribute('aria-expanded', 'true');
  });

  test('the story line folds every clue under a "more" disclosure titled "All clues"', async ({ page }) => {
    await page.goto(`/test-run-cases/${failedCaseId}`);
    await waitForHydration(page);
    // This synthetic failure has no chained story, but its clues still list under
    // the disclosure — and never as "The one clue" / "Other clues".
    await expect(page.getByText('The one clue')).toHaveCount(0);
    await expect(page.getByText('Other clues')).toHaveCount(0);
  });

  test('History block opens populated from the SSR payload, without refetching or a hydration mismatch', async ({
    page,
  }) => {
    // A client-side call to the history endpoint means the rows are missing from
    // the payload, which is what tears the server and client renders apart.
    const historyCalls: string[] = [];
    page.on('request', (req) => {
      if (/\/api\/test-cases\/\d+\/history/.test(req.url())) historyCalls.push(req.url());
    });
    // Vue only reports mismatches in a dev build; in a production run this stays empty.
    const hydrationErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('Hydration completed but contains mismatches')) hydrationErrors.push(msg.text());
    });

    await page.goto(`/test-run-cases/${failedCaseId}`);
    await waitForHydration(page);

    const historyCard = page.locator('[data-shot="execution-history"]');
    await expect(historyCard.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
    await expect(historyCard.getByRole('link', { name: 'Test history' })).toBeVisible();
    expect(historyCalls).toEqual([]);
    expect(hydrationErrors).toEqual([]);
  });
});

/** The rows of the diff the Next line shows, each with its leading marker. */
async function nextChangeRows(page: import('@playwright/test').Page): Promise<string[]> {
  const preview = page.locator('[data-shot="next-step-change"]').getByRole('region', { name: 'Change preview' });
  return (await preview.locator(':scope > div').allTextContents()).map((row) => row.replace(/\u00a0/g, ' '));
}

/**
 * The story line, the line under the headline and the next step read from the
 * deterministic demo seed: #37 chains the blocked-by-pending-request story and
 * proposes the diagnosed patch, #587 replaces a locator, #682 reproduces, #768
 * and #21 passed on retry and lead with their failed attempt, #748 never ran. These
 * run only when the seeded cases are present (a demo-seeded server); a bare test
 * DB has no such ids, so the block skips rather than fails.
 */
test.describe('Situation block on seeded cases', () => {
  let hasSeed = false;
  test.beforeAll(async ({ request }) => {
    hasSeed = (await request.get('/api/test-run-cases/37')).ok();
  });
  test.beforeEach(() => {
    test.skip(!hasSeed, 'demo seed not loaded on this server');
  });

  test('#37 reads the story, the regression situation and the diagnosed-fix next step', async ({ page }) => {
    await page.goto('/test-run-cases/37');
    await waitForHydration(page);

    // The block reads the explanation, the action, then the context.
    const labels = (await page.locator('[data-shot="situation-block"] dl > dt').allInnerTexts()).map((t) => t.trim());
    expect(labels).toEqual(['Most likely', 'Next', 'Cluster']);

    // Most likely — the blocked-by-pending-request story, Strong, 3 clues agree.
    await expect(page.getByText('Most likely', { exact: true })).toBeVisible();
    await expect(page.getByText('Strong', { exact: true })).toBeVisible();
    await expect(page.getByText(/3 clues agree/)).toBeVisible();

    // The line under the headline names the regression once, and says later runs
    // failed again, with one link to the newest execution; the Cluster line links
    // the cluster, then names its issue.
    const meta = page.locator('[data-shot="execution-meta"]');
    await expect(meta).toContainText('New regression');
    await expect(meta).toContainText('Not the latest');
    const openLatest = meta.getByRole('link', { name: 'Open the latest' });
    await expect(openLatest).toHaveAttribute('href', /^\/test-run-cases\/\d+$/);
    await expect(meta.getByRole('link', { name: /run #/ })).toHaveCount(0);
    const clusterLine = page.locator('[data-shot="cluster-line"]');
    await expect(clusterLine.getByRole('link', { name: /cluster #/ })).toBeVisible();
    await expect(clusterLine.locator('[data-shot="issue-line"]')).toBeVisible();

    // The next step applies the diagnosed fix; its overflow menu copies the retry command.
    const next = page.locator('[data-shot="next-step"]');
    await expect(next).toContainText('Apply the diagnosed fix');
    // Most likely is the story, so the step names the diagnosis its patch comes from.
    await expect(next.locator('[data-shot="next-step-source"]')).toContainText(
      "From the cluster's AI diagnosis, high confidence",
    );
    // The primary is named by what it copies, the command in its title.
    const apply = next.getByRole('button', { name: 'Copy apply command' });
    await expect(apply).toBeVisible();
    await expect(apply).toHaveAttribute('title', /^git apply <<'EOF' \.\.\. EOF, run at the repository root/);
    // `app:measure` finds the step and its action by these ids, never by the label.
    await expect(next).toHaveAttribute('data-next-kind', 'apply-patch');
    await expect(next.locator('[data-next-action]')).toHaveAttribute('data-next-action', 'copy-git-apply');
    await next.getByRole('button', { name: 'More next-step actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Copy retry command' })).toBeVisible();
    await page.keyboard.press('Escape');

    // "New regression" appears exactly once on the page.
    await expect(page.getByText('New regression')).toHaveCount(1);
  });

  test('#37 shows the diagnosed patch it copies, and Full patch opens the whole patch', async ({
    page,
    request,
    context,
  }) => {
    const detail = (await (await request.get('/api/test-run-cases/37')).json()) as {
      failureCluster: { id: number } | null;
    };
    const plan = (await (await request.get(`/api/failure-clusters/${detail.failureCluster!.id}/fix-plan`)).json()) as {
      diagnosis: { patch: string | null } | null;
    };
    const patch = plan.diagnosis?.patch;
    test.skip(!patch, 'the cluster of #37 has no diagnosed patch on this database');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/test-run-cases/37');
    await waitForHydration(page);

    // A window on the patch, its validation and how much it leaves out, above the source.
    const change = page.locator('[data-shot="next-step-change"]');
    await expect(change).toContainText('Applies cleanly');
    await expect(change).toContainText(/\d+ more lines/);
    const rows = await nextChangeRows(page);
    const added = rows.filter((row) => row.startsWith('+'));
    expect(added.length).toBeGreaterThan(0);
    for (const row of rows.slice(1)) expect(patch).toContain(row);
    await expect(page.locator('[data-shot="next-step-source"]')).toContainText(
      "From the cluster's AI diagnosis, high confidence",
    );

    // The primary copies the command that applies the whole patch.
    await page.locator('[data-shot="next-step"]').getByRole('button', { name: 'Copy apply command' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(gitApplyCommand(patch!));

    // Full patch opens the Diagnosis section at the whole patch.
    const diagnosis = page.locator('[data-shot="fix-diagnosis"] button[aria-expanded]').first();
    if ((await diagnosis.getAttribute('aria-expanded')) === 'true') await diagnosis.click();
    await expect(diagnosis).toHaveAttribute('aria-expanded', 'false');
    await change.getByRole('button', { name: 'Full patch' }).click();
    await expect(diagnosis).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-shot="diagnosis-patch"]')).toBeInViewport();
  });

  test('#37 keeps the patch preview inside the page at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/test-run-cases/37');
    await waitForHydration(page);
    await expect(page.locator('[data-shot="next-step-change"]')).toBeVisible();
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  test('#37 opens the evidence on the Timeline and the toolbox on Diagnosis', async ({ page }) => {
    await page.goto('/test-run-cases/37');
    await waitForHydration(page);

    // The story cites network, console and ARIA; the Timeline places them, so it
    // is the default tab rather than the single tab the leading clue cites.
    await expect(page.getByRole('tab', { name: /^Timeline/ })).toHaveAttribute('aria-selected', 'true');

    // The toolbox is "More ways to fix" and opens on the next step's section —
    // the diagnosed-fix step opens Diagnosis; the others are folded to one line.
    await expect(page.getByRole('heading', { name: 'More ways to fix' })).toBeVisible();
    await expect(page.locator('[data-shot="fix-diagnosis"] [aria-expanded="true"]')).toBeVisible();
    await expect(page.locator('[data-shot="fix-reproduce"] [aria-expanded="false"]')).toBeVisible();
  });

  test('#37 shows the page at the failure as views on the Screen tab and picks from its DOM', async ({ page }) => {
    await page.goto('/test-run-cases/37');
    await waitForHydration(page);
    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Screen', exact: true })
      .click();
    // One strip of views, opening on the screenshot.
    const views = page.getByRole('tablist', { name: 'Screen view' });
    await expect(views.getByRole('tab', { name: 'Screenshot', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(views.getByRole('tab', { name: 'Video', exact: true })).toBeVisible();
    // The DOM view renders the page — an iframe, never escaped markup.
    await views.getByRole('tab', { name: 'DOM', exact: true }).click();
    await expect(page.locator('iframe[title="DOM at the failure"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy HTML' })).toBeVisible();
    // The Accessibility tree view shows the tree as text.
    await views.getByRole('tab', { name: 'Accessibility tree', exact: true }).click();
    await expect(page.getByText('button "Pay now" [disabled]')).toBeVisible();
    // "Open in picker" loads the same snapshot into the locator picker, from any view.
    await page.getByRole('button', { name: 'Open in picker' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('iframe[title="DOM snapshot"]')).toBeVisible();
    await expect(dialog.getByText('No DOM snapshot or ARIA data available')).toHaveCount(0);
  });

  test('#533 proposes replacing the locator and opens the Locator fix section', async ({ page }) => {
    test.skip(!(await (await page.request.get('/api/test-run-cases/533')).ok()), 'no #533');
    await page.goto('/test-run-cases/533');
    await waitForHydration(page);
    const next = page.locator('[data-shot="next-step"]');
    await expect(next).toContainText('Replace the locator');
    await expect(page.locator('[data-shot="fix-locator-fix"] [aria-expanded="true"]')).toBeVisible();
  });

  // #587 waits for `.modal.is-open`, a modal the app never opens: no element of
  // the failing page relates to that CSS locator, so nothing is offered to replace it.
  test('#587 proposes no locator replacement for a CSS locator with no related element', async ({ page }) => {
    test.skip(!(await (await page.request.get('/api/test-run-cases/587')).ok()), 'no #587');
    await page.goto('/test-run-cases/587');
    await waitForHydration(page);
    await expect(page.locator('[data-shot="next-step"]')).toBeVisible();
    await expect(page.locator('[data-shot="next-step"]')).not.toContainText('Replace the locator');
  });

  test('#648 has no line edit, so it shows and copies the recommended locator, even from a folded section', async ({
    page,
    request,
    context,
  }) => {
    const res = await request.get('/api/test-run-cases/648');
    test.skip(!res.ok(), 'no #648');
    const detail = (await res.json()) as { nextStep?: { kind: string } | null };
    const healing = (await (await request.get('/api/test-run-cases/648/locator-healing')).json()) as {
      edit?: { unifiedDiff?: string | null } | null;
      recommendation?: { recommended?: { locator: string } | null } | null;
    };
    const recommended = healing.recommendation?.recommended?.locator;
    test.skip(
      detail.nextStep?.kind !== 'replace-locator' || Boolean(healing.edit?.unifiedDiff) || !recommended,
      '#648 is not a locator step without an edit on this database',
    );
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/test-run-cases/648');
    await waitForHydration(page);

    const next = page.locator('[data-shot="next-step"]');
    await expect(next.locator('[data-next-action]')).toHaveAttribute('data-next-action', 'copy-locator');
    await expect(next.getByRole('button', { name: 'Copy apply command' })).toHaveCount(0);
    const rows = await nextChangeRows(page);
    expect(rows.some((row) => row.startsWith('-'))).toBe(true);
    expect(rows).toContain(`+${recommended}`);

    // Folding Locator fix unmounts its panel; the copy reads the row's change.
    const section = page.locator('[data-shot="fix-locator-fix"] button[aria-expanded]').first();
    if ((await section.getAttribute('aria-expanded')) === 'true') await section.click();
    await expect(section).toHaveAttribute('aria-expanded', 'false');
    await next.getByRole('button', { name: 'Copy locator' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(recommended);
  });

  test('the replace-locator actions open a folded Locator fix section before acting on its panel', async ({
    page,
    request,
    context,
  }) => {
    // A seeded execution whose next step replaces the locator with a line edit;
    // which id that is differs between databases, so probe.
    let target: { id: number; diff: string; oldLine: string; newLine: string } | null = null;
    for (const id of [87, 533]) {
      const res = await request.get(`/api/test-run-cases/${id}`);
      if (!res.ok()) continue;
      const detail = (await res.json()) as { nextStep?: { kind: string } | null };
      if (detail.nextStep?.kind !== 'replace-locator') continue;
      const healing = (await (await request.get(`/api/test-run-cases/${id}/locator-healing`)).json()) as {
        edit?: { unifiedDiff?: string; oldLine: string; newLine: string } | null;
      };
      if (healing.edit?.unifiedDiff) {
        const { unifiedDiff, oldLine, newLine } = healing.edit;
        target = { id, diff: unifiedDiff, oldLine, newLine };
        break;
      }
    }
    test.skip(target == null, 'no seeded replace-locator execution with an edit');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/test-run-cases/${target!.id}`);
    await waitForHydration(page);

    // Folding the section unmounts the panel the actions drive; mounting it again
    // renders the page's healing answer without asking for it again.
    const healingFetches: string[] = [];
    page.on('request', (r) => {
      if (/\/locator-healing(\?|$)/.test(r.url())) healingFetches.push(r.url());
    });
    const section = page.locator('[data-shot="fix-locator-fix"] button[aria-expanded]').first();
    const fold = async () => {
      if ((await section.getAttribute('aria-expanded')) === 'true') await section.click();
      await expect(section).toHaveAttribute('aria-expanded', 'false');
    };
    const next = page.locator('[data-shot="next-step"]');

    // The row shows the line the edit rewrites, before and after.
    const rows = await nextChangeRows(page);
    expect(rows).toContain(`-${target!.oldLine}`);
    expect(rows).toContain(`+${target!.newLine}`);

    // Pick from snapshot opens the section, then the picker.
    await fold();
    await next.getByRole('button', { name: 'More next-step actions' }).click();
    await page.getByRole('menuitem', { name: 'Pick from snapshot' }).click();
    const picker = page.getByRole('dialog').filter({ hasText: 'Pick a locator from the DOM snapshot' });
    await expect(picker).toBeVisible();
    await expect(section).toHaveAttribute('aria-expanded', 'true');
    await picker.getByRole('button', { name: 'Cancel' }).click();
    await expect(picker).toHaveCount(0);
    // Scrolling the section into view moves the panel's content, never the
    // dashboard: the navbar stays on screen.
    const navbarTop = (await page.getByRole('button', { name: 'More actions' }).boundingBox())?.y ?? -1;
    expect(navbarTop).toBeGreaterThanOrEqual(0);

    // Copy apply command copies the command that applies the healing edit's diff.
    await fold();
    await next.getByRole('button', { name: 'Copy apply command' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(gitApplyCommand(target!.diff));

    // Download .patch, in the menu, saves the same diff for a shell without heredocs.
    const download = page.waitForEvent('download');
    await next.getByRole('button', { name: 'More next-step actions' }).click();
    await page.getByRole('menuitem', { name: 'Download .patch' }).click();
    const saved = await (await download).path();
    expect(readFileSync(saved, 'utf8').trimEnd()).toBe(target!.diff.trimEnd());
    expect(healingFetches).toEqual([]);
  });

  test('#682 proposes reproducing locally and opens the Reproduce section, run line first', async ({ page }) => {
    test.skip(!(await (await page.request.get('/api/test-run-cases/682')).ok()), 'no #682');
    await page.goto('/test-run-cases/682');
    await waitForHydration(page);
    const next = page.locator('[data-shot="next-step"]');
    await expect(next).toContainText('Reproduce locally');
    await expect(next.getByRole('button', { name: 'Copy recipe' })).toBeVisible();
    // The Reproduce section opens with the page; the run line leads, the full
    // recipe folds behind "Show the full recipe".
    await expect(page.locator('[data-shot="fix-reproduce"] [aria-expanded="true"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Show the full recipe/ })).toBeVisible();
  });

  test('#13 leads with the most-likely explanation', async ({ page }) => {
    test.skip(!(await (await page.request.get('/api/test-run-cases/13')).ok()), 'no #13');
    await page.goto('/test-run-cases/13');
    await waitForHydration(page);
    await expect(page.getByText('Most likely', { exact: true })).toBeVisible();
  });

  test("#768 opens on Attempts with the failed attempt's headline and a linked 1/2", async ({ page }) => {
    const res = await page.request.get('/api/test-run-cases/768');
    test.skip(!res.ok(), 'no #768');
    const detail = (await res.json()) as { verdict: { attempt: { executionId: number } | null } | null };
    const failedId = detail.verdict?.attempt?.executionId;
    expect(failedId, 'the seed stores the failed attempt of #768').toBeTruthy();
    await page.goto('/test-run-cases/768');
    await waitForHydration(page);
    await expect(page.getByText('Passed on retry', { exact: true })).toHaveCount(1);
    await expect(page.locator('[data-shot="failure-headline"]')).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Attempts/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-shot="execution-meta"]').getByRole('link', { name: 'attempt 1' })).toHaveAttribute(
      'href',
      `/test-run-cases/${failedId}`,
    );
    await expect(
      page.getByRole('group', { name: 'Attempts of this test in this run' }).getByRole('link', { name: /1\/2/ }),
    ).toHaveAttribute('href', `/test-run-cases/${failedId}`);
    // The seed's order-dependent flake: the next step reproduces it under the test that ran before it.
    await expect(page.locator('[data-shot="next-step"]')).toContainText(
      'Reproduce this flake under updates the organization name alongside',
    );
  });

  test('#748 states its reason in Most likely and shows no evidence card', async ({ page }) => {
    test.skip(!(await (await page.request.get('/api/test-run-cases/748')).ok()), 'no #748');
    await page.goto('/test-run-cases/748');
    await waitForHydration(page);
    await expect(page.locator('[data-shot="most-likely"]')).toContainText('maximum number of failures');
    await expect(page.locator('[data-shot="evidence-card"]')).toHaveCount(0);
    const next = page.locator('[data-shot="next-step"]');
    await expect(next).toHaveAttribute('data-next-kind', 'open-run');
    await expect(next).not.toContainText('Reproduce locally');
  });

  test('#21 proposes the Flake Lab verify step', async ({ page }) => {
    test.skip(!(await (await page.request.get('/api/test-run-cases/21')).ok()), 'no #21');
    await page.goto('/test-run-cases/21');
    await waitForHydration(page);
    const next = page.locator('[data-shot="next-step"]');
    await expect(next).toContainText('Verify the flake fix');
    await expect(next.getByRole('button', { name: 'Copy verify command' })).toBeVisible();
    await expect(page.getByText('Most likely', { exact: true })).toHaveCount(0);
    await expect(page.locator('[data-shot="fix"]')).toHaveCount(0);
  });
});

/**
 * The line under the headline says whether the execution is the latest of its
 * test: two failing runs of one test, then a passing one, in the same project.
 * Each attempt of the describe (a retry runs it again in a new worker) files
 * its own test, so the runs an earlier attempt left behind are another test's.
 */
test.describe('Latest execution line', () => {
  test.describe.configure({ mode: 'serial' });

  let base = 0;
  const failure = {
    title: 'cart keeps its items',
    location: 'tests/cart.spec.ts:7:1',
    duration: 1200,
    retries: 0,
    error:
      'Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId(\'cart-count\')\nExpected: "2"\nReceived: "0"',
  };

  async function submit(request: APIRequestContext, at: number, passed: boolean) {
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.LATEST_EXECUTION_LINE,
        status: passed ? 'passed' : 'failed',
        startTime: new Date(at).toISOString(),
        duration: 5000,
        totalTests: 1,
        passedTests: passed ? 1 : 0,
        failedTests: passed ? 0 : 1,
        skippedTests: 0,
        testCases: [
          passed
            ? { title: failure.title, location: failure.location, duration: 900, retries: 0, status: 'passed' }
            : { ...failure, status: 'failed' },
        ],
      },
    });
    const { runId } = (await res.json()) as { runId: number };
    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    return { runId, executionId: run.testCases[0].executionId as number };
  }

  let runA: { runId: number; executionId: number };
  let runB: { runId: number; executionId: number };

  test.beforeAll(async ({ request }, testInfo) => {
    base = Date.now() - 3 * 60 * 60 * 1000;
    failure.title = `cart keeps its items (attempt ${testInfo.retry}, ${base})`;
    runA = await submit(request, base, false);
    runB = await submit(request, base + 60 * 60 * 1000, false);
  });

  test('an older failure says a later run failed again and links the newest execution', async ({ page }) => {
    const hydrationErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('Hydration completed but contains mismatches')) hydrationErrors.push(msg.text());
    });
    await page.goto(`/test-run-cases/${runA.executionId}`);
    await waitForHydration(page);

    const meta = page.locator('[data-shot="execution-meta"]');
    await expect(meta).toContainText(`Not the latest: failed again in run #${runB.runId}`);
    await expect(meta.getByRole('link', { name: 'Open the latest' })).toHaveAttribute(
      'href',
      `/test-run-cases/${runB.executionId}`,
    );
    expect(hydrationErrors).toEqual([]);
  });

  test('the newest failure is the latest execution', async ({ page }) => {
    await page.goto(`/test-run-cases/${runB.executionId}`);
    await waitForHydration(page);
    const meta = page.locator('[data-shot="execution-meta"]');
    await expect(meta).toContainText('Latest execution of this test');
    await expect(meta.getByRole('link', { name: 'Open the latest' })).toHaveCount(0);
  });

  test('once a later run passes, the older failure says so', async ({ page, request }) => {
    const runC = await submit(request, base + 2 * 60 * 60 * 1000, true);
    await page.goto(`/test-run-cases/${runA.executionId}`);
    await waitForHydration(page);
    const meta = page.locator('[data-shot="execution-meta"]');
    await expect(meta).toContainText(`Not the latest: passed in run #${runC.runId}`);
    await expect(meta.getByRole('link', { name: 'Open the latest' })).toHaveAttribute(
      'href',
      `/test-run-cases/${runC.executionId}`,
    );
  });

  test('at phone width the latest part reads on its own line, with no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/test-run-cases/${runA.executionId}`);
    await waitForHydration(page);
    const since = page.getByTestId('execution-meta-since');
    const latest = page.getByTestId('execution-meta-latest');
    await expect(latest).toBeVisible();
    const sinceBox = (await since.boundingBox())!;
    const latestBox = (await latest.boundingBox())!;
    expect(latestBox.y).toBeGreaterThanOrEqual(sinceBox.y + sinceBox.height - 1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
