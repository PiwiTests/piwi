import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { connectTo, startCiInstance, type CiInstance } from './ci-instance.js';
import { test, expect } from './fixtures.js';

/**
 * The Runs window's CI runs against a stand-in Piwi instance: the run in progress it lists, the tests its lanes run
 * from the run's own stream, and **Watch** on one of them, read-only, through one watch of the run on the instance with
 * the extension's key, another lane shown by a POST on the same watch, its end said in the view with **Watch on the
 * dashboard**; and a test held at its failure for the run's controllers, with **Let it go** on a controller's watch.
 */

let instance: CiInstance;

test.beforeEach(async () => {
  instance = await startCiInstance();
});

test.afterEach(async () => {
  await instance.close();
});

/** Connected mode on the stand-in instance, then the Runs window. */
async function openRuns(page: Page, extensionId: string): Promise<void> {
  await connectTo(page, extensionId, instance);
  await page.goto(`chrome-extension://${extensionId}/runs.html`);
}

const jpeg = (color: string) =>
  sharp({ create: { width: 160, height: 100, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

test('Watch on a CI run’s running test shows its lane read-only, through one watch of the run', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await openRuns(page, extensionId);
  const run = page.getByRole('region', { name: 'CI run #78' });
  await expect(run.getByRole('list', { name: 'Tests running now' })).toBeVisible();
  const second = run.getByRole('listitem').filter({ hasText: 'Worker 2' });
  await expect(second).toContainText('checkout › ships abroad');
  await expect(run.getByRole('listitem').filter({ hasText: 'Worker 1' })).toContainText('cart › pays with a coupon');

  await second.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => instance.watches.length).toBe(1);
  expect(instance.watches[0]!.key).toBe(instance.key);
  expect(Object.fromEntries(instance.watches[0]!.query)).toMatchObject({ worker: '5', slot: '1' });
  await expect(second.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
  instance.live({
    type: 'frame',
    shard: null,
    worker: 5,
    slot: 1,
    image: new Uint8Array(await jpeg('#3b82f6')),
    call: { title: "Click getByRole('button', { name: 'Ship' })" } as never,
    test: 'checkout › ships abroad',
  });
  const view = run.getByRole('img', { name: 'Live view of the CI test’s page, read-only' });
  await expect(view).toBeVisible();
  await expect(run.locator('.ci-view .live-badge')).toBeVisible();
  await expect(run.locator('.ci-view figcaption')).toContainText("Click getByRole('button', { name: 'Ship' })");
  // Read-only: nothing here steers the run, takes input or picks.
  for (const name of ['Interact', 'Pause', 'Pick on the image', 'Resume']) {
    await expect(run.getByRole('button', { name, exact: true })).toHaveCount(0);
  }

  // Watch on the dashboard opens the lane's view on the run's page.
  const opened = context.waitForEvent('page');
  await second.getByRole('button', { name: 'Watch on the dashboard' }).click();
  expect((await opened).url()).toBe(`${instance.url}/test-runs/78?watch=2`);

  // Another lane of the run shows on the same watch.
  const first = run.getByRole('listitem').filter({ hasText: 'Worker 1' });
  await first.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => instance.posts.length).toBe(1);
  expect(instance.posts[0]).toEqual({
    key: instance.key,
    body: { watch: 'watch-0123456789ab', focus: { worker: 4, shard: null, slot: 0 }, width: 880, height: 550 },
  });
  expect(instance.watches).toHaveLength(1);
  await expect(first.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(second.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'false');
  instance.live({
    type: 'frame',
    shard: null,
    worker: 4,
    slot: 0,
    image: new Uint8Array(await jpeg('#22c55e')),
    call: null,
    test: 'cart › pays with a coupon',
  });
  await expect(run.locator('.ci-view figcaption')).toContainText('cart › pays with a coupon');

  // The instance ends the watch with the run: said in the view, with the dashboard's view beside it.
  instance.live({ type: 'end', reason: 'run-ended' });
  await expect(run.locator('.ci-view')).toContainText('The CI run ended.');
  await expect(page.locator('#announce')).toHaveText('The CI run ended.');
  await expect(run.locator('.ci-view').getByRole('button', { name: 'Watch on the dashboard' })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => instance.watches[0]!.closed).toBe(true);

  // Watched again, then turned off: the watch closes.
  await first.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => instance.watches.length).toBe(2);
  await first.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => instance.watches[1]!.closed).toBe(true);
  await expect(run.locator('.ci-view')).toHaveCount(0);

  // A hidden window watches nothing, the run's stream included, and watches again as it shows.
  await first.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => instance.watches.length).toBe(3);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => instance.watches[2]!.closed).toBe(true);
  await expect.poll(() => instance.runStreams.length).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => instance.watches.length).toBe(4);
  await expect.poll(() => instance.runStreams.length).toBe(1);
  await page.close();
  await expect.poll(() => instance.watches[3]!.closed).toBe(true);
  await expect.poll(() => instance.runStreams.length).toBe(0);
});

