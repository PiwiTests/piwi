import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { connectTo, startCiInstance, type CiInstance } from './ci-instance.js';
import { test, expect } from './fixtures.js';

/**
 * The Runs window's CI runs against a stand-in Piwi instance: the run in progress it lists, the tests its lanes run
 * from the run's own stream, and **Watch** on one of them, read-only, through one watch of the run on the instance with
 * the extension's key, another lane shown by a POST on the same watch, its end said in the view with **Watch on the
 * dashboard**.
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
