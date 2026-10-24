import busboy from 'busboy';
import type { H3Event } from 'h3';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * A file part of a multipart request, streamed straight to a temp file on disk
 * rather than buffered in memory. `path` is an absolute path the caller reads
 * (or moves) and then discards via {@link StreamedMultipart.cleanup}.
 */
export interface StreamedFile {
  /** Multipart field name (e.g. `trace`, `attach_file`). */
  field: string;
  /** Filename as sent by the client — unsanitized; sanitize before using it in a storage path. */
  filename: string;
  /** Absolute path of the temp file the part was streamed to. */
  path: string;
  /** Bytes written to disk. */
  size: number;
  /** Declared MIME type. */
  mimeType: string;
}

export interface StreamedMultipart {
  /** Non-file fields; last value wins for a repeated name. */
  fields: Map<string, string>;
  /** File parts streamed to temp files, in arrival order. */
  files: StreamedFile[];
  /** Remove the temp directory and every streamed file. Always call it in a `finally`. */
  cleanup: () => Promise<void>;
}

export interface StreamMultipartOptions {
  /**
   * Cap on each file part and on the bytes written across all file parts,
   * counted as the bytes arrive: the request is refused as soon as it passes.
   */
  maxTotalBytes: number;
  /** Cap on a single non-file field value (default 1 MiB). */
  maxFieldBytes?: number;
  /** Cap on the bytes of every non-file field value together (default 4 MiB). */
  maxTotalFieldBytes?: number;
  /** Cap on the number of non-file fields (default 100). */
  maxFields?: number;
  /** Cap on the number of file parts (default 500). */
  maxFiles?: number;
  /**
   * Runs once, with the fields read so far, before the first file part is
   * written to disk (or once parsing ends when the request has no file part).
   * Throwing refuses the request before any file byte is stored, so a route
   * authenticated by a field (a stream token sent ahead of the files) checks
   * it here.
   */
  beforeFiles?: (fields: Map<string, string>) => Promise<void> | void;
}

const DEFAULT_MAX_FIELD_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_TOTAL_FIELD_BYTES = 4 * 1024 * 1024; // 4 MiB
const DEFAULT_MAX_FIELDS = 100;
const DEFAULT_MAX_FILES = 500;

/**
 * Parse a `multipart/form-data` request as a stream: file parts are written to
 * temp files as they arrive and small value fields are kept in memory, so a
 * large upload (a trace ZIP) never sits in the heap for the whole transfer the
 * way `readMultipartFormData` — which buffers the entire raw body and then every
 * parsed part — does. The peak the parser holds is one filesystem chunk, not the
 * upload; the bytes live on disk until the caller reads them one at a time.
 *
 * Every cap is checked on the bytes actually read, whatever the request's
 * headers declare: a field over `maxFieldBytes`, fields over `maxTotalFieldBytes`
 * together, too many fields or file parts, or file bytes over `maxTotalBytes`
 * reject the request at once. Temp files are removed on any failure, and the
 * caller removes them on success via the returned `cleanup`.
 */
