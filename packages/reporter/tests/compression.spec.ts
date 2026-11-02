import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { compressDirectory } from '../src/internal/files/compression.js';

/**
 * Decode the archive produced by compressDirectory: gunzip, then walk the
 * concatenation of length-prefixed [pathLen(4LE)][path][contentLen(4LE)][content]
 * records back into a { relPath -> content } map.
 */
function decodeArchive(archive: Buffer): Map<string, Buffer> {
  const buf = zlib.gunzipSync(archive);
  const out = new Map<string, Buffer>();
  let offset = 0;
  while (offset < buf.length) {
    const pathLen = buf.readUInt32LE(offset);
    offset += 4;
    const relPath = buf.subarray(offset, offset + pathLen).toString('utf8');
    offset += pathLen;
    const contentLen = buf.readUInt32LE(offset);
    offset += 4;
    const content = buf.subarray(offset, offset + contentLen);
    offset += contentLen;
    out.set(relPath, content);
  }
  return out;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-compress-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('compressDirectory', () => {
  it('produces a gzip-magic-prefixed buffer', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    const archive = await compressDirectory(tmpDir);
    expect(archive).toBeInstanceOf(Buffer);
    expect(archive[0]).toBe(0x1f);
    expect(archive[1]).toBe(0x8b);
  });

  it('round-trips a flat directory of files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'beta');
    const decoded = decodeArchive(await compressDirectory(tmpDir));
    expect(decoded.get('a.txt')?.toString('utf8')).toBe('alpha');
    expect(decoded.get('b.txt')?.toString('utf8')).toBe('beta');
    expect(decoded.size).toBe(2);
  });

  it('round-trips a nested directory tree with relative paths', async () => {
    fs.mkdirSync(path.join(tmpDir, 'data', 'traces'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'report.html'), 'REPORT');
    fs.writeFileSync(path.join(tmpDir, 'data', 'app.js'), 'APP');
    fs.writeFileSync(path.join(tmpDir, 'data', 'traces', 'trace.zip'), 'TRACE');
    const decoded = decodeArchive(await compressDirectory(tmpDir));
    expect(decoded.get('report.html')?.toString('utf8')).toBe('REPORT');
    expect(decoded.get('data/app.js')?.toString('utf8')).toBe('APP');
    expect(decoded.get('data/traces/trace.zip')?.toString('utf8')).toBe('TRACE');
    expect(decoded.size).toBe(3);
  });

  it('preserves binary content byte-for-byte', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(path.join(tmpDir, 'pixel.png'), bytes);
    const decoded = decodeArchive(await compressDirectory(tmpDir));
    expect(decoded.get('pixel.png')?.equals(bytes)).toBe(true);
  });

  it('names nested files with forward slashes on Windows too', async () => {
    vi.resetModules();
    // Windows joins relative paths with backslashes; the absolute folders of this machine stay readable.
    vi.doMock('node:path', async () => {
      const actual = await vi.importActual<typeof path>('node:path');
      const join = (...parts: string[]): string =>
        actual.isAbsolute(parts[0] ?? '') ? actual.join(...parts) : actual.win32.join(...parts);
      return { ...actual, default: { ...actual, join }, join };
    });
    try {
      const windows = await import('../src/internal/files/compression.js');
      fs.mkdirSync(path.join(tmpDir, 'data', 'traces'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'data', 'traces', 'trace.zip'), 'TRACE');
      const decoded = decodeArchive(await windows.compressDirectory(tmpDir));
      expect([...decoded.keys()]).toEqual(['data/traces/trace.zip']);
    } finally {
      vi.doUnmock('node:path');
      vi.resetModules();
    }
  });

  it('produces an empty (but valid) archive for an empty directory', async () => {
    const archive = await compressDirectory(tmpDir);
    expect(zlib.gunzipSync(archive).length).toBe(0);
    expect(decodeArchive(archive).size).toBe(0);
  });
});
