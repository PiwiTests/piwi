import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page, Worker } from '@playwright/test';
import {
  clickInShadow,
  debuggerAttached,
  expect,
  expectText,
  finished,
  focusInShadow,
  mouseClickInShadow,
  panelNode,
  type DomNode,
  replayState,
  startReplay,
  step,
  stepsDoc,
  tabIdOf,
  target,
  test,
} from './trusted-site.js';

/**
 * The replay with the real extension: trusted input through `chrome.debugger`
 * where the browser has it, the page's own events when the session is
 * cancelled. Each page reports what it received: whether an event was
 * trusted, whether the element really matched `:hover`.
 */

const LAB = `<!doctype html><html><head><style>
  body { font: 14px sans-serif; margin: 40px; }
  #menu { padding: 12px; border: 1px solid #999; width: 200px; }
  #drag { width: 80px; height: 40px; background: #ddd; }
  #drop { width: 200px; height: 80px; border: 2px dashed #999; margin-top: 20px; }
  #editor { border: 1px solid #999; min-height: 30px; width: 300px; }
</style></head><body>
  <div id="menu" data-testid="menu">Menu</div>
  <output data-testid="hovered">no</output>
  <button data-testid="twice">Open</button>
  <output data-testid="twice-result">none</output>
  <div id="drag" data-testid="card" draggable="true">Card</div>
  <div id="drop" data-testid="bin">Drop here</div>
  <output data-testid="dropped">nothing</output>
  <input type="date" data-testid="due" aria-label="Due" />
  <output data-testid="due-result">none</output>
  <div id="editor" contenteditable="true" data-testid="editor" aria-label="Notes"></div>
  <output data-testid="editor-result">none</output>
  <input type="file" data-testid="upload" aria-label="Attachment" />
  <output data-testid="upload-result">none</output>
<script>
  const out = (id, text) => {
    const el = document.querySelector('[data-testid="' + id + '"]');
    if (el.textContent !== text) el.textContent = text;
  };
  const menu = document.getElementById('menu');
  // Only a real pointer puts an element under :hover; a replay's own events cannot.
  setInterval(() => out('hovered', menu.matches(':hover') ? 'hover: real' : 'no'), 50);
  document.querySelector('[data-testid="twice"]').addEventListener('dblclick', (e) =>
    out('twice-result', e.isTrusted ? 'double click: trusted' : 'double click: script'));
  const card = document.getElementById('drag');
  card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'card'));
  const bin = document.getElementById('drop');
  bin.addEventListener('dragover', (e) => e.preventDefault());
  bin.addEventListener('drop', (e) => {
    e.preventDefault();
    out('dropped', (e.isTrusted ? 'trusted: ' : 'script: ') + e.dataTransfer.getData('text/plain'));
  });
  document.querySelector('[data-testid="due"]').addEventListener('change', (e) => out('due-result', e.target.value));
  const editor = document.getElementById('editor');
  let kind = '';
  editor.addEventListener('beforeinput', (e) => (kind = (e.isTrusted ? 'trusted ' : 'script ') + e.inputType));
  editor.addEventListener('input', () => out('editor-result', kind + ': ' + editor.textContent));
  document.querySelector('[data-testid="upload"]').addEventListener('change', (e) => {
    const f = e.target.files[0];
    out('upload-result', f ? f.name + ' (' + f.size + ' bytes)' : 'none');
  });
</script></body></html>`;

const CLICKS = `<!doctype html><html><body>
  <button data-testid="first">First</button>
  <button data-testid="second">Second</button>
  <output data-testid="log"></output>
<script>
  const log = document.querySelector('[data-testid="log"]');
  for (const b of document.querySelectorAll('button'))
    b.addEventListener('click', (e) => (log.textContent += b.textContent + (e.isTrusted ? ' trusted; ' : ' script; ')));
</script></body></html>`;

