import { describe, test, expect } from 'vitest';
import { copyPreview, errorMessage } from '../app/utils/text';

describe('errorMessage (fetch error unwrapping)', () => {
  test('unwraps the { data: { message } } shape', () => {
    expect(errorMessage({ data: { message: 'Boom' } })).toBe('Boom');
  });

  test('falls back to the top-level message', () => {
    expect(errorMessage({ message: 'Plain' })).toBe('Plain');
  });

  test('returns the fallback for non-object / empty values', () => {
    expect(errorMessage('a string')).toBe('Unknown error');
    expect(errorMessage(null)).toBe('Unknown error');
    expect(errorMessage({}, 'custom fallback')).toBe('custom fallback');
  });
});

describe('copyPreview', () => {
  test('returns empty string for nullish input', () => {
    expect(copyPreview(null)).toBe('');
    expect(copyPreview(undefined)).toBe('');
  });

  test('joins newlines with a middot and truncates past the cap', () => {
    expect(copyPreview('a\nb')).toBe('a · b');
    expect(copyPreview('x'.repeat(200), 10)).toBe('xxxxxxxxxx…');
  });
});
