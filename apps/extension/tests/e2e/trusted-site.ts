import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type BrowserContext, type CDPSession, type Page, type Worker } from '@playwright/test';
import type { RecordedStep, RecordedTarget } from '@piwitests/core/recording';
import type { PiwiSteps } from '@piwitests/core/steps';
import { extensionWorker, launchWithExtension, openOptions } from './fixtures.js';

/**
 * The real extension on a local site, granted the site's origin as a person
 * grants it, for the specs that need what only the real extension has: the
 * background worker's debugging sessions (trusted input, CDP screenshots,
 * request conditions through the `Fetch` domain). Playwright drives the browser
 * through its own debugging connection; `chrome.debugger` attaches beside it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

export interface Fixtures {
  /** The site's origin, `http://127.0.0.1:<port>`; `pages` maps a path to its HTML. */
  site: string;
  pages: Record<string, string>;
  /** How long the site takes to answer a path, in milliseconds. */
  delays: Record<string, number>;
  context: BrowserContext;
  worker: Worker;
  /** An extension page, whose messages reach the worker as the popup's do. */
  control: Page;
}

export const test = base.extend<Fixtures>({
  pages: [{}, { option: true }],
  delays: [{}, { option: true }],
  site: async ({ pages, delays }, use) => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://x');
      const delay = delays[url.pathname];
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname.includes('fail')) response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ total: 40 }));
        return;
      }
      if (url.pathname.includes('missing')) {
        response.statusCode = 404;
        response.end();
        return;
      }
      if (url.pathname.endsWith('.png')) {
        response.setHeader('content-type', 'image/png');
        response.end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            'base64',
          ),
        );
        return;
      }
      if (url.pathname.endsWith('.js')) {
        response.setHeader('content-type', 'text/javascript');
        response.end(`document.documentElement.dataset.script = 'loaded';`);
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(pages[url.pathname] ?? '<!doctype html><title>Empty</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    server.close();
  },
  context: async ({}, use) => {
    const extension = mkdtempSync(path.join(tmpdir(), 'piwi-trusted-ext-'));
    cpSync(DIST, extension, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
    writeFileSync(
      path.join(extension, 'manifest.json'),
      JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }),
    );
    const context = await launchWithExtension(extension);
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    await use(await extensionWorker(context));
  },
  control: async ({ context, worker }, use) => {
    const page = await context.newPage();
    await openOptions(page, new URL(worker.url()).host);
    await use(page);
  },
});

export { expect };

export function target(testId: string, role: string | null = null, name: string | null = null): RecordedTarget {
  return {
    tagName: 'div',
    role,
    accessibleName: name,
    testId,
    text: null,
    alternatives: [{ locator: `getByTestId('${testId}')`, method: 'getByTestId', score: 100 }],
  };
}

export function step(action: RecordedStep['action'], pageUrl: string, extra: Partial<RecordedStep> = {}): RecordedStep {
  return { action, target: null, value: null, redacted: false, pageUrl, timestamp: 0, ...extra };
}

export function expectText(pageUrl: string, testId: string, expected: string): RecordedStep {
  return step('assert', pageUrl, {
    target: target(testId),
    assertion: { matcher: 'toHaveText', expected, actual: null, negated: false, note: null },
  });
}

export function stepsDoc(title: string, origin: string, steps: RecordedStep[]): PiwiSteps {
  return { v: 1, title, origin, recordedAt: 0, note: null, steps };
}

export interface StoredReplay {
  id: string;
  status: string;
  position: number;
  results: Array<{ status: string; detail: string | null; driver?: string }>;
  driver?: { driver: string; reason: string | null } | null;
  viewport?: { width: number; height: number; set: boolean } | null;
  handOver?: { step: number; reason: string } | null;
}

/**
 * Starts a replay on `site` as the popup does, then loads `path` in `page` (by
 * default a new tab), where the registered script runs it.
 */
export async function startReplay(
  control: Page,
  context: BrowserContext,
  site: string,
  doc: PiwiSteps,
  path: string,
  stepMode = false,
  page?: Page,
): Promise<Page> {
  const started = await control.evaluate(
    ({ steps, origin, stepMode }) =>
      chrome.runtime.sendMessage({ type: 'piwi-start-replay', steps, origin, stepMode, inject: false }),
    { steps: doc, origin: site, stepMode },
  );
  expect(started).toEqual({ ok: true });
  page ??= await context.newPage();
  await page.goto(`${site}${path}`);
  return page;
}