/** A page that shows its viewport's size. */
const SIZED = `<!doctype html><html><head><meta charset="utf-8"></head><body><output data-testid="size"></output>
<script>
  const show = () => (document.querySelector('[data-testid="size"]').textContent = innerWidth + '×' + innerHeight);
  show();
  addEventListener('resize', show);
</script></body></html>`;

/** A menu as menu libraries make one: a press outside it closes it, and so does Escape. */
const MENU = `<!doctype html><html><body style="font: 14px sans-serif; margin: 40px">
  <button data-testid="open">Actions</button>
  <div data-testid="menu" role="menu" hidden><button role="menuitem" data-testid="archive">Archive</button></div>
  <output data-testid="log"></output>
<script>
  const menu = document.querySelector('[data-testid="menu"]');
  const opener = document.querySelector('[data-testid="open"]');
  const log = (text) => (document.querySelector('[data-testid="log"]').textContent += text + ';');
  opener.addEventListener('click', () => (menu.hidden = false));
  document.querySelector('[data-testid="archive"]').addEventListener('click', () => {
    menu.hidden = true;
    log('archived');
  });
  document.addEventListener('pointerdown', (e) => {
    if (menu.hidden || menu.contains(e.target) || e.target === opener) return;
    menu.hidden = true;
    log('closed');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || menu.hidden) return;
    menu.hidden = true;
    log('escaped');
  });
</script></body></html>`;

/** A card to drag onto a bin too far below it for both to fit on the screen together. */
const FAR_DRAG = `<!doctype html><html><body style="margin: 0; font: 14px sans-serif">
  <div style="height: 100px"></div>
  <div data-testid="card" draggable="true" style="width: 120px; height: 40px; background: #ddd">Card</div>
  <div style="height: 3000px"></div>
  <div data-testid="bin" style="width: 240px; height: 80px; border: 2px dashed #999">Drop here</div>
  <div style="height: 1500px"></div>
  <output data-testid="dropped">nothing</output>
<script>
  document.querySelector('[data-testid="card"]').addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'card'));
  const bin = document.querySelector('[data-testid="bin"]');
  bin.addEventListener('dragover', (e) => e.preventDefault());
  bin.addEventListener('drop', (e) => {
    e.preventDefault();
    document.querySelector('[data-testid="dropped"]').textContent = e.dataTransfer.getData('text/plain');
  });
</script></body></html>`;

/** An item with a note to write, and a form that opens the next item. */
function item(n: number): string {
  return `<!doctype html><html><body><h1 data-testid="title">Item ${n}</h1>
  <form method="post" action="/items/${n + 1}"><input data-testid="note" aria-label="Note" />
  <button data-testid="next">Next item</button></form></body></html>`;
}

/** Two frames of the same payment form: a frame locator finds both, which an action refuses. */
const FRAMES = `<!doctype html><html><body><iframe src="/pay"></iframe><iframe src="/pay"></iframe></body></html>`;
const PAY = `<!doctype html><html><body><button onclick="this.textContent = 'Paid'">Pay</button></body></html>`;

test.use({
  pages: {
    '/lab': LAB,
    '/clicks': CLICKS,
    '/sized': SIZED,
    '/menu': MENU,
    '/drag-far': FAR_DRAG,
    '/items/1': item(1),
    '/items/2': item(2),
    '/frames': FRAMES,
    '/pay': PAY,
  },
  // The next item takes a while to answer.
  delays: { '/items/2': 2500 },
});

const hasAttribute = (name: string) => (node: DomNode) => {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === name) return true;
  return false;
};

/** The replay panel's own file field, inside its closed shadow root, set as a person's choice sets it. */
async function chooseInReplayPanel(page: Page, file: string): Promise<void> {
  // The panel draws the field once the step has found its element, after the position moved on to it.
  await expect.poll(() => panelNode(page, hasAttribute('data-piwi-replay-file')), { timeout: 20_000 }).not.toBeNull();
  const backendNodeId = await panelNode(page, hasAttribute('data-piwi-replay-file'));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.setFileInputFiles', { files: [file], backendNodeId: backendNodeId! });
  await cdp.detach();
}

