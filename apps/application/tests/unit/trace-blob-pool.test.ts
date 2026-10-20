import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openTempDb, type TempDb } from './temp-db';
import * as schema from '../../server/database/schema.sqlite';

// In-memory storage recording every write, and the test database behind
// `getDatabase`, shared with the mock factories through `vi.hoisted`.
const { storageFiles, writes, holder, failingReads } = vi.hoisted(() => ({
  storageFiles: new Map<string, Buffer>(),
  writes: [] as string[],
  holder: { db: null as unknown },
  // Paths whose read fails although the file exists, as a passing storage error does.
  failingReads: new Set<string>(),
}));
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async writeFile(path: string, data: Buffer) {
      writes.push(path);
      storageFiles.set(path, Buffer.from(data));
    },
    async readFile(path: string) {
      if (failingReads.has(path)) throw new Error(`503 Slow Down: ${path}`);
      const bytes = storageFiles.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return bytes;
    },
    async exists(path: string) {
      return storageFiles.has(path);
    },
    async fileSize(path: string) {
      return storageFiles.get(path)?.length ?? null;
    },
    async mkdir() {},
    async deleteFile(path: string) {
      storageFiles.delete(path);
    },
    async deleteDirectory(path: string) {
      for (const key of [...storageFiles.keys()]) if (key.startsWith(`${path}/`)) storageFiles.delete(key);
    },
  }),
}));
vi.mock('../../server/database', () => ({ getDatabase: async () => holder.db }));

delete process.env.PIWI_DATABASE_URL;

const { upsertTraceBlob, backfillTraceBlobStoredSizes, backfillTraceBlobResources } =
  await import('../../server/utils/trace-blobs');
const { reconstructTraceZip } = await import('../../server/utils/trace-reconstruct');
const { getTraceSnapshotResourceFromBlob } = await import('../../server/utils/trace-evidence');
const { gcTraceBlobs, reclaimOrphanTraceBlobs, reclaimOrphanTraceResources, ORPHAN_TRACE_BLOB_GRACE_MS } =
  await import('../../server/utils/delete-run-files');
const { withTracePoolIngest, reclaimTracePoolUnlessIngesting } = await import('../../server/utils/trace-pool-guard');
const { getStorageAnalysis } = await import('../../shared/handlers/admin-storage');
const { parseTraceManifest, pooledEntryPoolName, pooledTraceEntryName } =
  await import('../../server/utils/trace-manifest');
const { buildZip, parseZip, parseZipDirectory, ZipLimitError } = await import('../../server/utils/trace-zip');
const { LocalStorageAdapter } = await import('../../server/storage/local');

const png = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2]);
const jpeg = (seed: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, seed, seed + 1, seed + 2]);
const css = Buffer.from('body { color: red; }\n'.repeat(20), 'utf8');
/** Playwright names a snapshot resource by the SHA-1 of its bytes. */
const cssName = `${createHash('sha1').update(css).digest('hex')}.css`;

/**
 * A Playwright 1.63-shaped trace: two actions with before/after screenshots,
 * where the "after" of the first is the "before" of the second, two identical
 * screencast frames, one aria snapshot and one network resource.
 */
