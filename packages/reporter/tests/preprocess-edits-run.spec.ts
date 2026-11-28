import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYWRIGHT_VERSION, playwrightAtLeast, startServer, withoutCi, type FakeServer } from './_helpers.js';

/**
 * Real Playwright runs through the built package against a stub dashboard, on the edits the reporter's `preprocess`
 * makes to the run (Playwright 1.62 and later): the shards `balanceShards` splits by the dashboard's answer, which
 * every shard reads alike, a serial describe and a file that is not fully parallel kept in one shard, the setup
 * project left to Playwright; the fallback to Playwright's own split; and the tests a pass reuse plan reuses, skipped
 * with the run whose pass stands in for each, sent to the dashboard as none of the run's.
 */

const pkgRoot = path.join(import.meta.dirname, '..');
const dist = path.join(pkgRoot, 'dist', 'index.js');
// Inside the package, so the suite resolves the same @playwright/test as the built reporter.
const project = path.join(pkgRoot, 'tests', `.preprocess-edits-run-${process.pid}`);

const SPECS: Record<string, string> = {
  'tests/setup.spec.ts': `import { test } from '@playwright/test';
test('seeds', () => {});
`,
  'tests/shop.spec.ts': `import { test } from '@playwright/test';
test.describe.serial('checkout', () => {
  test('adds', () => {});
  test('pays', () => {});
});
test('browses', () => {});
test('searches', () => {});
`,
  'tests/account.spec.ts': `import { test } from '@playwright/test';
test.describe.configure({ mode: 'parallel' });
test('logs in', () => {});
test('logs out', () => {});
test('resets', () => {});
test('renames', () => {});
`,
};

/** The tests the chromium project runs, as `title` (setup's run apart). */
const CHROMIUM = ['adds', 'pays', 'browses', 'searches', 'logs in', 'logs out', 'resets', 'renames'];

/** Each test the run ended, as the run's own reporter saw it. */
const DUMP_REPORTER = `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; this.tests = []; }
  onTestEnd(test, result) {
    const project = test.parent.project().name;
    const skip = test.annotations.find((a) => a.type === 'skip');
    this.tests.push({ project, title: test.title, status: result.status, reason: skip ? skip.description ?? null : null });
  }
  onEnd() { fs.writeFileSync(this.file, JSON.stringify(this.tests)); }
};
`;

interface Ended {
  project: string;
  title: string;
  status: string;
  reason: string | null;
}

interface ListedTest {
  project: string;
  file: string;
  title: string;
  group: number;
  skipped?: boolean;
  suitePath?: string[];
}

let server: FakeServer;
/** How the stub answers the split: `group` puts each group in shard `group % total + 1`; `short` leaves a test out. */
let splitAnswer: 'group' | 'short' = 'group';
/** The splits the stub stored, by the body that asked for each: the first answer to a body is every later one's. */
const splits = new Map<string, number[]>();

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  fs.writeFileSync(path.join(project, file), text);
}

function answer(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

let runCount = 0;

/** Run the suite with `args`; the tests each project ended and the run's output. */
async function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ tests: Ended[]; output: string }> {
  const name = `run-${++runCount}`;
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PIWI_') && !(key in extraEnv)) delete env[key];
  }
  withoutCi(env);
  const output = await new Promise<string>((resolve) => {
    execFile(
      process.execPath,
      [
        createRequire(import.meta.url).resolve('@playwright/test/cli'),
        'test',
        '--output',
        `test-results-${name}`,
        ...args,
      ],
      { cwd: project, env: { ...env, DUMP_FILE: `${name}.json` }, timeout: 120_000 },
      (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
    );
  });
  const file = path.join(project, `${name}.json`);
  const tests = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Ended[]) : [];
  return { tests, output };
}

/** The chromium tests a run ran (not skipped), sorted. */
function ran(tests: Ended[]): string[] {
  return tests
    .filter((test) => test.project === 'chromium' && test.status !== 'skipped')
    .map((test) => test.title)
    .sort();
}

/** The requests the stub got to `pathname` since `from`. */
function requestsTo(pathname: string, from: number) {
  return server.requests.slice(from).filter((req) => req.url.split('?')[0] === pathname);
}

