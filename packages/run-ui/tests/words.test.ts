import { describe, expect, test } from 'vitest';
import { CONNECTION_WORDS, teamInstanceHost, optionWords, testCountWords } from '../app/utils/run-target-words';

describe('teamInstanceHost', () => {
  test('names the host of an address', () => {
    expect(teamInstanceHost('https://piwi.example.com:8443/some/path')).toBe('piwi.example.com:8443');
  });

  test('keeps what is not a URL as given, and names none', () => {
    expect(teamInstanceHost('not a url')).toBe('not a url');
    expect(teamInstanceHost(null)).toBe('your team instance');
    expect(teamInstanceHost('')).toBe('your team instance');
  });
});

describe('testCountWords', () => {
  test('says a test for one and a count for the rest', () => {
    expect(testCountWords(1)).toBe('a test');
    expect(testCountWords(3)).toBe('3 tests');
  });
});

describe('optionWords', () => {
  test('lists only what the request sets', () => {
    expect(optionWords({ headed: false })).toEqual(['headless']);
    expect(optionWords({ headed: true, trace: 'on', repeatEach: 3, workers: 2, project: 'chromium' })).toEqual([
      'headed',
      'trace on',
      'repeat 3×',
      '2 workers',
      'project chromium',
    ]);
    expect(optionWords({ headed: false, repeatEach: 1 })).toEqual(['headless']);
  });

  test('is empty without options', () => {
    expect(optionWords(null)).toEqual([]);
    expect(optionWords(undefined)).toEqual([]);
  });
});

describe('CONNECTION_WORDS', () => {
  test('has words for every state of the connection', () => {
    expect(Object.keys(CONNECTION_WORDS).sort()).toEqual(
      ['connecting', 'none', 'offline', 'online', 'revoked', 'signing-in'].sort(),
    );
  });
});
