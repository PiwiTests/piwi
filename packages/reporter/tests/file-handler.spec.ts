import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileHandler, MAX_ATTACHMENT_BYTES } from '../src/internal/files/file-handler.js';
import { Logger } from '../src/internal/support/logger.js';
import type { CollectedTestCase, RawAttachment } from '../src/types.js';

function testCase(attachments: RawAttachment[]): CollectedTestCase {
  return { title: 'attaches things', location: 'tests/attach.spec.ts:4:3', attachments };
}

let tmpDir: string;
let logger: Logger;
let warn: ReturnType<typeof vi.spyOn>;
/** The handlers the running test made: `afterEach` deletes what they staged, whether the test passed or not. */
let handlers: FileHandler[];

function fileHandler(maxAttachmentBytes?: number): FileHandler {
  const handler = new FileHandler(logger, maxAttachmentBytes);
  handlers.push(handler);
  return handler;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-file-handler-'));
  logger = new Logger(false);
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  handlers = [];
});

afterEach(() => {
  for (const handler of handlers) handler.cleanupBodyAttachments();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('FileHandler.findAllAttachments', () => {
  it('stages a body-only attachment as a temp file under os.tmpdir()', () => {
    const handler = fileHandler();
    const body = Buffer.from(JSON.stringify({ order: 42 }));
    const tc = testCase([{ name: 'order payload', contentType: 'application/json', body }]);

    const [found] = handler.findAllAttachments(tc);
    expect(found).toBeDefined();
    expect(found!.name).toBe('order payload');
    expect(found!.contentType).toBe('application/json');
    expect(found!.originalName).toBe('order-payload.json');
    expect(path.dirname(found!.path).startsWith(os.tmpdir())).toBe(true);
    expect(fs.readFileSync(found!.path)).toEqual(body);

    handler.cleanupBodyAttachments();
    expect(fs.existsSync(found!.path)).toBe(false);
  });

  it("adds the type's extension only to a name that does not end in it", () => {
    const handler = fileHandler();
    const tc = testCase([
      { name: 'notes.txt', contentType: 'text/plain', body: Buffer.from('a') },
      { name: 'Order.JSON', contentType: 'application/json', body: Buffer.from('{}') },
      { name: 'order', contentType: 'application/json', body: Buffer.from('{}') },
    ]);

    expect(handler.findAllAttachments(tc).map((a) => a.originalName)).toEqual([
      'notes.txt',
      'Order.JSON',
      'order.json',
    ]);
  });

  it('names a title that ends in a dot or holds an ellipsis without a `..`, a leading dot kept', () => {
    const handler = fileHandler();
    const png = { contentType: 'image/png', body: Buffer.from('png') };
    const tc = testCase([
      { name: 'Step 13: Click Generate new code | Expected: The new code is not the expired one.', ...png },
      { name: 'Step 3: Read the dialog as it starts | Expected: It shows "Generating code...".', ...png },
      { name: 'build v1...v2 diff', contentType: 'text/plain', body: Buffer.from('a') },
      { name: '..', contentType: 'application/octet-stream', body: Buffer.from('a') },
      { name: '.env', contentType: 'text/plain', body: Buffer.from('a') },
      { name: '.png', ...png },
      { name: '-v1-.', contentType: 'text/plain', body: Buffer.from('a') },
    ]);

    expect(handler.findAllAttachments(tc).map((a) => a.originalName)).toEqual([
      'Step-13-Click-Generate-new-code-Expected-The-new-code-is-not-the-expired-one.png',
      'Step-3-Read-the-dialog-as-it-starts-Expected-It-shows-Generating-code.png',
      'build-v1.v2-diff.txt',
      'attachment',
      '.env.txt',
      '.png.png',
      'v1.txt',
    ]);
  });

  it('stages a long title under a 200-character name that keeps its extension and stays apart from another', () => {
    const handler = fileHandler();
    const png = { contentType: 'image/png', body: Buffer.from('png') };
    const step =
      'Step 4: Fill the registration form with a valid email, a password of twelve characters and accept the ' +
      'terms | Expected: The submit button turns enabled, the inline validation messages disappear, the summary ' +
      'panel lists the email and the progress bar reads two of three steps done.';
    const gif =
      'Step 7: Drag the card from To do to Done | Expected: The card moves, keeps its labels and assignee, the ' +
      'board saves the new order and both column counters update without a reload of the page or the board.gif';
    const tc = testCase([
      { name: step, ...png },
      { name: gif, contentType: 'image/gif', body: Buffer.from('png') },
      { name: 'x'.repeat(300), ...png },
      { name: `${'x'.repeat(299)}y`, ...png },
      { name: `${'x'.repeat(190)}. ${'y'.repeat(100)}`, ...png },
    ]);

    const found = handler.findAllAttachments(tc);
    expect(found.map((a) => a.originalName)).toEqual([
      'Step-4-Fill-the-registration-form-with-a-valid-email-a-password-of-twelve-characters-and-accept-the-terms-' +
        'Expected-The-submit-button-turns-enabled-the-inline-validation-messages-disappear-the-354f5545.png',
      'Step-7-Drag-the-card-from-To-do-to-Done-Expected-The-card-moves-keeps-its-labels-and-assignee-the-board-' +
        'saves-the-new-order-and-both-column-counters-update-without-a-reload-of-the-page-or-88c74cd5.gif',
      `${'x'.repeat(191)}-0d4e2ca9.png`,
      `${'x'.repeat(191)}-d71979b4.png`,
      `${'x'.repeat(190)}-49e06af3.png`,
    ]);
    for (const a of found) expect(fs.readFileSync(a.path).toString()).toBe('png');
    expect(warn).not.toHaveBeenCalled();
  });

  it('reuses one temp file across repeated lookups of the same attachment', () => {
    const handler = fileHandler();
    const tc = testCase([{ name: 'note', contentType: 'text/plain', body: Buffer.from('hello') }]);

    const first = handler.findAllAttachments(tc)[0]!.path;
    const second = handler.findAllAttachments(tc)[0]!.path;
    expect(second).toBe(first);
    expect(fs.readdirSync(path.dirname(first))).toHaveLength(1);
  });

  it('keeps path-backed attachments as they are and skips internal ones', () => {
    const handler = fileHandler();
    const file = path.join(tmpDir, 'shot.png');
    fs.writeFileSync(file, 'png');
    const tc = testCase([
      { name: 'screenshot', contentType: 'image/png', path: file },
      { name: 'piwi-network', contentType: 'application/json', body: Buffer.from('[]') },
      { name: 'trace', contentType: 'application/zip', path: file },
    ]);

    const found = handler.findAllAttachments(tc);
    expect(found).toEqual([{ name: 'screenshot', path: file, contentType: 'image/png', originalName: 'shot.png' }]);
  });

  it('uploads a path-backed attachment whose file name holds a `..` under a name without one', () => {
    const handler = fileHandler();
    const file = path.join(tmpDir, 'The new code is not the expired one..png');
    fs.writeFileSync(file, 'png');
    const tc = testCase([{ name: 'expired', contentType: 'image/png', path: file }]);

    const [found] = handler.findAllAttachments(tc);
    expect(found).toEqual({
      name: 'expired',
      path: file,
      contentType: 'image/png',
      originalName: 'The new code is not the expired one.png',
    });

    // A name of dots and an extension keeps one `path.extname` reads, which the dashboard serves the file by.
    const dotted = path.join(tmpDir, '..png');
    fs.writeFileSync(dotted, 'png');
    const [named] = handler.findAllAttachments(testCase([{ name: 'dots', contentType: 'image/png', path: dotted }]));
    expect(named?.originalName).toBe('.png.png');
  });

  it('skips a body above the size limit and warns once per attachment', () => {
    const handler = fileHandler(8);
    const tc = testCase([
      { name: 'huge', contentType: 'application/octet-stream', body: Buffer.alloc(9) },
      { name: 'small', contentType: 'text/plain', body: Buffer.from('ok') },
    ]);

    expect(handler.findAllAttachments(tc).map((a) => a.name)).toEqual(['small']);
    handler.findAllAttachments(tc);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('"huge"');
    expect(warn.mock.calls[0]![0]).toContain('attaches things');
  });

  it('applies the same limit to path-backed attachments', () => {
    const handler = fileHandler(8);
    const file = path.join(tmpDir, 'video.webm');
    fs.writeFileSync(file, Buffer.alloc(16));
    const tc = testCase([{ name: 'video', contentType: 'video/webm', path: file }]);

    expect(handler.findAllAttachments(tc)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('"video"');
  });

  it('defaults to the dashboard upload ceiling', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(500 * 1024 * 1024);
  });
});

describe('FileHandler.listReport', () => {
  it("lists a report's files", () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html>');
    expect(
      fileHandler()
        .listReport(tmpDir)
        ?.map((file) => file.name),
    ).toEqual(['index.html']);
  });

  it("lists a report whatever its size: the dashboard's upload limit, which it sets, decides", async () => {
    const handler = fileHandler(8);
    fs.writeFileSync(path.join(tmpDir, 'index.html'), Buffer.alloc(5));
    fs.writeFileSync(path.join(tmpDir, 'data.js'), Buffer.alloc(5));

    const names = handler.listReport(tmpDir)?.map((file) => file.name);
    expect(names?.sort()).toEqual(['data.js', 'index.html']);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('FileHandler.checkMissingTraces', () => {
  it('asks nothing once the signal is aborted, and takes every trace as missing', async () => {
    const postJSON = vi.fn(async () => ({ missing: [] }));
    const missing = await fileHandler().checkMissingTraces(
      { postJSON },
      'proj',
      new Map([[0, { hash: 'abc' }]]),
      null,
      AbortSignal.abort(),
    );
    expect(postJSON).not.toHaveBeenCalled();
    expect([...missing]).toEqual(['abc']);
  });
});

describe('FileHandler.compressReport', () => {
  it('writes the archive to a temp file that cleanupBodyAttachments deletes', async () => {
    const handler = fileHandler();
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html>report</html>');

    const archive = await handler.compressReport(tmpDir, handler.listReport(tmpDir)!);
    expect(archive && path.dirname(archive).startsWith(os.tmpdir())).toBe(true);
    expect(fs.readFileSync(archive!).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    handler.cleanupBodyAttachments();
    expect(fs.existsSync(archive!)).toBe(false);
  });
});