test('replays with trusted input: a real hover, a double click, a drag and drop, a date, a rich text editor and a file', async ({
  context,
  control,
  site,
  worker,
}) => {
  const url = `${site}/lab`;
  const doc = stepsDoc('Trusted', site, [
    step('goto', '/lab', { value: '/lab' }),
    step('hover', '/lab', { target: target('menu') }),
    expectText('/lab', 'hovered', 'hover: real'),
    step('dblclick', '/lab', { target: target('twice', 'button', 'Open') }),
    expectText('/lab', 'twice-result', 'double click: trusted'),
    step('dragTo', '/lab', { target: target('card'), dropTarget: target('bin') }),
    expectText('/lab', 'dropped', 'trusted: card'),
    step('fill', '/lab', { target: target('due', 'textbox', 'Due'), value: '2026-09-28' }),
    expectText('/lab', 'due-result', '2026-09-28'),
    step('fill', '/lab', { target: target('editor', 'textbox', 'Notes'), value: 'Hello there' }),
    expectText('/lab', 'editor-result', 'trusted insertText: Hello there'),
    step('setInputFiles', '/lab', { target: target('upload', 'button', 'Attachment'), value: 'note.txt' }),
    expectText('/lab', 'upload-result', 'note.txt (5 bytes)'),
  ]);
  const page = await startReplay(control, context, site, doc, '/lab');
  const tabId = await tabIdOf(worker, url);

  // The file step waits for the developer to choose the file the report names.
  await expect.poll(async () => (await replayState(worker)).position, { timeout: 45_000 }).toBe(11);
  await expect.poll(() => debuggerAttached(worker, tabId)).toBe(true);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'piwi-file-')), 'note.txt');
  writeFileSync(file, 'hello');
  await chooseInReplayPanel(page, file);

  const state = await finished(worker);
  expect(state.results.map((r) => r.status)).toEqual([
    'done',
    'done',
    'passed',
    'done',
    'passed',
    'done',
    'passed',
    'done',
    'passed',
    'done',
    'passed',
    'done',
    'passed',
  ]);
  expect(state.driver).toEqual({ driver: 'cdp', reason: null });
  expect(state.results.filter((r) => r.driver).map((r) => r.driver)).toEqual(['cdp', 'cdp', 'cdp', 'cdp', 'cdp']);
  expect(state.results[11]!.detail).toContain('note.txt');
  // The session is let go with the replay: the debugging bar does not stay.
  await expect.poll(() => debuggerAttached(worker, tabId)).toBe(false);
});

test('a file step can be skipped, and the verdict says the step was left out', async ({
  context,
  control,
  site,
  worker,
}) => {
  const doc = stepsDoc('Skip', site, [
    step('goto', '/lab', { value: '/lab' }),
    step('setInputFiles', '/lab', { target: target('upload', 'button', 'Attachment'), value: 'a.pdf\nb.pdf' }),
  ]);
  const page = await startReplay(control, context, site, doc, '/lab');
  await expect.poll(async () => (await replayState(worker)).position, { timeout: 45_000 }).toBe(1);
  await expect.poll(() => panelNode(page, hasAttribute('data-piwi-replay-file')), { timeout: 20_000 }).not.toBeNull();
  await clickInShadow(page, 'Skip this step');
  const state = await finished(worker);
  expect(state.results.map((r) => r.status)).toEqual(['done', 'skipped']);
});

