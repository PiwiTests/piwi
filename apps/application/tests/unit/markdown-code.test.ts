import { describe, expect, test } from 'vitest';
import { markdownCode } from '#shared/utils/markdown-code';

describe('markdownCode', () => {
  test('wraps plain text in one backtick', () => {
    expect(markdownCode('tests/a.spec.ts')).toBe('`tests/a.spec.ts`');
  });

  test('fences text holding backticks with a longer run, padded when a backtick is at an edge', () => {
    expect(markdownCode('a`b')).toBe('``a`b``');
    expect(markdownCode('renders `code` block')).toBe('``renders `code` block``');
    expect(markdownCode('`x`')).toBe('`` `x` ``');
    expect(markdownCode('a``b')).toBe('```a``b```');
  });
});
