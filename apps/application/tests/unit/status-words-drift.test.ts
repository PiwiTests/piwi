import { describe, expect, test } from 'vitest';
import { formatStatusLabel } from '../../app/utils/index';
// Imported from the editor service's source: the words a test's line leads with in both editors.
import { statusWords } from '../../../../packages/editor/src/status-words';

/**
 * A test's status reads the same in the dashboard (`formatStatusLabel`) and on its line in both editors (the editor
 * service's `statusWords`). The words stay in each surface's own code; this test holds them together.
 */
describe('the words of a test’s status', () => {
  test('are the dashboard’s in the editors', () => {
    const statuses = [
      'passed',
      'failed',
      'flaky',
      'skipped',
      'timedOut',
      'timedout',
      'didnotrun',
      'never-run',
      'interrupted',
      'running',
      // Any other status is its own word on both sides.
      'some-new-status',
    ];
    expect(statuses.map(statusWords)).toEqual(statuses.map(formatStatusLabel));
  });
});
