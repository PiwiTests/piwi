import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openTempDb, type TempDb } from './temp-db';
import * as schema from '../../server/database/schema.sqlite';

// In-memory storage recording every write, and the test database behind
// `getDatabase`, shared with the mock factories through `vi.hoisted`.
const { storageFiles, writes, holder } = vi.hoisted(() => ({
  storageFiles: new Map<string, Buffer>(),
  writes: [] as string[],
  holder: { db: null as unknown },
}));
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async writeFile(path: string, data: Buffer) {
      writes.push(path);
      storageFiles.set(path, Buffer.from(data));
    },
    async readFile(path: string) {
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
const { gcTraceBlobs } = await import('../../server/utils/delete-run-files');
const { getStorageAnalysis } = await import('../../shared/handlers/admin-storage');
const { parseTraceManifest } = await import('../../server/utils/trace-manifest');
const { buildZip, parseZip, parseZipDirectory } = await import('../../server/utils/trace-zip');
const { LocalStorageAdapter } = await import('../../server/storage/local');

const png = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2]);
const jpeg = (seed: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, seed, seed + 1, seed + 2]);
const css = Buffer.from('body { color: red; }\n'.repeat(20), 'utf8');

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
      { name: 'resources/0a1b2c.css', data: css },
      { name: 'screenshots/c1-before.png', data: screens.c1Before },
      { name: 'screenshots/c1-after.png', data: screens.c1After },
      { name: 'screenshots/c2-before.png', data: screens.c2Before },
      { name: 'screencast/page@p1-1000.jpeg', data: jpeg(7) },
      { name: 'screencast/page@p1-1150.jpeg', data: jpeg(7) },
    ],
    { compress: true },
  );
}

/** A distinct SHA-256-shaped hash per trace, so each lands on its own content-addressed path. */
let hashCounter = 0;
const nextHash = () => (++hashCounter).toString(16).padStart(64, '0');

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
  await db.insert(schema.projects).values({ id: 1, name: 'p1' });
});

afterEach(async () => {
  await close();
});

describe('upsertTraceBlob pools screenshots and screencast frames', () => {
  test('stores each distinct image once and keeps them out of the slim ZIP', async () => {
    const trace = buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) });
    const blob = await upsertTraceBlob(1, nextHash(), trace);

    // The slim ZIP keeps the event streams and the aria snapshot only.
    const slimNames = parseZipDirectory(storageFiles.get(blob.path)!).map((e) => e.name);
    expect(slimNames.sort()).toEqual(['aria/c1-before.json', 'trace.network', 'trace.trace']);

    // Five image entries, three distinct contents: two screenshots and one frame, plus the CSS.
    expect(poolWrites()).toHaveLength(4);
    const manifest = parseTraceManifest(storageFiles.get(blob.path.replace(/\.zip$/, '.manifest.json'))!);
    expect(manifest.resources).toEqual(['0a1b2c.css']);
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
    expect(pooled['screenshots/c1-before.png']).toMatch(/^[0-9a-f]{40}\.png$/);

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
    await upsertTraceBlob(1, nextHash(), buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }));
    writes.length = 0;

    await upsertTraceBlob(1, nextHash(), buildTrace({ c1Before: png(2), c1After: png(3), c2Before: png(3) }));

    // Only png(3) is new: png(2), the frame and the CSS are already pooled.
    expect(poolWrites()).toHaveLength(1);
  });

  test('a trace without resources still pools its screenshots', async () => {
    const trace = buildZip([
      { name: 'trace.trace', data: Buffer.from('{"type":"before","callId":"c1"}', 'utf8') },
      { name: 'screenshots/c1-before.png', data: png(9) },
    ]);
    const blob = await upsertTraceBlob(1, nextHash(), trace);

    expect(parseZipDirectory(storageFiles.get(blob.path)!).map((e) => e.name)).toEqual(['trace.trace']);
    expect(poolWrites()).toHaveLength(1);
  });

  test('reconstruction restores every original entry, byte for byte', async () => {
    const trace = buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) });
    const blob = await upsertTraceBlob(1, nextHash(), trace);

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
    const blob = await upsertTraceBlob(
      1,
      nextHash(),
      buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }),
    );

    const shot = await getTraceSnapshotResourceFromBlob(blob.path, 'c2', 'screen', 'before');
    expect(shot?.contentType).toBe('image/png');
    expect(shot!.bytes.equals(png(2))).toBe(true);
    expect(await getTraceSnapshotResourceFromBlob(blob.path, 'c2', 'screen', 'after')).toBeNull();
  });
});

describe('pooled images are reference-counted', () => {
  test('deleting one trace frees only the images no other trace uses', async () => {
    const first = await upsertTraceBlob(
      1,
      nextHash(),
      buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }),
    );
    await upsertTraceBlob(1, nextHash(), buildTrace({ c1Before: png(2), c1After: png(3), c2Before: png(3) }));
    const firstManifest = parseTraceManifest(storageFiles.get(first.path.replace(/\.zip$/, '.manifest.json'))!);
    const onlyInFirst = firstManifest.pooledEntries['screenshots/c1-before.png']!;
    const shared = firstManifest.pooledEntries['screenshots/c1-after.png']!;

    // No `files` row references the first blob, so it goes.
    await gcTraceBlobs(db as never, [first.id]);

    expect(storageFiles.has(`project-1/trace-resources/${onlyInFirst}`)).toBe(false);
    expect(storageFiles.has(`project-1/trace-resources/${shared}`)).toBe(true);
    expect(storageFiles.has('project-1/trace-resources/0a1b2c.css')).toBe(true);
  });

  test('the link backfill reads pooled entries from the manifest', async () => {
    const blob = await upsertTraceBlob(
      1,
      nextHash(),
      buildTrace({ c1Before: png(1), c1After: png(2), c2Before: png(2) }),
    );
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
  test('the size backfill measures blobs stored before the column existed', async () => {
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
