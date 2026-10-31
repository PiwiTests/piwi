import { describe, expect, test } from 'vitest';
import { joinErrorMessages } from '../src/error-text';
import { extractErrorSignature } from '../src/error-signature';

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
