import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../server/storage/local';

let dir: string;
let storage: LocalStorageAdapter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'piwi-local-storage-'));
  storage = new LocalStorageAdapter(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('LocalStorageAdapter.exists', () => {
  test('is true for a stored file only, never for a directory or a missing path', async () => {
    await storage.writeFile('project-1/run-2/trace.zip', Buffer.from('zip'));
    expect(await storage.exists('project-1/run-2/trace.zip')).toBe(true);
    expect(await storage.exists('project-1/run-2')).toBe(false);
    expect(await storage.exists('project-1/missing.zip')).toBe(false);
    expect(await storage.exists('project-1/run-2/trace.zip/inside')).toBe(false);
  });
});

describe('LocalStorageAdapter.readFileIfExists', () => {
  test('reads a stored file, and is null for a missing path', async () => {
    await storage.writeFile('avatars/1/a.webp', Buffer.from('webp'));
    expect((await storage.readFileIfExists('avatars/1/a.webp'))?.toString()).toBe('webp');
    expect(await storage.readFileIfExists('avatars/1/missing.webp')).toBeNull();
    expect(await storage.readFileIfExists('avatars/1/a.webp/inside')).toBeNull();
  });

  test('throws when the path cannot be read for another reason', async () => {
    await storage.writeFile('avatars/1/a.webp', Buffer.from('webp'));
    await expect(storage.readFileIfExists('avatars/1')).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('LocalStorageAdapter.writeFileFrom', () => {
  test('copies a file into storage, making its folders and leaving the source in place', async () => {
    const source = join(dir, 'upload.bin');
    const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
    writeFileSync(source, bytes);
    await storage.writeFileFrom('project-1/run-2/video.webm', source);
    expect((await storage.readFile('project-1/run-2/video.webm')).equals(bytes)).toBe(true);
    expect(await storage.exists('upload.bin')).toBe(true);
  });

  test('refuses a path that leaves the storage root, and a source that is not there', async () => {
    const source = join(dir, 'upload.bin');
    writeFileSync(source, 'x');
    await expect(storage.writeFileFrom('../escape.bin', source)).rejects.toThrow(/escapes the storage root/);
    await expect(storage.writeFileFrom('a.bin', join(dir, 'missing.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
