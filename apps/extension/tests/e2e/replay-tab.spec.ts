import type { Page, Worker } from '@playwright/test';
import {
  clickInShadow,
  debuggerAttached,
  type DomNode,
  expect,
  expectText,
  finished,
  panelNode,
  replayState,
  startReplay,
  step,
  stepsDoc,
  tabIdOf,
  target,
  test,
} from './trusted-site.js';

/**
 * A replay belongs to one tab: the replay script is registered for the whole
 * origin, so every tab of it loads the script, and only the replay's own tab
 * plays the steps. The real extension, on a local site.
 */

const BUTTONS = `<!doctype html><html><body>
  <button data-testid="first">First</button>
  <button data-testid="second">Second</button>
  <output data-testid="log"></output>
<script>
  for (const b of document.querySelectorAll('button'))
    b.addEventListener('click', () => (document.querySelector('[data-testid="log"]').textContent += b.textContent + ';'));
</script></body></html>`;

/** A page that opens the next one in a new tab: a link, or a script. */
const OPENER = `<!doctype html><html><body>
  <a data-testid="link" href="/opened" target="_blank">Open the order</a>
  <button data-testid="script" onclick="window.open('/opened')">Open the order</button>
</body></html>`;

const OPENED = `<!doctype html><html><body>
  <button data-testid="pay" onclick="this.textContent = 'Paid'">Pay</button>
</body></html>`;

test.use({ pages: { '/buttons': BUTTONS, '/opener': OPENER, '/opened': OPENED } });

function twoClicks(site: string) {
  return stepsDoc('Two clicks', site, [
    step('goto', '/buttons', { value: '/buttons' }),
    step('click', '/buttons', { target: target('first', 'button', 'First') }),
    step('click', '/buttons', { target: target('second', 'button', 'Second') }),
  ]);
}

function hostIn(page: Page, id: string): Promise<boolean> {
  return page.evaluate((hostId) => document.getElementById(hostId) !== null, id).catch(() => false);
}

/** The replay waits in step mode for Next before its first click, its panel up in `page`. */
async function waitingForNext(worker: Worker, page: Page): Promise<void> {
  await expect.poll(async () => (await replayState(worker)).position, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => hostIn(page, 'piwi-replay-hud-host'), { timeout: 20_000 }).toBe(true);
}

test('another tab on the replayed origin leaves the replay to its own tab', async ({
  context,
  control,
  site,
  worker,
}) => {
  const page = await startReplay(control, context, site, twoClicks(site), '/buttons', true);
  await waitingForNext(worker, page);
  const replayTab = await tabIdOf(worker, `${site}/buttons`);

  const other = await context.newPage();
  await other.goto(`${site}/buttons`);
  await other.waitForLoadState('load');
  // Long enough for the registered script to have started a loop of its own, were it to.
  await other.waitForTimeout(1500);
  expect(await hostIn(other, 'piwi-replay-hud-host')).toBe(false);
  expect(await hostIn(other, 'piwi-replay-cursor-host')).toBe(false);
  expect(await hostIn(other, 'piwi-replay-dialog-host')).toBe(false);
  expect((await replayState(worker)).position).toBe(1);
  await expect(other.getByTestId('log')).toHaveText('');

  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'piwi-replay-wake', wake: true }), replayTab);
  await expect.poll(async () => (await replayState(worker)).position).toBe(2);
  await expect(page.getByTestId('log')).toHaveText('First;');
  await expect(other.getByTestId('log')).toHaveText('');
});

test('closing the replay’s tab ends the replay, and the origin’s next page does not play it', async ({
  context,
  control,
  site,
  worker,
}) => {
  const page = await startReplay(control, context, site, twoClicks(site), '/buttons', true);
  await waitingForNext(worker, page);
  await page.close();

  await expect
    .poll(async () => {
      const state = (await replayState(worker)) as { status: string; finished?: boolean };
      return [state.status, state.finished];
    })
    .toEqual(['stopped', true]);
  await expect
    .poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id)))
    .toEqual([]);

  const next = await context.newPage();
  await next.goto(`${site}/buttons`);
  await next.waitForLoadState('load');
  await next.waitForTimeout(1000);
  expect(await hostIn(next, 'piwi-replay-hud-host')).toBe(false);
  await expect(next.getByTestId('log')).toHaveText('');
});

for (const opener of ['link', 'script'] as const) {
  test(`a step that opens its page in a new tab (${opener}) takes the replay there`, async ({
    context,
    control,
    site,
    worker,
  }) => {
    const doc = stepsDoc('New tab', site, [
      step('goto', '/opener', { value: '/opener' }),
      step('click', '/opener', { target: target(opener, null, 'Open the order') }),
      step('click', '/opened', { target: target('pay', 'button', 'Pay') }),
      expectText('/opened', 'pay', 'Paid'),
    ]);
    const opened = context.waitForEvent('page', (p) => p.url().endsWith('/opened'));
    const page = await startReplay(control, context, site, doc, '/opener');
    const first = await tabIdOf(worker, `${site}/opener`);
    const next = await opened;

    const state = await finished(worker);
    expect(state.results.map((r) => r.status)).toEqual(['done', 'done', 'done', 'passed']);
    await expect(next.getByTestId('pay')).toHaveText('Paid');
    // The tab it left plays nothing more, and is let go.
    await expect.poll(() => hostIn(page, 'piwi-replay-hud-host')).toBe(false);
    expect(await hostIn(page, 'piwi-replay-cursor-host')).toBe(false);
    expect(await debuggerAttached(worker, first)).toBe(false);
  });
}

test('a handed-over step the person does by opening a new tab takes the replay there', async ({
  context,
  control,
  site,
  worker,
}) => {
  const doc = stepsDoc('New tab by hand', site, [
    step('goto', '/opener', { value: '/opener' }),
    step('click', '/opener', { target: target('gone', 'link', 'Open the order') }),
    step('click', '/opened', { target: target('pay', 'button', 'Pay') }),
  ]);
  const page = await startReplay(control, context, site, doc, '/opener');
  await expect.poll(async () => (await replayState(worker)).handOver?.step, { timeout: 30_000 }).toBe(1);

  const opened = context.waitForEvent('page');
  await page.getByTestId('link').click();
  const next = await opened;
  // The new tab draws the hand-over once its page is ready.
  const doneButton = (node: DomNode) =>
    node.nodeName === 'BUTTON' && (node.children ?? []).some((c) => c.nodeValue === 'I did it, continue');
  await expect.poll(() => panelNode(next, doneButton), { timeout: 20_000 }).not.toBeNull();
  await clickInShadow(next, 'I did it, continue');

  const state = await finished(worker);
  expect(state.results.map((r) => r.status)).toEqual(['done', 'manual', 'done']);
  await expect(next.getByTestId('pay')).toHaveText('Paid');
  await expect.poll(() => hostIn(page, 'piwi-replay-hud-host')).toBe(false);
});