export async function streamMultipart(event: H3Event, options: StreamMultipartOptions): Promise<StreamedMultipart> {
  const req = event.node.req;
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw apiError({ statusCode: 400, message: 'Expected multipart/form-data' });
  }

  const maxFieldBytes = options.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
  const maxTotalFieldBytes = options.maxTotalFieldBytes ?? DEFAULT_MAX_TOTAL_FIELD_BYTES;
  const maxFields = options.maxFields ?? DEFAULT_MAX_FIELDS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const dir = await mkdtemp(join(tmpdir(), 'piwi-upload-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });

  const fields = new Map<string, string>();
  const files: StreamedFile[] = [];

  // The `beforeFiles` check, run at most once, on the fields read when it starts.
  let gate: Promise<void> | undefined;
  const passGate = () => (gate ??= (async () => options.beforeFiles?.(new Map(fields)))());

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        req.unpipe(bb);
        req.resume(); // drain the rest so the socket doesn't hang
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      let bb: ReturnType<typeof busboy>;
      try {
        bb = busboy({
          headers: req.headers,
          limits: {
            fileSize: options.maxTotalBytes,
            fieldSize: maxFieldBytes,
            fields: maxFields,
            files: maxFiles,
            parts: maxFields + maxFiles,
          },
        });
      } catch {
        fail(apiError({ statusCode: 400, message: 'Malformed multipart request' }));
        return;
      }

      const fileWrites: Promise<void>[] = [];
      let totalBytes = 0;
      let fieldBytes = 0;
      // Counted as the bytes arrive, so an oversized upload stops before it fills the disk.
      let streamedBytes = 0;

      bb.on('file', (field: string, stream: NodeJS.ReadableStream, info: busboy.FileInfo) => {
        const { filename } = info;
        // A part with no filename is not a file upload — drain it so busboy can proceed.
        if (!filename) {
          stream.resume();
          return;
        }
        // Reserve this part's arrival slot now; writes flush out of order, so
        // filling the slot on completion keeps `files` in the order parts arrived.
        const index = fileWrites.length;
        const tmpPath = join(dir, `${randomBytes(8).toString('hex')}`);
        let truncated = false;
        stream.on('limit', () => {
          truncated = true;
        });
        // Nothing reads the part until the check passed: busboy, and the request
        // behind it, wait meanwhile.
        const write = passGate().then(async () => {
          stream.on('data', (chunk: Buffer) => {
            streamedBytes += chunk.length;
            if (streamedBytes > options.maxTotalBytes) {
              const error = apiError({ statusCode: 413, message: 'Upload exceeded the size limit' });
              (stream as unknown as { destroy(error?: Error): void }).destroy(error);
              fail(error);
            }
          });
          const ws = createWriteStream(tmpPath);
          await pipeline(stream, ws);
          if (truncated) throw apiError({ statusCode: 413, message: 'A file part exceeded the upload limit' });
          totalBytes += ws.bytesWritten;
          if (totalBytes > options.maxTotalBytes) {
            throw apiError({ statusCode: 413, message: 'Upload exceeded the size limit' });
          }
          files[index] = {
            field,
            filename,
            path: tmpPath,
            size: ws.bytesWritten,
            mimeType: info.mimeType,
          };
        });
        // A refused check, or a write cut short after the request already failed, fails the request once.
        write.catch(fail);
        fileWrites.push(write);
      });

      bb.on('field', (name: string, value: string, info: busboy.FieldInfo) => {
        if (info.valueTruncated) {
          fail(apiError({ statusCode: 413, message: `Field "${name}" exceeded the size limit` }));
          return;
        }
        fieldBytes += Buffer.byteLength(value);
        if (fieldBytes > maxTotalFieldBytes) {
          fail(apiError({ statusCode: 413, message: 'Form fields exceeded the size limit' }));
          return;
        }
        fields.set(name, value);
      });

      bb.on('filesLimit', () => fail(apiError({ statusCode: 413, message: 'Too many file parts' })));
      bb.on('fieldsLimit', () => fail(apiError({ statusCode: 413, message: 'Too many form fields' })));
      bb.on('partsLimit', () => fail(apiError({ statusCode: 413, message: 'Too many form parts' })));
      bb.on('error', fail);
      bb.on('close', () => {
        // busboy has finished parsing; wait for the in-flight file writes to flush,
        // and run the check when no file part did.
        Promise.all([...fileWrites, passGate()]).then(succeed, fail);
      });

      req.on('aborted', () => fail(apiError({ statusCode: 400, message: 'Request aborted' })));
      req.on('error', fail);
      req.pipe(bb);
    });
  } catch (error) {
    await cleanup();
    throw error;
  }

  return { fields, files, cleanup };
}
