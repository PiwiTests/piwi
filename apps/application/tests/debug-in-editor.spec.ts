import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration } from './utils';
import { fakeJetbrainsIdes } from './utils/fake-jetbrains';

/**
 * Debug in my editor on a seeded failure: execution #37 fails in a helper its spec calls
 * (`tests/helpers/payment.ts:16`), and the Source tab's frame of that line offers the button
 * beside its open link. Its link is the IDE's open link with `debug=1`, the failing line, the
 * test's spec and title, its Playwright project and the execution: the Piwi extension's
 * `vscode://` link for VS Code, the Piwi plugin's open request for a JetBrains IDE (faked by
 * intercepting its requests, its checks carrying none of it). Skipped on a database without the
 * demo seed.
 */

const SEEDED = 37;
const FIELDS = {
  file: 'tests/helpers/payment.ts',
  line: '16',
  debug: '1',
  spec: 'tests/checkout/checkout.spec.ts',
  test: 'Checkout › should complete checkout with credit card',
  playwrightProject: 'Chromium',
  execution: String(SEEDED),
};

/** The Source tab of an execution, in its captured frames, with these IDE preferences. */
async function openTheSource(page: Page, prefs: Record<string, unknown>, id = SEEDED) {
  await page.addInitScript((p) => localStorage.setItem('piwi-ide-prefs', JSON.stringify(p)), prefs);
  await page.goto(`/test-run-cases/${id}?evidence=source`);
  await waitForHydration(page);
}

/**
 * The button beside the failing line's frame, in the captured frames. With a trace, the tab shows its full stack once
 * it loads, which names the seed's recording script, so the captured frames are chosen then.
 */
async function debugButton(page: Page) {
  const captured = page.getByRole('tab', { name: /^Captured/ });
  if (
    await captured.waitFor({ timeout: 20_000 }).then(
      () => true,
      () => false,
    )
  )
    await captured.click();
  const button = page.getByRole('button', { name: 'Debug in my editor' });
  await expect(button).toBeVisible();
  return button;
}

test.describe('Debug in my editor', () => {
  test.setTimeout(60_000);
  let hasSeed = false;
  test.beforeAll(async ({ request }) => {
    const answer = await request.get(`/api/test-run-cases/${SEEDED}`);
    const detail = answer.ok()
      ? ((await answer.json()) as { testSourceFrames?: Array<{ file: string }> | null })
      : null;
    hasSeed = detail?.testSourceFrames?.[0]?.file === FIELDS.file;
  });
  test.beforeEach(() => {
    test.skip(!hasSeed, 'demo seed not loaded on this server');
  });

  test('gives the Piwi extension’s link debug=1, the failing line and the test', async ({ page }) => {
    await openTheSource(page, { method: 'vscode', vscodeExtension: true });
    const button = await debugButton(page);
    await expect(button).toHaveAttribute('title', /^Open tests\/helpers\/payment\.ts:16 in your editor, which offers/);
    await button.click();
    // The link is launched in a hidden frame, removed a second later.
    const launched = await page.locator('iframe[src^="vscode://"]').getAttribute('src');
    expect(launched).toBe(
      'vscode://piwitests.piwi/open?file=tests%2Fhelpers%2Fpayment.ts&line=16&debug=1' +
        '&spec=tests%2Fcheckout%2Fcheckout.spec.ts' +
        '&test=Checkout%20%E2%80%BA%20should%20complete%20checkout%20with%20credit%20card' +
        `&playwrightProject=Chromium&execution=${SEEDED}`,
    );
    await expect(
      page.getByText('Asked the Piwi extension in VS Code to debug the test', { exact: true }),
    ).toBeVisible();
  });

  test('asks the JetBrains plugin with debug=1 on the open alone, and says the IDE took it', async ({ page }) => {
    const seen = await fakeJetbrainsIdes(page, [
      {
        port: 63342,
        ide: 'WebStorm',
        holds: true,
        open: { status: 200, body: { found: true, opened: true, debug: 'asked', ide: 'WebStorm', project: 'shop' } },
      },
    ]);
    await openTheSource(page, { method: 'auto' });
    await (await debugButton(page)).click();
    await expect(page.getByText('Asked WebStorm to debug the test', { exact: true })).toBeVisible();

    const opens = seen.filter((u) => !u.searchParams.has('check'));
    expect(opens.map((u) => [u.port, Object.fromEntries(u.searchParams)])).toEqual([
      ['63342', { ...FIELDS, project: 'e2e-checkout' }],
    ]);
    const checks = seen.filter((u) => u.searchParams.has('check'));
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) expect(check.searchParams.has('debug')).toBe(false);
  });

  test('says why the IDE refused to debug the test', async ({ page }) => {
    const refusal =
      'This Debug in my editor link was refused: tests/helpers/payment.ts is not a spec. Nothing was opened or run.';
    await fakeJetbrainsIdes(page, [
      {
        port: 63342,
        ide: 'WebStorm',
        holds: true,
        open: { status: 400, body: { found: true, opened: false, ide: 'WebStorm', error: refusal } },
      },
    ]);
    await openTheSource(page, { method: 'jetbrains-http' });
    await (await debugButton(page)).click();
    await expect(page.getByText('WebStorm refused to debug the test', { exact: true })).toBeVisible();
    await expect(page.getByText(refusal, { exact: true })).toBeVisible();
  });

  test('is offered on the failing line’s frame alone', async ({ page }) => {
    await openTheSource(page, { method: 'vscode', vscodeExtension: true });
    await debugButton(page);
    await expect(page.getByRole('button', { name: 'Debug in my editor' })).toHaveCount(1);
    // The caller's frame, the spec's own line, offers none.
    const caller = page.locator('div.rounded-lg', { hasText: 'tests/checkout/checkout.spec.ts:11' }).first();
    await expect(caller.getByRole('button', { name: 'Debug in my editor' })).toHaveCount(0);
  });
});