function buildTrace(screens: { c1Before: Buffer; c1After: Buffer; c2Before: Buffer }): Buffer {
  const events = [
    { type: 'before', callId: 'c1', startTime: 100, class: 'Frame', method: 'goto', pageId: 'p1' },
    { type: 'aria-snapshot', callId: 'c1', phase: 'before', file: 'aria/c1-before.json' },
    { type: 'screenshot', callId: 'c1', phase: 'before', file: 'screenshots/c1-before.png' },
    { type: 'screenshot', callId: 'c1', phase: 'after', file: 'screenshots/c1-after.png' },
    { type: 'after', callId: 'c1', endTime: 200 },
    { type: 'before', callId: 'c2', startTime: 300, class: 'Frame', method: 'click', pageId: 'p1' },
    { type: 'screenshot', callId: 'c2', phase: 'before', file: 'screenshots/c2-before.png' },
    { type: 'after', callId: 'c2', endTime: 400 },
  ];
  return buildZip(
    [
      { name: 'trace.trace', data: Buffer.from(events.map((e) => JSON.stringify(e)).join('\n'), 'utf8') },
      { name: 'trace.network', data: Buffer.from('', 'utf8') },
      { name: 'aria/c1-before.json', data: Buffer.from(JSON.stringify([{ role: 'document' }]), 'utf8') },
      { name: `resources/${cssName}`, data: css },
      { name: 'screenshots/c1-before.png', data: screens.c1Before },
      { name: 'screenshots/c1-after.png', data: screens.c1After },
      { name: 'screenshots/c2-before.png', data: screens.c2Before },
      { name: 'screencast/page@p1-1000.jpeg', data: jpeg(7) },
      { name: 'screencast/page@p1-1150.jpeg', data: jpeg(7) },
    ],
    { compress: true },
  );
}

/** Store a trace under the SHA-256 of its bytes, as every caller does. */
const ingestTrace = (trace: Buffer) => upsertTraceBlob(1, createHash('sha256').update(trace).digest('hex'), trace);

const poolWrites = () => writes.filter((p) => p.includes('/trace-resources/'));
const entryMap = (entries: { name: string; data: Buffer }[]) =>
  new Map(entries.map((e) => [e.name, e.data.toString('hex')]));

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  holder.db = db;
  storageFiles.clear();
  writes.length = 0;
  failingReads.clear();
  await db.insert(schema.projects).values({ id: 1, name: 'p1' });
});

afterEach(async () => {
  await close();
});

describe('upsertTraceBlob pools screenshots and screencast frames', () => {
  test('stores each distinct image once and keeps them out of the slim ZIP', async () => {
    const trace = buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) });
    const blob = await ingestTrace(trace);

    // The slim ZIP keeps the event streams and the aria snapshot only.
    const slimNames = parseZipDirectory(storageFiles.get(blob.path)!).map((e) => e.name);
    expect(slimNames.sort()).toEqual(['aria/c1-before.json', 'trace.network', 'trace.trace']);

    // Five image entries, three distinct contents: two screenshots and one frame, plus the CSS.
    expect(poolWrites()).toHaveLength(4);
    const manifest = parseTraceManifest(storageFiles.get(blob.path.replace(/\.zip$/, '.manifest.json'))!);
    expect(manifest.resources).toEqual([cssName]);
    const pooled = manifest.pooledEntries;
    expect(Object.keys(pooled).sort()).toEqual([
      'screencast/page@p1-1000.jpeg',
      'screencast/page@p1-1150.jpeg',
      'screenshots/c1-after.png',
      'screenshots/c1-before.png',
      'screenshots/c2-before.png',
    ]);
    expect(pooled['screenshots/c1-after.png']).toBe(pooled['screenshots/c2-before.png']);
    expect(pooled['screencast/page@p1-1000.jpeg']).toBe(pooled['screencast/page@p1-1150.jpeg']);
    expect(pooled['screenshots/c1-before.png']).toMatch(/^pooled-[0-9a-f]{64}\.png$/);

    // Every pool file is registered and linked to the blob, so GC sees it.
    const [row] = await db.select().from(schema.traceBlobs).where(eq(schema.traceBlobs.id, blob.id));
    const links = await db
      .select()
      .from(schema.traceBlobResources)
      .where(eq(schema.traceBlobResources.blobId, blob.id));
    expect(links).toHaveLength(4);
    expect(await db.select().from(schema.traceResources)).toHaveLength(4);

    // `size` stays what the user uploaded; `storedSize` is what the blob's own files take.
    const manifestBytes = storageFiles.get(blob.path.replace(/\.zip$/, '.manifest.json'))!.length;
    expect(row!.size).toBe(trace.length);
    expect(row!.storedSize).toBe(storageFiles.get(blob.path)!.length + manifestBytes);
    expect(row!.resourcesIndexed).toBe(true);
  });

  test('a later trace writes only the images the pool does not hold yet', async () => {
    await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    writes.length = 0;

    await ingestTrace(buildTrace({ c1Before: png(2), c1After: png(3), c2Before: png(3) }));

    // Only png(3) is new: png(2), the frame and the CSS are already pooled.
    expect(poolWrites()).toHaveLength(1);
  });

  test('a trace without resources still pools its screenshots', async () => {
    const trace = buildZip([
      { name: 'trace.trace', data: Buffer.from('{"type":"before","callId":"c1"}', 'utf8') },
      { name: 'screenshots/c1-before.png', data: png(9) },
    ]);
    const blob = await ingestTrace(trace);

    expect(parseZipDirectory(storageFiles.get(blob.path)!).map((e) => e.name)).toEqual(['trace.trace']);
    expect(poolWrites()).toHaveLength(1);
  });

  test('reconstruction restores every original entry, byte for byte', async () => {
    const trace = buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) });
    const blob = await ingestTrace(trace);

    // The storage mock implements every method reconstruction uses.
    const storage = (await import('../../server/storage')).getStorage();
    const rebuilt = await reconstructTraceZip(
      storage,
      storageFiles.get(blob.path)!,
      blob.path.replace(/\.zip$/, '.manifest.json'),
      'project-1/',
    );

    expect(rebuilt).not.toBeNull();
    expect(entryMap(await parseZip(rebuilt!))).toEqual(entryMap(await parseZip(trace)));
  });

  test('the screenshot view serves a pooled screenshot', async () => {
    const blob = await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));

    const shot = await getTraceSnapshotResourceFromBlob(blob.path, 'c2', 'screen', 'before');
    expect(shot?.contentType).toBe('image/png');
    expect(shot!.bytes.equals(png(2))).toBe(true);
    expect(await getTraceSnapshotResourceFromBlob(blob.path, 'c2', 'screen', 'after')).toBeNull();
  });
});

