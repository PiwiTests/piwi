import { describe, expect, it } from 'vitest';
import { endedAtStopOf, endedAtStopWords } from '../src/outcome';
import { englishRunSpeaker as en } from '../src/words';

describe('how a run came out beyond its status', () => {
  it('counts the tests ended at a stop as the run’s own process counted them, within the skipped', () => {
    expect(endedAtStopOf({ skipped: 2, endedAtStop: 1 })).toBe(1);
    expect(endedAtStopOf({ skipped: 1, endedAtStop: 3 })).toBe(1);
    // A reporter that predates the count names none.
    expect(endedAtStopOf({ skipped: 2 })).toBe(0);
    expect(endedAtStopOf(null)).toBe(0);
  });

  it('marks a run whose tests were ended at a stop, never a plain pass', () => {
    expect(endedAtStopWords(1, en)).toBe('1 ended at a stop');
    expect(endedAtStopWords(3, en)).toBe('3 ended at a stop');
    expect(endedAtStopWords(0, en)).toBeNull();
  });
});
