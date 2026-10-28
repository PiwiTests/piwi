// The story, beat by beat: what the viewer reads (the lines), the windows each beat is about (`focus`), what it does
// on the real tools (`run`, through the gestures) and what it must have left (`check`).
import { beat, expect, waitFor } from './lib/script.mjs';
import { TILES } from './lib/set.mjs';
import { Agent, refOf, runsServer } from './lib/agent.mjs';
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

/** The test the developer starts for the coda, its last line the place it stops at, which the agent finishes. */
const NEW_TEST_TITLE = 'lists the order with the others';
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

/** The command that gives an agent the runs' MCP server. */
const COPY_RUNS_MCP = "Piwi: Copy the runs' MCP server configuration for agents";

/** Opens `file` in VS Code at the start of `line`, as a person does with Ctrl+P and Ctrl+G. */
async function goTo(vscode, gesture, file, line) {
  await gesture.click('vscode', vscode.locator('.editor-group-container.active .monaco-editor .view-lines'));
  await gesture.press('vscode', 'Control+P');
  await gesture.type('vscode', vscode.locator('.quick-input-widget input'), file);
  const name = file.split('/').pop();
  await gesture.click('vscode', vscode.locator('.quick-input-list .monaco-list-row', { hasText: name }).first());
  await vscode.locator('.tab.active', { hasText: name }).waitFor();
  await gesture.press('vscode', 'Control+G');
  // Go to Line opens with its colon typed.
  await gesture.type('vscode', vscode.locator('.quick-input-widget input'), `${line}:1`);
  await gesture.press('vscode', 'Enter');
  await vscode.locator('.statusbar-item', { hasText: `Ln ${line},` }).waitFor();
}

/** Waits until the Runs window shows no live run of the checkout: the one going on ended. */
const runEnded = (runs) => waitFor(async () => (await runCard(runs).count()) === 0, 'the run to end', 60_000);

/** The statuses of a test that ended. */
const FINISHED = new Set(['passed', 'failed', 'timedout', 'skipped', 'interrupted']);

/** A known bug: a run page opened before the run's tests begin stays there until it is reloaded. */
const RUN_PAGE_STAYS_INITIALIZING = 'the run page of a run still setting up never hears that it started';

/** The run card of the developer's checkout in the Runs window. */
const runCard = (runs) => runs.getByRole('region', { name: 'shop' }).and(runs.locator('.run:not(.ended)'));

