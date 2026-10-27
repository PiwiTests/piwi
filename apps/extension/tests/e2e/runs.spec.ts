import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { localStorageText, storedSecret } from './secrets.js';
import { pairedExtension, startEditor, startRun, waitFor, PAIRING_TOKEN, type Editor } from './runs-fixtures.js';

/**
 * The Runs window in the real extension, against the real editor service and its hub: the worker finds the hub
 * through the pairing, the popup's Runs tile opens the window, and the window pauses, steps and resumes a run whose
 * worker the spec plays, with the image of the stopped page. A page served from 127.0.0.1 never reaches the hub.
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

      // Step: the worker runs the call and stops before the next one, whose image is asked for in turn.
      await card.getByRole('button', { name: 'Step' }).click();
      expect(await run.worker.next('control', 1)).toEqual({ type: 'control', action: 'step', stop: 1 });
      run.worker.send({ type: 'running', stop: 1 });
      run.worker.stopAt(2, 31, true);
      await expect(card.getByText('tests/pages/cart.page.ts:31')).toBeVisible();
      const again = await run.worker.next('request', 3);
      expect(again).toMatchObject({ what: 'image' });
      run.worker.send({ type: 'answer', request: again.request, what: 'image', value: null });
      await expect(card.getByText('No image: the worker is not stopped, or did not answer in time.')).toBeVisible();

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
    // The command is the browser's, global in Chrome and Edge.
    const commands = await worker.evaluate(async () => chrome.commands.getAll());
    expect(commands.find((c) => c.name === 'run-pause-resume')).toMatchObject({
      description: 'Pause the editor’s runs, or resume a stopped test',
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
