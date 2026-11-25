import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYWRIGHT_VERSION, playwrightAtLeast } from './_helpers.js';

/**
 * A real Playwright run (`--list`, so no test runs) through the metadata collector's source: the suite modes its
 * reporter reads in `preprocess` (`testRun.mode`, Playwright 1.65 and later) are read back for the suites `onBegin`
 * hands over, and on every Playwright, from the private field where Playwright gives no mode, each describe records the
 * mode it runs its tests in.
 */
describe(`the suite modes of a real run (${PLAYWRIGHT_VERSION})`, () => {
  const pkgRoot = path.join(import.meta.dirname, '..');
  const project = path.join(pkgRoot, 'tests', `.suite-modes-run-${process.pid}`);
  let result:
    | {
        preprocessed: boolean;
        tests: Array<{ project: string; title: string; modes: string[]; marked: string[]; group: string }>;
      }
    | undefined;
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
  reporter: [['./modes-reporter.ts', { outputFile: 'modes.json' }]],
  projects: [{ name: 'plain' }, { name: 'fully', fullyParallel: true }],
});
`,
    );
    write(
      'modes-reporter.ts',
      `import * as fs from 'node:fs';
import { MetadataCollector } from '../../src/internal/collect/metadata-collector.js';

export default class {
  constructor(options) {
    this.file = options.outputFile;
    this.read = new MetadataCollector();
    this.marked = new MetadataCollector();
    this.preprocessed = false;
  }
  async preprocess({ suite, testRun }) {
    this.preprocessed = true;
    this.read.readSuiteModes(suite, testRun);
    // Every suite preprocess sees reads serial here, so a level of a test onBegin hands over that reads serial is one.
    this.marked.readSuiteModes(suite, { mode: () => 'serial' });
  }
  onBegin(config, suite) {
    const tests = suite.allTests().map((test) => ({
      project: test.parent.project().name,
      title: test.title,
      modes: this.read.getSuiteInfo(test).suiteConfig.map((level) => level.mode),
      marked: this.marked.getSuiteInfo(test).suiteConfig.map((level) => level.mode),
      group: this.read.shardGroup(test),
    }));
    fs.writeFileSync(this.file, JSON.stringify({ preprocessed: this.preprocessed, tests }));
  }
}
`,
    );
    write(
      'tests/modes.spec.ts',
      `import { test } from '@playwright/test';

test.describe.serial('outer serial', () => {
  test.describe('inner', () => {
    test('in a serial group', () => {});
  });
});

test.describe('explicit default', () => {
  test.describe.configure({ mode: 'default' });
  test('in order', () => {});
});

test.describe('inherits', () => {
  test('as its project', () => {});
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
    const file = path.join(project, 'modes.json');
    result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  }, 90_000);

  afterAll(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("records each describe's mode: its own, else the one above it, else its project's", () => {
    expect(
      result?.tests.map(({ project: name, title, modes }) => [name, title, modes]),
      output,
    ).toEqual([
      ['plain', 'in a serial group', ['serial', 'serial']],
      ['plain', 'in order', ['default']],
      ['plain', 'as its project', ['default']],
      ['fully', 'in a serial group', ['serial', 'serial']],
      ['fully', 'in order', ['default']],
      ['fully', 'as its project', ['parallel']],
    ]);
  });

  it('groups the tests as Playwright keeps them in one worker: a file not fully parallel, else an ordered describe', () => {
    const groups = (name: string) => result!.tests.filter((test) => test.project === name).map((test) => test.group);
    expect(new Set(groups('plain')).size, output).toBe(1);
    // The serial describe, the describe set to `default` and the test that inherits its project's parallel mode.
    expect(new Set(groups('fully')).size).toBe(3);
    expect(groups('fully')).not.toContain(groups('plain')[0]);
  });

  it.skipIf(!playwrightAtLeast('1.62.0'))('reads them in preprocess, for the suites onBegin hands over', () => {
    expect(result?.preprocessed, output).toBe(true);
    for (const test of result!.tests) expect(test.marked, test.title).toEqual(test.marked.map(() => 'serial'));
  });
});
