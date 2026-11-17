import { execFileSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildRetryCommand,
  buildRetryArgs,
  buildTitleGrepFlag,
  commandSpec,
  isSpecFilter,
  isTitleFilter,
  quoteShellArg,
  retryOptionFlags,
  retryProjects,
} from '#shared/retry-command';
import { splitRerunArgs } from '@piwitests/core/rerun-args';

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
  const cmd = buildRetryCommand([sampleCases[0]!]);
  expect(cmd).toBe('npx playwright test "/tests/login.spec.ts:10" --project="chromium"');
});

test('custom pkgRunner', () => {
  const cmd = buildRetryCommand([sampleCases[0]!], { pkgRunner: 'yarn' });
  expect(cmd).toContain('yarn playwright test');
});

test('dedupe same file:line', () => {
  const dupes = [
    { filePath: 'tests/foo.spec.ts', title: 'dup1', line: 10, projectName: 'chromium' },
    { filePath: 'tests/foo.spec.ts', title: 'dup2', line: 10, projectName: 'chromium' },
  ];
  const cmd = buildRetryCommand(dupes);
  // Only one "/tests/foo.spec.ts:10" arg despite 2 cases
  expect(cmd.match(/tests\/foo\.spec\.ts:10/g)?.length).toBe(1);
});

test('normalizes Windows backslash paths to forward slashes', () => {
  // Runs captured on Windows store backslash-separated paths; Playwright's CLI
  // file filter only matches forward-slash paths, so the command must convert them.
  const winCases = [
    { filePath: 'tests\\case-files-live.spec.ts', title: 'win test', line: 393, projectName: 'chromium' },
  ];
  expect(buildRetryCommand(winCases)).toBe(
    'npx playwright test "/tests/case-files-live.spec.ts:393" --project="chromium"',
  );
  expect(buildRetryCommand(winCases, { mode: 'file' })).toContain('"/tests/case-files-live.spec.ts"');
  expect(buildRetryCommand(winCases)).not.toContain('\\');
});

test('quotes paths containing spaces', () => {
  const spaced = [{ filePath: 'tests/my dir/foo.spec.ts', title: 'spaced', line: 12, projectName: 'chromium' }];
  expect(buildRetryCommand(spaced)).toContain('"/tests/my(?: |.20)dir/foo.spec.ts:12"');
  expect(buildRetryCommand(spaced, { mode: 'file' })).toContain('"/tests/my(?: |.20)dir/foo.spec.ts"');
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
      expect(cmd).toContain('"/tests/ok.spec.ts:4"');
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
      'npx playwright test "/tests/(?:.|.60)id(?:.|.60).spec.ts:1" --project="chromium"',
    );
    expect(buildRetryCommand([{ filePath: 'tests/a.spec.ts', title: 't', line: 1, projectName: 'x$(id)' }])).toBe(
      'npx playwright test "/tests/a.spec.ts:1"',
    );
  });

  test('a title or project holding a curly double quote, which PowerShell reads as a quote, never closes the argument', () => {
    for (const quote of ['“', '”', '„']) {
      const title = `x${quote} ; Start-Process calc ; #`;
      const grep = buildRetryCommand([{ filePath: 'tests/a.spec.ts', title, line: 1, projectName: 'chromium' }], {
        mode: 'grep',
      });
      expect(grep).toBe('npx playwright test --grep "x. ; Start-Process calc ; #" --project="chromium"');
      expect(
        buildRetryCommand([{ filePath: 'tests/a.spec.ts', title: 't', line: 1, projectName: `x${quote} ; calc ; #` }]),
      ).toBe('npx playwright test "/tests/a.spec.ts:1"');
      expect(quoteShellArg(`a${quote}b`)).toBeNull();
    }
  });

  test('CI re-run arguments hold nothing a shell expands', () => {
    expect(
      buildRetryArgs([
        { filePath: 'tests/$(id).spec.ts', title: 't', line: null },
        { filePath: 'tests/b.spec.ts', title: 't', line: null },
      ]),
    ).toBe('"/tests/.[(]id[)].spec.ts" "/tests/b.spec.ts"');
  });
});

