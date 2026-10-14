import { describe, test, expect } from 'vitest';
import { computeNextStep, type FlakeLabStepFacts, type NextStepInput } from '#shared/next-step';

function step(overrides: Partial<NextStepInput> = {}) {
  return computeNextStep({ clusterId: 10, executionId: 100, ...overrides });
}

describe('computeNextStep — one row per rule', () => {
  test('1: a did-not-run cascade opens the blocking failure', () => {
    const s = step({ status: 'didnotrun', blockedByCase: { id: 7, title: 'login' } });
    expect(s.kind).toBe('open-blocker');
    expect(s.primary.payload).toEqual({ executionId: 7 });
  });

  test('1: the blocker step says what to do, not why the test did not run', () => {
    const s = step({ status: 'didnotrun', blockedByCase: { id: 7, title: 'login' } });
    expect(s.why).toBe('Nothing to fix in this test: it runs again once that failure is fixed.');
    expect(s.why).not.toMatch(/did not run|stopped/);
  });

  describe('1b: a test the run never started, with no blocker, opens the run', () => {
    const run = (overrides: Partial<NextStepInput>) => step({ status: 'didnotrun', runId: 66, ...overrides });

    test('max-failures with one failure in the run opens that failure', () => {
      const s = run({ didNotRunReason: 'max-failures', runFailedExecutionId: 747 });
      expect(s).toMatchObject({
        kind: 'open-run',
        title: 'Open the failure that stopped the run',
        primary: { label: 'Open the failure', action: 'open-execution', payload: { executionId: 747 } },
        secondary: [],
        source: null,
      });
    });

    test('max-failures with several failures opens the failures of the run', () => {
      const s = run({ didNotRunReason: 'max-failures' });
      expect(s.title).toBe("Open the run's failures");
      expect(s.primary).toEqual({
        label: 'Open the failures',
        action: 'open-run',
        payload: { runId: 66, tab: 'failure-groups' },
      });
    });

    test('an earlier failure in its group with no blocker found opens the failures of the run', () => {
      const s = run({ didNotRunReason: 'previous-failure' });
      expect(s.kind).toBe('open-run');
      expect(s.primary.payload).toEqual({ runId: 66, tab: 'failure-groups' });
    });

    test('a global timeout opens the timeline of the run', () => {
      const s = run({ didNotRunReason: 'global-timeout' });
      expect(s.title).toBe('See what made the run slow');
      expect(s.primary).toEqual({
        label: "Open the run's timeline",
        action: 'open-run',
        payload: { runId: 66, tab: 'workers' },
      });
    });

    test('an interruption or no reason opens the run', () => {
      for (const didNotRunReason of ['interrupted', null]) {
        const s = run({ didNotRunReason });
        expect(s.title).toBe('Open the run');
        expect(s.primary).toEqual({ label: 'Open run #66', action: 'open-run', payload: { runId: 66 } });
      }
    });

    test('never reproduces or diagnoses, and never restates the reason', () => {
      for (const didNotRunReason of ['max-failures', 'global-timeout', 'interrupted', 'previous-failure', null]) {
        const s = run({ didNotRunReason, aiConfigured: true, why: null });
        expect(['reproduce', 'diagnose']).not.toContain(s.kind);
        expect(s.why.startsWith('Nothing to fix in this test: ')).toBe(true);
        expect(s.why).not.toMatch(/maximum number|global timeout|interrupted|did not run/);
      }
    });

    test('the blocker row wins when the blocking failure is known', () => {
      expect(run({ didNotRunReason: 'previous-failure', blockedByCase: { id: 7 } }).kind).toBe('open-blocker');
    });
  });

  test('2: a verified fix that held, still open → mark resolved', () => {
    const s = step({ fixVerification: 'diagnosis-verified', clusterStatus: 'open', fixLandedRunId: 62 });
    expect(s.kind).toBe('mark-resolved');
    expect(s.title).toContain('run #62');
  });

  test('3: a locator-resolution failure with a healing recommendation', () => {
    const s = step({ hasHealingRecommendation: true });
    expect(s.kind).toBe('replace-locator');
  });

  test('3: with an edit of the failing line, the apply command first, the locator next, the .patch file in the menu', () => {
    const s = step({ hasHealingRecommendation: true, healingEditAvailable: true });
    expect(s.primary).toMatchObject({ label: 'Copy apply command', action: 'copy-git-apply' });
    expect(s.secondary.map((a) => a.label)).toEqual([
      'Copy locator',
      'Download .patch',
      'Pick from snapshot',
      'All alternatives',
    ]);
    expect(s.secondary.map((a) => a.action).slice(0, 2)).toEqual(['copy-locator', 'download-patch']);
  });

  test('3: without an edit, the recommended locator is the change, and nothing offers an apply command', () => {
    const s = step({ hasHealingRecommendation: true, healingEditAvailable: false });
    expect(s.primary).toMatchObject({ label: 'Copy locator', action: 'copy-locator' });
    expect(s.secondary.map((a) => a.label)).toEqual(['Pick from snapshot', 'All alternatives']);
    expect(
      [s.primary, ...s.secondary].some((a) => a.action === 'copy-git-apply' || a.action === 'download-patch'),
    ).toBe(false);
  });

  test('4: a completed diagnosis whose patch applies cleanly', () => {
    const s = step({
      diagnosisCompleted: true,
      patchAppliesCleanly: true,
      patchFile: 'api/Users/UsersEndpoints.cs',
      diagnosisSummary: 'DefaultPageSize 50 → 25',
    });
    expect(s.kind).toBe('apply-patch');
    expect(s.primary).toMatchObject({ label: 'Copy apply command', action: 'copy-git-apply' });
    expect(s.title).toContain('api/Users/UsersEndpoints.cs');
    // The summary is the "Most likely" line's job; the step names only the work.
    expect(s.title).not.toContain('DefaultPageSize 50 → 25');
  });

  test('5: a completed diagnosis whose patch is stale or absent', () => {
    const s = step({ diagnosisCompleted: true, patchAppliesCleanly: false, diagnosisSummary: 'race on render' });
    expect(s.kind).toBe('follow-diagnosis');
  });

  test.each([
    [{ hasPatch: false }, 'A diagnosis explains the failure, but it proposes no patch.'],
    [
      { hasPatch: true, patchValidationStatus: 'stale-file' },
      'A diagnosis explains the failure, but its patch no longer applies to the current code.',
    ],
    [
      { hasPatch: true, patchValidationStatus: 'invalid' },
      'A diagnosis explains the failure, but its patch is not a valid diff.',
    ],
    [
      { hasPatch: true, patchValidationStatus: 'unchecked' },
      'A diagnosis explains the failure, but its patch could not be checked against the code.',
    ],
    [
      { hasPatch: true, patchValidationStatus: null },
      'A diagnosis explains the failure, but its patch could not be checked against the code.',
    ],
  ] as Array<[Partial<NextStepInput>, string]>)(
    '5: the reason says why the patch is not the step (%o)',
    (facts, why) => {
      const s = step({ diagnosisCompleted: true, ...facts });
      expect(s.kind).toBe('follow-diagnosis');
      expect(s.why).toBe(why);
    },
  );

  test('6: a regressed fix → see what changed', () => {
    const s = step({ fixVerification: 'regressed', fixCommit: 'demo001' });
    expect(s.kind).toBe('see-what-changed');
    expect(s.title).toContain('demo001');
  });

  test('6: a regressed fix names its commit by the short SHA', () => {
    const s = step({ fixVerification: 'regressed', fixCommit: '3f9c2e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e' });
    expect(s.title).toBe('See what changed since the fix in 3f9c2e1 — it did not hold');
  });

  test('9: passed-on-retry → compare attempts', () => {
    expect(step({ why: 'passed-on-retry' }).kind).toBe('compare-attempts');
    expect(step({ why: 'new-flaky' }).kind).toBe('compare-attempts');
  });

  test('10: a crash with a CI re-run configured', () => {
    expect(step({ errorKind: 'crash', ciRerunAvailable: true }).kind).toBe('rerun-in-ci');
    expect(step({ errorKind: 'navigation', ciRerunAvailable: true }).kind).toBe('rerun-in-ci');
  });

  test('11: AI configured and no diagnosis → diagnose', () => {
    expect(step({ aiConfigured: true }).kind).toBe('diagnose');
  });

  test('12: otherwise reproduce locally', () => {
    expect(step({}).kind).toBe('reproduce');
  });

  // The policy does not see the clues, so the fallback steps say nothing about them.
  test('11 and 12 make no claim about what is known', () => {
    for (const s of [step({ aiConfigured: true }), step({})]) {
      expect(`${s.title} ${s.why}`).not.toMatch(/nothing|conclusive|deterministic/i);
    }
    expect(step({ aiConfigured: true }).title).toBe('Diagnose with AI');
    expect(step({}).title).toBe('Reproduce locally');
  });
});

