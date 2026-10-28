import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { localStorageText, storedSecret } from './secrets.js';
import {
  answerNext,
  answerView,
  checkHandoff,
  heardRequests,
  jpegOf,
  olderEditor,
  pairedExtension,
  playInput,
  sendFrame,
  startDesktop,
  startEditor,
  startRun,
  stopAtCheckout,
  waitFor,
  CART_RESPONSE,
  CHECK,
  DESKTOP_TOKEN,
  FAILURE_ERROR,
  KEPT,
  PAIRING_TOKEN,
  RUN_TAKES,
  VIEWPORT,
  type Editor,
  FakeWorker,
} from './runs-fixtures.js';

/**
 * The Runs window in the real extension, against the real editor service and its hub: the worker finds the hub through
 * the pairing, the popup's Runs tile opens the window, and the window pauses, steps, resumes and ends a run whose
 * worker the spec plays, with the image of the stopped page, a run started in a terminal named as one. At a stop it
 * starts the code the editor writes there (Assert, Assert a region, Mock a request, as the worker's reporter takes
 * them), and holds a failed test, a headless one only while a Runs window is open. A page served from 127.0.0.1 never
 * reaches the hub. Watch live shows a stop's frames, the clicks and keys on them reach the page, Pick on the image
 * names the element under a click, and a headless stop takes Pick, Record and the checks once watched; an older editor
 * service shows none of it. The paired desktop app's runs show beside the editor's, the app named, their code made
 * there for the app's window to copy.
 */

let editor: Editor;

test.beforeAll(async () => {
  editor = await startEditor();
});

test.afterAll(async () => {
  await editor?.close();
});

test('pauses, steps and resumes a run from the Runs window, with the image of the stopped page', async () => {
  const { context, worker } = await pairedExtension(editor);
  try {
    // The popup's tile shows once a hub of the paired editor answers.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
    const tile = popup.getByRole('button', { name: /Runs/ });
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('Pause, step, resume');

    const opened = context.waitForEvent('page');
    await tile.click();
    const runs = await opened;
    await runs.locator('html[data-ready]').waitFor({ state: 'attached' });
    expect(runs.url()).toMatch(/\/runs\.html$/);
    // A small window of its own, beside the test's.
    const windows = await worker.evaluate(async () =>
      (await chrome.windows.getAll({ populate: true })).map((w) => ({ type: w.type, urls: w.tabs?.map((t) => t.url) })),
    );
    expect(windows).toContainEqual({ type: 'popup', urls: [expect.stringMatching(/\/runs\.html$/)] });
    await expect(runs.getByText('Following 1 editor window')).toBeVisible();
    await expect(runs.getByText('No run right now.', { exact: false })).toBeVisible();

    const run = await startRun(editor);
    try {
      const label = path.basename(editor.dir);
      const card = runs.getByRole('region', { name: label });
      await expect(card.getByText('cart › adds a mug')).toBeVisible();
      await expect(card.getByText('chromium · attempt 1')).toBeVisible();
      await expect(card.getByText('Running')).toBeVisible();

      // Pause: the worker stops before its next call, at a line of a page object.
      await card.getByRole('button', { name: 'Pause' }).click();
      expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'pause' });
      run.worker.stopAt(1, 30, true);
      await expect(card.getByText('Stopped at a breakpoint')).toBeVisible();
      await expect(card.getByText('tests/pages/cart.page.ts:30')).toBeVisible();
      await expect(card.locator('.stop')).toContainText("Click getByRole('button', { name: 'Add' })");
      await expect(runs.locator('#announce')).toHaveText('cart › adds a mug stopped at tests/pages/cart.page.ts:30.');

      // The image of the stopped page, asked for once for this stop.
      const asked = await run.worker.next('request');
      expect(asked).toMatchObject({ what: 'image' });
      run.worker.send({
        type: 'answer',
        request: asked.request,
        what: 'image',
        value: { mime: 'image/jpeg', data: await jpegOf(runs) },
      });
      const image = card.getByRole('img', {
        name: "The test’s page, stopped before: Click getByRole('button', { name: 'Add' })",
      });
      await expect(image).toBeVisible();
      expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);

      // Pick and Record start in the test's window; what the worker answers shows.
      await card.getByRole('button', { name: 'Pick' }).click();
      const pick = await run.worker.next('request', 1);
      expect(pick).toMatchObject({ what: 'pick', stop: 1 });
      run.worker.send({
        type: 'answer',
        request: pick.request,
        what: 'pick',
        value: { ok: true, message: "Pick an element in the test's window." },
      });
      await expect(card.getByText("Pick an element in the test's window.")).toBeVisible();
      await card.getByRole('button', { name: 'Record' }).click();
      const record = await run.worker.next('request', 2);
      run.worker.send({
        type: 'answer',
        request: record.request,
        what: 'record',
        value: { ok: false, message: 'Record here waits: a pick runs in the test’s window.' },
      });
      await expect(card.locator('.answer')).toHaveText('Record here waits: a pick runs in the test’s window.');
      // A refusal is read out too.
      await expect(runs.locator('#announce')).toHaveText('Record here waits: a pick runs in the test’s window.');

      // Step, with the keyboard: the worker runs the call and stops before the next one, whose image is asked for in
      // turn. The focus stays on Step while the command is on its way, is on Pause while the test runs, and on Step
      // again at the next stop.
      const step = card.getByRole('button', { name: 'Step' });
      await step.focus();
      await runs.keyboard.press('Enter');
      await expect(step).toBeFocused();
      expect(await run.worker.next('control', 1)).toEqual({ type: 'control', action: 'step', stop: 1 });
      run.worker.send({ type: 'running', stop: 1 });
      await expect(card.getByText('Running')).toBeVisible();
      await expect(card.getByRole('button', { name: 'Pause' })).toBeFocused();
      run.worker.stopAt(2, 31, true);
      await expect(card.getByText('tests/pages/cart.page.ts:31')).toBeVisible();
      await expect(step).toBeFocused();
      const again = await run.worker.next('request', 3);
      expect(again).toMatchObject({ what: 'image' });
      run.worker.send({ type: 'answer', request: again.request, what: 'image', value: null });
      await expect(
        card.getByText(
          'No image: the worker is not stopped, cannot tell which page it stopped in, or did not answer in time.',
        ),
      ).toBeVisible();

      // Resume, with the keyboard: the worker goes on.
      await card.getByRole('button', { name: 'Resume' }).focus();
      await runs.keyboard.press('Enter');
      expect(await run.worker.next('control', 2)).toEqual({ type: 'control', action: 'resume', stop: 2 });
      run.worker.send({ type: 'running', stop: 2 });
      await expect(card.getByText('Running')).toBeVisible();
      await expect(runs.locator('#announce')).toHaveText('cart › adds a mug goes on.');

      // The run ends.
      await editor.svc.client.sendNotification('piwi/commandEnded', { ref: run.ref, exitCode: 0 });
      await expect(card.getByText('The run ended.')).toBeVisible();
      await expect(card.getByRole('button')).toHaveCount(0);
    } finally {
      run.worker.socket.destroy();
    }

    // The tokens stay out of the storage content scripts read; the hubs' are in the secret area.
    const local = await localStorageText(runs);
    expect(local).not.toContain(PAIRING_TOKEN);
    expect(local).not.toContain(editor.hub.token);
    expect(JSON.stringify(await storedSecret(runs, 'hubs'))).toContain(editor.hub.token);
  } finally {
    await context.close();
  }
});

