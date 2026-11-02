import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(zlib.gzip);

/**
 * Recursively read a directory and pack all files into a gzip-compressed
 * archive (a concatenation of length-prefixed path+content pairs). Each path
 * is relative to the directory, with forward slashes on every platform.
 */
export async function compressDirectory(sourceDir: string): Promise<Buffer> {
  const files: Array<{ path: string; content: Buffer }> = [];

  function collect(dir: string, baseDir = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = baseDir ? `${baseDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collect(full, rel);
      else if (entry.isFile()) files.push({ path: rel, content: fs.readFileSync(full) });
    }
  }

  collect(sourceDir);

  const parts: Buffer[] = [];
  for (const f of files) {
    const pb = Buffer.from(f.path, 'utf8');
    const plb = Buffer.allocUnsafe(4);
    plb.writeUInt32LE(pb.length, 0);
    const clb = Buffer.allocUnsafe(4);
    clb.writeUInt32LE(f.content.length, 0);
    parts.push(plb, pb, clb, f.content);
  }

  return await gzipAsync(Buffer.concat(parts), { level: 5 });
}
