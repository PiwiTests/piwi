import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, expect } from 'vitest';
import {
  buildTraceBodyPreview,
  buildTraceCallStack,
  buildTraceNetwork,
  buildTraceSnapshots,
  maskBodyText,
  maskHeaders,
  matchNetworkBodySha1,
  parseNetworkTexts,
  parseStacksTexts,
  sha1Hex,
  type TraceResourceReader,
  type TraceResourceSnapshot,
} from '../../server/utils/trace-insights';
import { parseTraceTexts, type ParsedTraceData, type TraceAction } from '../../server/utils/trace-events';
import { parseZipSync } from '../utils/zip';

function makeAction(overrides: Partial<TraceAction> = {}): TraceAction {
  return { callId: 'call@1', apiName: 'locator.click', startTime: 1000, ...overrides };
}

function makeParsed(overrides: Partial<ParsedTraceData> = {}): ParsedTraceData {
  const failingAction = 'failingAction' in overrides ? (overrides.failingAction ?? null) : makeAction();
  return {
    actions: failingAction ? [failingAction] : [],
    consoleEntries: [],
    networkRequests: [],
    frameSnapshots: [],
    failingAction,
    failingActionIndex: failingAction ? 0 : -1,
    eventCount: 0,
    timeoutFallback: false,
    traceEndTime: 0,
    ...overrides,
  };
}

/** A reader over an in-memory resources/ map. */
function mapReader(entries: Record<string, string>): TraceResourceReader {
  return async (name) => {
    const value = entries[name];
    return value === undefined ? null : new TextEncoder().encode(value);
  };
}

describe('parseStacksTexts', () => {
  test('parses the modern format with numeric call ids into call@N keys', () => {
    const text = JSON.stringify({
      files: ['/home/ci/app/tests/checkout.spec.ts'],
      stacks: [
        [6, [[0, 125, 40, 'main']]],
        [
          18,
          [
            [0, 105, 6, 'runScenario'],
            [0, 127, 3, 'async main'],
          ],
        ],
      ],
    });
    const index = parseStacksTexts([text]);
    expect(index).not.toBeNull();
    expect(index!.files).toEqual(['/home/ci/app/tests/checkout.spec.ts']);
    expect(index!.byCallId.get('call@18')).toEqual([
      [0, 105, 6, 'runScenario'],
      [0, 127, 3, 'async main'],
    ]);
  });

  test('accepts string call ids and merges multiple documents with file-index offsets', () => {
    const a = JSON.stringify({ files: ['/a.ts'], stacks: [['call@1', [[0, 10, 1, 'fnA']]]] });
    const b = JSON.stringify({ files: ['/b.ts'], stacks: [[2, [[0, 20, 1, 'fnB']]]] });
    const index = parseStacksTexts([a, b]);
    expect(index!.files).toEqual(['/a.ts', '/b.ts']);
    expect(index!.byCallId.get('call@1')).toEqual([[0, 10, 1, 'fnA']]);
    // Second document's file index 0 is offset to point at /b.ts.
    expect(index!.byCallId.get('call@2')).toEqual([[1, 20, 1, 'fnB']]);
  });

  test('tolerates garbage without throwing and returns null when nothing parsed', () => {
    expect(parseStacksTexts(['not json', JSON.stringify({ nope: true }), JSON.stringify([1, 2])])).toBeNull();
    expect(parseStacksTexts([])).toBeNull();
  });
});

