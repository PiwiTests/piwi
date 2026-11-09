import { describe, expect, test } from 'vitest';
import { specPattern } from '../src/spec-filter';

describe('specPattern', () => {
  test('a spec path names its own file as Playwright reads a file filter, a regular expression', () => {
    for (const file of [
      'tests/[slug].spec.ts',
      'tests/checkout (guest).spec.ts',
      'tests/c++.spec.ts',
      'tests/a{1}.spec.ts',
      'app/routes/posts.$postId.spec.ts',
      'tests/^start$.spec.ts',
      'tests/100%!.spec.ts',
    ]) {
      const pattern = new RegExp(specPattern(file), 'gi');
      expect(pattern.test(file)).toBe(true);
      // Nothing a shell expands inside double quotes.
      expect(specPattern(file)).not.toMatch(/[\\$`"%!^]/);
    }
    expect(specPattern('tests\\checkout.spec.ts')).toBe('tests/checkout.spec.ts');
    expect(specPattern('tests/[id].spec.ts')).toBe('tests/[[]id].spec.ts');
    expect(specPattern('app/routes/posts.$postId.spec.ts')).toBe('app/routes/posts..postId.spec.ts');
  });
});
