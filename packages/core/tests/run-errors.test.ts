import { describe, expect, test } from 'vitest';
import {
  MAX_RUN_ERROR_CHARS,
  MAX_RUN_ERRORS,
  runErrorOfReported,
  sanitizeRunError,
  sanitizeRunErrors,
} from '../src/run-errors';

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

  test('cuts a long message and a long stack to the limit, their marker included, saying how much', () => {
    const error = sanitizeRunError({ message: 'x'.repeat(MAX_RUN_ERROR_CHARS + 500), stack: 'y'.repeat(9000) })!;
    for (const [text, char, length] of [
      [error.message, 'x', MAX_RUN_ERROR_CHARS + 500],
      [error.stack!, 'y', 9000],
    ] as const) {
      expect(text.length).toBeLessThanOrEqual(MAX_RUN_ERROR_CHARS);
      const [, kept, cut] = /^([xy]+)\n\[truncated (\d+) chars\]$/.exec(text)!;
      expect(kept).toBe(char.repeat(kept!.length));
      expect(kept!.length + Number(cut)).toBe(length);
    }
  });

  test('keeps a text that fits the limit whole, so a stored error read again stays as it is', () => {
    const atLimit = sanitizeRunError({ message: 'x'.repeat(MAX_RUN_ERROR_CHARS) })!;
    expect(atLimit.message).toBe('x'.repeat(MAX_RUN_ERROR_CHARS));

    const reported = runErrorOfReported(
      {
        message: `Error: login failed with token=s3cr3t-v4lue ${'x'.repeat(5000)}`,
        stack: `Error: login failed\n${'    at login (/repo/global-setup.ts:4:9)\n'.repeat(300)}`,
        location: { file: '/repo/global-setup.ts', line: 4, column: 9 },
      },
      (file) => file.replace('/repo/', ''),
    )!;
    expect(reported.message).toMatch(/\n\[truncated \d+ chars\]$/);
    expect(reported.stack).toMatch(/\n\[truncated \d+ chars\]$/);
    expect(sanitizeRunError(reported)).toEqual(reported);
    expect(sanitizeRunErrors([reported])).toEqual([reported]);
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
    expect(errors[errors.length - 1]!.message).toBe(`Error: spec ${MAX_RUN_ERRORS - 1} did not load`);
  });

  test('is null for no error, or for a value that is no list', () => {
    expect(sanitizeRunErrors([])).toBeNull();
    expect(sanitizeRunErrors([{ message: ' ' }, null])).toBeNull();
    expect(sanitizeRunErrors({ message: 'boom' })).toBeNull();
    expect(sanitizeRunErrors(undefined)).toBeNull();
  });
});

describe('an error Playwright reported outside any test', () => {
  const fromConfig = (file: string) => file.replace('/repo/', '');

  test('keeps its message with its causes, the frames of its stack, and its place named by the caller', () => {
    expect(
      runErrorOfReported(
        {
          message: 'TypeError: fetch failed',
          stack: 'TypeError: fetch failed\n    at globalSetup (/repo/global-setup.ts:4:9)',
          cause: { message: 'Error: connect ECONNREFUSED', cause: { value: '{ code: 42 }' } },
          location: { file: '/repo/global-setup.ts', line: 4, column: 9 },
        },
        fromConfig,
      ),
    ).toEqual({
      message: 'TypeError: fetch failed\n[cause]: Error: connect ECONNREFUSED\n[cause]: { code: 42 }',
      stack: '    at globalSetup (/repo/global-setup.ts:4:9)',
      location: { file: 'global-setup.ts', line: 4, column: 9 },
    });
  });

  test('reads only the fields of the expected type, as a blob report read back may hold any', () => {
    expect(runErrorOfReported({ message: 42, value: "'declined'", location: 'here' }, fromConfig)).toEqual({
      message: "'declined'",
      stack: null,
      location: null,
    });
    expect(runErrorOfReported({ stack: 'Error: boom\n    at x (/a.ts:1:1)', cause: 'no' }, fromConfig)?.message).toBe(
      'Error: boom',
    );
    expect(
      runErrorOfReported({ message: '', location: { file: '/repo/a.ts', line: 1, column: 1 } }, fromConfig),
    ).toBeNull();
  });
});
