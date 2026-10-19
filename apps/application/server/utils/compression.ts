import { dirname, resolve, relative, isAbsolute } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { createGunzip, gunzip } from 'zlib';
import { promisify } from 'util';

const gunzipAsync = promisify(gunzip);

/**
 * Upper bound on the decompressed size of a report archive. The archive packs
 * an entire report/trace directory into one gzip stream that is inflated fully
 * into memory here, and uploads are attacker-controllable (open when auth is
 * disabled), so an unbounded compression ratio would let a few kilobytes expand
 * to gigabytes and OOM the server. 1 GiB comfortably exceeds any realistic
 * report (even a large blob report with hundreds of traced tests) while
 * stopping decompression bombs. zlib throws ERR_BUFFER_TOO_LARGE past the cap.
 */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Decompress a gzip-compressed archive buffer into a target directory.
 */
export async function decompressDirectory(compressedBuffer: Buffer, targetDir: string): Promise<void> {
  try {
    const uncompressed = await gunzipAsync(compressedBuffer, { maxOutputLength: MAX_ARCHIVE_BYTES });

    await mkdir(targetDir, { recursive: true });

    // Parse the archive format (little-endian byte order)
    let offset = 0;
    let fileCount = 0;

    while (offset < uncompressed.length) {
      // Read path length
      if (offset + 4 > uncompressed.length) {
        if (offset !== uncompressed.length) {
          console.warn(`Incomplete archive data at offset ${offset}, expected ${uncompressed.length}`);
        }
        break;
      }
      const pathLength = uncompressed.readUInt32LE(offset);
      offset += 4;

      // Validate path length
      if (pathLength === 0 || pathLength > 10000) {
        throw new Error(`Invalid path length: ${pathLength} at offset ${offset - 4}`);
      }

      // Read path
      if (offset + pathLength > uncompressed.length) {
        throw new Error(`Incomplete path data at offset ${offset}`);
      }
      const filePath = uncompressed.toString('utf8', offset, offset + pathLength);
      offset += pathLength;

      // Read content length
      if (offset + 4 > uncompressed.length) {
        throw new Error(`Incomplete content length at offset ${offset}`);
      }
      const contentLength = uncompressed.readUInt32LE(offset);
      offset += 4;

      // Read content
      if (offset + contentLength > uncompressed.length) {
        throw new Error(`Incomplete content data at offset ${offset}, expected ${contentLength} bytes`);
      }
      const content = uncompressed.subarray(offset, offset + contentLength);
      offset += contentLength;

      // Write file — guard against path traversal (zip-slip). The archive is
      // attacker-controllable (uploaded to /api/test-runs/upload, which is open
      // when auth is disabled), so a malicious entry path like `../../evil` must
      // not be allowed to escape targetDir.
      const fullPath = resolve(targetDir, filePath);
      const rel = relative(targetDir, fullPath);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`Unsafe path in archive (path traversal blocked): ${filePath}`);
      }
      const dirPath = dirname(fullPath);

      await mkdir(dirPath, { recursive: true });
      await writeFile(fullPath, content);
      fileCount++;
    }

    console.log(`Successfully decompressed ${fileCount} files from archive`);
  } catch (error) {
    console.error('Failed to decompress archive:', error);
    throw error;
  }
}

/** Upper bound on the one file {@link readArchiveEntry} returns. */
const MAX_ARCHIVE_ENTRY_BYTES = 256 * 1024 * 1024; // 256 MiB

const EMPTY = Buffer.alloc(0);

/**
 * The content of the first file of a gzip-compressed archive (the format
 * {@link decompressDirectory} reads) whose path is `name` or ends with it, or
 * null when there is none or the archive is malformed. The archive is inflated
 * as a stream: the files before it are skipped as they arrive, only that file is
 * held, and reading stops once it is complete. Throws once more than
 * `maxInflatedBytes` were inflated, or when the file is over `maxEntryBytes`.
 */
export async function readArchiveEntry(
  compressedBuffer: Buffer,
  name: string,
  { maxInflatedBytes = MAX_ARCHIVE_BYTES, maxEntryBytes = MAX_ARCHIVE_ENTRY_BYTES } = {},
): Promise<Buffer | null> {
  const stream = createGunzip();
  stream.end(compressedBuffer);

  let inflated = 0;
  let header: Buffer = EMPTY; // bytes of a record header not yet complete
  let skip = 0; // bytes of a file that is not the one asked for, still to pass over
  let found: { remaining: number; chunks: Buffer[] } | null = null;

  for await (const data of stream) {
    let chunk: Buffer = data;
    inflated += chunk.length;
    if (inflated > maxInflatedBytes) throw new Error(`Archive inflates past ${maxInflatedBytes} bytes`);

    while (chunk.length > 0) {
      if (skip > 0) {
        const n = Math.min(skip, chunk.length);
        skip -= n;
        chunk = chunk.subarray(n);
        continue;
      }
      if (found) {
        const n = Math.min(found.remaining, chunk.length);
        found.chunks.push(chunk.subarray(0, n));
        found.remaining -= n;
        chunk = chunk.subarray(n);
        if (found.remaining === 0) return Buffer.concat(found.chunks);
        continue;
      }

      header = header.length > 0 ? Buffer.concat([header, chunk]) : chunk;
      chunk = EMPTY;
      if (header.length < 4) break;
      const pathLength = header.readUInt32LE(0);
      if (pathLength === 0 || pathLength > 10000) return null;
      if (header.length < 8 + pathLength) break;
      const filePath = header.toString('utf8', 4, 4 + pathLength);
      const contentLength = header.readUInt32LE(4 + pathLength);
      chunk = header.subarray(8 + pathLength);
      header = EMPTY;

      if (filePath === name || filePath.endsWith(name)) {
        if (contentLength > maxEntryBytes) throw new Error(`"${filePath}" is over ${maxEntryBytes} bytes`);
        if (contentLength === 0) return EMPTY;
        found = { remaining: contentLength, chunks: [] };
      } else {
        skip = contentLength;
      }
    }
  }
  return null;
}
