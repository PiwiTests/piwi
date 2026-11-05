import { describe, expect, test } from 'vitest';
import { attachmentStoragePaths } from '../../server/utils/attachment-paths';

describe('attachmentStoragePaths', () => {
  test('stores each attachment under its own name, a repeated name in a folder of its own', () => {
    expect(
      attachmentStoragePaths('run-1/7', ['screenshot.png', 'trace.zip', 'screenshot.png', 'screenshot.png']),
    ).toEqual([
      'run-1/7/screenshot.png',
      'run-1/7/trace.zip',
      'run-1/7/~2/screenshot.png',
      'run-1/7/~3/screenshot.png',
    ]);
  });

  test('gives the same paths for the same upload, so a retried upload finds what it stored', () => {
    const names = ['a.png', 'a.png', '..', ''];
    expect(attachmentStoragePaths('d', names)).toEqual(attachmentStoragePaths('d', names));
  });

  test('stores a name that is empty, `.` or `..` as `attachment`, inside its folder', () => {
    expect(attachmentStoragePaths('run-1/7', ['..', '.', '', 'attachment', 'a b/c.png', 'step-2..json'])).toEqual([
      'run-1/7/attachment',
      'run-1/7/~2/attachment',
      'run-1/7/~3/attachment',
      'run-1/7/~4/attachment',
      'run-1/7/a_b_c.png',
      'run-1/7/step-2..json',
    ]);
  });
});
