import { splitRerunArgs } from '@piwitests/core/rerun-args';
import { describe, expect, test } from 'vitest';
import { buildRetryArgs, quoteShellArg } from '#shared/retry-command';

// `buildRetryArgs` writes the arguments a CI re-run hands its job; `piwi rerun`
// splits them back with `splitRerunArgs`. Each must undo the other.
describe('splitRerunArgs undoes quoteShellArg', () => {
  test.each([
    'tests/login.spec.ts:10',
    'tests/with space.spec.ts',
    "it's.spec.ts",
    'a\u00a0b',
    '--project=chromium',
    '',
    'é ü 漢字',
  ])('%j', (arg) => {
    const quoted = quoteShellArg(arg);
    expect(quoted).not.toBeNull();
    expect(splitRerunArgs(quoted!)).toEqual([arg]);
    expect(splitRerunArgs(`${quoted} ${quoted}`)).toEqual([arg, arg]);
  });

  test('an argument holding a character a shell expands is never quoted, so never split', () => {
    for (const arg of ['$HOME', 'a"b', '`id`', 'a\\b', '%PATH%', 'a!b', 'a\tb']) expect(quoteShellArg(arg)).toBeNull();
  });

  test('gives back the specs and projects buildRetryArgs wrote', () => {
    const args = buildRetryArgs([
      { filePath: 'tests/login.spec.ts', title: 'logs in', line: 10, projectName: 'chromium' },
      { filePath: 'tests\\cart page.spec.ts', title: 'adds', line: 4, projectName: 'mobile safari' },
      { filePath: 'tests/posts.$postId.spec.ts', title: 'shows', line: null, projectName: 'chromium' },
    ]);
    expect(splitRerunArgs(args)).toEqual([
      'tests/login.spec.ts:10',
      'tests/cart page.spec.ts:4',
      'tests/posts..postId.spec.ts',
      '--project=chromium',
      '--project=mobile safari',
    ]);
  });
});
