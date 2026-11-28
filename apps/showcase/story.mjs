// The story, beat by beat: what the viewer reads (the lines), the windows each beat is about (`focus`), what it does
// on the real tools (`run`, through the gestures) and what it must have left (`check`).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beat, expect, waitFor } from './lib/script.mjs';
import { TILES } from './lib/set.mjs';
import { Agent, refOf, runsServer } from './lib/agent.mjs';
import { dataUrlBytes, decodeImage, likeness } from './lib/likeness.mjs';
import {
  RUN_VERDICT,
  laneLogProblems,
  readWatchLog,
  recordWatch,
  runningLines,
  tileProblems,
  watchedProblems,
} from './lib/watching.mjs';
import { PAGE_OBJECT, SPEC, push, read } from './lib/workspace.mjs';

/** The page object's line the test fails at, and the call on it. */
const FAILING_LINE = 19;
const BROKEN = "getByRole('button', { name: 'Place order' })";
const FIXED = "getByRole('button', { name: 'Pay now' })";

/** The spec's line that checks the order's summary, past the thank-you page. */
const SUMMARY_LINE = 29;

/** The step the recording writes for the box the redesign added. */
const TERMS = "getByRole('checkbox', { name: 'I accept the terms' })";

/** `text` as a regular expression's literal. */
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The test the developer starts in the last part, its last line the place it stops at, which the agent finishes. */
const NEW_TEST_TITLE = 'opens the orders after checkout';
const NEW_TEST_LAST = "await expect(page.getByRole('link', { name: 'Cart' })).toHaveText('Cart (0)');";
const NEW_TEST = [
  `  test('${NEW_TEST_TITLE}', feature('Orders'), async ({ page, signedIn, productsPage, checkoutPage, shopper }) => {`,
  "    await productsPage.addToCart('Water bottle');",
  "    await page.getByRole('link', { name: 'Cart' }).click();",
  "    await page.getByRole('button', { name: 'Checkout' }).click();",
  '    await checkoutPage.placeOrder(shopper);',
  `    ${NEW_TEST_LAST}`,
  '  });',
  '',
].join('\n');

/** The command that runs the test at the cursor headed, stopping at the editor's breakpoints. */
const DEBUG_AT_CURSOR = 'Piwi: Debug the test at the cursor';

/** The command that gives an agent the runs' MCP server. */
const COPY_RUNS_MCP = "Piwi: Copy the runs' MCP server configuration for agents";

/**
 * Brings `file` up in VS Code's editor, focused, as a person does: a click on its tab when it has one, else Quick Open
 * on its name (`shop.spec`), Enter once its row leads the list.
 */
async function openFile(vscode, gesture, file) {
  const name = file.split('/').pop();
  const tab = vscode.locator('.editor-group-container.active .tab', { hasText: name }).first();
  if (await tab.count()) await gesture.click('vscode', tab);
  else {
    await gesture.press('vscode', 'Control+P');
    await gesture.type('vscode', vscode.locator('.quick-input-widget input'), name.replace(/\.[^.]+$/, ''));
    await vscode.locator('.quick-input-list .monaco-list-row').first().filter({ hasText: name }).waitFor();
    await gesture.press('vscode', 'Enter');
  }
  await vscode.locator('.editor-group-container.active .tab.active', { hasText: name }).waitFor();
}

/**
 * Puts the active editor's cursor on `line`, as a person does: a click on the line when the editor shows it whole,
 * else Go to Line (Ctrl+G) and its number.
 */
async function goToLine(vscode, gesture, line) {
  const editor = vscode.locator('.editor-group-container.active .monaco-editor').first();
  const number = editor.locator('.line-numbers', { hasText: new RegExp(`^\\s*${line}\\s*$`) }).first();
  const view = await editor.locator('.editor-scrollable').first().boundingBox();
  const box = (await number.count()) ? await number.boundingBox() : null;
  if (box && view && box.y >= view.y && box.y + 2 * box.height <= view.y + view.height) {
    const lines = editor.locator('.view-lines').first();
    const area = await lines.boundingBox();
    const x = view.x - area.x + Math.min(240, view.width / 3);
    await gesture.click('vscode', lines, { position: { x, y: box.y - area.y + box.height / 2 } });
  } else {
    await gesture.press('vscode', 'Control+G');
    await gesture.type('vscode', vscode.locator('.quick-input-widget input'), String(line));
    await gesture.press('vscode', 'Enter');
  }
  await cursorLine(vscode, line).waitFor();
}

/** The active editor's line number of the cursor, once it stands on `line`. */
const cursorLine = (vscode, line) =>
  vscode.locator('.editor-group-container.active .line-numbers.active-line-number', {
    hasText: new RegExp(`^\\s*${line}\\s*$`),
  });

/** The spec's line where the test titled `title` starts, as the checkout's file stands now. */
const testLine = (repo, title) =>
  read(repo.shop, SPEC)
    .split('\n')
    .findIndex((text) => text.includes(`test('${title}'`)) + 1;