test('the run shortcut pauses the runs, then resumes the stopped test, with no Runs window open', async () => {
  const { context, worker } = await pairedExtension(editor);
  try {
    const shortcut = () =>
      worker.evaluate(() => (globalThis as { __piwiRunShortcut?: () => Promise<unknown> }).__piwiRunShortcut!());
    // The command is the browser's, with no key until the person gives it one (global in Chrome and Edge).
    const commands = await worker.evaluate(async () => chrome.commands.getAll());
    expect(commands.find((c) => c.name === 'run-pause-resume')).toEqual({
      name: 'run-pause-resume',
      description: 'Pause the editor’s runs, or resume a stopped test',
      shortcut: '',
    });
    const run = await startRun(editor);
    try {
      await waitFor(() => (editor.svc.latest(run.ref)?.workers[0]?.state === 'running' ? true : undefined));
      expect(await shortcut()).toEqual([{ ok: true, message: 'Pausing at the next call.' }]);
      expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'pause' });
      run.worker.stopAt(1, 30, true);
      await waitFor(() => editor.svc.latest(run.ref)?.workers[0]?.stop ?? undefined);
      // The extension hears the stop from the hub as the editor does, a burst at most every 50 ms.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await shortcut()).toEqual([{ ok: true, message: 'Resuming.' }]);
      expect(await run.worker.next('control', 1)).toEqual({ type: 'control', action: 'resume', stop: 1 });
    } finally {
      run.worker.socket.destroy();
    }
  } finally {
    await context.close();
  }
});

test('End the test ends a stopped test there, and a run started in a terminal shows as one', async () => {
  const { context, extensionId } = await pairedExtension(editor);
  try {
    const runs = await openRuns(context, extensionId);
    const card = liveRun(runs);
    const run = await startRun(editor, 'pays', [...RUN_TAKES]);
    try {
      await expect(card.getByText('Running')).toBeVisible();
      await expect(card.getByText('Terminal')).toHaveCount(0);
      stopAtCheckout(run.worker, 1);
      // Beside the other controls that steer the test, above the code a stop can write.
      const steering = card.locator('.controls .piwi-actions').first().getByRole('button');
      await expect(steering).toHaveText(['Resume', 'Step', 'Finish', 'End the test']);
      const end = card.getByRole('button', { name: 'End the test' });
      await expect(end).toHaveAttribute('title', 'End the test here: the rest of it is skipped');
      await end.click();
      expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'end', stop: 1 });
      run.worker.send({ type: 'running', stop: 1 });
      await expect(card.getByText('Running')).toBeVisible();
    } finally {
      await endRun(run);
    }

    // A run started in a terminal: a ref the editor never built, on its run channel, named a terminal's run.
    const { channel } = await editor.svc.command();
    const ref = `terminal-4242-${Date.now()}`;
    const terminal = new FakeWorker(channel.path, editor.dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    try {
      terminal.begin('pays');
      const shown = liveRun(runs).filter({ has: runs.locator('.run-title', { hasText: 'Terminal' }) });
      await expect(shown.locator('.run-title')).toHaveText(`${path.basename(editor.dir)}Test EditorTerminal`);
      stopAtCheckout(terminal, 1);
      await shown.getByRole('button', { name: 'End the test' }).click();
      expect(await terminal.next('control')).toEqual({ type: 'control', action: 'end', stop: 1 });
    } finally {
      terminal.socket.destroy();
      // Its session ends a while after its last worker left, with no command to end.
      await waitFor(() => (editor.svc.latest(ref)?.ended ? true : undefined), 10_000);
    }
  } finally {
    await context.close();
  }
});

test('a page served from 127.0.0.1 cannot open the hub’s WebSocket, which the extension can', async () => {
  const { context, worker } = await pairedExtension(editor);
  try {
    const page = await context.newPage();
    await page.goto(editor.origin);
    const fromPage = await page.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(url);
          socket.onopen = () => resolve('open');
          socket.onclose = (event) => resolve(`closed ${event.code}`);
        }),
      editor.hub.url,
    );
    expect(fromPage).toBe('closed 1006');
    // The same address, from the extension's worker, which the hub takes.
    const fromWorker = await worker.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(url);
          socket.onopen = () => {
            resolve('open');
            socket.close();
          };
          socket.onclose = (event) => resolve(`closed ${event.code}`);
        }),
      editor.hub.url,
    );
    expect(fromWorker).toBe('open');
  } finally {
    await context.close();
  }
});

test('a press on Pause reaches the run while its tests change under it', async () => {
  const { context, extensionId } = await pairedExtension(editor);
  try {
    const runs = await context.newPage();
    await runs.goto(`chrome-extension://${extensionId}/runs.html`);
    await runs.locator('html[data-ready]').waitFor({ state: 'attached' });
    const run = await startRun(editor);
    try {
      const pause = runs.getByRole('button', { name: 'Pause' });
      await expect(pause).toBeVisible();
      // Short tests, one after another: the window hears a change every 60 ms, while the button is held down.
      let n = 0;
      const tests = setInterval(() => run.worker.begin(`test ${n++}`), 60);
      try {
        const test = runs.locator('.test');
        await expect(test).toHaveText(/cart › test \d+/);
        const box = (await pause.boundingBox())!;
        await runs.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await runs.mouse.down();
        const pressed = await test.textContent();
        // Held until the window has shown another test.
        await expect(test).not.toHaveText(pressed!);
        await runs.mouse.up();
        expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'pause' });
      } finally {
        clearInterval(tests);
      }
    } finally {
      run.worker.socket.destroy();
    }
  } finally {
    await context.close();
  }
});

test('the Runs window says the run shortcut has no key, and opens the browser’s shortcuts page to set one', async () => {
  const { context, extensionId } = await pairedExtension(editor);
  try {
    const runs = await context.newPage();
    await runs.goto(`chrome-extension://${extensionId}/runs.html`);
    await runs.locator('html[data-ready]').waitFor({ state: 'attached' });
    await expect(runs.locator('#shortcut-text')).toHaveText(
      'No key pauses and resumes the runs yet. Set one, Global in Chrome or Edge, to use it from any window.',
    );
    const opened = context.waitForEvent('page');
    await runs.getByRole('button', { name: 'Set a shortcut' }).click();
    const shortcuts = await opened;
    await expect.poll(() => shortcuts.url()).toBe('chrome://extensions/shortcuts');
  } finally {
    await context.close();
  }
});

/** The Runs window, opened as a page of the extension, at the size of the window the popup opens. */
async function openRuns(context: BrowserContext, extensionId: string): Promise<Page> {
  const runs = await context.newPage();
  await runs.setViewportSize({ width: 440, height: 720 });
  await runs.goto(`chrome-extension://${extensionId}/runs.html`);
  await runs.locator('html[data-ready]').waitFor({ state: 'attached' });
  return runs;
}

/** The card of the live run, beside those of the runs that ended. */
function liveRun(runs: Page) {
  return runs.getByRole('region', { name: path.basename(editor.dir) }).and(runs.locator('.run:not(.ended)'));
}

