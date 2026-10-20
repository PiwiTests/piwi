import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir, existsSync } from 'fs';
import { rm, stat } from 'fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { promisify } from 'util';
import type { StorageAdapter } from './types';

const readFileAsync = promisify(fsReadFile);
const writeFileAsync = promisify(fsWriteFile);
const mkdirAsync = promisify(fsMkdir);

/**
 * Local file system storage adapter
 * Stores files in a local directory
 */
export class LocalStorageAdapter implements StorageAdapter {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Resolve a relative storage path and guarantee it stays inside `basePath`.
   * Throws on any path that would escape the storage root (e.g. a `..` sequence
   * from an untrusted archive entry), so traversal can never reach the disk.
   */
  private resolvePath(path: string): string {
    const fullPath = join(this.basePath, path);
    const rel = relative(resolve(this.basePath), resolve(fullPath));
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Storage path escapes the storage root: ${path}`);
    }
    return fullPath;
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const fullPath = this.resolvePath(path);
    const dirPath = dirname(fullPath);

    // Ensure directory exists
    if (!existsSync(dirPath)) {
      await mkdirAsync(dirPath, { recursive: true });
    }

    await writeFileAsync(fullPath, data);
  }

  async readFile(path: string): Promise<Buffer> {
    const fullPath = this.resolvePath(path);
    return await readFileAsync(fullPath);
  }

  /** Whether a regular file is stored at `path`; a directory is not one. */
  async exists(path: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);
    try {
      return (await stat(fullPath)).isFile();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw error;
    }
  }

  async fileSize(path: string): Promise<number | null> {
    const fullPath = this.resolvePath(path);
    try {
      return (await stat(fullPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async mkdir(path: string): Promise<void> {
    const fullPath = this.resolvePath(path);
    if (!existsSync(fullPath)) {
      await mkdirAsync(fullPath, { recursive: true });
    }
  }

  getFullPath(path: string): string {
    return this.resolvePath(path);
  }

  async deleteFile(path: string): Promise<void> {
    const fullPath = this.resolvePath(path);
    try {
      await rm(fullPath, { force: true });
    } catch {
      // Ignore if it doesn't exist
    }
  }

  async deleteDirectory(path: string): Promise<void> {
    const fullPath = this.resolvePath(path);
    if (existsSync(fullPath)) {
      await rm(fullPath, { recursive: true, force: true });
    }
  }
}
