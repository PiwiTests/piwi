import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { startServer, type FakeServer } from './_helpers.js';

/**
 * End the test in a real Playwright run, through the built package: a fake editor service on the run channel answers
 * stops with End the test (`control` `end`), and the pause bar's own End the test ends one in a headed page. The
 * page's button tells the server when it is clicked, so a stopped call that never runs is seen not to.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-channel-end-${process.pid}`);
const TIMEOUT_MS = 5000;
const REF = 'ed-0e0d0e0d';
const TOKEN = 'run-channel-end-token-0123456789';
const WINDOWS = process.platform === 'linux' && !!process.env.DISPLAY;

/** A page of the app: its button tells the server it was clicked, and it clicks the pause bar's button `bar` names. */
const PAGE = `<!doctype html><title>a</title><h1>A</h1><button>Go</button>
<script>
const query = new URLSearchParams(location.search);
document.querySelector('button').addEventListener('click', () => fetch('/clicked?from=' + query.get('from')));
new MutationObserver(() => {
  const bar = document.getElementById('__piwi-pause-bar');
  const answer = query.get('bar');
  if (!bar || bar.dataset.seen || !answer) return;
  bar.dataset.seen = '1';
  setTimeout(() => [...bar.querySelectorAll('button')].find((b) => b.textContent === answer).click(), 200);
}).observe(document.documentElement, { childList: true, subtree: true });
</script>`;

/** The specs. `// bp:<name>` marks a line of `PIWI_PAUSE_AT`. */
const HEADLESS_SPEC = (base: string) => `const { test, expect } = require('../fixture.cjs');
test.afterEach(async ({ page }, testInfo) => {
  // Nothing of Piwi is left in the page once the test ended.
  const left = await page.evaluate(() => !!document.getElementById('__piwi-pause-bar') || '__piwiPauseState' in window);
  await fetch('${base}/after-each?title=' + encodeURIComponent(testInfo.title) + '&left=' + left);
});
test('ends at a breakpoint', async ({ page }) => {
  await page.goto('${base}/a?from=breakpoint');
  await page.getByRole('button').click(); // bp:breakpoint
  await fetch('${base}/body?title=ends at a breakpoint');
});
test('after an ended test', async ({ page }) => {
  await page.goto('${base}/a?from=after');
  await page.getByRole('button').click();
});
test('ends at an assertion', async ({ page }) => {
  await page.goto('${base}/a?from=assertion');
  await expect(page.getByRole('heading')).toHaveText('A'); // bp:assertion
  await page.getByRole('button').click();
});
test('ends at a navigation', async ({ page }) => {
  await page.goto('${base}/a?from=navigation'); // bp:navigation
  await page.getByRole('button').click();
});
test('keeps a failure', async ({ page }) => {
  await page.goto('${base}/a?from=failure');
  await expect(page.getByRole('heading')).toHaveText('Not A', { timeout: 300 });
});
test.describe('retried', () => {
  test.describe.configure({ retries: 1 });
  test('retried', async ({ page }, testInfo) => {
    await page.goto('${base}/a?from=retried-' + testInfo.retry);
    if (testInfo.retry === 0) await expect(page.getByRole('heading')).toHaveText('Not A', { timeout: 300 });
    await page.getByRole('button').click(); // bp:retried
  });
});
test.describe('a beforeEach hook', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('${base}/a?from=before-each');
    await page.getByRole('button').click(); // bp:before-each
  });
  test('ends in beforeEach', async () => {
    await fetch('${base}/body?title=ends in beforeEach');
  });
});
test.describe('an afterEach hook', () => {
  test.afterEach(async ({ page }) => {
    await page.getByRole('button').click(); // bp:after-each
  });
  test('ends in afterEach', async ({ page }) => {
    await page.goto('${base}/a?from=after-each');
  });
});
test.describe('a beforeAll hook', () => {
  let shared;
  test.beforeAll(async ({ browser }) => {
    shared = await browser.newPage();
    await shared.goto('${base}/a?from=before-all');
    await shared.getByRole('button').click(); // bp:before-all
  });
  test.afterAll(async () => {
    await shared.close();
  });
  test('after a beforeAll', async () => {});
});
`;

const HEADED_SPEC = (base: string) => `const { test } = require('../fixture.cjs');
test('the bar ends it', async ({ page }) => {
  await page.goto('${base}/a?from=bar&bar=End%20the%20test');
  await page.getByRole('button').click(); // bp:bar
});
test('ends at a page.pause()', async ({ page }) => {
  await page.goto('${base}/a?from=pause');
  await page.pause(); // bp:pause
  await page.getByRole('button').click();
});
`;

