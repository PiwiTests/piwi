import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyDemoMedia, projectMediaPath } from '../../scripts/copy-demo-media.mjs';

let root: string;
let publicDemoDir: string;
let storageDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'piwi-copy-demo-media-'));
  publicDemoDir = join(root, 'public', 'demo');
  storageDir = join(root, 'storage');
  for (const sub of ['screenshots', 'traces', 'videos']) mkdirSync(join(publicDemoDir, sub), { recursive: true });
  writeFileSync(join(publicDemoDir, 'screenshots', 'shot.png'), 'png-bytes');
  writeFileSync(join(publicDemoDir, 'traces', 'trace.zip'), 'zip-bytes');
  writeFileSync(join(publicDemoDir, 'videos', 'clip.webm'), 'webm-bytes');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('projectMediaPath', () => {
  test('puts a seeded demo path inside the folder of its project', () => {
    expect(projectMediaPath(2, 'demo/screenshots/shot.png')).toBe('project-2/demo/screenshots/shot.png');
  });
});

describe('copyDemoMedia', () => {
  const stored = [
    'project-1/demo/screenshots/shot.png',
    'project-1/demo/traces/trace.zip',
    'project-2/demo/videos/clip.webm',
  ];

  test('copies the binary behind each stored media path to that path in the storage directory', () => {
    const copied = copyDemoMedia(publicDemoDir, storageDir, stored);

    expect(copied).toBe(3);
    expect(readFileSync(join(storageDir, 'project-1', 'demo', 'screenshots', 'shot.png'), 'utf8')).toBe('png-bytes');
    expect(readFileSync(join(storageDir, 'project-1', 'demo', 'traces', 'trace.zip'), 'utf8')).toBe('zip-bytes');
    expect(readFileSync(join(storageDir, 'project-2', 'demo', 'videos', 'clip.webm'), 'utf8')).toBe('webm-bytes');
    // Only what a project's rows name lands in its folder.
    expect(existsSync(join(storageDir, 'project-2', 'demo', 'screenshots'))).toBe(false);
  });

  test('copies a path several rows name once', () => {
    expect(copyDemoMedia(publicDemoDir, storageDir, [stored[0]!, stored[0]!])).toBe(1);
  });

  test('is idempotent — a second run copies nothing and leaves files untouched', () => {
    copyDemoMedia(publicDemoDir, storageDir, stored);
    const dest = join(storageDir, 'project-1', 'demo', 'screenshots', 'shot.png');
    const firstMtime = statSync(dest).mtimeMs;

    const copiedAgain = copyDemoMedia(publicDemoDir, storageDir, stored);

    expect(copiedAgain).toBe(0);
    expect(statSync(dest).mtimeMs).toBe(firstMtime);
  });

  test('re-copies a file whose destination size no longer matches the source', () => {
    copyDemoMedia(publicDemoDir, storageDir, stored);
    const dest = join(storageDir, 'project-1', 'demo', 'screenshots', 'shot.png');
    writeFileSync(dest, 'x');

    const copied = copyDemoMedia(publicDemoDir, storageDir, stored);

    expect(copied).toBe(1);
    expect(readFileSync(dest, 'utf8')).toBe('png-bytes');
  });

  test('copies a nested media path', () => {
    mkdirSync(join(publicDemoDir, 'traces', 'nested'), { recursive: true });
    writeFileSync(join(publicDemoDir, 'traces', 'nested', 'inner.zip'), 'inner');

    copyDemoMedia(publicDemoDir, storageDir, ['project-3/demo/traces/nested/inner.zip']);

    expect(readFileSync(join(storageDir, 'project-3', 'demo', 'traces', 'nested', 'inner.zip'), 'utf8')).toBe('inner');
  });

  test('skips a path outside a project folder and a binary that is not committed', () => {
    const copied = copyDemoMedia(publicDemoDir, storageDir, [
      'demo/screenshots/shot.png',
      'project-1/reports/1/index.html',
      'project-1/demo/screenshots/missing.png',
    ]);

    expect(copied).toBe(0);
    expect(existsSync(storageDir)).toBe(false);
  });
});
