import { describe, test, expect } from 'vitest';
import { describeRunBaseline, describeRunBaselineParts, type RunBaselineMatch } from '#shared/run-baseline';

type Side = { branch: string | null; environment: string | null };
type Fallback = { branch: string; source: 'default' | 'pull-request' };

const run: Side = { branch: 'feature/x', environment: 'staging' };
const fallback: Fallback = { branch: 'main', source: 'default' };
const pr: Fallback = { branch: 'develop', source: 'pull-request' };

function describe_(
  match: RunBaselineMatch,
  baseline: Side = { branch: 'main', environment: 'staging' },
  overrides: Partial<{ run: Side; fallback: Fallback | null }> = {},
) {
  return describeRunBaseline({ run: overrides.run ?? run, baseline, match, fallback: overrides.fallback ?? fallback });
}

describe('describeRunBaseline', () => {
  test('same branch, same environment', () => {
    expect(
      describe_(
        { branch: 'same', environment: 'same', outcome: 'passed' },
        { branch: 'feature/x', environment: 'staging' },
      ),
    ).toBe('The last passing run on feature/x in staging.');
  });

  test('fallback branch names the default branch or the pull request target', () => {
    expect(describe_({ branch: 'fallback', environment: 'same', outcome: 'passed' })).toBe(
      'No passing staging run exists on feature/x; the last passing run on the default branch main in staging.',
    );
    expect(
      describe_(
        { branch: 'fallback', environment: 'same', outcome: 'passed' },
        { branch: 'develop', environment: 'staging' },
        { fallback: pr },
      ),
    ).toBe(
      "No passing staging run exists on feature/x; the last passing run on the pull request's target branch develop in staging.",
    );
  });

  test('any branch within the environment', () => {
    expect(
      describe_(
        { branch: 'any', environment: 'same', outcome: 'passed' },
        { branch: 'release/2', environment: 'staging' },
      ),
    ).toBe(
      'No passing staging run exists on feature/x or main; the most recent passing run in staging, from release/2.',
    );
  });

  test('another environment says the environment is missing, then where the run came from', () => {
    expect(
      describe_(
        { branch: 'same', environment: 'other', outcome: 'passed' },
        { branch: 'feature/x', environment: 'production' },
      ),
    ).toBe('No passing staging run exists; the last passing run on feature/x, from the production environment.');
    expect(
      describe_({ branch: 'fallback', environment: 'other', outcome: 'passed' }, { branch: 'main', environment: null }),
    ).toBe(
      'No passing staging run exists, and no passing run exists on feature/x; the last passing run on the default branch main, from a run with no environment label.',
    );
    expect(
      describe_(
        { branch: 'any', environment: 'other', outcome: 'passed' },
        { branch: 'hotfix', environment: 'production' },
      ),
    ).toBe(
      'No passing staging run exists, and no passing run exists on feature/x or main; the most recent passing run, from hotfix in production.',
    );
  });

  test('a chosen base branch is named as the choice', () => {
    expect(
      describe_(
        { branch: 'chosen', environment: 'same', outcome: 'passed' },
        { branch: 'release/1', environment: 'staging' },
      ),
    ).toBe('The last passing run on release/1 in staging, the base branch you chose.');
    expect(
      describe_(
        { branch: 'chosen', environment: 'other', outcome: 'passed' },
        { branch: 'release/1', environment: 'production' },
      ),
    ).toBe(
      'No passing staging run exists on release/1; the last passing run on release/1, the base branch you chose, from the production environment.',
    );
  });

  test('a run without an environment label reads on the branch axis only', () => {
    const noEnv = { branch: 'feature/x', environment: null };
    expect(
      describe_(
        { branch: 'same', environment: null, outcome: 'passed' },
        { branch: 'feature/x', environment: null },
        { run: noEnv },
      ),
    ).toBe('The last passing run on feature/x.');
    expect(
      describe_(
        { branch: 'fallback', environment: null, outcome: 'passed' },
        { branch: 'main', environment: null },
        { run: noEnv },
      ),
    ).toBe('No passing run exists on feature/x; the last passing run on the default branch main.');
    expect(
      describe_(
        { branch: 'any', environment: null, outcome: 'passed' },
        { branch: 'other', environment: null },
        { run: noEnv },
      ),
    ).toBe('No passing run exists on feature/x or main; the most recent passing run, from other.');
  });

  test('a run without a branch reads on the environment axis only', () => {
    const noBranch = { branch: null, environment: 'staging' };
    expect(
      describe_(
        { branch: null, environment: 'same', outcome: 'passed' },
        { branch: 'main', environment: 'staging' },
        { run: noBranch },
      ),
    ).toBe('This run has no branch; the last passing staging run.');
    expect(
      describe_(
        { branch: null, environment: 'other', outcome: 'passed' },
        { branch: 'main', environment: 'production' },
        { run: noBranch },
      ),
    ).toBe(
      'This run has no branch, and no passing staging run exists; the most recent passing run, from the production environment.',
    );
    expect(
      describe_(
        { branch: null, environment: null, outcome: 'passed' },
        { branch: null, environment: null },
        { run: { branch: null, environment: null } },
      ),
    ).toBe('The most recent passing run.');
  });
});

