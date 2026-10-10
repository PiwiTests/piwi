import type { Page } from '@playwright/test';
import { PICKER_MARKER_ATTRIBUTE, PICKER_MARKER_EVENT } from '@piwitests/core/picker-marker';
import { expect, test } from './trusted-site.js';

/**
 * The marker on the connected instance's pages (`background/instance-marker.ts`,
 * `content/instance-marker.ts`), with the real worker and a real grant: the
 * site stands in for the instance, and the fixture grants its origin as
 * connecting does.
 */

const marker = (page: Page) =>
  page.evaluate((attribute) => document.documentElement.getAttribute(attribute), PICKER_MARKER_ATTRIBUTE);

test('marks the instance pages while connected, open ones included, and stops after Disconnect', async ({
  context,
  control,
  worker,
  site,
}) => {
  const version = await worker.evaluate(() => chrome.runtime.getManifest().version);
  const registered = () =>
    worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));

  const open = await context.newPage();
  await open.goto(`${site}/projects`);
  // As the dashboard does, for a mark that comes after the page looked.
  await open.evaluate((event) => {
    document.addEventListener(event, () => document.documentElement.setAttribute('data-heard', 'yes'));
  }, PICKER_MARKER_EVENT);
  expect(await marker(open)).toBeNull();

  await control.evaluate(async (instanceUrl) => {
    await chrome.storage.local.set({ piwiConnection: { instanceUrl, projectMappings: [] } });
  }, site);
  await expect.poll(registered).toContain('piwi-instance-marker');
  await expect.poll(() => marker(open)).toBe(version);
  expect(await open.evaluate(() => document.documentElement.getAttribute('data-heard'))).toBe('yes');

  const later = await context.newPage();
  await later.goto(`${site}/bug-reports`);
  await expect.poll(() => marker(later)).toBe(version);

  await control.evaluate(() => chrome.storage.local.remove('piwiConnection'));
  await expect.poll(registered).not.toContain('piwi-instance-marker');
  await later.reload();
  expect(await marker(later)).toBeNull();
});
