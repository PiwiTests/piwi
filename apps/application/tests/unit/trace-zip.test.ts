import { describe, test, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { buildZip, decompressEntry, parseZip, parseZipDirectory, ZipLimitError } from '../../server/utils/trace-zip';
import { parseZipSync } from '../utils/zip';

describe('buildZip / parseZipSync round-trip', () => {
  test('stores and recovers every entry unchanged', () => {
    const entries = [
      { name: 'trace.trace', data: Buffer.from('{"type":"context"}\n') },
      { name: 'trace.network', data: Buffer.from('{"type":"network"}\n') },
      { name: 'resources/abc.bin', data: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) },
    ];
    const parsed = parseZipSync(buildZip(entries));
    expect(parsed).toHaveLength(3);
    for (const orig of entries) {
      const found = parsed.find((e) => e.name === orig.name);
      expect(found?.data.equals(orig.data)).toBe(true);
    }
  });

  test('round-trips several larger entries', () => {
    const large = Buffer.alloc(128 * 1024, 0x42);
    const parsed = parseZipSync(
      buildZip([
        { name: 'big1.dat', data: large },
        { name: 'big2.dat', data: large },
      ]),
    );
    expect(parsed).toHaveLength(2);
    for (const e of parsed) expect(e.data.equals(large)).toBe(true);
  });

  test('produces a valid empty archive', () => {
    expect(parseZipSync(buildZip([]))).toHaveLength(0);
  });
});

describe('buildZip compression (opt-in)', () => {
  const compressibleText = Buffer.from('{"type":"before","callId":"call@1","value":123}\n'.repeat(200), 'utf8');

  test('deflates a compressible entry, shrinks the archive, and round-trips it', () => {
    const stored = buildZip([{ name: 'trace.trace', data: compressibleText }]);
    const compressed = buildZip([{ name: 'trace.trace', data: compressibleText }], { compress: true });

    expect(compressed.length).toBeLessThan(stored.length);
    expect(parseZipDirectory(compressed)[0]!.method).toBe(8); // deflated
    expect(parseZipSync(compressed)[0]!.data.equals(compressibleText)).toBe(true);
  });

  test('stores an incompressible entry rather than growing it', () => {
    const highEntropy = randomBytes(8192);
    const [meta] = parseZipDirectory(buildZip([{ name: 'shot.png', data: highEntropy }], { compress: true }));
    expect(meta!.method).toBe(0); // stored — deflate would not have shrunk it
    expect(
      parseZipSync(buildZip([{ name: 'shot.png', data: highEntropy }], { compress: true }))[0]!.data.equals(
        highEntropy,
      ),
    ).toBe(true);
  });

  test('leaves tiny entries stored even when compression is requested', () => {
    const [meta] = parseZipDirectory(buildZip([{ name: 'small.txt', data: Buffer.from('short') }], { compress: true }));
    expect(meta!.method).toBe(0);
  });

  test('mixes deflated and stored entries in one archive and recovers all of them', () => {
    const png = randomBytes(4096);
    const zip = buildZip(
      [
        { name: 'trace.trace', data: compressibleText },
        { name: 'resources/shot.png', data: png },
      ],
      { compress: true },
    );
    const metas = parseZipDirectory(zip);
    expect(metas.find((m) => m.name === 'trace.trace')!.method).toBe(8);
    expect(metas.find((m) => m.name === 'resources/shot.png')!.method).toBe(0);

    const parsed = parseZipSync(zip);
    expect(parsed.find((e) => e.name === 'trace.trace')!.data.equals(compressibleText)).toBe(true);
    expect(parsed.find((e) => e.name === 'resources/shot.png')!.data.equals(png)).toBe(true);
  });
});

describe('buildZip bounded allocation', () => {
  test('rejects an entry whose size exceeds the cap without allocating it', () => {
    // A length taken from (hostile or corrupt) data that would drive a
    // multi-gigabyte allocation must be refused before any buffer is built.
    const oversized = { name: 'huge.bin', data: { length: 2 * 1024 * 1024 * 1024 } as unknown as Buffer };
    expect(() => buildZip([oversized])).toThrow();
  });

  test('rejects a negative or non-integer entry size', () => {
    expect(() => buildZip([{ name: 'bad.bin', data: { length: -1 } as unknown as Buffer }])).toThrow();
    expect(() => buildZip([{ name: 'bad.bin', data: { length: 1.5 } as unknown as Buffer }])).toThrow();
  });
});

