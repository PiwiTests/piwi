import { describe, expect, it } from 'vitest';
import { liveRowNote, type LiveRowRun } from '../../app/utils/live-row-note';

const run = (over: Partial<LiveRowRun>): LiveRowRun => ({
  live: true,
  desktop: false,
  keyed: false,
  ci: false,
  workers: 0,
  ...over,
});

describe('what a running row says where Watch would be', () => {
  it('says a keyed run outside CI is not shared, until a worker of it joins the view', () => {
    expect(liveRowNote(run({ keyed: true }))).toBe('unshared');
    expect(liveRowNote(run({ keyed: true, workers: 1 }))).toBeNull();
  });

  it('says nothing of a CI run, whose workers join at once, nor of a run without a key', () => {
    expect(liveRowNote(run({ keyed: true, ci: true }))).toBeNull();
    expect(liveRowNote(run({ keyed: false }))).toBeNull();
  });

  it('says, in the desktop app, where a live run’s pages show', () => {
    expect(liveRowNote(run({ desktop: true }))).toBe('desktop');
    expect(liveRowNote(run({ desktop: true, keyed: true }))).toBe('desktop');
  });

  it('says nothing once the run ended', () => {
    expect(liveRowNote(run({ live: false, keyed: true }))).toBeNull();
    expect(liveRowNote(run({ live: false, desktop: true }))).toBeNull();
  });
});