/** The run's command ends, and its worker leaves: the window keeps it as a run that ended. */
async function endRun(run: { ref: string; worker: { socket: { destroy(): void } } }): Promise<void> {
  await editor.svc.client.sendNotification('piwi/commandEnded', { ref: run.ref, exitCode: 0 });
  run.worker.socket.destroy();
}

test.describe('code from a stop', () => {
  test('Assert starts the check panel in the test’s window, and the check made there is written in the editor', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        const card = liveRun(runs);
        await expect(card.getByText('cart › pays')).toBeVisible();
        stopAtCheckout(run.worker, 1);
        await expect(card.getByText('Stopped at a breakpoint')).toBeVisible();
        // The test's controls, then the code this stop can write, in a group of their own.
        await expect(card.locator('.controls button')).toHaveText([
          'Resume',
          'Step',
          'Finish',
          'End the test',
          'Pick',
          'Record',
          'Assert',
          'Assert a region',
          'Mock a request',
        ]);
        await expect(card.getByRole('group', { name: 'Code from this stop' }).getByRole('button')).toHaveText([
          'Pick',
          'Record',
          'Assert',
          'Assert a region',
          'Mock a request',
        ]);

        // With the keyboard: the focus stays on Assert while the worker answers, and after.
        const assert = card.getByRole('button', { name: 'Assert', exact: true });
        await expect(assert).toHaveAttribute(
          'title',
          'Check an element in the test’s window: the check goes to the editor, which writes it above this line',
        );
        await assert.focus();
        await runs.keyboard.press('Enter');
        const started = "Check an element in the test's window: the editor writes the check above the stopped line.";
        const asked = await answerNext(run.worker, 'assert', { ok: true, message: started });
        expect(asked).toMatchObject({ what: 'assert', stop: 1 });
        await expect(card.locator('.note')).toHaveText(started);
        await expect(runs.locator('#announce')).toHaveText(started);
        await expect(assert).toBeFocused();

        // The worker hands the page to the editor's check panel; the check made there goes to the editor alone.
        const handoff = checkHandoff(editor, run.channel, { ref: run.ref, worker: 0, stop: 1 });
        try {
          await waitFor(() => handoff.heard.find((m) => m.type === 'load'));
          handoff.send({ type: 'loaded' });
          handoff.send({
            type: 'binding',
            call: 1,
            outside: false,
            payload: { kind: 'message', message: { type: 'piwi-append-recording-event', event: CHECK } },
          });
          const written = await waitFor(() => editor.svc.codes.find((c) => c.ref === run.ref && c.action === 'assert'));
          const code = "  await expect(page.getByTestId('total')).toHaveText('Total €72.00');";
          expect(written).toMatchObject({ since: expect.any(String), line: 4, code });
          expect(written.edits).toContainEqual({
            range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } },
            newText: `${code}\n`,
          });
        } finally {
          handoff.socket.destroy();
        }
        // That the check went to the editor to write comes to the window, in place of what Assert's answer said, and is
        // read out; the editor says itself whether it wrote it.
        const sent =
          /^Piwi sent the check to Test Editor to write above checkout\.spec\.ts:5\. The stopped test goes on with the code/;
        await expect(card.locator('.note.sent')).toHaveText(sent);
        await expect(runs.locator('#announce')).toHaveText(sent);
        await expect(card.locator('.note')).toHaveCount(1);
        expect(await runs.content()).not.toContain('toHaveText(');

        // Assert a region: the worker answers that the pick starts, then sends the region picked, which the editor
        // writes as its ARIA snapshot.
        await card.getByRole('button', { name: 'Assert a region' }).click();
        const region =
          "Pick the region in the test's window: the editor writes its ARIA snapshot above the stopped line.";
        await answerNext(run.worker, 'assert-region', { ok: true, message: region });
        await expect(card.locator('.note')).toHaveText(region);
        run.worker.send({
          type: 'region',
          stop: 1,
          locator: "getByTestId('summary')",
          snapshot: '- heading "Summary" [level=2]',
        });
        const snapshot = await waitFor(() =>
          editor.svc.codes.find((c) => c.ref === run.ref && c.action === 'assert-region'),
        );
        expect(snapshot.code).toContain("await expect(page.getByTestId('summary')).toMatchAriaSnapshot(`");
        await expect(card.locator('.note.sent')).toHaveText(
          "Piwi sent the region's ARIA snapshot to Test Editor to write above checkout.spec.ts:5.",
        );

        // The test goes on: what Assert a region said goes with its stop.
        run.worker.send({ type: 'running', stop: 1 });
        await expect(card.getByText('Running')).toBeVisible();
        await expect(card.locator('.note')).toHaveCount(0);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('Mock a request lists the requests the page made, and the one chosen is written in the editor as a route', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        const card = liveRun(runs);
        stopAtCheckout(run.worker, 1);
        const mock = card.getByRole('button', { name: 'Mock a request' });
        await expect(mock).toHaveAttribute('aria-expanded', 'false');
        await mock.focus();
        await runs.keyboard.press('Enter');
        const asked = await answerNext(run.worker, 'requests', {
          ok: true,
          message: `The test kept ${KEPT.length} responses.`,
          requests: KEPT,
        });
        expect(asked).toMatchObject({ what: 'requests', stop: 1 });
        const list = card.getByRole('group', { name: 'Choose the request to mock' });
        await expect(list.getByRole('listitem')).toHaveCount(KEPT.length);
        await expect(runs.locator('#announce')).toHaveText(`${KEPT.length} requests: choose the one to mock.`);
        // The list opens under the button, which keeps the focus and says it is open.
        await expect(mock).toBeFocused();
        await expect(mock).toHaveAttribute('aria-expanded', 'true');
        await expect(mock).toHaveAttribute('aria-controls', (await list.getAttribute('id'))!);

        // Each row: the method and the address, then the status, the type, the size and when it ended.
        const cart = list.getByRole('button', { name: /^GET http:\/\/127\.0\.0\.1:3000\/api\/cart/ });
        await expect(cart).toHaveText('GET http://127.0.0.1:3000/api/cart 200 · application/json · 12B · at 0.8s');
        // A long address is cut to the row, whole in the tooltip; an address is text, never a link or markup.
        const long = list.getByRole('button', { name: /api\/products/ });
        await expect(long).toHaveAttribute('title', `GET ${KEPT[2]!.url}`);
        expect(await long.locator('.path').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        await expect(list.getByRole('link')).toHaveCount(0);
        await expect(list.locator('img')).toHaveCount(0);
        await expect(list.getByRole('button', { name: /api\/search/ })).toContainText('<img src=x onerror=alert(1)>');
        // A body sent in chunks states no size; the credential its address carried is hidden by the editor.
        const stream = list.getByRole('button', { name: /api\/stream/ });
        await expect(stream).toHaveText(
          'GET http://127.0.0.1:3000/api/stream?token=<hidden> 200 · text/plain · size unknown · at 2.6s',
        );
        await expect(stream).toHaveAttribute('title', 'GET http://127.0.0.1:3000/api/stream?token=<hidden>');
        expect(await runs.content()).not.toContain('abc123');

        // The keyboard: Tab reaches the list's close button, its filter and its rows; the arrows move between rows.
        await runs.keyboard.press('Tab');
        await expect(list.getByRole('button', { name: 'Close the list' })).toBeFocused();
        await runs.keyboard.press('Tab');
        const filter = list.getByRole('searchbox', { name: 'Filter by address, method or status' });
        await expect(filter).toBeFocused();
        await runs.keyboard.type('api/c');
        await expect(list.locator('li:not([hidden])')).toHaveCount(2);
        await runs.keyboard.press('ArrowDown');
        await expect(cart).toBeFocused();
        await runs.keyboard.press('ArrowDown');
        await expect(list.getByRole('button', { name: /api\/coupons/ })).toBeFocused();
        await runs.keyboard.press('ArrowUp');
        await expect(cart).toBeFocused();
        await runs.keyboard.press('Shift+Tab');
        await expect(filter).toBeFocused();
        await runs.keyboard.type('zzz');
        await expect(list.getByText('No request matches the filter.')).toBeVisible();
        await filter.fill('cart');
        await runs.keyboard.press('ArrowDown');
        await expect(cart).toBeFocused();

        // The one chosen: the worker hands over its body, and the editor writes the route above the stopped line.
        await runs.keyboard.press('Enter');
        const mocked = await answerNext(run.worker, 'mock', {
          ok: true,
          message: `GET ${CART_RESPONSE.url}`,
          response: { ...CART_RESPONSE, body: '{"items":[],"token":"cart-session-0123"}' },
        });
        expect(mocked).toMatchObject({ what: 'mock', stop: 1, id: 1 });
        const written = await waitFor(() => editor.svc.codes.find((c) => c.ref === run.ref && c.action === 'mock'));
        expect(written.code).toContain("await page.route('**/api/cart', (route) =>");
        const said = card.locator('.note.sent');
        await expect(said).toHaveText(/^Piwi sent the mock to Test Editor to write above checkout\.spec\.ts:5\./);
        // What to review in the code, under it, and read out with it.
        const hidden = 'A value named or shaped like a credential is written as <hidden>.';
        await expect(card.getByRole('list', { name: 'What to review in this code' })).toHaveText(hidden);
        await expect(runs.locator('#announce')).toHaveText(
          /^Piwi sent the mock to Test Editor to write above checkout\.spec\.ts:5\./,
        );
        await expect(runs.locator('#announce')).toContainText(hidden);
        // The list closes, and the focus goes back to the button that opened it. No code comes to the window.
        await expect(list).toHaveCount(0);
        await expect(mock).toBeFocused();
        await expect(mock).toHaveAttribute('aria-expanded', 'false');
        expect(await runs.content()).not.toContain('route.fulfill');

        // Open again, then Escape: the list closes, the focus back on Mock a request.
        await runs.keyboard.press('Enter');
        await answerNext(run.worker, 'requests', {
          ok: true,
          message: 'The test kept 1 response.',
          requests: [KEPT[0]],
        });
        await expect(list.getByRole('listitem')).toHaveCount(1);
        // Fewer requests: no filter.
        await expect(filter).toHaveCount(0);
        await runs.keyboard.press('Tab');
        await runs.keyboard.press('Tab');
        await expect(list.getByRole('button', { name: /api\/cart/ })).toBeFocused();
        await runs.keyboard.press('Escape');
        await expect(list).toHaveCount(0);
        await expect(mock).toBeFocused();

        // A mock the editor asks for itself shows here too, at the stop it was made at.
        const since = editor.svc.latest(run.ref)!.workers[0]!.stop!.since;
        const fromEditor = editor.svc.client.sendRequest('piwi/stopAction', {
          ref: run.ref,
          since,
          action: 'mock',
          request: 1,
        });
        await answerNext(run.worker, 'mock', {
          ok: true,
          message: `GET ${CART_RESPONSE.url}`,
          response: CART_RESPONSE,
        });
        expect(await fromEditor).toMatchObject({ ok: true });
        await expect(said).toHaveText('Piwi sent the mock to Test Editor to write above checkout.spec.ts:5.');
        await expect(card.getByRole('list', { name: 'What to review in this code' })).toHaveCount(0);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a list or an answer of a stop the test went on from is gone, and a refusal says why', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        const card = liveRun(runs);
        stopAtCheckout(run.worker, 1);
        const mock = card.getByRole('button', { name: 'Mock a request' });
        await mock.click();
        // No response kept yet: the list says so.
        await answerNext(run.worker, 'requests', { ok: true, message: 'The test kept no response yet.', requests: [] });
        const list = card.getByRole('group', { name: 'Choose the request to mock' });
        await expect(list).toContainText(
          'The test kept no response yet: Piwi keeps the text answers of its fetch and XHR requests.',
        );
        await mock.click();
        await expect(list).toHaveCount(0);

        // A response the worker no longer keeps: the refusal shows under the test, the list stays, and so does the
        // focus on the row.
        await mock.click();
        await answerNext(run.worker, 'requests', {
          ok: true,
          message: 'The test kept 2 responses.',
          requests: KEPT.slice(0, 2),
        });
        const cart = list.getByRole('button', { name: /api\/cart/ });
        await cart.focus();
        await runs.keyboard.press('Enter');
        await answerNext(run.worker, 'mock', {
          ok: false,
          message: 'The test kept no such response: it keeps the latest 50.',
          response: null,
        });
        await expect(card.locator('.answer')).toHaveText('The test kept no such response: it keeps the latest 50.');
        await expect(runs.locator('#announce')).toHaveText('The test kept no such response: it keeps the latest 50.');
        await expect(cart).toBeFocused();
        await expect(list).toBeVisible();

        // The test goes on and stops again: the list and the refusal were the last stop's.
        run.worker.send({ type: 'running', stop: 1 });
        await expect(card.getByText('Running')).toBeVisible();
        await expect(list).toHaveCount(0);
        await expect(card.locator('.answer')).toHaveCount(0);
        stopAtCheckout(run.worker, 2);
        await expect(card.getByText('Stopped at a breakpoint')).toBeVisible();
        await expect(list).toHaveCount(0);

        // An answer that comes once the test went on from its stop shows nothing.
        await mock.click();
        const late = await waitFor(() =>
          run.worker.heard.find((m) => m.type === 'request' && m.what === 'requests' && m.stop === 2),
        );
        run.worker.send({ type: 'running', stop: 2 });
        await expect(card.getByText('Running')).toBeVisible();
        run.worker.send({
          type: 'answer',
          request: (late as { request: number }).request,
          what: 'requests',
          value: { ok: true, message: 'The test kept 1 response.', requests: [KEPT[0]] },
        });
        await runs.waitForTimeout(300);
        await expect(list).toHaveCount(0);
        await expect(card.locator('.note, .answer')).toHaveCount(0);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a failed test held at its line says where it failed, with Resume to let it end', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        const card = liveRun(runs);
        await expect(card.getByText('Running')).toBeVisible();
        stopAtCheckout(run.worker, 1, { reason: 'failure' });
        await expect(card.locator('.state')).toHaveText('Failed at tests/checkout.spec.ts:5');
        await expect(card.locator('.worker')).toHaveAttribute('data-failed', '');
        // The error its stop names, under its label, its lines kept.
        await expect(card.locator('.stop dt')).toHaveText('Error');
        expect(await card.locator('.stop .error').innerText()).toBe(FAILURE_ERROR);
        await expect(runs.locator('#announce')).toHaveText('cart › pays failed at tests/checkout.spec.ts:5.');
        // No Step nor Finish: whatever answers it, the test ends as it failed.
        await expect(card.locator('.controls button')).toHaveText([
          'Resume',
          'Pick',
          'Record',
          'Assert',
          'Assert a region',
          'Mock a request',
        ]);
        const resume = card.getByRole('button', { name: 'Resume' });
        await expect(resume).toHaveAttribute('title', 'Let the test end as it failed');
        await resume.click();
        expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });

        // A reporter that names no error: the window reads it from the stop's title.
        run.worker.send({ type: 'running', stop: 1 });
        await expect(card.getByText('Running')).toBeVisible();
        stopAtCheckout(run.worker, 2, { reason: 'failure', error: null });
        await expect(card.locator('.stop')).toHaveText('Errorexpect(locator).toBeVisible() failed');
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a plain run’s headless failure waits for an answer only while a Runs window is open', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      // Paired, its Runs window never opened: the popup's tile shows once the worker hears the hub's runs.
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(popup.getByRole('button', { name: /Runs/ })).toBeVisible();
      await popup.close();
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      const shown = () => editor.svc.sessions.some((s) => s.ref === run.ref && s.workers.some((w) => w.stop));
      try {
        // A plain run, neither with breakpoints nor for a page.pause(): its failure goes on at once, shown to nobody.
        stopAtCheckout(run.worker, 1, { reason: 'failure', bar: false });
        expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
        expect(shown()).toBe(false);

        // A Runs window opens: the next failure waits there for an answer.
        const runs = await openRuns(context, extensionId);
        const card = liveRun(runs);
        await expect(card.getByText('cart › pays')).toBeVisible();
        await runs.waitForTimeout(300);
        stopAtCheckout(run.worker, 2, { reason: 'failure', bar: false });
        await expect(card.locator('.state')).toHaveText('Failed at tests/checkout.spec.ts:5');
        expect(run.worker.heard.filter((m) => m.type === 'control')).toHaveLength(1);
        // The window closes: the failure goes on.
        await runs.close();
        expect(await run.worker.next('control', 1)).toEqual({ type: 'control', action: 'resume', stop: 2 });
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('shows only the actions the worker’s reporter takes, and where the pause bar shows', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const card = liveRun(runs);
      const buttons = card.locator('.controls button');
      // A reporter before the code from a stop: Pick and Record alone.
      const older = await startRun(editor, 'pays', ['pick', 'record']);
      try {
        stopAtCheckout(older.worker, 1);
        await expect(buttons).toHaveText(['Resume', 'Step', 'Finish', 'Pick', 'Record']);
      } finally {
        await endRun(older);
      }
      // One that takes no intent: the controls alone.
      const oldest = await startRun(editor, 'pays', []);
      try {
        stopAtCheckout(oldest.worker, 1);
        await expect(buttons).toHaveText(['Resume', 'Step', 'Finish']);
        await expect(card.getByRole('group', { name: 'Code from this stop' })).toHaveCount(0);
      } finally {
        await endRun(oldest);
      }
      // A headless stop, which no pause bar shows: Mock a request alone, which needs no window.
      const headless = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        stopAtCheckout(headless.worker, 1, { bar: false });
        await expect(buttons).toHaveText(['Resume', 'Step', 'Finish', 'End the test', 'Mock a request']);
      } finally {
        await endRun(headless);
      }
    } finally {
      await context.close();
    }
  });
});

