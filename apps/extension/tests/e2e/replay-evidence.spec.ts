import type { Page } from '@playwright/test';
import { clickInShadow, expect, finished, nodeText, tabIdOf, test, type DomNode } from './trusted-site.js';

/**
 * What the page showed during a replay of the bug report recorded in this
 * browser, on the real extension: the recording's own console errors and
 * failed requests, which the page's evidence script still holds in the tab
 * the debugging session collected them from, are not the replay's.
 */

// Apply posts a coupon the server refuses and logs the failure; Done shows once it has.
const CART = `<!doctype html><html><body>
  <button id="apply">Apply coupon</button>
  <script>
    document.getElementById('apply').addEventListener('click', async () => {
      const res = await fetch('/api/cart/coupon-fail?code=SPRING10', { method: 'POST' });
      console.error('Coupon failed: ' + res.status);
      const done = document.createElement('button');
      done.id = 'done';
      done.textContent = 'Done';
      document.body.append(done);
    });
  </script>
</body></html>`;

test.use({ pages: { '/cart': CART } });

interface Evidence {
  console: Array<{ message: string; time: number }>;
  requests: Array<{ method: string; url: string; status: number; time: number }>;
}

/** The lines under "What the page showed during the replay", in the replay's closed panel. */
async function seenLines(page: Page): Promise<string[]> {
  const seen = (node: DomNode) => node.nodeName === 'DIV' && (node.attributes ?? []).join(' ').includes('class seen');
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    const find = (node: DomNode): DomNode | null => {
      if (seen(node)) return node;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    return (find(root)?.children ?? []).map(nodeText);
  } finally {
    await cdp.detach();
  }
}

test('a replay of the bug report recorded in this browser lists each request and console error it caused once', async ({
  context,
  control,
  site,
  worker,
}) => {
  const page = await context.newPage();
  await page.goto(`${site}/cart`);
  const tabId = await tabIdOf(worker, `${site}/cart`);
  const started = await control.evaluate(
    ({ tabId, pattern }) =>
      chrome.runtime.sendMessage({ type: 'piwi-start-recording', originPattern: pattern, tabId, mode: 'bug' }),
    { tabId, pattern: `${site}/*` },
  );
  expect(started).toEqual({ ok: true });
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-hud-host'))).toBe(true);

  // One click: one failed request, one console error, collected through the debugging session.
  await page.locator('#apply').click();
  await expect
    .poll(() =>
      worker.evaluate(async () => {
        const cdp = (await chrome.storage.session.get('piwiBugCdpEvidence')).piwiBugCdpEvidence as Evidence;
        return cdp ? cdp.console.length + cdp.requests.length : 0;
      }),
    )
    .toBe(2);
  await page.locator('#done').click();
  await clickInShadow(page, 'Finish');
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-review-host'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => !!document.getElementById('piwi-record-review-host'))).toBe(false);

  // The popup's Replay a bug report opens the chooser in the same page, which offers the report just recorded.
  await worker.evaluate(
    (id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['replay-panel.js'] }),
    tabId,
  );
  await clickInShadow(page, 'Use the bug report recorded in this browser');
  await clickInShadow(page, 'Replay');

  const state = await finished(worker);
  expect(state.results.map((r) => r.status)).toEqual(['done', 'done', 'done']);
  const evidence = (await worker.evaluate(
    async () => (await chrome.storage.session.get('piwiReplayEvidence')).piwiReplayEvidence,
  )) as Evidence;
  expect(evidence.requests.map((r) => `${r.method} ${r.url} ${r.status}`)).toEqual([
    'POST /api/cart/coupon-fail?code=%3Credacted%3E 500',
  ]);
  expect(evidence.console.map((c) => c.message)).toEqual(['Coupon failed: 500']);
  await expect
    .poll(() => seenLines(page))
    .toEqual([
      'What the page showed during the replay:',
      'POST /api/cart/coupon-fail?code=%3Credacted%3E answered 500',
      'Console error: Coupon failed: 500',
    ]);
});
