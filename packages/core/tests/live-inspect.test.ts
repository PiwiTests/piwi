import { describe, expect, test } from 'vitest';
import {
  LIVE_INSPECT_DATA_LIMITS,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_URL,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_RESOURCES,
  inspectResourceType,
  isResourceSha1,
  readLiveResource,
  readLiveSnapshot,
  type LiveSnapshot,
} from '../src/live-inspect';
import {
  LIVE_WORKER_POST_LIMITS,
  MAX_LIVE_FRAME,
  MAX_LIVE_HEADER,
  MAX_LIVE_INSPECT_MESSAGE,
  createLiveMessageReader,
  decodeLiveMessage,
  encodeLiveMessage,
  encodeLiveViewerMessage,
  liveFrameHeader,
  liveResourceHeader,
  liveSnapshotHeader,
  liveSnapshotRefusalHeader,
  parseInstanceToWorker,
  readLiveViewerMessage,
  readLiveWorkerPost,
  type LiveViewerMessage,
  type LiveWorkerId,
} from '../src/live-view';

const ID: LiveWorkerId = { shard: null, worker: 3, slot: 1 };
const SHA1 = `${'a1'.repeat(20)}.css`;
const AT = 1_794_475_486_981;

const SNAPSHOT: LiveSnapshot = {
  call: 'wzdw@54',
  title: 'Click getByRole(\'button\', { name: "Pay" })',
  phase: 'action',
  page: 'page@d7f0128682da59724a4eb8ce73c4ebd7',
  frame: 'frame@0f4dd28015bb771d37fb46b5eebf911d',
  main: true,
  full: false,
  at: AT,
  resources: [{ url: 'http://127.0.0.1:3000/app.css', sha1: SHA1 }],
};

/** A snapshot's JSON of the frame `frame`, `length` bytes long. */
function snapshotJson(length: number, frame = SNAPSHOT.frame): Uint8Array {
  const head = `{"frameId":"${frame}","html":["BODY",{},"`;
  const tail = '"]}';
  return new TextEncoder().encode(head + 'x'.repeat(length - head.length - tail.length) + tail);
}

/** Bytes of a resource, `length` long. */
function bytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(9);
}

/** Every message a reader of what a worker posts completes as `chunks` arrive. */
function readAll(...chunks: Uint8Array[]) {
  const read = createLiveMessageReader(LIVE_WORKER_POST_LIMITS);
  return chunks.flatMap((chunk) => read(chunk));
}

describe('the resources Inspect sends', () => {
  test('are stylesheets, fonts and images other than SVG, by their bare content type', () => {
    for (const [type, read] of [
      ['text/css', 'text/css'],
      ['text/css; charset=utf-8', 'text/css'],
      ['TEXT/CSS', 'text/css'],
      ['font/woff2', 'font/woff2'],
      ['font/ttf', 'font/ttf'],
      ['application/font-woff', 'application/font-woff'],
      ['application/vnd.ms-fontobject', 'application/vnd.ms-fontobject'],
      ['image/png', 'image/png'],
      ['image/jpeg', 'image/jpeg'],
      ['image/gif', 'image/gif'],
      ['image/webp', 'image/webp'],
      ['image/avif', 'image/avif'],
      ['image/x-icon', 'image/x-icon'],
      ['image/bmp', 'image/bmp'],
    ]) {
      expect(inspectResourceType(type), type).toBe(read);
    }
  });

  test('are never a script, a document, an SVG nor anything else', () => {
    for (const type of [
      'application/javascript',
      'text/javascript',
      'application/x-javascript',
      'module',
      'text/html',
      'application/xhtml+xml',
      'image/svg+xml',
      'application/json',
      'application/octet-stream',
      'text/plain',
      'image/tiff',
      'font/',
      'font/<script>',
      '',
      ' ',
      'x'.repeat(300),
      undefined,
      null,
      42,
    ]) {
      expect(inspectResourceType(type), String(type)).toBeNull();
    }
  });

  test('are named by their file among the trace’s resources: a SHA-1 and its extension', () => {
    expect(isResourceSha1(SHA1)).toBe(true);
    expect(isResourceSha1('a1'.repeat(20))).toBe(true);
    for (const name of [`resources/${SHA1}`, `../${SHA1}`, `${'a1'.repeat(19)}.css`, `${'G1'.repeat(20)}.css`, '', 7]) {
      expect(isResourceSha1(name), String(name)).toBe(false);
    }
  });
});

