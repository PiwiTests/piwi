import { describe, test, expect } from 'vitest';
import {
  buildBisectArgs,
  buildLocalRunPlan,
  buildReproduceArgs,
  localRunCopyOptions,
  localRunHoldRefusal,
  localRunHoldsFailures,
} from '../../app/utils/local-run-args';
import { desktopArgsAttended } from '../../app/utils/desktop-run-view';
import { buildRetryCommand } from '#shared/retry-command';
import { splitRerunArgs } from '@piwitests/core/rerun-args';

const CASE = {
  filePath: 'tests/checkout.spec.ts',
  title: 'checkout completes',
  line: 42,
  projectName: 'chromium',
};

describe('buildLocalRunPlan', () => {
  test('returns no steps for no cases', () => {
    expect(buildLocalRunPlan([])).toEqual([]);
  });

  test('builds one file:line step per Playwright project', () => {
    const plan = buildLocalRunPlan([
      CASE,
      { ...CASE, filePath: 'tests/login.spec.ts', line: 7, projectName: 'firefox' },
    ]);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.args).toEqual(['tests/checkout.spec.ts:42', '--project=chromium']);
    expect(plan[1]!.args).toEqual(['tests/login.spec.ts:7', '--project=firefox']);
    expect(plan[0]!.display).toBe('playwright test tests/checkout.spec.ts:42 --project=chromium');
  });

  test('omits --project when the case has none', () => {
    const plan = buildLocalRunPlan([{ ...CASE, projectName: null }]);
    expect(plan[0]!.args).toEqual(['tests/checkout.spec.ts:42']);
  });

  test('dedupes identical file:line specs and falls back to the file without a line', () => {
    const plan = buildLocalRunPlan([CASE, { ...CASE, title: 'other' }, { ...CASE, title: 'third', line: null }]);
    expect(plan[0]!.args).toEqual(['tests/checkout.spec.ts:42', 'tests/checkout.spec.ts', '--project=chromium']);
  });

  test('normalizes Windows separators to POSIX', () => {
    const plan = buildLocalRunPlan([{ ...CASE, filePath: 'tests\\checkout.spec.ts' }]);
    expect(plan[0]!.args[0]).toBe('tests/checkout.spec.ts:42');
  });

  test('grep mode escapes regex characters and joins titles', () => {
    const plan = buildLocalRunPlan(
      [
        { ...CASE, title: 'pays (visa)' },
        { ...CASE, title: 'refund $10' },
      ],
      { mode: 'grep' },
    );
    expect(plan[0]!.args).toEqual(['--grep', '(pays \\(visa\\)|refund \\$10)', '--project=chromium']);
  });

  test('file mode dedupes file paths', () => {
    const plan = buildLocalRunPlan([CASE, { ...CASE, title: 'other', line: 60 }], { mode: 'file' });
    expect(plan[0]!.args).toEqual(['tests/checkout.spec.ts', '--project=chromium']);
  });

  test('appends run mode, trace and repeat-each flags, a repeat without retries', () => {
    const plan = buildLocalRunPlan([CASE], { runMode: 'headed', trace: true, repeatEach: 25 });
    expect(plan[0]!.args).toEqual([
      'tests/checkout.spec.ts:42',
      '--project=chromium',
      '--headed',
      '--trace=on',
      '--repeat-each=25',
      '--retries=0',
    ]);
  });

  test('a repeated run that stops at its first failing repetition ends at one failure', () => {
    expect(buildLocalRunPlan([CASE], { repeatEach: 20, stopAtFirstFailure: true })[0]!.args.slice(-3)).toEqual([
      '--repeat-each=20',
      '--retries=0',
      '--max-failures=1',
    ]);
    // A run that does not repeat runs every test, as it would without the option.
    expect(buildLocalRunPlan([CASE], { repeatEach: 1, stopAtFirstFailure: true })[0]!.args).not.toContain(
      '--max-failures=1',
    );
  });

  test('Hold failures holds only in a run a person attends, as the shell names it', () => {
    expect(localRunHoldsFailures({ holdFailures: true })).toBe(true);
    expect(localRunHoldsFailures({ holdFailures: true, repeatEach: 20, stopAtFirstFailure: true })).toBe(true);
    expect(localRunHoldRefusal({ holdFailures: true, repeatEach: 20 })).toBe(
      'A repeated run goes on past each failure, unless it stops at the first one.',
    );
    expect(localRunHoldsFailures({ holdFailures: true, repeatEach: 20 })).toBe(false);
    expect(localRunHoldRefusal({ runMode: 'ui', repeatEach: 20, stopAtFirstFailure: true })).toBe(
      'UI mode goes on past each failure.',
    );
    // The rule is the shell's own, read from the arguments the run starts with.
    for (const options of [
      { repeatEach: 20 },
      { repeatEach: 20, stopAtFirstFailure: true },
      { runMode: 'ui' as const },
      { repeatEach: 1, stopAtFirstFailure: true },
    ]) {
      const attended = desktopArgsAttended(buildLocalRunPlan([CASE], options)[0]!.args);
      expect(localRunHoldRefusal(options) === null, JSON.stringify(options)).toBe(attended);
    }
  });

  test('Hold failures adds no flag: the run channel carries it', () => {
    expect(buildLocalRunPlan([CASE], { holdFailures: true })[0]!.args).toEqual(buildLocalRunPlan([CASE])[0]!.args);
  });

  test('debug and ui run modes map to their flags', () => {
    expect(buildLocalRunPlan([CASE], { runMode: 'debug' })[0]!.args).toContain('--debug');
    expect(buildLocalRunPlan([CASE], { runMode: 'ui' })[0]!.args).toContain('--ui');
  });

  test('clamps repeat-each to 1–1000 and omits it at 1', () => {
    expect(buildLocalRunPlan([CASE], { repeatEach: 0 })[0]!.args).not.toContain('--repeat-each=0');
    expect(buildLocalRunPlan([CASE], { repeatEach: 1.9 })[0]!.args.join(' ')).not.toContain('--repeat-each');
    expect(buildLocalRunPlan([CASE], { repeatEach: 5000 })[0]!.args).toContain('--repeat-each=1000');
    expect(buildLocalRunPlan([CASE], { repeatEach: 3.7 })[0]!.args).toContain('--repeat-each=3');
  });

  test('display quotes arguments with spaces or regex metacharacters, args stay raw', () => {
    const plan = buildLocalRunPlan([{ ...CASE, title: 'pays (visa)' }], { mode: 'grep' });
    expect(plan[0]!.args[1]).toBe('pays \\(visa\\)');
    expect(plan[0]!.display).toBe('playwright test --grep "pays \\(visa\\)" --project=chromium');
  });
});

