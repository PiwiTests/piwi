import { dirname, resolve, relative, isAbsolute } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { createGunzip } from 'zlib';

/**
 * Upper bound on the decompressed size of a report archive. The archive packs
 * an entire report/trace directory into one gzip stream, and uploads are
 * attacker-controllable (open when auth is disabled), so an unbounded
 * compression ratio would let a few kilobytes expand to gigabytes. 1 GiB
 * comfortably exceeds any realistic report (even a large blob report with
 * hundreds of traced tests) while stopping decompression bombs.
 */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024; // 1 GiB

/** Upper bound on the one file {@link readArchiveEntry} returns. */
const MAX_ARCHIVE_ENTRY_BYTES = 256 * 1024 * 1024; // 256 MiB

/** Longest path a record of the archive may carry. */
const MAX_PATH_BYTES = 10_000;

const EMPTY = Buffer.alloc(0);

/** An archive whose bytes do not follow the record format. */
class MalformedArchiveError extends Error {}

interface ArchiveLimits {
  /** Bytes the whole archive may inflate to. */
  maxInflatedBytes: number;
  /** Bytes one wanted file may hold. */
  maxEntryBytes: number;
}

/**
 * The files of a gzip-compressed report archive, in order: records of a path
 * and a content, each preceded by its length (32-bit little-endian), as the
 * reporter writes them. The archive is inflated as a stream: a file `want`
 * turns down is skipped as it arrives, and only the file being read is held.
 * Throws once more than `maxInflatedBytes` were inflated, when a wanted file is
 * over `maxEntryBytes`, and with a `MalformedArchiveError` on a record the
 * format cannot hold or one cut short.
 */
async function* archiveFiles(
  compressedBuffer: Buffer,
  want: (path: string) => boolean,
  { maxInflatedBytes, maxEntryBytes }: ArchiveLimits,
): AsyncGenerator<{ path: string; content: Buffer }> {
  const stream = createGunzip();
  stream.end(compressedBuffer);

  let inflated = 0;
  let header: Buffer = EMPTY; // bytes of a record header not yet complete
  let skip = 0; // bytes of a file that is not wanted, still to pass over
  let reading: { path: string; remaining: number; chunks: Buffer[] } | null = null;

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
      if (reading) {
        const n = Math.min(reading.remaining, chunk.length);
        reading.chunks.push(chunk.subarray(0, n));
        reading.remaining -= n;
        chunk = chunk.subarray(n);
        if (reading.remaining === 0) {
          yield { path: reading.path, content: Buffer.concat(reading.chunks) };
          reading = null;
        }
        continue;
      }

      header = header.length > 0 ? Buffer.concat([header, chunk]) : chunk;
      chunk = EMPTY;
      if (header.length < 4) break;
      const pathLength = header.readUInt32LE(0);
      if (pathLength === 0 || pathLength > MAX_PATH_BYTES) {
        throw new MalformedArchiveError(`Invalid path length ${pathLength}`);
      }
      if (header.length < 8 + pathLength) break;
      const path = header.toString('utf8', 4, 4 + pathLength);
      const contentLength = header.readUInt32LE(4 + pathLength);
      chunk = header.subarray(8 + pathLength);
      header = EMPTY;

      if (!want(path)) {
        skip = contentLength;
      } else if (contentLength > maxEntryBytes) {
        throw new Error(`"${path}" is over ${maxEntryBytes} bytes`);
      } else if (contentLength === 0) {
        yield { path, content: EMPTY };
      } else {
        reading = { path, remaining: contentLength, chunks: [] };
      }
    }
  }
  if (header.length > 0 || skip > 0 || reading) throw new MalformedArchiveError('The archive ends inside a record');
}

/**
 * Decompress a gzip-compressed report archive (the format {@link archiveFiles}
 * reads) into a target directory. Throws on a malformed archive, one over the
 * size limits, or a file whose path leaves the directory.
 */
export async function decompressDirectory(compressedBuffer: Buffer, targetDir: string): Promise<void> {
  try {
    await mkdir(targetDir, { recursive: true });
    let fileCount = 0;
    const limits = { maxInflatedBytes: MAX_ARCHIVE_BYTES, maxEntryBytes: MAX_ARCHIVE_BYTES };
    for await (const file of archiveFiles(compressedBuffer, () => true, limits)) {
      // Guard against path traversal (zip-slip): the archive is
      // attacker-controllable (uploaded to /api/test-runs/upload, which is open
      // when auth is disabled), so an entry path like `../../evil` must not
      // escape targetDir.
      const fullPath = resolve(targetDir, file.path);
      const rel = relative(targetDir, fullPath);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`Unsafe path in archive (path traversal blocked): ${file.path}`);
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.content);
      fileCount++;
    }

    console.log(`Successfully decompressed ${fileCount} files from archive`);
  } catch (error) {
    console.error('Failed to decompress archive:', error);
    throw error;
  }
}

/**
 * The content of the first file of a gzip-compressed report archive whose path
 * is `name` or ends with it, or null when there is none or the archive is
 * malformed. The files before it are skipped as they arrive, and reading stops
 * once it is complete. Throws once more than `maxInflatedBytes` were inflated,
 * or when the file is over `maxEntryBytes`.
 */
export async function readArchiveEntry(
  compressedBuffer: Buffer,
  name: string,
  { maxInflatedBytes = MAX_ARCHIVE_BYTES, maxEntryBytes = MAX_ARCHIVE_ENTRY_BYTES } = {},
): Promise<Buffer | null> {
  const wanted = (path: string) => path === name || path.endsWith(name);
  try {
    for await (const file of archiveFiles(compressedBuffer, wanted, { maxInflatedBytes, maxEntryBytes })) {
      return file.content;
    }
  } catch (error) {
    if (error instanceof MalformedArchiveError) return null;
    throw error;
  }
  return null;
}
