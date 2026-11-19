import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ENVIRONMENT, FOLDER, VIEWER, clipped, hubRun, playShell, read, root, runRequest, said } from './shell';

/**
 * Piwi Runner's window in another language than English, at its smallest size: the language the shell answers reaches
 * the page (`lang`), Runner's own words (the header, both views, the welcome, a run's card), the layer's (a run
 * request's confirmation and its checks, by their codes), the run model's (a stopped worker) and Nuxt UI's (a close
 * button), and no text is cut. The shell's bridge (`window.__TAURI__`) and the host's streams are played by the spec;
 * what each says comes from the catalogs.
 */

const LANGUAGES = [
  { code: 'fr', tag: 'fr', close: 'Fermer' },
  { code: 'de', tag: 'de', close: 'Schließen' },
];

const ESC = '\u001b';
/** What the run prints: Playwright's colors on, as the shell starts it. */
const OUTPUT = [
  'Running 1 test using 1 worker',
  `  ${ESC}[31m✘${ESC}[39m  1 ${ESC}[2m[chromium] › tests/checkout.spec.ts:3:1 › checkout › pays with a saved card${ESC}[22m`,
  `    Expected: ${ESC}[32m"Total: $45.00"${ESC}[39m`,
  `    Received: ${ESC}[31m"Total: $50.00"${ESC}[39m`,
  `  ${ESC}[31m1 failed${ESC}[39m`,
];

