import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  buildZip,
  decompressEntry,
  decompressFileEntry,
  openZipFile,
  parseZip,
  parseZipDirectory,
  readZipDirectory,
  ZipLimitError,
} from '../../server/utils/trace-zip';
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

describe('a ZIP read from a file, by position', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'piwi-zip-file-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  let count = 0;
  /** The archive in a file of its own, opened for reading by position. */
  async function onDisk(zip: Buffer) {
    const path = join(dir, `${++count}.zip`);
    writeFileSync(path, zip);
    return openZipFile(path);
  }

  test('reads the directory and every entry as the in-memory reader does', async () => {
    const entries = [
      { name: 'trace.trace', data: Buffer.from('{"type":"context"}\n'.repeat(500)) },
      { name: 'resources/abc.bin', data: randomBytes(70_000) },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ];
    for (const compress of [false, true]) {
      const zip = buildZip(entries, { compress });
      const file = await onDisk(zip);
      try {
        const metas = await readZipDirectory(file);
        expect(metas).toEqual(parseZipDirectory(zip));
        for (const meta of metas) {
          expect((await decompressFileEntry(file, meta)).equals(await decompressEntry(zip, meta))).toBe(true);
        }
      } finally {
        await file.close();
      }
    }
  });

  test('refuses what the in-memory reader refuses', async () => {
    const budget = buildZip([
      { name: 'a.trace', data: Buffer.alloc(600, 0x61) },
      { name: 'b.trace', data: Buffer.alloc(600, 0x62) },
    ]);
    const cases: [Buffer, { maxInflatedBytes?: number }, unknown][] = [
      [sharedBytesZip(3, Buffer.alloc(1024, 0x61)), {}, ZipLimitError],
      [budget, { maxInflatedBytes: 1000 }, ZipLimitError],
      [Buffer.from('definitely not a zip'), {}, /EOCD not found/],
      [buildZip([{ name: 'a.txt', data: Buffer.from('hello world') }]).subarray(0, 20), {}, /EOCD not found/],
    ];
    for (const [zip, options, refusal] of cases) {
      expect(() => parseZipDirectory(zip, options)).toThrow(refusal as never);
      const file = await onDisk(zip);
      await expect(readZipDirectory(file, options)).rejects.toThrow(refusal as never);
      await file.close();
    }
  });

  test('never reads an entry past the file, nor a central directory over 16 MiB', async () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('AAAA') }]);
    const file = await onDisk(zip);
    const [meta] = await readZipDirectory(file);
    await expect(decompressFileEntry(file, { ...meta!, compressedSize: 0xfffffff0 })).rejects.toThrow(/Truncated/);
    await file.close();

    // An end-of-directory record that says the directory starts at the file's first byte, 17 MiB before it.
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    const large = await onDisk(Buffer.concat([Buffer.alloc(17 * 1024 * 1024), eocd]));
    await expect(readZipDirectory(large)).rejects.toThrow(/central directory too large/);
    await large.close();
  });
});

describe('the checks both readers make as they read', () => {
  test('refuses an entry over the budget before reading a broken record after it', async () => {
    const zip = buildZip([
      { name: 'a.trace', data: Buffer.alloc(600, 0x61) },
      { name: 'b.trace', data: Buffer.alloc(600, 0x62) },
    ]);
    // Break the second central-directory record's signature.
    const eocd = zip.length - 22;
    const first = zip.readUInt32LE(eocd + 16);
    zip.writeUInt32LE(0, first + 46 + zip.readUInt16LE(first + 28));
    expect(() => parseZipDirectory(zip, { maxInflatedBytes: 500 })).toThrow(ZipLimitError);
    expect(() => parseZipDirectory(zip)).toThrow(/Invalid CD entry signature/);
    const dir = mkdtempSync(join(tmpdir(), 'piwi-zip-order-'));
    try {
      writeFileSync(join(dir, 'a.zip'), zip);
      const file = await openZipFile(join(dir, 'a.zip'));
      await expect(readZipDirectory(file, { maxInflatedBytes: 500 })).rejects.toThrow(ZipLimitError);
      await file.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never reads more deflated bytes than the size an entry declares allows', async () => {
    // One byte declared, 300 KiB of deflated data claimed for it.
    const zip = buildZip([{ name: 'a.trace', data: randomBytes(300 * 1024) }], { compress: true });
    const [stored] = parseZipDirectory(zip);
    const meta = { ...stored!, method: 8, uncompressedSize: 1 };
    await expect(decompressEntry(zip, meta)).rejects.toThrow(/larger than its declared size allows/);
    const dir = mkdtempSync(join(tmpdir(), 'piwi-zip-bound-'));
    try {
      writeFileSync(join(dir, 'a.zip'), zip);
      const file = await openZipFile(join(dir, 'a.zip'));
      await expect(decompressFileEntry(file, meta)).rejects.toThrow(/larger than its declared size allows/);
      await file.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Incompressible data deflates to a little more than its size, which is allowed.
    const incompressible = randomBytes(200_000);
    const deflated = deflateRawSync(incompressible);
    expect(deflated.length).toBeGreaterThan(incompressible.length);
    const one = buildZip([{ name: 'b.bin', data: incompressible }]);
    const [entry] = parseZipDirectory(one);
    const spliced = Buffer.concat([
      one.subarray(0, entry!.dataStart),
      deflated,
      one.subarray(entry!.dataStart + entry!.compressedSize),
    ]);
    // Rewrite the central directory as a deflated entry of that size.
    const cd = spliced.readUInt32LE(spliced.length - 22 + 16) + (deflated.length - entry!.compressedSize);
    spliced.writeUInt32LE(cd, spliced.length - 22 + 16);
    spliced.writeUInt16LE(8, cd + 10);
    spliced.writeUInt32LE(deflated.length, cd + 20);
    const [rewritten] = parseZipDirectory(spliced);
    expect((await decompressEntry(spliced, rewritten!)).equals(incompressible)).toBe(true);
  });

  test('reads thousands of small entries from a file, each as it is, also at once', async () => {
    const entries = Array.from({ length: 5000 }, (_, i) => ({ name: `screencast/${i}.jpeg`, data: randomBytes(64) }));
    const zip = buildZip(entries);
    const dir = mkdtempSync(join(tmpdir(), 'piwi-zip-ahead-'));
    try {
      writeFileSync(join(dir, 'a.zip'), zip);
      const file = await openZipFile(join(dir, 'a.zip'));
      const metas = await readZipDirectory(file);
      const read = await Promise.all(metas.map((meta) => decompressFileEntry(file, meta)));
      expect(read.map((data) => data.toString('hex'))).toEqual(entries.map((e) => e.data.toString('hex')));
      await file.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
