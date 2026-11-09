import { describe, expect, test } from 'vitest';
import { splitRerunArgs } from '../src/rerun-args';

describe('splitRerunArgs', () => {
  test('splits quoted arguments into the words they quote', () => {
    expect(splitRerunArgs('"tests/login.spec.ts:10" "tests/a b.spec.ts" --project="chromium"')).toEqual([
      'tests/login.spec.ts:10',
      'tests/a b.spec.ts',
      '--project=chromium',
    ]);
  });

  test('splits bare words and ignores the blanks around them', () => {
    expect(splitRerunArgs('  --workers=1\t-x\n tests/a.spec.ts  ')).toEqual(['--workers=1', '-x', 'tests/a.spec.ts']);
  });

  test('splits only on a space, a tab or a line break', () => {
    expect(splitRerunArgs('a\u00a0b\r\nc')).toEqual(['a\u00a0b', 'c']);
  });

  test('expands nothing', () => {
    expect(splitRerunArgs('$HOME "`id`" a\\b \'c d\'')).toEqual(['$HOME', '`id`', 'a\\b', "'c", "d'"]);
  });

  test('keeps an empty quoted word', () => {
    expect(splitRerunArgs('"" a')).toEqual(['', 'a']);
  });

  test('gives no words for an empty or blank string', () => {
    expect(splitRerunArgs('')).toEqual([]);
    expect(splitRerunArgs('   ')).toEqual([]);
  });

  test('refuses a quote left open', () => {
    expect(() => splitRerunArgs('"tests/a.spec.ts')).toThrow(/not closed/);
  });
});