/** Each test's result as the run's own reporter writes it, with the annotations of each attempt. */
const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    this.tests.push({ title: test.title, retry: result.retry, status: result.status, annotations: result.annotations ?? [], errors: result.errors.map((e) => e.message) });
  }
  onStdOut(chunk) { process.stdout.write(chunk); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface Result {
  title: string;
  retry: number;
  status: string;
  annotations: Array<{ type: string; description?: string }>;
  errors: string[];
}

interface Connection {
  socket: net.Socket;
  heard: RunToHub[];
  test: string | null;
  retry: number;
}

type Stopped = Extract<RunToHub, { type: 'stopped' }>;

let server: FakeServer;
let hub: net.Server;
let folder = '';
const connections: Connection[] = [];
let results: Result[] = [];
const lines: Record<string, number> = {};
let exitCode: number | null = null;
let output = '';
/** What the page's button was clicked from, the test bodies that went past their stop, and each afterEach's word. */
const clicked: string[] = [];
const bodies: string[] = [];
const afterEach: Record<string, string> = {};

function send(connection: Connection, message: HubToRun): void {
  connection.socket.write(`${JSON.stringify(message)}\n`);
}

/** The editor's answer at each stop: End the test, but where the test is to go on, or the bar answers. */
function onStopped(connection: Connection, stop: Stopped): void {
  const answer = (action: 'end' | 'resume') =>
    void setTimeout(() => send(connection, { type: 'control', action, stop: stop.stop }), 200);
  if (connection.test === 'the bar ends it') return;
  answer(connection.test === 'retried' && stop.reason !== 'failure' ? 'resume' : 'end');
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-end-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((socket) => {
    const connection: Connection = { socket, heard: [], test: null, retry: 0 };
    connections.push(connection);
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (!message) return;
          connection.heard.push(message);
          // This editor shows a held failure.
          if (message.type === 'run-attach') send(connection, { type: 'attached', holds: ['failure'] });
          if (message.type === 'test-begin') {
            connection.test = message.title[message.title.length - 1]!;
            connection.retry = message.retry;
          }
          if (message.type === 'stopped') onStopped(connection, message);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));

  server = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/clicked') clicked.push(url.searchParams.get('from') ?? '');
    else if (url.pathname === '/body') bodies.push(url.searchParams.get('title') ?? '');
    else if (url.pathname === '/after-each') {
      afterEach[url.searchParams.get('title') ?? ''] = url.searchParams.get('left') ?? '';
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    res.end();
  });

  const specs = { headless: HEADLESS_SPEC(server.url), headed: HEADED_SPEC(server.url) };
  for (const [name, spec] of Object.entries(specs)) {
    spec.split('\n').forEach((line, i) => {
      const marker = /\/\/ bp:([\w-]+)$/.exec(line)?.[1];
      if (marker) lines[marker] = i + 1;
    });
    write(`tests/${name}.spec.cjs`, spec);
  }
  write(
    'fixture.cjs',
    `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`,
  );
  write('results-reporter.cjs', RESULTS_REPORTER);
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: ${TIMEOUT_MS},
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  projects: [
    { name: 'headless', testMatch: 'headless.spec.cjs', use: { headless: true } },
    {
      name: 'headed',
      testMatch: 'headed.spec.cjs',
      use: { headless: false, launchOptions: { args: ${WINDOWS ? '[]' : "['--headless=new']"} } },
    },
  ],
});
`,
  );
  const breakpoints = Object.entries(lines).map(
    ([name, line]) => `tests/${name === 'bar' || name === 'pause' ? 'headed' : 'headless'}.spec.cjs:${line}`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
    PIWI_PAUSE_AT: breakpoints.join(';'),
  };
  for (const name of ['CI', 'PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_RECORD_CHANNEL', 'PIWI_EDITOR_SEND']) delete env[name];
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 120_000 },
      (error, stdout, stderr) => {
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const file = path.join(project, 'results.json');
  results = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Result[]) : [];
}, 150_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  for (const connection of connections) connection.socket.destroy();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

function result(title: string, retry = 0): Result {
  const found = results.find((r) => r.title === title && r.retry === retry);
  if (!found) throw new Error(`no result for "${title}" (retry ${retry}):\n${output}`);
  return found;
}

/** What the workers said while a test's attempt ran. */
function heardIn(title: string, retry = 0): RunToHub[] {
  for (const connection of connections) {
    const begin = connection.heard.findIndex(
      (m) => m.type === 'test-begin' && m.title[m.title.length - 1] === title && m.retry === retry,
    );
    if (begin < 0) continue;
    const end = connection.heard.findIndex((m, i) => i > begin && m.type === 'test-end');
    return connection.heard.slice(begin, end < 0 ? undefined : end + 1);
  }
  throw new Error(`no worker ran "${title}":\n${output}`);
}

const stopsIn = (title: string, retry = 0) =>
  heardIn(title, retry).filter((m): m is Stopped => m.type === 'stopped');
const noticesIn = (title: string) =>
  heardIn(title).flatMap((m) => (m.type === 'notice' ? [m.message] : []));
const skippedFromPiwi = (r: Result) =>
  r.status === 'skipped' && r.annotations.some((a) => a.type === 'skip' && a.description === 'Ended from Piwi');

describe('End the test', () => {
  it('runs every test to the result End gives it', () => {
    expect(exitCode, output).toBe(1);
    expect(results.map((r) => [r.title, r.retry, r.status])).toEqual([
      ['ends at a breakpoint', 0, 'skipped'],
      ['after an ended test', 0, 'passed'],
      ['ends at an assertion', 0, 'skipped'],
      ['ends at a navigation', 0, 'skipped'],
      ['keeps a failure', 0, 'failed'],
      ['retried', 0, 'failed'],
      ['retried', 1, 'passed'],
      ['ends in beforeEach', 0, 'skipped'],
      ['ends in afterEach', 0, 'passed'],
      ['after a beforeAll', 0, 'passed'],
      ['the bar ends it', 0, 'skipped'],
      ['ends at a page.pause()', 0, 'skipped'],
    ]);
  });

  it('skips a test stopped at a locator call with Piwi’s reason, and never runs the call', () => {
    for (const title of ['ends at a breakpoint', 'ends at an assertion', 'ends in beforeEach', 'the bar ends it']) {
      expect(skippedFromPiwi(result(title)), title).toBe(true);
      expect(result(title).errors, title).toEqual([]);
    }
    expect(stopsIn('ends at a breakpoint').map((s) => [s.reason, s.place.line])).toEqual([
      ['breakpoint', lines.breakpoint],
    ]);
    expect(clicked).not.toContain('breakpoint');
    expect(clicked).not.toContain('assertion');
    expect(clicked).not.toContain('before-each');
    expect(clicked).not.toContain('bar');
    // Nothing after the stop ran: the body after a stopped call, a beforeEach's test.
    expect(bodies).toEqual([]);
    expect(output).toContain(`[piwi] Ended the test at tests/headless.spec.cjs:${lines.breakpoint}: Click`);
  });

  it('ends a test at its page.pause(), nothing after it run', () => {
    expect(stopsIn('ends at a page.pause()').map((s) => s.reason)).toEqual(['page-pause']);
    expect(skippedFromPiwi(result('ends at a page.pause()'))).toBe(true);
    expect(clicked).not.toContain('pause');
  });

  it('runs a navigation first, and skips the test at its next locator call', () => {
    expect(stopsIn('ends at a navigation').map((s) => s.title)).toEqual([expect.stringMatching(/^Navigate/)]);
    expect(skippedFromPiwi(result('ends at a navigation'))).toBe(true);
    expect(clicked).not.toContain('navigation');
    expect(noticesIn('ends at a navigation')).toEqual([
      expect.stringMatching(/runs before the test ends: Piwi holds no locator call there/),
    ]);
  });

  it('lets a held failure end as it failed, and the next attempt run on its own', () => {
    for (const title of ['keeps a failure', 'retried']) {
      const stops = stopsIn(title);
      expect(stops.map((s) => s.reason), title).toEqual(['failure']);
      expect(result(title).annotations.some((a) => a.type === 'skip'), title).toBe(false);
      expect(result(title).errors.join('\n'), title).toMatch(/toHaveText/);
    }
    // The second attempt stops at its breakpoint, is resumed and clicks.
    expect(stopsIn('retried', 1).map((s) => [s.reason, s.place.line])).toEqual([['breakpoint', lines.retried]]);
    expect(clicked).toContain('retried-1');
  });

  it('lets a test go on once its function ended, saying so, and stops in no beforeAll hook', () => {
    expect(stopsIn('ends in afterEach').map((s) => s.place.line)).toEqual([lines['after-each']]);
    expect(noticesIn('ends in afterEach')).toEqual([
      `The test function already ended: End the test at tests/headless.spec.cjs:${lines['after-each']} lets it end as it is.`,
    ]);
    expect(clicked).toContain('after-each');
    for (const connection of connections) {
      expect(connection.heard.filter((m) => m.type === 'stopped' && m.place.line === lines['before-all'])).toEqual([]);
    }
    expect(clicked).toContain('before-all');
  });

  it('leaves the next test alone, and nothing of Piwi in the page', () => {
    expect(stopsIn('after an ended test')).toEqual([]);
    expect(clicked).toContain('after');
    for (const [title, left] of Object.entries(afterEach)) expect(left, title).toBe('false');
    expect(Object.keys(afterEach)).toContain('ends at a breakpoint');
    expect(Object.keys(afterEach)).toContain('ends in beforeEach');
  });
});
