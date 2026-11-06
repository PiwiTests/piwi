import { describe, expect, it } from 'vitest';
import { answeredRunUrl, runUrl } from '../src/internal/support/run-url.js';

describe("a run's page", () => {
  it('is the one the instance names, a path under the address the reporter reached it at', () => {
    expect(answeredRunUrl({ runUrl: 'https://piwi.example.com/test-runs/7' }, 'http://piwi:3000', 7)).toBe(
      'https://piwi.example.com/test-runs/7',
    );
    expect(answeredRunUrl({ runUrl: '/test-runs/7' }, 'http://piwi:3000/', 7)).toBe('http://piwi:3000/test-runs/7');
  });

  it('is built under the reporter’s own address from an instance that names none, or one that does not read', () => {
    const own = runUrl('http://piwi:3000', 7);
    for (const answer of [
      null,
      {},
      { runUrl: 7 },
      { runUrl: '' },
      { runUrl: 'javascript:alert(1)' },
      { runUrl: 'ftp://piwi/test-runs/7' },
      { runUrl: '//evil.example/test-runs/7' },
      { runUrl: 'https://piwi.example.com/test-runs/7) [x](https://evil.example' },
      { runUrl: 'https://piwi.example.com/test runs/7' },
    ]) {
      expect(answeredRunUrl(answer, 'http://piwi:3000', 7), JSON.stringify(answer)).toBe(own);
    }
  });
});