export const STORY = [
  beat({
    id: 'title',
    seconds: 4,
    focus: ['card'],
    lines: { en: ['From a red run to a fixed test, without leaving your flow.'] },
  }),

  beat({
    id: 'red-run',
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
      await waitFor(
        () => vscode.locator('.statusbar-item', { hasText: `Ln ${FAILING_LINE},` }).isVisible(),
        `the cursor on line ${FAILING_LINE}`,
      );
    },
  }),

  beat({
    id: 'run-followed',
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
      expect(
        text.includes(`npx playwright test ${SPEC}:21 --workers=1 --headed`),
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
    seconds: 14,
    focus: ['vscode', 'test-browser', 'runs'],
    lines: {
      en: ['The test stops at the failing line.', 'The editor, the page and Piwi Picker show the same place.'],
    },
    async run({ runs }) {
      await runCard(runs).getByText('Stopped at a breakpoint').waitFor({ timeout: 90_000 });
    },
    async check({ vscode, runs, testPage }) {
      await waitFor(
        () =>
          vscode
            .locator('.codelens-decoration', { hasText: `Paused · Click ${BROKEN}` })
            .first()
            .isVisible(),
        'the paused line in VS Code',
      );
      await waitFor(
        () => vscode.locator('.statusbar-item .codicon-debug-continue').first().isVisible(),
        "the run's controls in the status bar",
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
    },
  }),

  beat({
    id: 'right-locator',
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
    seconds: 18,
    focus: ['vscode', 'test-browser', 'vscode'],
    lines: {
      en: ['The redesign also added a box to tick.', 'Record here: the click becomes a step above the line.'],
    },
    async run({ vscode, testPage, gesture, palette }) {
      await gesture.click('vscode', vscode.locator('.codelens-decoration a', { hasText: /^Record$/ }).first());
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
    seconds: 18,
    focus: ['runs', 'vscode', 'test-browser', 'vscode'],
    lines: {
      en: [
        'The stopped test still runs its old code: end it,',
        'and run the fixed test to the summary check.',
        'Assert a region writes what the order page shows.',
      ],
    },
    budget: 240_000,
    async run({ runs, vscode, testPage, gesture, palette }) {
      await gesture.click('runs', runCard(runs).getByRole('button', { name: 'End the test' }));
      await runEnded(runs);
      await goTo(vscode, gesture, SPEC, SUMMARY_LINE);
      await gesture.press('vscode', 'F9');
      await gesture.press('vscode', 'Control+Shift+Alt+K');
      await runCard(runs).getByText(`${SPEC}:${SUMMARY_LINE}`).waitFor({ timeout: 120_000 });
      await vscode.locator('.codelens-decoration', { hasText: 'Paused · Expect' }).first().waitFor({ timeout: 30_000 });
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
    seconds: 8,
    focus: ['runs', 'vscode'],
    lines: { en: ['Resume: the test passes, and the editor shows it.'] },
    async run({ runs, gesture, vscode, palette }) {
      await gesture.click('runs', runCard(runs).getByRole('button', { name: 'Resume' }));
      await runEnded(runs);
      await palette('Testing: Focus on Test Explorer View');
      const tree = vscode.getByRole('tree', { name: 'Test Explorer' });
      for (const name of [/^tests \(/, /^shop\.spec\.ts \(/, /^shop \(/]) {
        const item = tree.getByRole('treeitem', { name }).first();
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
      const [latest] = await instance.runs();
      expect(latest.id !== state.redRun.id, 'the run from the editor reached the instance');
      const run = await instance.run(latest.id);
      expect(run.origin !== 'ci', `the run is the developer's, not CI's (${run.origin})`);
      const test = run.testCases.find((c) => c.title === 'places an order');
      expect(test?.status === 'passed', `places an order passed there (${test?.status})`);
    },
  }),

  beat({
    id: 'back-on-the-team',
    seconds: 22,
    focus: ['dashboard'],
    budget: 240_000,
    lines: {
      en: [
        'The fix is pushed. On the team instance, the CI run is live:',
        'watch its page beside the step it is on,',
        'until the run turns green.',
      ],
    },
    async run({ set, repo, dashboard, instance, gesture, state, skip }) {
      gesture.note('the fix is committed and pushed');
      state.fixCommit = push(repo.shop, 'Fix the checkout test for the redesign');
      const before = (await instance.runs()).map((r) => r.id);
      // A CI run slowed enough to watch, as a long suite's run is.
      state.ci = set.ci(state.fixCommit, 'ci-fix', { SLOW_MO: '1000' });
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
      // What the run was as its page loaded: the known bug is a page that loaded while the run set up.
      const atLoad = (await instance.run(live.id)).status;
      const watch = dashboard.getByRole('button', { name: /^Watch .* live$/ }).first();
      const header = dashboard.locator('[data-shot="run-header"]');
      // A live page shows Watch while a worker runs a test; a page the run's start never reached still says
      // Initializing once the instance holds a finished test of the run, which a live page lists.
      const page = await waitFor(
        async () => {
          if (await watch.isVisible()) return 'live';
          const finished = (await instance.run(live.id)).testCases?.some((c) => FINISHED.has(c.status));
          return finished && (await header.getByText('Initializing', { exact: true }).isVisible()) ? 'stuck' : null;
        },
        'the run page to show its workers',
        120_000,
      );
      if (page === 'stuck') {
        expect(atLoad === 'initializing', `the run page never went live, though the run was ${atLoad} as it loaded`);
        // Reloaded, as a person does: the bug, when the page then shows the worker.
        await dashboard.reload({ waitUntil: 'domcontentloaded' });
        await watch.waitFor({ timeout: 60_000 });
        skip(RUN_PAGE_STAYS_INITIALIZING, 'the run page, opened as the run set up, going live once it starts');
      }
      await gesture.click('dashboard', watch);
      const frame = dashboard.getByRole('dialog').getByRole('img', { name: /^The page .* as the test sees it$/ });
      state.watched = await waitFor(
        () =>
          frame.evaluate((img) =>
            img.complete && img.naturalWidth ? { width: img.naturalWidth, alt: img.alt } : null,
          ),
        "a frame of the worker's page",
        60_000,
      );
      state.ciExit = await state.ci;
      await gesture.press('dashboard', 'Escape');
    },
    async check({ dashboard, instance, state }) {
      expect(state.watched.width > 100, `the live view showed the page (${JSON.stringify(state.watched)})`);
      expect(state.ciExit === 0, `the fix's CI run passed (exit ${state.ciExit})`);
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
    id: 'coda',
    seconds: 18,
    focus: ['vscode', 'test-browser', 'runs', 'vscode'],
    budget: 240_000,
    lines: {
      en: [
        'A new test, its last check still to write:',
        "the coding agent finishes it through Piwi's run tools,",
        'and the editor writes its steps.',
      ],
    },
    async run({ editor, vscode, runs, gesture, palette, repo }) {
      await editor.copy(NEW_TEST);
      const close = read(repo.shop, SPEC).trimEnd().split('\n').length;
      await goTo(vscode, gesture, SPEC, close);
      await gesture.press('vscode', 'Home');
      await gesture.press('vscode', 'Control+V');
      await palette('File: Save All');
      const last =
        read(repo.shop, SPEC)
          .split('\n')
          .findIndex((line) => line.includes(NEW_TEST_LAST)) + 1;
      await goTo(vscode, gesture, SPEC, last);
      await gesture.press('vscode', 'F9');
      await gesture.press('vscode', 'Control+Shift+Alt+K');
      await runCard(runs).getByText(`${SPEC}:${last}`).waitFor({ timeout: 120_000 });
      // The editor reveals the stopped line, taking the focus, before anything else is typed there.
      await vscode.locator('.codelens-decoration', { hasText: 'Paused · Expect' }).first().waitFor({ timeout: 30_000 });

      // The command asks which agent's format: the first, VS Code's, as Claude Code reads it too.
      await gesture.press('vscode', 'F1');
      const input = vscode.locator('.quick-input-widget input');
      await gesture.type('vscode', input, `>${COPY_RUNS_MCP}`);
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
      const agent = new Agent(runsServer(configuration));
      await agent.connect();
      const { piwi: list } = await agent.tool('run_list');
      const stopped = list.runs
        .flatMap((r) => r.workers.map((w) => ({ run: r.run, worker: w })))
        .find((w) => w.worker.stop);
      const run = stopped.run;
      const stop = stopped.worker.stop.stop ?? stopped.worker.stop;
      const { page: before } = await agent.tool('page_snapshot', { run });
      const orders = refOf(before, 'link', 'Orders');
      await agent.tool('page_act', { run, stop, target: orders, action: 'click' });
      const { page: after } = await agent.tool('page_snapshot', { run });
      const heading = refOf(after, 'heading', 'Your orders');
      await agent.tool('code_write', { run, stop, kind: 'steps' });
      await agent.tool('code_write', { run, stop, kind: 'assertion', target: heading, assertion: 'visible' });
      await vscode.locator('.view-line', { hasText: 'Your orders' }).waitFor({ timeout: 30_000 });
      await palette('File: Save All');
      await agent.tool('run_control', { run, stop, action: 'resume' });
      await runEnded(runs);
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
    seconds: 6,
    focus: ['card'],
    lines: {
      en: ['The reporter, VS Code, JetBrains, Chrome and Firefox.', 'piwitests.dev'],
    },
  }),
];
