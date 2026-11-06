import { describe, expect, test } from 'vitest';
import { DEFAULT_RETRY_PREFS, parseRetryPrefs } from '../../app/utils/retry-prefs';

describe('parseRetryPrefs', () => {
  test('reads a cookie value written by the options', () => {
    const raw = JSON.stringify({ mode: 'grep', headed: true, trace: 'retain-on-failure', repeatEach: 4, workers: 2 });
    expect(parseRetryPrefs(raw)).toEqual({
      mode: 'grep',
      headed: true,
      trace: 'retain-on-failure',
      repeatEach: 4,
      workers: 2,
    });
  });

  test('anything missing, unknown or out of bounds reads as its default', () => {
    expect(parseRetryPrefs(null)).toEqual(DEFAULT_RETRY_PREFS);
    expect(parseRetryPrefs('not json')).toEqual(DEFAULT_RETRY_PREFS);
    expect(
      parseRetryPrefs({ mode: 'all', headed: 'yes', trace: 'off', repeatEach: 11, workers: 5, project: 'webkit' }),
    ).toEqual(DEFAULT_RETRY_PREFS);
    expect(parseRetryPrefs({ repeatEach: 2.5, workers: 0 })).toEqual(DEFAULT_RETRY_PREFS);
  });
});
