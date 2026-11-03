import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StreamBuffer } from '../src/internal/streaming/stream-buffer.js';
import { hashForProject } from '../src/internal/support/instance-id.js';
import {
  clearAriaSampleFile,
  loadAriaSampleSet,
  resetAriaSampleCache,
  writeAriaSampleFile,
} from '../src/internal/support/aria-sampling.js';
import { appendPrivateFile, readPrivateFile, writePrivateFile } from '../src/internal/support/private-file.js';
import type { CompleteStreamEvent } from '../src/types/wire.js';
import type * as NodeFs from 'node:fs';

const projectName = 'piwi-private-file-' + process.pid;
const streamFile = (runId: number) =>
  path.join(os.tmpdir(), `piwi-dashboard-stream-${hashForProject(projectName)}-${runId}.jsonl`);
const ariaFile = path.join(os.tmpdir(), `piwi-dashboard-aria-sample-${hashForProject(projectName)}.json`);
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-private-'));
});

afterEach(() => {
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
    expect(readPrivateFile(appended)).toEqual({ text: 'a\nb\n' });
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