describe('buildReproduceArgs', () => {
  test('one file:line spec plus its project', () => {
    expect(buildReproduceArgs([CASE])).toEqual(['tests/checkout.spec.ts:42', '--project=chromium']);
  });

  test('drops the line when a case has none', () => {
    expect(buildReproduceArgs([{ ...CASE, line: null }])).toEqual(['tests/checkout.spec.ts', '--project=chromium']);
  });

  test('never splits into steps — all specs then one --project per distinct project', () => {
    const args = buildReproduceArgs([
      CASE,
      { ...CASE, filePath: 'tests/login.spec.ts', line: 7, projectName: 'firefox' },
    ]);
    expect(args).toEqual([
      'tests/checkout.spec.ts:42',
      'tests/login.spec.ts:7',
      '--project=chromium',
      '--project=firefox',
    ]);
  });

  test('dedupes identical specs', () => {
    expect(buildReproduceArgs([CASE, { ...CASE }])).toEqual(['tests/checkout.spec.ts:42', '--project=chromium']);
  });

  test('omits the project filter when no project is known', () => {
    expect(buildReproduceArgs([{ ...CASE, projectName: null }])).toEqual(['tests/checkout.spec.ts:42']);
  });
});

describe('buildBisectArgs', () => {
  test('finds the tests by file and title, so a line that moved between commits still matches', () => {
    expect(
      buildBisectArgs([
        { filePath: 'tests\\checkout.spec.ts', title: 'pays (card)', line: 42, projectName: 'chromium' },
        { filePath: 'tests/checkout.spec.ts', title: 'refunds', line: 60, projectName: 'firefox' },
      ]),
    ).toEqual([
      'tests/checkout.spec.ts',
      '--grep=(pays \\(card\\)|refunds)',
      '--project=chromium',
      '--project=firefox',
    ]);
  });

  test('never passes a path that would be read as an option', () => {
    expect(buildBisectArgs([{ filePath: '-u', title: 'u', line: null, projectName: null }])).toEqual(['--grep=u']);
  });
});

describe('a spec whose path holds a character a regular expression reads', () => {
  test('is passed as a pattern that names its own file', () => {
    const cases = [{ filePath: 'tests/[slug].spec.ts', title: 'shows a post', line: 3, projectName: 'chromium' }];
    expect(buildReproduceArgs(cases)).toEqual(['tests/[[]slug].spec.ts:3', '--project=chromium']);
    expect(buildBisectArgs([{ ...cases[0]!, filePath: 'tests/checkout (guest).spec.ts' }])[0]).toBe(
      'tests/checkout [(]guest[)].spec.ts',
    );
  });
});

describe('Copy as command', () => {
  test('the copied command runs what the local run runs', () => {
    const options = { runMode: 'headed' as const, trace: true, repeatEach: 25 };
    const copied = buildRetryCommand([CASE], { options: localRunCopyOptions(options) });
    const plan = buildLocalRunPlan([CASE], options);
    expect(splitRerunArgs(copied)).toEqual(['npx', 'playwright', 'test', ...plan[0]!.args]);
  });

  test('a run that stops at its first failing repetition copies its limit', () => {
    const options = { mode: 'grep' as const, repeatEach: 20, stopAtFirstFailure: true, trace: true };
    const copied = buildRetryCommand([CASE], { mode: 'grep', options: localRunCopyOptions(options) });
    expect(splitRerunArgs(copied)).toEqual([
      'npx',
      'playwright',
      'test',
      ...buildLocalRunPlan([CASE], options)[0]!.args,
    ]);
  });

  test('a debug run copies its flag, a plain one copies none', () => {
    expect(buildRetryCommand([CASE], { options: localRunCopyOptions({ runMode: 'debug' }) })).toContain(' --debug');
    expect(buildRetryCommand([CASE], { options: localRunCopyOptions({}) })).toBe(buildRetryCommand([CASE]));
  });
});
