import { describe, expect, it } from 'vitest';
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
    const done = readStopNotes((note) => heard.push(note), env);
    expect(done).not.toBeNull();
    const file = env.PIWI_STOP_NOTES;
    expect(file).toEqual(expect.any(String));
    noteStop(file, { kind: 'stopped', testId: 't1', retry: 0, stop: STOP });
    noteStop(file, { kind: 'resumed', testId: 't1', retry: 0, pausedMs: 1200 });
    done!();
    expect(heard.map((note) => note.kind)).toEqual(['stopped', 'resumed']);
    expect(env.PIWI_STOP_NOTES).toBeUndefined();
    // A note to a file no run reads is dropped, never thrown.
    expect(() => noteStop(file, { kind: 'resumed', testId: 't1', retry: 0, pausedMs: 1 })).not.toThrow();
    expect(() => noteStop(null, { kind: 'resumed', testId: 't1', retry: 0, pausedMs: 1 })).not.toThrow();
  });
});
