import { describe, expect, test } from 'vitest';
import { fixturesActiveIn } from '../../app/utils/fixtures-active';

describe('fixturesActiveIn', () => {
  test('an execution holding data only the capture fixtures record ran with them', () => {
    expect(fixturesActiveIn({ ariaSnapshot: '- button "Sign in"' })).toBe(true);
    expect(fixturesActiveIn({ networkRequests: [{ url: '/shop/login' }] })).toBe(true);
    expect(fixturesActiveIn({ pageState: { url: '/shop/login' } })).toBe(true);
  });

  test('data read back from the trace, or none, says nothing of the fixtures', () => {
    expect(fixturesActiveIn(null)).toBe(false);
    expect(fixturesActiveIn({ consoleLogs: [], networkRequests: [] })).toBe(false);
    const traced = {
      ariaSnapshot: '- button',
      networkRequests: [{}],
      evidenceSources: { aria: 'trace', network: 'trace' },
    };
    expect(fixturesActiveIn(traced)).toBe(false);
  });
});
