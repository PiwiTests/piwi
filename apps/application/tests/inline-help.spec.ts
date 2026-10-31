import { test, expect, type Page } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { DOCS_BASE_URL } from '#shared/docs';

/**
 * Verifies the inline-help affordance (`HelpHint`): the trigger is an
 * accessible button, activating it reveals the explanatory popover, the
 * "Learn more" link points at the right docs anchor, and a topic's recipe
 * shows as a second link labeled with its question.
 *
 * NOTE: in dev mode Vite compiles pages on-demand, so the SSR markup is
 * interactive only once the client bundle hydrates (a few seconds on first
 * load). `openHint` polls the click until the popover actually opens instead of
 * assuming the page is hydrated.
 */
async function openHint(page: Page, name: string) {
  // Some help topics are shared by a card header and a field label (e.g. the
  // wasted-time topic), so the same accessible name resolves to several
  // buttons. Target the first visible one — the card header hint.
  const trigger = page.getByRole('button', { name }).first();
  await trigger.waitFor({ state: 'visible', timeout: 15000 });
  await expect(async () => {
    await trigger.click();
    expect(await trigger.getAttribute('aria-expanded')).toBe('true');
  }).toPass({ timeout: 20000, intervals: [250] });
  return trigger;
}

test.describe('Inline help (HelpHint)', () => {
  test('MCP page help icon opens a popover with a docs link', async ({ page }) => {
    await page.goto('/mcp');

    await openHint(page, 'Help: What it provides');

    // Popover explanation is shown.
    await expect(page.getByText('The tools this MCP server exposes')).toBeVisible();

    // "Learn more" resolves through docsUrl() to the verified anchor.
    const learnMore = page.getByRole('link', { name: /Learn more/ });
    await expect(learnMore).toHaveAttribute('href', `${DOCS_BASE_URL}/features/mcp#what-it-provides`);
    await expect(learnMore).toHaveAttribute('target', '_blank');
  });

  test('project detail performance hint links to the slow-tests docs and its recipe', async ({ page, request }) => {
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.INLINE_HELP,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 5000,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          { title: 'a', status: 'passed', duration: 1000, location: 'tests/a.spec.ts:1:1' },
          { title: 'b', status: 'passed', duration: 1500, location: 'tests/b.spec.ts:1:1' },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const { projectId } = await res.json();

    await page.goto(`/projects/${projectId}?tab=performance`);

    await openHint(page, 'Help: Performance');

    await expect(page.getByText('Duration trends for the suite')).toBeVisible();
    const learnMore = page.getByRole('link', { name: /Learn more/ });
    await expect(learnMore).toHaveAttribute('href', `${DOCS_BASE_URL}/features/slow-tests`);

    // The topic's recipe is a second link, labeled with the recipe's question.
    const recipe = page.getByRole('link', { name: /Cut the time it costs/ });
    await expect(recipe).toHaveAttribute('href', `${DOCS_BASE_URL}/recipes/faster-suite`);
    await expect(recipe).toHaveAttribute('target', '_blank');
  });

  test('settings AI provider hint lists the backing PIWI_AI_* env vars', async ({ page }) => {
    await page.goto('/settings/ai');

    // The "AI provider" topic is the help of the "Provider" card header.
    await openHint(page, 'Help: AI provider');

    // The env vars that override the diagnosis provider are surfaced in the
    // popover (the system-admin affordance), each as a copyable code element.
    await expect(page.getByText('Environment variables:')).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'Help: AI provider' }).locator('code', { hasText: 'PIWI_AI_PROVIDER' }),
    ).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'Help: AI provider' }).locator('code', { hasText: 'PIWI_AI_API_KEY' }),
    ).toBeVisible();

    // A "Configuration reference" link points at the canonical docs page.
    const configLink = page.getByRole('link', { name: /Configuration reference/ });
    await expect(configLink).toHaveAttribute('href', `${DOCS_BASE_URL}/reference/configuration`);
    await expect(configLink).toHaveAttribute('target', '_blank');
  });

  test('settings wasted-time hint names PIWI_WASTED_WAIT_PATTERNS', async ({ page }) => {
    await page.goto('/settings/performance');

    // The "Wasted-time patterns" topic is used by both the card header and the
    // Patterns field label; target the first one (the card header).
    await openHint(page, 'Help: Wasted-time patterns');

    await expect(page.getByText('Environment variable:')).toBeVisible();
    await expect(page.locator('code', { hasText: 'PIWI_WASTED_WAIT_PATTERNS' })).toBeVisible();
  });
});