describe('a spec whose path holds a character a regular expression reads', () => {
  test('is written as a pattern that names its own file, with nothing a shell expands', () => {
    const cases = [{ filePath: 'tests/c++.spec.ts', title: 'adds', line: 7, projectName: null }];
    expect(buildRetryCommand(cases)).toBe('npx playwright test "/tests/c[+][+].spec.ts:7"');
    expect(buildRetryArgs(cases)).toBe('"/tests/c[+][+].spec.ts:7"');
  });
});

describe('run options', () => {
  test('no options add no flag', () => {
    for (const mode of ['file-line', 'grep', 'file'] as const) {
      expect(buildRetryCommand(sampleCases, { mode, options: {} })).toBe(buildRetryCommand(sampleCases, { mode }));
      expect(buildRetryCommand(sampleCases, { mode, options: null })).toBe(buildRetryCommand(sampleCases, { mode }));
    }
  });

  test('flags follow every command, in a fixed order', () => {
    const cmd = buildRetryCommand(sampleCases, {
      options: { runMode: 'headed', trace: 'retain-on-failure', repeatEach: 3, workers: 2 },
    });
    const flags = ' --headed --trace=retain-on-failure --repeat-each=3 --retries=0 --workers=2';
    expect(cmd).toBe(
      `npx playwright test "/tests/login.spec.ts:10" "/tests/login.spec.ts:42" --project="chromium"${flags}` +
        ` && npx playwright test "/tests/checkout.spec.ts:88" --project="firefox"${flags}`,
    );
  });

  test('a repeat count of 1 adds nothing', () => {
    expect(retryOptionFlags({ repeatEach: 1 })).toBe('');
  });

  test('a count that is not a whole number in bounds is left out', () => {
    for (const bad of [0, -1, 1.5, 1001, Number.NaN]) {
      expect(retryOptionFlags({ repeatEach: bad, workers: bad })).toBe('');
    }
    expect(retryOptionFlags({ repeatEach: 1000, workers: 1 })).toBe(' --repeat-each=1000 --retries=0 --workers=1');
  });

  test('an unknown trace or run mode is left out', () => {
    expect(retryOptionFlags({ trace: 'off' as never, runMode: 'fast' as never })).toBe('');
  });

  test('debug and ui modes carry their flag', () => {
    expect(retryOptionFlags({ runMode: 'debug' })).toBe(' --debug');
    expect(retryOptionFlags({ runMode: 'ui' })).toBe(' --ui');
  });

  test('one project runs every test in one command', () => {
    const cmd = buildRetryCommand(sampleCases, { options: { project: 'webkit' } });
    expect(cmd).toBe(
      'npx playwright test "/tests/login.spec.ts:10" "/tests/login.spec.ts:42" "/tests/checkout.spec.ts:88" --project="webkit"',
    );
  });

  test('a project that cannot be quoted safely keeps each test in its own', () => {
    expect(buildRetryCommand(sampleCases, { options: { project: 'a$b' } })).toBe(buildRetryCommand(sampleCases));
  });

  test('the length fallback keeps the flags', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      filePath: `tests/area-${i}/a-rather-long-spec-file-name-${i}.spec.ts`,
      title: `test ${i}`,
      line: i + 1,
      projectName: 'chromium',
    }));
    const cmd = buildRetryCommand(many, { options: { runMode: 'headed', workers: 2, project: 'chromium' } });
    expect(cmd.length).toBeLessThanOrEqual(4096);
    expect(cmd.endsWith(' --project="chromium" --headed --workers=2')).toBe(true);
    // Only whole specs: the quotes balance, and every argument reads back as a spec or a flag.
    expect(cmd.split('"').length % 2).toBe(1);
    const args = splitRerunArgs(cmd).slice(3);
    expect(args.slice(-3)).toEqual(['--project=chromium', '--headed', '--workers=2']);
    for (const arg of args.slice(0, -3))
      expect(arg).toMatch(/^\/tests\/area-\d+\/a-rather-long-spec-file-name-\d+\.spec\.ts$/);
  });

  test('the flags read back as separate arguments', () => {
    const cmd = buildRetryCommand(sampleCases.slice(0, 1), {
      options: { runMode: 'headed', trace: 'on', repeatEach: 5, workers: 4 },
    });
    expect(splitRerunArgs(cmd)).toEqual([
      'npx',
      'playwright',
      'test',
      '/tests/login.spec.ts:10',
      '--project=chromium',
      '--headed',
      '--trace=on',
      '--repeat-each=5',
      '--retries=0',
      '--workers=4',
    ]);
  });
});

