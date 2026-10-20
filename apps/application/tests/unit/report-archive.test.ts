import { describe, test, expect, beforeEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the helpers.
delete process.env.PIWI_DATABASE_URL;
const { readArchiveEntry, decompressDirectory } = await import('../../server/utils/compression');
const { readReportArchiveIndex, clearReportArchiveCache } = await import('../../server/utils/report-archive');

/** A report archive in the format the reporter uploads: length-prefixed path and content pairs, gzipped. */
function reportArchive(files: Array<[string, Buffer | string]>): Buffer {
  const parts: Buffer[] = [];
  for (const [path, content] of files) {
    const name = Buffer.from(path);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32LE(name.length);
    const contentLength = Buffer.alloc(4);
    contentLength.writeUInt32LE(data.length);
    parts.push(pathLength, name, contentLength, data);
  }
  return gzipSync(Buffer.concat(parts));
}

describe('readArchiveEntry', () => {
  test('returns the file asked for, past the files before it', async () => {
    const archive = reportArchive([
      ['data/trace.zip', Buffer.alloc(300 * 1024, 7)],
      ['index.html', '<html>report</html>'],
      ['data/other.js', 'x'],
    ]);
    expect((await readArchiveEntry(archive, 'index.html'))?.toString()).toBe('<html>report</html>');
    expect(await readArchiveEntry(archive, 'missing.html')).toBeNull();
  });

  test('stops inflating past its budget, and refuses a file over its cap', async () => {
    const archive = reportArchive([
      ['data/big.bin', Buffer.alloc(2 * 1024 * 1024)],
      ['index.html', '<html></html>'],
    ]);
    await expect(readArchiveEntry(archive, 'index.html', { maxInflatedBytes: 1024 * 1024 })).rejects.toThrow();
    await expect(readArchiveEntry(archive, 'big.bin', { maxEntryBytes: 1024 })).rejects.toThrow();
  });

  test('reads a malformed archive as holding nothing', async () => {
    expect(await readArchiveEntry(gzipSync(Buffer.from([0, 0, 0, 0, 1, 2, 3])), 'index.html')).toBeNull();
    expect(await readArchiveEntry(gzipSync(Buffer.from([5, 0, 0])), 'index.html')).toBeNull();
  });
});

describe('decompressDirectory', () => {
  async function extract(archive: Buffer) {
    const dir = await mkdtemp(join(tmpdir(), 'piwi-archive-'));
    try {
      await decompressDirectory(archive, join(dir, 'out'));
      const names = (await readdir(join(dir, 'out'), { recursive: true })).sort();
      return { names, index: await readFile(join(dir, 'out', 'index.html'), 'utf8').catch(() => null) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('writes every file of the archive under the directory', async () => {
    const archive = reportArchive([
      ['index.html', '<html>report</html>'],
      ['data/trace.zip', Buffer.alloc(300 * 1024, 7)],
      ['data/empty.txt', ''],
    ]);
    expect(await extract(archive)).toEqual({
      names: ['data', 'data/empty.txt', 'data/trace.zip', 'index.html'],
      index: '<html>report</html>',
    });
  });

  test('refuses a path that leaves the directory, and a malformed or truncated archive', async () => {
    await expect(extract(reportArchive([['../evil.html', 'x']]))).rejects.toThrow(/path traversal/);
    await expect(extract(gzipSync(Buffer.from([0, 0, 0, 0, 1, 2, 3])))).rejects.toThrow();
    const archive = gzipSync(
      Buffer.concat([Buffer.from([10, 0, 0, 0]), Buffer.from('index.html'), Buffer.from([9, 0, 0, 0, 1])]),
    );
    await expect(extract(archive)).rejects.toThrow(/ends inside a record/);
  });
});

describe('readReportArchiveIndex', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const archive = reportArchive([['index.html', '<html>cached</html>']]);

  beforeEach(async () => {
    clearReportArchiveCache();
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    await db.insert(schema.projects).values([
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Beta' },
    ]);
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
    await db.insert(schema.files).values([
      { testRunId: 1, type: 'report', subtype: 'html', path: 'project-1/run-1-report.gz' },
      { testRunId: 1, type: 'attachment', path: 'project-1/run-1/7/logs.gz' },
    ]);
  });

  test('reads a report archive once for every request, and keeps the answer', async () => {
    const read = vi.fn(async () => archive);
    const answers = await Promise.all([
      readReportArchiveIndex(db as never, 1, 'project-1/run-1-report.gz', read),
      readReportArchiveIndex(db as never, 1, 'project-1/run-1-report.gz', read),
    ]);
    expect(answers.map((html) => html?.toString())).toEqual(['<html>cached</html>', '<html>cached</html>']);
    expect((await readReportArchiveIndex(db as never, 1, 'project-1/run-1-report.gz', read))?.toString()).toBe(
      '<html>cached</html>',
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('never inflates a .gz that is not a report archive of the project', async () => {
    const read = vi.fn(async () => archive);
    expect(await readReportArchiveIndex(db as never, 1, 'project-1/run-1/7/logs.gz', read)).toBeNull();
    expect(await readReportArchiveIndex(db as never, 2, 'project-1/run-1-report.gz', read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
