import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The DOM view renders the page as the trace recorded it: field values, checkbox and option states, scroll offsets,
 * a modal dialog and a popover, a web component's shadow DOM and adopted stylesheets, the action's target, the mouse
 * and the `:hover` styles of the element under it. Driven by
 * real traces of the same test recorded with Playwright 1.60 and 1.63 (`scripts/record-live-state-traces.mjs`),
 * whose snapshot formats differ.
 */
const VERSIONS = ['1.60', '1.63'] as const;
const trace = (version: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/trace-live-state-${version}.zip`, import.meta.url)));

// The recorder's `page.uncheck('#agree')` and `page.hover('#products')`, the same calls in both versions.
const UNCHECK_CALL = 'call@16';
const HOVER_CALL = 'call@22';

// What the capture fixtures would read at test end on the recorded page, by element path: the dialog's OK button
// focused with its focus ring, the mouse over the dialog's text, "modal" selected, the newsletter box indeterminate.
const PAGE_STATE = {
  url: 'about:blank',
  hash: null,
  historyState: null,
  localStorage: [],
  sessionStorage: [],
  cookies: [],
  focus: { element: { path: 'html:1/body:1/dialog:1/button:1', label: 'button#ok' }, visible: true },
  hover: { path: 'html:1/body:1/dialog:1/p:1', label: 'p "modal body"' },
  selection: {
    start: { path: 'html:1/body:1/dialog:1/p:1', offset: 0 },
    end: { path: 'html:1/body:1/dialog:1/p:1', offset: 5 },
    length: 5,
  },
  indeterminate: [{ path: 'html:1/body:1/input:2', label: 'input#news' }],
};

async function uploadFailingCase(request: APIRequestContext, version: string): Promise<number> {
  const testCase = {
    title: `profile form keeps its state (${version})`,
    location: `tests/profile-${version}.spec.ts:3:1`,
    retries: 0,
  };
  const start = await retryPost(request, '/api/test-runs/start', {
    data: { projectName: PROJECT.DOM_SNAPSHOT_STATE, startTime: new Date().toISOString() },
  });
  const { runId, streamToken } = await start.json();
  await retryPost(request, `/api/test-runs/${runId}/events`, {
    data: {
      streamToken,
      testCases: [
        {
          type: 'complete',
          ...testCase,
          status: 'failed',
          duration: 900,
          error: "TimeoutError: page.click: Timeout 300ms exceeded.\n  - waiting for locator('#missing')",
          ...(version === '1.63' ? { pageState: PAGE_STATE } : {}),
        },
      ],
    },
  });
  const bytes = trace(version);
  const form = new FormData();
  form.set('streamToken', streamToken);
  form.set('testCase', JSON.stringify(testCase));
  form.set('trace_hash', createHash('sha256').update(bytes).digest('hex'));
  form.append('trace', new Blob([bytes], { type: 'application/zip' }), 'trace.zip');
  const upload = await request.post(`/api/test-runs/${runId}/case-files`, { multipart: form });
  expect(upload.ok()).toBeTruthy();
  return (await upload.json()).executionId;
}

test.describe('DOM snapshot live state', () => {
  test.describe.configure({ mode: 'serial' });

  const executions: Record<string, number> = {};

  test.beforeAll(async ({ request }) => {
    for (const version of VERSIONS) executions[version] = await uploadFailingCase(request, version);
  });

  for (const version of VERSIONS) {
    test(`the frame shows the page as Playwright ${version} recorded it`, async ({ page }) => {
      await page.goto(`/api/test-run-cases/${executions[version]}/dom-snapshot-frame?mode=readonly`);

      await expect(page.locator('#name')).toHaveValue('Ada Lovelace');
      await expect(page.locator('#pw')).toHaveValue('••••••••');
      expect(await page.content()).not.toContain('hunter2');
      await expect(page.locator('#notes')).toHaveValue('typed notes');
      await expect(page.locator('#agree')).not.toBeChecked();
      await expect(page.locator('#news')).toBeChecked();
      await expect(page.locator('#country')).toHaveValue('de');
      await expect.poll(() => page.locator('#list').evaluate((el) => el.scrollTop)).toBe(120);

      await expect(page.locator('dialog:modal')).toHaveText(/modal body/);
      await expect(page.locator('#toast:popover-open')).toHaveText('Saved');

      // The shadow root, its adopted stylesheet, and `:defined` for the custom element.
      await expect(page.locator('#wc .title')).toHaveCSS('color', 'rgb(128, 0, 128)');
      await expect(page.locator('#wc')).toBeVisible();
      await expect(page.locator('body')).toHaveCSS('font-family', 'serif');
      // Nested CSS reaches the browser unescaped.
      await expect(page.locator('.card .inner')).toHaveCSS('color', 'rgb(0, 128, 0)');
    });

    test(`the action's target is outlined in its own snapshot (Playwright ${version})`, async ({ page }) => {
      await page.goto(
        `/api/test-run-cases/${executions[version]}/dom-snapshot-frame?mode=readonly&callId=${UNCHECK_CALL}&phase=after`,
      );
      await expect(page.locator('#agree')).toHaveCSS('outline-color', 'rgb(37, 99, 235)');
      await expect(page.locator('[data-piwi-target]')).toHaveCount(1);
    });

    test(`the mouse is shown, and the menu it hovered open (Playwright ${version})`, async ({ page }) => {
      await page.goto(
        `/api/test-run-cases/${executions[version]}/dom-snapshot-frame?mode=readonly&callId=${HOVER_CALL}&phase=after`,
      );
      // A menu only CSS `:hover` shows.
      await expect(page.locator('#products .submenu')).toBeVisible();
      const dot = await page.locator('#__piwi_pointer').boundingBox();
      expect(dot && { x: Math.round(dot.x + dot.width / 2), y: Math.round(dot.y + dot.height / 2) }).toEqual({
        x: 420,
        y: 25,
      });
    });
  }

  test('the failure-time frame shows the focus, hover, selection and checkbox the reporter read', async ({ page }) => {
    await page.goto(`/api/test-run-cases/${executions['1.63']}/dom-snapshot-frame?mode=readonly`);
    // The page's own `button:focus-visible` rule, on the button that held focus.
    await expect(page.locator('#ok')).toHaveCSS('outline-color', 'rgb(255, 0, 0)');
    await expect(page.locator('#ok')).toHaveAttribute('data-piwi-focus', '');
    await expect(page.locator('#dlg')).toHaveAttribute('data-piwi-focus-within', '');
    await expect(page.locator('dialog p')).toHaveAttribute('data-piwi-hover', '');
    expect(await page.evaluate(() => [...CSS.highlights.get('piwi-selection')!][0]!.toString())).toBe('modal');
    expect(await page.locator('#news').evaluate((box: HTMLInputElement) => box.indeterminate)).toBe(true);

    // Another moment of the test is not the page the reporter read.
    await page.goto(
      `/api/test-run-cases/${executions['1.63']}/dom-snapshot-frame?mode=readonly&callId=${HOVER_CALL}&phase=after`,
    );
    await expect(page.locator('[data-piwi-focus]')).toHaveCount(0);
  });

  test('the State tab names what the page was doing, never a value', async ({ page }) => {
    await page.goto(`/test-run-cases/${executions['1.63']}`);
    await waitForHydration(page);
    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'State', exact: true })
      .click();
    await expect(page.getByText('button#ok (focus ring shown)')).toBeVisible();
    await expect(page.getByText('p "modal body"')).toBeVisible();
    await expect(page.getByText('5 characters')).toBeVisible();
    await expect(page.getByText('input#news')).toBeVisible();
  });

  test('the Screen tab opens on the dialog the page showed, and keeps keyboard focus', async ({ page }) => {
    await page.goto(`/test-run-cases/${executions['1.63']}`);
    await waitForHydration(page);
    await page
      .getByRole('tablist', { name: 'Evidence sections' })
      .getByRole('tab', { name: 'Screen', exact: true })
      .click();
    const domTab = page.getByRole('tablist', { name: 'Screen view' }).getByRole('tab', { name: 'DOM', exact: true });
    await domTab.click();

    const iframe = page.locator('iframe[title="DOM at the failure"]');
    await expect(page.frameLocator('iframe[title="DOM at the failure"]').locator('dialog:modal')).toBeVisible();
    // The frame is as tall as the page, so the modal sits below the top and the stage scrolls to it.
    await expect.poll(() => iframe.evaluate((el) => el.parentElement!.parentElement!.scrollTop)).toBeGreaterThan(0);
    // Opening the recorded modal leaves keyboard focus in the dashboard.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME');
  });
});
