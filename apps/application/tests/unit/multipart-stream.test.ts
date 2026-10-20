import { describe, test, expect, beforeAll, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { readFileSync, existsSync } from 'node:fs';
import { streamMultipart, type StreamedMultipart } from '../../server/utils/multipart-stream';

// `apiError` is a Nitro auto-import in the running server; the util resolves it
// from the global scope at call time, so provide an equivalent for the tests.
beforeAll(() => {
  (globalThis as Record<string, unknown>).apiError = (input: { statusCode: number; message: string }) =>
    Object.assign(new Error(input.message), { statusCode: input.statusCode });
});

const BOUNDARY = 'testboundary1234';

interface Part {
  name: string;
  value?: string;
  filename?: string;
  data?: Buffer;
  contentType?: string;
}

function buildMultipart(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(p.data ?? Buffer.from(p.value ?? '', 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function makeEvent(body: Buffer, contentType = `multipart/form-data; boundary=${BOUNDARY}`) {
  const req = new PassThrough() as PassThrough & { headers: Record<string, string> };
  req.headers = { 'content-type': contentType };
  req.end(body);
  return { node: { req } } as never;
}

let last: StreamedMultipart | null = null;
afterEach(async () => {
  if (last) await last.cleanup();
  last = null;
});

describe('streamMultipart', () => {
  test('streams value fields to memory and file parts to disk', async () => {
    const traceBytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    const body = buildMultipart([
      { name: 'streamToken', value: 'tok-123' },
      { name: 'testCase', value: '{"title":"t"}' },
      { name: 'trace', filename: 'trace.zip', data: traceBytes, contentType: 'application/zip' },
      { name: 'attach_file', filename: 'shot.png', data: Buffer.from('png-bytes'), contentType: 'image/png' },
    ]);

    const result = (last = await streamMultipart(makeEvent(body), { maxTotalBytes: 1024 * 1024 }));

    expect(result.fields.get('streamToken')).toBe('tok-123');
    expect(result.fields.get('testCase')).toBe('{"title":"t"}');

    const trace = result.files.find((f) => f.field === 'trace');
    expect(trace).toBeDefined();
    expect(trace!.filename).toBe('trace.zip');
    expect(trace!.size).toBe(traceBytes.length);
    expect(readFileSync(trace!.path).equals(traceBytes)).toBe(true);

    const attach = result.files.find((f) => f.field === 'attach_file');
    expect(attach).toBeDefined();
    expect(readFileSync(attach!.path).toString()).toBe('png-bytes');
  });

  test('cleanup removes every streamed temp file', async () => {
    const body = buildMultipart([{ name: 'trace', filename: 'trace.zip', data: Buffer.from('abc') }]);
    const result = await streamMultipart(makeEvent(body), { maxTotalBytes: 1024 });
    const path = result.files[0]!.path;
    expect(existsSync(path)).toBe(true);
    await result.cleanup();
    expect(existsSync(path)).toBe(false);
  });

  test('rejects and cleans up when a file exceeds the total cap', async () => {
    const body = buildMultipart([{ name: 'trace', filename: 'big.zip', data: Buffer.alloc(2048, 1) }]);
    await expect(streamMultipart(makeEvent(body), { maxTotalBytes: 512 })).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  test('rejects parts that are each under the cap but together exceed it', async () => {
    const parts = Array.from({ length: 6 }, (_, i) => ({
      name: 'file',
      filename: `a${i}.bin`,
      data: Buffer.alloc(200, 1),
    }));
    await expect(streamMultipart(makeEvent(buildMultipart(parts)), { maxTotalBytes: 512 })).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  test('rejects a non-multipart request', async () => {
    await expect(
      streamMultipart(makeEvent(Buffer.from('{}'), 'application/json'), { maxTotalBytes: 1024 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('keeps multiple attachment parts in arrival order', async () => {
    const body = buildMultipart([
      { name: 'attach_file', filename: 'a.txt', data: Buffer.from('A') },
      { name: 'attach_file', filename: 'b.txt', data: Buffer.from('B') },
    ]);
    const result = (last = await streamMultipart(makeEvent(body), { maxTotalBytes: 1024 }));
    const attachments = result.files.filter((f) => f.field === 'attach_file');
    expect(attachments.map((a) => a.filename)).toEqual(['a.txt', 'b.txt']);
    expect(readFileSync(attachments[0]!.path).toString()).toBe('A');
    expect(readFileSync(attachments[1]!.path).toString()).toBe('B');
  });

  test('refuses too many fields, and fields over their total size', async () => {
    const many = buildMultipart(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, value: 'x' })));
    await expect(streamMultipart(makeEvent(many), { maxTotalBytes: 1024, maxFields: 3 })).rejects.toMatchObject({
      statusCode: 413,
    });

    const large = buildMultipart(Array.from({ length: 3 }, (_, i) => ({ name: `f${i}`, value: 'y'.repeat(400) })));
    await expect(
      streamMultipart(makeEvent(large), { maxTotalBytes: 1024, maxTotalFieldBytes: 1000 }),
    ).rejects.toMatchObject({ statusCode: 413 });
  });

  test('runs beforeFiles once, with the fields sent ahead of the first file part', async () => {
    const seen: Array<Record<string, string>> = [];
    const body = buildMultipart([
      { name: 'streamToken', value: 'tok-123' },
      { name: 'trace', filename: 'trace.zip', data: Buffer.from('abc') },
      { name: 'late', value: 'after-the-file' },
      { name: 'attach_file', filename: 'a.txt', data: Buffer.from('A') },
    ]);
    last = await streamMultipart(makeEvent(body), {
      maxTotalBytes: 1024,
      beforeFiles: (fields) => void seen.push(Object.fromEntries(fields)),
    });
    expect(seen).toEqual([{ streamToken: 'tok-123' }]);
    expect(last.files).toHaveLength(2);
  });

  test('a refused beforeFiles check rejects the request before any file part is written', async () => {
    let written = false;
    const body = buildMultipart([
      { name: 'streamToken', value: 'wrong' },
      { name: 'trace', filename: 'trace.zip', data: Buffer.alloc(4096, 1) },
    ]);
    await expect(
      streamMultipart(makeEvent(body), {
        maxTotalBytes: 1024 * 1024,
        beforeFiles: () => {
          throw Object.assign(new Error('Invalid stream token'), { statusCode: 403 });
        },
      }).then((result) => {
        written = result.files.length > 0;
        return result;
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(written).toBe(false);
  });

  test('runs beforeFiles once parsing ends when no file part arrives', async () => {
    let calls = 0;
    const body = buildMultipart([{ name: 'streamToken', value: 'tok' }]);
    last = await streamMultipart(makeEvent(body), { maxTotalBytes: 1024, beforeFiles: () => void calls++ });
    expect(calls).toBe(1);
  });
});
