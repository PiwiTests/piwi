import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunToHub, type TraceAnswer } from '@piwitests/core/run-channel';
import { withoutCi } from './_helpers.js';

/**
 * Where a worker's running test's trace grows, in a real Playwright run through the built package: a fake editor
 * service on the socket the run names asks each worker for its trace (`trace`), as the hub does for **Open the trace so
 * far**. In a traced test the worker names the attempt's own trace file in the runner's trace folder, of that test and
 * not of the one before it in the worker, a file that grows as the test goes on; in a traced test that opened no context
 * yet it says the trace starts with the first; once its last test ended it says none runs; in a project whose trace is
 * off it says the attempt is not traced.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-trace-${process.pid}`);
const REF = 'ed-7ace7ace';
const TOKEN = 'run-trace-token-0123456789';
const requireHere = createRequire(import.meta.url);

const TRACED_SPEC = `const { test } = require('../fixture.cjs');
test('bare', async () => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
});
test('first', async ({ page }) => {
  await page.setContent('<h1>first</h1>');
});
test('grows', async ({ page }) => {
  await page.setContent('<h1>one</h1>');
  await page.click('h1');
  await page.waitForTimeout(2500);
  await page.setContent('<h1>two</h1><button>Pay</button>');
  await page.click('button');
  await page.waitForTimeout(2500);
});
`;

const PLAIN_SPEC = `const { test } = require('../fixture.cjs');
test('plain', async ({ page }) => {
  await page.setContent('<h1>plain</h1>');
  await page.waitForTimeout(2000);
});
`;

const RESULTS_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) { this.tests.push({ title: test.title, status: result.status }); }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

/** An answer to `trace`, with the size of the file it names as it was answered (null when there is none). */
interface Answered {
  test: string | null;
  answer: TraceAnswer;
  size: number | null;
  link: boolean;
}

let hub: net.Server;
let folder = '';
const heard: RunToHub[] = [];
const answers: Answered[] = [];
const ids: Record<string, string> = {};
const workers: number[] = [];
let tests: Array<{ title: string; status: string }> = [];
let output = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A connection's side of the fake service: it asks for the trace and keeps each answer with its file's size. */
function serve(connection: net.Socket): void {
  let requests = 0;
  /** What this worker said: its requests are numbered on their own. */
  const said: RunToHub[] = [];
  const send = (message: HubToRun) => connection.write(`${JSON.stringify(message)}\n`);
  const askTrace = async (test: string | null): Promise<void> => {
    const request = ++requests;
    send({ type: 'request', request, what: 'trace' });
    for (let i = 0; i < 250; i++) {
      const found = said.find((m) => m.type === 'answer' && m.request === request && m.what === 'trace');
      if (found) {
        const answer = (found as { value: TraceAnswer }).value;
        const stat = answer.ok ? fs.lstatSync(answer.file, { throwIfNoEntry: false }) : undefined;
        answers.push({ test, answer, size: stat?.isFile() ? stat.size : null, link: !!stat?.isSymbolicLink() });
        return;
      }
      await sleep(20);
    }
    throw new Error('no answer');
  };
  connection.setEncoding('utf8');
  connection.on('error', () => connection.destroy());
  connection.on(
    'data',
    lineReader(
      (line) => {
        const message = parseRunToHub(line);
        if (!message) return;
        heard.push(message);
        said.push(message);
        void (async () => {
          if (message.type === 'run-attach') return void workers.push(message.workerIndex);
          // The traced worker's last test ended: it runs none until it ends.
          if (message.type === 'test-end' && message.testId === ids.grows) return askTrace(null);
          if (message.type !== 'test-begin') return;
          const title = message.title[message.title.length - 1]!;
          ids[title] = message.testId;
          if (title === 'grows') {
            await sleep(1200);
            await askTrace(title);
            await sleep(3000);
            return askTrace(title);
          }
          if (title === 'plain' || title === 'bare') {
            await sleep(800);
            return askTrace(title);
          }
        })().catch(() => undefined);
      },
      () => connection.destroy(),
    ),
  );
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-trace-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer(serve);
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));
  write('tests/traced.spec.cjs', TRACED_SPEC);
  write('tests/plain.spec.cjs', PLAIN_SPEC);
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
  timeout: 30000,
  workers: 1,
  reporter: [['./results-reporter.cjs', { outputFile: 'results.json' }]],
  projects: [
    { name: 'traced', testMatch: 'traced.spec.cjs', use: { headless: true, trace: 'on' } },
    { name: 'plain', testMatch: 'plain.spec.cjs', use: { headless: true, trace: 'off' }, dependencies: ['traced'] },
  ],
});
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
  };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_EDITOR_SEND', 'PIWI_RECORD_CHANNEL', 'PIWI_PAUSE_AT']) {
    delete env[name];
  }
  withoutCi(env);
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 120_000 },
      (_error, stdout, stderr) => {
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  const results = path.join(project, 'results.json');
  tests = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [];
}, 150_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

describe('where a worker’s running test’s trace grows', () => {
  it('lets every test pass, and says it answers where the trace grows as it attaches', () => {
    expect(
      tests.map((t) => [t.title, t.status]),
      output,
    ).toEqual([
      ['bare', 'passed'],
      ['first', 'passed'],
      ['grows', 'passed'],
      ['plain', 'passed'],
    ]);
    for (const attach of heard.filter((m) => m.type === 'run-attach')) {
      expect(attach).toMatchObject({ features: expect.arrayContaining(['trace']) });
    }
  });

  it('says no test runs once the worker’s last test ended', () => {
    const after = answers.filter((a) => a.test === null);
    expect(after).toHaveLength(1);
    expect(after[0]!.answer).toEqual({ ok: false, message: 'No test runs on this worker now.' });
  });

  it('names the attempt’s own trace file in the runner’s trace folder, which grows as the test goes on', () => {
    const grows = answers.filter((a) => a.test === 'grows');
    expect(grows, output).toHaveLength(2);
    const [early, later] = grows;
    expect(early!.answer.ok, JSON.stringify(early!.answer)).toBe(true);
    expect(later!.answer.ok).toBe(true);
    const file = (early!.answer as { file: string }).file;
    expect((later!.answer as { file: string }).file).toBe(file);
    expect(path.isAbsolute(file)).toBe(true);
    expect(path.dirname(file)).toBe(
      path.join(project, 'test-results', `.playwright-artifacts-${workers[0]}`, 'traces'),
    );
    // Of this test's attempt, not of the test before it in the worker.
    expect(path.basename(file)).toMatch(new RegExp(`^${ids.grows}(-recording\\d+)?\\.trace$`));
    expect(path.basename(file).startsWith(ids.first!)).toBe(false);
    expect(early!.link).toBe(false);
    expect(early!.size).toBeGreaterThan(0);
    expect(later!.size).toBeGreaterThan(early!.size!);
  });

  it('says a traced test that opened no context yet has written no trace yet', () => {
    const bare = answers.filter((a) => a.test === 'bare');
    expect(bare).toHaveLength(1);
    expect(bare[0]!.answer).toEqual({
      ok: false,
      message: 'This test has written no trace yet: its trace starts with its first browser context.',
    });
  });

  it('says a test whose project traces nothing is not traced', () => {
    const plain = answers.filter((a) => a.test === 'plain');
    expect(plain).toHaveLength(1);
    expect(plain[0]!.answer).toEqual({
      ok: false,
      message: "This test's attempt is not traced: its project's trace option records none of it.",
    });
  });
});