describe('pooled names cannot be planted', () => {
  test("a trace's resources/ entry under a server-only name stays in its own slim ZIP", async () => {
    // Trace 1 ships junk under the pool name trace 2's real screenshot will get.
    const planted = `resources/${pooledTraceEntryName('screenshots/c2-before.png', png(2))}`;
    const junk = Buffer.from('not the screenshot');
    const first = await ingestTrace(
      buildZip([
        { name: 'trace.trace', data: Buffer.from('{"type":"before","callId":"c0"}', 'utf8') },
        { name: planted, data: junk },
      ]),
    );
    expect(parseZipDirectory(storageFiles.get(first.path)!).map((e) => e.name)).toContain(planted);
    expect(poolWrites()).toHaveLength(0);

    const second = await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    const shot = await getTraceSnapshotResourceFromBlob(second.path, 'c2', 'screen', 'before');
    expect(shot!.bytes.equals(png(2))).toBe(true);
  });

  test("a resources/ entry whose bytes are not its name's SHA-1 stays in its own slim ZIP", async () => {
    // A name another trace's real stylesheet will have, with other bytes.
    const forged = `resources/${cssName}`;
    const first = await ingestTrace(
      buildZip([
        { name: 'trace.trace', data: Buffer.from('{"type":"before","callId":"c0"}', 'utf8') },
        { name: forged, data: Buffer.from('body { display: none; }') },
        { name: 'resources/src@4abfab78d432fdcee7aa7afcefcd17bffdb020ed.txt', data: Buffer.from('source') },
      ]),
    );
    const slim = parseZipDirectory(storageFiles.get(first.path)!).map((e) => e.name);
    expect(slim).toContain(forged);
    expect(slim).toContain('resources/src@4abfab78d432fdcee7aa7afcefcd17bffdb020ed.txt');
    expect(poolWrites()).toHaveLength(0);

    await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    expect(storageFiles.has(`project-1/trace-resources/${cssName}`)).toBe(true);
  });

  test('a trace whose bytes are not its hash is refused', async () => {
    const trace = buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) });
    await expect(upsertTraceBlob(1, 'f'.repeat(64), trace)).rejects.toMatchObject({ statusCode: 400 });
    expect(writes).toHaveLength(0);
  });

  test('an archive over the ZIP limits is refused, never stored as is', async () => {
    const trace = buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) });
    // Point every central-directory entry at the first local header: entries that share their bytes.
    const eocd = trace.length - 22;
    const count = trace.readUInt16LE(eocd + 10);
    let pos = trace.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      trace.writeUInt32LE(0, pos + 42);
      pos += 46 + trace.readUInt16LE(pos + 28) + trace.readUInt16LE(pos + 30) + trace.readUInt16LE(pos + 32);
    }
    await expect(ingestTrace(trace)).rejects.toThrow(ZipLimitError);
    expect(writes).toHaveLength(0);
  });

  test('an entry name such as constructor resolves to no pool file', () => {
    const manifest = parseTraceManifest(Buffer.from(JSON.stringify({ resources: [], pooledEntries: {} })));
    expect(pooledEntryPoolName(manifest, 'constructor')).toBeNull();
    expect(pooledEntryPoolName(manifest, '__proto__')).toBeNull();
    expect(pooledEntryPoolName(manifest, 'toString')).toBeNull();
  });
});

