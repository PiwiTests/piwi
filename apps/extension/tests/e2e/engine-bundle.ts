import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from '@playwright/test';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.join(here, '..', '..');

let bundle: Promise<string> | null = null;

/**
 * The locator engine built into one classic script, the same IIFE shape the
 * extension's content scripts are built in, exposing `__piwiEngineQueryAll`
 * (see `engine-entry.ts`). Built once per test process.
 */
export function engineBundle(): Promise<string> {
  bundle ??= (async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'piwi-engine-'));
    process.once('exit', () => rmSync(outDir, { recursive: true, force: true }));
    await build({
      root: extensionRoot,
      configFile: false,
      logLevel: 'warn',
      build: {
        outDir,
        emptyOutDir: false,
        lib: {
          entry: path.join(here, 'engine-entry.ts'),
          formats: ['iife'],
          name: 'PiwiEngineTest',
          fileName: () => 'engine.js',
        },
        rollupOptions: { output: { extend: true } },
      },
    });
    return path.join(outDir, 'engine.js');
  })();
  return bundle;
}

export const PAGES_DIR = path.join(here, 'pages');

/** Serves `tests/e2e/pages/*` from a real origin, so same-origin frames can be read. */
export async function servePages(page: Page, origin: string, pages: Record<string, string> = {}): Promise<void> {
  const { readFileSync } = await import('node:fs');
  await page.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname.replace(/^\//, '');
    const inline = pages[pathname];
    if (inline !== undefined) {
      await route.fulfill({ contentType: 'text/html', body: inline });
      return;
    }
    try {
      const body = readFileSync(path.join(PAGES_DIR, pathname || 'index.html'), 'utf8');
      await route.fulfill({ contentType: 'text/html', body });
    } catch {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
}

/** Tags every element of every frame (open shadow roots included) with a unique `data-eid`, to compare results by identity. */
export async function tagElements(page: Page): Promise<void> {
  const frames: Frame[] = page.frames();
  for (const [i, frame] of frames.entries()) {
    await frame.evaluate((prefix) => {
      let n = 0;
      const visit = (root: Document | ShadowRoot) => {
        for (const element of Array.from(root.querySelectorAll('*'))) {
          element.setAttribute('data-eid', `${prefix}${n++}`);
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      visit(document);
    }, `f${i}-`);
  }
}
