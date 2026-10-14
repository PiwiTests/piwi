import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoverageFile } from '@piwitests/core/coverage';

/**
 * The git blob id of a file's content, the id `git hash-object` gives a file
 * git stores unfiltered: the SHA-1 of `blob <byte length>\0` followed by the
 * content.
 */
export function gitBlobId(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/**
 * The blob ids of repository-relative files in the checkout, each read once
 * per run. A file that is missing, unreadable, or resolves outside the
 * repository root has none.
 */
export class BlobIds {
  private readonly cache = new Map<string, Promise<string | null>>();

  /** @param repoRoot The repository root the paths are relative to, found on first use. */
  constructor(private readonly repoRoot: () => string) {}

  /** The blob id of a repository-relative path, or null. */
  blobOf(relativePath: string): Promise<string | null> {
    let blob = this.cache.get(relativePath);
    if (!blob) {
      blob = this.read(relativePath);
      this.cache.set(relativePath, blob);
    }
    return blob;
  }

  /** The files with the blob id of each one that names line numbers and has a blob in the checkout. */
  async withBlobs<T extends CoverageFile>(files: T[]): Promise<T[]> {
    return Promise.all(
      files.map(async (file) => {
        if (!file.functions?.length && !file.lines?.length) return file;
        const blob = await this.blobOf(file.path);
        return blob ? { ...file, blob } : file;
      }),
    );
  }

  private async read(relativePath: string): Promise<string | null> {
    try {
      const root = path.resolve(this.repoRoot());
      const file = path.resolve(root, relativePath);
      if (!file.startsWith(root + path.sep)) return null;
      return gitBlobId(await fs.promises.readFile(file));
    } catch {
      return null;
    }
  }
}