/** The worker of the second lane holding its test at its failure for the run's controllers, as the instance says it. */
const HELD = {
  shard: null,
  worker: 5,
  slot: 1,
  connected: true,
  holds: true,
  heldFor: ['Ana'],
  paused: {
    reason: 'held',
    call: { title: 'Expected "Shipped", received "Pending"', file: 'tests/checkout.spec.ts', line: 42 },
    test: 'checkout › ships abroad',
    until: Date.UTC(2026, 10, 21, 12, 5),
  },
};

test('a CI test held at its failure shows its hold, and Let it go on a controller’s watch of its lane alone', async ({
  context,
  extensionId,
}) => {
  instance.controller = true;
  const page = await context.newPage();
  await openRuns(page, extensionId);
  const run = page.getByRole('region', { name: 'CI run #78' });
  const second = run.getByRole('listitem').filter({ hasText: 'Worker 2' });
  await expect(second).toBeVisible();
  instance.worker(HELD);
  await expect(second).toContainText('Failed, held at its line');
  // Not watched: the hold shows in the list, with no Let it go.
  await expect(run.getByRole('button', { name: 'Let it go' })).toHaveCount(0);

  await second.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => instance.watches.length).toBe(1);
  const held = run.locator('.ci-held-box');
  await expect(held).toContainText('Failed, held at its line · Held for Ana · until');
  await expect(held).toContainText('Expected "Shipped", received "Pending"');
  await expect(held).toContainText('tests/checkout.spec.ts:42');
  await expect(held).toContainText('The CI job’s own timeout still runs.');
  // The instance's refusal, in its own words: Let it go may be asked again.
  instance.letGoAnswer = { status: 409, body: { message: 'The instance refuses this let-go for now' } };
  const letGo = held.getByRole('button', { name: 'Let it go' });
  await letGo.click();
  await expect.poll(() => instance.letGos.length).toBe(1);
  expect(instance.letGos[0]).toEqual({
    key: instance.key,
    body: { watch: 'watch-0123456789ab', shard: null, worker: 5, slot: 1 },
  });
  await expect(held).toContainText('The instance refuses this let-go for now.');
  await expect(letGo).not.toHaveAttribute('aria-disabled', 'true');
  instance.letGoAnswer = {
    status: 200,
    body: { success: true, message: 'The test goes on: it tears down as it would have, its result unchanged.' },
  };
  await letGo.click();
  await expect.poll(() => instance.letGos.length).toBe(2);
  await expect(held).toContainText('The test goes on: it tears down as it would have, its result unchanged.');
  // Let go, the hold is asked no more until it ends: a press goes nowhere.
  await expect(letGo).toHaveAttribute('aria-disabled', 'true');
  await letGo.dispatchEvent('click');
  await page.waitForTimeout(300);
  expect(instance.letGos).toHaveLength(2);

  // The hold ends as the worker goes on.
  instance.worker({ ...HELD, paused: null });
  await expect(held).toHaveCount(0);
  await expect(second).not.toContainText('Failed, held at its line');
});

test('a held CI test offers no Let it go to a watch the instance did not say is a controller’s', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await openRuns(page, extensionId);
  const run = page.getByRole('region', { name: 'CI run #78' });
  const second = run.getByRole('listitem').filter({ hasText: 'Worker 2' });
  await second.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => instance.watches.length).toBe(1);
  instance.worker(HELD);
  await expect(run.locator('.ci-held-box')).toContainText('Held for Ana');
  await expect(run.getByRole('button', { name: 'Let it go' })).toHaveCount(0);
});

