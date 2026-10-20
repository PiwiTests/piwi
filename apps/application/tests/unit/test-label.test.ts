import { describe, expect, test } from 'vitest';
import { testLabel, testTextLabel } from '#shared/utils/test-label';

describe('testLabel', () => {
  test('shows the title without its ID when the reporter removed it', () => {
    expect(testLabel({ title: '12526, Log in', displayTitle: 'Log in' })).toBe('Log in');
    expect(testLabel({ title: 'Log in', displayTitle: null })).toBe('Log in');
  });
});

describe('testTextLabel', () => {
  test('leads with the external ID', () => {
    expect(testTextLabel({ title: '12526, Log in', displayTitle: 'Log in', externalId: '12526' })).toBe(
      '12526 · Log in',
    );
    expect(testTextLabel({ title: 'Log in', externalId: 'TC-7' })).toBe('TC-7 · Log in');
  });

  test('does not repeat an ID the title already holds, and leaves a test without one as it is', () => {
    expect(testTextLabel({ title: '12526, Log in', externalId: '12526' })).toBe('12526, Log in');
    expect(testTextLabel({ title: 'Log in' })).toBe('Log in');
  });
});
