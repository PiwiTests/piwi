import { describe, it, expect } from 'vitest';
import {
  mergeAnnotations,
  classifyStatus,
  expectsFailure,
  expectedFailureError,
} from '@piwitests/core/status-classify';

describe('mergeAnnotations', () => {
  it('merges test- and result-level annotations, deduped', () => {
    const merged = mergeAnnotations(
      { annotations: [{ type: 'skip', description: 'reason' }] },
      { annotations: [{ type: 'skip', description: 'reason' }, { type: 'tag', description: '@smoke' }] },
    );
    expect(merged).toEqual([
      { type: 'skip', description: 'reason' },
      { type: 'tag', description: '@smoke' },
    ]);
  });

  it('handles missing annotation arrays', () => {
    expect(mergeAnnotations({}, {})).toEqual([]);
    expect(mergeAnnotations({ annotations: [{ type: 'fixme' }] }, {})).toEqual([{ type: 'fixme' }]);
  });

  it('keeps entries with the same type but different descriptions', () => {
    const merged = mergeAnnotations(
      { annotations: [{ type: 'skip', description: 'a' }] },
      { annotations: [{ type: 'skip', description: 'b' }] },
    );
    expect(merged).toHaveLength(2);
  });
});

describe('classifyStatus', () => {
  it('passes non-skipped statuses through unchanged', () => {
    expect(classifyStatus('passed', [])).toBe('passed');
    expect(classifyStatus('failed', [])).toBe('failed');
    expect(classifyStatus('timedOut', [])).toBe('timedOut');
  });

  it('keeps an intentional skip (skip annotation) as skipped', () => {
    expect(classifyStatus('skipped', [{ type: 'skip', description: 'flaky on CI' }])).toBe('skipped');
    expect(classifyStatus('skipped', [{ type: 'skip' }])).toBe('skipped');
  });

  it('keeps a fixme as skipped', () => {
    expect(classifyStatus('skipped', [{ type: 'fixme', description: 'broken' }])).toBe('skipped');
  });

  it('reclassifies an annotation-less skip (serial cascade) as didnotrun', () => {
    expect(classifyStatus('skipped', [])).toBe('didnotrun');
    expect(classifyStatus('skipped', [{ type: 'tag', description: '@smoke' }])).toBe('didnotrun');
  });

  it('counts a test.fail() failure as passed (expected)', () => {
    expect(classifyStatus('failed', [{ type: 'fail' }])).toBe('passed');
    expect(classifyStatus('failed', [{ type: 'fail', description: 'known bug' }])).toBe('passed');
  });

  it('counts a test.fail() pass as failed (unexpected)', () => {
    expect(classifyStatus('passed', [{ type: 'fail' }])).toBe('failed');
  });

  it('leaves a test.fail() timeout as timed out (Playwright counts it unexpected)', () => {
    expect(classifyStatus('timedOut', [{ type: 'fail' }])).toBe('timedOut');
  });

  it('keeps skip/fixme precedence over fail for a should-fail test that was skipped', () => {
    expect(classifyStatus('skipped', [{ type: 'fail' }, { type: 'skip' }])).toBe('skipped');
    // A should-fail test skipped by a serial cascade (fail mark, no skip mark).
    expect(classifyStatus('skipped', [{ type: 'fail' }])).toBe('didnotrun');
  });
});

describe('expectsFailure', () => {
  it('is true for a fail annotation', () => {
    expect(expectsFailure([{ type: 'fail' }])).toBe(true);
    expect(expectsFailure([{ type: 'tag', description: '@x' }, { type: 'fail' }])).toBe(true);
  });

  it('is false without a fail annotation', () => {
    expect(expectsFailure([])).toBe(false);
    expect(expectsFailure([{ type: 'slow' }])).toBe(false);
  });

  it('lets skip/fixme win over fail', () => {
    expect(expectsFailure([{ type: 'fail' }, { type: 'skip' }])).toBe(false);
    expect(expectsFailure([{ type: 'fixme' }, { type: 'fail' }])).toBe(false);
  });
});

describe('expectedFailureError', () => {
  it('describes only a should-fail test that unexpectedly passed', () => {
    expect(expectedFailureError('passed', [{ type: 'fail' }])).toBe('Expected to fail, but passed.');
  });

  it('is null for an expected failure or a plain pass', () => {
    expect(expectedFailureError('failed', [{ type: 'fail' }])).toBeNull();
    expect(expectedFailureError('passed', [])).toBeNull();
    expect(expectedFailureError('timedOut', [{ type: 'fail' }])).toBeNull();
  });
});