test('after the debugging bar is cancelled, the replay goes on with the page’s own events and says so', async ({
  context,
  control,
  site,
  worker,
}) => {
  const url = `${site}/clicks`;
  const doc = stepsDoc('Cancel', site, [
    step('goto', '/clicks', { value: '/clicks' }),
    step('click', '/clicks', { target: target('first', 'button', 'First') }),
    step('click', '/clicks', { target: target('second', 'button', 'Second') }),
    expectText('/clicks', 'log', 'First trusted; Second script;'),
  ]);
  const page = await startReplay(control, context, site, doc, '/clicks', true);
  const tabId = await tabIdOf(worker, url);
  const next = () =>
    worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'piwi-replay-wake', wake: true }), tabId);

  await expect.poll(async () => (await replayState(worker)).driver?.driver, { timeout: 30_000 }).toBe('cdp');
  await expect.poll(async () => (await replayState(worker)).position).toBe(1);
  // The goto reloads the page, and the loop starting there forgets a Next sent before it: wait until that loop has
  // drawn its cursor in the reloaded page.
  await expect
    .poll(
      () =>
        page
          .evaluate(
            () =>
              (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type ===
                'reload' && document.getElementById('piwi-replay-cursor-host') !== null,
          )
          .catch(() => false),
      { timeout: 20_000 },
    )
    .toBe(true);
  await next();
  await expect.poll(async () => (await replayState(worker)).position).toBe(2);
  // The position moves on before the step acts: the first click has to land before the bar is cancelled.
  await expect(page.getByTestId('log')).toHaveText('First trusted;');
  // The person clicks Cancel on Chrome's bar.
  await worker.evaluate(
    (id) => (globalThis as { __piwiCancelDebugging?: (id: number) => Promise<void> }).__piwiCancelDebugging!(id),
    tabId,
  );
  await expect
    .poll(async () => (await replayState(worker)).driver)
    .toEqual({ driver: 'synthetic', reason: 'canceled' });
  await next();
  await expect.poll(async () => (await replayState(worker)).position).toBe(3);
  await next();
  const state = await finished(worker);
  expect(state.results.map((r) => [r.status, r.driver ?? null])).toEqual([
    ['done', null],
    ['done', 'cdp'],
    ['done', 'synthetic'],
    ['passed', null],
  ]);
  expect(await debuggerAttached(worker, tabId)).toBe(false);
});

test('a protocol command that fails lets the session go, and the replay goes on with the page’s own events', async ({
  context,
  control,
  site,
  worker,
}) => {
  const url = `${site}/clicks`;
  const doc = stepsDoc('Command fails', site, [
    step('goto', '/clicks', { value: '/clicks' }),
    step('click', '/clicks', { target: target('first', 'button', 'First') }),
    step('click', '/clicks', { target: target('second', 'button', 'Second') }),
    expectText('/clicks', 'log', 'First script; Second script;'),
  ]);
  const page = await startReplay(control, context, site, doc, '/clicks', true);
  const tabId = await tabIdOf(worker, url);
  const next = () =>
    worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'piwi-replay-wake', wake: true }), tabId);

  await expect.poll(async () => (await replayState(worker)).driver?.driver, { timeout: 30_000 }).toBe('cdp');
  await expect.poll(async () => (await replayState(worker)).position).toBe(1);
  await expect
    .poll(
      () =>
        page
          .evaluate(
            () =>
              (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type ===
                'reload' && document.getElementById('piwi-replay-cursor-host') !== null,
          )
          .catch(() => false),
      { timeout: 20_000 },
    )
    .toBe(true);
  // The browser refuses the first mouse command, the session still attached.
  await worker.evaluate(() => {
    const debuggerApi = chrome.debugger as unknown as {
      sendCommand: (target: unknown, method: string, params?: unknown) => Promise<unknown>;
    };
    const send = debuggerApi.sendCommand.bind(chrome.debugger);
    let refused = false;
    debuggerApi.sendCommand = (target, method, params) => {
      if (refused || method !== 'Input.dispatchMouseEvent') return send(target, method, params);
      refused = true;
      return Promise.reject(new Error('Internal error'));
    };
  });
  await next();
  await expect(page.getByTestId('log')).toHaveText('First script;', { timeout: 20_000 });
  await expect.poll(async () => (await replayState(worker)).driver).toEqual({ driver: 'synthetic', reason: 'lost' });
  // The replay no longer uses the session: the debugging bar goes while it still runs.
  await expect.poll(() => debuggerAttached(worker, tabId)).toBe(false);
  expect((await replayState(worker)).status).toBe('running');
  await next();
  await expect.poll(async () => (await replayState(worker)).position).toBe(3);
  await next();
  const state = await finished(worker);
  expect(state.results.map((r) => [r.status, r.driver ?? null])).toEqual([
    ['done', null],
    ['done', 'synthetic'],
    ['done', 'synthetic'],
    ['passed', null],
  ]);
});

