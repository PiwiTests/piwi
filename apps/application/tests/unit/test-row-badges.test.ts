import { describe, test, expect } from 'vitest';
import { buildTestRowBadges, badgesFromTestCase } from '../../app/utils/test-row-badges';
import type { TestCaseResult } from '../../types/api';

describe('buildTestRowBadges', () => {
  test('returns nothing when a test declared no signals or metadata', () => {
    expect(buildTestRowBadges({})).toEqual([]);
  });

  test('orders exceptional signals before tags and ownership metadata', () => {
    const badges = buildTestRowBadges({
      isNewRegression: true,
      quarantined: true,
      annotations: [
        { type: 'fixme', description: 'flaky login' },
        { type: 'tag', description: 'smoke' },
      ],
      tags: ['checkout'],
      meta: { owner: 'team-a', priority: 'critical', feature: 'cart' },
    });
    const keys = badges.map((b) => b.key);
    // Exceptional first: new regression, the mark, the tag mark, quarantined —
    // then priority, tags, owner, feature.
    expect(keys[0]).toBe('new-regression');
    expect(keys).toContain('quarantined');
    expect(keys.indexOf('new-regression')).toBeLessThan(keys.indexOf('quarantined'));
    expect(keys.indexOf('quarantined')).toBeLessThan(keys.indexOf('priority'));
    expect(keys.indexOf('priority')).toBeLessThan(keys.indexOf('tag:checkout'));
    expect(keys.indexOf('tag:checkout')).toBeLessThan(keys.indexOf('owner'));
    expect(keys.indexOf('owner')).toBeLessThan(keys.indexOf('feature'));
  });

  test('drops piwi ownership annotations from the marks (they render via meta)', () => {
    const badges = buildTestRowBadges({
      annotations: [{ type: 'piwi:owner', description: 'team-a' }, { type: 'slow' }],
    });
    expect(badges.map((b) => b.key)).toEqual(['mark:slow:']);
  });

  test('a tag mark renders its description and stays monospaced', () => {
    const [badge] = buildTestRowBadges({ annotations: [{ type: 'tag', description: 'smoke' }] });
    expect(badge).toMatchObject({ label: 'smoke', mono: true });
  });

  test('maps priority to its color', () => {
    expect(buildTestRowBadges({ meta: { priority: 'critical' } })[0]).toMatchObject({
      key: 'priority',
      label: 'critical',
      color: 'error',
    });
    expect(buildTestRowBadges({ meta: { priority: 'low' } })[0]).toMatchObject({ color: 'neutral' });
  });
});

describe('badgesFromTestCase', () => {
  const base: TestCaseResult = { executionId: 1, testCaseId: 1, title: 't', status: 'passed' };

  test('marks a passed-on-retry execution as an exceptional signal', () => {
    const badges = badgesFromTestCase({ ...base, status: 'passed', retries: 2 });
    expect(badges.map((b) => b.key)).toContain('passed-on-retry');
  });

  test('a passed execution with no retries carries no passed-on-retry badge', () => {
    expect(badgesFromTestCase({ ...base, status: 'passed', retries: 0 })).toEqual([]);
  });

  test('a retry whose earlier attempts passed carries no passed-on-retry badge', () => {
    // A describe.serial group retried for another test's failure runs this one again.
    const attempts = [
      { retry: 0, status: 'passed', duration: 10, startedAt: null },
      { retry: 1, status: 'passed', duration: 10, startedAt: null },
    ];
    expect(badgesFromTestCase({ ...base, status: 'passed', retries: 1, attempts })).toEqual([]);
    const failedFirst = [{ ...attempts[0]!, status: 'failed' }, attempts[1]!];
    expect(
      badgesFromTestCase({ ...base, status: 'passed', retries: 1, attempts: failedFirst }).map((b) => b.key),
    ).toEqual(['passed-on-retry']);
  });

  test('threads the quarantined flag through', () => {
    const badges = badgesFromTestCase({ ...base }, { quarantined: true });
    expect(badges.map((b) => b.key)).toEqual(['quarantined']);
  });
});