/** Two looks of the test's page, as JPEGs a worker sends: its frames, or the image of its stop. */
async function shopFrames(context: BrowserContext): Promise<{ before: string; after: string }> {
  const shop = await context.newPage();
  await shop.setViewportSize(VIEWPORT);
  await shop.setContent('<!doctype html><h1>Cart</h1><button style="font-size:40px">Pay</button>');
  const before = await jpegOf(shop);
  await shop.locator('h1').evaluate((h1) => (h1.textContent = 'Paid'));
  const after = await jpegOf(shop);
  await shop.close();
  return { before, after };
}

/** The worker answers the image of its stop with `data`, naming the viewport it shows, as a reporter of the view does. */
async function answerImage(worker: FakeWorker, data: string): Promise<void> {
  await answerNext(worker, 'image', { mime: 'image/jpeg', data, ...VIEWPORT });
}

/** A point of an image, as a fraction of its content box. */
async function at(image: ReturnType<Page['locator']>, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const size = await image.evaluate((img: HTMLImageElement) => ({ w: img.clientWidth, h: img.clientHeight }));
  return { x: size.w * fx, y: size.h * fy };
}

test.describe('the live view', () => {
  test('Watch live shows a headless stop’s frames in place of its image, offers Pick and Record there, and stops', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before, after } = await shopFrames(context);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        const card = liveRun(runs);
        stopAtCheckout(run.worker, 1, { bar: false });
        await answerImage(run.worker, before);
        const still = card.getByRole('img', {
          name: "The test’s page, stopped before: Click getByRole('button', { name: 'Pay' })",
        });
        await expect(still).toBeVisible();
        const buttons = card.locator('.controls button');
        // Headless, nobody watching: Pick and Record have no page to start in.
        await expect(buttons).toHaveText(['Resume', 'Step', 'Finish', 'End the test', 'Mock a request']);
        const watch = card.getByRole('button', { name: 'Watch live' });
        await expect(watch).toHaveAttribute('aria-pressed', 'false');
        await expect(card.getByRole('button', { name: 'Pick on the image' })).toBeVisible();

        await watch.click();
        await expect(watch).toHaveAttribute('aria-pressed', 'true');
        expect(await answerView(run.worker)).toMatchObject({ what: 'view', stop: 1, on: true });
        await expect(card.getByText('Starting the live view…')).toBeVisible();
        sendFrame(run.worker, 1, before);
        const live = card.getByRole('img', { name: 'Live view of the test’s page: keys and clicks go to the page' });
        await expect(live).toBeVisible();
        await expect(still).toHaveCount(0);
        await expect(card.locator('.live-badge')).toHaveText('Live');
        // As wide as the window lets it, its aspect kept.
        const shown = await live.evaluate((img: HTMLImageElement) => [
          img.clientWidth / img.clientHeight,
          img.naturalWidth,
        ]);
        expect(shown[0]).toBeCloseTo(VIEWPORT.width / VIEWPORT.height, 1);
        await expect(
          card.getByText('Your clicks, the wheel and your keys on the view go to the test’s page.', { exact: false }),
        ).toBeVisible();
        // Watched, the headless stop takes the actions in its page, driven through the view.
        await expect(buttons).toHaveText([
          'Resume',
          'Step',
          'Finish',
          'End the test',
          'Pick',
          'Record',
          'Assert',
          'Assert a region',
          'Mock a request',
        ]);
        await card.getByRole('button', { name: 'Pick', exact: true }).click();
        const pick = await answerNext(run.worker, 'pick', {
          ok: true,
          message: "Pick an element in the test's window: the locator goes to the editor.",
        });
        expect(pick).toMatchObject({ stop: 1 });
        await expect(card.locator('.note')).toHaveText(
          "Pick an element in the test's window: the locator goes to the editor.",
        );

        // The next frame takes the place of the one before.
        const first = await live.getAttribute('src');
        sendFrame(run.worker, 1, after);
        await expect.poll(() => live.getAttribute('src')).not.toBe(first);
        expect(await live.getAttribute('src')).toBe(`data:image/jpeg;base64,${after}`);
        // A frame is kept in memory, never stored.
        const stored = await runs.evaluate(async () =>
          JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]),
        );
        expect(stored).not.toContain(after.slice(0, 200));

        // Watch live off: the worker stops the view, and the image is back, with the actions of a headless stop.
        await watch.click();
        expect(await answerView(run.worker, false)).toMatchObject({ what: 'view', stop: 1, on: false });
        await expect(watch).toHaveAttribute('aria-pressed', 'false');
        await expect(live).toHaveCount(0);
        await expect(still).toBeVisible();
        await expect(buttons).toHaveText(['Resume', 'Step', 'Finish', 'End the test', 'Mock a request']);
        sendFrame(run.worker, 1, before);
        await runs.waitForTimeout(300);
        await expect(card.locator('img.live')).toHaveCount(0);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a click, the wheel and keys on the live view reach the page at its CSS pixels, Escape staying the window’s', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before } = await shopFrames(context);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      const input = playInput(run.worker);
      try {
        const card = liveRun(runs);
        stopAtCheckout(run.worker, 1, { bar: false });
        await answerImage(run.worker, before);
        const watch = card.getByRole('button', { name: 'Watch live' });
        await watch.click();
        await answerView(run.worker);
        sendFrame(run.worker, 1, before);
        const live = card.getByRole('img', { name: 'Live view of the test’s page: keys and clicks go to the page' });
        await expect(live).toBeVisible();
        const buttons = () =>
          input.events
            .filter((e) => e.type === 'mouse' && e.action !== 'move')
            .map((e) => ('button' in e ? [e.action, e.button, e.clickCount] : []));

        // A click a quarter down the middle: the point in the page's own pixels, the button down and up at once.
        await live.click({ position: await at(live, 0.5, 0.25) });
        await expect.poll(buttons).toEqual([
          ['down', 'left', 1],
          ['up', 'left', 1],
        ]);
        const down = input.events.find((e) => e.type === 'mouse' && e.action === 'down') as { x: number; y: number };
        expect(down.x).toBeCloseTo(VIEWPORT.width * 0.5, -0.5);
        expect(down.y).toBeCloseTo(VIEWPORT.height * 0.25, -0.5);
        await expect(live).toBeFocused();
        // A double click as the browser counts it, a slow one included: no wait of the window's own decides it.
        await live.dblclick({ position: await at(live, 0.25, 0.5) });
        const box = (await live.boundingBox())!;
        await runs.mouse.move(box.x + 30, box.y + 30);
        await runs.mouse.down({ clickCount: 1 });
        await runs.mouse.up({ clickCount: 1 });
        await runs.waitForTimeout(320);
        await runs.mouse.down({ clickCount: 2 });
        await runs.mouse.up({ clickCount: 2 });
        // A right click is the right button's; the middle one stays the window's, as it opens a new tab.
        await live.click({ button: 'right', position: await at(live, 0.75, 0.75) });
        await live.click({ button: 'middle', position: await at(live, 0.75, 0.75) });
        await expect.poll(buttons).toEqual([
          ['down', 'left', 1],
          ['up', 'left', 1],
          ['down', 'left', 1],
          ['up', 'left', 1],
          ['down', 'left', 2],
          ['up', 'left', 2],
          ['down', 'left', 1],
          ['up', 'left', 1],
          ['down', 'left', 2],
          ['up', 'left', 2],
          ['down', 'right', 1],
          ['up', 'right', 1],
        ]);
        // Control held with a click: down around it, as the page's own click would have it.
        const keysBefore = input.events.length;
        await live.click({ position: await at(live, 0.5, 0.5), modifiers: ['Control'] });
        await expect
          .poll(() => input.events.slice(keysBefore).filter((e) => e.type !== 'mouse' || e.action !== 'move'))
          .toEqual([
            { type: 'key', action: 'down', key: 'Control' },
            expect.objectContaining({ type: 'mouse', action: 'down', button: 'left', clickCount: 1 }),
            expect.objectContaining({ type: 'mouse', action: 'up', button: 'left', clickCount: 1 }),
            { type: 'key', action: 'up', key: 'Control' },
          ]);
        // The wheel, once the view has the focus.
        await runs.mouse.wheel(0, 120);
        await expect.poll(() => input.events.find((e) => e.type === 'wheel')).toMatchObject({ deltaY: 120 });

        // Typing: printable keys as Playwright's keys, another character as text, a named key, an editing shortcut;
        // a browser's shortcut stays the browser's.
        const typed = input.events.length;
        await runs.keyboard.type('ab');
        // A key of a layout Playwright has none of: an AZERTY keyboard's é.
        await live.dispatchEvent('keydown', { key: 'é', code: 'Digit2', bubbles: true, cancelable: true });
        await runs.keyboard.press('Control+l');
        await runs.keyboard.press('Control+a');
        await runs.keyboard.press('Shift+Enter');
        // A click into the view took the keyboard: Tab goes to the page too.
        await runs.keyboard.press('Tab');
        await expect.poll(() => input.events.length - typed).toBe(6);
        expect(input.events.slice(typed)).toEqual([
          { type: 'key', action: 'press', key: 'a' },
          { type: 'key', action: 'press', key: 'b' },
          { type: 'text', text: 'é' },
          { type: 'key', action: 'press', key: 'ControlOrMeta+a' },
          { type: 'key', action: 'press', key: 'Shift+Enter' },
          { type: 'key', action: 'press', key: 'Tab' },
        ]);
        await expect(live).toBeFocused();

        // Escape gives the keyboard back, on Watch live; Tab comes back to the view, past Pick on the image, and moves on
        // from it.
        const sent = input.events.length;
        await runs.keyboard.press('Escape');
        await expect(watch).toBeFocused();
        await runs.keyboard.press('Tab');
        await expect(card.getByRole('button', { name: 'Pick on the image' })).toBeFocused();
        await runs.keyboard.press('Tab');
        await expect(live).toBeFocused();
        await runs.keyboard.press('Tab');
        await expect(live).not.toBeFocused();
        await runs.waitForTimeout(400);
        expect(input.events.length).toBe(sent);
      } finally {
        input.stop();
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a click on the view of an older reporter’s stop is held for a double click, a key held with it around it', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before } = await shopFrames(context);
      // A reporter that plays no click count on a button's down and up.
      const run = await startRun(
        editor,
        'pays',
        RUN_TAKES.filter((take) => take !== 'input-clicks'),
      );
      const input = playInput(run.worker);
      try {
        const card = liveRun(runs);
        stopAtCheckout(run.worker, 1, { bar: false });
        await answerImage(run.worker, before);
        await card.getByRole('button', { name: 'Watch live' }).click();
        await answerView(run.worker);
        sendFrame(run.worker, 1, before);
        const live = card.locator('img.live');
        await expect(live).toBeVisible();
        const sent = () => input.events.filter((e) => e.type !== 'mouse' || e.action !== 'move');
        await live.dblclick({ position: await at(live, 0.25, 0.5) });
        await expect.poll(sent).toEqual([expect.objectContaining({ action: 'click', button: 'left', clickCount: 2 })]);
        await live.click({ position: await at(live, 0.5, 0.5), modifiers: ['Alt'] });
        await expect
          .poll(sent)
          .toEqual([
            expect.objectContaining({ action: 'click', clickCount: 2 }),
            { type: 'key', action: 'down', key: 'Alt' },
            expect.objectContaining({ action: 'click', button: 'left', clickCount: 1 }),
            { type: 'key', action: 'up', key: 'Alt' },
          ]);
      } finally {
        input.stop();
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('Pick on the image sends the point of a click on the image, or a Shift+click on the view, and shows the locator', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before } = await shopFrames(context);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      const input = playInput(run.worker);
      try {
        const card = liveRun(runs);
        // At a stop the pause bar shows, on the image the worker sent.
        stopAtCheckout(run.worker, 1);
        await answerImage(run.worker, before);
        const still = card.getByRole('img', { name: /^The test’s page, stopped before/ });
        await expect(still).toBeVisible();
        const pickAt = card.getByRole('button', { name: 'Pick on the image' });
        await pickAt.click();
        await expect(pickAt).toHaveAttribute('aria-pressed', 'true');
        await expect(runs.locator('#announce')).toHaveText(
          'Click the element on the image to pick its locator. Esc stops.',
        );
        await still.click({ position: await at(still, 0.1, 0.2) });
        const locator = "getByRole('button', { name: 'Pay' })";
        const said = `${locator} went to the editor, in place of the locator on the stopped line.`;
        const asked = await answerNext(run.worker, 'pick-at', { ok: true, message: said, locator });
        expect(asked).toMatchObject({ stop: 1 });
        expect((asked as unknown as { x: number }).x).toBeCloseTo(VIEWPORT.width * 0.1, -0.5);
        expect((asked as unknown as { y: number }).y).toBeCloseTo(VIEWPORT.height * 0.2, -0.5);
        await expect(card.locator('.note.sent')).toHaveText(said);
        await expect(card.locator('.note.sent .piwi-loc')).toHaveText(locator);
        await expect(runs.locator('#announce')).toHaveText(said);
        await expect(pickAt).toHaveAttribute('aria-pressed', 'false');

        // On the live view, a Shift+click picks, and goes to the page as no click; a locator is shown as text.
        await card.getByRole('button', { name: 'Watch live' }).click();
        await answerView(run.worker);
        sendFrame(run.worker, 1, before);
        const live = card.locator('img.live');
        await expect(live).toBeVisible();
        await live.click({ position: await at(live, 0.5, 0.5), modifiers: ['Shift'] });
        const markup = "getByText('<img src=x onerror=alert(1)>')";
        await answerNext(run.worker, 'pick-at', {
          ok: true,
          message: `${markup} went to the editor.`,
          locator: markup,
        });
        await expect(card.locator('.note.sent')).toHaveText(`${markup} went to the editor.`);
        await expect(card.locator('.note.sent img')).toHaveCount(0);
        await runs.waitForTimeout(400);
        expect(input.events.filter((e) => e.type === 'mouse' && e.action === 'click')).toEqual([]);
        // A refusal says why.
        await live.click({ position: await at(live, 0.5, 0.9), modifiers: ['Shift'] });
        await answerNext(run.worker, 'pick-at', {
          ok: false,
          message: 'No element is under that point.',
          locator: null,
        });
        await expect(card.locator('.answer')).toHaveText('No element is under that point.');
      } finally {
        input.stop();
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a second window watching a stop shows its latest frame at once, a still page painting no other', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const first = await openRuns(context, extensionId);
      const { before } = await shopFrames(context);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        stopAtCheckout(run.worker, 1, { bar: false });
        await answerImage(run.worker, before);
        await liveRun(first).getByRole('button', { name: 'Watch live' }).click();
        await answerView(run.worker);
        sendFrame(run.worker, 1, before);
        await expect(liveRun(first).locator('img.live')).toHaveAttribute('src', `data:image/jpeg;base64,${before}`);
        const second = await openRuns(context, extensionId);
        await liveRun(second).getByRole('button', { name: 'Watch live' }).click();
        await expect(liveRun(second).locator('img.live')).toHaveAttribute('src', `data:image/jpeg;base64,${before}`);
        // One connection to the hub watches for both: the worker was asked once.
        expect(heardRequests(run.worker, 'view').map((r) => [r.stop, r.on])).toEqual([[1, true]]);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('Watch live stays on as the extension’s worker restarts, and the view is asked again', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before } = await shopFrames(context);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        const card = liveRun(runs);
        const views = () => heardRequests(run.worker, 'view').map((r) => [r.stop, r.on]);
        stopAtCheckout(run.worker, 1, { bar: false });
        await answerImage(run.worker, before);
        const watch = card.getByRole('button', { name: 'Watch live' });
        await watch.click();
        await answerView(run.worker);
        sendFrame(run.worker, 1, before);
        await expect(card.locator('img.live')).toBeVisible();
        // The browser stops the worker, as it does an idle one: its connection to the hub goes with it.
        const cdp = await context.newCDPSession(runs);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await expect.poll(views, { timeout: 20_000 }).toEqual([
          [1, true],
          [1, false],
          [1, true],
        ]);
        await expect(watch).toHaveAttribute('aria-pressed', 'true');
        await answerView(run.worker);
        sendFrame(run.worker, 1, before);
        await expect(card.locator('img.live')).toBeVisible();
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('says why a view sends no frame in place of its start, until a frame comes', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before } = await shopFrames(context);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        const card = liveRun(runs);
        stopAtCheckout(run.worker, 1, { bar: false });
        await answerImage(run.worker, before);
        await card.getByRole('button', { name: 'Watch live' }).click();
        await answerView(run.worker);
        await expect(card.getByText('Starting the live view…')).toBeVisible();
        const refused = 'This page is too heavy for the live view: each image of it is over 384 KB.';
        run.worker.send({ type: 'frame', stop: 1, refused });
        await expect(card.locator('.view-note')).toHaveText(refused);
        await expect(card.getByText('Starting the live view…')).toHaveCount(0);
        await expect(runs.locator('#announce')).toHaveText(refused);
        // The stop's image stays, and Watch live stays on.
        await expect(card.getByRole('img', { name: /^The test’s page, stopped before/ })).toBeVisible();
        await expect(card.getByRole('button', { name: 'Watch live' })).toHaveAttribute('aria-pressed', 'true');
        sendFrame(run.worker, 1, before);
        await expect(card.locator('img.live')).toBeVisible();
        await expect(card.getByText(refused)).toHaveCount(0);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a new stop needs a new view, asked again while Watch live stays on, and none while the window is hidden or gone', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before, after } = await shopFrames(context);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        const card = liveRun(runs);
        const views = () => heardRequests(run.worker, 'view').map((r) => [r.stop, r.on]);
        stopAtCheckout(run.worker, 1, { bar: false });
        await card.getByRole('button', { name: 'Watch live' }).click();
        await answerView(run.worker);
        sendFrame(run.worker, 1, before);
        await expect(card.locator('img.live')).toBeVisible();

        // The test goes on: the view goes with its stop, and a frame of it shows nowhere.
        run.worker.send({ type: 'running', stop: 1 });
        await expect(card.getByText('Running')).toBeVisible();
        await expect(card.locator('img.live')).toHaveCount(0);
        // At the next stop, Watch live left on asks for its own view.
        stopAtCheckout(run.worker, 2, { bar: false });
        await expect.poll(views).toEqual([
          [1, true],
          [2, true],
        ]);
        await answerView(run.worker);
        sendFrame(run.worker, 1, before);
        sendFrame(run.worker, 2, after);
        const live = card.locator('img.live');
        await expect(live).toHaveAttribute('src', `data:image/jpeg;base64,${after}`);

        // The window hides: it watches nothing until it shows again.
        const hidden = (value: boolean) =>
          runs.evaluate((value) => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
            document.dispatchEvent(new Event('visibilitychange'));
          }, value);
        await hidden(true);
        await expect.poll(views).toEqual([
          [1, true],
          [2, true],
          [2, false],
        ]);
        await hidden(false);
        await expect.poll(views).toEqual([
          [1, true],
          [2, true],
          [2, false],
          [2, true],
        ]);
        await answerView(run.worker);
        sendFrame(run.worker, 2, before);
        await expect(live).toHaveAttribute('src', `data:image/jpeg;base64,${before}`);

        // The window closes: the worker stops the view.
        await runs.close();
        await expect.poll(views).toEqual([
          [1, true],
          [2, true],
          [2, false],
          [2, true],
          [2, false],
        ]);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('an older editor service, which says nothing of what a stop takes from the window, shows it as before', async () => {
    const worker = (index: number, bar: boolean) => ({
      worker: index,
      parallelIndex: index,
      state: 'stopped' as const,
      pausing: false,
      intents: ['pick' as const, 'record' as const, 'mock' as const],
      test: {
        id: `t${index}`,
        title: ['cart', `pays ${index}`],
        uri: 'file:///home/me/shop/tests/cart.spec.ts',
        line: 3,
        project: 'chromium',
        retry: 0,
        cannotPause: null,
      },
      stop: {
        reason: 'breakpoint' as const,
        title: "Click getByRole('button', { name: 'Pay' })",
        uri: 'file:///home/me/shop/tests/cart.spec.ts',
        line: 4,
        character: 4,
        locator: "getByRole('button', { name: 'Pay' })",
        bar,
        since: `s${index}`,
      },
    });
    const { context: shooting } = await pairedExtension(editor);
    const { before } = await shopFrames(shooting);
    await shooting.close();
    const older = await olderEditor(
      [
        {
          ref: 'ed-older',
          root: '/home/me/shop',
          label: 'shop',
          command: 'npx playwright test',
          project: null,
          workers: [worker(0, false), worker(1, true)],
          ended: false,
        },
      ],
      before,
    );
    const { context, extensionId } = await pairedExtension(older);
    try {
      const runs = await openRuns(context, extensionId);
      const workers = runs.locator('.worker');
      await expect(workers).toHaveCount(2);
      await expect(workers.nth(0).locator('.controls button')).toHaveText([
        'Resume',
        'Step',
        'Finish',
        'Mock a request',
      ]);
      await expect(workers.nth(1).locator('.controls button')).toHaveText([
        'Resume',
        'Step',
        'Finish',
        'Pick',
        'Record',
        'Mock a request',
      ]);
      await expect(workers.getByRole('img')).toHaveCount(2);
      await expect(runs.getByRole('button', { name: 'Watch live' })).toHaveCount(0);
      await expect(runs.getByRole('button', { name: 'Pick on the image' })).toHaveCount(0);
      await expect(runs.locator('.page-tools')).toHaveCount(0);
      expect(
        older.heard
          .map((m) => m.type)
          .filter((type) => !['subscribe', 'follow', 'pausedPage'].includes(type as string)),
      ).toEqual([]);
    } finally {
      await context.close();
      await older.close();
    }
  });
});

