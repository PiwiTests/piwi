import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { piwiFixtures } from '../src/internal/capture/capture-fixtures.js';
import { ATTACHMENT_NAMES } from '../src/internal/capture/attachments.js';
import { resetCodeReachCaches } from '../src/internal/capture/code-reach.js';

const [captureFixture] = piwiFixtures.piwiCapture as unknown as [
  (args: object, use: () => Promise<void>, info: unknown) => Promise<void>,
];
const pageFixture = piwiFixtures.page as unknown as (
  args: { page: unknown },
  use: (page: unknown) => Promise<void>,
) => Promise<void>;
const [browserFixture] = piwiFixtures.browser as unknown as [
  (args: { browser: Browser }, use: (browser: Browser) => Promise<void>) => Promise<void>,
];

const ENV_KEYS = ['PIWI_CAPTURE_CODE_REACH', 'PIWI_CAPTURE_LOCATORS', 'PIWI_CODE_REACH_ROOTS', 'PIWI_COVERAGE_BROWSER'];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

let dir = '';

beforeAll(() => {
  process.env.PIWI_CAPTURE_CODE_REACH = 'true';
  process.env.PIWI_CAPTURE_LOCATORS = 'false';
  delete process.env.PIWI_CODE_REACH_ROOTS;
  delete process.env.PIWI_COVERAGE_BROWSER;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-reach-fixtures-')));
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Run `body` as one test through the capture fixtures; the files its code reach attachment names, or null. */
async function captureTest(body: () => Promise<void>): Promise<string[] | null> {
  resetCodeReachCaches();
  const testInfo = {
    status: 'passed',
    annotations: [],
    config: { configFile: path.join(dir, 'playwright.config.ts'), rootDir: dir },
    attach: vi.fn(async (_name: string, _attachment: { body: Buffer }) => {}),
  };
  await captureFixture({}, body, testInfo);
  const call = testInfo.attach.mock.calls.find(([name]) => name === ATTACHMENT_NAMES.codeReach);
  return call ? (JSON.parse(String(call[1].body)) as string[]) : null;
}

describe('on the pages already open as a test starts', () => {
  /** A Chromium page whose CDP session answers as `session` does; `starts` counts the sessions asked for. */
  interface FakePage {
    page: object;
    starts: () => number;
    closed: boolean;
    close: () => void;
  }

  const fakes: FakePage[] = [];

  function fakePage(session: () => Promise<never>): FakePage {
    const onClose: Array<() => void> = [];
    const context = {
      browser: () => ({ browserType: () => ({ name: () => 'chromium' }) }),
      newCDPSession: vi.fn(session),
      newPage: async () => {
        throw new Error('not used');
      },
      on: () => {},
    };
    const fake: FakePage = {
      page: {
        on: () => {},
        once: (event: string, handler: () => void) => {
          if (event === 'close') onClose.push(handler);
        },
        isClosed: () => fake.closed,
        context: () => context,
        url: () => 'about:blank',
      },
      starts: () => context.newCDPSession.mock.calls.length,
      closed: false,
      close: () => {
        fake.closed = true;
        for (const handler of onClose.splice(0)) handler();
      },
    };
    fakes.push(fake);
    return fake;
  }

  /** Hand the page out through the `page` fixture, as a hook or an earlier test would. */
  const open = (fake: FakePage) => pageFixture({ page: fake.page }, async () => {});

  const refused = () => Promise.reject(new Error('no session'));

  afterEach(() => {
    for (const fake of fakes.splice(0)) fake.close();
  });

  it('starts 16 of them at most, closed pages not counted, and always a page the test opens', async () => {
    const closed = [fakePage(refused), fakePage(refused)];
    const already = Array.from({ length: 18 }, () => fakePage(refused));
    for (const fake of [...closed, ...already]) await open(fake);
    // Closed, but their `close` event not seen yet.
    for (const fake of closed) fake.closed = true;
    const opened = fakePage(refused);
    await captureTest(async () => {
      await open(opened);
    });
    expect(closed.map((fake) => fake.starts())).toEqual([0, 0]);
    expect(already.map((fake) => fake.starts())).toEqual([...Array<number>(16).fill(1), 0, 0]);
    expect(opened.starts()).toBe(1);
    // The next test counts afresh: the pages the last test recorded on hold no place.
    await captureTest(async () => {});
    expect(already.map((fake) => fake.starts())).toEqual([...Array<number>(16).fill(2), 0, 0]);
  });

  it('waits 2 s at most for their coverage to start', async () => {
    let release: ((error: Error) => void) | undefined;
    const hung = fakePage(
      () =>
        new Promise<never>((_resolve, reject) => {
          release = reject;
        }),
    );
    await open(hung);
    const began = Date.now();
    let waited = -1;
    await captureTest(async () => {
      waited = Date.now() - began;
      release?.(new Error('gone'));
    });
    expect(hung.starts()).toBe(1);
    expect(waited).toBeGreaterThanOrEqual(1900);
    expect(waited).toBeLessThan(4000);
  }, 10_000);
});

describe('in Chromium', () => {
  let browser: Browser | null = null;
  let server: http.Server;
  let url = '';

  function write(file: string, text: string): void {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }

  beforeAll(async () => {
    write('index.html', '<button id="pay">Pay</button><script type="module" src="/src/main.js"></script>');
    write(
      'src/main.js',
      "import { pay } from './pay.js';\ndocument.querySelector('#pay').addEventListener('click', () => pay());\n",
    );
    write('src/pay.js', "export function pay() {\n  document.body.dataset.paid = 'yes';\n}\n");
    for (const name of ['other', 'third']) {
      write(`${name}.html`, `<script type="module" src="/src/${name}.js"></script>`);
      write(`src/${name}.js`, `function ${name}() {\n  document.body.dataset.ran = '${name}';\n}\n${name}();\n`);
    }
    // A bundle whose source map answers 500 ms late.
    write('mapped.html', '<body><script src="/dist/mapped.js"></script></body>');
    const mapped = "function mapped() {\n  document.body.dataset.ran = 'mapped';\n}\nmapped();\n";
    write('src/mapped.js', mapped);
    write('dist/mapped.js', `${mapped}//# sourceMappingURL=/slow/mapped.js.map\n`);
    write(
      'slow/mapped.js.map',
      JSON.stringify({ version: 3, sources: ['../src/mapped.js'], mappings: 'AAAA;AACA;AACA;AACA' }),
    );
    server = http.createServer(async (req, res) => {
      const pathname = (req.url ?? '/').split('?')[0]!;
      if (pathname.startsWith('/slow/')) await new Promise((resolve) => setTimeout(resolve, 500));
      const file = path.join(dir, pathname === '/' ? 'index.html' : pathname);
      if (!fs.existsSync(file)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      browser = await chromium.launch();
    } catch {
      browser = null;
    }
    // The worker fixture patches the browser: every page it opens is instrumented.
    if (browser) await browserFixture({ browser }, async () => {});
  });

  afterEach(async () => {
    for (const context of browser?.contexts() ?? []) await context.close().catch(() => {});
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function pay(page: Page): Promise<void> {
    await page.click('#pay');
    await page.waitForFunction("document.body.dataset.paid === 'yes'");
  }

  async function run(page: Page, name: string): Promise<void> {
    await page.goto(`${url}${name}.html`);
    await page.waitForFunction(`document.body.dataset.ran === '${name}'`);
  }

  /** Close a page as Playwright does, without going through the capture's own `close`. */
  function closeBehindCapture(page: Page): Promise<void> {
    return (Object.getPrototypeOf(page) as Page).close.call(page);
  }

  it('records every page: one open as the test starts, and each the test opens', async (ctx) => {
    if (!browser) return ctx.skip();
    const before = await browser.newPage();
    await before.goto(url);
    const files = await captureTest(async () => {
      const first = await browser!.newPage();
      const second = await browser!.newPage();
      await run(first, 'other');
      await run(second, 'third');
      await pay(before);
    });
    expect(files).toEqual(['src/main.js', 'src/other.js', 'src/pay.js', 'src/third.js']);
  });

  it('keeps what a page closed during the test, or the pages of a closed context, ran; the others record on', async (ctx) => {
    if (!browser) return ctx.skip();
    const files = await captureTest(async () => {
      const kept = await browser!.newPage();
      await kept.goto(url);
      const closing = await browser!.newPage();
      await run(closing, 'other');
      await closing.close();
      const context = await browser!.newContext();
      await run(await context.newPage(), 'third');
      await context.close();
      await pay(kept);
    });
    expect(files).toEqual(['src/main.js', 'src/other.js', 'src/pay.js', 'src/third.js']);
  });

  it('keeps the other pages when a page or its context closes before or as the coverage stops', async (ctx) => {
    if (!browser) return ctx.skip();
    const closing: Array<Promise<void>> = [];
    const files = await captureTest(async () => {
      const kept = await browser!.newPage();
      await kept.goto(url);
      await pay(kept);
      const gone = await browser!.newPage();
      await run(gone, 'other');
      await closeBehindCapture(gone);
      const going = await browser!.newPage();
      await run(going, 'third');
      const context = await browser!.newContext();
      await run(await context.newPage(), 'other');
      closing.push(closeBehindCapture(going), context.close());
    });
    await Promise.all(closing);
    expect(files).toEqual(expect.arrayContaining(['src/main.js', 'src/pay.js']));
  });

  it('waits for the pages of a context still closing as the test ends to resolve', async (ctx) => {
    if (!browser) return ctx.skip();
    let closing: Promise<void> = Promise.resolve();
    const files = await captureTest(async () => {
      const context = await browser!.newContext();
      await run(await context.newPage(), 'mapped');
      closing = context.close();
      // The test ends while the context's page still fetches its source map.
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await closing;
    expect(files).toEqual(['src/mapped.js']);
  });
});
