import { describe, expect, test } from 'vitest';
import {
  ANY_RUN_SCOPE,
  DEFAULT_AUTO_CREATE,
  DEFAULT_AUTO_CREATE_RULE,
  describeAutoCreateDecision,
  describeRunScope,
  descriptionDigest,
  evaluateAutoCreate,
  noteWindow,
  runInScope,
  tagsMatch,
  type AutoCreateFacts,
  type AutoCreatePolicy,
  type AutoCreateRule,
  type ClusterFailureRun,
} from '../../shared/integrations/automation';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

function run(overrides: Partial<ClusterFailureRun> = {}): ClusterFailureRun {
  return {
    runId: 1,
    startedAt: NOW,
    occurrences: 1,
    branch: 'main',
    environment: 'staging',
    isDefaultBranch: true,
    ...overrides,
  };
}

function facts(overrides: Partial<AutoCreateFacts> = {}): AutoCreateFacts {
  return {
    status: 'open',
    snoozed: false,
    tracked: false,
    flaky: false,
    tags: [],
    owner: null,
    failures: [run({ runId: 1, startedAt: NOW - 2 * DAY }), run({ runId: 2, startedAt: NOW })],
    ...overrides,
  };
}

function rule(overrides: Partial<AutoCreateRule> = {}): AutoCreateRule {
  return { ...DEFAULT_AUTO_CREATE_RULE, ...overrides };
}

function policy(overrides: Partial<AutoCreatePolicy> = {}): AutoCreatePolicy {
  return { ...DEFAULT_AUTO_CREATE, enabled: true, ...overrides };
}

describe('runInScope', () => {
  const onMain = { branch: 'main', environment: 'staging', isDefaultBranch: true };
  const onFeature = { branch: 'feat/login', environment: 'staging', isDefaultBranch: false };

  test('a scope that names nothing takes every run, a run without a branch included', () => {
    expect(runInScope(ANY_RUN_SCOPE, onMain)).toBe(true);
    expect(runInScope(ANY_RUN_SCOPE, onFeature)).toBe(true);
    expect(runInScope(ANY_RUN_SCOPE, { branch: null, environment: null, isDefaultBranch: false })).toBe(true);
  });

  test('the default branch matches whatever it is named', () => {
    const scope = { ...ANY_RUN_SCOPE, defaultBranch: true };
    expect(runInScope(scope, { ...onMain, branch: 'trunk' })).toBe(true);
    expect(runInScope(scope, onFeature)).toBe(false);
  });

  test('branch patterns match with *, alongside the default branch', () => {
    const scope = { branches: ['release/*'], defaultBranch: true, environments: [] };
    expect(runInScope(scope, { ...onFeature, branch: 'release/2.1' })).toBe(true);
    expect(runInScope(scope, onMain)).toBe(true);
    expect(runInScope(scope, onFeature)).toBe(false);
    expect(runInScope({ ...scope, defaultBranch: false }, onMain)).toBe(false);
  });

  test('environments name the run’s environment by its key or an alias, ignoring case, else its label', () => {
    const scope = { ...ANY_RUN_SCOPE, environments: ['Staging'] };
    const stg = { ...onMain, environment: 'stg', environmentKey: 'staging', environmentAliases: ['stg'] };
    expect(runInScope(scope, stg)).toBe(true);
    expect(runInScope({ ...ANY_RUN_SCOPE, environments: ['STG'] }, stg)).toBe(true);
    expect(runInScope({ ...ANY_RUN_SCOPE, environments: ['production'] }, stg)).toBe(false);
    // A label no environment takes is matched as written, ignoring case.
    expect(runInScope({ ...ANY_RUN_SCOPE, environments: ['preview-*'] }, { ...onMain, environment: 'Preview-7' })).toBe(
      true,
    );
  });

  test('environments narrow the runs, and a run with no environment matches none', () => {
    const scope = { ...ANY_RUN_SCOPE, environments: ['prod*'] };
    expect(runInScope(scope, { ...onMain, environment: 'production' })).toBe(true);
    expect(runInScope(scope, onMain)).toBe(false);
    expect(runInScope(scope, { ...onMain, environment: null })).toBe(false);
  });

  test('a scope reads as words', () => {
    expect(describeRunScope(ANY_RUN_SCOPE)).toBe('every branch');
    expect(describeRunScope({ branches: ['release/*'], defaultBranch: true, environments: ['staging'] })).toBe(
      'the default branch, release/* in staging',
    );
  });
});

describe('tagsMatch', () => {
  test('no tag named lets every test in; otherwise one shared tag does, @ and case aside', () => {
    expect(tagsMatch([], [])).toBe(true);
    expect(tagsMatch(['smoke'], ['@Smoke', 'slow'])).toBe(true);
    expect(tagsMatch(['@critical'], ['smoke'])).toBe(false);
  });
});