describe('sha1Hex', () => {
  test('produces the standard hex digest', async () => {
    expect(await sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
});

describe('buildTraceCallStack', () => {
  const specAbs = '/home/ci/repo/tests/checkout.spec.ts';
  const helperAbs = '/home/ci/repo/helpers/pay.ts';
  const depAbs = '/home/ci/repo/node_modules/lib/index.js';

  async function makeStacks() {
    return {
      files: [helperAbs, specAbs, depAbs],
      byCallId: new Map([
        [
          'call@2',
          [
            [0, 3, 5, 'payWithCard'] as [number, number, number, string?],
            [2, 1, 1, 'libCall'] as [number, number, number, string?],
            [1, 12, 9, 'checkout test'] as [number, number, number, string?],
          ],
        ],
      ]),
    };
  }

  const helperSource = Array.from({ length: 30 }, (_, i) => `helper line ${i + 1}`).join('\n');
  const specSource = Array.from({ length: 30 }, (_, i) => `spec line ${i + 1}`).join('\n');

  test('resolves source windows, project-relative paths and in-project flags', async () => {
    const parsed = makeParsed({
      failingAction: makeAction({ callId: 'call@2', apiName: 'Frame.click', error: { message: 'boom' } }),
    });
    const reader = mapReader({
      [`src@${await sha1Hex(helperAbs)}.txt`]: helperSource,
      [`src@${await sha1Hex(specAbs)}.txt`]: specSource,
    });
    const result = await buildTraceCallStack(parsed, await makeStacks(), reader, {
      knownTestFilePath: 'tests/checkout.spec.ts',
      contextLines: 2,
    });

    expect(result.status).toBe('ok');
    expect(result.apiName).toBe('Frame.click');
    expect(result.errorMessage).toBe('boom');
    expect(result.hasSources).toBe(true);
    expect(result.frames).toHaveLength(3);

    const [helper, dep, spec] = result.frames!;
    expect(helper).toMatchObject({ file: 'helpers/pay.ts', line: 3, inProject: true, functionName: 'payWithCard' });
    expect(helper!.source).toEqual({
      startLine: 1,
      lines: ['helper line 1', 'helper line 2', 'helper line 3', 'helper line 4', 'helper line 5'],
      totalLines: 30,
    });
    expect(dep).toMatchObject({ file: 'node_modules/lib/index.js', inProject: false, source: null });
    expect(spec).toMatchObject({ file: 'tests/checkout.spec.ts', line: 12, inProject: true });
    expect(spec!.source?.startLine).toBe(10);
    expect(spec!.source?.lines).toHaveLength(5);
  });

  test('degrades to source: null frames when the trace has no embedded sources', async () => {
    const parsed = makeParsed({ failingAction: makeAction({ callId: 'call@2' }) });
    const result = await buildTraceCallStack(parsed, await makeStacks(), mapReader({}), {
      knownTestFilePath: 'tests/checkout.spec.ts',
    });
    expect(result.status).toBe('ok');
    expect(result.hasSources).toBe(false);
    expect(result.frames!.every((f) => f.source === null)).toBe(true);
  });

  test('falls back to the nearest preceding action with a stack and reports its apiName', async () => {
    const first = makeAction({ callId: 'call@2', apiName: 'Frame.goto' });
    const failing = makeAction({ callId: 'call@9', apiName: 'Frame.click', error: { message: 'x' } });
    const parsed = makeParsed({ actions: [first, failing], failingAction: failing, failingActionIndex: 1 });
    const result = await buildTraceCallStack(parsed, await makeStacks(), mapReader({}), {});
    expect(result.status).toBe('ok');
    expect(result.apiName).toBe('Frame.goto');
  });

  test('returns no-stacks when the index is missing or no action has a stack', async () => {
    const parsed = makeParsed({ failingAction: makeAction({ callId: 'call@404' }) });
    expect((await buildTraceCallStack(parsed, null, mapReader({}), {})).status).toBe('no-stacks');
    const emptyIndex = { files: [], byCallId: new Map() };
    expect((await buildTraceCallStack(parsed, emptyIndex, mapReader({}), {})).status).toBe('no-stacks');
  });

  test('normalizes Windows paths for display and root inference', async () => {
    const winSpec = String.raw`C:\ci\repo\tests\login.spec.ts`;
    const stacks = {
      files: [winSpec],
      byCallId: new Map([['call@1', [[0, 5, 1, 'test'] as [number, number, number, string?]]]]),
    };
    const parsed = makeParsed({ failingAction: makeAction({ callId: 'call@1' }) });
    const result = await buildTraceCallStack(parsed, stacks, mapReader({}), {
      knownTestFilePath: 'tests/login.spec.ts',
    });
    expect(result.frames![0]).toMatchObject({ file: 'tests/login.spec.ts', inProject: true });
  });
});

describe('maskHeaders / maskBodyText', () => {
  test('masks sensitive header names and token-shaped values, keeps ordinary headers', () => {
    const masked = maskHeaders([
      { name: 'Authorization', value: 'Bearer abc123' },
      { name: 'Cookie', value: 'session=xyz' },
      { name: 'X-Custom-Token', value: 'v' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Trace', value: 'eyJabcdefghij.abcde.abcde' },
    ]);
    expect(masked).toEqual([
      { name: 'Authorization', value: '[masked]' },
      { name: 'Cookie', value: '[masked]' },
      { name: 'X-Custom-Token', value: '[masked]' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Trace', value: '[masked-token]' },
    ]);
  });

  test('masks JWTs, long hex and data URIs inside bodies and honors the cap', () => {
    const body = `token=eyJabcdefghij.abcde.abcde hex=${'a'.repeat(40)} data:image/png;base64,AAAA rest`;
    const { content, truncated } = maskBodyText(body, 10_000);
    expect(truncated).toBe(false);
    expect(content).toContain('[masked-token]');
    expect(content).toContain('[masked-hex]');
    expect(content).toContain('data:[masked]');
    expect(maskBodyText('x'.repeat(20), 10)).toEqual({ content: 'x'.repeat(10), truncated: true });
  });
});

describe('buildTraceNetwork', () => {
  function snapshot(overrides: Partial<TraceResourceSnapshot> = {}): TraceResourceSnapshot {
    return {
      startedDateTime: '2026-07-11T15:50:59.282Z',
      time: 20,
      request: { method: 'GET', url: 'https://x.test/page', headers: [], bodySize: 0 },
      response: { status: 200, statusText: 'OK', headers: [], content: { size: 100, mimeType: 'text/html' } },
      timings: { dns: -1, connect: -1, ssl: -1, send: 0, wait: 3, receive: 17 },
      _monotonicTime: 1000,
      ...overrides,
    };
  }

  test('builds a relative timeline and flags requests overlapping the failing window', () => {
    const failing = makeAction({ callId: 'call@9', startTime: 2500, endTime: 3000, error: { message: 'boom' } });
    const parsed = makeParsed({ failingAction: failing });
    const result = buildTraceNetwork(parsed, [
      snapshot({ _monotonicTime: 1000 }),
      snapshot({
        _monotonicTime: 2600,
        time: 300,
        request: { method: 'POST', url: 'https://x.test/api/payments', headers: [] },
        response: {
          status: 500,
          statusText: 'Server Error',
          headers: [],
          content: { size: 20, mimeType: 'application/json', _sha1: 'a'.repeat(40) + '.json' },
        },
      }),
    ]);

    expect(result.status).toBe('ok');
    expect(result.requests).toHaveLength(2);
    const [first, second] = result.requests!;
    expect(first).toMatchObject({ start: 0, duration: 20, duringFailure: false, failed: false });
    expect(second).toMatchObject({
      start: 1600,
      duration: 300,
      duringFailure: true,
      failed: true,
      status: 500,
      bodyPreviewable: true,
    });
    expect(result.failingWindow).toEqual({ start: 500, end: 2000 });
    expect(result.timelineDuration).toBe(1900);
  });

  test('falls back to startedDateTime deltas (no failure correlation) when monotonic time is missing', () => {
    const parsed = makeParsed({ failingAction: makeAction({ startTime: 100, endTime: 200 }) });
    const result = buildTraceNetwork(parsed, [
      snapshot({ _monotonicTime: undefined, startedDateTime: '2026-07-11T15:50:59.000Z' }),
      snapshot({ _monotonicTime: undefined, startedDateTime: '2026-07-11T15:51:00.500Z' }),
    ]);
    expect(result.requests![0]!.start).toBe(0);
    expect(result.requests![1]!.start).toBe(1500);
    expect(result.failingWindow).toBeNull();
    expect(result.requests!.every((r) => !r.duringFailure)).toBe(true);
  });

  test('marks aborted requests (status 0) as failed and carries the failure text', () => {
    const result = buildTraceNetwork(null, [
      snapshot({ response: { status: 0, headers: [] }, _failureText: 'net::ERR_ABORTED' }),
    ]);
    expect(result.requests![0]).toMatchObject({ status: 0, failed: true, failureText: 'net::ERR_ABORTED' });
  });

  test('caps entries, reports truncation and masks headers + tokens in URLs', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      snapshot({
        _monotonicTime: 1000 + i,
        request: {
          method: 'GET',
          url: `https://x.test/${i}?jwt=eyJabcdefghij.abcde.abcde`,
          headers: [{ name: 'Authorization', value: 'Bearer secret' }],
        },
      }),
    );
    const result = buildTraceNetwork(null, many, { maxEntries: 3 });
    expect(result.requests).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.totalBeforeCap).toBe(5);
    expect(result.requests![0]!.url).toContain('[masked-token]');
    expect(result.requests![0]!.requestHeaders).toEqual([{ name: 'Authorization', value: '[masked]' }]);
  });

  test('resolves the response body of a v9 trace whose ref is `_file: resources/<name>`', () => {
    // Playwright 1.63 writes `content._file = "resources/<sha1>.<ext>"` instead
    // of the older `content._sha1`. The stored file name (what the pool / ZIP is
    // keyed on) is that value with its `resources/` prefix stripped.
    const hash = 'f'.repeat(40);
    const result = buildTraceNetwork(null, [
      snapshot({
        response: {
          status: 200,
          headers: [],
          content: { size: 20, mimeType: 'application/json', _file: `resources/${hash}.json` },
        },
      }),
    ]);
    expect(result.requests![0]).toMatchObject({
      bodySha1: `${hash}.json`,
      bodyPreviewable: true,
    });
  });

  test('returns empty for a trace without network entries', () => {
    expect(buildTraceNetwork(null, []).status).toBe('empty');
  });
});

describe('matchNetworkBodySha1', () => {
  const hash = 'b'.repeat(40);
  const snapshots: TraceResourceSnapshot[] = [
    { response: { content: { _sha1: `${hash}.json`, mimeType: 'application/json' } } },
  ];

  test('matches with and without the stored extension, rejects unknown hashes', () => {
    expect(matchNetworkBodySha1(snapshots, `${hash}.json`)).toEqual({
      name: `${hash}.json`,
      mimeType: 'application/json',
    });
    expect(matchNetworkBodySha1(snapshots, hash)).toEqual({ name: `${hash}.json`, mimeType: 'application/json' });
    expect(matchNetworkBodySha1(snapshots, 'c'.repeat(40))).toBeNull();
  });

  test('matches a v9 `_file` ref by its bare name (prefix stripped), for response and request bodies', () => {
    const respHash = 'd'.repeat(40);
    const reqHash = 'e'.repeat(40);
    const v9: TraceResourceSnapshot[] = [
      {
        request: { method: 'POST', url: 'https://x.test/api', postData: { _file: `resources/${reqHash}.dat` } },
        response: { content: { _file: `resources/${respHash}.json`, mimeType: 'application/json' } },
      },
    ];
    // The `resources/` prefix is stripped, so the returned name matches the
    // stored spelling; both the exact ref and the bare hash resolve.
    expect(matchNetworkBodySha1(v9, `${respHash}.json`)).toEqual({
      name: `${respHash}.json`,
      mimeType: 'application/json',
    });
    expect(matchNetworkBodySha1(v9, respHash)).toEqual({ name: `${respHash}.json`, mimeType: 'application/json' });
    expect(matchNetworkBodySha1(v9, `${reqHash}.dat`)).toMatchObject({ name: `${reqHash}.dat` });
    expect(matchNetworkBodySha1(v9, 'a'.repeat(40))).toBeNull();
  });
});

describe('buildTraceBodyPreview', () => {
  test('pretty-prints and masks JSON bodies', () => {
    const bytes = new TextEncoder().encode('{"ok":true,"token":"eyJabcdefghij.abcde.abcde"}');
    const result = buildTraceBodyPreview(bytes, 'application/json');
    expect(result.status).toBe('ok');
    expect(result.kind).toBe('json');
    expect(result.content).toContain('"ok": true');
    expect(result.content).toContain('[masked-token]');
  });

  test('serves images as data URIs and rejects oversized ones', () => {
    const image = buildTraceBodyPreview(new Uint8Array([1, 2, 3]), 'image/png');
    expect(image).toMatchObject({ status: 'ok', kind: 'image', size: 3 });
    expect(image.dataUri).toMatch(/^data:image\/png;base64,/);

    const huge = buildTraceBodyPreview(new Uint8Array(1_500_001), 'image/png');
    expect(huge.status).toBe('too-large');
  });

  test('reports unsupported for opaque binary types', () => {
    expect(buildTraceBodyPreview(new Uint8Array([0, 1]), 'application/octet-stream').status).toBe('unsupported');
  });
});

describe('committed demo trace integration', () => {
  const zipPath = join(__dirname, '../../public/demo/traces/checkout-pay-timeout.zip');
  const entries = parseZipSync(readFileSync(zipPath));

  test('parses the real network stream including the stuck quote request', () => {
    const texts = entries.filter((e) => e.name.endsWith('.network')).map((e) => e.data.toString('utf8'));
    const snapshots = parseNetworkTexts(texts);
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const result = buildTraceNetwork(null, snapshots);
    expect(result.status).toBe('ok');
    // The Pay button stays disabled because /api/quote never resolves — that's
    // the story: a request the browser gave up on, not an HTTP error response.
    const quote = result.requests!.find((r) => r.url.endsWith('/api/quote'));
    expect(quote).toMatchObject({ method: 'GET', status: -1, failed: true, bodyPreviewable: false });
  });

  test('parses the real stacks index and correlates it with the failing action', () => {
    const stacksTexts = entries.filter((e) => e.name.endsWith('.stacks')).map((e) => e.data.toString('utf8'));
    const index = parseStacksTexts(stacksTexts);
    expect(index).not.toBeNull();

    const traceTexts = entries.filter((e) => e.name.endsWith('.trace')).map((e) => e.data.toString('utf8'));
    const parsed = parseTraceTexts(traceTexts);
    expect(parsed.failingAction).not.toBeNull();
    expect(parsed.failingAction!.apiName).toBe('Frame.click');
    expect(index!.byCallId.has(parsed.failingAction!.callId)).toBe(true);
  });

  test('resolves real embedded sources via the src@{sha1(path)} convention', async () => {
    // The committed trace is recorded with sources: true, so this exercises the
    // production sha1(absolute path) → resources/src@{sha1}.txt mapping end to end.
    const stacksTexts = entries.filter((e) => e.name.endsWith('.stacks')).map((e) => e.data.toString('utf8'));
    const traceTexts = entries.filter((e) => e.name.endsWith('.trace')).map((e) => e.data.toString('utf8'));
    const index = parseStacksTexts(stacksTexts)!;
    const parsed = parseTraceTexts(traceTexts);

    const resources = new Map(
      entries.filter((e) => e.name.startsWith('resources/')).map((e) => [e.name.slice('resources/'.length), e.data]),
    );
    const reader: TraceResourceReader = async (name) => resources.get(name) ?? null;

    const result = await buildTraceCallStack(parsed, index, reader, {});
    expect(result.status).toBe('ok');
    expect(result.hasSources).toBe(true);
    const withSource = result.frames!.find((f) => f.source);
    expect(withSource).toBeTruthy();
    expect(withSource!.source!.lines.length).toBeGreaterThan(0);
    // The window really covers the failing line of the recorded scenario script.
    expect(withSource!.line).toBeGreaterThanOrEqual(withSource!.source!.startLine);
  });
});

describe('buildTraceSnapshots — a runner action', () => {
  test('marks the page call the failing runner action drove, not a later teardown call', () => {
    const events = [
      { type: 'before', callId: 'expect@5', class: 'Test', method: 'expect', startTime: 100 },
      {
        type: 'after',
        callId: 'expect@5',
        endTime: 400,
        error: { message: 'Error: expect(locator).toBeVisible() failed' },
      },
      { type: 'error', message: 'Error: expect(locator).toBeVisible() failed' },
      { type: 'before', callId: 'call@3', class: 'Frame', method: 'expect', startTime: 101 },
      { type: 'aria-snapshot', callId: 'call@3', phase: 'after', file: 'aria/call@3-after.json' },
      { type: 'after', callId: 'call@3', endTime: 399, error: { message: 'Expect failed' } },
      { type: 'before', callId: 'call@7', class: 'Frame', method: 'expect', startTime: 501 },
      { type: 'aria-snapshot', callId: 'call@7', phase: 'after', file: 'aria/call@7-after.json' },
      { type: 'after', callId: 'call@7', endTime: 699, error: { message: 'Expect failed' } },
    ];
    const parsed = parseTraceTexts([events.map((e) => JSON.stringify(e)).join('\n')]);
    const res = buildTraceSnapshots(parsed, (file) => `- text: ${file}`);
    expect(res.failingCallId).toBe('call@3');
    expect(res.failingAriaText).toBe('- text: aria/call@3-after.json');
  });
});