test('plays the steps at the viewport they were recorded at, then gives the tab its size back', async ({
  context,
  control,
  site,
  worker,
}) => {
  const doc = {
    ...stepsDoc('Sized', site, [
      step('goto', '/sized', { value: '/sized' }),
      expectText('/sized', 'size', '800×600'),
      expectText('/sized', 'size', '390×664'),
    ]),
    viewports: [
      { step: 0, width: 800, height: 600 },
      { step: 2, width: 390, height: 664 },
    ],
  };
  const page = await startReplay(control, context, site, doc, '/sized');
  const tabId = await tabIdOf(worker, `${site}/sized`);
  const state = await finished(worker);
  expect(state.results.map((r) => r.status)).toEqual(['done', 'passed', 'passed']);
  expect((state as { viewport?: unknown }).viewport).toEqual({ width: 390, height: 664, set: true });
  await expect.poll(() => debuggerAttached(worker, tabId)).toBe(false);
  // Back to the window's size: not the size Playwright emulates, which the cleared override takes away too.
  await expect.poll(() => page.evaluate(() => `${innerWidth}×${innerHeight}`)).not.toMatch(/^(390×664|800×600)$/);
});

test('plays at the recorded size in CSS pixels whatever the zoom of the tab replaying it', async ({
  context,
  control,
  site,
  worker,
}) => {
  // Zoom is kept per site: at 125% here, the replayed tab opens zoomed too.
  const other = await context.newPage();
  await other.goto(`${site}/sized`);
  await worker.evaluate(async (id) => chrome.tabs.setZoom(id, 1.25), await tabIdOf(worker, `${site}/sized`));
  await other.close();
  const doc = {
    ...stepsDoc('Zoomed', site, [step('goto', '/sized', { value: '/sized' }), expectText('/sized', 'size', '390×664')]),
    viewports: [{ step: 0, width: 390, height: 664 }],
  };
  await startReplay(control, context, site, doc, '/sized');
  const state = await finished(worker);
  expect(state.results.map((r) => r.status)).toEqual(['done', 'passed']);
});

/** The replay in `page` is on step `index`, the step before it played and the panel drawn for this one. */
async function waitsForNext(worker: Worker, page: Page, index: number): Promise<void> {
  await expect.poll(async () => (await replayState(worker)).position, { timeout: 30_000 }).toBe(index);
  const progress = `· step ${index + 1} of`;
  await expect
    .poll(() => panelNode(page, (node) => !!node.nodeValue?.includes(progress)).catch(() => null), { timeout: 20_000 })
    .not.toBeNull();
}

test('a Next clicked on the panel leaves the page’s open menu open for the step after it', async ({
  context,
  control,
  site,
  worker,
}) => {
  const doc = stepsDoc('Menu', site, [
    step('goto', '/menu', { value: '/menu' }),
    step('click', '/menu', { target: target('open', 'button', 'Actions') }),
    step('click', '/menu', { target: target('archive', 'menuitem', 'Archive') }),
    expectText('/menu', 'log', 'archived;'),
  ]);
  const page = await startReplay(control, context, site, doc, '/menu', true);
  for (const index of [1, 2, 3]) {
    await waitsForNext(worker, page, index);
    await mouseClickInShadow(page, 'Next step');
  }
  const state = await finished(worker);
  await expect(page.getByTestId('log')).toHaveText('archived;');
  expect(state.results.map((r) => r.status)).toEqual(['done', 'done', 'done', 'passed']);
});

