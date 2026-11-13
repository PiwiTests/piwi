import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';
import { readZipEntries } from '../../app/demo/trace-zip.client';
import { parseTraceTexts, traceFileRank } from '../../server/utils/trace-events';
import {
  extractDomSnapshot,
  DOM_SNAPSHOT_CAP_CHARS,
  type DomSnapshotResult,
} from '../../server/utils/dom-snapshot-render';
import { parseTraceEvents } from '../../server/utils/trace-parser';
import { buildZip } from '../../server/utils/trace-zip';

// The real committed demo traces the browser demo parses at runtime. These
// tests are the guard that a re-recorded trace (scripts/record-demo-media.mjs)
// still renders through the demo's browser path — one case per committed zip.
const TRACE_CASES = [
  { file: 'checkout-pay-timeout.zip', expectedContent: 'Checkout' },
  { file: 'email-label-renamed.zip', expectedContent: 'Checkout' },
  { file: 'button-strict-mode.zip', expectedContent: 'Components / Button' },
  { file: 'admin-dark-dashboard.zip', expectedContent: 'Monthly report' },
];

/** The demo service worker's trace path: DataView + DecompressionStream. */
async function browserPathSnapshot(zip: Uint8Array<ArrayBuffer>): Promise<DomSnapshotResult> {
  const traceEntries = (await readZipEntries(zip, (name) => name.endsWith('.trace'))).sort(
    (a, b) => traceFileRank(a.name) - traceFileRank(b.name),
  );
  const decoder = new TextDecoder();
  const data = parseTraceTexts(traceEntries.map((entry) => decoder.decode(entry.data)));
  return extractDomSnapshot(data, DOM_SNAPSHOT_CAP_CHARS);
}

describe('demo browser trace path (readZipEntries + parseTraceTexts)', () => {
  for (const { file, expectedContent } of TRACE_CASES) {
    describe(file, () => {
      const zipPath = fileURLToPath(new URL(`../../public/demo/traces/${file}`, import.meta.url));
      const zipBytes = new Uint8Array(readFileSync(zipPath));

      test('renders the failure-time DOM of the committed demo trace', async () => {
        const result = await browserPathSnapshot(zipBytes);
        expect(result.status).toBe('ok');
        expect(result.html).toBeTruthy();
        expect(result.html).toContain(expectedContent);
        expect(result.snapshotName).toBeTruthy();
        // The picker's proportion-preserving zoom needs the recorded viewport.
        expect(result.viewport?.width).toBeGreaterThan(0);
        expect(result.viewport?.height).toBeGreaterThan(0);
      });

      test('renders exactly what the server (node zlib) path renders', async () => {
        const browser = await browserPathSnapshot(zipBytes);
        const parsed = await parseTraceEvents(readFileSync(zipPath));
        expect(parsed).not.toBeNull();
        const server = extractDomSnapshot(parsed!, DOM_SNAPSHOT_CAP_CHARS);
        expect(browser).toEqual(server);
      });
    });
  }

  test('reads stored (uncompressed) entries and filters by name', async () => {
    // buildZip emits stored entries — the other ZIP layout the reader must handle.
    const zip = buildZip([
      { name: 'trace.trace', data: Buffer.from('{"type":"frame-snapshot","snapshot":{"html":["HTML",{}]}}') },
      { name: 'resources/blob.dat', data: Buffer.from('binary') },
    ]);
    const entries = await readZipEntries(new Uint8Array(zip), (name) => name.endsWith('.trace'));
    expect(entries.map((e) => e.name)).toEqual(['trace.trace']);
    expect(new TextDecoder().decode(entries[0]!.data)).toContain('frame-snapshot');
  });

  test('throws on a buffer that is not a ZIP', async () => {
    await expect(readZipEntries(new Uint8Array([1, 2, 3, 4]), () => true)).rejects.toThrow(/EOCD/);
  });
});