test('the projects offered are the ones the tests ran in that every shell quotes as they are', () => {
  const cases = [
    { filePath: 'a.spec.ts', title: 'a', projectName: 'chromium' },
    { filePath: 'b.spec.ts', title: 'b', projectName: 'mobile $safari' },
    { filePath: 'c.spec.ts', title: 'c', projectName: 'chromium' },
    { filePath: 'd.spec.ts', title: 'd', projectName: null },
    { filePath: 'e.spec.ts', title: 'e', projectName: 'webkit' },
  ];
  expect(retryProjects(cases)).toEqual(['chromium', 'webkit']);
});

describe('a filter that would match every test', () => {
  const empty = { filePath: '', title: '', line: 3, projectName: 'chromium' };

  test('an empty path, or a line with no path, is left out', () => {
    expect(buildRetryCommand([empty])).toBe('');
    expect(buildRetryCommand([empty], { mode: 'file' })).toBe('');
    expect(buildRetryCommand([empty, sampleCases[0]!])).toBe(
      'npx playwright test "/tests/login.spec.ts:10" --project="chromium"',
    );
    expect(buildRetryArgs([empty])).toBe('');
  });

  test('an empty title is left out', () => {
    expect(buildRetryCommand([empty], { mode: 'grep' })).toBe('');
    expect(buildRetryCommand([empty, sampleCases[0]!], { mode: 'grep' })).toBe(
      'npx playwright test --grep "should login" --project="chromium"',
    );
  });

  test('a path that starts with a dash is left out', () => {
    expect(buildRetryCommand([{ ...empty, filePath: '--ui' }])).toBe('');
    expect(buildRetryArgs([{ ...empty, filePath: '-x.spec.ts' }])).toBe('');
  });
});

describe('a test left out of a retry', () => {
  test('takes its project with it', () => {
    expect(
      buildRetryArgs([
        { filePath: 'tests/a.spec.ts', title: 'a', line: null, projectName: 'p1' },
        { filePath: '', title: 'b', line: null, projectName: 'p2' },
      ]),
    ).toBe('"/tests/a.spec.ts" --project="p1"');
  });

  test('a blank title is left out like an empty one', () => {
    expect(buildRetryCommand([{ filePath: '', title: '  ', line: null, projectName: null }], { mode: 'grep' })).toBe(
      '',
    );
    expect(buildTitleGrepFlag([' ', 'pays'])).toBe(' -g "pays"');
  });
});

describe('a filter that matches more than it names', () => {
  test('a title made only of characters a shell expands is left out', () => {
    expect(isTitleFilter('$')).toBe(false);
    expect(isTitleFilter('!! ')).toBe(false);
    expect(isTitleFilter('pays $10')).toBe(true);
    expect(
      buildRetryCommand([{ filePath: 'a.spec.ts', title: '$', line: 1, projectName: null }], { mode: 'grep' }),
    ).toBe('');
    expect(buildTitleGrepFlag(['!!', 'pays'])).toBe(' -g "pays"');
  });

  test('a path made only of `.` and `/` is left out, with or without a line', () => {
    for (const spec of ['.', '/', './', '/:2', '..:3', '', '.:5:7', '/./i', '//g'])
      expect(isSpecFilter(spec)).toBe(false);
    for (const spec of ['a.spec.ts', 'tests/a.spec.ts:2', '.github/a.spec.ts', './tests/a.spec.ts:3:1', '/tests/']) {
      expect(isSpecFilter(spec)).toBe(true);
    }
    expect(buildRetryCommand([{ filePath: '\\', title: 't', line: 2, projectName: null }])).toBe('');
    expect(buildRetryArgs([{ filePath: '.', title: 't', line: null, projectName: null }])).toBe('');
  });
});

