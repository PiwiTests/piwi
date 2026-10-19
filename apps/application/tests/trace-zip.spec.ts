import { test, expect } from './fixtures';
import { deflateRawSync } from 'zlib';
import { buildZip } from '../server/utils/trace-zip';
import { parseZipSync as parseZip } from './utils/zip';

// Local CRC-32 needed only for the deflated-entry test that builds a raw ZIP
function crc32(buf: Buffer): number {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a raw ZIP with a single deflated (method=8) entry — bypasses buildZip which always stores. */
function buildDeflatedZip(name: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const compressed = deflateRawSync(data);
  const checksum = crc32(data);

  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  nameBytes.copy(local, 30);

  const cdOffset = local.length + compressed.length;
  const cd = Buffer.alloc(46 + nameBytes.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(8, 10); // deflate
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(checksum, 16);
  cd.writeUInt32LE(compressed.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBytes.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42); // local header at offset 0
  nameBytes.copy(cd, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([local, compressed, cd, eocd]);
}

test.describe('trace-zip: parseZip / buildZip', () => {
  test('round-trips all stored entries unchanged', () => {
    const entries = [
      { name: 'trace.trace', data: Buffer.from('{"type":"contextOptions","callId":"ctx@1"}\n') },
      { name: 'trace.network', data: Buffer.from('{"type":"network"}\n') },
      { name: 'resources/abc123.net', data: Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhello') },
    ];
    const zip = buildZip(entries);
    const parsed = parseZip(zip);

    expect(parsed).toHaveLength(3);
    for (const orig of entries) {
      const found = parsed.find((e) => e.name === orig.name);
      expect(found).toBeDefined();
      expect(found!.data.equals(orig.data)).toBe(true);
    }
  });

  test('preserves binary data unchanged', () => {
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const [entry] = parseZip(buildZip([{ name: 'binary.bin', data: binary }]));
    expect(entry.data.equals(binary)).toBe(true);
  });

  test('round-trips multiple large entries', () => {
    const large = Buffer.alloc(64 * 1024, 0x42);
    const entries = [
      { name: 'big1.dat', data: large },
      { name: 'big2.dat', data: large },
    ];
    const parsed = parseZip(buildZip(entries));
    expect(parsed).toHaveLength(2);
    for (const e of parsed) expect(e.data.equals(large)).toBe(true);
  });

  test('returns empty array for ZIP with no entries', () => {
    const zip = buildZip([]);
    expect(parseZip(zip)).toHaveLength(0);
  });

  test('handles empty (zero-byte) file entries', () => {
    const [entry] = parseZip(buildZip([{ name: 'empty.dat', data: Buffer.alloc(0) }]));
    expect(entry.name).toBe('empty.dat');
    expect(entry.data.length).toBe(0);
  });

  test('parses deflated (method=8) entries', () => {
    const data = Buffer.from('hello world '.repeat(100)); // repetition compresses well
    const zip = buildDeflatedZip('deflated.txt', data);
    const [entry] = parseZip(zip);
    expect(entry.name).toBe('deflated.txt');
    expect(entry.data.equals(data)).toBe(true);
  });

  test('throws on data that is not a ZIP', () => {
    expect(() => parseZip(Buffer.from('not a zip file at all'))).toThrow();
    expect(() => parseZip(Buffer.alloc(0))).toThrow();
  });

  test('round-trips entries with non-ASCII filenames', () => {
    const name = 'resources/тест-файл.net';
    const data = Buffer.from('content');
    const [entry] = parseZip(buildZip([{ name, data }]));
    expect(entry.name).toBe(name);
    expect(entry.data.equals(data)).toBe(true);
  });
});
