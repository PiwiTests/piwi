import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { REVEAL_EXPRESSION } from '../../src/shared/devtools-selection.js';
import { launchWithEditedManifest, removedOnClose } from './fixtures.js';

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** Evaluates `expression` in a target through its own debugging socket, awaiting a promise it returns. */
async function evaluateIn(target: CdpTarget, expression: string): Promise<unknown> {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  try {
    const reply = await new Promise<{ result?: { result?: { value?: unknown } } }>((resolve) => {
      socket.onmessage = (message) => resolve(JSON.parse(String(message.data)));
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    return reply.result?.result?.value;
  } finally {
    socket.close();
  }
}

/**
 * The browser's real DevTools, opened by `--auto-open-devtools-for-tabs`,
 * loads the extension's `devtools_page`, and from it the ranking path the
 * Elements sidebar takes works: the content script is injected, `$0` is
 * handed to it with `useContentScriptContext`, and it answers with the
 * verified locators. The DevTools page is reached through the browser's
 * debugging port, since DevTools' own pages are not Playwright pages.
 */
test('the real DevTools loads the devtools page, and $0 reaches the ranking script', async () => {
  const server = http
    .createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<!doctype html><main><button class="btn">Apply coupon</button><button id="show">Show popup</button></main>',
      );
    })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cart`;

  // The site's grant, as a person gives it from the sidebar's Allow button.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'piwi-devtools-profile-'));
  const context = removedOnClose(
    await launchWithEditedManifest((manifest) => ({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }), {
      userDataDir,
      args: ['--auto-open-devtools-for-tabs', '--remote-debugging-port=0'],
    }),
    userDataDir,
  );
  try {
    const page = await context.newPage();
    await page.goto(url);
    const port = readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0];

    let devtoolsPage: CdpTarget | undefined;
    await expect
      .poll(
        async () => {
          const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as CdpTarget[];
          for (const target of targets.filter((t) => t.url.endsWith('/devtools.html'))) {
            const inspected = await evaluateIn(
              target,
              `new Promise((resolve) => chrome.devtools.inspectedWindow.eval('location.href', (href) => resolve(href)))`,
            );
            if (inspected === url) devtoolsPage = target;
          }
          return devtoolsPage?.url ?? null;
        },
        { timeout: 20_000 },
      )
      .toMatch(/^chrome-extension:\/\/[a-p]{32}\/devtools\.html$/);

    await evaluateIn(
      devtoolsPage!,
      `chrome.scripting.executeScript({ target: { tabId: chrome.devtools.inspectedWindow.tabId }, files: ['devtools-rank.js'] })
        .then(() => new Promise((resolve) => chrome.devtools.inspectedWindow.eval('inspect(document.querySelector("button"))', resolve)))`,
    );
    // DevTools moves its selection to the inspected node a moment after `inspect()`.
    let ranking: { status?: string; tag?: string; locators?: { locator: string; verdict: string }[] } = {};
    await expect
      .poll(async () => {
        ranking = (await evaluateIn(
          devtoolsPage!,
          `new Promise((resolve) => chrome.devtools.inspectedWindow.eval('__piwiRankSelected($0)', { useContentScriptContext: true }, (value, error) => resolve(value ?? error)))`,
        )) as typeof ranking;
        return ranking.tag;
      })
      .toBe('button');
    expect(ranking.status).toBe('ranked');
    expect(ranking.locators?.[0]).toMatchObject({
      locator: "getByRole('button', { name: 'Apply coupon' })",
      verdict: 'unique',
    });

    // The Locators tab's path: the content script finds the elements, and Reveal selects one in Elements.
    const found = (await evaluateIn(
      devtoolsPage!,
      `new Promise((resolve) => chrome.devtools.inspectedWindow.eval('__piwiDevtools.query("getByRole(\\'button\\')")', { useContentScriptContext: true }, (value, error) => resolve(value ?? error)))`,
    )) as { ok: boolean; count: number };
    expect(found).toMatchObject({ ok: true, count: 2 });
    await evaluateIn(
      devtoolsPage!,
      `new Promise((resolve) => chrome.devtools.inspectedWindow.eval('__piwiDevtools.mark(1)', { useContentScriptContext: true }, () =>
        chrome.devtools.inspectedWindow.eval(${JSON.stringify(REVEAL_EXPRESSION)}, resolve)))`,
    );
    await expect
      .poll(async () => {
        const selected = (await evaluateIn(
          devtoolsPage!,
          `new Promise((resolve) => chrome.devtools.inspectedWindow.eval('__piwiRankSelected($0)', { useContentScriptContext: true }, (value) => resolve(value)))`,
        )) as { name?: string };
        return selected?.name;
      })
      .toBe('Show popup');
  } finally {
    await context.close();
    server.close();
  }
});