describe('computeNextStep — precedence between rows', () => {
  test('a verified fix whose patch still applied at its commit goes to the patch, with Mark resolved last in its menu', () => {
    const s = step({
      fixVerification: 'diagnosis-verified',
      clusterStatus: 'open',
      diagnosisCompleted: true,
      patchAppliesCleanly: true,
      patchAppliesAtFix: true,
    });
    expect(s.kind).toBe('apply-patch');
    expect(s.why).toBe('A fix was verified, but the diagnosed patch still applied to the code at its commit.');
    expect(s.secondary.at(-1)).toEqual({ label: 'Mark resolved', action: 'mark-resolved', payload: { clusterId: 10 } });
  });

  test('a verified fix whose patch applied only when it was diagnosed is marked resolved', () => {
    // The #10 case: the patch validated against the code the model was shown,
    // before the fix; nothing says it still applies at the fix's commit.
    for (const patchAppliesAtFix of [false, undefined]) {
      const s = step({
        fixVerification: 'diagnosis-verified',
        clusterStatus: 'open',
        fixLandedRunId: 62,
        diagnosisCompleted: true,
        patchAppliesCleanly: true,
        patchAppliesAtFix,
      });
      expect(s.kind).toBe('mark-resolved');
      expect(s.title).toBe('Mark the cluster resolved — the fix held in run #62');
    }
  });

  test('the patch outranks a locator replacement while a verified fix is unconfirmed on an open cluster', () => {
    const unconfirmed = {
      fixVerification: 'diagnosis-verified',
      diagnosisCompleted: true,
      patchAppliesCleanly: true,
      patchAppliesAtFix: true,
      hasHealingRecommendation: true,
    };
    const open = step({ ...unconfirmed, clusterStatus: 'open' });
    expect(open.kind).toBe('apply-patch');
    expect(open.secondary.map((a) => a.action)).toContain('mark-resolved');
    // Resolved, the state claims nothing about the fix: healing leads as usual.
    expect(step({ ...unconfirmed, clusterStatus: 'resolved' }).kind).toBe('replace-locator');
  });

  test('a patch that still applied at the fix is the step even when its diagnosis-time check was unchecked', () => {
    const s = step({
      fixVerification: 'diagnosis-verified',
      clusterStatus: 'open',
      diagnosisCompleted: true,
      patchAppliesCleanly: false,
      patchAppliesAtFix: true,
    });
    expect(s.kind).toBe('apply-patch');
  });

  test('a cluster that stopped failing with no fix identified is marked resolved, whatever its patch says', () => {
    const s = step({
      fixVerification: 'stopped-failing',
      clusterStatus: 'open',
      fixLandedRunId: 62,
      diagnosisCompleted: true,
      patchAppliesCleanly: true,
    });
    expect(s.kind).toBe('mark-resolved');
    expect(s.title).toBe('Mark the cluster resolved — it stopped failing in run #62');
    expect(s.why).toContain('no fix identified');
    expect(`${s.title} ${s.why}`).not.toMatch(/fix held|fix was verified/);
  });

  test('the patch offers no Mark resolved without a verified fix on an open cluster', () => {
    const patch = { diagnosisCompleted: true, patchAppliesCleanly: true, patchAppliesAtFix: true };
    for (const s of [
      step(patch),
      step({ ...patch, fixVerification: 'regressed', clusterStatus: 'open' }),
      step({ ...patch, fixVerification: 'diagnosis-verified', clusterStatus: 'resolved' }),
    ]) {
      expect(s.kind).toBe('apply-patch');
      expect(s.secondary.map((a) => a.action)).not.toContain('mark-resolved');
    }
  });

  test('the blocker row wins over everything', () => {
    const s = step({
      status: 'didnotrun',
      blockedByCase: { id: 7 },
      hasHealingRecommendation: true,
      diagnosisCompleted: true,
      patchAppliesCleanly: true,
    });
    expect(s.kind).toBe('open-blocker');
  });

  test('replace-locator wins over apply-patch when both are present', () => {
    const s = step({ hasHealingRecommendation: true, diagnosisCompleted: true, patchAppliesCleanly: true });
    expect(s.kind).toBe('replace-locator');
  });

  test('apply-patch wins over see-what-changed on a regressed cluster with a clean patch', () => {
    const s = step({ fixVerification: 'regressed', diagnosisCompleted: true, patchAppliesCleanly: true });
    expect(s.kind).toBe('apply-patch');
  });

  test('crash without a CI re-run falls through to diagnose or reproduce, not rerun-in-ci', () => {
    expect(step({ errorKind: 'crash', ciRerunAvailable: false }).kind).not.toBe('rerun-in-ci');
  });

  test('every row returns exactly one primary action', () => {
    for (const input of [
      { status: 'didnotrun', blockedByCase: { id: 1 } },
      { status: 'didnotrun', didNotRunReason: 'max-failures', runId: 1, runFailedExecutionId: 2 },
      { status: 'didnotrun', didNotRunReason: 'max-failures', runId: 1 },
      { status: 'didnotrun', didNotRunReason: 'global-timeout', runId: 1 },
      { status: 'didnotrun', runId: 1 },
      { fixVerification: 'diagnosis-verified', clusterStatus: 'open' },
      { hasHealingRecommendation: true },
      { hasHealingRecommendation: true, healingEditAvailable: true },
      { diagnosisCompleted: true, patchAppliesCleanly: true },
      { diagnosisCompleted: true },
      { fixVerification: 'regressed' },
      { why: 'new-flaky' as const },
      { errorKind: 'crash' as const, ciRerunAvailable: true },
      { aiConfigured: true },
      {},
    ]) {
      const s = computeNextStep(input);
      expect(s.primary).toBeTruthy();
      expect(typeof s.primary.action).toBe('string');
      // A code-change step copies an apply command or a locator, never a bare patch.
      expect([s.primary, ...s.secondary].map((a) => a.action)).not.toContain('copy-patch');
    }
  });
});

