import { execFileSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRetryCommand, buildRetryArgs, buildTitleGrepFlag } from '#shared/retry-command';

const sampleCases = [
  { filePath: 'tests/login.spec.ts', title: 'should login', line: 10, projectName: 'chromium' },
  { filePath: 'tests/login.spec.ts', title: 'should logout', line: 42, projectName: 'chromium' },
  { filePath: 'tests/checkout.spec.ts', title: 'should checkout', line: 88, projectName: 'firefox' },
];

test('file-line mode — default', () => {
  const cmd = buildRetryCommand(sampleCases);
  expect(cmd).toContain('npx playwright test');
  expect(cmd).toContain('tests/login.spec.ts:10');
  expect(cmd).toContain('tests/login.spec.ts:42');
  expect(cmd).toContain('tests/checkout.spec.ts:88');
  expect(cmd).toContain('--project="chromium"');
  expect(cmd).toContain('--project="firefox"');
  expect(cmd).toContain(' && ');
});

test('file mode — broad', () => {
  const cmd = buildRetryCommand(sampleCases, { mode: 'file' });
  expect(cmd).not.toContain(':10');
  expect(cmd).not.toContain(':42');
  expect(cmd).not.toContain(':88');
  expect(cmd).toContain('tests/login.spec.ts');
  expect(cmd).toContain('tests/checkout.spec.ts');
});

test('grep mode — by title', () => {
  const cmd = buildRetryCommand(sampleCases, { mode: 'grep' });
  expect(cmd).toContain('--grep');
  // Titles are escaped and OR'd
  expect(cmd).toContain('should login');
  expect(cmd).toContain('should logout');
});

test('grep mode — escapes regex meta characters', () => {
  const special = [{ filePath: 'tests/foo.spec.ts', title: 'click .button (plus?)', line: null, projectName: null }];
  const cmd = buildRetryCommand(special, { mode: 'grep' });
  expect(cmd).toContain('click \\.button \\(plus\\?\\)');
});

test('empty cases', () => {
  expect(buildRetryCommand([])).toBe('');
});

test('single case', () => {
  const cmd = buildRetryCommand([sampleCases[0]]);
  expect(cmd).toBe('npx playwright test "tests/login.spec.ts:10" --project="chromium"');
});

test('custom pkgRunner', () => {
  const cmd = buildRetryCommand([sampleCases[0]], { pkgRunner: 'yarn' });
  expect(cmd).toContain('yarn playwright test');
});

test('dedupe same file:line', () => {
  const dupes = [
    { filePath: 'tests/foo.spec.ts', title: 'dup1', line: 10, projectName: 'chromium' },
    { filePath: 'tests/foo.spec.ts', title: 'dup2', line: 10, projectName: 'chromium' },
  ];
  const cmd = buildRetryCommand(dupes);
  // Only one "tests/foo.spec.ts:10" arg despite 2 cases
  expect(cmd.match(/tests\/foo\.spec\.ts:10/g)?.length).toBe(1);
});

test('normalizes Windows backslash paths to forward slashes', () => {
  // Runs captured on Windows store backslash-separated paths; Playwright's CLI
  // file filter only matches forward-slash paths, so the command must convert them.
  const winCases = [
    { filePath: 'tests\\case-files-live.spec.ts', title: 'win test', line: 393, projectName: 'chromium' },
  ];
  expect(buildRetryCommand(winCases)).toBe(
    'npx playwright test "tests/case-files-live.spec.ts:393" --project="chromium"',
  );
  expect(buildRetryCommand(winCases, { mode: 'file' })).toContain('"tests/case-files-live.spec.ts"');
  expect(buildRetryCommand(winCases)).not.toContain('\\');
});

test('quotes paths containing spaces', () => {
  const spaced = [{ filePath: 'tests/my dir/foo.spec.ts', title: 'spaced', line: 12, projectName: 'chromium' }];
  expect(buildRetryCommand(spaced)).toContain('"tests/my dir/foo.spec.ts:12"');
  expect(buildRetryCommand(spaced, { mode: 'file' })).toContain('"tests/my dir/foo.spec.ts"');
});

test('no project name', () => {
  const noProject = [{ filePath: 'tests/bar.spec.ts', title: 'bar test', line: 5, projectName: null }];
  const cmd = buildRetryCommand(noProject);
  expect(cmd).not.toContain('--project=');
});