export async function replayState(worker: Worker): Promise<StoredReplay> {
  return worker.evaluate(async () => (await chrome.storage.session.get('piwiReplay')).piwiReplay as StoredReplay);
}

export async function finished(worker: Worker, timeout = 45_000): Promise<StoredReplay> {
  await expect.poll(async () => (await replayState(worker))?.status, { timeout }).toMatch(/^(done|stopped)$/);
  return replayState(worker);
}

/** Whether the extension holds a debugging session on the tab: a command goes through only then. */
export async function debuggerAttached(worker: Worker, tabId: number): Promise<boolean> {
  return worker.evaluate(async (id) => {
    try {
      await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.evaluate', { expression: '1' });
      return true;
    } catch {
      return false;
    }
  }, tabId);
}

export async function tabIdOf(worker: Worker, url: string): Promise<number> {
  return worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0]!.id!, url);
}

export interface DomNode {
  backendNodeId: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

/** The first node of the page, closed shadow roots included, that `match` accepts. */
export async function panelNode(page: Page, match: (node: DomNode) => boolean): Promise<number | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    const find = (node: DomNode): number | null => {
      if (match(node)) return node.backendNodeId;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    return find(root);
  } finally {
    await cdp.detach();
  }
}

/** The text of `node` and everything inside it, as `textContent` reads it. */
export function nodeText(node: DomNode): string {
  return (node.nodeValue ?? '') + (node.children ?? []).map(nodeText).join('');
}

async function buttonNode(page: Page, label: string): Promise<number> {
  const backendNodeId = await panelNode(page, (node) => node.nodeName === 'BUTTON' && nodeText(node) === label);
  expect(backendNodeId, `a button reading "${label}"`).not.toBeNull();
  return backendNodeId!;
}

/** The answers of the debugging protocol for a node no longer in the page. */
const GONE = /Could not compute box model|No node with given id|Node is detached/;

/**
 * Runs `use` on the button reading `label`, in the page or one of the extension's closed shadow roots. The
 * extension's panels are drawn again on every change, so the button found can be gone by the time `use` reaches
 * it: `use` then answers null, or the protocol says the node is gone, and the button is found again.
 */
async function withButton<T>(
  page: Page,
  label: string,
  use: (cdp: CDPSession, backendNodeId: number) => Promise<T | null>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const backendNodeId = await buttonNode(page, label);
    const cdp = await page.context().newCDPSession(page);
    try {
      const result = await use(cdp, backendNodeId);
      if (result !== null) return result;
    } catch (error) {
      if (!GONE.test(String(error))) throw error;
    } finally {
      await cdp.detach();
    }
    expect(attempt, `the button reading "${label}" stays laid out on the page long enough to be used`).toBeLessThan(50);
  }
}

/** Runs `action` (on `this`) on the button reading `label`, in the page or one of the extension's closed shadow roots. */
async function callOnButton(page: Page, label: string, action: string): Promise<void> {
  await withButton(page, label, async (cdp, backendNodeId) => {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId!,
      functionDeclaration: `function () { if (!this.isConnected) return false; ${action}; return true; }`,
      returnByValue: true,
    });
    return result.value === true ? true : null;
  });
}

/** Clicks the button reading `label`, in the page or one of the extension's closed shadow roots. */
export function clickInShadow(page: Page, label: string): Promise<void> {
  return callOnButton(page, label, 'this.click()');
}

/** Moves focus to the button reading `label`, as a person tabbing to it does. */
export function focusInShadow(page: Page, label: string): Promise<void> {
  return callOnButton(page, label, 'this.focus()');
}

/** Clicks the button reading `label` with the mouse, as a person does: pressed and released at its middle. */
export async function mouseClickInShadow(page: Page, label: string): Promise<void> {
  const border = await withButton(page, label, async (cdp, backendNodeId) => {
    const { model } = (await cdp.send('DOM.getBoxModel', { backendNodeId })) as { model: { border: number[] } };
    return model.border;
  });
  const [left, top, , , right, bottom] = border as [number, number, number, number, number, number];
  await page.mouse.click((left + right) / 2, (top + bottom) / 2);
}
