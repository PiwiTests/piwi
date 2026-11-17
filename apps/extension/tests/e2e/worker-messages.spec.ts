import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Worker } from '@playwright/test';
import { debuggerAttached, expect, step, stepsDoc, tabIdOf, target, test } from './trusted-site.js';

/**
 * What the background worker does with the messages the extension's own pages
 * send, on the real extension: refused from a content script, applied only
 * where they say, one start at a time.
 */

/** Sends `message` from the tab's isolated world, as one of the extension's content scripts would. */
async function fromContentScript(worker: Worker, tabId: number, message: Record<string, unknown>): Promise<unknown> {
  return worker.evaluate(
    async ({ tab, msg }) =>
      (
        await chrome.scripting.executeScript({
          target: { tabId: tab },
          func: (m: unknown) => chrome.runtime.sendMessage(m),
          args: [msg],
        })
      )[0]!.result,
    { tab: tabId, msg: message },
  );
}

const failCart = { id: 'cart', method: 'GET', pattern: '**/api/cart', kind: 'error', delayMs: 0 };

test('a message only the extension’s pages send is refused from a content script', async ({
  context,
  control,
  site,
  worker,
}) => {
  const page = await context.newPage();
  await page.goto(`${site}/page`);
  const tabId = await tabIdOf(worker, `${site}/page`);
  const pagesBefore = context.pages().length;

  const refused = [
    { type: 'piwi-set-tab-viewport', tabId, width: 390, height: 664 },
    { type: 'piwi-clear-tab-viewport', tabId },
    { type: 'piwi-open-viewport', url: `${site}/page`, width: 800, height: 500 },
    { type: 'piwi-set-conditions', tabId, origin: site, conditions: [failCart] },
    { type: 'piwi-start-recording', originPattern: `${site}/*`, tabId, mode: 'actions' },
    { type: 'piwi-set-language', code: 'fr' },
  ];
  for (const message of refused) {
    expect(await fromContentScript(worker, tabId, message), message.type).toEqual({ ok: false });
  }
  expect(await debuggerAttached(worker, tabId)).toBe(false);
  expect(context.pages()).toHaveLength(pagesBefore);
  expect(
    await worker.evaluate(async () => ({
      scripts: (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id),
      recording: ((await chrome.storage.session.get('piwiRecording')).piwiRecording as { active?: boolean })?.active,
      language: (await chrome.storage.local.get('piwiLanguage')).piwiLanguage,
    })),
  ).toEqual({ scripts: [], recording: undefined, language: undefined });

  // The same message from an extension page goes through.
  expect(
    await control.evaluate(
      (id) => chrome.runtime.sendMessage({ type: 'piwi-set-tab-viewport', tabId: id, width: 390, height: 664 }),
      tabId,
    ),
  ).toEqual({ ok: true });
  expect(await debuggerAttached(worker, tabId)).toBe(true);
});

test('request conditions are set only on a tab that shows their origin', async ({ context, control, site, worker }) => {
  // Another origin the extension may also reach: the same address, another port.
  const other = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Other</title>');
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  const otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  try {
    const page = await context.newPage();
    await page.goto(`${otherOrigin}/elsewhere`);
    const tabId = await tabIdOf(worker, `${otherOrigin}/elsewhere`);
    const answer = (await control.evaluate((message) => chrome.runtime.sendMessage(message), {
      type: 'piwi-set-conditions',
      tabId,
      origin: site,
      conditions: [failCart],
    })) as { ok: boolean };
    expect(answer.ok).toBe(false);
    expect(await debuggerAttached(worker, tabId)).toBe(false);
    expect(
      await worker.evaluate(
        async () => (await chrome.storage.session.get('piwiRequestConditions')).piwiRequestConditions,
      ),
    ).toBe(undefined);
  } finally {
    other.close();
  }
});

function oneClick(site: string) {
  return stepsDoc('One click', site, [
    step('goto', '/page', { value: '/page' }),
    step('click', '/page', { target: target('go', 'button', 'Go') }),
  ]);
}

test('two replays started at once both start, the later one registered', async ({ control, site, worker }) => {
  const answers = await control.evaluate(
    ({ steps, origin }) =>
      Promise.all(
        [0, 1].map(() => chrome.runtime.sendMessage({ type: 'piwi-start-replay', steps, origin, inject: false })),
      ),
    { steps: oneClick(site), origin: site },
  );
  expect(answers).toEqual([{ ok: true }, { ok: true }]);
  expect((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).map((s) => s.id).sort()).toEqual(
    ['piwi-replay-evidence', 'piwi-replay-panel'],
  );
});

test('a recording stopped while a replay runs leaves the replay’s badge', async ({
  context,
  control,
  site,
  worker,
}) => {
  const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}));
  // Loaded before the replay starts, the page does not play it: the replay waits for one that does.
  const page = await context.newPage();
  await page.goto(`${site}/page`);
  const tabId = await tabIdOf(worker, `${site}/page`);
  expect(
    await control.evaluate(
      ({ steps, origin }) => chrome.runtime.sendMessage({ type: 'piwi-start-replay', steps, origin, inject: false }),
      { steps: oneClick(site), origin: site },
    ),
  ).toEqual({ ok: true });
  await expect.poll(badge).toBe('PLAY');

  expect(
    await control.evaluate(
      ({ tab, pattern }) =>
        chrome.runtime.sendMessage({
          type: 'piwi-start-recording',
          originPattern: pattern,
          tabId: tab,
        }),
      { tab: tabId, pattern: `${site}/*` },
    ),
  ).toEqual({ ok: true });
  await expect.poll(badge).toBe('REC');

  // The popup's Stop: the recording stored as stopped, then the worker told.
  await control.evaluate(async () => {
    const { piwiRecording } = await chrome.storage.session.get('piwiRecording');
    await chrome.storage.session.set({ piwiRecording: { ...(piwiRecording as object), active: false } });
    await chrome.runtime.sendMessage({ type: 'piwi-recording-stopped' });
  });
  await expect.poll(badge).toBe('PLAY');
});
