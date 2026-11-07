/**
 * The checks a target runs before it asks about a run request, and the command it builds: by `file:line` on the
 * request's commit, by title off it or with changes, a failed check leaving no command.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { specFileArgument, specFilePattern, type RunRequest } from '@piwitests/core/run-request';
import { planRequestedRun, requestedRunArgs } from '../src/request-run';

let folder: string;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: folder,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Robin',
      GIT_AUTHOR_EMAIL: 'robin@example.com',
      GIT_COMMITTER_NAME: 'Robin',
      GIT_COMMITTER_EMAIL: 'robin@example.com',
    },
  }).trim();
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    id: 'f'.repeat(32),
    kind: 'run',
    projectId: 1,
    tests: [
      { filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', line: 12, projectName: 'chromium' },
      { filePath: 'tests/checkout.spec.ts', title: 'refunds (partly)', line: 30, projectName: 'chromium' },
    ],
    options: { headed: true },
    source: {},
    ...overrides,
  };
}

beforeEach(() => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-request-run-')));
  fs.mkdirSync(path.join(folder, 'tests'));
  fs.writeFileSync(path.join(folder, 'tests', 'checkout.spec.ts'), '');
  fs.writeFileSync(path.join(folder, 'playwright.config.ts'), 'export default {};\n');
  fs.mkdirSync(path.join(folder, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'node_modules', '@playwright', 'test', 'package.json'),
    '{"name":"@playwright/test"}',
  );
  fs.writeFileSync(path.join(folder, '.gitignore'), 'node_modules\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'start');
});

afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

describe('requestedRunArgs', () => {
  test('selects each test by its line, then the project and the options', () => {
    const spec = path.join(folder, 'tests', 'checkout.spec.ts');
    const args = requestedRunArgs(
      request({ options: { headed: true, trace: 'on', repeatEach: 3, workers: 2 } }),
      folder,
      false,
    );
    expect(args).toEqual([
      specFileArgument(spec, 12),
      specFileArgument(spec, 30),
      '--project=chromium',
      '--headed',
      '--trace=on',
      '--repeat-each=3',
      '--retries=0',
      '--workers=2',
    ]);
  });

  test('by title, each spec file once and one --grep of the escaped titles, in one element', () => {
    const args = requestedRunArgs(request({ options: { headed: false, project: 'firefox' } }), folder, true);
    expect(args).toEqual([
      specFilePattern(path.join(folder, 'tests', 'checkout.spec.ts')),
      '--grep=(?:^| )(?:pays with a saved card|refunds \\(partly\\))(?: @\\S+)*$',
      '--project=firefox',
    ]);
  });
});

describe('planRequestedRun', () => {
  test('on the request’s commit, every check passes and the tests go by line', async () => {
    const commit = git('rev-parse', 'HEAD');
    const plan = await planRequestedRun(request({ source: { branch: 'main', commit } }), folder);
    expect(plan.runnable).toBe(true);
    expect(plan.byTitle).toBe(false);
    expect(plan.checks.map((c) => `${c.id}:${c.level}`)).toEqual([
      'folder:ok',
      'specs:ok',
      'playwright:ok',
      'commit:ok',
    ]);
    expect(plan.args[0]).toBe(specFileArgument(path.join(folder, 'tests', 'checkout.spec.ts'), 12));
    expect(plan.display.startsWith('npx playwright test ')).toBe(true);
    expect(plan).toMatchObject({ branch: 'main', commit });
  });

  test('off the request’s commit, or with changes, warns and selects by title', async () => {
    const plan = await planRequestedRun(
      request({ source: { branch: 'main', commit: '9f8e7d6'.padEnd(40, '0') } }),
      folder,
    );
    expect(plan.runnable).toBe(true);
    expect(plan.byTitle).toBe(true);
    const warning = plan.checks.find((c) => c.id === 'commit')!;
    expect(warning.level).toBe('warn');
    expect(warning.message).toMatch(/on main at [0-9a-f]{7}; the run you came from was on main at 9f8e7d6/);

    fs.writeFileSync(path.join(folder, 'tests', 'checkout.spec.ts'), '// edited\n');
    const changed = await planRequestedRun(request({ source: { commit: git('rev-parse', 'HEAD') } }), folder);
    expect(changed.byTitle).toBe(true);
    expect(changed.checks.find((c) => c.id === 'changes')?.level).toBe('warn');
  });

  test('a missing folder, spec, config or Playwright fails with no command', async () => {
    const none = await planRequestedRun(request(), null);
    expect(none.runnable).toBe(false);
    expect(none.args).toEqual([]);
    expect(none.display).toBe('');
    expect(none.checks[0]).toMatchObject({ id: 'folder', level: 'fail' });

    const gone = await planRequestedRun(request(), path.join(folder, 'nowhere'));
    expect(gone.checks[0]?.message).toMatch(/no longer exists/);

    fs.rmSync(path.join(folder, 'playwright.config.ts'));
    fs.rmSync(path.join(folder, 'node_modules'), { recursive: true });
    const plan = await planRequestedRun(
      request({
        tests: [
          { filePath: 'tests/checkout.spec.ts', title: 'a', line: 1, projectName: null },
          { filePath: 'tests/missing.spec.ts', title: 'b', line: 1, projectName: null },
          { filePath: '../outside.spec.ts', title: 'c', line: 1, projectName: null },
        ],
      }),
      folder,
    );
    expect(plan.runnable).toBe(false);
    expect(plan.args).toEqual([]);
    const failed = Object.fromEntries(plan.checks.filter((c) => c.level === 'fail').map((c) => [c.id, c.message]));
    expect(Object.keys(failed)).toEqual(['config', 'specs', 'playwright']);
    expect(failed.specs).toBe('Not in the folder: tests/missing.spec.ts, ../outside.spec.ts.');
  });
});