test.describe('the desktop app’s runs', () => {
  test('show beside the editor’s as the desktop app’s, steered here, their code to copy in the app’s window', async () => {
    const desktop = await startDesktop(editor.dir);
    const { context, worker, extensionId } = await pairedExtension(editor, { desktop });
    try {
      // The popup's tile shows once the hubs answer.
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(popup.getByRole('button', { name: /Runs/ })).toBeVisible();
      await popup.close();
      const runs = await openRuns(context, extensionId);
      await expect(runs.getByText('Following 1 editor window and the desktop app')).toBeVisible();

      const run = new FakeWorker(desktop.channel.path, editor.dir).attach(desktop.channel.token, 'desktop-7', 0, [
        ...RUN_TAKES,
      ]);
      run.begin('pays');
      try {
        const card = runs.getByRole('region', { name: path.basename(editor.dir) });
        await expect(card.getByText('Desktop app', { exact: true })).toBeVisible();
        await expect(card.getByText('cart › pays')).toBeVisible();
        await card.getByRole('button', { name: 'Pause' }).click();
        expect(await run.next('control')).toEqual({ type: 'control', action: 'pause' });
        stopAtCheckout(run, 1);
        await expect(card.getByText('Stopped at a breakpoint')).toBeVisible();
        // Pick, Record and Assert end in an editor, which the desktop app has none of: never offered.
        await expect(card.locator('.controls button')).toHaveText([
          'Resume',
          'Step',
          'Finish',
          'End the test',
          'Assert a region',
          'Mock a request',
        ]);

        // Mock a request: the code is made in the desktop app, for its window to copy; this window hears where it went.
        await card.getByRole('button', { name: 'Mock a request' }).click();
        await answerNext(run, 'requests', {
          ok: true,
          message: 'The test kept 1 response.',
          requests: KEPT.slice(0, 1),
        });
        await card.getByRole('button', { name: /api\/cart/ }).click();
        await answerNext(run, 'mock', { ok: true, message: '', response: CART_RESPONSE });
        await expect(card.locator('.note.sent')).toHaveText(
          /^Piwi made the mock to write above checkout\.spec\.ts:5: copy it in the desktop app's window\./,
        );
        await waitFor(() => desktop.codes[0]);
        expect(desktop.codes[0]).toMatchObject({ ref: 'desktop-7', action: 'mock' });
        expect(desktop.codes[0]!.code).toContain("await page.route('**/api/cart'");
        expect(await runs.content()).not.toContain('route.fulfill');

        await card.getByRole('button', { name: 'Resume' }).click();
        expect(await run.next('control', 1)).toEqual({ type: 'control', action: 'resume', stop: 1 });
        // The app's token stays in the secret area, never in the storage a content script reads.
        expect(await localStorageText(runs)).not.toContain(DESKTOP_TOKEN);
        expect(await storedSecret(runs, 'desktop')).toEqual({ url: desktop.origin, token: DESKTOP_TOKEN });
        expect(await storedSecret(runs, 'hubs')).toEqual([editor.hub]);
        expect(JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null)))).not.toContain(
          DESKTOP_TOKEN,
        );
      } finally {
        run.socket.destroy();
      }
    } finally {
      await context.close();
      await desktop.close();
    }
  });

  test('with no editor paired, follow the desktop app alone, and say when it does not answer', async () => {
    const desktop = await startDesktop(editor.dir);
    const { context, extensionId } = await pairedExtension(null, { desktop });
    try {
      const runs = await openRuns(context, extensionId);
      await expect(runs.getByText('Following the desktop app')).toBeVisible();
      await expect(runs.getByText('No run right now. Run a test from the desktop app: it shows here.')).toBeVisible();
      await desktop.close();
      await expect(runs.getByText('Connecting to the desktop app again…')).toBeVisible();
      await expect(
        runs.getByText('The desktop app does not answer: open it to follow the runs it starts.'),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
