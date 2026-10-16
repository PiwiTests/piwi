import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoverageFile } from '@piwitests/core/coverage';

/**
 * The checksums a backend names for the source each file was compiled from
 * (`sha256:<hex>` or `sha1:<hex>`, from the compiler's span table), checked
 * against the file in the reporter's checkout. The compiler hashed the bytes
 * it read, so the checkout's file matches when it is the same as is, or with
 * its line endings turned the other way (a checkout made with
 * `core.autocrlf`, a build on another system).
 */

const CHECKSUM = /^(sha1|sha256):[0-9a-f]{40,64}$/;

/** The checksums of a backend's file entry: the well-formed ones, each kept once. */
export function checksumsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((value): value is string => typeof value === 'string' && CHECKSUM.test(value)))];
}

/** The text with every line ending as LF, and with every line ending as CRLF. */
function lineEndingForms(content: Buffer): Buffer[] {
  const text = content.toString('latin1');
  const lf = text.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  return [content, Buffer.from(lf, 'latin1'), Buffer.from(crlf, 'latin1')];
}

/** Every checksum the content can have in a span table. */
export function contentChecksums(content: Buffer): Set<string> {
  const out = new Set<string>();
  for (const form of lineEndingForms(content)) {
    for (const algorithm of ['sha1', 'sha256'] as const) {
      out.add(`${algorithm}:${crypto.createHash(algorithm).update(form).digest('hex')}`);
    }
  }
  return out;
}

/** A file's coverage without its line numbers: the path only, the file still counting as reached. */
function withoutLines<T extends CoverageFile>(file: T): T {
  const copy: T & { executable?: unknown } = { ...file };
  delete copy.functions;
  delete copy.lines;
  delete copy.blob;
  delete copy.executable;
  return copy;
}

/** The checkout's files, read once per run, matched against the checksums a backend names. */
export class SourceChecksums {
  private readonly cache = new Map<string, Promise<Set<string> | null>>();

  /** @param repoRoot The repository root the paths are relative to, found on first use. */
  constructor(private readonly repoRoot: () => string) {}

  /**
   * The files with the line numbers of each one built from another version
   * than the checkout's dropped, and the paths dropped. A file the checkout
   * does not hold, or that names no checksum, is kept as it is.
   */
  async verify<T extends CoverageFile>(
    files: T[],
    checksums: ReadonlyMap<string, readonly string[]>,
  ): Promise<{ files: T[]; dropped: string[] }> {
    const dropped: string[] = [];
    const out = await Promise.all(
      files.map(async (file) => {
        const named = checksums.get(file.path);
        if (!named?.length) return file;
        const known = await this.checksumsOf(file.path);
        if (!known || named.every((checksum) => known.has(checksum))) return file;
        dropped.push(file.path);
        return withoutLines(file);
      }),
    );
    return { files: out, dropped: dropped.sort() };
  }

  private checksumsOf(relativePath: string): Promise<Set<string> | null> {
    let cached = this.cache.get(relativePath);
    if (!cached) {
      cached = this.read(relativePath);
      this.cache.set(relativePath, cached);
    }
    return cached;
  }

  private async read(relativePath: string): Promise<Set<string> | null> {
    try {
      const root = path.resolve(this.repoRoot());
      const file = path.resolve(root, relativePath);
      if (!file.startsWith(root + path.sep)) return null;
      return contentChecksums(await fs.promises.readFile(file));
    } catch {
      return null;
    }
  }
}