test('a key press with no element goes to the page, though focus was on the panel', async ({
  context,
  control,
  site,
  worker,
}) => {
  const doc = stepsDoc('Escape', site, [
    step('goto', '/menu', { value: '/menu' }),
    step('click', '/menu', { target: target('open', 'button', 'Actions') }),
    step('press', '/menu', { value: 'Escape' }),
    expectText('/menu', 'log', 'escaped;'),
  ]);
  const page = await startReplay(control, context, site, doc, '/menu', true);
  await waitsForNext(worker, page, 1);
  await mouseClickInShadow(page, 'Next step');
  await waitsForNext(worker, page, 2);
  await expect(page.getByRole('menu')).toBeVisible();
  // The person reached Next with the keyboard: focus is on the panel when the key is pressed.
  await focusInShadow(page, 'Next step');
  await mouseClickInShadow(page, 'Next step');
  await waitsForNext(worker, page, 3);
  await mouseClickInShadow(page, 'Next step');
  const state = await finished(worker);
  await expect(page.getByTestId('log')).toHaveText('escaped;');
  expect(state.results.map((r) => r.status)).toEqual(['done', 'done', 'done', 'passed']);
});

test('a click the tab never gets, behind a browser dialog, goes to the person rather than passing', async ({
  context,
  control,
  site,
  worker,
}) => {
  const url = `${site}/clicks`;
  const doc = stepsDoc('Dialog in front', site, [
    step('goto', '/clicks', { value: '/clicks' }),
    step('click', '/clicks', { target: target('first', 'button', 'First') }),
    expectText('/clicks', 'log', 'First trusted;'),
  ]);
  const page = await startReplay(control, context, site, doc, '/clicks', true);
  const tabId = await tabIdOf(worker, url);
  await expect.poll(async () => (await replayState(worker)).driver?.driver, { timeout: 30_000 }).toBe('cdp');
  await expect.poll(async () => (await replayState(worker)).position).toBe(1);
  await expect
    .poll(() => page.evaluate(() => document.getElementById('piwi-replay-cursor-host') !== null).catch(() => false), {
      timeout: 20_000,
    })
    .toBe(true);
  // A tab-modal dialog in front of the tab (Chrome's warning about a leaked password) makes it ignore all input.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.setIgnoreInputEvents', { ignore: true });
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'piwi-replay-wake', wake: true }), tabId);
  await expect.poll(async () => (await replayState(worker)).handOver?.step ?? null, { timeout: 30_000 }).toBe(1);
  expect((await replayState(worker)).handOver?.reason).toMatch(/did not get this input/);
  await cdp.send('Input.setIgnoreInputEvents', { ignore: false });
  await cdp.detach();
  await expect(page.getByTestId('log')).toHaveText('');
});

test('a drag whose two ends never fit on the screen together goes to the person', async ({
  context,
  control,
  site,
  worker,
}) => {
  const doc = stepsDoc('Drag far', site, [
    step('goto', '/drag-far', { value: '/drag-far' }),
    step('dragTo', '/drag-far', { target: target('card'), dropTarget: target('bin') }),
    expectText('/drag-far', 'dropped', 'card'),
  ]);
  const page = await startReplay(control, context, site, doc, '/drag-far');
  await expect.poll(async () => (await replayState(worker)).handOver?.step ?? null, { timeout: 30_000 }).toBe(1);
  expect((await replayState(worker)).handOver?.reason).toMatch(/on screen at once/);
  await expect(page.getByTestId('dropped')).toHaveText('nothing');
});