describe('buildTitleGrepFlag', () => {
  test('no titles, no flag', () => {
    expect(buildTitleGrepFlag([])).toBe('');
  });

  test('joins plain titles with an alternation', () => {
    expect(buildTitleGrepFlag(['should login', 'should logout'])).toBe(' -g "should login|should logout"');
  });

  test('escapes regex metacharacters in each title', () => {
    expect(buildTitleGrepFlag(['click .button (plus?)', 'list [a] + *b'])).toBe(
      ' -g "click \\.button \\(plus\\?\\)|list \\[a\\] \\+ \\*b"',
    );
  });

  test('matches a character any shell would expand as `.`, so none reaches the shell', () => {
    expect(buildTitleGrepFlag(['say "hi"', 'cost `5` $x', 'a\\b %PATH% !x'])).toBe(
      ' -g "say .hi.|cost .5. .x|a.b .PATH. .x"',
    );
  });

  describe.skipIf(process.platform === 'win32')('through a POSIX shell', () => {
    const titles = [
      'Users (admin) [beta] v1.2',
      'adds 1 + 1 = 2? *yes*',
      'price is $5 or ${x}',
      'say "hi" and \'bye\'',
      'back\\slash `tick` | pipe ^caret',
    ];

    function shellArguments(flag: string): string[] {
      const out = execFileSync('sh', ['-c', `printf '%s\\n'${flag}`], { encoding: 'utf8' });
      return out.split('\n').slice(0, -1);
    }

    test.each(titles)('the shell hands Playwright a regex that matches %s', (title) => {
      const flag = buildTitleGrepFlag([title]);
      const [name, pattern] = shellArguments(flag);
      expect(name).toBe('-g');
      // The shell passes the pattern through unchanged: nothing in it expands.
      expect(pattern).toBe(flag.slice(' -g "'.length, -1));
      expect(new RegExp(pattern!).test(title)).toBe(true);
    });

    test.each(titles.filter((t) => !/[$`"\\%!]/.test(t)))(
      'a title without shell characters matches only %s',
      (title) => {
        const [, pattern] = shellArguments(buildTitleGrepFlag([title]));
        expect(new RegExp(pattern!).test(title.replace(/[^A-Za-z0-9 ]/, 'Z'))).toBe(false);
      },
    );

    test('command substitution in a title or a path never runs', () => {
      const dir = mkdtempSync(join(tmpdir(), 'piwi-retry-'));
      const marker = join(dir, 'pwned');
      const title = `checkout $(touch ${marker}) \`touch ${marker}\` works`;
      shellArguments(buildTitleGrepFlag([title]));
      const cmd = buildRetryCommand(
        [
          { filePath: `tests/$(touch ${marker}).spec.ts`, title, line: 3, projectName: `p$(touch ${marker})` },
          { filePath: 'tests/ok.spec.ts', title: 'ok', line: 4, projectName: 'chromium' },
        ],
        { mode: 'file-line' },
      );
      execFileSync('sh', [
        '-c',
        `printf '%s\\n' ${cmd.replace(/^npx playwright test /, '').replace(/ && npx playwright test /g, ' ')}`,
      ]);
      expect(existsSync(marker)).toBe(false);
      expect(cmd).toContain('"tests/ok.spec.ts:4"');
      expect(cmd).not.toContain('$(');
    });

    test('a dot, a star and a bracket in a title match only themselves', () => {
      const [, pattern] = shellArguments(buildTitleGrepFlag(['v1.2 [a]*']));
      const regex = new RegExp(pattern!);
      expect(regex.test('v1.2 [a]*')).toBe(true);
      expect(regex.test('v1X2 [a]*')).toBe(false);
      expect(regex.test('v1.2 a')).toBe(false);
    });

    test('several titles become one alternation that matches each of them', () => {
      const [, pattern] = shellArguments(buildTitleGrepFlag(titles));
      const regex = new RegExp(pattern!);
      for (const title of titles) expect(regex.test(title)).toBe(true);
      expect(regex.test('an unrelated title')).toBe(false);
    });
  });
});

describe('unsafe file paths and project names are left out', () => {
  test('a path holding characters a shell expands names its file with `.` in their place, and such a project is dropped', () => {
    expect(buildRetryCommand([{ filePath: 'tests/`id`.spec.ts', title: 't', line: 1, projectName: 'chromium' }])).toBe(
      'npx playwright test "tests/.id..spec.ts:1" --project="chromium"',
    );
    expect(buildRetryCommand([{ filePath: 'tests/a.spec.ts', title: 't', line: 1, projectName: 'x$(id)' }])).toBe(
      'npx playwright test "tests/a.spec.ts:1"',
    );
  });

  test('CI re-run arguments hold nothing a shell expands', () => {
    expect(
      buildRetryArgs([
        { filePath: 'tests/$(id).spec.ts', title: 't', line: null },
        { filePath: 'tests/b.spec.ts', title: 't', line: null },
      ]),
    ).toBe('"tests/.[(]id[)].spec.ts" "tests/b.spec.ts"');
  });
});

describe('a spec whose path holds a character a regular expression reads', () => {
  test('is written as a pattern that names its own file, with nothing a shell expands', () => {
    const cases = [{ filePath: 'tests/c++.spec.ts', title: 'adds', line: 7, projectName: null }];
    expect(buildRetryCommand(cases)).toBe('npx playwright test "tests/c[+][+].spec.ts:7"');
    expect(buildRetryArgs(cases)).toBe('"tests/c[+][+].spec.ts:7"');
  });
});
