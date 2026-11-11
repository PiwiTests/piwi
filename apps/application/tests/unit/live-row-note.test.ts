import { describe, expect, it } from 'vitest';
import { liveRowNote, liveRowShows, type LiveRowRun } from '../../app/utils/live-row-note';

const run = (over: Partial<LiveRowRun>): LiveRowRun => ({
  live: true,
  desktop: false,
  workers: 0,
  ...over,
});

describe('what a running row says where Watch would be', () => {
  it('says nothing of a run nobody shares: the Tests toolbar says it once', () => {
    expect(liveRowNote(run({}))).toBeNull();
  });

  it('says, in the desktop app, where a live run’s pages show, until a worker of it joins the view', () => {
    expect(liveRowNote(run({ desktop: true }))).toBe('desktop');
    expect(liveRowNote(run({ desktop: true, workers: 1 }))).toBeNull();
  });

  it('says nothing once the run ended', () => {
    expect(liveRowNote(run({ live: false, desktop: true }))).toBeNull();
  });
});

describe('what a running row shows where Watch would be', () => {
  const row = (over: Partial<Parameters<typeof liveRowShows>[0]>) =>
    liveRowShows({ liveWorker: false, desktopWorker: false, note: null, ...over });

  it('shows Watch on its worker in the run’s live view, before anything else', () => {
    expect(row({ liveWorker: true, desktopWorker: true, note: 'desktop' })).toBe('watch');
  });

  it('shows Pause and watch, in the desktop app, in place of the note on a run it started', () => {
    expect(row({ desktopWorker: true, note: 'desktop' })).toBe('pause-and-watch');
  });

  it('shows the run’s note on a row no worker of either serves, and nothing without one', () => {
    expect(row({ note: 'desktop' })).toBe('desktop');
    expect(row({})).toBeNull();
  });
});
