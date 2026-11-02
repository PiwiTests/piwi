import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** A file of a folder to archive. */
export interface ArchiveFile {
  /** Where the file is. */
  path: string;
  /** Its path relative to the archived folder, with forward slashes on every platform. */
  name: string;
  size: number;
}

/** Every file under `sourceDir`, with its name in the archive and its size. */
export function listArchiveFiles(sourceDir: string): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  function collect(dir: string, baseDir = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const name = baseDir ? `${baseDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collect(full, name);
      else if (entry.isFile()) files.push({ path: full, name, size: fs.statSync(full).size });
    }
  }
  collect(sourceDir);
  return files;
}

/** The archive's records: each file's name and content, each preceded by its length (32-bit little-endian). */
async function* archiveRecords(files: ArchiveFile[]): AsyncGenerator<Buffer> {
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const header = Buffer.alloc(8 + name.length);
    header.writeUInt32LE(name.length, 0);
    name.copy(header, 4);
    header.writeUInt32LE(file.size, 4 + name.length);
    yield header;
    let read = 0;
    if (file.size > 0) {
      for await (const chunk of fs.createReadStream(file.path, { start: 0, end: file.size - 1 })) {
        read += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
    }
    if (read !== file.size) throw new Error(`${file.name} changed while it was archived`);
  }
}

/**
 * Write the gzip-compressed archive of `files` to `target`: the records the dashboard extracts, read one file at a
 * time as they are compressed, so neither the files nor the archive are ever held in memory whole.
 */
export async function writeArchive(files: ArchiveFile[], target: string): Promise<void> {
  await pipeline(Readable.from(archiveRecords(files)), zlib.createGzip({ level: 5 }), fs.createWriteStream(target));
}
