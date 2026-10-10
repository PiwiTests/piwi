import type { Page } from '@playwright/test';
import { PICKER_MARKER_ATTRIBUTE, PICKER_MARKER_EVENT } from '@piwitests/core/picker-marker';
import { PICKER_CHROME_URL, PICKER_FIREFOX_URL } from '#shared/companion-links';
import { PROJECT } from '#shared/test-project-names';
import { resolveE2ETarget } from './desktop-target';
import { test, expect } from './fixtures';

// The hint to install Piwi Picker, on a project's empty bug reports: the store
// of this browser, Don't show again, and no hint once the extension marks the page.
test.describe.serial('Piwi Picker install hint', () => {
  test.skip(resolveE2ETarget().desktop, 'the desktop window shows no hint: no extension runs there');

  let projectId = 0;

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.PICKER_HINT,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'home loads', status: 'passed', duration: 10, location: 'tests/home.spec.ts:3:5' }],
      },
    });
    expect(response.ok()).toBeTruthy();
    ({ projectId } = (await response.json()) as { projectId: number });
  });

  const hint = (page: Page) => page.getByTestId('picker-install-hint');

  async function openBugReports(page: Page) {
    await page.goto(`/projects/${projectId}/bug-reports`);
    // A dev server compiles the page and its list endpoint on the first visit.
    await expect(page.getByText('No bug report yet')).toBeVisible({ timeout: 15_000 });
  }

  test('suggests the Chrome Web Store in Chrome, until Don’t show again', async ({ page }) => {
    await openBugReports(page);
    await expect(hint(page)).toBeVisible();
    await expect(hint(page).getByRole('link', { name: 'Chrome Web Store' })).toHaveAttribute('href', PICKER_CHROME_URL);

    await hint(page).getByRole('button', { name: 'Don’t show again' }).click();
    await expect(hint(page)).toHaveCount(0);
    await openBugReports(page);
    await expect(hint(page)).toHaveCount(0);
  });

  test('is gone as soon as the extension marks the page', async ({ page }) => {
    await openBugReports(page);
    await expect(hint(page)).toBeVisible();
    // What Piwi Picker's script does on its connected instance's pages, here after the page looked.
    await page.evaluate(
      ([attribute, event]) => {
        document.documentElement.setAttribute(attribute, '0.50.0');
        document.dispatchEvent(new Event(event));
      },
      [PICKER_MARKER_ATTRIBUTE, PICKER_MARKER_EVENT],
    );
    await expect(hint(page)).toHaveCount(0);
  });

  test('is not shown on a page the extension marked as it loaded', async ({ page }) => {
    await page.addInitScript(
      ([attribute, event]) => {
        document.addEventListener('DOMContentLoaded', () => {
          document.documentElement.setAttribute(attribute, '0.50.0');
          document.dispatchEvent(new Event(event));
        });
      },
      [PICKER_MARKER_ATTRIBUTE, PICKER_MARKER_EVENT],
    );
    await openBugReports(page);
    await expect(hint(page)).toHaveCount(0);
  });

  test.describe('in Firefox', () => {
    test.use({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0' });

    test('suggests Firefox Add-ons', async ({ page }) => {
      await openBugReports(page);
      await expect(hint(page).getByRole('link', { name: 'Firefox Add-ons' })).toHaveAttribute(
        'href',
        PICKER_FIREFOX_URL,
      );
    });
  });
});
