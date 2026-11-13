import { describe, test, expect } from 'vitest';
import { openZipBlob, readZipDirectory, readZipEntries } from '../../app/demo/trace-zip.client';
import { buildBlobReport, buildTraceArchive } from '../utils/blob-report-fixture';

/**
 * The demo imports an archive by slicing the uploaded `File` rather than
 * reading it into memory, so the blob-backed reader has to agree entry for
 * entry with the buffer-backed one the committed demo traces still use.
 */
function toBlob(bytes: Buffer): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

describe('openZipBlob', () => {
  test('lists the same entries as the buffer reader, and reads them identically', async () => {
    const zip = buildBlobReport({
      tests: [{ testId: 't', title: 'checkout works', attempts: [{ status: 'passed', duration: 12 }] }],
    });

    const archive = await openZipBlob(toBlob(zip));
    const viaBuffer = await readZipEntries(new Uint8Array(zip), () => true);

    expect(archive.entryNames.sort()).toEqual(viaBuffer.map((entry) => entry.name).sort());
    expect(archive.entryNames).toContain('report.jsonl');

    for (const entry of viaBuffer) {
      const sliced = await archive.readEntry(entry.name);
      expect(sliced, entry.name).not.toBeNull();
      expect(Array.from(sliced!), entry.name).toEqual(Array.from(entry.data));
    }
  });

  test('reads a trace archive without ever holding it whole', async () => {
    const zip = buildTraceArchive({ title: 'tests/checkout.spec.ts:12:3 › pays' });
    const archive = await openZipBlob(toBlob(zip));

    expect(archive.entryNames.some((name) => name.endsWith('.trace'))).toBe(true);

    const trace = await archive.readEntry('test.trace');
    expect(trace).not.toBeNull();
    expect(new TextDecoder().decode(trace!)).toContain('context-options');
  });

  test('returns null for an entry the archive does not have', async () => {
    const archive = await openZipBlob(toBlob(buildTraceArchive()));
    expect(await archive.readEntry('nope.txt')).toBeNull();
  });

  test('rejects something that is not a ZIP at all', async () => {
    await expect(openZipBlob(new Blob(['not a zip, just some text']))).rejects.toThrow(/EOCD/);
  });

  test('finds the directory when a ZIP comment sits between it and the end', async () => {
    // A trailing comment pushes the EOCD record away from the last 22 bytes,
    // which is exactly what the tail slice has to be sized to survive.
    const zip = buildTraceArchive();
    const withComment = Buffer.concat([zip, Buffer.alloc(0)]);
    const commented = new Uint8Array(withComment);
    // Rewrite the EOCD comment length, then append the comment itself.
    const comment = new TextEncoder().encode('x'.repeat(4096));
    const view = new DataView(commented.buffer, commented.byteOffset, commented.byteLength);
    let eocd = -1;
    for (let i = commented.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    expect(eocd).toBeGreaterThan(-1);
    view.setUint16(eocd + 20, comment.length, true);

    const archive = await openZipBlob(new Blob([commented, comment]));
    expect(archive.entryNames).toEqual(readZipDirectory(new Uint8Array(zip)).map((meta) => meta.name));
  });
});