describe('computeNextStep — where the change a step copies comes from', () => {
  test.each([
    ['replace-locator', { hasHealingRecommendation: true }, 'healing'],
    ['apply-patch', { diagnosisCompleted: true, patchAppliesCleanly: true }, 'diagnosis'],
    ['follow-diagnosis', { diagnosisCompleted: true }, 'diagnosis'],
    ['open-blocker', { status: 'didnotrun', blockedByCase: { id: 1 } }, null],
    ['open-run', { status: 'didnotrun', didNotRunReason: 'interrupted', runId: 1 }, null],
    ['mark-resolved', { fixVerification: 'stopped-failing', clusterStatus: 'open' }, null],
    ['see-what-changed', { fixVerification: 'regressed' }, null],
    ['compare-attempts', { why: 'passed-on-retry' as const }, null],
    ['rerun-in-ci', { errorKind: 'crash' as const, ciRerunAvailable: true }, null],
    ['diagnose', { aiConfigured: true }, null],
    ['reproduce', {}, null],
  ] as Array<[string, Partial<NextStepInput>, string | null]>)('%s', (kind, input, source) => {
    const s = step(input);
    expect(s.kind).toBe(kind);
    expect(s.source).toBe(source);
  });
});

describe('computeNextStep — the Flake Lab rows', () => {
  const lab = (overrides: Partial<FlakeLabStepFacts> = {}): FlakeLabStepFacts => ({
    testCaseId: 42,
    nextStep: 'reproduce',
    command: 'npx @piwitests/reporter flake 42',
    reproducedBy: null,
    suspect: { id: 'slow-route:GET /api/cart', label: 'GET /api/cart slower (≥1.6 s)', standing: 'untested' },
    untestedSuspects: 3,
    ciAvailable: false,
    ...overrides,
  });

  test('reproduce under the top suspect while it is untested', () => {
    const s = step({ why: 'passed-on-retry', flakeLab: lab() });
    expect(s.kind).toBe('reproduce-flake');
    expect(s.title).toBe('Reproduce this flake under GET /api/cart slower (≥1.6 s)');
    expect(s.why).toMatch(/and 2 more the Flake Lab has not tested/);
    expect(s.primary).toEqual({
      label: 'Copy lab command',
      action: 'copy-flake-command',
      payload: { command: 'npx @piwitests/reporter flake 42' },
    });
    expect(s.secondary.map((a) => a.action)).toEqual(['flakiness-tab', 'attempts-tab']);
    expect(s.secondary[0]!.payload).toEqual({ testCaseId: 42, suspect: 'slow-route:GET /api/cart' });
  });

  test('verify once reproduced, under the condition that reproduced it', () => {
    const s = step({
      why: 'passed-on-retry',
      flakeLab: lab({
        nextStep: 'verify',
        command: 'npx @piwitests/reporter flake verify 42',
        reproducedBy: 'delay GET /api/cart 1.8 s',
        suspect: null,
      }),
    });
    expect(s.kind).toBe('verify-flake-fix');
    expect(s.title).toBe('Verify the flake fix under delay GET /api/cart 1.8 s');
    expect(s.primary.payload).toEqual({ command: 'npx @piwitests/reporter flake verify 42' });
  });

  test('a Flake Lab CI target adds a CI action', () => {
    expect(step({ flakeLab: lab({ ciAvailable: true }) }).secondary[0]).toEqual({
      label: 'Reproduce in CI',
      action: 'flake-lab-ci',
      payload: { testCaseId: 42, suspect: 'slow-route:GET /api/cart', kind: 'reproduce' },
    });
    const verify = step({ flakeLab: lab({ nextStep: 'verify', ciAvailable: true }) });
    expect(verify.secondary[0]).toMatchObject({ action: 'flake-lab-ci', payload: { testCaseId: 42, kind: 'verify' } });
  });

  test('falls through to comparing attempts when no suspect is left untested or the fix holds', () => {
    const tested = lab({ suspect: { id: 'load', label: 'load', standing: 'not-reproduced' }, untestedSuspects: 0 });
    expect(step({ why: 'passed-on-retry', flakeLab: tested }).kind).toBe('compare-attempts');
    expect(step({ why: 'passed-on-retry', flakeLab: lab({ suspect: null }) }).kind).toBe('compare-attempts');
    expect(step({ why: 'passed-on-retry', flakeLab: lab({ nextStep: null, command: null }) }).kind).toBe(
      'compare-attempts',
    );
  });

  test('a diagnosed patch still comes first', () => {
    expect(step({ diagnosisCompleted: true, patchAppliesCleanly: true, flakeLab: lab() }).kind).toBe('apply-patch');
  });
});

describe('a Done ticket on a cluster that stopped failing', () => {
  test('marks the cluster resolved, ahead of a patch that still applies', () => {
    const step = computeNextStep({
      clusterStatus: 'open',
      ticketDoneKey: 'CHK-7',
      diagnosisCompleted: true,
      patchAppliesCleanly: true,
      clusterId: 10,
    });
    expect(step.kind).toBe('mark-resolved');
    expect(step.title).toContain('CHK-7 is Done');
    expect(step.primary.action).toBe('mark-resolved');
  });

  test('says nothing of the ticket once the cluster is resolved', () => {
    const step = computeNextStep({ clusterStatus: 'resolved', ticketDoneKey: 'CHK-7', clusterId: 10 });
    expect(step.kind).not.toBe('mark-resolved');
  });
});
