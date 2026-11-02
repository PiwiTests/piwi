import { describe, expect, test } from 'vitest';
import { MAX_RUN_ERROR_CHARS, MAX_RUN_ERRORS, sanitizeRunError, sanitizeRunErrors } from '../src/run-errors';

describe('an error of a run outside any test', () => {
  // As Playwright 1.64 reports a global setup that threw.
  const globalSetup = {
    message: 'Error: global setup could not sign in',
    stack: '    at module.exports (/repo/global-setup.ts:4:9)',
    location: { file: 'global-setup.ts', line: 4, column: 9 },
  };

  test('keeps its message, its stack and its location', () => {
    expect(sanitizeRunError(globalSetup)).toEqual(globalSetup);
  });

  test('hides what may be a secret, in its message and in its stack', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJlLXZhbHVl';
    const error = sanitizeRunError({
      message: `Error: login failed for https://api.example.test/login?token=s3cr3t-v4lue with Bearer ${token}`,
      stack: `    at login (/repo/global-setup.ts:4:9) {"password":"hunter2"}`,
    });
    expect(error?.message).not.toContain('s3cr3t-v4lue');
    expect(error?.message).not.toContain(token);
    expect(error?.message).toContain('token=<hidden>');
    expect(error?.stack).toContain('"password":"<hidden>"');
  });

  test('hides the text a fill typed, as in the error text of a test', () => {
    const error = sanitizeRunError({
      message: 'Error: locator.fill: Timeout 500ms exceeded.\nCall log:\n  - fill("correct horse battery staple")',
    });
    expect(error?.message).not.toContain('correct horse');
  });

  test('cuts a long message and a long stack, saying how much', () => {
    const error = sanitizeRunError({ message: 'x'.repeat(MAX_RUN_ERROR_CHARS + 500), stack: 'y'.repeat(9000) })!;
    expect(error.message.startsWith('x'.repeat(MAX_RUN_ERROR_CHARS))).toBe(true);
    expect(error.message.endsWith('\n[truncated 500 chars]')).toBe(true);
    expect(error.stack!.length).toBeLessThan(MAX_RUN_ERROR_CHARS + 40);
  });

  test('needs a message; a stack, a location and their parts are each kept only when valid', () => {
    expect(sanitizeRunError({ message: '   ' })).toBeNull();
    expect(sanitizeRunError({ stack: 'at x' })).toBeNull();
    expect(sanitizeRunError('Error: boom')).toBeNull();
    expect(
      sanitizeRunError({ message: 'Error: No tests found', stack: '', location: { file: 'a.ts', line: -1 } }),
    ).toEqual({ message: 'Error: No tests found', stack: null, location: null });
    expect(
      sanitizeRunError({ message: 'boom', location: { file: 'a.ts', line: 3, column: 1.5 } })?.location,
    ).toBeNull();
    expect(sanitizeRunError({ message: 'boom', location: { file: '', line: 3, column: 1 } })?.location).toBeNull();
  });
});

describe("a run's errors outside any test", () => {
  test(`keeps the first ${MAX_RUN_ERRORS} that hold a message`, () => {
    const errors = sanitizeRunErrors([
      { message: '' },
      ...Array.from({ length: MAX_RUN_ERRORS + 5 }, (_, i) => ({ message: `Error: spec ${i} did not load` })),
    ])!;
    expect(errors).toHaveLength(MAX_RUN_ERRORS);
    expect(errors[0]!.message).toBe('Error: spec 0 did not load');
    expect(errors.at(-1)!.message).toBe(`Error: spec ${MAX_RUN_ERRORS - 1} did not load`);
  });

  test('is null for no error, or for a value that is no list', () => {
    expect(sanitizeRunErrors([])).toBeNull();
    expect(sanitizeRunErrors([{ message: ' ' }, null])).toBeNull();
    expect(sanitizeRunErrors({ message: 'boom' })).toBeNull();
    expect(sanitizeRunErrors(undefined)).toBeNull();
  });
});
