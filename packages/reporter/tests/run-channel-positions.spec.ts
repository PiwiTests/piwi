import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import { startServer, type FakeServer, withoutCi } from './_helpers.js';

/**
 * Where each call of the running test begins, as an editor that watches no lane hears it: in a real Playwright run
 * through the built package, a fake editor service asks for the positions and nothing else, and each position names
 * its call as the runner's step does (`Click getByRole('link', { name: 'Cart' })`), the text a fill types and what
 * the attempt typed into a secret field hidden.
 * Headless Chromium.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
const project = path.join(pkgRoot, 'tests', `.run-positions-${process.pid}`);
const REF = 'ed-5c1e0a51';
const TOKEN = 'run-positions-token-0123456789';
const TYPED = 'coupon-WELCOME10';
const PASSWORD = 'hunter2-secret-value';
const requireHere = createRequire(import.meta.url);

const PAGE = `<!doctype html><meta charset="utf-8"><title>Shop</title>
<a href="#cart">Cart</a>
<label>Coupon <input id="coupon"></label>
<label>Password <input type="password" id="pw"></label>`;

/** Each call waits past the positions' pace before the next begins, so each is told on its own. */
const SPEC = (base: string) => `const { test } = require('../fixture.cjs');
const pause = () => new Promise((resolve) => setTimeout(resolve, 600));
test('names its calls', async ({ page }) => {
  await page.goto('${base}/shop');
  await pause();
  await page.getByRole('link', { name: 'Cart' }).click();
  await pause();
  await page.getByLabel('Coupon').fill('${TYPED}');
  await pause();
  await page.getByLabel('Password').fill('${PASSWORD}');
  await pause();
  await page.getByText('${PASSWORD}').count();
  await pause();
});
`;

let server: FakeServer;
let hub: net.Server;
let folder = '';
const heard: RunToHub[] = [];
let exitCode: number | null = null;
let output = '';

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-positions-'));
  const socketPath = path.join(folder, 'channel.sock');
  hub = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    let first = true;
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (!message) return;
          if (first) {
            first = false;
            socket.write(`${JSON.stringify({ type: 'positions', on: true } satisfies HubToRun)}\n`);
          }
          heard.push(message);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => hub.listen(socketPath, resolve));
  server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  fs.mkdirSync(path.join(project, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tests', 'positions.spec.cjs'), SPEC(server.url));
  fs.writeFileSync(
    path.join(project, 'fixture.cjs'),
    `const { test: base } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
`,
  );
  fs.writeFileSync(
    path.join(project, 'playwright.config.cjs'),
    `module.exports = { testDir: './tests', outputDir: './test-results', timeout: 15000, workers: 1,
  reporter: 'line', use: { headless: true } };
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }),
    PIWI_ORIGIN: 'editor',
    PIWI_ORIGIN_REF: REF,
  };
  for (const name of ['PWDEBUG', 'PIWI_DASHBOARD_URL', 'PIWI_EDITOR_SEND', 'PIWI_RECORD_CHANNEL']) delete env[name];
  withoutCi(env);
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [requireHere.resolve('@playwright/test/cli'), 'test'],
      { cwd: project, env, timeout: 90_000 },
      (error, stdout, stderr) => {
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
}, 120_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  await new Promise<void>((resolve) => hub?.close(() => resolve()));
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  await server?.close();
});

describe('the positions of an unwatched lane', () => {
  it('name each call as the runner’s step does, never by its internal selector', () => {
    expect(exitCode, output).toBe(0);
    const positions = heard.filter((m): m is Extract<RunToHub, { type: 'position' }> => m.type === 'position');
    const titles = positions.map((p) => p.title);
    expect(titles).toContain("Click getByRole('link', { name: 'Cart' })");
    expect(
      titles.some((t) => /^Fill ".*" getByLabel\('Coupon'\)$/.test(t)),
      titles.join('\n'),
    ).toBe(true);
    expect(titles.join('\n')).not.toMatch(/internal:|locator\.click|locator\.fill/);
    expect(titles.join('\n')).not.toContain(TYPED);
    expect(
      titles.some((t) => /count getByText\(/i.test(t)),
      titles.join('\n'),
    ).toBe(true);
    expect(titles.join('\n')).not.toContain(PASSWORD);
    expect(positions.find((p) => p.title.startsWith('Click'))?.place).toMatchObject({
      file: 'tests/positions.spec.cjs',
      line: 6,
    });
  });
});