/** Waits until VS Code marks the line a running test is in, and gives the marks. */
const runningLineShown = (vscode) =>
  waitFor(
    async () => {
      const marks = await runningLines(vscode);
      return marks.length ? marks : null;
    },
    'the running line in the spec',
    120_000,
  );

/** Closes VS Code's worker panel by its tab's Close button, and the code has the window again. */
async function closeWorkerPanel(vscode, gesture) {
  const tab = vscode.getByRole('tab', { name: /^Piwi: worker/ });
  await gesture.click('vscode', tab.getByRole('button', { name: /^Close/ }));
  await tab.waitFor({ state: 'detached' });
}

/** Waits until the Runs window shows no live run of the checkout: the one going on ended. */
const runEnded = (runs) => waitFor(async () => (await runCard(runs).count()) === 0, 'the run to end', 60_000);

/** The statuses of a test that ended. */
const FINISHED = new Set(['passed', 'failed', 'timedout', 'skipped', 'interrupted']);

/** The run card of the developer's checkout in the Runs window. */
const runCard = (runs) => runs.getByRole('region', { name: 'shop' }).and(runs.locator('.run:not(.ended)'));

/** What hides Piwi's pause bar from an image of the page, as the reporter hides it from the stop's image. */
const PAUSE_BAR_HIDDEN = '#__piwi-pause-bar { display: none !important; }';

/** How long VS Code's worker panel is watched showing a running test. */
const WATCH_MS = 5000;

/** The workers of the fix's CI run: one for each test of the shop's suite, so Watch all shows them side by side. */
const CI_WORKERS = 3;

/** The name of the image of the page in VS Code's worker panel ("Piwi: worker N"). */
const WORKER_IMAGE = "The page of the worker's test";

/** The frame of VS Code's worker panel, a webview beside the editor, once it shows; null before. */
async function workerView(vscode) {
  for (const frame of vscode.frames()) {
    if (
      await frame
        .locator(`img#page[alt="${WORKER_IMAGE}"]`)
        .count()
        .catch(() => 0)
    )
      return frame;
  }
  return null;
}

/**
 * Runs `act` with `SLOW_MO` in the checkout's `.env`, which its Playwright config reads, so a run started from the
 * editor meanwhile is slowed enough to watch, as the fix's CI run is; the `.env` is put back after.
 */
async function slowedDown(shop, act) {
  const file = path.join(shop, '.env');
  const env = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, `${env}SLOW_MO=1000\n`);
  try {
    return await act();
  } finally {
    fs.writeFileSync(file, env);
  }
}

