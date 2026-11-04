import { describe, expect, test } from 'vitest';
import { fnv1a32 } from '../src/hash';

describe('fnv1a32', () => {
  test('gives the FNV-1a 32-bit hash as 8 hex characters', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('a')).toBe('e40c292c');
    expect(fnv1a32('foobar')).toBe('bf9cf968');
    expect(fnv1a32('piwi')).toBe('24241b02');
    expect(fnv1a32('héllo ✓')).toBe('0579d2da');
    expect(fnv1a32('ghp_token123')).toBe('5e2101f0');
  });

  test('starts from the given seed', () => {
    expect(fnv1a32('', 0x01000193)).toBe('01000193');
    expect(fnv1a32('a', 0x01000193)).toBe('85030ff6');
    expect(fnv1a32('foobar', 0x01000193)).toBe('1e622b02');
  });
});