describe('reconstruction and storage errors', () => {
  async function rebuild(blobPath: string) {
    const storage = (await import('../../server/storage')).getStorage();
    return reconstructTraceZip(
      storage,
      storageFiles.get(blobPath)!,
      blobPath.replace(/\.zip$/, '.manifest.json'),
      'project-1/',
    );
  }

  test('a pooled file that is gone is left out of the rebuilt trace', async () => {
    const blob = await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    const manifest = parseTraceManifest(storageFiles.get(blob.path.replace(/\.zip$/, '.manifest.json'))!);
    storageFiles.delete(`project-1/trace-resources/${manifest.pooledEntries['screenshots/c1-before.png']}`);

    const names = (await parseZip((await rebuild(blob.path))!)).map((e) => e.name);
    expect(names).not.toContain('screenshots/c1-before.png');
    expect(names).toContain('screenshots/c1-after.png');
  });

  test('a pooled file that exists but cannot be read fails the rebuild instead of dropping the entry', async () => {
    const blob = await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    const manifest = parseTraceManifest(storageFiles.get(blob.path.replace(/\.zip$/, '.manifest.json'))!);
    failingReads.add(`project-1/trace-resources/${manifest.pooledEntries['screenshots/c1-before.png']}`);

    await expect(rebuild(blob.path)).rejects.toThrow('503 Slow Down');
  });
});

describe('screenshots and frames beyond one chunk', () => {
  // About 32 MB of image data crosses the chunk limit once; the round trip of
  // such a trace is covered above on a small one.
  test('are written once each across chunks', { timeout: 30_000 }, async () => {
    // The 32 MB screenshot closes the first chunk; the last one repeats the first, from the next chunk.
    const big = Buffer.concat([png(4), Buffer.alloc(32 * 1024 * 1024, 4)]);
    const trace = buildZip([
      { name: 'trace.trace', data: Buffer.from('{"type":"before","callId":"c1"}', 'utf8') },
      { name: 'screenshots/a.png', data: png(1) },
      { name: 'screenshots/b.png', data: big },
      { name: 'screenshots/c.png', data: png(1) },
    ]);
    const blob = await ingestTrace(trace);

    expect(poolWrites()).toHaveLength(2);
    const manifest = parseTraceManifest(storageFiles.get(blob.path.replace(/\.zip$/, '.manifest.json'))!);
    expect(manifest.pooledEntries['screenshots/c.png']).toBe(manifest.pooledEntries['screenshots/a.png']);
  });
});

