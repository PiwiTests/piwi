import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { localStorageText, storedSecret } from './secrets.js';
import {
  answerNext,
  checkHandoff,
  pairedExtension,
  startEditor,
  startRun,
  stopAtCheckout,
  waitFor,
  CART_RESPONSE,
  CHECK,
  FAILURE_ERROR,
  KEPT,
  PAIRING_TOKEN,
  RUN_TAKES,
  type Editor,
} from './runs-fixtures.js';

/**
 * The Runs window in the real extension, against the real editor service and its hub: the worker finds the hub
 * through the pairing, the popup's Runs tile opens the window, and the window pauses, steps and resumes a run whose
 * worker the spec plays, with the image of the stopped page. At a stop it starts the code the editor writes there
 * (Assert, Assert a region, Mock a request, as the worker's reporter takes them), and holds a failed test. A page
 * served from 127.0.0.1 never reaches the hub.
 */

let editor: Editor;

test.beforeAll(async () => {
  editor = await startEditor();
});

test.afterAll(async () => {
  await editor?.close();
});

/** A JPEG of a page, as a worker sends the image of its stopped page. */
async function jpegOf(page: Page): Promise<string> {
  return (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
}

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
          'Check an element in the test’s window: the check is written above this line',
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
        // What the editor wrote comes to the window, in place of what Assert's answer said, and is read out.
        const wrote = /^Piwi wrote the check above checkout\.spec\.ts:5\. The stopped test goes on with the code/;
        await expect(card.locator('.note.written')).toHaveText(wrote);
        await expect(runs.locator('#announce')).toHaveText(wrote);
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
        await expect(card.locator('.note.written')).toHaveText(
          "Piwi wrote the region's ARIA snapshot above checkout.spec.ts:5.",
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
        const said = card.locator('.note.written');
        await expect(said).toHaveText(/^Piwi wrote the mock above checkout\.spec\.ts:5\./);
        // What to review in the code, under it, and read out with it.
        const hidden = 'A value named or shaped like a credential is written as <hidden>.';
        await expect(card.getByRole('list', { name: 'What to review in this code' })).toHaveText(hidden);
        await expect(runs.locator('#announce')).toHaveText(/^Piwi wrote the mock above checkout\.spec\.ts:5\./);
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
        await expect(said).toHaveText('Piwi wrote the mock above checkout.spec.ts:5.');
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
        await expect(buttons).toHaveText(['Resume', 'Step', 'Finish', 'Mock a request']);
      } finally {
        await endRun(headless);
      }
    } finally {
      await context.close();
    }
  });
});
