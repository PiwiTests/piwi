import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STALE_PRIVATE_FILE_MS, sweepStalePrivateFiles } from '../src/internal/support/private-file.js';
import { noteStop, readStopNote, readStopNotes, type StopNote } from '../src/internal/support/stop-notes.js';

const STOP = {
  reason: 'breakpoint',
  title: "Click locator('h1')",
  file: 'tests/a.spec.ts',
  line: 4,
  bar: false,
  since: 1_762_400_000_000,
  pausedMs: 0,
} as const;

describe('the stops a worker notes for the reporter’s process', () => {
  it('reads each line back field by field, and none that does not read', () => {
    const stopped: StopNote = { kind: 'stopped', testId: 't1', retry: 0, stop: STOP };
    expect(readStopNote(JSON.stringify(stopped))).toEqual(stopped);
    expect(readStopNote(JSON.stringify({ kind: 'resumed', testId: 't1', retry: 1, pausedMs: 900 }))).toEqual({
      kind: 'resumed',
      testId: 't1',
      retry: 1,
      pausedMs: 900,
    });
    for (const line of [
      'not json',
      '[]',
      JSON.stringify({ ...stopped, testId: '' }),
      JSON.stringify({ ...stopped, retry: -1 }),
      JSON.stringify({ ...stopped, stop: { ...STOP, since: 'now' } }),
      JSON.stringify({ kind: 'resumed', testId: 't1', retry: 0 }),
      JSON.stringify({ kind: 'moved', testId: 't1', retry: 0 }),
    ]) {
      expect(readStopNote(line), line).toBeNull();
    }
  });

  it('hands the reporter each note the workers append, in order, the last ones as it stops reading', () => {
    const env: NodeJS.ProcessEnv = {};
    const heard: StopNote[] = [];
    const reader = readStopNotes((note) => heard.push(note), env);
    expect(reader).not.toBeNull();
    const file = env.PIWI_STOP_NOTES;
    expect(file).toEqual(expect.any(String));
    noteStop(file, { kind: 'stopped', testId: 't1', retry: 0, stop: STOP });
    // Read at once when asked, as at a test's end, before the timer's next read.
    reader!.read();
    expect(heard.map((note) => note.kind)).toEqual(['stopped']);
    noteStop(file, { kind: 'resumed', testId: 't1', retry: 0, pausedMs: 1200 });
    reader!.stop();
    expect(heard.map((note) => note.kind)).toEqual(['stopped', 'resumed']);
    expect(env.PIWI_STOP_NOTES).toBeUndefined();
    // A note to a file no run reads is dropped, never thrown.
    expect(() => noteStop(file, { kind: 'resumed', testId: 't1', retry: 0, pausedMs: 1 })).not.toThrow();
    expect(() => noteStop(null, { kind: 'resumed', testId: 't1', retry: 0, pausedMs: 1 })).not.toThrow();
  });

  it('keeps a file a run still reads from another run’s sweep, however long since its last note', () => {
    const env: NodeJS.ProcessEnv = {};
    const heard: StopNote[] = [];
    const reader = readStopNotes((note) => heard.push(note), env)!;
    const file = env.PIWI_STOP_NOTES!;
    try {
      noteStop(file, { kind: 'stopped', testId: 't1', retry: 0, stop: STOP });
      reader.read();
      // A stop held for longer than a day: no worker writes, the file's times grow old.
      const old = new Date(Date.now() - 2 * STALE_PRIVATE_FILE_MS);
      fs.utimesSync(file, old, old);
      reader.read();
      sweepStalePrivateFiles(path.basename(file), { dir: path.dirname(file) });
      expect(fs.existsSync(file)).toBe(true);
      noteStop(file, { kind: 'resumed', testId: 't1', retry: 0, pausedMs: 1200 });
      reader.read();
      expect(heard.map((note) => note.kind)).toEqual(['stopped', 'resumed']);
    } finally {
      reader.stop();
    }
  });
});
