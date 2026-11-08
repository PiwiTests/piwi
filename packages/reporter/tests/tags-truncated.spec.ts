import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_TEST_TAGS } from '@piwitests/core/test-meta';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { formatTagsTruncated } from '../src/internal/collect/test-meta.js';
import {
  startServer,
  jsonRes,
  textRes,
  fakeConfig,
  fakeSuite,
  fakeTestCase,
  fakeResult,
  PLAYWRIGHT_VERSION,
  type FakeServer,
} from './_helpers.js';

const many = (count: number, prefix = 'SHOP-T') => Array.from({ length: count }, (_, i) => `@${prefix}${i + 1}`);

describe('formatTagsTruncated', () => {
  it('prints nothing when no test lost a tag', () => {
    expect(formatTagsTruncated(null)).toEqual([]);
  });

  it('names each recorded test, how many more there are, and the remedy', () => {
    const lines = formatTagsTruncated({
      tests: 3,
      examples: [
        { filePath: 'tests/cart.spec.ts', suitePath: ['cart'], title: 'pays', line: 4, dropped: 1 },
        { filePath: 'tests/cart.spec.ts', title: 'refunds', dropped: 5 },
      ],
    });
    expect(lines).toEqual([
      `3 tests declare more than ${MAX_TEST_TAGS} tags; Piwi keeps the first ${MAX_TEST_TAGS} of each and drops the rest:`,
      '  tests/cart.spec.ts:4  cart › pays (1 tag dropped)',
      '  tests/cart.spec.ts  refunds (5 tags dropped)',
      '  and 1 more',
      "Playwright lists config and describe tags first and the test's own tag option last: keep config and describe tags few, or put the tags that matter in the test title.",
    ]);
  });
});

describe('tags cut on the wire', () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await server.close();
    server = undefined;
  });

  async function run(
    tests: Array<{ title: string; tags: string[] | null }>,
  ): Promise<{ body: any; warnings: string[] }> {
    let body: any;
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/submit') {
        body = JSON.parse(req.body);
        jsonRes(res, 200, { runId: 1, projectId: 1 });
      } else {
        textRes(res, 404, 'nope');
      }
    });
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => void warnings.push(String(line)));
    const reporter = new PiwiDashboardReporter({
      serverUrl: server.url,
      projectName: 'piwi-tags-truncated-' + process.pid,
      streaming: false,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
    });
    const suite = fakeSuite();
    const cases = tests.map((t, i) => ({
      ...fakeTestCase({ title: t.title, parent: suite, line: i + 1 }),
      id: `t${i}`,
      tags: t.tags ?? [],
    }));
    tests.forEach((t, i) => {
      if (t.tags) return;
      Object.defineProperty(cases[i], 'tags', {
        get() {
          throw new Error('tags are gone');
        },
      });
    });
    suite.allTests = () => cases;
    reporter.onBegin(fakeConfig(), suite);
    for (const test of cases.filter((_, i) => tests[i]!.tags)) {
      reporter.onTestBegin(test, fakeResult({ workerIndex: 0 }));
      reporter.onTestEnd(test, fakeResult({ status: 'passed', duration: 5, workerIndex: 0 }));
    }
    await reporter.onEnd({ status: 'passed' } as any);
    return { body, warnings };
  }

  it('warns once, records the cut tests on the run and sends the first tags', async () => {
    const { body, warnings } = await run([
      { title: 'covers many cases', tags: many(MAX_TEST_TAGS + 3) },
      { title: 'covers one case', tags: ['@SHOP-T1'] },
    ]);
    expect(body.metadata.tagsTruncated).toEqual({
      tests: 1,
      examples: [{ filePath: expect.any(String), title: 'covers many cases', line: 1, dropped: 3 }],
    });
    expect(body.testCases[0].tags).toHaveLength(MAX_TEST_TAGS);
    expect(warnings.filter((line) => line.includes(`more than ${MAX_TEST_TAGS} tags`))).toHaveLength(1);
    expect(warnings.some((line) => line.includes('covers many cases (3 tags dropped)'))).toBe(true);
  });

  it('names the readable tests when a planned test cannot be read', async () => {
    const { body, warnings } = await run([
      { title: 'unreadable', tags: null },
      { title: 'covers many cases', tags: many(MAX_TEST_TAGS + 2) },
    ]);
    expect(body.metadata.tagsTruncated).toEqual({
      tests: 1,
      examples: [{ filePath: expect.any(String), title: 'covers many cases', line: 2, dropped: 2 }],
    });
    expect(warnings.some((line) => line.includes('covers many cases (2 tags dropped)'))).toBe(true);
  });

  it('records nothing and stays quiet when every test fits', async () => {
    const { body, warnings } = await run([{ title: 'fits', tags: many(MAX_TEST_TAGS) }]);
    expect(body.metadata.tagsTruncated).toBeUndefined();
    expect(warnings.filter((line) => line.includes('tags'))).toEqual([]);
  });
});

/**
 * The order of `TestCase.tags` decides which tags the limit cuts. A real Playwright run of a suite with config,
 * describe, title and `tag`-option tags pins it: config tags, then each describe's (its title's @-words, then its
 * `tag` option, outer to inner), then the test title's @-words, then the test's own `tag` option.
 */
describe(`Playwright's tag order (${PLAYWRIGHT_VERSION})`, () => {
  const pkgRoot = path.join(import.meta.dirname, '..');
  const project = path.join(pkgRoot, 'tests', `.tag-order-run-${process.pid}`);
  let tags: string[] | undefined;
  let output = '';

  function write(file: string, text: string): void {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), text);
  }

  beforeAll(async () => {
    write(
      'playwright.config.ts',
      `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  tag: '@config',
  reporter: [['./tags-reporter.cjs', { outputFile: 'tags.json' }]],
});
`,
    );
    write(
      'tags-reporter.cjs',
      `const fs = require('node:fs');
module.exports = class {
  constructor(options) { this.file = options.outputFile; }
  onBegin(config, suite) { fs.writeFileSync(this.file, JSON.stringify(suite.allTests()[0].tags)); }
};
`,
    );
    write(
      'tests/order.spec.ts',
      `import { test } from '@playwright/test';

test.describe('outer @outer-title', { tag: '@outer-option' }, () => {
  test.describe('inner @inner-title', { tag: '@inner-option' }, () => {
    test('covers @test-title', { tag: '@test-option' }, () => {});
  });
});
`,
    );
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.PIWI_DASHBOARD_URL;
    await new Promise<void>((resolve) => {
      execFile(
        process.execPath,
        [createRequire(import.meta.url).resolve('@playwright/test/cli'), 'test', '--list'],
        { cwd: project, env, timeout: 60_000 },
        (_error, stdout, stderr) => {
          output = `${stdout}\n${stderr}`;
          resolve();
        },
      );
    });
    const file = path.join(project, 'tags.json');
    tags = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as string[]) : undefined;
  }, 90_000);

  afterAll(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('lists config, describe (outer to inner), title, then the test tag option', () => {
    expect(tags, output).toEqual([
      '@config',
      '@outer-title',
      '@outer-option',
      '@inner-title',
      '@inner-option',
      '@test-title',
      '@test-option',
    ]);
  });
});
