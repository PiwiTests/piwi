import { describe, expect, test } from 'vitest';
import { RUN_WORDS_EN } from '@piwitests/run-model/words';
import { heldStopWords, stopWords } from '../../app/utils/stop-words';

/**
 * What a stopped test says of its stop on the run page: its reason's words, and for a failed CI test held for its
 * controllers, the run model's words (`Failed, held at its line`), for whom and until when.
 */

const UNTIL = 1_800_000_000_000;
/** The page's clock, as a test reads it: the hold's end alone, at 12:05. */
const clock = (time: number) => (time === UNTIL ? '12:05' : 'another time');

describe('the words of a stop', () => {
  test('read a held CI failure as a failure held at its line', () => {
    expect(stopWords('held')).toBe(RUN_WORDS_EN.runs_stateFailed);
    expect(stopWords('failure')).toBe('Held at its failure');
    expect(stopWords('later')).toBe('Stopped');
  });

  test('say for whom a held CI failure is held, and until when', () => {
    expect(heldStopWords({ until: UNTIL }, ['Ana'], clock)).toBe('Held for Ana · until 12:05');
    expect(heldStopWords({ until: UNTIL }, ['Ana', 'Bo', 'Cy'], clock)).toBe('Held for Ana, Bo, and Cy · until 12:05');
    expect(heldStopWords({ until: UNTIL }, [], clock)).toBe('Held · until 12:05');
    // A held stop of a reporter that said no end names none.
    expect(heldStopWords({}, ['Ana'], clock)).toBeNull();
  });
});