describe('the pool guard', () => {
  test('a reclaim skips a project while one of its traces is ingested, and runs once it is done', async () => {
    let release!: () => void;
    const ingest = withTracePoolIngest(1, () => new Promise<void>((resolve) => (release = resolve)));

    expect(await reclaimTracePoolUnlessIngesting(1, async () => {})).toBe(false);
    expect(await reclaimTracePoolUnlessIngesting(2, async () => {})).toBe(true);

    release();
    await ingest;
    expect(await reclaimTracePoolUnlessIngesting(1, async () => {})).toBe(true);
  });

  test('an ingestion waits for a running reclaim of its project', async () => {
    const order: string[] = [];
    let release!: () => void;
    const reclaim = reclaimTracePoolUnlessIngesting(1, async () => {
      await new Promise<void>((resolve) => (release = resolve));
      order.push('reclaim');
    });
    const ingest = withTracePoolIngest(1, async () => {
      order.push('ingest');
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    release();
    await Promise.all([reclaim, ingest]);
    expect(order).toEqual(['reclaim', 'ingest']);
  });

  test('a delete during an ingestion keeps the pool, and the nightly sweep frees it afterwards', async () => {
    const first = await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    await ingestTrace(buildTrace({ c1Before: png(2), c1After: png(3), c2Before: png(3) }));
    const firstManifest = parseTraceManifest(storageFiles.get(first.path.replace(/\.zip$/, '.manifest.json'))!);
    const onlyInFirst = `project-1/trace-resources/${firstManifest.pooledEntries['screenshots/c1-before.png']}`;

    await withTracePoolIngest(1, () => gcTraceBlobs(db as never, [first.id]));
    expect(storageFiles.has(onlyInFirst)).toBe(true);

    expect(await reclaimOrphanTraceResources(db as never)).toBe(1);
    expect(storageFiles.has(onlyInFirst)).toBe(false);
  });
});

describe('the nightly sweep deletes traces no execution links', () => {
  async function linkedRun() {
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId: 1, status: 'passed', startTime: new Date() })
      .returning();
    return run!.id;
  }

  test('a blob unlinked past the grace period goes, with the pool files only it used', async () => {
    const orphan = await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    const linked = await ingestTrace(buildTrace({ c1Before: png(2), c1After: png(3), c2Before: png(3) }));
    const runId = await linkedRun();
    await db.insert(schema.files).values({ testRunId: runId, type: 'trace', path: linked.path, blobId: linked.id });
    const manifest = parseTraceManifest(storageFiles.get(orphan.path.replace(/\.zip$/, '.manifest.json'))!);
    const onlyInOrphan = `project-1/trace-resources/${manifest.pooledEntries['screenshots/c1-before.png']}`;
    const shared = `project-1/trace-resources/${manifest.pooledEntries['screenshots/c1-after.png']}`;

    // Within the grace period an upload may still be about to link it.
    expect(await reclaimOrphanTraceBlobs(db as never)).toBe(0);
    expect(storageFiles.has(orphan.path)).toBe(true);

    const later = Date.now() + ORPHAN_TRACE_BLOB_GRACE_MS + 60_000;
    expect(await reclaimOrphanTraceBlobs(db as never, later)).toBe(1);
    expect((await db.select().from(schema.traceBlobs)).map((b) => b.id)).toEqual([linked.id]);
    expect(storageFiles.has(orphan.path)).toBe(false);
    expect(storageFiles.has(onlyInOrphan)).toBe(false);
    expect(storageFiles.has(shared)).toBe(true);
    expect(storageFiles.has(linked.path)).toBe(true);
  });

  test('a project with a trace being ingested is left for the next sweep', async () => {
    await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    const later = Date.now() + ORPHAN_TRACE_BLOB_GRACE_MS + 60_000;

    let release!: () => void;
    const ingest = withTracePoolIngest(1, () => new Promise<void>((resolve) => (release = resolve)));
    expect(await reclaimOrphanTraceBlobs(db as never, later)).toBe(0);
    release();
    await ingest;
    expect(await reclaimOrphanTraceBlobs(db as never, later)).toBe(1);
  });
});

