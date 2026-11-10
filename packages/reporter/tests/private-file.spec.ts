import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StreamBuffer } from '../src/internal/streaming/stream-buffer.js';
import { recoveryFilePath } from '../src/internal/streaming/crash-recovery.js';
import { hashForProject } from '../src/internal/support/instance-id.js';
import { getSetupFilePath, writeSetupInfo } from '../src/internal/support/setup-file.js';
import {
  clearAriaSampleFile,
  loadAriaSampleSet,
  resetAriaSampleCache,
  writeAriaSampleFile,
} from '../src/internal/support/aria-sampling.js';
import {
  appendPrivateFile,
  legacyPrivateTempDir,
  privateTempDir,
  readPrivateFile,
  STALE_PRIVATE_FILE_MS,
  sweepStalePrivateFiles,
  writePrivateFile,
} from '../src/internal/support/private-file.js';
import type { CompleteStreamEvent } from '../src/types/wire.js';
import { stubPlatform } from './_helpers.js';
import type * as NodeFs from 'node:fs';

const projectName = 'piwi-private-file-' + process.pid;
const streamFile = (runId: number) =>
  path.join(privateTempDir(), `piwi-dashboard-stream-${hashForProject(projectName)}-${runId}.jsonl`);
const ariaFile = path.join(privateTempDir(), `piwi-dashboard-aria-sample-${hashForProject(projectName)}.json`);
const posix = process.platform !== 'win32';

function completeEvent(title: string): CompleteStreamEvent {
  return {
    type: 'complete',
    title,
    location: 'test.spec.ts:1:1',
    status: 'passed',
    duration: 0,
    error: null,
    retries: 0,
    workerIndex: 0,
    shardIndex: null,
    startedAt: null,
  };
}

/** A symbolic link at `at` to a new file holding `contents`; null where links cannot be made. */
function plantLink(at: string, contents: string): string | null {
  const target = path.join(dir, 'target.txt');
  fs.writeFileSync(target, contents);
  try {
    fs.symlinkSync(target, at);
  } catch {
    return null; // creating a link needs a privilege some systems do not grant
  }
  return target;
}

let dir: string;
/** Puts the real `process.platform` back after a test that stubbed it. */
let realPlatform: (() => void) | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-private-'));
});

afterEach(() => {
  realPlatform?.();
  realPlatform = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const file of [streamFile(1), streamFile(2), ariaFile]) fs.rmSync(file, { force: true });
  resetAriaSampleCache();
});

describe('the stream buffer file', () => {
  it.skipIf(!posix)('is readable by its owner alone', () => {
    const buffer = new StreamBuffer(projectName);
    buffer.bindRun(1);
    buffer.append([completeEvent('kept')]);
    expect(fs.statSync(streamFile(1)).mode & 0o777).toBe(0o600);
    expect(buffer.load().map((e) => e.title)).toEqual(['kept']);
  });

  it('is never written nor read through a symbolic link', () => {
    const target = plantLink(streamFile(1), `${JSON.stringify(completeEvent('planted'))}\n`);
    if (!target) return;
    const buffer = new StreamBuffer(projectName);
    buffer.bindRun(1);
    buffer.append([completeEvent('ours')]);
    expect(fs.readFileSync(target, 'utf8')).not.toContain('ours');
    expect(buffer.load()).toEqual([]);
  });

  it.skipIf(!posix)('is neither written nor read when another user owns it', () => {
    const buffer = new StreamBuffer(projectName);
    buffer.bindRun(2);
    buffer.append([completeEvent('first')]);
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    buffer.append([completeEvent('second')]);
    expect(buffer.load()).toEqual([]);
    vi.restoreAllMocks();
    expect(buffer.load().map((e) => e.title)).toEqual(['first']);
  });

  it.skipIf(!posix)('is not read when other users may write to it', () => {
    const buffer = new StreamBuffer(projectName);
    buffer.bindRun(1);
    buffer.append([completeEvent('kept')]);
    fs.chmodSync(streamFile(1), 0o666);
    expect(buffer.load()).toEqual([]);
  });
});

