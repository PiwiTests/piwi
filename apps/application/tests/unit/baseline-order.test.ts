import { describe, test, expect } from 'vitest';
import { rankBaselineCandidates, baselineEnvironmentNote } from '#shared/baseline-order';

/**
 * Candidates arrive most recent first; ranking keeps that order inside a tier.
 */
const candidates = [
  { id: 1, environment: 'production', branch: 'main' },
  { id: 2, environment: 'development', branch: 'feature/x' },
  { id: 3, environment: 'production', branch: 'feature/x' },
  { id: 4, environment: 'development', branch: 'main' },
  { id: 5, environment: null, branch: null },
];

const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id);

describe('rankBaselineCandidates', () => {
  test('same environment first, then same branch, then recency', () => {
    const failing = { environment: 'development', branch: 'main' };
    expect(ids(rankBaselineCandidates(failing, candidates))).toEqual([4, 2, 1, 3, 5]);
  });

  test('a same-environment pass on another branch beats a same-branch pass from another environment', () => {
    const failing = { environment: 'development', branch: 'main' };
    const ranked = rankBaselineCandidates(failing, [candidates[0]!, candidates[1]!]);
    expect(ids(ranked)).toEqual([2, 1]);
  });

  test('an unknown failing environment ranks by branch, then recency', () => {
    const failing = { environment: null, branch: 'feature/x' };
    expect(ids(rankBaselineCandidates(failing, candidates))).toEqual([2, 3, 1, 4, 5]);
  });

  test('an unknown failing branch ranks by environment, then recency', () => {
    const failing = { environment: 'production', branch: null };
    expect(ids(rankBaselineCandidates(failing, candidates))).toEqual([1, 3, 2, 4, 5]);
  });

  test('nothing known keeps the input (most recent first) order', () => {
    expect(ids(rankBaselineCandidates({ environment: null, branch: null }, candidates))).toEqual([1, 2, 3, 4, 5]);
  });

  test('a known Playwright version ranks after the environment and before the branch', () => {
    const failing = { environment: 'production', branch: 'main', playwrightVersion: '1.65.1' };
    const versioned = [
      { id: 1, environment: 'production', branch: 'main', playwrightVersion: '1.64.1' },
      { id: 2, environment: 'staging', branch: 'main', playwrightVersion: '1.65.1' },
      { id: 3, environment: 'production', branch: 'feature/x', playwrightVersion: '1.65.1' },
      { id: 4, environment: 'production', branch: 'main', playwrightVersion: null },
      { id: 5, environment: 'production', branch: 'main', playwrightVersion: '1.65.1' },
    ];
    expect(ids(rankBaselineCandidates(failing, versioned))).toEqual([5, 3, 1, 4, 2]);
  });

  test('a failing run with no Playwright version ranks no candidate by version', () => {
    const versioned = candidates.map((c, i) => ({ ...c, playwrightVersion: i % 2 ? '1.65.1' : '1.64.1' }));
    const failing = { environment: 'development', branch: 'main' };
    expect(ids(rankBaselineCandidates(failing, versioned))).toEqual([4, 2, 1, 3, 5]);
  });

  test('does not mutate the input', () => {
    const copy = [...candidates];
    rankBaselineCandidates({ environment: 'development', branch: 'main' }, candidates);
    expect(candidates).toEqual(copy);
  });
});

describe('baselineEnvironmentNote', () => {
  test('names the environment the baseline came from when it differs', () => {
    const note = baselineEnvironmentNote(
      { environment: 'development', branch: 'main' },
      { environment: 'production', branch: 'main' },
    );
    expect(note).toBe('compared with a production run; no passing development run of this test exists');
  });

  test('handles a baseline with no environment label', () => {
    const note = baselineEnvironmentNote({ environment: 'staging', branch: null }, { environment: null, branch: null });
    expect(note).toBe('compared with a run with no environment label; no passing staging run of this test exists');
  });

  test('is null for the same environment or an unlabeled failing run', () => {
    expect(
      baselineEnvironmentNote({ environment: 'production', branch: 'a' }, { environment: 'production', branch: 'b' }),
    ).toBeNull();
    expect(
      baselineEnvironmentNote({ environment: null, branch: 'a' }, { environment: 'production', branch: 'a' }),
    ).toBeNull();
  });
});
