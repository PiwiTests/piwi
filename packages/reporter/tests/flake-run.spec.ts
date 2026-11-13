import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flakeErrorSignature, type FlakeResultLine } from '@piwitests/core/flake-plan';
import { startServer, type FakeServer } from './_helpers.js';

/**
 * A real Playwright run in flake mode, through the built package: several
 * workers append to one results file, retries are forced off, the target test
 * gets the arm's delay and its companion gets a line of its own.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
// Inside the package, so the suite resolves the same @playwright/test as the built reporter.
const project = path.join(pkgRoot, 'tests', `.flake-run-${process.pid}`);
const REPEATS = 6;

let server: FakeServer;
let lines: FlakeResultLine[] = [];
let exitCode: number | null = null;
let output = '';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

beforeAll(async () => {
  if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
  server = await startServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>shop</title>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"items":[]}');
  });

  const fixture = `const { test: base, expect } = require('@playwright/test');
const { extendPiwiFixtures } = require(${JSON.stringify(dist)});
exports.test = extendPiwiFixtures(base);
exports.expect = expect;
`;
  write('fixture.cjs', fixture);
  // Its own outputDir: Playwright defaults to the package's test-results/, which every spawned run clears on start.
  write(
    'playwright.config.cjs',
    `const { defineConfig } = require('@playwright/test');
const { wrapConfig } = require(${JSON.stringify(dist)});
module.exports = wrapConfig(defineConfig({ testDir: './tests', outputDir: './test-results', retries: 2, workers: 4, reporter: 'line' }));
`,
  );
  write(
    'tests/checkout.spec.cjs',
    `const { test } = require('../fixture.cjs');
test.describe('checkout', () => {
  test('pays', async ({ page }) => {
    await page.goto(${JSON.stringify(server.url + '/')});
    const ms = await page.evaluate(async () => {
      const start = performance.now();
      await (await fetch('/api/cart')).text();
      return performance.now() - start;
    });
    if (ms > 400) throw new Error('the cart answered too late');
  });
});
`,
  );
  write(
    'tests/admin.spec.cjs',
    `const { test } = require('../fixture.cjs');
test('resets catalog', async ({ page }) => {
  await page.goto(${JSON.stringify(server.url + '/')});
  const ms = await page.evaluate(async () => {
    const start = performance.now();
    await (await fetch('/api/cart')).text();
    return performance.now() - start;
  });
  if (ms >= 800) throw new Error("the companion's cart was delayed");
});
test('unrelated', async () => {});
`,
  );
  const planFile = path.join(project, 'plan.json');
  const resultsFile = path.join(project, 'results.jsonl');
  fs.writeFileSync(
    planFile,
    JSON.stringify({
      version: 1,
      experimentId: 'exp-1',
      test: { file: 'tests/checkout.spec.cjs', title: 'pays', suite: ['checkout'], project: null },
      arm: {
        id: 'delay-cart',
        conditions: [
          { kind: 'delay', route: 'GET /api/cart', ms: 800 },
          { kind: 'alongside', test: { file: 'tests/admin.spec.cjs', title: 'resets catalog' } },
        ],
      },
      errorSignatures: [flakeErrorSignature('Error: the cart answered too late')],
    }),
  );

  const env: NodeJS.ProcessEnv = { ...process.env, PIWI_FLAKE_PLAN: planFile, PIWI_FLAKE_RESULTS: resultsFile };
  delete env.PIWI_DASHBOARD_URL;
  delete env.PIWI_PROBE;
  await new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test', `--repeat-each=${REPEATS}`],
      { cwd: project, env, timeout: 180_000 },
      (error, stdout, stderr) => {
        exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
        output = `${stdout}\n${stderr}`;
        resolve();
      },
    );
  });
  lines = fs.existsSync(resultsFile)
    ? fs
        .readFileSync(resultsFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as FlakeResultLine)
    : [];
}, 200_000);

afterAll(async () => {
  fs.rmSync(project, { recursive: true, force: true });
  await server?.close();
});

describe('a flake-lab run', () => {
  it('fails the target under its delay, once per repeat, with retries off', () => {
    expect(exitCode, output).toBe(1);
    const target = lines.filter((l) => l.role === 'target');
    expect(target).toHaveLength(REPEATS);
    for (const line of target) {
      expect(line).toMatchObject({
        experimentId: 'exp-1',
        armId: 'delay-cart',
        file: 'tests/checkout.spec.cjs',
        title: 'pays',
        status: 'failed',
        matchesHistory: true,
        retry: 0,
        conditions: [
          { kind: 'delay', outcome: 'applied' },
          { kind: 'alongside', outcome: 'by-command' },
        ],
      });
      expect(line.duration).toBeGreaterThanOrEqual(800);
    }
    expect(new Set(target.map((l) => l.repeatEachIndex)).size).toBe(REPEATS);
  });

  it('records the companion with what the lab needs to check the overlap', () => {
    const companion = lines.filter((l) => l.role === 'companion');
    expect(companion).toHaveLength(REPEATS);
    for (const line of companion) {
      expect(line).toMatchObject({ title: 'resets catalog', status: 'passed', conditions: [], errorSignature: null });
      expect(line.startedAt).toBeGreaterThan(0);
      expect(typeof line.workerIndex).toBe('number');
    }
    // Only the target's request is delayed: the companion fails when its own fetch takes the 800 ms delay, and it passed.
  });

  it('writes whole lines from several workers into one file, and none for other tests', () => {
    expect(lines).toHaveLength(REPEATS * 2);
    expect(new Set(lines.map((l) => l.workerIndex)).size).toBeGreaterThan(1);
    expect(lines.some((l) => l.title === 'unrelated')).toBe(false);
  });
});