describe('parseZip corrupt / oversized fields', () => {
  test('throws cleanly on data that is not a ZIP', () => {
    expect(() => parseZipSync(Buffer.from('definitely not a zip'))).toThrow();
    expect(() => parseZipSync(Buffer.alloc(0))).toThrow();
  });

  test('throws on a truncated archive rather than reading past the buffer', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hello world') }]);
    // Drop the central directory + EOCD so the directory parse cannot complete.
    const truncated = zip.subarray(0, 20);
    expect(() => parseZipDirectory(truncated)).toThrow();
  });

  test('skips an entry whose declared size runs past the buffer, keeping valid entries', () => {
    const zip = buildZip([
      { name: 'corrupt.dat', data: Buffer.from('AAAA') },
      { name: 'good.dat', data: Buffer.from('BBBB') },
    ]);

    // Overwrite the first central-directory entry's compressed-size field with a
    // value far larger than the archive. A naive parser would try to slice that
    // many bytes; the guard must skip the entry instead.
    const eocdOffset = zip.length - 22;
    const cdOffset = zip.readUInt32LE(eocdOffset + 16);
    expect(zip.readUInt32LE(cdOffset)).toBe(0x02014b50); // central-directory signature
    zip.writeUInt32LE(0xfffffff0, cdOffset + 20); // compressed size

    // The directory still parses (the field is not bounds-checked there)…
    const metas = parseZipDirectory(zip);
    expect(metas).toHaveLength(2);
    expect(metas[0]!.compressedSize).toBe(0xfffffff0);

    // …but decompression skips the corrupt entry and returns only the valid one,
    // never allocating the bogus length.
    const parsed = parseZipSync(zip);
    expect(parsed.map((e) => e.name)).toEqual(['good.dat']);
    expect(parsed[0]!.data.toString()).toBe('BBBB');
  });
});

/** A ZIP whose central directory lists `count` entries that all point at one deflated local entry. */
function sharedBytesZip(count: number, inflated: Buffer): Buffer {
  const name = Buffer.from('a.trace');
  const deflated = deflateRawSync(inflated);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(inflated.length, 22);
  local.writeUInt16LE(name.length, 26);
  const head = Buffer.concat([local, name, deflated]);
  const entries: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(inflated.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(0, 42); // every entry at the same local header
    entries.push(cd, name);
  }
  const cd = Buffer.concat(entries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(head.length, 16);
  return Buffer.concat([head, cd, eocd]);
}

describe('ZIP limits', () => {
  test('refuses entries that share their bytes', () => {
    const zip = sharedBytesZip(3, Buffer.alloc(1024, 0x61));
    expect(() => parseZipDirectory(zip)).toThrow(ZipLimitError);
    return expect(parseZip(zip)).rejects.toThrow(ZipLimitError);
  });

  test('refuses an archive whose entries declare more than its budget', () => {
    const zip = buildZip([
      { name: 'a.trace', data: Buffer.alloc(600, 0x61) },
      { name: 'b.trace', data: Buffer.alloc(600, 0x62) },
    ]);
    expect(() => parseZipDirectory(zip, { maxInflatedBytes: 1000 })).toThrow(ZipLimitError);
    expect(parseZipDirectory(zip, { maxInflatedBytes: 1200 })).toHaveLength(2);
  });

  test('an entry never inflates past the size it declares', async () => {
    const zip = buildZip([{ name: 'a.trace', data: Buffer.alloc(64 * 1024, 0x61) }], { compress: true });
    const [meta] = parseZipDirectory(zip);
    expect(meta!.method).toBe(8);
    await expect(decompressEntry(zip, meta!)).resolves.toHaveLength(64 * 1024);
    await expect(decompressEntry(zip, { ...meta!, uncompressedSize: 1024 })).rejects.toThrow();
  });
});
