import { describe, expect, test } from 'vitest';
import { runErrorHeadline } from '~/utils/run-errors';

describe('runErrorHeadline', () => {
  test("is the first error's first line, without its stack", () => {
    expect(
      runErrorHeadline([
        {
          message:
            'Error: ENOSPC: no space left on device, write\n    at WriteStream.write (node:internal/fs/streams:318:12)',
        },
      ]),
    ).toBe('Error: ENOSPC: no space left on device, write');
  });

  test('takes out colour codes and leading blank lines', () => {
    expect(
      runErrorHeadline([{ message: '\n  \n\u001b[31mError: Timed out waiting for the web server\u001b[39m\nmore' }]),
    ).toBe('Error: Timed out waiting for the web server');
  });

  test('reads only the first of several errors', () => {
    expect(runErrorHeadline([{ message: 'Error: first' }, { message: 'Error: second' }])).toBe('Error: first');
  });

  test('is empty with no errors or a blank message', () => {
    expect(runErrorHeadline([])).toBe('');
    expect(runErrorHeadline([{ message: '' }])).toBe('');
    expect(runErrorHeadline([{ message: ' \n\t\n' }])).toBe('');
  });
});