describe.skipIf(!playwrightAtLeast('1.62.0'))(`the run preprocess edits (${PLAYWRIGHT_VERSION})`, () => {
  beforeAll(async () => {
    if (!fs.existsSync(dist)) throw new Error(`${dist} is missing: run \`npm run reporter:build\` before this spec`);
    server = await startServer((req, res) => {
      const pathname = req.url.split('?')[0];
      if (pathname === '/api/projects/menu') return answer(res, 200, { items: [{ id: 7, name: 'shop' }] });
      if (pathname === '/api/projects/7/shard-split') {
        const body = JSON.parse(req.body) as { shardTotal: number; tests: ListedTest[] };
        let shards = splits.get(req.body);
        if (!shards) {
          shards = body.tests.map((test) => (test.group % body.shardTotal) + 1);
          if (splitAnswer === 'short') shards.pop();
          splits.set(req.body, shards);
        }
        return answer(res, 200, { shards, durationsMs: [61_000, 2_000], expiresAt: '' });
      }
      if (pathname === '/api/projects/7/run-plans/9') {
        // Test list lines name files from Playwright's rootDir, the config's testDir here.
        const line = '[chromium] › shop.spec.ts › browses';
        return answer(res, 200, {
          id: 9,
          skip: [line],
          reused: [
            { testCaseId: 3, sourceRunId: 41, sourceCommit: 'a'.repeat(40), projects: ['chromium'], skip: [line] },
          ],
        });
      }
      if (pathname.startsWith('/api/projects/7/run-plans/'))
        return answer(res, 404, { message: 'No plan, or it has expired' });
      if (pathname.startsWith('/api/test-runs')) return answer(res, 200, { runId: 1, projectId: 7 });
      return answer(res, 404, {});
    });
    for (const [file, text] of Object.entries(SPECS)) write(file, text);
    write('dump-reporter.cjs', DUMP_REPORTER);
    write(
      'playwright.config.ts',
      `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  workers: 1,
  reporter: [
    [${JSON.stringify(dist)}, {
      serverUrl: ${JSON.stringify(server.url)},
      apiKey: 'pd_test',
      projectName: 'shop',
      streaming: false,
      balanceShards: process.env.BALANCE === '1',
      uploadTraces: false,
      uploadReport: false,
      captureResources: false,
      collectEnvironmentInfo: false,
      uploadManifest: false,
      sampleAriaOnPass: false,
    }],
    ['./dump-reporter.cjs', { outputFile: process.env.DUMP_FILE }],
  ],
  projects: [
    { name: 'setup', testMatch: /setup\\.spec\\.ts/ },
    { name: 'chromium', testIgnore: /setup\\.spec\\.ts/, dependencies: ['setup'] },
  ],
});
`,
    );
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('splits the shards by the dashboard’s answer, the same for each, keeping a group in one shard', async () => {
    splitAnswer = 'group';
    const from = server.requests.length;
    const first = await run(['--shard=1/2'], { BALANCE: '1' });
    const second = await run(['--shard=2/2'], { BALANCE: '1' });
    const asked = requestsTo('/api/projects/7/shard-split', from);
    expect(asked, `${first.output}\n${second.output}`).toHaveLength(2);
    expect(asked[0]!.body).toBe(asked[1]!.body);

    const body = JSON.parse(asked[0]!.body) as { shardTotal: number; tests: ListedTest[] };
    expect(body.shardTotal).toBe(2);
    // The setup project is Playwright's to run, never listed.
    expect(body.tests.every((test) => test.project === 'chromium')).toBe(true);
    const group = (title: string) => body.tests.find((test) => test.title === title)!.group;
    // The serial describe and the file that is not fully parallel are one group each; a parallel file's tests are
    // groups of their own.
    expect(group('adds')).toBe(group('pays'));
    expect(group('adds')).toBe(group('browses'));
    expect(new Set(['logs in', 'logs out', 'resets', 'renames'].map(group)).size).toBe(4);
    expect(body.tests.find((test) => test.title === 'pays')).toMatchObject({
      file: 'tests/shop.spec.ts',
      suitePath: ['checkout'],
    });

    // Each shard ran its tests alone, and together every test once.
    const shardOf = (title: string) =>
      splits.get(asked[0]!.body)![body.tests.findIndex((test) => test.title === title)];
    expect(ran(first.tests)).toEqual(CHROMIUM.filter((title) => shardOf(title) === 1).sort());
    expect(ran(second.tests)).toEqual(CHROMIUM.filter((title) => shardOf(title) === 2).sort());
    expect(first.output).toContain('[Piwi Dashboard] Shard 1/2 runs');
    expect(first.output).toContain('as the dashboard balanced them by recorded duration (about 1 min)');
  }, 120_000);

  it('lets Playwright split the run when the answer does not cover the listed tests', async () => {
    splitAnswer = 'short';
    splits.clear();
    const first = await run(['--shard=1/2'], { BALANCE: '1' });
    const second = await run(['--shard=2/2'], { BALANCE: '1' });
    expect(first.output).toContain('Could not balance the shards');
    expect(first.output).toContain('Playwright splits this run.');
    expect([...ran(first.tests), ...ran(second.tests)].sort()).toEqual([...CHROMIUM].sort());
    splitAnswer = 'group';
  }, 120_000);

  it('stands aside for --last-failed, and asks nothing without the option', async () => {
    const from = server.requests.length;
    const aside = await run(['--shard=1/2', '--last-failed'], { BALANCE: '1' });
    expect(aside.output).toContain('balanceShards stands aside for --last-failed');
    await run(['--shard=1/2']);
    expect(requestsTo('/api/projects/7/shard-split', from)).toEqual([]);
    expect(requestsTo('/api/projects/menu', from)).toEqual([]);
  }, 120_000);

  it('skips the tests a pass reuse plan reuses, which the dashboard gets none of, and claims the plan', async () => {
    const from = server.requests.length;
    const { tests, output } = await run([], { PIWI_PLAN: '9', PIWI_PLAN_SKIP: 'true' });
    expect(
      tests.find((test) => test.title === 'browses'),
      output,
    ).toEqual({
      project: 'chromium',
      title: 'browses',
      status: 'skipped',
      reason: 'passed in run #41',
    });
    expect(ran(tests)).toEqual(CHROMIUM.filter((title) => title !== 'browses').sort());
    expect(output).toContain('Pass reuse plan 9: skipping 1 test');

    const sent = server.requests.slice(from).filter((req) => req.url.startsWith('/api/test-runs'));
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) {
      expect(req.body).not.toContain('browses');
      expect(req.body).toContain('"piwiPlan":{"id":9}');
    }
    expect(sent.some((req) => req.body.includes('searches'))).toBe(true);
  }, 120_000);

  it('balances the shards of a planned run, a reused test weighing nothing and skipped in one shard', async () => {
    splits.clear();
    const from = server.requests.length;
    const env = { BALANCE: '1', PIWI_PLAN: '9', PIWI_PLAN_SKIP: 'true' };
    const first = await run(['--shard=1/2'], env);
    const second = await run(['--shard=2/2'], env);
    const [asked] = requestsTo('/api/projects/7/shard-split', from);
    const listed = JSON.parse(asked!.body) as { tests: ListedTest[] };
    expect(listed.tests.find((test) => test.title === 'browses')).toMatchObject({ skipped: true });
    const skipped = [...first.tests, ...second.tests].filter((test) => test.title === 'browses');
    expect(skipped).toEqual([
      { project: 'chromium', title: 'browses', status: 'skipped', reason: 'passed in run #41' },
    ]);
    expect([...ran(first.tests), ...ran(second.tests)].sort()).toEqual(CHROMIUM.filter((t) => t !== 'browses').sort());
  }, 120_000);

  it('runs every test, the whole suite in a shard, when the plan cannot be read', async () => {
    const { tests, output } = await run(['--shard=1/2'], { PIWI_PLAN: '10', PIWI_PLAN_SKIP: 'true' });
    expect(output).toContain('Could not read pass reuse plan 10');
    expect(output).toContain('the whole suite in this shard (1/2)');
    expect(ran(tests)).toEqual([...CHROMIUM].sort());
  }, 120_000);
});
