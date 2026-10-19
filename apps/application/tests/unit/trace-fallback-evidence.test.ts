import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';
import { parseZipSync } from '../utils/zip';
import { parseTraceTexts, traceFileRank } from '../../server/utils/trace-events';
import { parseNetworkTexts } from '../../server/utils/trace-insights';
import { consoleLogsFromTrace } from '../../server/utils/import-evidence';
import { buildNetworkRequestItems } from '../../server/utils/network-request-helpers';
import { traceNetworkRequestsFromSnapshots } from '../../server/utils/trace-fallback-evidence';

/** Read a committed sample trace and split it into the streams the derivation reads. */
function readSampleTrace(file: string) {
  const zipPath = fileURLToPath(new URL(`../../public/demo/traces/${file}`, import.meta.url));
  const entries = parseZipSync(readFileSync(zipPath));
  const traceTexts = entries
    .filter((e) => e.name.endsWith('.trace'))
    .sort((a, b) => traceFileRank(a.name) - traceFileRank(b.name))
    .map((e) => e.data.toString('utf8'));
  const networkTexts = entries.filter((e) => e.name.endsWith('.network')).map((e) => e.data.toString('utf8'));
  return { parsed: parseTraceTexts(traceTexts), network: parseNetworkTexts(networkTexts) };
}

describe('traceNetworkRequestsFromSnapshots', () => {
  test('recovers the request list from a failing run trace, restricted to fixture resource types', () => {
    const { network } = readSampleTrace('checkout-pay-timeout.zip');
    const raw = traceNetworkRequestsFromSnapshots(network);

    const byUrl = new Map(raw.map((r) => [String(r.url).replace(/^https?:\/\/[^/]+/, ''), r]));

    // The document navigation is kept and typed.
    const doc = byUrl.get('/checkout');
    expect(doc).toBeTruthy();
    expect(doc!.method).toBe('GET');
    expect(doc!.status).toBe(200);
    expect(doc!.resourceType).toBe('document');
    expect(doc!.duration).toBe(8); // rounded from 7.835ms
    expect(typeof doc!.startTime).toBe('number');

    // The aborted API request the fixtures never capture is recovered from the trace.
    const quote = byUrl.get('/api/quote');
    expect(quote).toBeTruthy();
    expect(quote!.status).toBe(-1);
    expect(quote!.resourceType).toBe('other');
    // A negative HAR time is stored as no duration rather than a bogus -1.
    expect(quote!.duration).toBeNull();
  });

  test('feeds through the ingest pipeline into stored request rows', () => {
    const { network } = readSampleTrace('checkout-pay-timeout.zip');
    const items = buildNetworkRequestItems(traceNetworkRequestsFromSnapshots(network));

    expect(items.length).toBe(2);
    for (const item of items) {
      expect(item.method).toBe('GET');
      expect(item.url).toMatch(/\/(checkout|api\/quote)$/);
      expect(['document', 'other']).toContain(item.resourceType);
      expect(item.normalizedUrl).toBeTruthy();
    }
  });

  test('drops static assets the fixtures never keep', () => {
    const raw = traceNetworkRequestsFromSnapshots([
      {
        request: { method: 'GET', url: 'https://app.test/main.css' },
        response: { status: 200, content: { mimeType: 'text/css' } },
      },
      {
        request: { method: 'GET', url: 'https://app.test/logo.png' },
        response: { status: 200, content: { mimeType: 'image/png' } },
      },
      {
        request: { method: 'GET', url: 'https://app.test/api/user' },
        response: { status: 200, content: { mimeType: 'application/json' } },
      },
    ]);
    const items = buildNetworkRequestItems(raw);
    // Only the JSON API call survives the fixture resource-type filter.
    expect(items.map((i) => i.url)).toEqual(['https://app.test/api/user']);
    expect(items[0]!.resourceType).toBe('fetch');
  });
});

describe('consoleLogsFromTrace on sample traces', () => {
  test('recovers the failure-time console error from the trace stream', () => {
    const { parsed } = readSampleTrace('checkout-pay-timeout.zip');
    const entries = consoleLogsFromTrace(parsed, 1_784_388_642_000);
    expect(entries).not.toBeNull();
    expect(entries!.length).toBeGreaterThan(0);
    // Only warning/error/assert survive — every recovered entry is one of them.
    for (const entry of entries!) {
      expect(['warning', 'error', 'assert']).toContain(entry.type);
      expect(typeof entry.text).toBe('string');
    }
  });
});
