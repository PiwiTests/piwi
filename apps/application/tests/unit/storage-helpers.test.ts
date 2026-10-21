import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forEachLimited, uploadDirectory } from '../../server/utils/storage-helpers';
import type { StorageAdapter } from '../../server/storage/types';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('forEachLimited', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test('rejects with the first failure only once the tasks in flight have settled', async () => {
    const finished: string[] = [];
    const run = forEachLimited(['slow', 'fails'], 2, async (item) => {
      if (item === 'fails') throw new Error('write failed');
      await sleep(20);
      finished.push(item);
    });

    await expect(run).rejects.toThrow('write failed');
    expect(finished).toEqual(['slow']);
  });

  test('starts no new task after one fails', async () => {
    const started: number[] = [];
    const run = forEachLimited([0, 1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item);
      if (item === 1) throw new Error('write failed');
      await sleep(5);
    });

    await expect(run).rejects.toThrow('write failed');
    // Long enough for a worker still running to pick up the next item.
    await sleep(30);
    expect(started).toEqual([0, 1]);
  });
});

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
