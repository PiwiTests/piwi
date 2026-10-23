/**
 * The authored guides on an instance whose assistant has no AI model: the
 * command palette lists them under Guides, a keyword finds one, and picking it
 * starts it on its first stop; the assistant panel lists them while it cannot
 * answer, and starting one closes it; a stop whose entity the instance does not
 * hold shows centered with its anchor's `shownWhen`; a guide whose capability
 * the instance declined is not listed.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import type { AssistantStatus } from '#shared/assistant';
import { findGuideAnchor } from '../shared/guide-anchors/index.mjs';
import { waitForHydration } from './utils';

// One test declines a capability every test reads.
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const NO_MODEL: AssistantStatus = {
  available: false,
  reason: 'not-configured',
  provider: null,
  model: null,
  toolMode: null,
};

/** Opens `/` as an instance with no AI model answers the assistant's status. */
async function openWithoutModel(page: Page) {
  await page.route('**/api/assistant/status', (route) => route.fulfill({ json: NO_MODEL }));
  await page.goto('/');
  await waitForHydration(page);
}

/** Opens the command palette and types `term`; answers the palette's Guides group. */
async function searchPalette(page: Page, term: string) {
  await page.getByRole('button', { name: /^Search…/ }).click();
  await page.getByPlaceholder('Type a command or search…').fill(term);
  return page.getByRole('group', { name: 'Guides' });
}

/** The popover of a guide's stop once it is shown in place. */
function stopPopover(page: Page, guideId: string) {
  return page.locator(`.driver-popover.piwi-guide[data-guide="guide-${guideId}"][data-guide-settled]`);
}

test.describe('Guides', () => {
  test('the palette lists them with no AI model, and one starts on its first stop', async ({ page }) => {
    await openWithoutModel(page);
    await page.getByRole('button', { name: /^Search…/ }).click();
    const guides = page.getByRole('group', { name: 'Guides' });
    await expect(guides.getByRole('option', { name: /^Report a first run/ })).toBeVisible();
    await expect(guides.getByRole('option', { name: /^Set retention/ })).toBeVisible();

    // A keyword finds a guide whose title does not hold it.
    await page.getByPlaceholder('Type a command or search…').fill('ollama');
    await expect(guides.getByRole('option')).toHaveText([/^Configure AI/]);

    await page.getByPlaceholder('Type a command or search…').fill('Report a first run');
    await expect(guides.getByRole('option').first()).toHaveText(/^Report a first run/);
    await guides.getByRole('option').first().click();

    const popover = stopPopover(page, 'report-first-run');
    await expect(popover).toBeVisible({ timeout: 30_000 });
    await expect(popover).toHaveAttribute('data-guide-stop', 'wizard');
    await expect(popover).toHaveAttribute('data-guide-anchor', 'get-started-wizard');
    await expect(popover).toContainText('One command, or a few steps');
    await expect(popover.getByRole('link', { name: 'Read the docs' })).toHaveAttribute('href', /guide\/reporter/);
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.locator('[data-tour="get-started-wizard"].driver-active-element')).toBeVisible();
  });

  test('the assistant panel lists them while it cannot answer, and starting one closes it', async ({ page }) => {
    await openWithoutModel(page);
    const launcher = page.getByRole('button', { name: 'Ask Piwi' });
    await launcher.click();
    const panel = page.getByRole('dialog', { name: 'Ask Piwi' });
    const list = panel.locator('[data-assistant-unavailable] [data-guide-list]');
    await expect(list).toBeVisible();
    await list.locator('[data-guide-id="configure-ai"]').click();

    await expect(panel).toBeHidden();
    const popover = stopPopover(page, 'configure-ai');
    await expect(popover).toBeVisible({ timeout: 30_000 });
    await expect(popover).toHaveAttribute('data-guide-anchor', 'ai-model-providers');
    await expect(page).toHaveURL(/\/settings\/ai$/);
  });

  test('a stop whose entity the instance does not hold shows centered, saying when its anchor shows', async ({
    page,
  }) => {
    // No run: the guide finds no failure with a locator fix to open.
    await page.route('**/api/test-runs/recent', (route) => route.fulfill({ json: { items: [] } }));
    await openWithoutModel(page);
    const guides = await searchPalette(page, 'Apply a locator fix');
    await expect(guides.getByRole('option').first()).toHaveText(/^Apply a locator fix/);
    await guides.getByRole('option').first().click();

    const popover = stopPopover(page, 'apply-locator-fix');
    await expect(popover).toBeVisible({ timeout: 30_000 });
    await expect(popover).toHaveAttribute('data-guide-stop', 'locators');
    await expect(popover).toHaveAttribute('data-guide-anchor', '');
    await expect(popover.locator('.piwi-guide-note')).toHaveText(findGuideAnchor('evidence-locators')!.shownWhen!);
    await expect(page).toHaveURL(/\/$/);
  });

  test('a guide whose capability is declined is not listed', async ({ page, request }) => {
    const title = /^Turn on pull-request feedback/;
    await openWithoutModel(page);
    let guides = await searchPalette(page, 'pull-request feedback');
    await expect(guides.getByRole('option', { name: title })).toHaveCount(1);

    const declined = await request.patch('/api/capabilities', { data: { decisions: { 'pr-feedback': 'declined' } } });
    expect(declined.ok()).toBeTruthy();
    try {
      const states = (await (await request.get('/api/capabilities')).json()) as {
        items: { id: string; state: string }[];
      };
      expect(states.items.find((item) => item.id === 'pr-feedback')?.state).toBe('declined');
      await page.goto('/');
      await waitForHydration(page);
      guides = await searchPalette(page, 'pull-request feedback');
      await expect(page.getByRole('option', { name: /^Ask Piwi/ })).toBeVisible();
      await expect(guides.getByRole('option', { name: title })).toHaveCount(0);
    } finally {
      await request.patch('/api/capabilities', { data: { decisions: { 'pr-feedback': null } } });
    }
  });
});