describe('a spec named from a folder’s start', () => {
  /** Whether Playwright takes `file` for a copied spec filter: its file part, a regular expression ignoring case. */
  const takes = (arg: string, file: string) => new RegExp(arg.replace(/(?::\d+){1,2}$/, ''), 'gi').test(file);

  test('never takes a spec whose folder’s name ends as its own', () => {
    const [spec] = splitRerunArgs(buildRetryCommand([{ filePath: 'tests/a.spec.ts', title: 'pays', line: 3 }])).slice(
      3,
    );
    expect(spec).toBe('/tests/a.spec.ts:3');
    expect(takes(spec!, '/repo/tests/a.spec.ts')).toBe(true);
    expect(takes(spec!, 'C:/repo/tests/a.spec.ts')).toBe(true);
    expect(takes(spec!, 'file:///C:/repo/tests/a.spec.ts')).toBe(true);
    expect(takes(spec!, '/repo/xtests/a.spec.ts')).toBe(false);
    expect(takes(spec!, '/repo/my tests/a.spec.ts')).toBe(false);
    // A folder whose path ends as its own still matches: the dashboard does not know the checkout's folder.
    expect(takes(spec!, '/repo/e2e/tests/a.spec.ts')).toBe(true);
  });

  test('takes a spec whose path its file: URL encodes, as Windows Playwright up to 1.62 tests it', () => {
    for (const filePath of [
      'my tests/a.spec.ts',
      'tests/café.spec.ts',
      'tests/#1 [x] {y} ~^%`.spec.ts',
      '測試/a.spec.ts',
    ]) {
      const [spec] = splitRerunArgs(buildRetryArgs([{ filePath, title: 't', line: 3 }]));
      expect(spec, filePath).toMatch(/:3$/);
      const posix = `C:/repo/${filePath}`;
      expect(takes(spec!, posix), posix).toBe(true);
      expect(takes(spec!, `/repo/${filePath}`), filePath).toBe(true);
      const url = pathToFileURL(`C:\\repo\\${filePath.replace(/\//g, '\\')}`, { windows: true }).href;
      expect(url).toContain('%');
      expect(takes(spec!, url), url).toBe(true);
      expect(takes(spec!, url.replace('/repo/', '/repo/x')), url).toBe(false);
    }
    expect(commandSpec('my tests/a.spec.ts')).toBe('/my(?: |.20)tests/a.spec.ts');
    expect(commandSpec('tests/é.spec.ts')).toBe('/tests/(?:é|.C3.A9).spec.ts');
    expect(commandSpec('tests/[id].spec.ts')).toBe('/tests/(?:[[]|.5B)id(?:]|.5D).spec.ts');
    expect(commandSpec('tests/a%b.spec.ts')).toBe('/tests/a(?:.|.25)b.spec.ts');
  });

  test('is written once, and never before a path that starts at a root', () => {
    expect(commandSpec('tests/a.spec.ts')).toBe('/tests/a.spec.ts');
    expect(commandSpec('/abs/tests/a.spec.ts')).toBe('/abs/tests/a.spec.ts');
    expect(commandSpec('C:\\abs\\a.spec.ts')).toBe('C:/abs/a.spec.ts');
    expect(buildRetryArgs([{ filePath: 'a.spec.ts', title: 't', line: null }])).toBe('"/a.spec.ts"');
  });
});