test('a step whose frame locator finds two frames goes to the person, as a Playwright action refuses it', async ({
  context,
  control,
  site,
  worker,
}) => {
  const pay = "frameLocator('iframe').getByRole('button', { name: 'Pay' })";
  const doc = stepsDoc('Two frames', site, [
    step('goto', '/frames', { value: '/frames' }),
    step('click', '/frames', {
      target: { ...target('pay', 'button', 'Pay'), alternatives: [{ locator: pay, method: 'getByRole', score: 90 }] },
    }),
  ]);
  const page = await startReplay(control, context, site, doc, '/frames');
  await expect.poll(async () => (await replayState(worker)).handOver?.step ?? null, { timeout: 30_000 }).toBe(1);
  expect((await replayState(worker)).handOver?.reason).toMatch(/^2 elements match/);
  for (const frame of page.frames().slice(1)) await expect(frame.getByRole('button')).toHaveText('Pay');
});

test('sets the recorded viewport again on a page the tab comes back to, and says so no more once the session is gone', async ({
  context,
  control,
  site,
  worker,
}) => {
  // Another origin the tab can leave for, which the replay lets go of the tab on.
  const elsewhere = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Elsewhere</title>');
  });
  await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
  try {
    const doc = {
      ...stepsDoc('Back again', site, [
        step('goto', '/sized', { value: '/sized' }),
        expectText('/sized', 'size', '800×600'),
        expectText('/sized', 'size', '800×600'),
      ]),
      viewports: [{ step: 0, width: 800, height: 600 }],
    };
    const page = await startReplay(control, context, site, doc, '/sized', true);
    const tabId = await tabIdOf(worker, `${site}/sized`);
    await waitsForNext(worker, page, 1);
    await expect(page.getByTestId('size')).toHaveText('800×600');

    await page.goto(`http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/`);
    await expect.poll(() => debuggerAttached(worker, tabId)).toBe(false);
    await page.goto(`${site}/sized`);
    await waitsForNext(worker, page, 1);
    await clickInShadow(page, 'Next step');
    await expect.poll(async () => (await replayState(worker)).results[1]?.status ?? null).toBe('passed');

    await waitsForNext(worker, page, 2);
    await worker.evaluate(
      (id) => (globalThis as { __piwiCancelDebugging?: (id: number) => Promise<void> }).__piwiCancelDebugging!(id),
      tabId,
    );
    await expect
      .poll(async () => (await replayState(worker)).viewport)
      .toEqual({ width: 800, height: 600, set: false });
  } finally {
    elsewhere.close();
  }
});

test('lets go of the tab when it leaves for an origin the extension has no access to', async ({
  context,
  control,
  site,
  worker,
}) => {
  const doc = stepsDoc('Leave', site, [
    step('goto', '/clicks', { value: '/clicks' }),
    step('click', '/clicks', { target: target('first', 'button', 'First') }),
  ]);
  const page = await startReplay(control, context, site, doc, '/clicks', true);
  const tabId = await tabIdOf(worker, `${site}/clicks`);
  await waitsForNext(worker, page, 1);
  await expect.poll(() => debuggerAttached(worker, tabId)).toBe(true);
  // The same server under another name: an origin the harness grants nothing on.
  await page.goto(`${site.replace('127.0.0.1', 'localhost')}/clicks`);
  await expect.poll(() => debuggerAttached(worker, tabId), { timeout: 10_000 }).toBe(false);
});

test('waits for the page a submit loads, however slow its answer, before the next step', async ({
  context,
  control,
  site,
  worker,
}) => {
  const doc = stepsDoc('Next item', site, [
    step('goto', '/items/1', { value: '/items/1' }),
    step('click', '/items/1', { target: target('next', 'button', 'Next item') }),
    step('fill', '/items/2', { target: target('note', 'textbox', 'Note'), value: 'hello' }),
    expectText('/items/2', 'title', 'Item 2'),
    step('assert', '/items/2', {
      target: target('note', 'textbox', 'Note'),
      assertion: { matcher: 'toHaveValue', expected: 'hello', actual: null, negated: false, note: null },
    }),
  ]);
  await startReplay(control, context, site, doc, '/items/1');
  const state = await finished(worker);
  expect(state.results.map((r) => r.status)).toEqual(['done', 'done', 'done', 'passed', 'passed']);
});
