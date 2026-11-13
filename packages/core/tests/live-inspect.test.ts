import { describe, expect, test } from 'vitest';
import {
  LIVE_INSPECT_DATA_LIMITS,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_URL,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_RESOURCES,
  cssReferences,
  MAX_SNAPSHOT_NODES,
  hideFrameSnapshotSecrets,
  hideResourceUrl,
  hideSnapshotSecrets,
  inspectResourceType,
  isFullSnapshot,
  isInspectResourceBytes,
  isResourceSha1,
  readLiveResource,
  readLiveSnapshot,
  resolveResourceUrl,
  snapshotFieldSecrets,
  snapshotNodes,
  snapshotPhase,
  snapshotResourceUrls,
  type LiveSnapshot,
  type SnapshotResolver,
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
  index: 7,
  at: AT,
  resources: [{ url: 'http://127.0.0.1:3000/app.css', sha1: SHA1 }],
};

/** A snapshot's JSON of the frame `frame`, `length` bytes long. */
function snapshotJson(length: number, frame = SNAPSHOT.frame): Uint8Array {
  const head = `{"frameId":"${frame}","html":["BODY",{},"`;
  const tail = '"]}';
  return new TextEncoder().encode(head + 'x'.repeat(length - head.length - tail.length) + tail);
}