export const STORY = [
  beat({
    id: 'title',
    title: 'Piwi',
    seconds: 4,
    focus: ['card'],
    lines: { en: ['From a red run to a fixed test, without leaving your flow.'] },
  }),

  beat({
    id: 'red-run',
    title: 'The red run',
    part: { title: 'CI is red', what: 'The failure page names the locator that broke.' },
    seconds: 22,
    focus: ['dashboard'],
    lines: {
      en: [
        'The checkout was redesigned, and CI went red on main.',
        'Piwi kept the failure: the page, the timeline, the locator that broke.',
      ],
    },
    async run({ dashboard, gesture, instance, state }) {
      const [red] = await instance.runs();
      state.redRun = await instance.run(red.id);
      state.failing = state.redRun.testCases.find((c) => c.title === 'places an order');
      await dashboard.bringToFront();
      await dashboard.reload({ waitUntil: 'domcontentloaded' });
      await gesture.click('dashboard', dashboard.getByRole('link', { name: `Run #${red.id}`, exact: true }));
      await dashboard.waitForURL(`**/test-runs/${red.id}`);
      await gesture.click('dashboard', dashboard.getByRole('link', { name: /places an order/ }).first());
      await dashboard.waitForURL(`**/test-run-cases/${state.failing.executionId}`);
      await dashboard
        .getByRole('heading', { level: 1 })
        .or(dashboard.getByText('was not found on the page'))
        .first()
        .waitFor();
    },
    async check({ dashboard, state, instance }) {
      const run = state.redRun;
      expect(run.status === 'failed', `the latest run is red (${run.status})`);
      expect(run.origin === 'ci', `the latest run is a CI run (${run.origin})`);
      expect(run.branch === 'main', `the latest run is on main (${run.branch})`);
      expect(state.failing?.status === 'failed', `places an order failed (${state.failing?.status})`);
      await waitFor(
        () =>
          dashboard
            .getByText(/was not found on the page/)
            .first()
            .isVisible(),
        'the failure page naming the missing button',
      );
      const headline = await dashboard
        .getByText(/was not found on the page/)
        .first()
        .innerText();
      expect(headline.includes('Place order'), `the headline names the button: ${headline}`);
      const healing = await instance.api(`/api/test-run-cases/${state.failing.executionId}/locator-healing`);
      expect(
        healing && 'recommendation' in healing && 'source' in healing && 'failingLocator' in healing,
        `the healing answers its candidate: ${JSON.stringify(healing).slice(0, 200)}`,
      );
      expect(
        healing.failingLocator?.method === 'getByRole' && healing.failingLocator.args?.name === 'Place order',
        `the healing reads the broken locator: ${JSON.stringify(healing.failingLocator)}`,
      );
      const candidate = healing.recommendation?.recommended?.locator ?? null;
      expect(candidate === FIXED, `the healing's candidate is ${FIXED}: ${candidate}`);
      const text = (selector) => async () => {
        const element = dashboard.locator(selector).first();
        return (await element.isVisible()) ? element.innerText() : null;
      };
      const panel = await waitFor(text('[data-shot="alternative-locators"]'), "the failure page's healing panel");
      expect(panel.includes("'Pay now'"), `the healing panel's candidate is ${FIXED}: ${panel.slice(0, 200)}`);
      const mostLikely = await waitFor(text('[data-shot="most-likely"]'), "the failure page's Most likely");
      expect(/Pay now|Place order/.test(mostLikely), `Most likely names the button: ${mostLikely.slice(0, 200)}`);
    },
  }),

  beat({
    id: 'to-the-editor',
    title: 'To the editor',
    part: { title: 'Debug in VS Code', what: 'The test runs in the editor and stops at its line.' },
    seconds: 14,
    focus: ['dashboard', 'vscode'],
    lines: {
      en: ['Debug in my editor: VS Code opens the failing line,', 'and runs the test there, headed, stopping at it.'],
    },
    async run({ dashboard, vscode, gesture, set, state }) {
      await gesture.click('dashboard', dashboard.getByRole('tab', { name: /Source/ }));
      const links = set.editorLinks.length;
      await gesture.click('dashboard', dashboard.getByRole('button', { name: 'Debug in my editor' }).first());
      state.debugLink = await waitFor(() => set.editorLinks[links], 'the link the dashboard handed to VS Code');
      const prompt = vscode.locator('.notification-toast', { hasText: 'Debug this test here?' });
      await gesture.click('vscode', prompt.getByRole('button', { name: 'Debug' }));
    },
    async check({ vscode, state }) {
      const link = new URL(state.debugLink);
      expect(link.protocol === 'vscode:' && link.host === 'piwitests.piwi', `a link to Piwi's extension: ${link}`);
      const field = (name) => link.searchParams.get(name);
      expect(field('debug') === '1', 'the link asks to debug');
      expect(field('file') === PAGE_OBJECT && field('line') === String(FAILING_LINE), `the failing line: ${link}`);
      expect(field('spec') === SPEC && field('test') === 'shop › places an order', `the test to run: ${link}`);
      await waitFor(
        () => vscode.locator('.tab.active', { hasText: 'checkout-page.ts' }).isVisible(),
        'the page object open in VS Code',
      );
      await waitFor(() => cursorLine(vscode, FAILING_LINE).isVisible(), `the cursor on line ${FAILING_LINE}`);
    },
  }),

  beat({
    id: 'run-followed',
    title: 'The run, followed',
    seconds: 10,
    focus: ['test-browser', 'runs'],
    lines: { en: ["The test's browser opens beside the editor,", 'and Piwi Picker follows the run.'] },
    async run({ runs, testPage }) {
      await testPage();
      await runCard(runs).getByText('shop › places an order').waitFor({ timeout: 60_000 });
    },
    async check({ runs, testPage }) {
      const card = runCard(runs);
      const text = await card.innerText();
      expect(text.includes('acme-shop') && text.includes('Visual Studio Code'), `the run names its project and editor`);
      // The editor names the spec by its whole path, anchored at its start.
      expect(
        new RegExp(`npx playwright test "\\^/\\S*/${escaped(SPEC)}:21" --workers=1 --headed`).test(text),
        `the run is the test, headed, one worker: ${text.split('\n').slice(0, 4).join(' | ')}`,
      );
      const page = await testPage();
      // Read between the test's navigations.
      const placed = await waitFor(
        () =>
          page.evaluate(() => ({
            x: window.screenX,
            y: window.screenY,
            width: window.outerWidth,
            height: window.outerHeight,
          })),
        "the test's window's place",
      );
      const tile = TILES.testBrowser;
      expect(
        Math.abs(placed.x - tile.x) <= 8 &&
          Math.abs(placed.y - tile.y) <= 8 &&
          Math.abs(placed.width - tile.width) <= 16,
        `the test's browser at its tile: ${JSON.stringify(placed)}`,
      );
    },
  }),

  beat({
    id: 'paused',
    title: 'Paused',
    seconds: 14,
    focus: ['vscode', 'test-browser', 'runs'],
    lines: {
      en: ['The test stops at the failing line.', 'The editor, the page and Piwi Picker show the same place.'],
    },
    async run({ runs }) {
      await runCard(runs).getByText('Stopped at a breakpoint').waitFor({ timeout: 90_000 });
    },
    async check({ vscode, runs, testPage, set }) {
      const row = vscode
        .locator('.codelens-decoration', { hasText: `Stopped at a breakpoint · Click ${BROKEN}` })
        .first();
      await waitFor(() => row.isVisible(), 'the paused line in VS Code');
      // The stop row ends inside the editor it is drawn in: none of its controls lies past the editor's right edge.
      const fits = await row.evaluate((el) => {
        const box = el.closest('.monaco-editor')?.querySelector('.editor-scrollable')?.getBoundingClientRect();
        const ends = [...el.children].map((child) => child.getBoundingClientRect().right);
        return { right: Math.max(el.getBoundingClientRect().left, ...ends), box: box?.right ?? null };
      });
      expect(fits.box !== null && fits.right <= fits.box, `the stop row fits its editor: ${JSON.stringify(fits)}`);
      await waitFor(
        () => vscode.locator('.editor-actions .codicon-debug-continue').first().isVisible(),
        "the run's controls in the editor's title",
      );
      await waitFor(
        () =>
          vscode
            .locator('.statusbar-item', { hasText: `stopped at a breakpoint · checkout-page.ts:${FAILING_LINE}` })
            .first()
            .isVisible(),
        'where the test stands in the status bar',
      );
      const page = await testPage();
      await waitFor(
        () => page.getByText(`Paused at checkout-page.ts:${FAILING_LINE}`).first().isVisible(),
        "Piwi's pause bar in the test's page",
      );
      const card = runCard(runs);
      await waitFor(() => card.getByText(`${PAGE_OBJECT}:${FAILING_LINE}`).isVisible(), 'the stop in the Runs window');
      const image = card.getByRole('img', { name: `The test’s page, stopped before: Click ${BROKEN}` });
      const width = await waitFor(
        () => image.evaluate((img) => img.complete && img.naturalWidth),
        'the image of the stopped page',
      );
      expect(width > 100, `the image of the stopped page is ${width} pixels wide`);
      // The image shows the page as it stands, not tiled, cut or stretched: alike a screenshot of it, taken without the
      // pause bar as the image is. Both are kept beside the logs when they differ.
      const bytes = dataUrlBytes(await image.getAttribute('src'));
      const screenshot = await page.screenshot({ scale: 'css', style: PAUSE_BAR_HIDDEN });
      const shown = decodeImage(bytes);
      const alike = likeness(shown, decodeImage(screenshot));
      if (!alike.same) {
        fs.writeFileSync(path.join(set.logs, 'stop-image.jpg'), bytes);
        fs.writeFileSync(path.join(set.logs, 'stop-page.png'), screenshot);
      }
      expect(alike.same, `the image of the stopped page shows the page: ${JSON.stringify(alike)}`);
      const drawn = await image.evaluate((img) => ({ width: img.clientWidth, height: img.clientHeight }));
      const stretch = Math.abs(drawn.width / drawn.height / (shown.width / shown.height) - 1);
      expect(stretch < 0.02, `the Runs window draws the image at its shape: ${JSON.stringify(drawn)}`);
    },
  }),

  beat({
    id: 'right-locator',
    title: 'The right locator',
    part: { title: 'Fix the test', what: 'Pick the locator, record a step, check the order.' },
    seconds: 18,
    focus: ['runs', 'test-browser', 'vscode'],
    lines: {
      en: ['Pick the button on the page.', 'The locator is written at the line where the test stopped.'],
    },
    async run({ runs, testPage, vscode, gesture, palette }) {
      await gesture.click('runs', runCard(runs).getByRole('button', { name: 'Pick', exact: true }));
      const page = await testPage();
      await gesture.click('test-browser', page.getByRole('button', { name: 'Pay now' }));
      await gesture.click('test-browser', page.getByRole('button', { name: 'Skip (Esc)' }));
      await gesture.click('test-browser', page.getByRole('button', { name: new RegExp(escaped(FIXED)) }));
      await vscode.locator('.view-line', { hasText: "name: 'Pay now'" }).waitFor({ timeout: 30_000 });
      await palette('File: Save All');
    },
    async check({ repo }) {
      const lines = read(repo.shop, PAGE_OBJECT).split('\n');
      expect(
        lines[FAILING_LINE - 1] === `    await this.page.${FIXED}.click();`,
        `line ${FAILING_LINE} clicks the picked locator: ${lines[FAILING_LINE - 1]}`,
      );
      expect(!lines.join('\n').includes(BROKEN), 'the broken locator is gone');
    },
  }),

  beat({
    id: 'missing-step',
    title: 'The missing step',
    seconds: 18,
    focus: ['vscode', 'test-browser', 'vscode'],
    lines: {
      en: ['The redesign also added a box to tick.', 'Record at the stop: the click becomes a step above the line.'],
    },
    async run({ vscode, testPage, gesture, palette }) {
      await palette('Piwi: Record at the stop');
      const page = await testPage();
      // The recorder records once it has its first step, the page it starts on, which the editor counts.
      await vscode.locator('.statusbar-item', { hasText: 'Piwi: recording · 1 step' }).waitFor({ timeout: 30_000 });
      await gesture.click('test-browser', page.getByLabel('I accept the terms'));
      await vscode.locator('.view-line', { hasText: 'I accept the terms' }).waitFor({ timeout: 30_000 });
      // Stop above the block in the editor: the page's own bar is in a closed shadow root, out of a script's reach.
      await gesture.click('vscode', vscode.locator('.codelens-decoration a', { hasText: /^Stop$/ }).first());
      await vscode.locator('.statusbar-item', { hasText: 'Piwi: recording' }).waitFor({ state: 'hidden' });
      await palette('File: Save All');
    },
    async check({ repo }) {
      const lines = read(repo.shop, PAGE_OBJECT).split('\n');
      expect(
        lines[FAILING_LINE - 1] === `    await this.page.${TERMS}.check();`,
        `the recorded step stands above the click: ${lines[FAILING_LINE - 1]}`,
      );
      expect(
        lines[FAILING_LINE] === `    await this.page.${FIXED}.click();`,
        `the click follows: ${lines[FAILING_LINE]}`,
      );
    },
  }),

  beat({
    id: 'check-order',
    title: 'Check the order',
    seconds: 18,
    focus: ['runs', 'vscode', 'test-browser', 'vscode'],
    lines: {
      en: [
        'The stopped test still runs its old code: end it,',
        'and debug the fixed test to the summary check.',
        'Assert a region writes what the order page shows.',
      ],
    },
    budget: 240_000,
    async run({ runs, vscode, testPage, gesture, palette }) {
      await gesture.click('runs', runCard(runs).getByRole('button', { name: 'End the test' }));
      await runEnded(runs);
      await openFile(vscode, gesture, SPEC);
      await goToLine(vscode, gesture, SUMMARY_LINE);
      await gesture.press('vscode', 'F9');
      // Debug with Piwi runs the test headed and stops at the editor's breakpoints, which a plain run passes.
      await palette(DEBUG_AT_CURSOR);
      await runCard(runs).getByText(`${SPEC}:${SUMMARY_LINE}`).waitFor({ timeout: 120_000 });
      await vscode
        .locator('.codelens-decoration', { hasText: 'Stopped at a breakpoint · Expect' })
        .first()
        .waitFor({ timeout: 30_000 });
      // Assert a region is folded under More, beside the stop's other code tools.
      await gesture.click('runs', runCard(runs).getByRole('button', { name: 'More', exact: true }));
      await gesture.click('runs', runCard(runs).getByRole('button', { name: 'Assert a region' }));
      const page = await testPage();
      // The order's card, by its corner: the picker takes the element under the pointer.
      await gesture.click('test-browser', page.locator('main .card'), { position: { x: 12, y: 12 } });
      await gesture.click('test-browser', page.locator('#__piwi_picker_choices button').first());
      await vscode.locator('.view-line', { hasText: 'toMatchAriaSnapshot' }).waitFor({ timeout: 30_000 });
      await palette('File: Save All');
    },
    async check({ repo }) {
      const lines = read(repo.shop, SPEC).split('\n');
      const at = lines.findIndex((line) => line.includes('toMatchAriaSnapshot('));
      const summary = lines.findIndex((line) => line.includes("page.locator('#summary')"));
      expect(at >= 0, 'a toMatchAriaSnapshot in the spec');
      expect(at < summary, `the region's check stands above the summary check (lines ${at + 1} and ${summary + 1})`);
      const snapshot = lines.slice(at, summary).join('\n');
      expect(
        snapshot.includes('- heading "Thank you, Alice Martin!" [level=1]'),
        `the region was read past the thank-you page:\n${snapshot}`,
      );
    },
  }),

  beat({
    id: 'green',
    title: 'Green',
    seconds: 8,
    focus: ['runs', 'vscode'],
    lines: { en: ['Resume: the test passes, and the editor shows it.'] },
    async run({ runs, gesture, vscode, palette }) {
      await gesture.click('runs', runCard(runs).getByRole('button', { name: 'Resume' }));
      await runEnded(runs);
      await palette('Testing: Focus on Test Explorer View');
      const tree = vscode.getByRole('tree', { name: 'Test Explorer' });
      // Down to the spec's describe block, the last of the tree's items named shop (its root is the checkout's).
      for (const name of [/^tests \(/, /^shop\.spec\.ts \(/, /^shop \(/]) {
        const item = tree.getByRole('treeitem', { name }).last();
        await item.waitFor({ timeout: 30_000 });
        if ((await item.getAttribute('aria-expanded')) !== 'true') {
          await gesture.click('vscode', item);
          if ((await item.getAttribute('aria-expanded')) !== 'true') await gesture.press('vscode', 'ArrowRight');
        }
      }
    },
    async check({ vscode, instance, state }) {
      const tree = vscode.getByRole('tree', { name: 'Test Explorer' });
      await waitFor(
        () => tree.getByRole('treeitem', { name: 'places an order (Passed)' }).isVisible(),
        "the test green in VS Code's Testing view",
      );
      // The Testing view lists the tests through the checkout's own Playwright, linked from this repository.
      const refused = await tree.getByText(/Playwright is not installed/).count();
      expect(refused === 0, "the Testing view found the checkout's Playwright");
      const [latest] = await instance.runs();
      expect(latest.id !== state.redRun.id, 'the run from the editor reached the instance');
      const run = await instance.run(latest.id);
      expect(run.origin !== 'ci', `the run is the developer's, not CI's (${run.origin})`);
      const test = run.testCases.find((c) => c.title === 'places an order');
      expect(test?.status === 'passed', `places an order passed there (${test?.status})`);
    },
  }),

  beat({
    id: 'watch-running',
    title: 'In the editor',
    part: { title: 'Watch it run', what: 'Each worker’s page, live: in the editor, then on CI.' },
    seconds: 14,
    focus: ['vscode'],
    budget: 240_000,
    lines: {
      en: [
        'Run it once more, headless: the editor marks the line it runs,',
        'and Watch shows its page live, beside the code.',
      ],
    },
    async run({ vscode, runs, gesture, palette, repo, instance, state }) {
      state.beforeWatched = (await instance.runs()).map((r) => r.id);
      // The Testing view the last beat opened gives its room back to the code and the worker's panel.
      await palette('View: Close Primary Side Bar');
      await slowedDown(repo.shop, async () => {
        await openFile(vscode, gesture, SPEC);
        await goToLine(vscode, gesture, testLine(repo, 'places an order'));
        await gesture.press('vscode', 'Control+Shift+Alt+K');
        // The editor marks the line of the call the test is in, once the test reaches the spec's own calls.
        state.runningLines = await runningLineShown(vscode);
        await palette("Piwi: Watch a worker's test");
        const view = await waitFor(() => workerView(vscode), "the worker's panel beside the editor");
        const image = view.locator(`img#page[alt="${WORKER_IMAGE}"]`);
        const stopped = view.locator('#controls:not([hidden])');
        // What the panel shows of the running test, and when, as often as it can be read for WATCH_MS.
        const looks = [];
        const until = Date.now() + WATCH_MS;
        await waitFor(
          async () => {
            const src = await image.getAttribute('src', { timeout: 1000 }).catch(() => null);
            looks.push({ t: Date.now(), src, stopped: await stopped.count() });
            return Date.now() >= until;
          },
          `${WATCH_MS / 1000} s of the running test in the worker's panel`,
          WATCH_MS + 10_000,
        );
        state.watchedRunning = looks;
        await runEnded(runs);
      });
      await closeWorkerPanel(vscode, gesture);
    },
    async check({ instance, state }) {
      // The worker, then the call as its call log names it: `Worker 1 · Click getByRole('link', { name: 'Cart' })`.
      expect(
        state.runningLines.some((mark) => /^Worker 1 · [A-Z]\w* /.test(mark)),
        `the running line names the worker and its call: ${JSON.stringify(state.runningLines)}`,
      );
      const problems = watchedProblems(state.watchedRunning);
      expect(!problems.length, `the worker's panel showed the running test: ${problems.join('; ')}`);
      const test = await waitFor(async () => {
        const latest = (await instance.runs()).find((r) => !state.beforeWatched.includes(r.id));
        const found = latest && (await instance.run(latest.id)).testCases.find((c) => c.title === 'places an order');
        return found && FINISHED.has(found.status) ? found : null;
      }, 'the watched run on the instance, its test ended');
      expect(test.status === 'passed', `the watched test passed (${test.status})`);
    },
  }),

  beat({
    id: 'back-on-the-team',
    title: 'On CI, paused',
    seconds: 22,
    focus: ['dashboard'],
    budget: 240_000,
    lines: {
      en: [
        'The fix is pushed, and CI runs the suite on three workers.',
        'Watch all shows each worker’s page, live.',
        'Pause one from the run page: the CI test waits for a look.',
      ],
    },
    async run({ set, repo, dashboard, instance, gesture, state }) {
      gesture.note('the fix is committed and pushed');
      state.fixCommit = push(repo.shop, 'Fix the checkout test for the redesign');
      const before = (await instance.runs()).map((r) => r.id);
      // A CI run slowed enough to watch, as a long suite's run is, each of its tests on a worker of its own.
      state.ci = set.ci(state.fixCommit, 'ci-fix', { SLOW_MO: '1000' }, [`--workers=${CI_WORKERS}`]);
      const live = await waitFor(
        async () => (await instance.runs()).find((r) => !before.includes(r.id)),
        'the CI run of the fix on the instance',
        120_000,
      );
      state.liveRun = live.id;
      await dashboard.bringToFront();
      await dashboard.goto(`${instance.base}/projects/${set.projectId}`, { waitUntil: 'domcontentloaded' });
      await gesture.click('dashboard', dashboard.getByRole('link', { name: `Run #${live.id}`, exact: true }));
      await dashboard.waitForURL(`**/test-runs/${live.id}`);
      await recordWatch(dashboard);
      // The run page offers Watch all once a worker of the run is in its live view.
      await gesture.click('dashboard', dashboard.getByTestId('watch-all-toggle'), { timeout: 120_000 });
      await waitFor(
        async () => tileProblems(await readWatchLog(dashboard)).length === 0,
        `the page of ${CI_WORKERS} workers in Watch all`,
        60_000,
      );
      // The checkout's worker, in full, paused at its next call: the project lets its controllers pause a CI test.
      const tile = dashboard.getByRole('button', { name: /^Show worker \d+ in full: places an order/ });
      await gesture.click('dashboard', tile);
      const panel = dashboard.getByTestId('lane-panel');
      await panel.getByTestId('live-frame').waitFor({ timeout: 60_000 });
      await gesture.click('dashboard', panel.getByTestId('live-control-pause'), { timeout: 30_000 });
      const pausedBy = panel.getByTestId('live-paused-by');
      await pausedBy.waitFor({ timeout: 60_000 });
      state.pausedSaid = (await pausedBy.innerText()).trim();
      const row = dashboard.getByTestId('live-paused').first();
      await row.waitFor({ timeout: 30_000 });
      state.pausedRow = { reason: await row.getAttribute('data-reason'), text: (await row.innerText()).trim() };
      state.pausedTest = (await instance.run(live.id)).testCases?.find((c) => c.title === 'places an order')?.status;
    },
    async check({ dashboard, state }) {
      const problems = tileProblems(await readWatchLog(dashboard));
      expect(!problems.length, `Watch all showed the workers: ${problems.join('; ')}`);
      expect(state.pausedSaid.startsWith('Paused'), `the lane panel says the CI test is paused: ${state.pausedSaid}`);
      expect(
        state.pausedRow.reason === 'pause' && state.pausedRow.text.startsWith('Paused'),
        `the test's row says it is paused: ${JSON.stringify(state.pausedRow)}`,
      );
      expect(state.pausedTest !== 'passed', `the paused test had not ended (${state.pausedTest})`);
    },
  }),

  beat({
    id: 'resumed',
    title: 'Resumed',
    seconds: 8,
    focus: ['dashboard'],
    budget: 180_000,
    lines: { en: ['Resume, and the CI run goes on to green.'] },
    async run({ dashboard, gesture, state }) {
      await gesture.click('dashboard', dashboard.getByTestId('lane-panel').getByTestId('live-control-resume'));
      state.ciExit = await state.ci;
      // The view stays open through the run's end, and says how the run ended.
      await waitFor(
        async () => (await readWatchLog(dashboard)).statuses.some((said) => RUN_VERDICT.test(said.text)),
        'the live view to say how the run ended',
        60_000,
      ).catch(() => null);
      state.watchLog = await readWatchLog(dashboard);
      await gesture.press('dashboard', 'Escape');
    },
    async check({ dashboard, instance, state }) {
      expect(state.ciExit === 0, `the fix's CI run passed (exit ${state.ciExit})`);
      const problems = [...tileProblems(state.watchLog), ...laneLogProblems(state.watchLog)];
      expect(!problems.length, `the watch followed the run until it was green: ${problems.join('; ')}`);
      const run = await waitFor(async () => {
        const r = await instance.run(state.liveRun);
        return r.status === 'running' ? null : r;
      }, 'the CI run to finish on the instance');
      expect(run.status === 'passed', `the CI run is green (${run.status})`);
      expect(run.origin === 'ci' && run.branch === 'main', `a CI run on main (${run.origin}, ${run.branch})`);
      expect(run.commit === state.fixCommit, `the run of the pushed fix (${run.commit})`);
      await waitFor(
        () => dashboard.locator('[data-shot="run-header"]').getByText('Passed', { exact: true }).isVisible(),
        "the run page's status green",
      );
    },
  }),

  beat({
    id: 'new-test',
    title: 'A new test',
    part: { title: 'Hand it to an agent', what: 'A coding agent finishes a test with Piwi’s run tools.' },
    seconds: 10,
    focus: ['vscode', 'test-browser', 'runs'],
    budget: 180_000,
    lines: {
      en: ['A new test, its last check still to write.', 'Debug it to the line where that check goes.'],
    },
    async run({ editor, vscode, runs, gesture, palette, repo, state }) {
      await editor.copy(NEW_TEST);
      // The new test goes at the end of the spec's describe, before its closing line, the file's last.
      await openFile(vscode, gesture, SPEC);
      await gesture.press('vscode', 'Control+End');
      await goToLine(vscode, gesture, read(repo.shop, SPEC).trimEnd().split('\n').length);
      await gesture.press('vscode', 'Home');
      await gesture.press('vscode', 'Control+V');
      await palette('File: Save All');
      state.newTestLine =
        read(repo.shop, SPEC)
          .split('\n')
          .findIndex((line) => line.includes(NEW_TEST_LAST)) + 1;
      await goToLine(vscode, gesture, state.newTestLine);
      await gesture.press('vscode', 'F9');
      await palette(DEBUG_AT_CURSOR);
      await runCard(runs).getByText(`${SPEC}:${state.newTestLine}`).waitFor({ timeout: 120_000 });
      // The editor reveals the stopped line, taking the focus, before anything else is typed there.
      await vscode
        .locator('.codelens-decoration', { hasText: 'Stopped at a breakpoint · Expect' })
        .first()
        .waitFor({ timeout: 30_000 });
    },
    async check({ repo, runs, state }) {
      const lines = read(repo.shop, SPEC).split('\n');
      expect(
        lines[state.newTestLine - 1]?.trim() === NEW_TEST_LAST,
        `the new test's last line stands at ${state.newTestLine}: ${lines[state.newTestLine - 1]}`,
      );
      const card = runCard(runs);
      expect(
        (await card.getByText('Stopped at a breakpoint').count()) > 0 &&
          (await card.getByText(`${SPEC}:${state.newTestLine}`).count()) > 0,
        `the Runs window shows the new test stopped at ${SPEC}:${state.newTestLine}`,
      );
    },
  }),

  beat({
    id: 'agent',
    title: 'The agent finishes it',
    seconds: 16,
    focus: ['vscode', 'agent', 'test-browser'],
    budget: 180_000,
    lines: {
      en: [
        'Copy the run tools’ setup into your coding agent,',
        'and ask it to finish the test.',
        'It reads the stopped page, clicks Orders and writes both lines,',
        'then resumes: the new test passes.',
      ],
    },
    async run({ editor, vscode, runs, gesture, palette, state }) {
      // The command asks which agent's format: the first, VS Code's, as Claude Code reads it too. A few of its words
      // find it in the palette.
      await gesture.press('vscode', 'F1');
      const input = vscode.locator('.quick-input-widget input');
      await gesture.type('vscode', input, '>copy runs mcp');
      const row = vscode.locator('.quick-input-list .monaco-list-row').filter({
        has: vscode.locator('.label-name', { hasText: new RegExp(`^${escaped(COPY_RUNS_MCP)}`) }),
      });
      await gesture.click('vscode', row.first());
      await vscode.locator('.quick-input-widget .quick-input-title', { hasText: 'copy the runs' }).waitFor();
      const copied = (await editor.clipboard()) ?? '';
      await gesture.click('vscode', vscode.locator('.quick-input-list .monaco-list-row').first());
      const configuration = await waitFor(async () => {
        const now = await editor.clipboard();
        return now !== copied && now.includes('piwi-runs') ? now : null;
      }, "the runs' MCP configuration on the clipboard");

      // What the agent is asked and each tool call it makes, in words, for the cut's agent panel.
      const stoppedAt = `${SPEC.split('/').pop()}:${state.newTestLine}`;
      const tell = (agent) => gesture.note('the agent', { agent });
      tell({ task: `Finish the test stopped at ${stoppedAt}: open the orders, and check their page shows.` });
      const agent = new Agent(runsServer(configuration), ({ name, say }) => tell({ tool: name, say }));
      await agent.connect();
      const { piwi: list } = await agent.tool('run_list', {}, `Finds the run stopped at ${stoppedAt}`);
      const stopped = list.runs
        .flatMap((r) => r.workers.map((w) => ({ run: r.run, worker: w })))
        .find((w) => w.worker.stop);
      const run = stopped.run;
      const stop = stopped.worker.stop.stop ?? stopped.worker.stop;
      const { page: before } = await agent.tool('page_snapshot', { run }, 'Reads the page the test stopped on');
      const orders = refOf(before, 'link', 'Orders');
      await agent.tool('page_act', { run, stop, target: orders, action: 'click' }, 'Clicks Orders on that page');
      const { page: after } = await agent.tool('page_snapshot', { run }, 'Reads the page again: “Your orders”');
      const heading = refOf(after, 'heading', 'Your orders');
      await agent.tool('code_write', { run, stop, kind: 'steps' }, 'Writes the click into the test');
      await agent.tool(
        'code_write',
        { run, stop, kind: 'assertion', target: heading, assertion: 'visible' },
        'Writes the check: “Your orders” shows',
      );
      await vscode.locator('.view-line', { hasText: 'Your orders' }).waitFor({ timeout: 30_000 });
      await agent.tool('run_control', { run, stop, action: 'resume' }, 'Resumes the run');
      await runEnded(runs);
      tell({ done: true });
      // The person keeps what the agent wrote once it is done.
      await palette('File: Save All');
    },
    async check({ repo, instance }) {
      const lines = read(repo.shop, SPEC).split('\n');
      const last = lines.findIndex((line) => line.includes(NEW_TEST_LAST));
      const written = lines.slice(last - 2, last).map((line) => line.trim());
      expect(
        written[0] === "await page.getByRole('link', { name: 'Orders' }).click();",
        `the agent's click stands above the test's last line: ${written[0]}`,
      );
      expect(
        written[1] === "await expect(page.getByRole('heading', { name: 'Your orders', level: 1 })).toBeVisible();",
        `the agent's check follows: ${written[1]}`,
      );
      const [latest] = await instance.runs();
      const run = await instance.run(latest.id);
      const test = run.testCases.find((c) => c.title === NEW_TEST_TITLE);
      expect(test?.status === 'passed', `the finished test passed (${test?.status})`);
    },
  }),

  beat({
    id: 'end',
    title: 'Get Piwi',
    seconds: 6,
    focus: ['card'],
    lines: {
      en: ['The reporter, VS Code, JetBrains, Chrome and Firefox.', 'piwitests.dev'],
    },
  }),
];