describe('pooled images are reference-counted', () => {
  test('deleting one trace frees only the images no other trace uses', async () => {
    const first = await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    await ingestTrace(buildTrace({ c1Before: png(2), c1After: png(3), c2Before: png(3) }));
    const firstManifest = parseTraceManifest(storageFiles.get(first.path.replace(/\.zip$/, '.manifest.json'))!);
    const onlyInFirst = firstManifest.pooledEntries['screenshots/c1-before.png']!;
    const shared = firstManifest.pooledEntries['screenshots/c1-after.png']!;

    // No `files` row references the first blob, so it goes.
    await gcTraceBlobs(db as never, [first.id]);

    expect(storageFiles.has(`project-1/trace-resources/${onlyInFirst}`)).toBe(false);
    expect(storageFiles.has(`project-1/trace-resources/${shared}`)).toBe(true);
    expect(storageFiles.has(`project-1/trace-resources/${cssName}`)).toBe(true);
  });

  test('the link backfill reads pooled entries from the manifest', async () => {
    const blob = await ingestTrace(buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    await db.delete(schema.traceBlobResources);
    await db.update(schema.traceBlobs).set({ resourcesIndexed: false });

    expect(await backfillTraceBlobResources(db as never)).toBe(1);

    const links = await db
      .select()
      .from(schema.traceBlobResources)
      .where(eq(schema.traceBlobResources.blobId, blob.id));
    expect(links).toHaveLength(4);
  });
});

describe('storage stats count what a blob occupies', () => {
  test('the size backfill measures blobs whose stored size is unknown', async () => {
    storageFiles.set('project-1/blobs/a.zip', Buffer.alloc(300));
    storageFiles.set('project-1/blobs/a.manifest.json', Buffer.alloc(20));
    await db.insert(schema.traceBlobs).values([
      { projectId: 1, hash: 'a', path: 'project-1/blobs/a.zip', size: 5000 },
      { projectId: 1, hash: 'gone', path: 'project-1/blobs/gone.zip', size: 700 },
      { projectId: 1, hash: 'done', path: 'project-1/blobs/done.zip', size: 900, storedSize: 90 },
    ]);

    expect(await backfillTraceBlobStoredSizes(db as never)).toBe(2);

    const sizes = Object.fromEntries((await db.select().from(schema.traceBlobs)).map((b) => [b.hash, b.storedSize]));
    expect(sizes).toEqual({ a: 320, gone: 0, done: 90 });
  });

  test('the analysis counts stored sizes and pool files once, falling back to the upload size', async () => {
    await db.insert(schema.traceBlobs).values([
      { projectId: 1, hash: 'slim', path: 'project-1/blobs/slim.zip', size: 10_000, storedSize: 1_000 },
      { projectId: 1, hash: 'old', path: 'project-1/blobs/old.zip', size: 2_000 },
    ]);
    await db
      .insert(schema.traceResources)
      .values({ projectId: 1, name: 'x.png', path: 'project-1/trace-resources/x.png', size: 4_000 });

    const analysis = await getStorageAnalysis(db as never);

    expect(analysis.totalBytes).toBe(1_000 + 2_000 + 4_000);
    expect(analysis.byKind.find((k) => k.kind === 'trace')?.bytes).toBe(7_000);
  });
});

describe('LocalStorageAdapter.fileSize', () => {
  test('reads the size without the file and answers null for a missing one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piwi-file-size-'));
    try {
      writeFileSync(join(dir, 'a.bin'), Buffer.alloc(1234));
      const storage = new LocalStorageAdapter(dir);
      expect(await storage.fileSize('a.bin')).toBe(1234);
      expect(await storage.fileSize('missing.bin')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseTraceManifest', () => {
  test('reads the older shape and drops pool names that are not a single safe segment', () => {
    expect(parseTraceManifest(Buffer.from(JSON.stringify({ resources: ['a.css'] })))).toEqual({
      resources: ['a.css'],
      pooledEntries: {},
    });
    const parsed = parseTraceManifest(
      Buffer.from(
        JSON.stringify({
          resources: ['ok.css', '../evil'],
          pooledEntries: { 'screenshots/a.png': 'abc.png', 'screenshots/b.png': '../../x', 'screenshots/c.png': 3 },
        }),
      ),
    );
    expect(parsed).toEqual({ resources: ['ok.css'], pooledEntries: { 'screenshots/a.png': 'abc.png' } });
  });
});