describe('the ARIA sample file', () => {
  it('replaces a symbolic link at its path instead of writing through it', () => {
    const target = plantLink(ariaFile, 'untouched');
    if (!target) return;
    writeAriaSampleFile(projectName, ['a']);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    expect(fs.lstatSync(ariaFile).isSymbolicLink()).toBe(false);
    expect(loadAriaSampleSet(projectName)).toEqual(new Set(['a']));
  });

  it.skipIf(!posix)('is readable by its owner alone, and ignored when another user owns it', () => {
    writeAriaSampleFile(projectName, ['a']);
    expect(fs.statSync(ariaFile).mode & 0o777).toBe(0o600);
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    expect(loadAriaSampleSet(projectName)).toBeNull();
    clearAriaSampleFile(projectName);
  });
});

describe('a private temp file', () => {
  it.skipIf(!posix)('is written and appended readable by its owner alone', () => {
    const written = path.join(dir, 'written.json');
    const appended = path.join(dir, 'appended.jsonl');
    writePrivateFile(written, '{}');
    appendPrivateFile(appended, 'a\n');
    appendPrivateFile(appended, 'b\n');
    expect(fs.statSync(written).mode & 0o777).toBe(0o600);
    expect(fs.statSync(appended).mode & 0o777).toBe(0o600);
    expect(readPrivateFile(appended)).toMatchObject({ text: 'a\nb\n' });
  });

  it('is never appended through a symbolic link', () => {
    const file = path.join(dir, 'results.jsonl');
    const target = plantLink(file, 'untouched');
    if (!target) return;
    expect(() => appendPrivateFile(file, 'census\n')).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    expect(readPrivateFile(file)).toEqual({ untrusted: 'it is a symbolic link' });
  });

  it('is never appended through a symbolic link where the open cannot refuse one, as on Windows', async () => {
    const file = path.join(dir, 'results.jsonl');
    const target = plantLink(file, 'untouched');
    if (!target) return;
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      const constants = { ...actual.constants, O_NOFOLLOW: undefined, O_NONBLOCK: undefined };
      return { ...actual, constants, default: { ...actual, constants } };
    });
    try {
      const windows = await import('../src/internal/support/private-file.js');
      expect(() => windows.appendPrivateFile(file, 'census\n')).toThrow(/symbolic link/);
      expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it.skipIf(!posix)('is never opened when it is a named pipe, so an append never waits for a reader', () => {
    const file = path.join(dir, 'results.jsonl');
    execFileSync('mkfifo', [file]);
    // A reader that opens late releases an append waiting for one, so a wait fails the test instead of hanging it.
    const lateReader =
      "const fs = require('node:fs'); setTimeout(() => { fs.openSync(process.argv[1], fs.constants.O_RDONLY | " +
      'fs.constants.O_NONBLOCK); setInterval(() => {}, 1000); }, 2000);';
    const reader = spawn(process.execPath, ['-e', lateReader, file], { stdio: 'ignore' });
    try {
      const started = Date.now();
      expect(() => appendPrivateFile(file, 'census\n')).toThrow(/not a regular file/);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(readPrivateFile(file)).toEqual({ untrusted: 'it is not a regular file' });
    } finally {
      reader.kill();
    }
  });

  it.skipIf(!posix)('is never appended to under another name', () => {
    const file = path.join(dir, 'results.jsonl');
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'untouched', { mode: 0o600 });
    fs.linkSync(target, file);
    expect(() => appendPrivateFile(file, 'census\n')).toThrow(/another name/);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
  });

  it('reads as absent when there is none', () => {
    expect(readPrivateFile(path.join(dir, 'none.json'))).toBeNull();
  });
});