for (const { code, tag, close } of LANGUAGES) {
  test(`the window speaks ${code}, a run request and a stopped run included, with no text cut`, async ({ page }) => {
    const runner = read(`apps/runner/locales/${code}.json`);
    const layer = read(`packages/run-ui/locales/${code}.json`);
    const runWords = JSON.parse(
      readFileSync(path.join(root, `packages/run-model/src/words/${code}.json`), 'utf8'),
    ) as Record<string, string>;
    await playShell(page, code);
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', tag);
    const header = page.getByTestId('runner-header');
    await expect(header.getByText(said(runner, 'runner_connectedTo', { host: 'piwi.example.com' }))).toBeVisible();
    await expect(page.getByText(said(runner, 'runner_noRuns'))).toBeVisible();
    expect(await clipped(header)).toEqual([]);
    expect(await clipped(page.locator('main'))).toEqual([]);

    // The settings, a section at a time, from the connection's line: the connection (Disconnect asks first), the
    // folders, the general settings and About.
    await page.getByTestId('runner-status').click();
    await expect(header.getByRole('tab', { name: said(runner, 'runner_settingsHeading') })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const settings = page.getByTestId('runner-settings');
    const section = (key: string) => settings.getByRole('tab', { name: said(runner, key) }).click();
    await expect(settings.getByText(said(layer, 'runui_connectionStateOnline'))).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);
    await page.getByTestId('runner-disconnect').click();
    const question = page.getByTestId('runner-disconnect-question');
    await expect(
      question.getByText(said(runner, 'runner_disconnectQuestion', { host: 'piwi.example.com' })),
    ).toBeVisible();
    expect(await clipped(question)).toEqual([]);
    await question.getByRole('button', { name: said(layer, 'runui_commonCancel') }).click();
    await expect(question).toBeHidden();
    expect(await page.evaluate(() => window.__invoked)).not.toContain('desktop_forget_run_target');
    await page.getByTestId('runner-disconnect').click();
    await question.getByRole('button', { name: said(layer, 'runui_connectionDisconnect') }).click();
    await expect(question).toBeHidden();
    expect(await page.evaluate(() => window.__invoked)).toContain('desktop_forget_run_target');
    await section('runner_navFolders');
    await expect(page.getByTestId('runner-folders').getByText('Acme Checkout')).toBeVisible();
    await expect(page.getByTestId('runner-folders')).toContainText(FOLDER);
    await section('runner_navGeneral');
    await expect(page.getByRole('heading', { name: said(runner, 'runner_languageHeading') })).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);
    await section('runner_aboutHeading');
    await expect(page.getByTestId('runner-about').getByText(said(runner, 'runner_tagline'))).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);

    // A request: its confirmation, its checks said from their codes, and Nuxt UI's own close button.
    await page.evaluate((request) => window.__events.send('host', { type: 'run-request', request }), runRequest());
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText(said(layer, 'runui_requestTitleFor', { environment: ENVIRONMENT.name })),
    ).toBeVisible();
    const checks = dialog.getByTestId('team-run-request-checks');
    await expect(checks).toContainText(said(layer, 'runui_checkFolderLinked', { folder: FOLDER }));
    await expect(checks).toContainText(said(layer, 'runui_checkChangesUncommitted'));
    const tags = ENVIRONMENT.requiredTags.join(', ');
    await expect(checks).toContainText(
      said(layer, 'runui_checkEnvironmentProtected', { environment: ENVIRONMENT.name, tags }),
    );
    // A protected environment: Run waits for the box that names it.
    const protectedBox = dialog.getByTestId('team-run-request-protected');
    await expect(protectedBox).toContainText(
      said(layer, 'runui_requestProtectedNote', { environment: ENVIRONMENT.name, tags }),
    );
    const confirm = protectedBox.getByRole('checkbox', {
      name: said(layer, 'runui_requestProtectedConfirm', { environment: ENVIRONMENT.name }),
    });
    await expect(dialog.getByRole('button', { name: said(layer, 'runui_requestRun') })).toBeDisabled();
    await confirm.check();
    await expect(dialog.getByRole('button', { name: said(layer, 'runui_requestRun') })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: close })).toBeVisible();
    expect(await clipped(dialog)).toEqual([]);

    // Run: the window shows the runs again, the run's card under Running now names its project and tests; once it
    // failed, its row under Finished shows its output, with Playwright's colors and none of their codes.
    await dialog.getByRole('button', { name: said(layer, 'runui_requestRun') }).click();
    await expect(dialog).toBeHidden();
    const run = page.getByTestId('runner-running').getByTestId('runner-run');
    await expect(page.getByTestId('runner-running').getByRole('heading')).toContainText(
      said(runner, 'runner_runningHeading'),
    );
    await expect(run.getByText(said(runner, 'runner_statusRunning'))).toBeVisible();
    await expect(run).toContainText('checkout › pays with a saved card');
    await expect(run).not.toContainText('piwi.example.com');
    await expect(run).toContainText('Acme Checkout');
    await expect(run.getByText(said(layer, 'runui_tests_one', { count: '1' }))).toBeVisible();
    await expect(header.getByRole('tab', { name: said(runner, 'runner_runsHeading') })).toContainText('1');
    // Its workers live, once the hub names the run, with Hold failures; then its page on the instance.
    await page.evaluate((viewer) => window.__events.send('hub', { type: 'hello', viewer }), VIEWER);
    await page.evaluate(
      (event) => window.__events.send('hub', event),
      hubRun('desktop-1', { stopped: false, page: { id: 78, url: 'https://piwi.example.com/test-runs/78' } }),
    );
    await expect(run.getByTestId('runner-hold-failures')).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);
    for (const line of OUTPUT) {
      await page.evaluate((l) => window.__events.emit('piwi:local-run', { id: 1, kind: 'stdout', line: l }), line);
    }
    await page.evaluate(() => window.__events.emit('piwi:local-run', { id: 1, kind: 'exit', code: 1 }));
    await page.evaluate(
      (event) => window.__events.send('hub', event),
      hubRun('desktop-1', { ended: true, page: { id: 78, url: 'https://piwi.example.com/test-runs/78' } }),
    );
    await expect(run).toBeHidden();
    const ended = page.getByTestId('runner-finished').getByTestId('runner-run');
    await expect(page.getByTestId('runner-finished').getByRole('heading')).toContainText(
      said(runner, 'runner_finishedHeading'),
    );
    await expect(ended.getByText(said(runner, 'runner_statusFailed'))).toBeVisible();
    const output = ended.getByTestId('runner-run-output');
    await expect(output.locator('pre')).toBeVisible();
    await expect(output.locator('pre')).toContainText('Received: "Total: $50.00"');
    expect(await output.locator('pre').innerText()).not.toContain(ESC);
    await expect(output.locator('pre span[style*="color"]').first()).toBeVisible();
    await expect(output.getByRole('button', { name: said(runner, 'runner_copyOutput') })).toBeVisible();
    await expect(ended.getByText(runWords.runs_runNumber!.replace('$id$', '78'))).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);
    // Its row folds, and opens again with its output as it was.
    const toggle = ended.getByRole('button', { name: 'checkout › pays with a saved card' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(output).toBeHidden();
    await toggle.click();
    await expect(output.locator('pre')).toBeVisible();

    // Clear finished takes the ended run away.
    await page.getByTestId('runner-clear-finished').click();
    await expect(ended).toBeHidden();
    await expect(page.getByText(said(runner, 'runner_noRuns'))).toBeVisible();

    // A run the hub has and this window holds no entry for: its worker stopped at a Pause, in the run model's words,
    // counted on the Runs tab. The stop brings the runs back from the settings.
    await header.getByRole('tab', { name: said(runner, 'runner_settingsHeading') }).click();
    await expect(page.getByTestId('runner-settings')).toBeVisible();
    await page.evaluate((event) => window.__events.send('hub', event), hubRun());
    await expect(page.getByTestId('runner-settings')).toBeHidden();
    const unlisted = page.getByTestId('runner-unlisted-run');
    await expect(unlisted.getByText(said(runner, 'runner_stillRunning'))).toBeVisible();
    await expect(header.getByRole('tab', { name: said(runner, 'runner_runsHeading') })).toContainText('1');
    await expect(unlisted.getByText(runWords.runs_stoppedPause!, { exact: true }).first()).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);
  });

  test(`the window speaks ${code} before it is connected, with no text cut`, async ({ page }) => {
    const runner = read(`apps/runner/locales/${code}.json`);
    const layer = read(`packages/run-ui/locales/${code}.json`);
    await playShell(page, code, 'none');
    await page.goto('/');

    const welcome = page.getByTestId('runner-welcome');
    await expect(welcome.getByRole('heading', { name: said(runner, 'runner_welcomeHeading') })).toBeVisible();
    await expect(welcome.getByText(said(runner, 'runner_tagline'))).toBeVisible();
    await expect(
      welcome.getByText(said(runner, 'runner_stepConfirm', { run: said(layer, 'runui_requestRun') })),
    ).toBeVisible();
    await expect(welcome.getByRole('button', { name: said(layer, 'runui_connectionConnect') })).toBeVisible();
    await expect(page.getByTestId('runner-status')).toHaveText(said(layer, 'runui_connectionStateNone'));
    expect(await clipped(page.getByTestId('runner-header'))).toEqual([]);
    expect(await clipped(page.locator('main'))).toEqual([]);
  });

  test(`the window speaks ${code} while the instance does not answer, with no text cut`, async ({ page }) => {
    const runner = read(`apps/runner/locales/${code}.json`);
    await playShell(page, code, 'offline');
    await page.goto('/');

    const host = 'piwi.example.com';
    await expect(page.getByTestId('runner-status')).toHaveText(said(runner, 'runner_reconnectingTo', { host }));
    await expect(page.getByTestId('runner-offline')).toHaveText(said(runner, 'runner_offline', { host }));
    expect(await clipped(page.getByTestId('runner-header'))).toEqual([]);
    expect(await clipped(page.locator('main'))).toEqual([]);
  });
}
