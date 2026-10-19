import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadDirectory } from '../../server/utils/storage-helpers';
import type { StorageAdapter } from '../../server/storage/types';

let dir: string;

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('uploadDirectory', () => {
  test('copies a whole tree under the prefix, a few files at a time', async () => {
    dir = mkdtempSync(join(tmpdir(), 'piwi-upload-dir-'));
    mkdirSync(join(dir, 'data', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<html>');
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, 'data', i % 2 ? 'deep' : '', `${i}.js`), 'x'.repeat(i));

    const written = new Map<string, number>();
    let inFlight = 0;
    let peak = 0;
    const storage = {
      async writeFile(path: string, data: Buffer) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        written.set(path, data.length);
        inFlight--;
      },
    } as unknown as StorageAdapter;

    const size = await uploadDirectory(dir, 'project-1/run-1-html-report', storage);

    expect(written.size).toBe(41);
    expect(written.get('project-1/run-1-html-report/index.html')).toBe(6);
    expect(written.get('project-1/run-1-html-report/data/deep/39.js')).toBe(39);
    expect(written.get('project-1/run-1-html-report/data/38.js')).toBe(38);
    expect(size).toBe(6 + (39 * 40) / 2);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });
});