describe('evaluateAutoCreate', () => {
  test('files when the first rule meets every threshold', () => {
    const decision = evaluateAutoCreate(policy(), [], facts(), { now: NOW });
    expect(decision.verdict).toBe('file');
    if (decision.verdict !== 'file') return;
    expect(decision.progress).toMatchObject({ ruleIndex: 0, occurrences: 2, runs: 2, days: 2, unmet: [] });
    expect(decision.progress.branches).toEqual(['main']);
    expect(decision.progress.environments).toEqual(['staging']);
  });

  test('waits, naming what is missing, until the thresholds are met', () => {
    const p = policy({ rules: [rule({ minRuns: 3, minDays: 5 })] });
    const decision = evaluateAutoCreate(p, [], facts(), { now: NOW });
    expect(decision.verdict).toBe('wait');
    if (decision.verdict !== 'wait') return;
    expect(decision.progress.unmet).toEqual(['runs', 'days']);
    expect(describeAutoCreateDecision(decision, p)).toBe('Waiting on rule 1: 2 of 3 runs, 2 of 5 days');
  });

  test('counts only the runs in the rule scope', () => {
    const f = facts({
      failures: [
        run({ runId: 1, branch: 'feat/a', isDefaultBranch: false, occurrences: 9 }),
        run({ runId: 2, branch: 'main' }),
      ],
    });
    const decision = evaluateAutoCreate(policy(), [], f, { now: NOW });
    expect(decision.verdict).toBe('wait');
    if (decision.verdict === 'wait') expect(decision.progress).toMatchObject({ occurrences: 1, runs: 1 });
  });

  test('a later rule files what an earlier one only makes wait', () => {
    const p = policy({
      rules: [rule({ minRuns: 10 }), rule({ defaultBranch: false, branches: ['main'], minOccurrences: 1, minRuns: 1 })],
    });
    const decision = evaluateAutoCreate(p, [], facts(), { now: NOW });
    expect(decision).toMatchObject({ verdict: 'file', progress: { ruleIndex: 1 } });
    expect(describeAutoCreateDecision(decision, p)).toBe('Meets rule 2: 2 occurrences in 2 runs over 2 days');
  });

  test('with a current run, a rule acts only when that run is one it counts', () => {
    const f = facts({
      failures: [run({ runId: 1 }), run({ runId: 2 }), run({ runId: 3, branch: 'feat/a', isDefaultBranch: false })],
    });
    expect(evaluateAutoCreate(policy(), [], f, { now: NOW, currentRunId: 3 })).toEqual({
      verdict: 'skip',
      reason: 'no-rule',
    });
    expect(evaluateAutoCreate(policy(), [], f, { now: NOW, currentRunId: 2 }).verdict).toBe('file');
  });

  test('a rule naming tags leaves out a cluster whose tests carry none of them', () => {
    const p = policy({ rules: [rule({ tags: ['critical'] })] });
    expect(evaluateAutoCreate(p, [], facts({ tags: ['smoke'] }), { now: NOW })).toEqual({
      verdict: 'skip',
      reason: 'no-rule',
    });
    expect(evaluateAutoCreate(p, [], facts({ tags: ['@critical'] }), { now: NOW }).verdict).toBe('file');
  });

  test('the guards come before any rule', () => {
    const p = policy();
    expect(evaluateAutoCreate({ ...p, enabled: false }, [], facts(), { now: NOW })).toMatchObject({
      reason: 'disabled',
    });
    expect(evaluateAutoCreate(p, [], facts({ status: 'resolved' }), { now: NOW })).toMatchObject({
      reason: 'not-open',
    });
    expect(evaluateAutoCreate(p, [], facts({ snoozed: true }), { now: NOW })).toMatchObject({ reason: 'snoozed' });
    expect(evaluateAutoCreate(p, [], facts({ tracked: true }), { now: NOW })).toMatchObject({ reason: 'tracked' });
    expect(evaluateAutoCreate(p, [], facts({ flaky: true }), { now: NOW })).toMatchObject({ reason: 'flaky' });
    expect(evaluateAutoCreate({ ...p, skipFlaky: false }, [], facts({ flaky: true }), { now: NOW }).verdict).toBe(
      'file',
    );
  });

  test('with owner routes, an unmatched owner is filed only when unmatched owners go to the default', () => {
    const routes = [{ owner: '@acme/checkout', projectKey: 'CHK' }];
    expect(evaluateAutoCreate(policy(), routes, facts({ owner: '@acme/search' }), { now: NOW })).toMatchObject({
      reason: 'no-route',
    });
    expect(evaluateAutoCreate(policy(), routes, facts({ owner: '@ACME/checkout' }), { now: NOW }).verdict).toBe('file');
    const routed = policy({ routeUnmatchedToDefault: true });
    expect(evaluateAutoCreate(routed, routes, facts({ owner: null }), { now: NOW }).verdict).toBe('file');
  });

  test('a threshold of one reads singular', () => {
    const p = policy({ rules: [rule({ minOccurrences: 1, minRuns: 1, minDays: 1 })] });
    const decision = evaluateAutoCreate(p, [], facts({ failures: [run({ startedAt: NOW })] }), { now: NOW });
    expect(describeAutoCreateDecision(decision, p)).toBe('Waiting on rule 1: 0 of 1 day');
  });

  test('a skip reads as words', () => {
    expect(describeAutoCreateDecision({ verdict: 'skip', reason: 'tracked' }, policy())).toBe(
      'Already tracked by an issue',
    );
  });
});

describe('noteWindow', () => {
  test('a day is its UTC date', () => {
    expect(noteWindow('day', new Date(NOW))).toBe('2026-10-08');
  });

  test('a week is its ISO 8601 week, across year boundaries', () => {
    expect(noteWindow('week', new Date(NOW))).toBe('2026-W41');
    expect(noteWindow('week', new Date(Date.UTC(2025, 11, 29)))).toBe('2026-W01');
    expect(noteWindow('week', new Date(Date.UTC(2026, 0, 1)))).toBe('2026-W01');
    expect(noteWindow('week', new Date(Date.UTC(2027, 0, 1)))).toBe('2026-W53');
    expect(noteWindow('week', new Date(Date.UTC(2027, 0, 4)))).toBe('2027-W01');
  });
});

describe('descriptionDigest', () => {
  test('ignores whitespace but not wording', async () => {
    const a = await descriptionDigest('What happened\n\nTimed out  clicking Pay');
    expect(await descriptionDigest('What happenedTimed out clicking Pay')).toBe(a);
    expect(await descriptionDigest('What happened Timed out clicking Buy')).not.toBe(a);
  });
});