describe('a snapshot’s header', () => {
  test('is read field by field, its title hidden again and the resources that are not one left out', () => {
    const header = {
      ...liveSnapshotHeader(ID, SNAPSHOT, 'pays'),
      title: 'Fill "S3cr3t!Passw0rd" getByLabel(\'Password\')',
      resources: [
        ...SNAPSHOT.resources,
        { url: 'javascript:alert(1)', sha1: SHA1 },
        { url: 'http://x.test/a.css', sha1: 'nope' },
        { url: `http://x.test/${'a'.repeat(MAX_RESOURCE_URL)}`, sha1: SHA1 },
        { url: 'http://x.test/a\nb.css', sha1: SHA1 },
        'http://x.test/a.css',
      ],
    };
    const read = readLiveSnapshot(header, snapshotJson(200));
    expect(read).toMatchObject({
      ...SNAPSHOT,
      title: 'Fill "<hidden>" getByLabel(\'Password\')',
      resources: SNAPSHOT.resources,
    });
  });

  test('refuses one that does not name its call, its moment, its page, its frame or when it was taken', () => {
    const header = liveSnapshotHeader(ID, SNAPSHOT, null);
    const data = snapshotJson(200);
    for (const broken of [
      { call: '' },
      { call: 'a b' },
      { title: '' },
      { phase: 'during' },
      { page: undefined },
      { frame: 'frame/../x' },
      { main: 'yes' },
      { full: undefined },
      { at: 12 },
      { resources: 'all' },
      { resources: Array.from({ length: MAX_SNAPSHOT_RESOURCES + 1 }, () => SNAPSHOT.resources[0]) },
    ]) {
      expect(typeof readLiveSnapshot({ ...header, ...broken }, data), JSON.stringify(broken)).toBe('string');
    }
  });

  test('refuses data that is not the JSON of a snapshot of its frame', () => {
    const header = liveSnapshotHeader(ID, SNAPSHOT, null);
    const encode = (text: string) => new TextEncoder().encode(text);
    for (const data of [
      null,
      encode('not json'),
      encode('[]'),
      encode('{"frameId":"frame@other","html":[]}'),
      encode('{"html":"<p>"}'),
      new Uint8Array([0x7b, 0xff, 0x7d]),
    ]) {
      expect(typeof readLiveSnapshot(header, data)).toBe('string');
    }
    expect(readLiveSnapshot(header, encode('{"html":["P",{},"a"]}'))).toMatchObject({ call: SNAPSHOT.call });
  });
});

describe('a resource’s header', () => {
  test('is read field by field: its name, a content type Inspect sends, and its bytes', () => {
    const header = liveResourceHeader(ID, { sha1: SHA1, contentType: 'text/css; charset=utf-8' });
    expect(readLiveResource(header, bytes(10))).toEqual({ sha1: SHA1, contentType: 'text/css', data: bytes(10) });
    expect(typeof readLiveResource({ ...header, contentType: 'application/javascript' }, bytes(10))).toBe('string');
    expect(typeof readLiveResource({ ...header, contentType: 'image/svg+xml' }, bytes(10))).toBe('string');
    expect(typeof readLiveResource({ ...header, sha1: 'resources/x.css' }, bytes(10))).toBe('string');
    expect(typeof readLiveResource(header, null)).toBe('string');
    expect(typeof readLiveResource(header, new Uint8Array(0))).toBe('string');
  });
});

