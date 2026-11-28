import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The routes that take a run's files as a multipart upload, streamed to temp files. */
const ROUTES = ['server/api/test-runs/upload.post.ts', 'server/api/test-runs/[id]/case-files.post.ts'];

describe('the upload routes store a file from its temp file', () => {
  test.each(ROUTES)('%s reads no uploaded file whole', (route) => {
    const source = readFileSync(join(__dirname, '../..', route), 'utf8');
    expect(source).not.toMatch(/\breadFile\(/);
    expect(source).toMatch(/\bwriteFileFrom\(/);
  });
});
