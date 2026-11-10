import path from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { LIVE_SHARE_MISSING } from '@piwitests/core/live-view';
import { test, expect } from './fixtures.js';
import { localStorageText, storedSecret } from './secrets.js';
import {
  answerLane,
  answerNext,
  answerView,
  checkHandoff,
  heardRequests,
  jpegOf,
  laneWorker,
  olderEditor,
  pairedExtension,
  playInput,
  runMain,
  sendFrame,
  sendLaneFrame,
  startDesktop,
  startEditor,
  startLaneRun,
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
 * service shows none of it. Watch shows a worker's page while its test runs, through its tests and stops, the last
 * frame dimmed until the next one comes, and its frames are the stop's live view; a reporter that cannot show it is
 * told to update. The paired desktop app's runs show beside the editor's, the app named, their code made there for the
 * app's window to copy.
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
      // A reporter that shows no stopped page live: the run says nothing of where its pages show.
      await expect(card.locator('.page-hint')).toHaveCount(0);

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
      expect(await shortcut()).toEqual({
        action: 'pause',
        answers: [{ ok: true, message: 'Pausing at the next call.' }],
      });
      expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'pause' });
      // Its sign on the toolbar badge, for a moment.
      expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('II');
      run.worker.stopAt(1, 30, true);
      await waitFor(() => editor.svc.latest(run.ref)?.workers[0]?.stop ?? undefined);
      // The extension hears the stop from the hub as the editor does, a burst at most every 50 ms.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await shortcut()).toEqual({ action: 'resume', answers: [{ ok: true, message: 'Resuming.' }] });
      expect(await run.worker.next('control', 1)).toEqual({ type: 'control', action: 'resume', stop: 1 });
    } finally {
      run.worker.socket.destroy();
    }
  } finally {
    await context.close();
  }
});

test('a run of several workers pauses and resumes all from its header, and F10 steps the stopped test', async () => {
  const { context, extensionId } = await pairedExtension(editor);
  try {
    const runs = await openRuns(context, extensionId);
    // This run alone: a run of an earlier test may still be listed.
    const card = liveRun(runs).filter({ hasText: 'cart › pays' });
    const { ref, channel } = await editor.svc.command();
    const first = new FakeWorker(channel.path, editor.dir).attach(channel.token, ref, 0, [...RUN_TAKES]);
    const second = new FakeWorker(channel.path, editor.dir).attach(channel.token, ref, 1, [...RUN_TAKES]);
    first.begin('pays');
    second.begin('adds a mug');
    try {
      await card.getByRole('button', { name: 'Pause all' }).click();
      expect(await first.next('control')).toEqual({ type: 'control', action: 'pause' });
      expect(await second.next('control')).toEqual({ type: 'control', action: 'pause' });
      first.stopAt(1, 30, true);
      second.stopAt(1, 31, true);
      await card.getByRole('button', { name: 'Resume all' }).click();
      expect(await first.next('control', 1)).toEqual({ type: 'control', action: 'resume', stop: 1 });
      expect(await second.next('control', 1)).toEqual({ type: 'control', action: 'resume', stop: 1 });
      first.send({ type: 'running', stop: 1 });
      second.send({ type: 'running', stop: 1 });
      await expect(card.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
      // The only stopped test takes the debuggers' keys, its buttons naming them.
      first.stopAt(2, 30, true);
      const step = card.getByRole('button', { name: 'Step', exact: true });
      await expect(step).toHaveAttribute('aria-keyshortcuts', 'F10');
      await expect(card.getByRole('button', { name: 'Resume all' })).toHaveCount(0);
      await runs.keyboard.press('F10');
      expect(await first.next('control', 2)).toEqual({ type: 'control', action: 'step', stop: 2 });
    } finally {
      await editor.svc.client.sendNotification('piwi/commandEnded', { ref, exitCode: 0 });
      first.socket.destroy();
      second.socket.destroy();
    }
  } finally {
    await context.close();
  }
});

test('End the test ends a stopped test there, and a run started in a terminal or a test runner shows as one', async () => {
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

    // A run the editor's own test runner started: one of the runs the editor did not build, named as the runner's.
    const runnerRef = `terminal-4243-${Date.now()}`;
    const runner = new FakeWorker(channel.path, editor.dir).attach(
      channel.token,
      runnerRef,
      0,
      [...RUN_TAKES],
      ['failure'],
      true,
    );
    try {
      runner.begin('pays');
      const shown = liveRun(runs).filter({ has: runs.locator('.run-title', { hasText: 'Test runner' }) });
      await expect(shown.locator('.run-title')).toHaveText(`${path.basename(editor.dir)}Test EditorTest runner`);
    } finally {
      runner.socket.destroy();
      await waitFor(() => (editor.svc.latest(runnerRef)?.ended ? true : undefined), 10_000);
    }
  } finally {
    await context.close();
  }
});

test('a Pause that waits for a call says which and for how long, and End the test ends the test there', async () => {
  const { context, extensionId } = await pairedExtension(editor);
  try {
    const runs = await openRuns(context, extensionId);
    const run = await startLaneRun(editor, 'pays');
    try {
      const card = liveRun(runs);
      // Paused from the keyboard: the focus it loses goes to another control, never End the test.
      await card.getByRole('button', { name: 'Pause', exact: true }).focus();
      await runs.keyboard.press('Enter');
      expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'pause' });
      run.worker.send({
        type: 'waiting',
        title: "Click getByRole('button', { name: 'Pay' })",
        place: { file: 'tests/checkout.spec.ts', line: 5, column: 5 },
        ms: 3000,
        endable: true,
      });
      await expect(card.locator('.state')).toContainText(
        "Pausing: waits in Click getByRole('button', { name: 'Pay' })",
      );
      // The time shows as the line is drawn, and the call as a locator.
      await expect(card.locator('.waited')).toHaveText(/^for \d+\s?s$/, { timeout: 500 });
      await expect(card.locator('.state .call .piwi-loc')).toBeVisible();
      const end = card.getByRole('button', { name: 'End the test' });
      await expect(end).toHaveAttribute('title', /the call it waits in is given up/);
      await expect(end).not.toBeFocused();
      // With no Resume, Step and Finish beside it, End the test stays at the row's start.
      expect(await end.getAttribute('data-apart')).toBeNull();
      await end.click();
      expect(await run.worker.next('control', 1)).toEqual({
        type: 'control',
        action: 'give-up',
        testId: expect.any(String),
      });
      // The Pause is dropped with the test: the row runs on, with Pause again.
      await expect(end).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    } finally {
      await endRun(run);
    }
  } finally {
    await context.close();
  }
});

