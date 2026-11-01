import { describe, expect, test } from 'vitest';
import { appendErrorLocation, joinErrorMessages, locatedError } from '../src/error-text';
import { extractErrorSignature } from '../src/error-signature';

describe('the error of a timed-out test', () => {
  // As Playwright lists them: the timeout first, with no place, then the call it interrupted.
  const timeout: { message: string; location?: { file: string; line: number; column: number } } = {
    message: 'Test timeout of 30000ms exceeded.',
  };
  const click = {
    message:
      "Error: locator.click: Test timeout of 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Log in' })",
    location: { file: '/repo/tests/sign-in.spec.ts', line: 7, column: 54 },
  };

  test('is placed at the call it interrupted', () => {
    expect(locatedError([timeout, click])).toBe(click);
    expect(locatedError([timeout, null, undefined])).toBeUndefined();
    expect(locatedError([{ message: 'x', location: { file: '' } }])).toBeUndefined();
  });

  test('fingerprints as it did once that place is appended, and names its file', () => {
    const text = joinErrorMessages([timeout, click])!;
    const placed = appendErrorLocation(text, { file: 'tests/sign-in.spec.ts', line: 7, column: 54 });
    expect(placed.endsWith('\n    at tests/sign-in.spec.ts:7:54')).toBe(true);
    // The fingerprint hashes the type, the message and the locator; the top frame is for display.
    const { topFrameFile, ...hashed } = extractErrorSignature(placed);
    const { topFrameFile: before, ...hashedBefore } = extractErrorSignature(text);
    expect(hashed).toEqual(hashedBefore);
    expect(before).toBeNull();
    expect(topFrameFile).toBe('tests/sign-in.spec.ts');
  });
});

describe('the error text of a test', () => {
  // As Playwright 1.64 writes a fill that timed out on a field it found.
  const fillError = [
    'locator.fill: Timeout 1500ms exceeded.',
    'Call log:',
    "  - waiting for getByLabel('Password')",
    '    - locator resolved to <input readonly id="p" type="password"/>',
    '  - fill("S3cr3t!Passw0rd")',
    '  - attempting fill action',
  ].join('\n');

  test('names no text a fill or a typing typed in its call log', () => {
    const text = joinErrorMessages([{ message: fillError }])!;
    expect(text).not.toContain('S3cr3t');
    expect(text).toContain('  - fill("<hidden>")');
  });

  test('fingerprints as it did: the signature reads the message ahead of the call log', () => {
    const text = joinErrorMessages([{ message: fillError }])!;
    expect(extractErrorSignature(text)).toEqual(extractErrorSignature(fillError));
  });
});
