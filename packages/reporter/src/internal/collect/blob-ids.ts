import { execFile } from 'node:child_process';
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

/** Whether a file's entry names line numbers, which refer to one version of the file. */
function namesLines(file: CoverageFile & { executable?: unknown[]; allFunctions?: unknown[] }): boolean {
  return Boolean(file.functions?.length || file.lines?.length || file.executable?.length || file.allFunctions?.length);
}

/** Paths hashed by one `git hash-object` at most. */
const GIT_BATCH = 500;

/**
 * The blob ids git gives repository-relative paths under `root`
 * (`git hash-object --stdin-paths`), after its own filters: a checkout with
 * CRLF line endings that git stores as LF (`core.autocrlf`, `.gitattributes`)
 * gets the id of what git stores. Null when git is missing or fails.
 */
export function gitHashObjects(root: string, paths: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['hash-object', '--stdin-paths'],
      { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true },
      (error, stdout) => {
        const ids = error ? [] : stdout.split('\n').filter(Boolean);
        resolve(ids.length === paths.length ? ids : null);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(`${paths.join('\n')}\n`);
  });
}

/**
 * The blob ids of repository-relative files in the checkout, each read once
 * per run, the ones not read yet in one batch: as git gives them, else hashed
 * as they are on disk when git cannot. A file that is missing, unreadable, or
 * resolves outside the repository root has none.
 */
export class BlobIds {
  private readonly cache = new Map<string, Promise<string | null>>();

  /**
   * @param repoRoot The repository root the paths are relative to, found on first use.
   * @param hashObjects How git hashes paths; {@link gitHashObjects} unless a test replaces it.
   */
  constructor(
    private readonly repoRoot: () => string,
    private readonly hashObjects: (root: string, paths: string[]) => Promise<string[] | null> = gitHashObjects,
  ) {}

  /**
   * The files with the blob id of each one that names line numbers (functions, lines, executable lines or every
   * function) and has a blob in the checkout.
   */
  async withBlobs<T extends CoverageFile>(files: T[]): Promise<T[]> {
    const named = files.filter(namesLines);
    const blobs = new Map<string, string | null>();
    const ids = await this.blobsOf(named.map((file) => file.path));
    named.forEach((file, i) => blobs.set(file.path, ids[i] ?? null));
    return files.map((file) => {
      const blob = blobs.get(file.path);
      return blob && namesLines(file) ? { ...file, blob } : file;
    });
  }

  /** The blob id of each repository-relative path, or null. */
  private blobsOf(relativePaths: string[]): Promise<Array<string | null>> {
    const fresh = [...new Set(relativePaths.filter((p) => !this.cache.has(p)))];
    for (let start = 0; start < fresh.length; start += GIT_BATCH) {
      const batch = fresh.slice(start, start + GIT_BATCH);
      const read = this.read(batch);
      batch.forEach((p, i) =>
        this.cache.set(
          p,
          read.then((ids) => ids[i] ?? null),
        ),
      );
    }
    return Promise.all(relativePaths.map((p) => this.cache.get(p)!));
  }

  private async read(relativePaths: string[]): Promise<Array<string | null>> {
    let root: string;
    try {
      root = path.resolve(this.repoRoot());
    } catch {
      return relativePaths.map(() => null);
    }
    const files = await Promise.all(
      relativePaths.map(async (relativePath) => {
        const file = path.resolve(root, relativePath);
        if (!file.startsWith(root + path.sep)) return null;
        const stat = await fs.promises.stat(file).catch(() => null);
        return stat?.isFile() ? file : null;
      }),
    );
    // Git reads one path per line: a path with a line break is hashed here.
    const forGit = files.flatMap((file) => (file && !/[\r\n]/.test(file) ? [file] : []));
    const fromGit = new Map<string, string>();
    const ids =
      forGit.length > 0
        ? await this.hashObjects(
            root,
            forGit.map((file) => path.relative(root, file)),
          )
        : null;
    if (ids) forGit.forEach((file, i) => fromGit.set(file, ids[i]!));
    return Promise.all(
      files.map(async (file) => {
        if (!file) return null;
        const id = fromGit.get(file);
        if (id) return id;
        try {
          return gitBlobId(await fs.promises.readFile(file));
        } catch {
          return null;
        }
      }),
    );
  }
}