test('a run says how far it is and how it ended, as its own process says', async () => {
  const { context, extensionId } = await pairedExtension(editor);
  try {
    const runs = await openRuns(context, extensionId);
    const run = await startRun(editor, 'pays');
    const main = runMain(editor, run.channel, run.ref, 3);
    try {
      const card = liveRun(runs);
      await expect(card.locator('.run-progress')).toHaveText('0 of 3 tests');
      // Its number and page on the instance, once its process names them.
      await expect(card.locator('.run-page')).toHaveCount(0);
      main.send({ type: 'run-page', id: 78, url: 'http://127.0.0.1:7494/test-runs/78' });
      await expect(card.locator('.run-number')).toHaveText('Run #78');
      await expect(card.getByRole('button', { name: 'Open' })).toHaveAttribute(
        'title',
        'http://127.0.0.1:7494/test-runs/78',
      );
      await expect(card.getByRole('button', { name: 'Copy link' })).toBeVisible();
      main.send({ type: 'run-progress', done: 2, failed: 1, flaky: 1, skipped: 0 });
      await expect(card.locator('.run-progress')).toHaveText('2 of 3 tests · 1 failed · 1 flaky');
      main.send({
        type: 'run-end',
        status: 'failed',
        failure: { title: 'cart › pays', error: 'expect(locator).toBeVisible() failed' },
        done: 3,
        failed: 1,
        flaky: 1,
        skipped: 0,
      });
    } finally {
      main.socket.destroy();
      await endRun(run);
    }
    // The run that ended says how, with its first failure, its error as the tip.
    const ended = runs.locator('.run.ended', { has: runs.locator('.run-progress') });
    await expect(ended.locator('.run-progress')).toHaveText('3 of 3 tests · 1 failed · 1 flaky');
    await expect(ended.locator('.run-ended')).toHaveText('The run failed. First failure: cart › pays');
    await expect(ended.locator('.first-failure')).toHaveAttribute('title', 'expect(locator).toBeVisible() failed');
    // The run that ended keeps its page.
    await expect(ended.locator('.run-number')).toHaveText('Run #78');
  } finally {
    await context.close();
  }
});

