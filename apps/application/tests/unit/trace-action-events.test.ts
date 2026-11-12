import { describe, expect, it, vi, beforeEach } from 'vitest';

/** The marks under the video read a trace's actions without inflating its other streams or touching the shared cache. */

const { files, reads, inflated } = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  reads: [] as string[],
  inflated: [] as string[],
}));
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async readFile(path: string) {
      reads.push(path);
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return bytes;
    },
  }),
}));
vi.mock('../../server/utils/trace-zip', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../server/utils/trace-zip')>();
  return {
    ...real,
    decompressTextEntries: (zip: Buffer, metas: Array<{ name: string }>) => {
      inflated.push(...metas.map((m) => m.name));
      return (real.decompressTextEntries as (z: Buffer, m: unknown) => unknown)(zip, metas);
    },
  };
});

const { loadStoredTraceActionEvents, loadStoredTraceEvents } = await import('../../server/utils/trace-evidence');
const { buildZip } = await import('../../server/utils/trace-zip');

const events = [
  { type: 'context-options', origin: 'library', wallTime: 1_000, monotonicTime: 0, browserName: 'chromium' },
  { type: 'before', callId: 'c1', startTime: 100, class: 'Frame', method: 'click', params: {}, pageId: 'p1' },
  { type: 'after', callId: 'c1', endTime: 200 },
];
const zip = buildZip(
  [
    { name: 'trace.trace', data: Buffer.from(events.map((e) => JSON.stringify(e)).join('\n')) },
    { name: 'trace.network', data: Buffer.from('') },
    { name: 'trace.stacks', data: Buffer.from('{}') },
    { name: 'screenshots/a.png', data: Buffer.from([0x89, 0x50]) },
  ],
  { compress: true },
);
const hashed = `project-1/blobs/${'a'.repeat(64)}.zip`;

beforeEach(() => {
  files.clear();
  reads.length = 0;
  inflated.length = 0;
  files.set(hashed, zip);
  files.set('legacy/trace.zip', zip);
});

describe('loadStoredTraceActionEvents', () => {
  it('parses the events and inflates only the .trace entries', async () => {
    const parsed = await loadStoredTraceActionEvents(hashed);
    expect(parsed?.actions).toHaveLength(1);
    expect(inflated).toEqual(['trace.trace']);
  });

  it('does not keep the trace, so the shared cache holds only what the other views loaded', async () => {
    await loadStoredTraceActionEvents(hashed);
    await loadStoredTraceActionEvents(hashed);
    expect(reads).toEqual([hashed, hashed]);
    // The shared loader still loads the trace itself: nothing of it was left behind by the marks.
    inflated.length = 0;
    await loadStoredTraceEvents(hashed);
    expect(inflated).toContain('trace.network');
  });

  it('reads from the shared trace when a view has already loaded it', async () => {
    await loadStoredTraceEvents(`project-1/blobs/${'a'.repeat(64)}.zip`);
    reads.length = 0;
    inflated.length = 0;
    const parsed = await loadStoredTraceActionEvents(hashed);
    expect(parsed?.actions).toHaveLength(1);
    expect(reads).toEqual([]);
    expect(inflated).toEqual([]);
  });

  it('is null for a trace that cannot be read', async () => {
    expect(await loadStoredTraceActionEvents('project-1/blobs/missing.zip')).toBeNull();
  });
});