describe('describeRunBaseline with a failed baseline', () => {
  test('says no earlier full run passed, then which failed run was taken', () => {
    expect(
      describe_(
        { branch: 'same', environment: 'same', outcome: 'failed' },
        { branch: 'feature/x', environment: 'staging' },
      ),
    ).toBe('No earlier full run passed; the last failed run on feature/x in staging.');
    expect(describe_({ branch: 'fallback', environment: 'same', outcome: 'failed' })).toBe(
      'No earlier full run passed, and no failed staging run exists on feature/x; the last failed run on the default branch main in staging.',
    );
  });

  test('lists three reasons with one "and"', () => {
    expect(
      describe_({ branch: 'fallback', environment: 'other', outcome: 'failed' }, { branch: 'main', environment: null }),
    ).toBe(
      'No earlier full run passed, no failed staging run exists, and no failed run exists on feature/x; the last failed run on the default branch main, from a run with no environment label.',
    );
  });

  test('a chosen base branch scopes the missing passing run to that branch', () => {
    expect(
      describe_(
        { branch: 'chosen', environment: 'same', outcome: 'failed' },
        { branch: 'release/1', environment: 'staging' },
      ),
    ).toBe(
      'No earlier full run passed on release/1; the last failed run on release/1 in staging, the base branch you chose.',
    );
  });

  test('a run with neither branch nor environment', () => {
    expect(
      describe_(
        { branch: null, environment: null, outcome: 'failed' },
        { branch: null, environment: null },
        { run: { branch: null, environment: null } },
      ),
    ).toBe('No earlier full run passed; the most recent failed run.');
  });
});

describe('describeRunBaselineParts', () => {
  test('marks branch and environment names as their own parts, merging the words between', () => {
    const parts = describeRunBaselineParts({
      run,
      baseline: { branch: 'main', environment: 'staging' },
      match: { branch: 'fallback', environment: 'same', outcome: 'passed' },
      fallback,
    });
    expect(parts).toEqual([
      { kind: 'text', text: 'No passing ' },
      { kind: 'environment', name: 'staging' },
      { kind: 'text', text: ' run exists on ' },
      { kind: 'branch', name: 'feature/x' },
      { kind: 'text', text: '; the last passing run on the default branch ' },
      { kind: 'branch', name: 'main' },
      { kind: 'text', text: ' in ' },
      { kind: 'environment', name: 'staging' },
      { kind: 'text', text: '.' },
    ]);
  });

  test('joins back to the plain sentence', () => {
    const input = {
      run,
      baseline: { branch: 'hotfix', environment: 'production' },
      match: { branch: 'any', environment: 'other', outcome: 'passed' } as RunBaselineMatch,
      fallback,
    };
    const joined = describeRunBaselineParts(input)
      .map((p) => (p.kind === 'text' ? p.text : p.name))
      .join('');
    expect(joined).toBe(describeRunBaseline(input));
  });
});