test('Share live says what it sends the first time, shares the run, says who watches, and stops sharing', async () => {
  const { context, extensionId } = await pairedExtension(editor);
  try {
    const runs = await openRuns(context, extensionId);
    const run = await startRun(editor, 'pays', [...RUN_TAKES]);
    const page = 'https://piwi.example.com/test-runs/42';
    const shares = () => run.worker.heard.filter((m) => m.type === 'share');
    try {
      const card = liveRun(runs);
      run.worker.send({ type: 'live', can: true, on: false, viewers: 0, page, why: null });
      const share = card.getByRole('button', { name: 'Share live' });
      await expect(share).toHaveAttribute('title', /team’s Piwi instance/);
      await share.click();
      // The first time in this window, it says what goes out and to whom, and waits for a yes.
      const asked = card.getByRole('group', { name: 'Share live' });
      await expect(card.locator('.share-warning')).toContainText(
        'While this run is shared on piwi.example.com, anyone with its page open there sees each stop of its tests',
      );
      await expect(card.locator('.share-warning')).toContainText(
        'on an instance with authentication off, anyone who can reach it',
      );
      await expect(asked.getByRole('button', { name: 'Share live' })).toBeFocused();
      await asked.getByRole('button', { name: 'Cancel' }).click();
      await expect(card.locator('.share-warning')).toHaveCount(0);
      expect(shares()).toEqual([]);
      await share.click();
      await card.getByRole('button', { name: 'Share live' }).click();
      expect(await run.worker.next('share')).toEqual({ type: 'share', on: true });
      // Shared as its worker says it is.
      run.worker.send({ type: 'live', can: true, on: true, viewers: 0, page, why: null });
      await expect(card.getByText('Shared live on piwi.example.com · nobody watches yet')).toBeVisible();
      run.worker.send({ type: 'live', can: true, on: true, viewers: 2, page, why: null });
      await expect(card.getByText('Shared live on piwi.example.com · 2 views open')).toBeVisible();
      await expect(card.getByRole('button', { name: 'Copy the run page’s link' })).toBeVisible();
      await card.getByRole('button', { name: 'Stop sharing' }).click();
      expect(await run.worker.next('share', 1)).toEqual({ type: 'share', on: false });
      run.worker.send({ type: 'live', can: true, on: false, viewers: 0, page, why: null });
      // Asked once in this window: a second share goes at once.
      await card.getByRole('button', { name: 'Share live' }).click();
      expect(await run.worker.next('share', 2)).toEqual({ type: 'share', on: true });
      await expect(card.locator('.share-warning')).toHaveCount(0);
      run.worker.send({ type: 'live', can: true, on: true, viewers: 1, page, why: null });
      await expect(card.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
      // Its stream given up, the run is no longer shared: it says why, and offers Share live again.
      const lost = 'Sharing stopped: the instance did not answer. Share the run again to try once more.';
      run.worker.send({ type: 'live', can: true, on: false, viewers: 0, page, why: lost });
      await expect(card.getByText(lost)).toBeVisible();
      await expect(card.getByRole('button', { name: 'Share live' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Stop sharing' })).toHaveCount(0);
    } finally {
      await endRun(run);
    }

    // A run that cannot be shared says why in place of Share live, and nothing is asked of its worker: the reporter's
    // reasons in the window's words, any other sentence as the hub said it.
    const refused = await startRun(editor, 'pays', [...RUN_TAKES]);
    try {
      const card = liveRun(runs);
      const local = LIVE_SHARE_MISSING.local;
      refused.worker.send({ type: 'live', can: false, on: false, viewers: 0, page: null, why: local });
      await expect(card.locator('.share-refused')).toHaveText(
        'This run cannot be shared live: it reports to the Piwi desktop app on this machine, which no teammate ' +
          'reaches. Name your team’s instance in PIWI_DASHBOARD_URL to share a run there.',
      );
      await expect(card.getByRole('button', { name: 'Share live' })).toHaveCount(0);
      const why = 'This run cannot be shared live: the instance gave its key up.';
      refused.worker.send({ type: 'live', can: false, on: false, viewers: 0, page: null, why });
      await expect(card.locator('.share-refused')).toHaveText(why);
      await expect(card.locator('.run-share')).toHaveCount(0);
      expect(refused.worker.heard.filter((m) => m.type === 'share')).toEqual([]);
    } finally {
      await endRun(refused);
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
        // The test's controls, then the code this stop can write, in a group of their own, Assert a region and Mock a
        // request folded under More.
        await expect(card.locator('.controls button')).toHaveText([
          'Resume',
          'Step',
          'Finish',
          'End the test',
          'Pick',
          'Record',
          'Assert',
          'More',
        ]);
        const code = card.getByRole('group', { name: 'Code from this stop' });
        const more = code.getByRole('button', { name: 'More' });
        await expect(more).toHaveAttribute('aria-expanded', 'false');
        await expect(more).toHaveAttribute('title', 'Assert a region, Mock a request');
        await more.click();
        await expect(more).toHaveAttribute('aria-expanded', 'true');
        await expect(code.getByRole('button')).toHaveText([
          'Pick',
          'Record',
          'Assert',
          'More',
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
        await expect(card.locator('.worker .note')).toHaveCount(0);
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
        await card.getByRole('button', { name: 'More' }).click();
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
        // The list opens under the button, which keeps the focus and says it is open, pressed whatever its tone.
        await expect(mock).toBeFocused();
        await expect(mock).toHaveAttribute('aria-expanded', 'true');
        await expect(mock).toHaveAttribute('aria-controls', (await list.getAttribute('id'))!);
        const pressed = (button: Locator) => button.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(await pressed(mock)).not.toBe('rgba(0, 0, 0, 0)');

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

        // More folds Mock a request and its open list together, and keeps the focus; it shows it is open, pressed.
        const more = card.getByRole('button', { name: 'More' });
        expect(await pressed(more)).not.toBe('rgba(0, 0, 0, 0)');
        await runs.keyboard.press('Enter');
        await answerNext(run.worker, 'requests', {
          ok: true,
          message: 'The test kept 1 response.',
          requests: [KEPT[0]],
        });
        await expect(list.getByRole('listitem')).toHaveCount(1);
        await more.click();
        await expect(list).toHaveCount(0);
        await expect(mock).toHaveCount(0);
        await expect(more).toHaveAttribute('aria-expanded', 'false');
        await expect(more).toBeFocused();
        await more.click();

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
        await card.getByRole('button', { name: 'More' }).click();
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

        // An answer that comes once the test went on from its stop shows nothing. The new stop folds More again.
        await card.getByRole('button', { name: 'More' }).click();
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
        await expect(card.locator('.worker').locator('.note, .answer')).toHaveCount(0);
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
        // The error its stop names, under its place in its red card, its lines kept.
        await expect(card.locator('.status')).toHaveAttribute('data-tone', 'failed');
        expect(await card.locator('.stop .error').innerText()).toBe(FAILURE_ERROR);
        await expect(runs.locator('#announce')).toHaveText('cart › pays failed at tests/checkout.spec.ts:5.');
        // No Step nor Finish: whatever answers it, the test ends as it failed.
        await expect(card.locator('.controls button')).toHaveText(['Resume', 'Pick', 'Record', 'Assert', 'More']);
        const resume = card.getByRole('button', { name: 'Resume' });
        await expect(resume).toHaveAttribute('title', 'Let the test end as it failed (F8)');
        await resume.click();
        expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });

        // A reporter that names no error: the window reads it from the stop's title.
        run.worker.send({ type: 'running', stop: 1 });
        await expect(card.getByText('Running')).toBeVisible();
        stopAtCheckout(run.worker, 2, { reason: 'failure', error: null });
        await expect(card.locator('.stop')).toHaveText('expect(locator).toBeVisible() failed');
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a plain run’s headless failure waits for an answer only while its Hold failures is on, turned on here', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      const shown = () => editor.svc.sessions.some((s) => s.ref === run.ref && s.workers.some((w) => w.stop));
      const controls = () => run.worker.heard.filter((m) => m.type === 'control');
      try {
        // A plain run, neither with breakpoints nor for a page.pause(): its failure goes on at once, shown to nobody.
        stopAtCheckout(run.worker, 1, { reason: 'failure', bar: false });
        expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
        expect(shown()).toBe(false);

        // A Runs window open holds nothing by itself: the run's Hold failures, off, says so, and the failure goes on.
        const runs = await openRuns(context, extensionId);
        const card = liveRun(runs);
        await expect(card.getByText('cart › pays')).toBeVisible();
        const hold = card.getByRole('button', { name: 'Hold failures' });
        await expect(hold).toHaveAttribute('aria-pressed', 'false');
        await expect(hold).toHaveAttribute('title', /^A failed test goes on at once\./);
        stopAtCheckout(run.worker, 2, { reason: 'failure', bar: false });
        expect(await run.worker.next('control', 1)).toEqual({ type: 'control', action: 'resume', stop: 2 });

        // Turned on here: the run keeps it, and the next failure waits in the window for an answer.
        await hold.click();
        await expect(hold).toHaveAttribute('aria-pressed', 'true');
        await expect(runs.locator('#announce')).toHaveText(
          'A failure no pause bar shows waits at its line in this run until someone answers it.',
        );
        expect(editor.svc.latest(run.ref)?.hold).toEqual({ on: true, by: 'person' });
        stopAtCheckout(run.worker, 3, { reason: 'failure', bar: false });
        await expect(card.locator('.state')).toHaveText('Failed at tests/checkout.spec.ts:5');
        await runs.waitForTimeout(200);
        expect(controls()).toHaveLength(2);
        // Turned off: the failure held now goes on.
        await hold.click();
        expect(await run.worker.next('control', 2)).toEqual({ type: 'control', action: 'resume', stop: 3 });
        await expect(hold).toHaveAttribute('aria-pressed', 'false');
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
      // A headless stop, which no pause bar shows: Mock a request, which needs no window, and the actions in the test's
      // window held until it is watched.
      const headless = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        stopAtCheckout(headless.worker, 1, { bar: false });
        await expect(buttons).toHaveText([
          'Resume',
          'Step',
          'Finish',
          'End the test',
          'Pick',
          'Record',
          'Assert',
          'More',
        ]);
        await expectWatchToUse(card);
      } finally {
        await endRun(headless);
      }
    } finally {
      await context.close();
    }
  });
});

test('Show the browser brings a headed stop’s window to the front, and is not offered at a headless one', async () => {
  const { context, extensionId } = await pairedExtension(editor);
  try {
    const runs = await openRuns(context, extensionId);
    const card = liveRun(runs);
    const { ref, channel } = await editor.svc.command();
    const worker = laneWorker(editor, channel, ref, 0, ['view-lane', 'give-up', 'front']);
    worker.begin('pays');
    try {
      stopAtCheckout(worker, 1);
      const show = card.getByRole('button', { name: 'Show the browser' });
      await expect(show).toHaveAttribute('title', 'Bring the test’s browser window to the front');
      await show.click();
      const asked = await answerNext(worker, 'front', { ok: true, message: "The test's window is in front." });
      expect(asked).toMatchObject({ what: 'front', stop: 1 });
      worker.send({ type: 'running', stop: 1 });
      stopAtCheckout(worker, 2, { bar: false });
      await expect(card.getByRole('button', { name: 'Resume' })).toBeVisible();
      await expect(show).toHaveCount(0);
    } finally {
      await endRun({ ref, worker });
    }
  } finally {
    await context.close();
  }
});

/** The actions in the test's window a headless stop takes once watched. */
const WATCH_TO_USE = ['Pick', 'Record', 'Assert', 'Assert a region'];

/**
 * Pick, Record and the checks at a headless stop the window does not watch: held, each saying to watch first, Assert a
 * region under More.
 */
async function expectWatchToUse(card: Locator): Promise<void> {
  const more = card.getByRole('button', { name: 'More' });
  if ((await more.getAttribute('aria-expanded')) === 'false') await more.click();
  for (const name of WATCH_TO_USE) {
    const button = card.getByRole('button', { name, exact: true });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAttribute('title', 'Watch to use');
  }
}

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

/** The Runs window hides (`true`) or shows again, as the browser says it when it is minimized and back. */
async function setHidden(runs: Page, hidden: boolean): Promise<void> {
  await runs.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
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
        // While the test runs, the run says where its page shows, and how a test stops.
        const hint = card.locator('.page-hint');
        await expect(hint).toHaveText(
          'A test’s page shows here when it stops: at a breakpoint, at page.pause(), or once you pause it. ' +
            'Watch live then shows it as it paints.',
        );
        stopAtCheckout(run.worker, 1, { bar: false });
        await answerImage(run.worker, before);
        const still = card.getByRole('img', {
          name: "The test’s page, stopped before: Click getByRole('button', { name: 'Pay' })",
        });
        await expect(still).toBeVisible();
        await expect(hint).toHaveCount(0);
        const buttons = card.locator('.controls button');
        // Headless, nobody watching: Pick and Record have no page to start in, and say to watch first.
        await expect(buttons).toHaveText([
          'Resume',
          'Step',
          'Finish',
          'End the test',
          'Pick',
          'Record',
          'Assert',
          'More',
        ]);
        await expectWatchToUse(card);
        await card.getByRole('button', { name: 'Pick', exact: true }).click({ force: true });
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
        // Watched, the headless stop takes the actions in its page, driven through the view; More stays open.
        await expect(buttons).toHaveText([
          'Resume',
          'Step',
          'Finish',
          'End the test',
          'Pick',
          'Record',
          'Assert',
          'More',
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
        await expect(buttons).toHaveText([
          'Resume',
          'Step',
          'Finish',
          'End the test',
          'Pick',
          'Record',
          'Assert',
          'More',
          'Assert a region',
          'Mock a request',
        ]);
        await expectWatchToUse(card);
        // The held Pick sent nothing: the one Pick sent was the watched stop's.
        expect(heardRequests(run.worker, 'pick')).toHaveLength(1);
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
        // A locator no editor took is not said to be sent, and is offered to copy.
        await live.click({ position: await at(live, 0.5, 0.5), modifiers: ['Shift'] });
        const alone = `${locator}: no editor took it, as this run names no Send to editor pairing that answers.`;
        await answerNext(run.worker, 'pick-at', { ok: true, message: alone, locator, taken: false });
        await expect(card.locator('.note').filter({ hasText: 'no editor took it' })).toBeVisible();
        await expect(card.locator('.note.sent')).toHaveCount(0);
        await expect(card.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
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

  test('says who else has the run open, who watches a stop and who drives it, Take control and Give back moving it', async () => {
    const theirs = await pairedExtension(editor);
    const ours = await pairedExtension(editor);
    try {
      // A Runs window in another browser, and this one.
      const other = liveRun(await openRuns(theirs.context, theirs.extensionId));
      const runs = await openRuns(ours.context, ours.extensionId);
      const { before } = await shopFrames(ours.context);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      const input = playInput(run.worker);
      try {
        const card = liveRun(runs);
        await expect(card.getByText('Running')).toBeVisible();
        // Each window names the other, and leaves itself out.
        await expect(card.locator('.run-presence')).toHaveText('Also open in Piwi Picker');
        await expect(other.locator('.run-presence')).toHaveText('Also open in Piwi Picker');

        // Watched here: the window says so, as you; nobody drives the stop and no agent follows the run, so nothing
        // offers to take it.
        stopAtCheckout(run.worker, 1, { bar: false });
        await card.getByRole('button', { name: 'Watch live' }).click();
        await answerView(run.worker);
        await expect(card.locator('.watchers')).toHaveText('Watched by you');
        await expect(other.locator('.watchers')).toHaveText('Watched by Piwi Picker');
        await expect(card.locator('.run-driver')).toHaveCount(0);

        // The editor watches too, and its input drives the stop from there.
        const since = editor.svc.latest(run.ref)!.workers[0]!.stop!.since;
        const at = { ref: run.ref, worker: 0, since };
        expect(await editor.svc.client.sendRequest('piwi/pageView', { ...at, on: true })).toMatchObject({ ok: true });
        sendFrame(run.worker, 1, before);
        await expect(card.locator('.watchers')).toHaveText('Watched by you and Test Editor');
        const typed = { ...at, events: [{ type: 'text', text: 'a' }] };
        expect(await editor.svc.client.sendRequest('piwi/pageInput', typed)).toMatchObject({ ok: true });
        await expect(card.locator('.run-driver .driver')).toHaveText('Test Editor drives this stop');

        // Taken here: this window drives it, and the other one hears so.
        await card.getByRole('button', { name: 'Take control' }).click();
        await expect(card.locator('.run-driver .driver')).toHaveText('You drive this stop');
        await expect(runs.locator('#announce')).toHaveText(
          'You drive this stop: an agent would wait until you give it back.',
        );
        await expect(other.locator('.run-driver .driver')).toHaveText('Piwi Picker drives this stop');
        const giveBack = card.getByRole('button', { name: 'Give back' });
        await expect(giveBack).toHaveAttribute('title', 'Give this stop back: an agent may act on it again');
        await expect(giveBack).toBeFocused();

        // Given back: nobody drives it.
        await giveBack.click();
        await expect(runs.locator('#announce')).toHaveText('You gave this stop back: an agent may act on it.');
        await expect(card.locator('.run-driver')).toHaveCount(0);
        await expect(other.locator('.run-driver')).toHaveCount(0);
      } finally {
        input.stop();
        await endRun(run);
      }
    } finally {
      await ours.context.close();
      await theirs.context.close();
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
      // Two workers, one shown at a time behind their tabs: the first stopped one, then the other.
      const workers = runs.locator('.worker');
      await expect(runs.getByRole('tab')).toHaveText(['worker 1', 'worker 2']);
      await expect(workers).toHaveCount(1);
      await expect(workers.locator('.controls button')).toHaveText(['Resume', 'Step', 'Finish', 'Mock a request']);
      await expect(workers.getByRole('img')).toHaveCount(1);
      await runs.getByRole('tab', { name: 'worker 2' }).click();
      await expect(runs.getByRole('tab', { name: 'worker 2' })).toHaveAttribute('aria-selected', 'true');
      await expect(workers.locator('.controls button')).toHaveText([
        'Resume',
        'Step',
        'Finish',
        'Pick',
        'Record',
        'Mock a request',
      ]);
      await expect(workers.getByRole('img')).toHaveCount(1);
      // The arrow keys move between the tabs, the focus with them.
      await runs.keyboard.press('ArrowLeft');
      await expect(runs.getByRole('tab', { name: 'worker 1' })).toHaveAttribute('aria-selected', 'true');
      await expect(runs.getByRole('tab', { name: 'worker 1' })).toBeFocused();
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

test.describe('watching a running test', () => {
  test('Watch shows a running test’s page, keeps its last frame dimmed between tests, and stops', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before, after } = await shopFrames(context);
      const run = await startLaneRun(editor, 'pays');
      try {
        const card = liveRun(runs);
        await expect(card.getByText('Running')).toBeVisible();
        // Its row says it: no hint that the page shows at a stop alone.
        await expect(card.locator('.page-hint')).toHaveCount(0);
        await expect(card.locator('.controls button')).toHaveText(['Pause', 'Pause and watch', 'Watch']);
        const watch = card.getByRole('button', { name: 'Watch', exact: true });
        await expect(watch).toHaveAttribute('aria-pressed', 'false');
        await expect(card.locator('figure')).toHaveCount(0);

        await watch.click();
        await expect(watch).toHaveAttribute('aria-pressed', 'true');
        expect(await answerLane(run.worker)).toMatchObject({ what: 'view-lane', on: true });
        await expect(card.getByText('Starting the live view…')).toBeVisible();
        sendLaneFrame(run.worker, 'pays', null, before);
        const live = card.getByRole('img', { name: 'Live view of the test’s page', exact: true });
        await expect(live).toHaveAttribute('src', `data:image/jpeg;base64,${before}`);
        await expect(card.locator('.live-badge')).toHaveText('Live');
        await expect(card.locator('img.stale')).toHaveCount(0);
        // Watched, Pause and watch has nothing left to do.
        await expect(card.locator('.controls button')).toHaveText(['Pause', 'Watch']);
        // Who watches it in its page's head, its controls above its page, and no stop's image asked of a running test.
        await expect(card.locator('.page-head .watchers')).toHaveText('Watched by you');
        expect(
          await card.locator('.worker').evaluate((item) => [...item.children].map((child) => child.className)),
        ).toEqual(['test-head', 'status', 'controls', 'page']);
        expect(heardRequests(run.worker, 'image')).toEqual([]);

        // The test ends: its last frame stays, dimmed and marked as running, until the next test's comes.
        run.worker.send({ type: 'test-end', testId: 'id-pays', status: 'passed', pausedMs: 0 });
        const last = card.getByRole('img', { name: 'The test’s page, as last seen' });
        await expect(last).toHaveClass(/\bstale\b/);
        await expect(last).toHaveAttribute('src', `data:image/jpeg;base64,${before}`);
        await expect(card.locator('.live-badge')).toHaveText('Running…');
        run.worker.begin('pays again');
        await expect(card.getByText('cart › pays again')).toBeVisible();
        await expect(last).toHaveClass(/\bstale\b/);
        sendLaneFrame(run.worker, 'pays again', null, after);
        await expect(live).toHaveAttribute('src', `data:image/jpeg;base64,${after}`);
        await expect(live).not.toHaveClass(/\bstale\b/);
        await expect(card.locator('.live-badge')).toHaveText('Live');
        // A frame is kept in memory, never stored.
        const stored = await runs.evaluate(async () =>
          JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]),
        );
        expect(stored).not.toContain(after.slice(0, 200));

        // Watch off: the worker stops its lane view, and the row is as it was.
        await watch.click();
        expect(await answerLane(run.worker, false)).toMatchObject({ what: 'view-lane', on: false });
        await expect(watch).toHaveAttribute('aria-pressed', 'false');
        await expect(card.locator('figure')).toHaveCount(0);
        await expect(card.locator('.controls button')).toHaveText(['Pause', 'Pause and watch', 'Watch']);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('Pause and watch brings the stop into view, whose frames take input with no view of its own, dimmed across a Step', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      // A short window, which the stopped lane is brought into.
      await runs.setViewportSize({ width: 440, height: 300 });
      const { before, after } = await shopFrames(context);
      const run = await startLaneRun(editor, 'pays');
      const input = playInput(run.worker);
      try {
        const card = liveRun(runs);
        await card.getByRole('button', { name: 'Pause and watch' }).click();
        expect(await answerLane(run.worker)).toMatchObject({ on: true });
        expect(await run.worker.next('control')).toEqual({ type: 'control', action: 'pause' });
        sendLaneFrame(run.worker, 'pays', null, before);
        const lane = card.locator('img.live');
        await expect(lane).toHaveAttribute('src', `data:image/jpeg;base64,${before}`);
        // The keyboard on no control, so no focus scrolls the window, then the window scrolled past the row's top.
        await runs.mouse.click(2, 2);
        await runs.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await expect(card.locator('.state')).not.toBeInViewport();

        // It stops headless: brought into view, its controls above the page, the frame before dimmed until the stop's.
        stopAtCheckout(run.worker, 1, { bar: false });
        await expect(card.getByText('Stopped at a breakpoint')).toBeInViewport();
        await expect(card.getByRole('button', { name: 'Resume' })).toBeInViewport();
        await expect(lane).toHaveClass(/\bstale\b/);
        await expect(card.locator('.live-badge')).toHaveCount(0);
        // Watch, in place of Watch live, and the stop's actions as a watched stop takes them.
        await expect(card.getByRole('button', { name: 'Watch live' })).toHaveCount(0);
        await expect(card.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(card.locator('.controls button')).toHaveText([
          'Resume',
          'Step',
          'Finish',
          'End the test',
          'Pick',
          'Record',
          'Assert',
          'More',
        ]);
        await card.getByRole('button', { name: 'More' }).click();
        await expect(card.getByRole('button', { name: 'Assert a region' })).toBeVisible();
        await expect(card.locator('.controls [aria-disabled]')).toHaveCount(0);
        sendLaneFrame(run.worker, 'pays', 1, after);
        const live = card.getByRole('img', { name: 'Live view of the test’s page: keys and clicks go to the page' });
        await expect(live).toHaveAttribute('src', `data:image/jpeg;base64,${after}`);
        await expect(live).not.toHaveClass(/\bstale\b/);
        await expect(card.locator('.live-badge')).toHaveText('Live');

        // A click on it reaches the page at its CSS pixels, through the lane: no view of the stop's own is asked.
        await live.click({ position: await at(live, 0.5, 0.25) });
        await expect
          .poll(() => input.events.filter((e) => e.type === 'mouse' && e.action !== 'move').map((e) => e.action))
          .toEqual(['down', 'up']);
        const down = input.events.find((e) => e.type === 'mouse' && e.action === 'down') as { x: number; y: number };
        expect(down.x).toBeCloseTo(VIEWPORT.width * 0.5, -0.5);
        expect(down.y).toBeCloseTo(VIEWPORT.height * 0.25, -0.5);
        await expect(
          card.getByText('Your clicks, the wheel and your keys on the view go to', { exact: false }),
        ).toBeVisible();
        // Pick, driven through the view.
        await card.getByRole('button', { name: 'Pick', exact: true }).click();
        expect(await answerNext(run.worker, 'pick', { ok: true, message: 'Pick an element.' })).toMatchObject({
          stop: 1,
        });
        // Escape gives the keyboard back to Watch.
        await live.click({ position: await at(live, 0.25, 0.75) });
        await runs.keyboard.press('Escape');
        await expect(card.getByRole('button', { name: 'Watch', exact: true })).toBeFocused();
        expect(heardRequests(run.worker, 'view')).toEqual([]);

        // Watched again once the window shows: the frame before is the page as last seen, dimmed and taking no input,
        // until a frame of this watch comes.
        const lanes = () => heardRequests(run.worker, 'view-lane').map((r) => r.on);
        await setHidden(runs, true);
        await expect.poll(lanes).toEqual([true, false]);
        await answerLane(run.worker, false);
        await setHidden(runs, false);
        await expect.poll(lanes).toEqual([true, false, true]);
        await answerLane(run.worker);
        const seen = card.getByRole('img', { name: 'The test’s page, as last seen' });
        await expect(seen).toHaveClass(/\bstale\b/);
        await expect(seen).not.toHaveAttribute('tabindex');
        await expect(card.locator('.live-badge')).toHaveCount(0);
        const played = input.events.length;
        await seen.click({ position: await at(seen, 0.5, 0.5) });
        await runs.waitForTimeout(300);
        expect(input.events).toHaveLength(played);
        sendLaneFrame(run.worker, 'pays', 1, before);
        await expect(live).toHaveAttribute('src', `data:image/jpeg;base64,${before}`);
        await expect(live).not.toHaveClass(/\bstale\b/);

        // A Step: the stop's frame stays, dimmed and marked as running, until the next one comes.
        await card.getByRole('button', { name: 'Step' }).click();
        expect(await run.worker.next('control', 1)).toMatchObject({ action: 'step', stop: 1 });
        run.worker.send({ type: 'running', stop: 1 });
        const last = card.getByRole('img', { name: 'The test’s page, as last seen' });
        await expect(last).toHaveClass(/\bstale\b/);
        await expect(card.locator('.live-badge')).toHaveText('Running…');
        await expect(card.getByRole('button', { name: 'Pick', exact: true })).toHaveCount(0);
        sendLaneFrame(run.worker, 'pays', null, before);
        await expect(card.getByRole('img', { name: 'Live view of the test’s page', exact: true })).toBeVisible();
        expect(lanes()).toEqual([true, false, true]);
      } finally {
        input.stop();
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('Watch says why the lane sends no frame, stops while the window is hidden, and starts again as it shows', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before } = await shopFrames(context);
      const run = await startLaneRun(editor, 'pays');
      try {
        const card = liveRun(runs);
        const lanes = () => heardRequests(run.worker, 'view-lane').map((r) => r.on);
        await card.getByRole('button', { name: 'Watch', exact: true }).click();
        await answerLane(run.worker);
        sendLaneFrame(run.worker, 'pays', null, before);
        await expect(card.locator('img.live')).toBeVisible();
        // Why no frame comes shows in place of the image, read out, until one does.
        const refused = 'This test has no page to show yet.';
        run.worker.send({ type: 'lane-frame', test: 'id-pays', stop: null, refused });
        await expect(card.locator('.view-note')).toHaveText(refused);
        await expect(card.locator('img.live')).toHaveCount(0);
        await expect(runs.locator('#announce')).toHaveText(refused);
        sendLaneFrame(run.worker, 'pays', null, before);
        await expect(card.locator('img.live')).toBeVisible();
        await expect(card.getByText(refused)).toHaveCount(0);

        const hidden = (value: boolean) =>
          runs.evaluate((value) => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
            document.dispatchEvent(new Event('visibilitychange'));
          }, value);
        await hidden(true);
        await expect.poll(lanes).toEqual([true, false]);
        await answerLane(run.worker, false);
        await hidden(false);
        await expect.poll(lanes).toEqual([true, false, true]);
        await expect(card.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await answerLane(run.worker);
        // The frame of the watch before shows dimmed, as the page last seen, until one of this watch comes.
        await expect(card.getByRole('img', { name: 'The test’s page, as last seen' })).toHaveClass(/\bstale\b/);
        await expect(card.locator('.live-badge')).toHaveText('Running…');
        sendLaneFrame(run.worker, 'pays', null, before);
        await expect(card.locator('img.live:not(.stale)')).toBeVisible();

        // The window closes: the worker stops watching.
        await runs.close();
        await expect.poll(lanes).toEqual([true, false, true, false]);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('Watch follows the lane to the worker Playwright starts in its place, and as the extension’s worker restarts', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before, after } = await shopFrames(context);
      const run = await startLaneRun(editor, 'pays');
      let next: ReturnType<typeof laneWorker> | null = null;
      try {
        const card = liveRun(runs);
        await card.getByRole('button', { name: 'Watch', exact: true }).click();
        await answerLane(run.worker);
        sendLaneFrame(run.worker, 'pays', null, before);
        await expect(card.locator('img.live:not(.stale)')).toBeVisible();

        // The worker exits after a failure, and Playwright starts another one in its lane: the hub has it show the
        // lane, and its first frame takes the place of the last one, dimmed meanwhile.
        run.worker.socket.destroy();
        next = laneWorker(editor, run.channel, run.ref, 1);
        next.begin('pays again');
        expect(await answerLane(next)).toMatchObject({ what: 'view-lane', on: true });
        await expect(card.getByText('cart › pays again')).toBeVisible();
        await expect(card.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(card.locator('img.live')).toHaveClass(/\bstale\b/);
        sendLaneFrame(next, 'pays again', null, after);
        await expect(card.locator('img.live:not(.stale)')).toHaveAttribute('src', `data:image/jpeg;base64,${after}`);

        // The browser stops the extension's worker: its connection to the hub goes with it, and the next one watches
        // the lane again.
        const lanes = () => heardRequests(next!, 'view-lane').map((r) => r.on);
        const cdp = await context.newCDPSession(runs);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await expect.poll(lanes, { timeout: 20_000 }).toEqual([true, false, true]);
        await expect(card.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await answerLane(next, false);
        await answerLane(next);
        sendLaneFrame(next, 'pays again', null, before);
        await expect(card.locator('img.live:not(.stale)')).toHaveAttribute('src', `data:image/jpeg;base64,${before}`);
      } finally {
        next?.socket.destroy();
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a refusal to watch shows under the row while its test runs, its stops included, and goes with the test', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const run = await startLaneRun(editor, 'pays');
      try {
        const card = liveRun(runs);
        const watch = card.getByRole('button', { name: 'Watch', exact: true });
        await watch.click();
        const refused = 'This test has no page to show.';
        await answerNext(run.worker, 'view-lane', { ok: false, message: refused });
        const note = card.locator('.view-note');
        await expect(note).toHaveText(refused);
        await expect(watch).toHaveAttribute('aria-pressed', 'false');
        await expect(runs.locator('#announce')).toHaveText(refused);
        // A stop of the test, and the test going on: the refusal stays.
        stopAtCheckout(run.worker, 1);
        await expect(card.getByText('Stopped at a breakpoint')).toBeVisible();
        await expect(note).toHaveText(refused);
        run.worker.send({ type: 'running', stop: 1 });
        await expect(card.getByText('Running')).toBeVisible();
        await expect(note).toHaveText(refused);
        // The test ends: it goes with it.
        run.worker.send({ type: 'test-end', testId: 'id-pays', status: 'passed', pausedMs: 0 });
        await expect(card.getByText('Between tests')).toBeVisible();
        await expect(card.getByText(refused)).toHaveCount(0);
        await expect(card.locator('figure')).toHaveCount(0);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a watched lane’s stop outside a test, which the lane does not show, has Watch live', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const { before } = await shopFrames(context);
      const run = await startLaneRun(editor, 'pays');
      try {
        const card = liveRun(runs);
        await card.getByRole('button', { name: 'Watch', exact: true }).click();
        await answerLane(run.worker);
        sendLaneFrame(run.worker, 'pays', null, before);
        await expect(card.locator('img.live:not(.stale)')).toBeVisible();
        // The test ends, and the worker stops after it, in a fixture's teardown.
        run.worker.send({ type: 'test-end', testId: 'id-pays', status: 'failed', pausedMs: 0 });
        await expect(card.getByText('Between tests')).toBeVisible();
        stopAtCheckout(run.worker, 1, { bar: false });
        await expect(card.getByText('Stopped at a breakpoint')).toBeVisible();
        // Its own view, Watch live, and the actions in the test's window held until it is watched.
        const live = card.getByRole('button', { name: 'Watch live' });
        await expect(live).toBeVisible();
        await expect(card.getByRole('button', { name: 'Watch', exact: true })).toHaveCount(0);
        await expectWatchToUse(card);
        await answerImage(run.worker, before);
        await live.click();
        expect(await answerView(run.worker)).toMatchObject({ what: 'view', stop: 1, on: true });
        sendFrame(run.worker, 1, before);
        await expect(
          card.getByRole('img', { name: 'Live view of the test’s page: keys and clicks go to the page' }),
        ).toBeVisible();
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
    }
  });

  test('a watched lane whose hub is lost says so once, and is not asked again until the hub answers', async () => {
    const desktop = await startDesktop(editor.dir);
    const { context, extensionId } = await pairedExtension(null, { desktop });
    const worker = laneWorker(editor, desktop.channel, 'desktop-lane', 0);
    try {
      const runs = await openRuns(context, extensionId);
      const { before } = await shopFrames(context);
      worker.begin('pays');
      const card = runs.getByRole('region', { name: path.basename(editor.dir) });
      await card.getByRole('button', { name: 'Watch', exact: true }).click();
      await answerLane(worker);
      sendLaneFrame(worker, 'pays', null, before);
      await expect(card.locator('img.live:not(.stale)')).toBeVisible();
      // Each sentence the window reads out, as it is set.
      await runs.evaluate(() => {
        const announce = document.getElementById('announce')!;
        const said: string[] = [];
        (window as unknown as { said: string[] }).said = said;
        new MutationObserver(() => {
          if (announce.textContent) said.push(announce.textContent);
        }).observe(announce, { childList: true, characterData: true, subtree: true });
      });
      const said = () => runs.evaluate(() => (window as unknown as { said: string[] }).said);
      const lost = 'The connection to the editor was lost: the live view starts again once it is back.';
      await desktop.close();
      await expect.poll(said).toContain(lost);
      await runs.waitForTimeout(1500);
      expect((await said()).filter((text) => text === lost)).toHaveLength(1);
    } finally {
      worker.socket.destroy();
      await context.close();
    }
  });

  test('a reporter that cannot show a running test says to update it, and keeps Watch live at its stops', async () => {
    const { context, extensionId } = await pairedExtension(editor);
    try {
      const runs = await openRuns(context, extensionId);
      const run = await startRun(editor, 'pays', [...RUN_TAKES]);
      try {
        const card = liveRun(runs);
        await expect(card.locator('.controls button')).toHaveText(['Pause', 'Watch']);
        const watch = card.getByRole('button', { name: 'Watch', exact: true });
        await expect(watch).toHaveAttribute('aria-disabled', 'true');
        await expect(watch).toHaveAttribute('title', 'Update the reporter to watch a running test');
        await expect(watch).not.toHaveAttribute('aria-pressed');
        await watch.click({ force: true });
        // Its stops are shown as before: the page shows there, and Watch live watches it.
        await expect(card.locator('.page-hint')).toBeVisible();
        stopAtCheckout(run.worker, 1, { bar: false });
        await expect(card.getByRole('button', { name: 'Watch live' })).toBeVisible();
        await expect(card.getByRole('button', { name: 'Watch', exact: true })).toHaveCount(0);
        expect(heardRequests(run.worker, 'view-lane')).toEqual([]);
      } finally {
        await endRun(run);
      }
    } finally {
      await context.close();
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
      // A line for each paired tool.
      await expect(runs.locator('#hubs > p')).toHaveText(['Following 1 editor window', 'Following the desktop app']);

      const run = new FakeWorker(desktop.channel.path, editor.dir).attach(desktop.channel.token, 'desktop-7', 0, [
        ...RUN_TAKES,
      ]);
      run.begin('pays');
      try {
        const card = runs.getByRole('region', { name: path.basename(editor.dir) });
        await expect(card.getByText('Desktop app', { exact: true })).toBeVisible();
        await expect(card.getByText('cart › pays')).toBeVisible();
        // The desktop app sets no breakpoints: its run names the other ways a test stops.
        await expect(card.locator('.page-hint')).toHaveText(
          'A test’s page shows here when it stops: at page.pause(), or once you pause it. ' +
            'Watch live then shows it as it paints.',
        );
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

  test('say when the desktop app stops answering, on a line of its own beside the editor’s', async () => {
    const desktop = await startDesktop(editor.dir);
    const { context, extensionId } = await pairedExtension(editor, { desktop });
    try {
      const runs = await openRuns(context, extensionId);
      await expect(runs.locator('#hubs > p')).toHaveText(['Following 1 editor window', 'Following the desktop app']);
      await desktop.close();
      await expect(runs.locator('#hubs > p').nth(1)).toHaveText('Connecting to the desktop app again…');
      // Found again, the app answers nothing: its line says so, with the button it names, the editor's stays.
      const line = runs.locator('#hubs > p').nth(1);
      await expect(line).toContainText('The desktop app does not answer: open it to follow the runs it starts.', {
        timeout: 15_000,
      });
      await expect(line.getByRole('button', { name: 'Look again' })).toBeVisible();
      await expect(runs.locator('#hubs > p').first()).toHaveText('Following 1 editor window');
    } finally {
      await context.close();
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
