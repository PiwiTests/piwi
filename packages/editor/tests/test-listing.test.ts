import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { listWithReporter, ProjectOptionsError } from '../src/recorder/project-options';
import { LIST_TESTS_ENV, type ListedTestLine } from '../src/recorder/use-reporter';
import {
  excludingFilter,
  listTests,
  parseErrorLines,
  parseOnlyNamed,
  parseTestsLine,
  specFilter,
  TestListings,
  type ListRunner,
} from '../src/test-listing';

const NODE_MODULES = path.join(__dirname, '..', '..', '..', 'node_modules');

let dir = '';
let reporter = '';

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-listing-')));
  // The reporter as `editor:build` bundles it: one CommonJS file Playwright loads by its path.
  reporter = path.join(dir, 'piwi-use-reporter.cjs');
  await build({
    entryPoints: [path.join(__dirname, '..', 'src', 'recorder', 'use-reporter.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: reporter,
    logLevel: 'silent',
  });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A project folder that resolves this repository's Playwright, with these files; its config's path. */
function project(name: string, files: Record<string, string>): string {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(NODE_MODULES, path.join(root, 'node_modules'), 'dir');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return path.join(root, 'playwright.config.js');
}

/** The config's own Playwright, as the service runs it for the listing. */
const playwright: ListRunner = (configFile, args) =>
  listWithReporter(configFile, reporter, args, {
    timeoutMs: 60_000,
    doing: 'list the tests',
    env: { [LIST_TESTS_ENV]: '1' },
  });

const listed = (fields: Partial<ListedTestLine>): ListedTestLine => ({
  id: 'id',
  file: 'tests/a.spec.ts',
  line: 3,
  column: 1,
  title: 'pays',
  suites: [],
  project: '',
  tags: [],
  ...fields,
});

const testsLine = (tests: ListedTestLine[]) => `PIWI_TESTS ${JSON.stringify(tests)}\n`;

describe('the reporter’s lines', () => {
  test('name the projects that run only when --project names them, none a project run by default shares', () => {
    const use = (projects: unknown[]) => `PIWI_USE ${JSON.stringify({ rootDir: '/w', projects })}\n`;
    expect(
      parseOnlyNamed(
        use([
          { name: 'chromium', default: true },
          { name: 'slow', default: false },
          { name: 'Shared', default: false },
          { name: 'shared', default: true },
          { name: 'old' },
          { default: false },
        ]),
      ),
    ).toEqual(['slow']);
    expect(parseOnlyNamed('no line\n')).toBeNull();
  });

  test('leaves out a test of a spec outside the config’s folder', () => {
    const outside = [listed({ file: '../tests/a.spec.ts' }), listed({ file: '/repo/tests/a.spec.ts' }), listed({})];
    expect(parseTestsLine(testsLine(outside))).toEqual([listed({})]);
  });

  test('reads the listed tests among Playwright’s output, leaving out one that does not parse', () => {
    const good = listed({ suites: [{ title: 'cart', line: 2 }], tags: ['@smoke'] });
    const output = `Listing tests:\nPIWI_USE {}\n${testsLine([good, { ...good, line: 0 } as ListedTestLine])}Total: 1 test\n`;
    expect(parseTestsLine(output)).toEqual([good]);
    expect(parseTestsLine('PIWI_USE {}\n')).toBeNull();
    expect(parseTestsLine('PIWI_TESTS {"tests":')).toBeNull();
  });

  test('reads each error with the file and the line it names', () => {
    const output = [
      'PIWI_ERROR {"message":"SyntaxError: Missing semicolon. (3:4)","file":"tests/broken.spec.ts","line":3}',
      'PIWI_ERROR {"message":"Error: no file","file":null,"line":null}',
      'PIWI_ERROR {"file":"no message"}',
    ].join('\n');
    expect(parseErrorLines(output)).toEqual([
      { message: 'SyntaxError: Missing semicolon. (3:4)', file: 'tests/broken.spec.ts', line: 3 },
      { message: 'Error: no file', file: null, line: null },
    ]);
  });
});

/** A file filter as Playwright reads it: between slashes as written, else ignoring case. */
const playwrightRegExp = (filter: string) => {
  const between = /^\/(.*)\/([gi]*)$/.exec(filter);
  return between ? new RegExp(between[1]!, between[2]) : new RegExp(filter, 'gi');
};

describe('the file filters', () => {
  const matches = (filter: string, file: string) => playwrightRegExp(filter).test(file);
  const caseSensitive = process.platform !== 'win32' && process.platform !== 'darwin';

  test('one spec: its whole path, either separator, or its file: URL', () => {
    const filter = specFilter('/work', 'my tests/cart.spec.ts');
    expect(matches(filter, '/work/my tests/cart.spec.ts')).toBe(true);
    expect(matches(filter, '\\work\\my tests\\cart.spec.ts')).toBe(true);
    expect(matches(filter, 'file:///work/my%20tests/cart.spec.ts')).toBe(true);
    expect(matches(filter, '/work/sub/my tests/cart.spec.ts')).toBe(false);
    expect(matches(filter, '/work/my tests/my-cart.spec.ts')).toBe(false);
    expect(matches(filter, '/work/my tests/cartXspec.ts')).toBe(false);
    expect(matches(filter, '/work/my tests/cart.spec.tsx')).toBe(false);
    // With the file system's case.
    expect(matches(filter, '/work/my tests/Cart.spec.ts')).toBe(!caseSensitive);
  });

  test('every spec but some, by their whole paths or their file: URLs', () => {
    const filter = excludingFilter('/work', ['tests/broken.spec.ts', 'my tests/a (1).spec.ts']);
    expect(matches(filter, '/work/tests/cart.spec.ts')).toBe(true);
    expect(matches(filter, '/work/tests/broken.spec.ts')).toBe(false);
    expect(matches(filter, '/work/my tests/a (1).spec.ts')).toBe(false);
    expect(matches(filter, 'file:///work/my%20tests/a%20(1).spec.ts')).toBe(false);
    expect(matches(filter, '/work/tests/unbroken.spec.ts')).toBe(true);
    expect(matches(filter, '/work/sub/tests/broken.spec.ts')).toBe(true);
    expect(matches(filter, '/work/tests/Broken.spec.ts')).toBe(caseSensitive);
  });
});

describe('a listing', () => {
  test('lists again without the specs that did not load: Playwright lists none once one fails', async () => {
    const asked: string[][] = [];
    const run: ListRunner = (_config, args) => {
      asked.push(args);
      if (args.length === 1) {
        return Promise.resolve({
          stdout: `${testsLine([])}PIWI_ERROR {"message":"SyntaxError: Unexpected token","file":"tests/broken.spec.ts","line":3}\n`,
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: testsLine([listed({ file: 'tests/cart.spec.ts' })]), stderr: '' });
    };
    const result = await listTests(run, '/work/playwright.config.ts', null);
    expect(result).toEqual({
      tests: [listed({ file: 'tests/cart.spec.ts' })],
      broken: new Map([['tests/broken.spec.ts', 'SyntaxError: Unexpected token (line 3)']]),
      onlyNamed: null,
    });
    // Every project's tests, those with `default: false` too.
    expect(asked).toEqual([['--project=*'], [excludingFilter('/work', ['tests/broken.spec.ts']), '--project=*']]);
  });

  test('says why when Playwright lists nothing at all, or cannot run', async () => {
    const config = '/work/playwright.config.ts';
    const thrown: ListRunner = () => Promise.resolve({ stdout: '', stderr: 'Error: Cannot find module ./setup\n' });
    expect(await listTests(thrown, config, null)).toEqual({
      error: 'Playwright could not list the tests of playwright.config.ts: Error: Cannot find module ./setup.',
    });
    const missing: ListRunner = () =>
      Promise.reject(
        new ProjectOptionsError('playwright-missing', 'Playwright is not installed in /work: run npm install there.'),
      );
    expect(await listTests(missing, config, null)).toEqual({
      error: 'Playwright is not installed in /work: run npm install there.',
    });
  });

  test('says why when a file every spec reads does not load', async () => {
    const helper = `${testsLine([])}PIWI_ERROR {"message":"ReferenceError: x is not defined","file":"tests/helpers.ts","line":2}\n`;
    const run: ListRunner = () => Promise.resolve({ stdout: helper, stderr: '' });
    expect(await listTests(run, '/work/playwright.config.ts', null)).toEqual({
      error: 'Playwright could not list the tests of playwright.config.ts: ReferenceError: x is not defined.',
    });
  });

  test('lists a config’s tests with its own Playwright, once per project, a spec that does not load apart', async () => {
    const config = project('real', {
      'playwright.config.js':
        "module.exports = { testDir: 'tests', projects: [{ name: 'chromium' }, { name: 'firefox' }] };\n",
      'tests/cart.spec.js': [
        "const { test } = require('@playwright/test');",
        'for (const n of [1, 2]) test(`adds mug ${n}`, async () => {});',
        "test.describe('checkout', () => {",
        "  test('pays', { tag: '@smoke' }, async () => {});",
        '});',
        '',
      ].join('\n'),
      'tests/broken.spec.js':
        "const { test } = require('@playwright/test');\ntest('ok', async () => {});\nthis is not js\n",
      'tests/old/tests/cart.spec.js': 'this is not js\n',
    });
    const result = await listTests(playwright, config, null);
    if ('error' in result) throw new Error(result.error);
    expect([...result.broken.keys()].sort()).toEqual(['tests/broken.spec.js', 'tests/old/tests/cart.spec.js']);
    expect(result.broken.get('tests/broken.spec.js')).toMatch(/\(line 3\)$/);
    const seen = result.tests.map((t) => [t.project, t.file, t.line, t.suites, t.title, t.tags]);
    expect(seen).toEqual(
      expect.arrayContaining([
        ['chromium', 'tests/cart.spec.js', 2, [], 'adds mug 1', []],
        ['chromium', 'tests/cart.spec.js', 2, [], 'adds mug 2', []],
        ['chromium', 'tests/cart.spec.js', 4, [{ title: 'checkout', line: 3 }], 'pays', ['@smoke']],
        ['firefox', 'tests/cart.spec.js', 4, [{ title: 'checkout', line: 3 }], 'pays', ['@smoke']],
      ]),
    );
    expect(result.tests).toHaveLength(6);
    expect(new Set(result.tests.map((t) => t.id)).size).toBe(6);
    // One spec alone, though a spec whose path ends as its own does not load.
    const one = await listTests(playwright, config, ['tests/cart.spec.js']);
    expect('tests' in one && one.tests.length).toBe(6);
  }, 120_000);

  test('lists a config whose projects none matches without --project, as it lists nothing', async () => {
    const asked: string[][] = [];
    const run: ListRunner = (_config, args) => {
      asked.push(args);
      return Promise.resolve(
        args.includes('--project=*')
          ? { stdout: '', stderr: 'Error: No projects matched. Available projects: \n    at filterProjects\n' }
          : { stdout: `PIWI_USE {"rootDir":"/work","projects":[]}\n${testsLine([])}`, stderr: '' },
      );
    };
    expect(await listTests(run, '/work/playwright.config.ts', null)).toEqual({
      tests: [],
      broken: new Map(),
      onlyNamed: [],
    });
    expect(asked).toEqual([['--project=*'], []]);
  });

  test('lists the tests of a project with default: false, and names it, with its own Playwright', async () => {
    const config = project('named', {
      'playwright.config.js': [
        'module.exports = {',
        "  testDir: 'tests',",
        '  projects: [',
        "    { name: 'chromium', testIgnore: /slow/ },",
        "    { name: 'slow', testMatch: /slow/, default: false },",
        "    { name: 'nightly', default: false },",
        '  ],',
        '};',
        '',
      ].join('\n'),
      'tests/cart.spec.js': "const { test } = require('@playwright/test');\ntest('adds', async () => {});\n",
      'tests/slow.spec.js': "const { test } = require('@playwright/test');\ntest('waits', async () => {});\n",
    });
    const result = await listTests(playwright, config, null);
    if ('error' in result) throw new Error(result.error);
    expect(result.tests.map((t) => `${t.project} ${t.file} ${t.title}`).sort()).toEqual([
      'chromium tests/cart.spec.js adds',
      'nightly tests/cart.spec.js adds',
      'nightly tests/slow.spec.js waits',
      'slow tests/slow.spec.js waits',
    ]);
    expect(result.onlyNamed?.sort()).toEqual(['nightly', 'slow']);
    // A config with no project lists nothing, and says nothing failed.
    const empty = project('no-projects', {
      'playwright.config.js': "module.exports = { testDir: 'tests', projects: [] };\n",
      'tests/cart.spec.js': "const { test } = require('@playwright/test');\ntest('adds', async () => {});\n",
    });
    expect(await listTests(playwright, empty, null)).toEqual({ tests: [], broken: new Map(), onlyNamed: [] });
  }, 120_000);
});

describe('each config’s listing', () => {
  /** A runner that answers each call when asked to, with the tests of the specs it was given (or all). */
  function held(all: ListedTestLine[]) {
    const calls: Array<{ args: string[]; answer: () => void }> = [];
    const run: ListRunner = (_config, args) =>
      new Promise((resolve) => {
        const filters = args.filter((a) => a !== '--project=*');
        const tests = filters.length
          ? all.filter((t) => filters.some((a) => playwrightRegExp(a).test(`/w/${t.file}`)))
          : all;
        calls.push({ args, answer: () => resolve({ stdout: testsLine(tests), stderr: '' }) });
      });
    return { calls, run };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('runs one listing at a time per config, and what is asked meanwhile after it, merged', async () => {
    const tests = [listed({ file: 'tests/a.spec.ts', id: 'a' }), listed({ file: 'tests/b.spec.ts', id: 'b' })];
    const { calls, run } = held(tests);
    const changed: string[] = [];
    const listings = new TestListings(
      run,
      (root) => changed.push(root),
      () => 'same',
    );
    listings.listAll('/w', '/w/playwright.config.ts');
    expect(listings.state('/w')).toEqual({ listing: null, error: null, running: true });
    listings.listSpecs('/w', ['tests/a.spec.ts']);
    listings.listSpecs('/w', ['tests/b.spec.ts']);
    expect(calls).toHaveLength(1);
    calls[0]!.answer();
    await settle();
    expect([...listings.state('/w')!.listing!.specs.keys()]).toEqual(['tests/a.spec.ts', 'tests/b.spec.ts']);
    expect(changed).toEqual(['/w']);
    // The two specs asked meanwhile, in one listing.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual([
      specFilter('/w', 'tests/a.spec.ts'),
      specFilter('/w', 'tests/b.spec.ts'),
      '--project=*',
    ]);
  });

  test('a listing of some specs keeps theirs alone, whatever else Playwright lists', async () => {
    const a = listed({ file: 'tests/a.spec.ts', id: 'a' });
    const sub = listed({ file: 'sub/tests/a.spec.ts', id: 'sub' });
    const run: ListRunner = () => Promise.resolve({ stdout: testsLine([a, sub]), stderr: '' });
    const listings = new TestListings(
      run,
      () => {},
      () => 'same',
    );
    listings.listAll('/w', '/w/playwright.config.ts');
    await settle();
    for (let i = 0; i < 3; i++) {
      listings.listSpecs('/w', ['tests/a.spec.ts']);
      await settle();
    }
    const listing = listings.state('/w')!.listing!;
    expect(listing.specs.get('tests/a.spec.ts')).toEqual([a]);
    expect(listing.specs.get('sub/tests/a.spec.ts')).toEqual([sub]);
  });

  test('a spec listed alone replaces its own tests, a spec with none leaves the listing', async () => {
    let tests = [listed({ file: 'tests/a.spec.ts', id: 'a' }), listed({ file: 'tests/b.spec.ts', id: 'b' })];
    const run: ListRunner = (_config, args) => {
      const filters = args.filter((a) => a !== '--project=*');
      const picked = filters.length
        ? tests.filter((t) => filters.some((a) => playwrightRegExp(a).test(`/w/${t.file}`)))
        : tests;
      return Promise.resolve({ stdout: testsLine(picked), stderr: '' });
    };
    const listings = new TestListings(
      run,
      () => {},
      () => 'same',
    );
    listings.listAll('/w', '/w/playwright.config.ts');
    await settle();
    tests = [listed({ file: 'tests/a.spec.ts', id: 'a2', title: 'renamed' })];
    listings.listSpecs('/w', ['tests/a.spec.ts', 'tests/b.spec.ts']);
    await settle();
    const listing = listings.state('/w')!.listing!;
    expect([...listing.specs]).toEqual([['tests/a.spec.ts', [tests[0]]]]);
    expect(listing.listedAt.has('tests/b.spec.ts')).toBe(true);
  });

  test('keeps the projects that run only when named, as the last listing read them', async () => {
    let named = ['slow'];
    const run: ListRunner = () =>
      Promise.resolve({
        stdout: `PIWI_USE ${JSON.stringify({ rootDir: '/w', projects: named.map((name) => ({ name, default: false })) })}\n${testsLine([listed({})])}`,
        stderr: '',
      });
    const listings = new TestListings(
      run,
      () => {},
      () => 'same',
    );
    listings.listAll('/w', '/w/playwright.config.ts');
    await settle();
    expect([...listings.state('/w')!.listing!.onlyNamed]).toEqual(['slow']);
    named = ['nightly'];
    listings.listSpecs('/w', ['tests/a.spec.ts']);
    await settle();
    expect([...listings.state('/w')!.listing!.onlyNamed]).toEqual(['nightly']);
  });

  test('lists a config whole again when a file it reads changed, and keeps the last listing past a failure', async () => {
    let fingerprint = 'one';
    let fails = false;
    const run: ListRunner = () =>
      fails
        ? Promise.reject(new ProjectOptionsError('timeout', 'Playwright did not list the tests within 120 seconds.'))
        : Promise.resolve({ stdout: testsLine([listed({})]), stderr: '' });
    let runs = 0;
    const listings = new TestListings(
      (c, a) => {
        runs++;
        return run(c, a);
      },
      () => {},
      () => fingerprint,
    );
    listings.listAll('/w', '/w/playwright.config.ts');
    await settle();
    listings.checkConfig('/w');
    expect(runs).toBe(1);
    fingerprint = 'two';
    fails = true;
    listings.checkConfig('/w');
    await settle();
    expect(runs).toBe(2);
    const state = listings.state('/w')!;
    expect(state.error).toBe('Playwright did not list the tests within 120 seconds.');
    expect([...state.listing!.specs.keys()]).toEqual(['tests/a.spec.ts']);
    // A config never listed is not followed.
    listings.listSpecs('/other', ['tests/a.spec.ts']);
    listings.checkConfig('/other');
    expect(listings.listed('/other')).toBe(false);
  });
});
