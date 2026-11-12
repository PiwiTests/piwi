import { describe, test, expect, vi, beforeEach } from 'vitest';

// Back the storage adapter with an in-memory file map so the whole inlining
// path (ZIP read → .trace/.network parse → resource reads) runs end to end
// without touching disk. `vi.hoisted` lets the factory below reach the map.
const { storageFiles } = vi.hoisted(() => ({ storageFiles: new Map<string, Buffer>() }));
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    readFile: async (path: string) => {
      const bytes = storageFiles.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return bytes;
    },
  }),
}));

import { getTraceDomSnapshot } from '~~/server/utils/dom-snapshot';
import { buildZip } from '~~/server/utils/trace-zip';

/**
 * A minimal slim trace ZIP: one main-frame snapshot linking an external
 * stylesheet, and a `.network` stream mapping that stylesheet and its
 * background image to stored resources — the exact shape the picker inlines.
 * `head`/`body` replace the snapshot's children for tests about other elements.
 */
function buildTraceZip(
  head: unknown[] = [['LINK', { rel: 'stylesheet', href: '/app.css' }]],
  body: unknown[] = [['DIV', { class: 'logo' }, 'hi']],
): Buffer {
  const frameSnapshot = {
    type: 'frame-snapshot',
    snapshot: {
      snapshotName: 's1',
      frameId: 'f1',
      isMainFrame: true,
      frameUrl: 'http://app.local/page',
      doctype: 'html',
      viewport: { width: 800, height: 600 },
      html: ['HTML', {}, ['HEAD', {}, ...head], ['BODY', {}, ...body]],
    },
  };
  const resourceSnap = (url: string, sha1: string, mimeType: string) => ({
    type: 'resource-snapshot',
    snapshot: { request: { url }, response: { content: { _sha1: sha1, mimeType } } },
  });
  const network = [
    resourceSnap('http://app.local/app.css', 'css1', 'text/css'),
    resourceSnap('http://app.local/img/logo.png', 'img1', 'image/png'),
    resourceSnap('http://app.local/img/huge.png', 'img2', 'image/png'),
    resourceSnap('http://app.local/app.css?desktop', 'css2', 'text/css'),
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  return buildZip([
    { name: '0-trace.trace', data: Buffer.from(JSON.stringify(frameSnapshot), 'utf8') },
    { name: '0-trace.network', data: Buffer.from(network, 'utf8') },
  ]);
}

const BLOB = 'project-7/blobs/abc.zip';
const HEX_SECRET = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'; // 40 hex chars → masked
// The stylesheet references a background image by a document-relative url() and
// also carries a token-shaped secret, so one fixture exercises both concerns.
const CSS = `.logo{background:url(/img/logo.png)}.k{--t:"${HEX_SECRET}"}`;
const PNG = Buffer.from('PNGBYTES');

beforeEach(() => {
  storageFiles.clear();
  storageFiles.set(BLOB, buildTraceZip());
  storageFiles.set('project-7/trace-resources/css1', Buffer.from(CSS, 'utf8'));
  storageFiles.set('project-7/trace-resources/img1', PNG);
});

describe('getTraceDomSnapshot — stylesheet + asset inlining', () => {
  test('inlines the stylesheet, embeds its url() image as a data URI, and masks secrets last', async () => {
    const res = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    expect(res.status).toBe('ok');
    // The <link> became an inline <style>.
    expect(res.html).toContain('<style>');
    expect(res.html).not.toContain('<link rel="stylesheet"');
    // The CSS url() now points at the base64-embedded image — proving assets are
    // inlined AND that the later secret-mask left the fresh data URI intact.
    expect(res.html).toContain(`url("data:image/png;base64,${PNG.toString('base64')}")`);
    // …while the token-shaped secret in the same sheet is still scrubbed.
    expect(res.html).toContain('[masked-hex]');
    expect(res.html).not.toContain(HEX_SECRET);
  });

  test('leaves the external <link> untouched when inlineStyles is off (the AI-context path)', async () => {
    const res = await getTraceDomSnapshot(BLOB, 1_000_000);
    expect(res.status).toBe('ok');
    expect(res.html).toContain('<link rel="stylesheet" href="/app.css">');
    expect(res.html).not.toContain('data:image/png');
  });

  test("charges a stylesheet's repeated url() asset once per use", async () => {
    // 400 KB fits the budget once, but eight @font-face uses would embed 3.2 MB.
    storageFiles.set('project-7/trace-resources/img1', Buffer.alloc(400_000, 1));
    const face = '@font-face{font-family:x;src:url(/img/logo.png)}';
    storageFiles.set('project-7/trace-resources/css1', Buffer.from(face.repeat(8), 'utf8'));
    const res = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    expect(res.html).toContain('src:url(/img/logo.png)');
    expect(res.html).not.toContain('data:image/png');
  });

  test('inlines a multi-megabyte stylesheet', async () => {
    storageFiles.set('project-7/trace-resources/css1', Buffer.from(`.big{color:red}${' '.repeat(1_500_000)}`, 'utf8'));
    const res = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    expect(res.html).toContain('<style>.big{color:red}');
    expect(res.html).not.toContain('<link rel="stylesheet"');
  });

  test("skips a stylesheet whose media query can't match the recorded viewport", async () => {
    storageFiles.set(
      BLOB,
      buildTraceZip([
        ['LINK', { rel: 'stylesheet', href: '/app.css', media: 'screen and (max-width: 599px)' }],
        ['LINK', { rel: 'stylesheet', href: '/app.css?desktop', media: 'screen and (min-width: 600px)' }],
      ]),
    );
    storageFiles.set('project-7/trace-resources/css2', Buffer.from('.desk{color:blue}', 'utf8'));
    const res = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    // The 800px-wide recording matches only the desktop sheet.
    expect(res.html).toContain('<link rel="stylesheet" href="/app.css" media="screen and (max-width: 599px)">');
    expect(res.html).toContain('<style media="screen and (min-width: 600px)">.desk{color:blue}</style>');
  });

  test('keeps the <link> when the stylesheet resource is missing (graceful degradation)', async () => {
    storageFiles.delete('project-7/trace-resources/css1');
    const res = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    expect(res.status).toBe('ok');
    expect(res.html).toContain('<link rel="stylesheet" href="/app.css">');
  });
});

describe('getTraceDomSnapshot — image inlining', () => {
  const PNG_URI = `data:image/png;base64,${PNG.toString('base64')}`;

  test('embeds each <img src> the trace captured, resolved against the frame URL', async () => {
    storageFiles.set(
      BLOB,
      buildTraceZip(undefined, [
        ['IMG', { alt: 'a > b', src: '/img/logo.png' }],
        ['IMG', { src: 'img/logo.png', class: 'relative' }],
        ['IMG', { src: '/img/missing.png', alt: 'gone' }],
      ]),
    );
    const res = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    expect(res.status).toBe('ok');
    // Root-relative and document-relative refs both resolve to the captured image.
    expect(res.html).toContain(`<img alt="a &gt; b" src="${PNG_URI}">`);
    expect(res.html).toContain(`<img src="${PNG_URI}" class="relative">`);
    // An image the trace never captured keeps its src.
    expect(res.html).toContain('<img src="/img/missing.png" alt="gone">');
  });

  test('embeds images on a page that links no stylesheet', async () => {
    storageFiles.set(BLOB, buildTraceZip([], [['IMG', { src: '/img/logo.png' }]]));
    const res = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    expect(res.html).toContain(`<img src="${PNG_URI}">`);
  });

  test('keeps the src of an image over the per-asset cap', async () => {
    storageFiles.set('project-7/trace-resources/img2', Buffer.alloc(600_000, 1));
    storageFiles.set(BLOB, buildTraceZip([], [['IMG', { src: '/img/huge.png' }]]));
    const res = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    expect(res.html).toContain('<img src="/img/huge.png">');
  });

  test('charges the budget per use, so a much-repeated image stays a plain src', async () => {
    // 400 KB fits one embed, but ten uses would embed 4 MB — past the budget.
    storageFiles.set('project-7/trace-resources/img2', Buffer.alloc(400_000, 1));
    const rows = Array.from({ length: 10 }, () => ['IMG', { src: '/img/huge.png' }]);
    storageFiles.set(BLOB, buildTraceZip([], rows));
    const res = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    expect(res.html).not.toContain('data:image/png');
    expect(res.html!.match(/<img src="\/img\/huge.png">/g)).toHaveLength(10);
  });

  test("keeps the page's own inline data: images, which text consumers get masked", async () => {
    const inline = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
    storageFiles.set(BLOB, buildTraceZip([], [['IMG', { src: inline, alt: 'QR' }]]));
    const rendered = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    expect(rendered.html).toContain(`<img src="${inline}" alt="QR">`);
    const text = await getTraceDomSnapshot(BLOB, 1_000_000);
    expect(text.html).toContain('<img src="data:[masked]" alt="QR">');
  });

  test('leaves images alone when inlineStyles is off (the AI-context path)', async () => {
    storageFiles.set(BLOB, buildTraceZip([], [['IMG', { src: '/img/logo.png' }]]));
    const res = await getTraceDomSnapshot(BLOB, 1_000_000);
    expect(res.html).toContain('<img src="/img/logo.png">');
  });
});

/**
 * The same inlining path over a Playwright v9 trace: the frame snapshot is keyed
 * by `callId` + `phase` (no `snapshotName`) and the `.network` resource body is
 * named by `_file` (`resources/`-prefixed) instead of `_sha1`. This is the exact
 * shape that left the picker unstyled before the format was supported.
 */
function buildV9TraceZip(): Buffer {
  const before = { type: 'before', callId: 'call@8', startTime: 1, class: 'Frame', method: 'goto', pageId: 'p1' };
  const frameSnapshot = {
    type: 'frame-snapshot',
    snapshot: {
      callId: 'call@8',
      phase: 'after',
      frameId: 'f1',
      isMainFrame: true,
      frameUrl: 'http://app.local/page',
      doctype: 'html',
      viewport: { width: 800, height: 600 },
      html: [
        'HTML',
        {},
        ['HEAD', {}, ['LINK', { rel: 'stylesheet', href: '/app.css' }]],
        ['BODY', {}, ['DIV', { class: 'logo' }, 'hi']],
      ],
    },
  };
  const after = { type: 'after', callId: 'call@8', endTime: 2 };
  const resourceSnap = (url: string, file: string, mimeType: string) => ({
    type: 'resource-snapshot',
    snapshot: { request: { url }, response: { content: { _file: `resources/${file}`, mimeType } } },
  });
  const network = [
    resourceSnap('http://app.local/app.css', 'css1', 'text/css'),
    resourceSnap('http://app.local/img/logo.png', 'img1', 'image/png'),
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  return buildZip([
    {
      name: '0-trace.trace',
      data: Buffer.from([before, frameSnapshot, after].map((e) => JSON.stringify(e)).join('\n'), 'utf8'),
    },
    { name: '0-trace.network', data: Buffer.from(network, 'utf8') },
  ]);
}

describe('getTraceDomSnapshot — Playwright v9 trace format', () => {
  beforeEach(() => {
    storageFiles.set(BLOB, buildV9TraceZip());
  });

  test('renders the v9 snapshot and inlines its stylesheet + url() asset', async () => {
    const res = await getTraceDomSnapshot(BLOB, 1_000_000, { inlineStyles: true });
    expect(res.status).toBe('ok');
    // The callId+phase frame snapshot rendered despite carrying no snapshotName.
    expect(res.html).toContain('<div class="logo">hi</div>');
    // The `_file`-named stylesheet inlined, image embedded as a data URI.
    expect(res.html).toContain('<style>');
    expect(res.html).not.toContain('<link rel="stylesheet"');
    expect(res.html).toContain(`url("data:image/png;base64,${PNG.toString('base64')}")`);
  });
});