describe('the files a killed run left', () => {
  /** A file of `dir`, last changed `ageMs` ago. */
  const fileAged = (name: string, ageMs: number): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'note\n');
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
    return file;
  };

  it('are removed once unchanged for a day, those of the prefix alone', () => {
    const stale = fileAged('piwi-stop-notes-old.txt', STALE_PRIVATE_FILE_MS + 60_000);
    const live = fileAged('piwi-stop-notes-live.txt', STALE_PRIVATE_FILE_MS - 60_000);
    const other = fileAged('piwi-run-log-old.txt', STALE_PRIVATE_FILE_MS + 60_000);
    sweepStalePrivateFiles('piwi-stop-notes-', { dir });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('never remove a link nor what it names', () => {
    const at = path.join(dir, 'piwi-stop-notes-link.txt');
    const target = plantLink(at, 'untouched');
    if (!target) return;
    const old = new Date(Date.now() - 2 * STALE_PRIVATE_FILE_MS);
    fs.utimesSync(target, old, old);
    fs.lutimesSync(at, old, old);
    sweepStalePrivateFiles('piwi-stop-notes-', { dir });
    expect(fs.lstatSync(at).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
  });

  it('leave the folder alone when it cannot be read', () => {
    expect(() => sweepStalePrivateFiles('piwi-stop-notes-', { dir: path.join(dir, 'missing') })).not.toThrow();
  });
});

describe('the private temp folder', () => {
  /** Run as if on `platform`, with this user's local application data folder at `local`, until the test ends. */
  function onPlatform(platform: NodeJS.Platform, local: string | undefined): void {
    realPlatform?.();
    realPlatform = stubPlatform(platform);
    vi.stubEnv('LOCALAPPDATA', local);
  }

  it('is os.tmpdir() on Linux and macOS, with no folder created', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      onPlatform(platform, path.join(dir, 'Local'));
      expect(privateTempDir()).toBe(os.tmpdir());
      expect(legacyPrivateTempDir()).toBeNull();
    }
    expect(fs.existsSync(path.join(dir, 'Local'))).toBe(false);
  });

  it("is piwi\\tmp in this user's local application data folder on Windows, created on first use", () => {
    onPlatform('win32', path.join(dir, 'Local'));
    const folder = path.join(dir, 'Local', 'piwi', 'tmp');
    expect(privateTempDir()).toBe(folder);
    expect(fs.statSync(folder).isDirectory()).toBe(true);
    expect(privateTempDir()).toBe(folder);
    expect(legacyPrivateTempDir()).toBe(os.tmpdir());
  });

  it('is under AppData\\Local in the home folder on Windows when LOCALAPPDATA is not set', () => {
    onPlatform('win32', undefined);
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    const folder = path.join(dir, 'AppData', 'Local', 'piwi', 'tmp');
    expect(privateTempDir()).toBe(folder);
    expect(fs.statSync(folder).isDirectory()).toBe(true);
  });

  it('holds the setup file, the stream buffer, the ARIA sample set and the recovery file on Windows', () => {
    onPlatform('win32', dir);
    const folder = path.join(dir, 'piwi', 'tmp');
    writeSetupInfo({ runId: 1, setupToken: 't', projectName });
    const buffer = new StreamBuffer(projectName);
    buffer.bindRun(3);
    buffer.append([completeEvent('kept')]);
    writeAriaSampleFile(projectName, ['a']);

    const hash = hashForProject(projectName);
    expect(fs.readdirSync(folder).sort()).toEqual(
      [
        path.basename(getSetupFilePath(projectName)),
        `piwi-dashboard-stream-${hash}-3.jsonl`,
        `piwi-dashboard-aria-sample-${hash}.json`,
      ].sort(),
    );
    expect(path.dirname(getSetupFilePath(projectName))).toBe(folder);
    expect(path.dirname(recoveryFilePath('http://a.example', projectName))).toBe(folder);
    expect(buffer.load().map((event) => event.title)).toEqual(['kept']);
    expect(loadAriaSampleSet(projectName)).toEqual(new Set(['a']));
  });
});
