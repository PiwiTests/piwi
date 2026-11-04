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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-file-handler-'));
  logger = new Logger(false);
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('FileHandler.findAllAttachments', () => {
  it('stages a body-only attachment as a temp file under os.tmpdir()', () => {
    const handler = new FileHandler(logger);
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
    const handler = new FileHandler(logger);
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
    handler.cleanupBodyAttachments();
  });

  it('names a title that ends in a dot or holds an ellipsis without a `..`', () => {
    const handler = new FileHandler(logger);
    const png = { contentType: 'image/png', body: Buffer.from('png') };
    const tc = testCase([
      { name: 'Step 13: Click Generate new code | Expected: The new code is not the expired one.', ...png },
      { name: 'Step 3: Read the dialog as it starts | Expected: It shows "Generating code...".', ...png },
      { name: 'build v1...v2 diff', contentType: 'text/plain', body: Buffer.from('a') },
      { name: '..', contentType: 'application/octet-stream', body: Buffer.from('a') },
      { name: '.env', contentType: 'text/plain', body: Buffer.from('a') },
    ]);

    expect(handler.findAllAttachments(tc).map((a) => a.originalName)).toEqual([
      'Step-13-Click-Generate-new-code-Expected-The-new-code-is-not-the-expired-one.png',
      'Step-3-Read-the-dialog-as-it-starts-Expected-It-shows-Generating-code.png',
      'build-v1.v2-diff.txt',
      'attachment',
      'env.txt',
    ]);
    handler.cleanupBodyAttachments();
  });

  it('reuses one temp file across repeated lookups of the same attachment', () => {
    const handler = new FileHandler(logger);
    const tc = testCase([{ name: 'note', contentType: 'text/plain', body: Buffer.from('hello') }]);

    const first = handler.findAllAttachments(tc)[0]!.path;
    const second = handler.findAllAttachments(tc)[0]!.path;
    expect(second).toBe(first);
    expect(fs.readdirSync(path.dirname(first))).toHaveLength(1);
    handler.cleanupBodyAttachments();
  });

  it('keeps path-backed attachments as they are and skips internal ones', () => {
    const handler = new FileHandler(logger);
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

  it('skips a body above the size limit and warns once per attachment', () => {
    const handler = new FileHandler(logger, 8);
    const tc = testCase([
      { name: 'huge', contentType: 'application/octet-stream', body: Buffer.alloc(9) },
      { name: 'small', contentType: 'text/plain', body: Buffer.from('ok') },
    ]);

    expect(handler.findAllAttachments(tc).map((a) => a.name)).toEqual(['small']);
    handler.findAllAttachments(tc);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('"huge"');
    expect(warn.mock.calls[0]![0]).toContain('attaches things');
    handler.cleanupBodyAttachments();
  });

  it('applies the same limit to path-backed attachments', () => {
    const handler = new FileHandler(logger, 8);
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
    expect(new FileHandler(logger).listReport(tmpDir)?.map((file) => file.name)).toEqual(['index.html']);
  });

  it("lists a report whatever its size: the dashboard's upload limit, which it sets, decides", async () => {
    const handler = new FileHandler(logger, 8);
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
    const missing = await new FileHandler(logger).checkMissingTraces(
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
    const handler = new FileHandler(logger);
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html>report</html>');

    const archive = await handler.compressReport(tmpDir, handler.listReport(tmpDir)!);
    expect(archive && path.dirname(archive).startsWith(os.tmpdir())).toBe(true);
    expect(fs.readFileSync(archive!).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    handler.cleanupBodyAttachments();
    expect(fs.existsSync(archive!)).toBe(false);
  });
});