describe('the Inspect messages a worker posts', () => {
  test('go through the reader whole at their size limits, beside a frame at its own', () => {
    const snapshot = encodeLiveMessage(liveSnapshotHeader(ID, SNAPSHOT, 'pays'), snapshotJson(MAX_SNAPSHOT_BYTES));
    const resource = encodeLiveMessage(
      liveResourceHeader(ID, { sha1: SHA1, contentType: 'font/woff2' }),
      bytes(MAX_RESOURCE_BYTES),
    );
    const frame = encodeLiveMessage(liveFrameHeader(ID, { call: null, test: 'pays' }), jpegBytes(MAX_LIVE_FRAME));
    expect(snapshot.length).toBeLessThanOrEqual(MAX_LIVE_INSPECT_MESSAGE);
    const whole = new Uint8Array(snapshot.length + resource.length + frame.length);
    whole.set(snapshot);
    whole.set(resource, snapshot.length);
    whole.set(frame, snapshot.length + resource.length);
    // In chunks that cut each message's header and data in two.
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < whole.length; at += 1_000_003) chunks.push(whole.subarray(at, at + 1_000_003));
    const messages = readAll(...chunks);
    expect(messages.map((message) => message.header.type)).toEqual(['snapshot', 'resource', 'frame']);
    const posts = messages.map(readLiveWorkerPost);
    expect(posts[0]).toMatchObject({ type: 'snapshot', ...ID, snapshot: SNAPSHOT, test: 'pays' });
    expect((posts[0] as { data: Uint8Array }).data.length).toBe(MAX_SNAPSHOT_BYTES);
    expect(posts[1]).toMatchObject({ type: 'resource', ...ID, resource: { sha1: SHA1, contentType: 'font/woff2' } });
    expect((posts[1] as { data: Uint8Array }).data.length).toBe(MAX_RESOURCE_BYTES);
    expect(posts[2]).toMatchObject({ type: 'frame', ...ID, test: 'pays' });
    for (const one of [snapshot, resource, frame]) {
      expect(typeof decodeLiveMessage(one, LIVE_WORKER_POST_LIMITS)).toBe('object');
    }
  });

  test('are refused past their size limits, and a frame past its own', () => {
    const snapshot = encodeLiveMessage(liveSnapshotHeader(ID, SNAPSHOT, null), snapshotJson(MAX_SNAPSHOT_BYTES + 1));
    const resource = encodeLiveMessage(
      liveResourceHeader(ID, { sha1: SHA1, contentType: 'image/png' }),
      bytes(MAX_RESOURCE_BYTES + 1),
    );
    const frame = encodeLiveMessage({ type: 'frame', ...ID }, jpegBytes(MAX_LIVE_FRAME + 1));
    for (const [message, max] of [
      [snapshot, MAX_SNAPSHOT_BYTES],
      [resource, MAX_RESOURCE_BYTES],
      [frame, MAX_LIVE_FRAME],
    ] as const) {
      const why = `A live message’s data is ${max} bytes at most.`;
      expect(decodeLiveMessage(message, LIVE_WORKER_POST_LIMITS)).toBe(why);
      // The reader refuses as soon as the data's length is read, before the data comes.
      expect(() => createLiveMessageReader(LIVE_WORKER_POST_LIMITS)(message.subarray(0, 64 * 1024))).toThrow(why);
    }
    // A frame's header naming another type gets no larger bound.
    const disguised = encodeLiveMessage({ type: 'thumb', ...ID }, jpegBytes(MAX_LIVE_FRAME + 1));
    expect(decodeLiveMessage(disguised, LIVE_WORKER_POST_LIMITS)).toBe(
      `A live message’s data is ${MAX_LIVE_FRAME} bytes at most.`,
    );
  });

  test('take a frame’s bound from a reader that names none for them', () => {
    const resource = encodeLiveMessage(liveResourceHeader(ID, { sha1: SHA1, contentType: 'image/png' }), bytes(5000));
    expect(decodeLiveMessage(resource, { maxData: 4096 })).toBe('A live message’s data is 4096 bytes at most.');
    expect(LIVE_WORKER_POST_LIMITS.byType).toBe(LIVE_INSPECT_DATA_LIMITS);
    expect(MAX_LIVE_INSPECT_MESSAGE).toBe(8 + MAX_LIVE_HEADER + MAX_SNAPSHOT_BYTES);
  });

  test('say why no snapshot goes, and refuse a snapshot or a resource that is not one', () => {
    const refusal = encodeLiveMessage(liveSnapshotRefusalHeader(ID, 'This project masks elements.', 'pays'));
    const [message] = readAll(refusal);
    expect(readLiveWorkerPost(message!)).toEqual({
      type: 'snapshot',
      ...ID,
      refused: 'This project masks elements.',
      test: 'pays',
    });
    const script = encodeLiveMessage(
      liveResourceHeader(ID, { sha1: `${'b2'.repeat(20)}.js`, contentType: 'application/javascript' }),
      bytes(10),
    );
    expect(readLiveWorkerPost(readAll(script)[0]!)).toBe(
      'A resource is a stylesheet, a font or an image other than SVG.',
    );
    const nameless = encodeLiveMessage({ ...liveSnapshotHeader(ID, SNAPSHOT, null), worker: -1 }, snapshotJson(100));
    expect(readLiveWorkerPost(readAll(nameless)[0]!)).toMatch(/names no worker/);
  });
});

describe('a watch with Inspect open', () => {
  test('hears of each snapshot without its JSON nor its resources, and why none comes', () => {
    const { resources: _resources, ...notice } = SNAPSHOT;
    const messages: LiveViewerMessage[] = [
      { type: 'snapshot', ...ID, ...notice, test: 'pays' },
      { type: 'snapshot', ...ID, refused: 'This project masks elements.', test: null },
    ];
    for (const message of messages) {
      const bytes = encodeLiveViewerMessage(message);
      const [read] = createLiveMessageReader({ maxData: MAX_LIVE_FRAME })(bytes);
      expect(read!.data).toBeNull();
      expect(readLiveViewerMessage(read!)).toEqual(message);
    }
    const [broken] = createLiveMessageReader({ maxData: MAX_LIVE_FRAME })(
      encodeLiveViewerMessage({ ...messages[0]!, phase: 'during' } as unknown as LiveViewerMessage),
    );
    expect(readLiveViewerMessage(broken!)).toBeNull();
  });
});

describe('the view the instance asks', () => {
  test('says whether a full view has Inspect open, false when it does not say', () => {
    const view = { type: 'view', width: 640, height: 400, fps: 4, full: true, layers: [] };
    expect(parseInstanceToWorker(JSON.stringify({ ...view, inspect: true }))).toMatchObject({ inspect: true });
    expect(parseInstanceToWorker(JSON.stringify({ ...view, inspect: 'yes' }))).toMatchObject({ inspect: false });
    expect(parseInstanceToWorker(JSON.stringify(view))).toMatchObject({ inspect: false });
  });
});

/** A JPEG's first bytes, then filler. */
function jpegBytes(length: number): Uint8Array {
  const data = new Uint8Array(length).fill(7);
  data.set([0xff, 0xd8, 0xff, 0xe0]);
  return data;
}
