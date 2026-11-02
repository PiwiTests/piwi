import { describe, expect, test } from 'vitest';
import { MAX_TEST_OUTPUT_CHARS, boundTestOutput, sanitizeTestOutput } from '../src/test-output';

/** `count` lines, each naming its number. */
function lines(count: number, from = 0): string {
  return Array.from({ length: count }, (_, i) => `line ${from + i}: the cart holds ${(from + i) % 7} items\n`).join('');
}

describe('what a test wrote to a stream', () => {
  test('is kept whole when it fits', () => {
    const text = lines(20);
    expect(boundTestOutput(text)).toBe(text);
  });

  test('is null when it holds only white space', () => {
    expect(boundTestOutput('')).toBeNull();
    expect(boundTestOutput('\n  \n')).toBeNull();
  });

  test('has what may be a secret hidden, as in the error text of a test', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJlLXZhbHVl';
    const kept = boundTestOutput(
      [
        `GET https://api.example.test/orders?page=2&api_key=k3y-v4lue-0001 200`,
        `signed in as demo with ${token}`,
        `{"password":"hunter2","user":"demo"}`,
        'Error: locator.fill: Timeout 500ms exceeded.\nCall log:\n  - fill("correct horse battery staple")',
      ].join('\n'),
    )!;
    expect(kept).toContain('page=2&api_key=<hidden>');
    expect(kept).not.toContain(token);
    expect(kept).toContain('"password":"<hidden>","user":"demo"');
    expect(kept).not.toContain('correct horse');
  });

  test('past the budget, keeps its first and its last lines, and says what was cut between them', () => {
    const text = lines(5000);
    const kept = boundTestOutput(text)!;
    expect(kept.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT_CHARS);
    expect(kept.startsWith('line 0: ')).toBe(true);
    expect(kept.endsWith('line 4999: the cart holds 1 items\n')).toBe(true);
    const marker = /\n\[… (\d+) lines \((\d+) characters\) of output cut …\]\n/.exec(kept)!;
    expect(marker).not.toBeNull();
    // Whole lines on both sides of the marker: what was cut is whole lines too.
    const [head, tail] = kept.split(marker[0]);
    expect(head!.endsWith(' items')).toBe(true);
    expect(tail!.startsWith('line ')).toBe(true);
    expect(Number(marker[1])).toBe(5000 - (head! + '\n').split('\n').length + 1 - tail!.split('\n').length + 1);
    expect(Number(marker[2])).toBe(text.length - head!.length - 1 - tail!.length);
  });

  test('cuts a single line too long to keep, saying how many characters were cut', () => {
    const kept = boundTestOutput('a'.repeat(200_000), 1000)!;
    expect(kept.length).toBeLessThanOrEqual(1000);
    expect(kept).toMatch(/^a+\n\[… \d+ characters of output cut …\]\na+$/);
  });

  test('hides the secrets of an output far longer than the budget, in the parts it keeps', () => {
    const secret = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    const text = `${secret}\n${lines(40_000)}${secret}\n`;
    const kept = boundTestOutput(text)!;
    expect(kept.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT_CHARS);
    expect(kept).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(kept.startsWith('Authorization: ')).toBe(true);
    expect(kept.endsWith('<hidden>\n')).toBe(true);
    const marker = /\[… (\d+) lines \((\d+) characters\) of output cut …\]/.exec(kept)!;
    expect(Number(marker[1])).toBeGreaterThan(38_000);
  });

  test('is kept as it is when the dashboard reads it again', () => {
    const once = boundTestOutput(lines(5000))!;
    expect(boundTestOutput(once)).toBe(once);
  });
});

describe('a stream read from untrusted input', () => {
  test('is kept when it is text, and null otherwise', () => {
    expect(sanitizeTestOutput('hello\n')).toBe('hello\n');
    expect(sanitizeTestOutput(42)).toBeNull();
    expect(sanitizeTestOutput(['hello'])).toBeNull();
    expect(sanitizeTestOutput(null)).toBeNull();
  });
});