/** Bytes of a resource, `length` long: a stylesheet's spaces, or `head` then filler. */
function bytes(length: number, head = ''): Uint8Array {
  const data = new Uint8Array(length).fill(9);
  data.set(new TextEncoder().encode(head));
  return data;
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
      ['font/woff', 'font/woff'],
      ['font/ttf', 'font/ttf'],
      ['font/otf', 'font/otf'],
      ['font/sfnt', 'font/sfnt'],
      ['font/collection', 'font/collection'],
      ['application/font-woff', 'application/font-woff'],
      ['application/x-font-ttf', 'application/x-font-ttf'],
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
      'font/svg+xml',
      'application/font-sfnt',
      'font/x-unknown',
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

  test('are the kind of bytes their content type says, never a document nor an SVG', () => {
    const at34 = (data: number[]) => {
      const eot = new Uint8Array(40);
      eot.set(data, 34);
      return eot;
    };
    const of = (...values: Array<number | string>) =>
      new Uint8Array(
        values.flatMap((value) => (typeof value === 'string' ? [...value].map((c) => c.charCodeAt(0)) : [value])),
      );
    for (const [type, data] of [
      ['image/png', of(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0)],
      ['image/jpeg', of(0xff, 0xd8, 0xff, 0xe0)],
      ['image/gif', of('GIF89a', 1)],
      ['image/gif', of('GIF87a', 1)],
      ['image/webp', of('RIFF', 0, 0, 0, 0, 'WEBPVP8 ')],
      ['image/avif', of(0, 0, 0, 0x20, 'ftypavif', 0)],
      ['image/x-icon', of(0, 0, 1, 0, 1)],
      ['image/x-icon', of(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a)],
      ['image/bmp', of('BM', 0, 0)],
      ['font/woff', of('wOFF', 0)],
      ['font/woff2', of('wOF2', 0)],
      ['font/ttf', of(0, 1, 0, 0, 0)],
      ['application/x-font-ttf', of('true', 0)],
      ['font/otf', of('OTTO', 0)],
      ['font/collection', of('ttcf', 0)],
      ['application/vnd.ms-fontobject', at34([0x4c, 0x50])],
      ['text/css', of('body { color: red }')],
      ['text/css', of(0xef, 0xbb, 0xbf, ' \n\t@import "a.css";')],
    ] as const) {
      expect(isInspectResourceBytes(type, data), `${type} ${String(data.slice(0, 12))}`).toBe(true);
    }
    for (const [type, data] of [
      ['image/png', of('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ['image/jpeg', of('<!doctype html><script>alert(1)</script>')],
      ['image/webp', of('RIFF', 0, 0, 0, 0, 'WAVE')],
      ['image/avif', of(0, 0, 0, 0x20, 'ftypisom')],
      ['font/woff2', of('<?xml version="1.0"?><svg><font/></svg>')],
      ['font/ttf', of('wOF')],
      ['application/vnd.ms-fontobject', at34([0x50, 0x4c])],
      ['text/css', of('<!doctype html><script>alert(1)</script>')],
      ['text/css', of(0xef, 0xbb, 0xbf, '  \r\n<html>')],
      ['text/css', of(0xff, 0xfe, '<', 0, 'h', 0)],
      ['text/css', new Uint8Array(0)],
      ['application/javascript', of('alert(1)')],
    ] as const) {
      expect(isInspectResourceBytes(type, data), `${type} ${String(data.slice(0, 12))}`).toBe(false);
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
      { index: -1 },
      { index: 1.5 },
      { index: '3' },
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
    expect(readLiveResource(header, bytes(10, '<html>'))).toBe('A resource’s bytes are what its content type says.');
    expect(readLiveResource({ ...header, contentType: 'image/png' }, bytes(10))).toBe(
      'A resource’s bytes are what its content type says.',
    );
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
      bytes(MAX_RESOURCE_BYTES, 'wOF2'),
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

describe('a snapshot as the trace writes it', () => {
  test('names its moment by its phase, or by its name in an older trace', () => {
    expect(snapshotPhase({ phase: 'action' })).toBe('action');
    expect(snapshotPhase({ phase: 'later' })).toBeNull();
    expect(snapshotPhase({ snapshotName: 'before@call@8' })).toBe('before');
    expect(snapshotPhase({ snapshotName: 'input@call@10' })).toBe('action');
    expect(snapshotPhase({ snapshotName: 'after@call@10' })).toBe('after');
    expect(snapshotPhase({ snapshotName: 'call@10' })).toBeNull();
    expect(snapshotPhase({})).toBeNull();
  });

  test('is full when it refers to no earlier snapshot, and numbers its nodes as Playwright does', () => {
    const title = ['TITLE', {}, 'Shop'];
    const head = ['HEAD', {}, title];
    const p = ['P', {}, 'a'];
    const body = ['BODY', {}, 'hi', p];
    const full = ['HTML', {}, head, body];
    expect(isFullSnapshot(full)).toBe(true);
    expect(isFullSnapshot([[1, 40]])).toBe(false);
    expect(isFullSnapshot(['HTML', {}, [[2, 11]], ['BODY', {}]])).toBe(false);
    expect(isFullSnapshot('html')).toBe(false);
    expect(snapshotNodes(full)).toEqual(['Shop', title, head, 'hi', 'a', p, body, full]);
    expect(snapshotNodes(['HTML', {}, [[2, 11]], 'x'])).toEqual(['x', ['HTML', {}, [[2, 11]], 'x']]);
  });
});

describe('the secrets a snapshot shows', () => {
  const SECRET = 'S3cr3t!Pw';
  const field = (attributes: Record<string, unknown>) => [
    'INPUT',
    { __playwright_value_: 'v4lue-held', ...attributes },
  ];

  test('go from a password field, a one-time code and a card number, the rest of the field kept', () => {
    const html = [
      'BODY',
      {},
      field({ type: 'PASSWORD', value: SECRET, __playwright_value_: SECRET, id: 'pw' }),
      field({ autocomplete: 'one-time-code', __playwright_value_: '123456' }),
      field({ autocomplete: 'billing cc-number' }),
      ['TEXTAREA', { autocomplete: 'new-password', __playwright_value_: 'a b c' }, 'a b c'],
      field({ name: 'card', __playwright_value_: '4111 1111 1111 1111' }),
      field({ id: 'name', __playwright_value_: 'Ada' }),
    ];
    expect(hideSnapshotSecrets(html, { secrets: [] })).toEqual([
      'BODY',
      {},
      ['INPUT', { type: 'PASSWORD', id: 'pw' }],
      ['INPUT', { autocomplete: 'one-time-code' }],
      ['INPUT', { autocomplete: 'billing cc-number' }],
      ['TEXTAREA', { autocomplete: 'new-password' }, '<hidden>'],
      ['INPUT', { __playwright_value_: '<hidden>', name: 'card' }],
      ['INPUT', { __playwright_value_: 'Ada', id: 'name' }],
    ]);
  });

  test('go from a field its name, its placeholder or its label names for a secret, a label of an earlier snapshot too', () => {
    const earlier = ['LABEL', {}, 'Verification code'];
    const resolve: SnapshotResolver = (back, index) =>
      back === 1 && index === 0
        ? { node: 'PIN ', resolve: () => null }
        : back === 2
          ? { node: earlier, resolve }
          : null;
    const html = [
      'FORM',
      {},
      field({ name: 'api_key' }),
      field({ placeholder: 'Password' }),
      ['LABEL', {}, 'PIN ', field({})],
      ['LABEL', {}, [[1, 0]], field({ id: 'by-reference' })],
      ['LABEL', { for: 'code' }, 'Verification code'],
      field({ id: 'code' }),
      [[2, 5]],
      field({ id: 'nickname' }),
    ];
    const hidden = hideSnapshotSecrets(html, { secrets: [], resolve }) as unknown[];
    const values = hidden.slice(2).map((node) => (node as [string, Record<string, unknown>])[1]?.__playwright_value_);
    expect(values).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'v4lue-held']);
    expect((hidden[4] as unknown[])[3]).toEqual(['INPUT', {}]);
    expect(hidden[8]).toEqual([[2, 5]]);
  });

  test('go wherever a value the attempt’s secret fields held shows, as a text or an attribute, the shape kept', () => {
    const html = [
      'BODY',
      {},
      ['DIV', { id: 'out' }, SECRET],
      ['P', {}, `Your password is ${SECRET}.`],
      ['A', { href: `/reset?token=${SECRET}`, title: ` ${SECRET} ` }, 'reset'],
      ['SPAN', {}, '4111-1111-1111-1111'],
      ['SPAN', {}, '1234'],
      ['SPAN', {}, 'Ada'],
    ];
    const before = JSON.stringify(html);
    const hidden = hideSnapshotSecrets(html, { secrets: [SECRET, '1234', ' '] });
    expect(JSON.stringify(html)).toBe(before);
    expect(hidden).toEqual([
      'BODY',
      {},
      ['DIV', { id: 'out' }, '<hidden>'],
      ['P', {}, 'Your password is <hidden>.'],
      ['A', { href: '/reset?token=<hidden>', title: '<hidden>' }, 'reset'],
      ['SPAN', {}, '<hidden>'],
      ['SPAN', {}, '<hidden>'],
      ['SPAN', {}, 'Ada'],
    ]);
    expect(snapshotNodes(hidden)!.length).toBe(snapshotNodes(html)!.length);
    expect(JSON.stringify(hidden)).not.toContain(SECRET);
  });

  test('are the values of the fields it hides, read from the snapshot alone, its labels followed', () => {
    const resolve: SnapshotResolver = (back, index) =>
      back === 1 && index === 0 ? { node: 'Verification code', resolve: () => null } : null;
    const html = [
      'BODY',
      {},
      field({ type: 'password', value: SECRET, __playwright_value_: SECRET }),
      ['LABEL', {}, [[1, 0]], field({ __playwright_value_: '842113' })],
      ['TEXTAREA', { autocomplete: 'new-password' }, 'long secret text'],
      field({ type: 'password', __playwright_value_: '' }),
      field({ id: 'name', __playwright_value_: 'Ada' }),
      ['P', {}, SECRET],
    ];
    expect(snapshotFieldSecrets(html, resolve)).toEqual([SECRET, '842113', 'long secret text']);
    // What it found hides the same values wherever else they show.
    const hidden = hideSnapshotSecrets(html, { secrets: snapshotFieldSecrets(html, resolve)!, resolve });
    expect(JSON.stringify(hidden)).not.toContain(SECRET);
    expect(snapshotFieldSecrets(['BODY', {}, [[1, 0]]], () => null)).toBeNull();
    expect(snapshotFieldSecrets(['BODY', {}, [[1, 0]]])).toEqual([]);
  });
});

describe('the credentials a snapshot holds', () => {
  const PNG_DATA = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'.repeat(4)}`;
  const FONT_DATA = `data:font/woff2;base64,${'d09GMgABAAAAAAhEAA0AAAAAEGAAAAfuAAEAAAAA'.repeat(4)}`;

  test('go from every address, text and attribute, and from a meta named for a secret, the images and fonts kept', () => {
    const html = [
      'HTML',
      {},
      [
        'HEAD',
        {},
        ['META', { name: 'csrf-token', content: 'q8Zt3kPLm2' }],
        ['META', { 'http-equiv': 'X-Api-Key', content: 'k-123' }],
        ['META', { property: 'og:url', content: 'https://app.test/share?token=q8Zt3kPLm2' }],
        ['META', { name: 'viewport', content: 'width=device-width' }],
        ['LINK', { rel: 'stylesheet', href: 'https://cdn.test/app.css?sig=abc123' }],
        ['STYLE', {}, `@font-face { src: url(${FONT_DATA}) } .a { background: url(/bg.png?token=css1) }`],
      ],
      [
        'BODY',
        {},
        ['A', { href: 'https://app.test/reset?token=q8Zt3kPLm2' }, 'Reset'],
        ['A', { href: '/reset?access_token=q8Zt3kPLm2#top' }, 'Reset'],
        [
          'IMG',
          {
            src: '/img.png?token=img1',
            srcset: '/a.png?token=set1 1x, /b.png?sig=set2 2x',
            __playwright_current_src__: 'https://app.test/img.png?token=img1',
          },
        ],
        ['IMG', { src: PNG_DATA, srcset: `${PNG_DATA} 1x, /c.png?token=set3 2x` }],
        ['FORM', { action: '/login?session=form1' }, ['BUTTON', { formaction: '/go?key=form2' }, 'Go']],
        ['VIDEO', { poster: '/p.jpg?token=poster1' }],
        ['OBJECT', { data: '/o.pdf?token=object1' }],
        ['svg', {}, ['use', { 'xlink:href': '/s.svg?token=use1#i' }]],
        [
          'DIV',
          { style: `background: url(${PNG_DATA})`, title: 'see https://x.test/?token=title1' },
          'Your link: https://x.test/a?token=text1 expires',
        ],
        ['P', {}, 'Your order 12345 ships soon'],
      ],
    ];
    const before = JSON.stringify(html);
    const hidden = hideSnapshotSecrets(html, { secrets: [] }) as unknown[];
    expect(JSON.stringify(html)).toBe(before);
    const [, , head, body] = hidden as [string, object, unknown[], unknown[]];
    expect(head.slice(2)).toEqual([
      ['META', { name: 'csrf-token', content: '<hidden>' }],
      ['META', { 'http-equiv': 'X-Api-Key', content: '<hidden>' }],
      ['META', { property: 'og:url', content: 'https://app.test/share?token=<hidden>' }],
      ['META', { name: 'viewport', content: 'width=device-width' }],
      ['LINK', { rel: 'stylesheet', href: 'https://cdn.test/app.css?sig=<hidden>' }],
      ['STYLE', {}, `@font-face { src: url(${FONT_DATA}) } .a { background: url(/bg.png?token=<hidden>) }`],
    ]);
    expect(body.slice(2)).toEqual([
      ['A', { href: 'https://app.test/reset?token=<hidden>' }, 'Reset'],
      ['A', { href: '/reset?access_token=<hidden>#top' }, 'Reset'],
      [
        'IMG',
        {
          src: '/img.png?token=<hidden>',
          srcset: '/a.png?token=<hidden> 1x, /b.png?sig=<hidden> 2x',
          __playwright_current_src__: 'https://app.test/img.png?token=<hidden>',
        },
      ],
      ['IMG', { src: PNG_DATA, srcset: `${PNG_DATA} 1x, /c.png?token=<hidden> 2x` }],
      ['FORM', { action: '/login?session=<hidden>' }, ['BUTTON', { formaction: '/go?key=<hidden>' }, 'Go']],
      ['VIDEO', { poster: '/p.jpg?token=<hidden>' }],
      ['OBJECT', { data: '/o.pdf?token=<hidden>' }],
      ['svg', {}, ['use', { 'xlink:href': '/s.svg?token=<hidden>#i' }]],
      [
        'DIV',
        { style: `background: url(${PNG_DATA})`, title: 'see https://x.test/?token=<hidden>' },
        'Your link: https://x.test/a?token=<hidden> expires',
      ],
      ['P', {}, 'Your order 12345 ships soon'],
    ]);
  });

  test('go from its frame’s address and its stylesheets’, and the resources’ addresses read as the page’s read', () => {
    const SECRET = 'S3cr3t!Pw';
    const snapshot = {
      callId: 'call@8',
      frameUrl: `https://app.test/u/${SECRET}/cart?session=f1`,
      resourceOverrides: [{ url: 'https://app.test/app.css?token=o1', sha1: SHA1 }, { ref: 2 }],
      viewport: { width: 1280, height: 720 },
      html: ['HTML', {}, ['HEAD', {}, ['LINK', { rel: 'stylesheet', href: 'theme.css?token=r1' }]]],
    };
    const before = JSON.stringify(snapshot);
    const shown = hideFrameSnapshotSecrets(snapshot, { secrets: [SECRET] })!;
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(shown).toEqual({
      ...snapshot,
      frameUrl: 'https://app.test/u/<hidden>/cart?session=<hidden>',
      resourceOverrides: [{ url: 'https://app.test/app.css?token=<hidden>', sha1: SHA1 }, { ref: 2 }],
      html: ['HTML', {}, ['HEAD', {}, ['LINK', { rel: 'stylesheet', href: 'theme.css?token=<hidden>' }]]],
    });
    // The instance resolves the hidden link against the hidden frame's address: the header names it so.
    const real = new URL('theme.css?token=r1', snapshot.frameUrl).href;
    const read = new URL('theme.css?token=<hidden>', shown.frameUrl as string).href;
    expect(hideResourceUrl(real, [SECRET])).toBe(read);
    expect(read).not.toContain(SECRET);
    expect(hideResourceUrl('https://app.test/a.css?v=3')).toBe('https://app.test/a.css?v=3');
    expect(hideResourceUrl('javascript:alert(1)')).toBeNull();
  });

  test('go from the header’s resources the instance reads again', () => {
    const header = {
      ...liveSnapshotHeader(ID, SNAPSHOT, null),
      resources: [{ url: 'https://app.test/app.css?token=h1', sha1: SHA1 }],
    };
    expect(readLiveSnapshot(header, snapshotJson(200))).toMatchObject({
      resources: [{ url: 'https://app.test/app.css?token=%3Chidden%3E', sha1: SHA1 }],
    });
  });

  test('never run: a script Playwright keeps is emptied in place, an address that runs one is left out', () => {
    const html = [
      'HTML',
      {},
      [
        'BODY',
        {},
        ['svg', {}, ['script', { href: '/evil.js' }, 'alert(document.cookie)'], ['circle', { r: '1' }]],
        ['html:script', {}, 'alert(2)', ['b', {}, 'x']],
        ['A', { href: 'javascript:alert(1)', title: 'a' }, 'one'],
        ['A', { href: ' JaVa\tScRiPt:alert(1)' }, 'two'],
        ['BUTTON', { formaction: 'vbscript:msgbox(1)' }, 'three'],
        ['a', { 'xlink:href': 'javascript:alert(1)' }, 'four'],
        ['A', { href: '/javascript:not-a-scheme' }, 'five'],
      ],
    ];
    const hidden = hideSnapshotSecrets(html, { secrets: [] });
    expect(hidden).toEqual([
      'HTML',
      {},
      [
        'BODY',
        {},
        ['svg', {}, ['template', {}, ''], ['circle', { r: '1' }]],
        ['template', {}, '', ['template', {}, '']],
        ['A', { title: 'a' }, 'one'],
        ['A', {}, 'two'],
        ['BUTTON', {}, 'three'],
        ['a', {}, 'four'],
        ['A', { href: '/javascript:not-a-scheme' }, 'five'],
      ],
    ]);
    expect(snapshotNodes(hidden)!.length).toBe(snapshotNodes(html)!.length);
  });
});

describe('a snapshot that cannot be read whole', () => {
  /** `node` inside `levels` elements. */
  const nested = (node: unknown, levels: number): unknown => {
    let out = node;
    for (let i = 0; i < levels; i++) out = ['DIV', {}, out];
    return out;
  };

  test('does not go: a node deeper than the walk goes, past the nodes it visits, or of an unknown shape', () => {
    const password = ['INPUT', { type: 'password', __playwright_value_: 'hunter2-deep' }];
    expect(hideSnapshotSecrets(['HTML', {}, nested(password, 520)], { secrets: [] })).toBeNull();
    expect(hideSnapshotSecrets(['HTML', {}, nested(password, 500)], { secrets: [] })).not.toBeNull();
    const wide = ['BODY', {}, ...Array.from({ length: MAX_SNAPSHOT_NODES / 2 }, (_, i) => ['SPAN', {}, `x${i}`])];
    expect(hideSnapshotSecrets(['HTML', {}, wide], { secrets: [] })).toBeNull();
    expect(snapshotNodes(['HTML', {}, wide])).toBeNull();
    expect(snapshotNodes(['HTML', {}, nested('x', 520)])).toBeNull();
    expect(hideSnapshotSecrets(['HTML', 'not attributes', ['BODY', {}]], { secrets: [] })).toBeNull();
    expect(hideFrameSnapshotSecrets({ html: ['HTML', {}, nested(password, 520)] }, { secrets: [] })).toBeNull();
  });

  test('is not read as full: a reference deeper than the walk goes, or past the nodes it visits', () => {
    expect(isFullSnapshot(['HTML', {}, nested([[1, 3]], 520)])).toBe(false);
    expect(isFullSnapshot(['HTML', {}, nested('x', 520)])).toBe(false);
    const wide = ['BODY', {}, ...Array.from({ length: MAX_SNAPSHOT_NODES / 2 }, (_, i) => ['SPAN', {}, `x${i}`])];
    expect(isFullSnapshot(['HTML', {}, wide])).toBe(false);
  });

  test('does not go with a reference its resolver does not know; without one, its references are not followed', () => {
    const html = ['HTML', {}, ['BODY', {}, [[1, 4]], ['INPUT', { id: 'nick', __playwright_value_: '9182' }]]];
    expect(hideSnapshotSecrets(html, { secrets: [], resolve: () => null })).toBeNull();
    expect(JSON.stringify(hideSnapshotSecrets(html, { secrets: [] }))).toContain('9182');
  });
});

describe('the labels of a snapshot’s fields', () => {
  const field = (attributes: Record<string, unknown>) => ['INPUT', { __playwright_value_: '9182', ...attributes }];
  const valueOf = (hidden: unknown, at: number[]): unknown => {
    let node = hidden as unknown[];
    for (const i of at) node = node[i] as unknown[];
    return (node[1] as Record<string, unknown>).__playwright_value_;
  };

  test('hide a field named by a label far into a large page', () => {
    const rows = Array.from({ length: 60_000 }, (_, i) => ['SPAN', {}, `x${i}`]);
    const html = ['BODY', {}, ...rows, ['LABEL', { for: 'f' }, 'PIN'], field({ id: 'f' })];
    expect(valueOf(hideSnapshotSecrets(html, { secrets: [] }), [rows.length + 3])).toBeUndefined();
  });

  test('hide a field its aria-labelledby names a secret by, in this snapshot or an earlier one', () => {
    const earlier = ['SPAN', { id: 'old' }, 'Security code'];
    const resolve: SnapshotResolver = (back, index) =>
      back === 1 && index === 3 ? { node: earlier, resolve: () => null } : null;
    const html = [
      'BODY',
      {},
      ['SPAN', { id: 'l' }, 'Password'],
      field({ 'aria-labelledby': 'l' }),
      [[1, 3]],
      field({ 'aria-labelledby': 'nick old' }),
      ['SPAN', { id: 'nick' }, 'Nickname'],
      field({ 'aria-labelledby': 'nick' }),
      field({ 'aria-labelledby': 'missing' }),
    ];
    const hidden = hideSnapshotSecrets(html, { secrets: [], resolve });
    expect([3, 5, 7, 8].map((at) => valueOf(hidden, [at]))).toEqual([undefined, undefined, '9182', '9182']);
  });

  test('hide a field whose label cannot be read whole', () => {
    const long = ['SPAN', {}, ...Array.from({ length: 1200 }, () => ['B', {}])];
    const html = [
      'BODY',
      {},
      ['LABEL', {}, 'Nick', long, field({})],
      ['LABEL', { for: 'n' }, long, 'Nick'],
      field({ id: 'n' }),
    ];
    const hidden = hideSnapshotSecrets(html, { secrets: [] });
    expect(valueOf(hidden, [2, 4])).toBeUndefined();
    expect(valueOf(hidden, [4])).toBeUndefined();
  });
});

describe('the resources a snapshot names', () => {
  test('are its stylesheets, icons, images and what its styles name, read against its base', () => {
    const snapshot = {
      frameUrl: 'http://shop.test/cart/index.html',
      html: [
        'HTML',
        {},
        [
          'HEAD',
          {},
          ['BASE', { href: 'http://shop.test/cart/' }],
          ['LINK', { rel: 'stylesheet', href: '/app.css' }],
          ['LINK', { rel: 'icon', href: 'favicon.ico' }],
          ['LINK', { rel: 'preload', href: '/app.js' }],
          ['SCRIPT', { src: '/app.js' }],
          ['STYLE', {}, '@import url("/extra.css"); @import \'print.css\'; .a { background: url(bg.png) }'],
        ],
        [
          'BODY',
          { style: 'background-image: url("data:image/png;base64,AAAA")' },
          ['IMG', { __playwright_current_src__: 'http://cdn.test/logo.png', src: 'logo.png' }],
          ['IMG', { srcset: 'small.png 1x, big.png 2x' }],
          ['PICTURE', {}, ['SOURCE', { srcset: '/hero.webp' }]],
          ['INPUT', { type: 'image', src: 'go.gif' }],
          ['VIDEO', { poster: 'poster.jpg' }],
          ['DIV', { __playwright_style_sheet_: '/* url(skip.png) */ .b { background: url(/b.png) }' }],
          ['A', { href: 'next.html' }, 'next'],
          ['IMG', { src: 'javascript:alert(1)' }],
          [[3, 4]],
        ],
      ],
    };
    expect(snapshotResourceUrls(snapshot).sort()).toEqual(
      [
        'http://shop.test/app.css',
        'http://shop.test/cart/favicon.ico',
        'http://shop.test/extra.css',
        'http://shop.test/cart/print.css',
        'http://shop.test/cart/bg.png',
        'http://cdn.test/logo.png',
        'http://shop.test/cart/logo.png',
        'http://shop.test/cart/small.png',
        'http://shop.test/cart/big.png',
        'http://shop.test/hero.webp',
        'http://shop.test/cart/go.gif',
        'http://shop.test/cart/poster.jpg',
        'http://shop.test/b.png',
      ].sort(),
    );
  });

  test('of a stylesheet are its urls and imports, its comments and data addresses left out', () => {
    expect(
      cssReferences(
        '@font-face { src: url("f.woff2") format("woff2"), url( \'f.woff\' ) } /* url(no.png) */ @import "a.css"; .x { background: url(data:image/gif;base64,R0) }',
      ),
    ).toEqual(['f.woff2', 'f.woff', 'a.css']);
    expect(resolveResourceUrl('f.woff2', 'http://shop.test/css/app.css')).toBe('http://shop.test/css/f.woff2');
    expect(resolveResourceUrl('/a.png#x', 'https://shop.test/')).toBe('https://shop.test/a.png');
    expect(resolveResourceUrl('file:///etc/passwd', 'http://shop.test/')).toBeNull();
    expect(resolveResourceUrl('a.png', null)).toBeNull();
  });

  test('of a stylesheet are read in one pass, whatever it holds, as the patterns of url() and @import read them', () => {
    /** The patterns a stylesheet's references are defined by. */
    const byPatterns = (css: string): string[] => {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const found = new Set<string>();
      for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi)) {
        found.add((match[1] ?? match[2] ?? match[3] ?? '').trim());
      }
      for (const match of text.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
        found.add((match[1] ?? match[2] ?? '').trim());
      }
      return [...found].filter((ref) => ref && !/^data:/i.test(ref));
    };
    const pieces = [
      'url(',
      'URL(',
      '"',
      "'",
      ')',
      ' ',
      '\n',
      '/*',
      '*/',
      '@import',
      '@IMPORT',
      'a.png',
      'b c',
      'data:x',
    ];
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 5000; round++) {
      let css = '';
      for (let i = random(24); i > 0; i--) css += pieces[random(pieces.length)];
      expect(cssReferences(css), JSON.stringify(css)).toEqual(byPatterns(css));
    }
    // What made the patterns read the text again from each start takes one pass.
    for (const repeated of ['url("', "url('", 'url(', '/*', '@import "', 'url(url( ']) {
      const started = performance.now();
      cssReferences(repeated.repeat(Math.ceil(400_000 / repeated.length)));
      expect(performance.now() - started, repeated).toBeLessThan(500);
    }
  });
});
