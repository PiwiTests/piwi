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
    const names = ['a.png', 'a.png'];
    expect(attachmentStoragePaths('d', names)).toEqual(attachmentStoragePaths('d', names));
  });
});
