import { describe, test, expect } from 'vitest';
import { materializeSelection, type ResolvedTest } from '#shared/selection';

const tests: ResolvedTest[] = [
  {
    testCaseId: 1,
    filePath: 'tests/login.spec.ts',
    suitePath: '',
    title: 'logs in',
    line: 10,
    avgDurationMs: 1200,
    locks: [],
  },
  {
    testCaseId: 2,
    filePath: 'tests/login.spec.ts',
    suitePath: '',
    title: 'logs out',
    line: 24,
    avgDurationMs: 800,
    locks: [],
  },
  {
    testCaseId: 3,
    filePath: 'tests/cart.spec.ts',
    suitePath: '',
    title: 'adds item',
    line: null,
    avgDurationMs: null,
    locks: [],
  },
];

describe('materializeSelection', () => {
  test('args format emits file:line tokens', () => {
    const m = materializeSelection(tests, 'args');
    expect(m.format).toBe('args');
    expect(m.args).toEqual(['tests/login.spec.ts:10', 'tests/login.spec.ts:24', 'tests/cart.spec.ts']);
    expect(m.command).toBe(
      'npx playwright test "tests/login.spec.ts:10" "tests/login.spec.ts:24" "tests/cart.spec.ts"',
    );
  });

  test('files format dedupes to file paths', () => {
    const m = materializeSelection(tests, 'files');
    expect(m.args).toEqual(['tests/login.spec.ts', 'tests/cart.spec.ts']);
  });

  test('grep format builds a title alternation', () => {
    const m = materializeSelection(tests, 'grep');
    expect(m.args[0]).toBe('--grep');
    expect(m.args[1]).toBe('(logs in|logs out|adds item)');
  });

  test('grep escapes regex metacharacters in titles', () => {
    const m = materializeSelection(
      [
        {
          testCaseId: 1,
          filePath: 'a.spec.ts',
          suitePath: '',
          title: 'a (b) [c]',
          line: 1,
          avgDurationMs: 1,
          locks: [],
        },
      ],
      'grep',
    );
    expect(m.args[1]).toBe('a \\(b\\) \\[c\\]');
  });

  test('json and empty inputs produce no command', () => {
    expect(materializeSelection(tests, 'json')).toEqual({ format: 'json', args: [], command: '' });
    expect(materializeSelection([], 'args')).toEqual({ format: 'args', args: [], command: '' });
  });

  test('respects a custom package runner', () => {
    const m = materializeSelection(tests, 'files', { pkgRunner: 'pnpm' });
    expect(m.command.startsWith('pnpm playwright test ')).toBe(true);
  });

  test('falls back from grep to a file materialization when the command is too long', () => {
    const many: ResolvedTest[] = Array.from({ length: 400 }, (_, i) => ({
      testCaseId: i,
      filePath: `tests/file-${i}.spec.ts`,
      suitePath: '',
      title: `a rather long descriptive test title number ${i} that eats characters`,
      line: i,
      avgDurationMs: 100,
    }));
    const m = materializeSelection(many, 'grep');
    expect(m.format).not.toBe('grep');
    expect(m.command.length).toBeLessThanOrEqual(4096);
  });
});

describe('shell safety', () => {
  const hostile: ResolvedTest = {
    testCaseId: 9,
    filePath: 'tests/$(touch pwned).spec.ts',
    suitePath: '',
    title: 'checkout `id` works',
    line: 5,
    avgDurationMs: null,
    locks: [],
  };

  test('a file holding characters a shell expands is named with `.` in their place, in args and command', () => {
    const result = materializeSelection([hostile, tests[0]!], 'args');
    expect(result.args).toEqual(['tests/.[(]touch pwned[)].spec.ts:5', 'tests/login.spec.ts:10']);
    expect(result.command).not.toContain('$(');
    const files = materializeSelection([hostile], 'files');
    expect(files.format).toBe('files');
    expect(files.command).toBe('npx playwright test "tests/.[(]touch pwned[)].spec.ts"');
  });
});
