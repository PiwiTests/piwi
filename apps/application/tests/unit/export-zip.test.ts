import { describe, it, expect } from 'vitest';
import { buildExportZip } from '../../shared/export/zip';
import { parseZipSync } from '../utils/zip';

/**
 * The export writer (fflate, deflating, isomorphic) and the trace reader
 * (hand-rolled, store-only) are different tools. These assert they speak the
 * same ZIP, which is what lets the demo build archives the server can read.
 */
describe('buildExportZip', () => {
  it('round-trips text through the trace-zip reader', () => {
    const zip = buildExportZip([
      { path: 'report.html', data: '<!DOCTYPE html><p>hello</p>' },
      { path: 'data.json', data: JSON.stringify({ a: 1 }) },
    ]);

    const entries = parseZipSync(Buffer.from(zip));
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.data.toString('utf8')]));
    expect(byName['report.html']).toBe('<!DOCTYPE html><p>hello</p>');
    expect(byName['data.json']).toBe('{"a":1}');
  });

  it('round-trips binary entries stored without compression', () => {
    const bytes = new Uint8Array(512);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;

    const entries = parseZipSync(Buffer.from(buildExportZip([{ path: 'a.png', data: bytes, precompressed: true }])));
    expect(entries).toHaveLength(1);
    expect(Uint8Array.from(entries[0]!.data)).toEqual(bytes);
  });

  it('actually deflates compressible text', () => {
    const text = 'x'.repeat(20_000);
    const deflated = buildExportZip([{ path: 'a.txt', data: text }]);
    const stored = buildExportZip([{ path: 'a.txt', data: text, precompressed: true }]);
    expect(deflated.length).toBeLessThan(stored.length / 2);
    expect(parseZipSync(Buffer.from(deflated))[0]!.data.toString('utf8')).toBe(text);
  });

  it('suffixes a duplicate path instead of overwriting the first entry', () => {
    const entries = parseZipSync(
      Buffer.from(
        buildExportZip([
          { path: 'evidence/shot.png', data: 'first' },
          { path: 'evidence/shot.png', data: 'second' },
        ]),
      ),
    );
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['evidence/shot-2.png', 'evidence/shot.png']);
  });

  it('writes an empty archive without corrupting it', () => {
    expect(parseZipSync(Buffer.from(buildExportZip([])))).toEqual([]);
  });
});