/** The worker of the second lane, which can pause its test for the run's controllers, as the instance says it. */
const PAUSING = { shard: null, worker: 5, slot: 1, connected: true, holds: true, pauses: true, paused: null };
const PAUSED = {
  ...PAUSING,
  pausedBy: 'Ana',
  paused: {
    reason: 'pause',
    call: { title: "Click getByRole('button', { name: 'Ship' })", file: 'tests/checkout.spec.ts', line: 31 },
    test: 'checkout › ships abroad',
    until: Date.UTC(2026, 10, 21, 12, 5),
  },
};

test('a controller pauses a CI test on the watch of its lane, sees the Pause asked, then resumes or ends it', async ({
  context,
  extensionId,
}) => {
  instance.controller = true;
  const page = await context.newPage();
  await openRuns(page, extensionId);
  const run = page.getByRole('region', { name: 'CI run #78' });
  const second = run.getByRole('listitem').filter({ hasText: 'Worker 2' });
  await second.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => instance.watches.length).toBe(1);
  instance.worker(PAUSING);
  const controls = run.locator('.ci-controls');
  const pause = run.getByRole('button', { name: 'Pause', exact: true });
  await pause.click();
  await expect.poll(() => instance.controls.length).toBe(1);
  expect(instance.controls[0]).toEqual({
    key: instance.key,
    body: { watch: 'watch-0123456789ab', shard: null, worker: 5, slot: 1, command: 'pause' },
  });
  await expect(controls).toContainText('The test pauses before its next call.');
  // Asked once in this state: a second press goes nowhere.
  await expect(pause).toHaveAttribute('aria-disabled', 'true');
  // The worker took it: the Pause waits, and Resume takes it back.
  instance.worker({ ...PAUSING, pauseAsked: { by: 'Ana' } });
  await expect(controls).toContainText('Pause asked by Ana');
  await expect(run.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
  await expect(run.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  // Paused: by whom and until when, the call, its place, the job's timeout, Resume and End the test.
  instance.worker(PAUSED);
  await expect(second).toContainText('Paused');
  const box = run.locator('.ci-paused-box');
  await expect(box).toContainText('Paused by Ana · until');
  await expect(box).not.toContainText('Paused · Paused');
  await expect(box).toContainText('tests/checkout.spec.ts:31');
  await expect(box).toContainText('The CI job’s own timeout still runs.');
  // The instance's refusal, in its own words: End the test may be asked again.
  instance.controlAnswer = { status: 409, body: { message: 'The instance refuses this end for now' } };
  const end = box.getByRole('button', { name: 'End the test' });
  await end.click();
  await expect(box).toContainText('The instance refuses this end for now.');
  await expect(end).not.toHaveAttribute('aria-disabled', 'true');
  instance.controlAnswer = { status: 200, body: { success: true, message: 'The test goes on.' } };
  await box.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => instance.controls.map((c) => c.body.command)).toEqual(['pause', 'end', 'resume']);
  await expect(box).toContainText('The test goes on.');
  await expect(end).toHaveAttribute('aria-disabled', 'true');
  // The test goes on: the box goes, Pause comes back.
  instance.worker(PAUSING);
  await expect(box).toHaveCount(0);
  await expect(run.getByRole('button', { name: 'Pause', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
});

/** A `lane` event of the run's stream, as a busy run sends one between the workers' states. */
function laneEvent(n: number, worker: number, title: string, retry = 0) {
  const event = {
    id: { run: 78, shard: null, lane: n },
    state: 'running',
    worker,
    test: { id: `t${n}-${retry}`, title, retry },
    stop: null,
    waiting: null,
    done: 3,
    failed: retry,
  };
  for (const res of instance.runStreams)
    res.write(`data: ${JSON.stringify({ type: 'lane', data: event, seq: 1 })}\n\n`);
}

test('a Pause the worker drops says so alone, and Pause is offered again however fast the drop came', async ({
  context,
  extensionId,
}) => {
  instance.controller = true;
  const page = await context.newPage();
  await openRuns(page, extensionId);
  const run = page.getByRole('region', { name: 'CI run #78' });
  await run
    .getByRole('listitem')
    .filter({ hasText: 'Worker 2' })
    .getByRole('button', { name: 'Watch', exact: true })
    .click();
  await expect.poll(() => instance.watches.length).toBe(1);
  const why = 'No test runs on this worker now.';
  instance.worker({ ...PAUSING, pauseSeq: 1 });
  const pause = run.getByRole('button', { name: 'Pause', exact: true });
  await pause.click();
  await expect.poll(() => instance.controls.length).toBe(1);
  await expect(run.locator('.ci-controls')).toContainText('The test pauses before its next call.');
  // The Pause is taken, then dropped at once: what the click came to goes with the state it was said in.
  laneEvent(0, 4, 'cart › pays with a coupon');
  instance.worker({ ...PAUSING, pauseAsked: {}, pauseSeq: 2 });
  instance.worker({ ...PAUSING, pauseDropped: why, pauseSeq: 3 });
  await expect(run.locator('.ci-controls')).toContainText(`The Pause was dropped: ${why}`);
  await expect(run.locator('.ci-controls')).not.toContainText('The test pauses before its next call.');
  await expect(pause).not.toHaveAttribute('aria-disabled', 'true');
  // The same again, the same reason: Pause is offered again all the same.
  await pause.click();
  await expect.poll(() => instance.controls.length).toBe(2);
  instance.worker({ ...PAUSING, pauseAsked: {}, pauseSeq: 4 });
  instance.worker({ ...PAUSING, pauseDropped: why, pauseSeq: 5 });
  await expect(pause).not.toHaveAttribute('aria-disabled', 'true');
});

test('a new worker in the lane takes the controls: one press, one command, for that worker', async ({
  context,
  extensionId,
}) => {
  instance.controller = true;
  const page = await context.newPage();
  await openRuns(page, extensionId);
  const run = page.getByRole('region', { name: 'CI run #78' });
  await run
    .getByRole('listitem')
    .filter({ hasText: 'Worker 2' })
    .getByRole('button', { name: 'Watch', exact: true })
    .click();
  await expect.poll(() => instance.watches.length).toBe(1);
  instance.worker({ ...PAUSING, pauseSeq: 1 });
  await expect(run.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  // Playwright starts worker 6 in the lane after a failure: the lane's next test.
  laneEvent(1, 6, 'checkout › ships abroad', 1);
  instance.worker({ ...PAUSING, connected: false });
  instance.worker({ ...PAUSING, worker: 6, pauseSeq: 0 });
  await page.waitForTimeout(800);
  const pause = run.getByRole('button', { name: 'Pause', exact: true });
  await pause.click();
  await pause.dispatchEvent('click');
  await page.waitForTimeout(500);
  expect(instance.controls.map((c) => c.body)).toEqual([
    { watch: 'watch-0123456789ab', shard: null, worker: 6, slot: 1, command: 'pause' },
  ]);
  await expect(pause).toHaveAttribute('aria-disabled', 'true');
});

test('a CI test paused offers no control to a watch the instance did not say is a controller’s', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await openRuns(page, extensionId);
  const run = page.getByRole('region', { name: 'CI run #78' });
  await run
    .getByRole('listitem')
    .filter({ hasText: 'Worker 2' })
    .getByRole('button', { name: 'Watch', exact: true })
    .click();
  await expect.poll(() => instance.watches.length).toBe(1);
  instance.worker(PAUSED);
  await expect(run.locator('.ci-paused-box')).toContainText('Paused by Ana');
  for (const name of ['Pause', 'Resume', 'End the test']) {
    await expect(run.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
});

test('a CI run whose project’s live view is off lists its tests without Watch, saying why', async ({
  context,
  extensionId,
}) => {
  instance.watchable = false;
  const page = await context.newPage();
  await openRuns(page, extensionId);
  const run = page.getByRole('region', { name: 'CI run #78' });
  await expect(run.getByRole('listitem').filter({ hasText: 'Worker 1' })).toBeVisible();
  await expect(run).toContainText('This run’s tests cannot be watched');
  await expect(run.getByRole('button', { name: 'Watch', exact: true })).toHaveCount(0);
  await expect(run.getByRole('button', { name: 'Watch on the dashboard' })).toHaveCount(2);
});
