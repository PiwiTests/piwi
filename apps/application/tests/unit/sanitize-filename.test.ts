import { describe, test, expect } from 'vitest';
import {
  attachmentFileName,
  escapesStorageRoot,
  safeStorageSegment,
  sanitizeFilename,
} from '../../server/utils/sanitize-filename';

describe('safeStorageSegment', () => {
  test('preserves a legitimate single segment exactly', () => {
    // Playwright trace source resources are named `src@<sha1>.txt` — the `@`
    // must survive or the trace events can no longer reference the resource.
    expect(safeStorageSegment('src@0123456789abcdef.txt')).toBe('src@0123456789abcdef.txt');
    expect(safeStorageSegment('0123456789abcdef0123456789abcdef01234567')).toBe(
      '0123456789abcdef0123456789abcdef01234567',
    );
    expect(safeStorageSegment('a.b-c_d')).toBe('a.b-c_d');
    // Dots that are not a whole traversal segment, and spaces, are kept.
    expect(safeStorageSegment('a..b')).toBe('a..b');
    expect(safeStorageSegment('a b')).toBe('a b');
  });

  test('rejects traversal and separator names', () => {
    expect(safeStorageSegment('')).toBeNull();
    expect(safeStorageSegment('.')).toBeNull();
    expect(safeStorageSegment('..')).toBeNull();
    expect(safeStorageSegment('../../../etc/cron.d/pwn')).toBeNull();
    expect(safeStorageSegment('foo/bar')).toBeNull();
    expect(safeStorageSegment('foo\\bar')).toBeNull();
  });
});

describe('sanitizeFilename', () => {
  test('replaces unsafe characters with underscores', () => {
    expect(sanitizeFilename('a/b c@d')).toBe('a_b_c_d');
    expect(sanitizeFilename('keep.this-name_1')).toBe('keep.this-name_1');
  });
});

describe('attachmentFileName', () => {
  test('names an attachment whose name is dots alone `attachment`, and keeps any other sanitized', () => {
    for (const name of ['', '.', '..', '...']) expect(attachmentFileName(name), name).toBe('attachment');
    expect(attachmentFileName('a/..')).toBe('a_..');
    expect(attachmentFileName('.env.txt')).toBe('.env.txt');
    expect(attachmentFileName('shot one.png')).toBe('shot_one.png');
  });
});

describe('escapesStorageRoot', () => {
  test('finds a `..` segment under either separator, and an absolute path', () => {
    for (const path of [
      '../x',
      'project-1/../project-2/a.txt',
      'project-1/run-1/..',
      'project-1/run-1\\..\\..\\project-2\\a.txt',
      '/etc/passwd',
      '\\server\\share',
    ]) {
      expect(escapesStorageRoot(path), path).toBe(true);
    }
  });

  test('lets a name holding dots through', () => {
    for (const path of ['project-1/run-1/7/step-2..json', 'project-1/run-1/7/...', 'project-1/a..b/c.txt']) {
      expect(escapesStorageRoot(path), path).toBe(false);
    }
  });
});
