import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import type { TestResult } from '@playwright/test/reporter';
import { buildErrorText } from '../src/internal/collect/error-text.js';

type PartialError = { message?: string; location?: { file: string; line: number; column: number } };

function makeResult(errors: PartialError[], primary?: PartialError): TestResult {
  return { errors, error: primary } as unknown as TestResult;
}

describe('buildErrorText', () => {
  it('returns null when there are no errors', () => {
    expect(buildErrorText(makeResult([]))).toBeNull();
    expect(buildErrorText({ errors: undefined } as unknown as TestResult)).toBeNull();
  });

  it('returns the message of a single error', () => {
    expect(buildErrorText(makeResult([{ message: 'expect(received).toBe(expected)' }]))).toBe(
      'expect(received).toBe(expected)',
    );
  });

  it('joins multiple distinct errors with a separator', () => {
    const text = buildErrorText(makeResult([{ message: 'first failure' }, { message: 'second failure' }]));
    expect(text).toBe('first failure\n---\nsecond failure');
  });

  it('dedupes errors that share the same message head (timeout + interrupted action)', () => {
    const text = buildErrorText(
      makeResult([{ message: 'Test timeout of 30000ms exceeded.' }, { message: 'Test timeout of 30000ms exceeded.' }]),
    );
    expect(text).toBe('Test timeout of 30000ms exceeded.');
  });

  it('skips errors with empty or missing messages', () => {
    expect(buildErrorText(makeResult([{ message: '' }, { message: undefined }, { message: 'real one' }]))).toBe(
      'real one',
    );
  });

  it('returns null when every error message is empty', () => {
    expect(buildErrorText(makeResult([{ message: '' }, { message: undefined }]))).toBeNull();
  });

  it('appends a synthetic stack frame from error.location when none is present', () => {
    const file = path.join(process.cwd(), 'tests', 'login.spec.ts');
    const text = buildErrorText(
      makeResult([{ message: 'locator not found' }], {
        message: 'locator not found',
        location: { file, line: 12, column: 5 },
      }),
    );
    expect(text).toBe('locator not found\n    at tests/login.spec.ts:12:5');
  });

  it('uses forward slashes in the synthetic frame path', () => {
    const file = path.join(process.cwd(), 'a', 'b', 'c.spec.ts');
    const text = buildErrorText(
      makeResult([{ message: 'oops' }], { message: 'oops', location: { file, line: 1, column: 1 } }),
    );
    expect(text).toContain('at a/b/c.spec.ts:1:1');
    expect(text).not.toContain('\\');
  });

  it('does not append a synthetic frame when the text already carries a stack frame', () => {
    const withStack = 'boom\n    at existing.spec.ts:9:9';
    const file = path.join(process.cwd(), 'tests', 'login.spec.ts');
    const text = buildErrorText(
      makeResult([{ message: withStack }], { message: withStack, location: { file, line: 12, column: 5 } }),
    );
    expect(text).toBe(withStack);
  });

  it('places a timed-out test at the call the timeout interrupted', () => {
    const file = path.join(process.cwd(), 'tests', 'sign-in.spec.ts');
    const timeout = { message: 'Test timeout of 30000ms exceeded.' };
    const click = { message: 'Error: locator.click: Test timeout of 30000ms exceeded.', location: { file, line: 7, column: 54 } };
    const text = buildErrorText(makeResult([timeout, click], timeout));
    expect(text).toBe(
      'Test timeout of 30000ms exceeded.\n---\nError: locator.click: Test timeout of 30000ms exceeded.\n    at tests/sign-in.spec.ts:7:54',
    );
  });

  it('does not append a synthetic frame when there is no primary error location', () => {
    const text = buildErrorText(makeResult([{ message: 'no location error' }]));
    expect(text).toBe('no location error');
  });
});
