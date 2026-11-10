import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePausedMs, parseTestStop, type TestStop } from '@piwitests/core/wire';
import { PIWI_STOP_NOTES_ENV } from '../config/env.js';
import {
  appendPrivateFile,
  keepPrivateFileLive,
  privateTempDir,
  readPrivateFile,
  sweepStalePrivateFiles,
  writePrivateFile,
} from './private-file.js';

/** How the run's stop notes files are named, a random part following. */
const STOP_NOTES_PREFIX = 'piwi-stop-notes-';

/**
 * The stops of a run's tests, as their workers tell them to the reporter's own process. A stop shows in a worker, and
 * only the reporter's process streams to the instance, so the reporter names a private file for the workers in
 * `onBegin` (`PIWI_STOP_NOTES`, `readStopNotes`), which a worker appends a line to as a stop shows and as it ends
 * (`noteStop`), and which the reporter reads every `READ_MS`.
 */

/** How often the reporter's process reads the lines the workers appended. */
const READ_MS = 500;

/** A stop that showed (`stopped`) or ended (`resumed`), of the attempt `retry` of the test `testId`. */
export type StopNote =
  | { kind: 'stopped'; testId: string; retry: number; stop: TestStop }
  | { kind: 'resumed'; testId: string; retry: number; pausedMs: number };

/** Append `note` to the file the reporter reads, when it names one. Never throws. */
export function noteStop(file: string | null | undefined, note: StopNote): void {
  if (!file) return;
  try {
    appendPrivateFile(file, `${JSON.stringify(note)}\n`);
  } catch {
    // A note that cannot be written is not told.
  }
}

/** A line a worker appended, read back field by field; null when it does not read. */
export function readStopNote(line: string): StopNote | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const { kind, testId, retry } = value as Record<string, unknown>;
  if (typeof testId !== 'string' || !testId || typeof retry !== 'number' || !Number.isInteger(retry) || retry < 0) {
    return null;
  }
  if (kind === 'stopped') {
    const stop = parseTestStop((value as { stop?: unknown }).stop);
    return stop ? { kind, testId, retry, stop } : null;
  }
  if (kind === 'resumed') {
    const pausedMs = parsePausedMs((value as { pausedMs?: unknown }).pausedMs);
    return pausedMs === null ? null : { kind, testId, retry, pausedMs };
  }
  return null;
}

/** Reading the notes: `read` hears the ones appended since, `stop` hears the last ones and removes the file. */
export interface StopNotesReader {
  read: () => void;
  stop: () => void;
}

/**
 * Hand `hear` each stop the workers that start from now on note: a new private file, named in `env` for them, read
 * every `READ_MS` and whenever `read` is called. Null when no file can be made: the run then tells no stop.
 */
export function readStopNotes(
  hear: (note: StopNote) => void,
  env: NodeJS.ProcessEnv = process.env,
): StopNotesReader | null {
  sweepStalePrivateFiles(STOP_NOTES_PREFIX);
  const file = path.join(privateTempDir(), `${STOP_NOTES_PREFIX}${randomBytes(12).toString('hex')}.txt`);
  try {
    writePrivateFile(file, '');
  } catch {
    return null;
  }
  env[PIWI_STOP_NOTES_ENV] = file;
  let read = 0;
  const flush = (): void => {
    let text: string;
    try {
      const found = readPrivateFile(file);
      if (!found || !('text' in found)) return;
      text = found.text;
      keepPrivateFileLive(file);
    } catch {
      return;
    }
    // Whole lines alone: one a worker is still writing waits for the next read.
    const end = text.lastIndexOf('\n') + 1;
    if (end <= read) return;
    const lines = text.slice(read, end).split('\n');
    read = end;
    for (const line of lines) {
      const note = line ? readStopNote(line) : null;
      if (!note) continue;
      try {
        hear(note);
      } catch {
        // A note the reporter could not tell is lost, never the run.
      }
    }
  };
  const timer = setInterval(flush, READ_MS);
  timer.unref();
  return {
    read: flush,
    stop: () => {
      clearInterval(timer);
      flush();
      delete env[PIWI_STOP_NOTES_ENV];
      fs.rmSync(file, { force: true });
    },
  };
}
