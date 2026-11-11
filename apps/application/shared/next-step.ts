/**
 * One next step, chosen by a policy rather than offered as a menu. Both the
 * execution page and the cluster page assemble the same facts — the verdict,
 * whether locator healing has a recommendation, the cluster's diagnosis and its
 * patch validation, the fix verification, the attempt facts, whether AI and a
 * CI re-run are configured, the case that blocked this one, and for a test that
 * did not run why and in which run — and hand them here. The first matching row
 * wins; the caller renders the one primary action and folds the rest into the
 * toolbox. A step that copies a change names where the change comes from
 * (`source`), which the pages turn into a sentence.
 *
 * Pure: no DB, no model call. The facts are gathered in the handlers.
 */
import type { FailureWhy } from '#shared/failure-verdict';
import type { ParsedErrorKind } from '#shared/error-parse';
import { shortCommit } from '#shared/scm-urls';
import type { FlakeExperimentKind, FlakeSuspectStanding } from '#shared/flake-lab';
import type { PatchValidationStatus } from '#shared/patch';

export type NextStepKind =
  | 'open-blocker'
  | 'open-run'
  | 'mark-resolved'
  | 'replace-locator'
  | 'apply-patch'
  | 'follow-diagnosis'
  | 'see-what-changed'
  | 'verify-flake-fix'
  | 'reproduce-flake'
  | 'compare-attempts'
  | 'rerun-in-ci'
  | 'diagnose'
  | 'reproduce';

export interface NextStepAction {
  label: string;
  action: string;
  payload?: Record<string, unknown>;
}

/**
 * Where the change a step copies comes from: the cluster's AI diagnosis (its
 * patch) or locator healing (its recommended locator). Null for a step whose
 * action is its own.
 */
export type NextStepSource = 'diagnosis' | 'healing';

export interface NextStep {
  kind: NextStepKind;
  title: string;
  /** One line saying why this is the step. */
  why: string;
  primary: NextStepAction;
  secondary: NextStepAction[];
  source: NextStepSource | null;
}

export interface NextStepInput {
  /** The execution or cluster's own status (`didnotrun` gates the blocker and run rows). */
  status?: string | null;
  /** The failing execution that blocked this one, when this test did not run. */
  blockedByCase?: { id: number; title?: string | null } | null;
  /** Why this test did not run, as the reporter recorded it (`max-failures`, `global-timeout`, …). */
  didNotRunReason?: string | null;
  /** The run this execution belongs to. */
  runId?: number | null;
  /** The run's failed execution, when it has exactly one. */
  runFailedExecutionId?: number | null;

  /** The cluster's triage status and fix verification. */
  clusterStatus?: string | null;
  fixVerification?: string | null;
  fixLandedRunId?: number | null;
  fixCommit?: string | null;
  /** The cluster's known ticket is Done and the newest finished run no longer fails: its key. */
  ticketDoneKey?: string | null;

  /**
   * Locator healing has a usable recommendation for a locator-resolution
   * failure, in a project that shows locator healing.
   */
  hasHealingRecommendation?: boolean;
  /** The recommendation comes with a git-applyable edit of the failing line. */
  healingEditAvailable?: boolean;

  /** A completed AI diagnosis exists, its one-line summary and the file it touches. */
  diagnosisCompleted?: boolean;
  diagnosisSummary?: string | null;
  patchFile?: string | null;
  /** The diagnosis proposes a patch, and how it validated against the code the model was shown. */
  hasPatch?: boolean;
  patchValidationStatus?: PatchValidationStatus | null;
  /** The suggested patch is present and validates as applying cleanly to the tree. */
  patchAppliesCleanly?: boolean;
  /**
   * The suggested patch still applied at the commit of the verified fix, its
   * change not there: checked when the fix was verified.
   */
  patchAppliesAtFix?: boolean;

  /** Verdict facts. */
  why?: FailureWhy | null;
  errorKind?: ParsedErrorKind | null;

  /** A provider is configured, and a CI re-run target is configured for this project. */
  aiConfigured?: boolean;
  ciRerunAvailable?: boolean;

  /**
   * The flaky test's place in the Flake Lab, given for a flaky failure: the step
   * it needs next and its command, the condition that reproduced it, the suspect
   * it is shown with, and whether a Flake Lab CI target can run it.
   */
  flakeLab?: FlakeLabStepFacts | null;

  /** Ids the actions carry as payload. */
  clusterId?: number | null;
  executionId?: number | null;
}

export interface FlakeLabStepFacts {
  testCaseId: number;
  nextStep: FlakeExperimentKind | null;
  command: string | null;
  /** The condition that last reproduced it. */
  reproducedBy: string | null;
  /** Its top suspect, with a reproduce step only. */
  suspect: { id: string; label: string; standing: FlakeSuspectStanding } | null;
  /** Its suspects no experiment tested yet. */
  untestedSuspects: number;
  ciAvailable: boolean;
}

const SOURCE_BY_KIND: Partial<Record<NextStepKind, NextStepSource>> = {
  'replace-locator': 'healing',
  'apply-patch': 'diagnosis',
  'follow-diagnosis': 'diagnosis',
};

export function computeNextStep(input: NextStepInput): NextStep {
  const step = chooseStep(input);
  return { ...step, source: SOURCE_BY_KIND[step.kind] ?? null };
}

/**
 * Why a completed diagnosis's patch is not the step, as a clause ("its patch no
 * longer applies to the current code"), or null when the facts say it applies.
 * The follow-diagnosis reason and the Next line's source sentence both say it.
 */
export function patchShortfall(patch: {
  hasPatch?: boolean | null;
  status?: PatchValidationStatus | null;
}): string | null {
  if (patch.hasPatch === false) return 'it proposes no patch';
  switch (patch.status) {
    case 'applies':
    case 'applies-with-offset':
      return null;
    case 'stale-file':
      return 'its patch no longer applies to the current code';
    case 'invalid':
      return 'its patch is not a valid diff';
    default:
      return 'its patch could not be checked against the code';
  }
}

/** The step for a test the run never started: the failure that stopped it, the run's failures or the run. */
function openRunStep(input: NextStepInput): Omit<NextStep, 'source'> {
  const runId = input.runId ?? null;
  const openRun = (label: string, tab?: string): NextStepAction => ({
    label,
    action: 'open-run',
    payload: runId != null ? { runId, ...(tab ? { tab } : {}) } : undefined,
  });
  const runLabel = runId != null ? `Open run #${runId}` : 'Open the run';
  const step = (title: string, why: string, primary: NextStepAction) => ({
    kind: 'open-run' as const,
    title,
    why: `Nothing to fix in this test: ${why}`,
    primary,
    secondary: [],
  });
  switch (input.didNotRunReason) {
    case 'max-failures':
      if (input.runFailedExecutionId != null) {
        return step('Open the failure that stopped the run', 'it runs again once that failure is fixed.', {
          label: 'Open the failure',
          action: 'open-execution',
          payload: { executionId: input.runFailedExecutionId },
        });
      }
      return step(
        "Open the run's failures",
        'it runs again once those failures are fixed.',
        openRun('Open the failures', 'failure-groups'),
      );
    case 'previous-failure':
      return step(
        "Open the run's failures",
        "it runs again once its group's failure is fixed.",
        openRun('Open the failures', 'failure-groups'),
      );
    case 'dependency-failure':
      return step(
        "Open the run's failures",
        'it runs again once the project it depends on passes.',
        openRun('Open the failures', 'failure-groups'),
      );
    case 'global-timeout':
      return step(
        'See what made the run slow',
        'it runs again once the run ends within its time limit.',
        openRun("Open the run's timeline", 'workers'),
      );
    case 'interrupted':
      return step('Open the run', 'it runs again in the next run that completes.', openRun(runLabel));
    default:
      return step('Open the run', 'the run shows where it stopped.', openRun(runLabel));
  }
}

function chooseStep(input: NextStepInput): Omit<NextStep, 'source'> {
  const clusterId = input.clusterId ?? null;
  const withCluster = clusterId != null ? { clusterId } : undefined;
  const withExecution = input.executionId != null ? { executionId: input.executionId } : undefined;

  const verified = input.fixVerification === 'diagnosis-verified' || input.fixVerification === 'stopped-failing';
  // A diagnosis-verified fix at whose commit the diagnosed patch still applied may
  // not be the diagnosed change: the cluster state says so, and on an open
  // cluster the patch comes first, with Mark resolved in its menu.
  const fixUnconfirmed =
    input.fixVerification === 'diagnosis-verified' &&
    input.diagnosisCompleted === true &&
    input.patchAppliesAtFix === true;
  const patchFirst = fixUnconfirmed && input.clusterStatus === 'open';
  const hasCleanPatch = input.diagnosisCompleted === true && (input.patchAppliesCleanly === true || fixUnconfirmed);

  // 1 — a did-not-run cascade: open the failure that blocked this test. The
  // reason is the Most likely line's; the step says what to do about it.
  if (input.status === 'didnotrun' && input.blockedByCase) {
    return {
      kind: 'open-blocker',
      title: 'Open the failure that blocked this test',
      why: 'Nothing to fix in this test: it runs again once that failure is fixed.',
      primary: {
        label: 'Open the blocking failure',
        action: 'open-execution',
        payload: { executionId: input.blockedByCase.id },
      },
      secondary: [],
    };
  }

  // 1b — a test the run never started, with no blocker: open the run, where
  // what stopped it is.
  if (input.status === 'didnotrun') return openRunStep(input);

  // 2 — the failures stopped on an open cluster: mark it resolved. A
  // diagnosis-verified fix whose patch still applied at its commit goes to the
  // patch (row 4); a cluster that stopped failing with no fix identified is
  // marked resolved whatever its patch says.
  if (verified && input.clusterStatus === 'open' && !fixUnconfirmed) {
    const run = input.fixLandedRunId != null ? ` in run #${input.fixLandedRunId}` : '';
    const fixVerified = input.fixVerification === 'diagnosis-verified';
    return {
      kind: 'mark-resolved',
      title: fixVerified
        ? `Mark the cluster resolved — the fix held${run}`
        : `Mark the cluster resolved — it stopped failing${run}`,
      why: fixVerified
        ? 'The failures stopped and the fix was verified, but the cluster is still marked open.'
        : 'The failures stopped with no fix identified, but the cluster is still marked open.',
      primary: { label: 'Mark resolved', action: 'mark-resolved', payload: withCluster },
      secondary: [{ label: 'Reopen if it comes back', action: 'reopen', payload: withCluster }],
    };
  }

  // 2b — the ticket closed and the failure stopped: mark the cluster resolved, as
  // the state line offers.
  if (input.ticketDoneKey && input.clusterStatus === 'open') {
    return {
      kind: 'mark-resolved',
      title: `Mark the cluster resolved — ${input.ticketDoneKey} is Done`,
      why: 'The ticket is Done and the latest run no longer fails, but the cluster is still marked open.',
      primary: { label: 'Mark resolved', action: 'mark-resolved', payload: withCluster },
      secondary: [{ label: 'Reopen if it comes back', action: 'reopen', payload: withCluster }],
    };
  }

  // 3 — a locator-resolution failure that healing can repair, unless the patch
  // comes first. The edit of the failing line is the change to apply, as an
  // apply command or a .patch file for a shell without heredocs; without one,
  // the recommended locator is.
  if (input.hasHealingRecommendation && !patchFirst) {
    const replace = {
      kind: 'replace-locator' as const,
      title: 'Replace the locator',
      why: 'The locator no longer resolves; healing found the element under a new locator.',
    };
    const pick = [
      { label: 'Pick from snapshot', action: 'pick-from-snapshot', payload: withExecution },
      { label: 'All alternatives', action: 'all-alternatives', payload: withExecution },
    ];
    if (input.healingEditAvailable) {
      return {
        ...replace,
        primary: { label: 'Copy apply command', action: 'copy-git-apply', payload: withExecution },
        secondary: [
          { label: 'Copy locator', action: 'copy-locator', payload: withExecution },
          { label: 'Download .patch', action: 'download-patch', payload: withExecution },
          ...pick,
        ],
      };
    }
    return {
      ...replace,
      primary: { label: 'Copy locator', action: 'copy-locator', payload: withExecution },
      secondary: pick,
    };
  }

  // 4 — a completed diagnosis whose patch applies cleanly.
  if (hasCleanPatch) {
    const file = input.patchFile?.trim();
    return {
      kind: 'apply-patch',
      title: `Apply the diagnosed fix${file ? ` to ${file}` : ''}`,
      why: fixUnconfirmed
        ? 'A fix was verified, but the diagnosed patch still applied to the code at its commit.'
        : 'The diagnosis suggests a patch that applies cleanly to the current code.',
      primary: { label: 'Copy apply command', action: 'copy-git-apply', payload: withCluster },
      secondary: [
        { label: 'Download .patch', action: 'download-patch', payload: withCluster },
        { label: 'Open in editor', action: 'open-in-ide', payload: withCluster },
        { label: 'Read the diagnosis', action: 'read-diagnosis', payload: withCluster },
        // The fix was verified, so whoever knows it is in the code can still close it.
        ...(patchFirst ? [{ label: 'Mark resolved', action: 'mark-resolved', payload: withCluster }] : []),
      ],
    };
  }

  // 5 — a completed diagnosis whose patch is stale, unchecked, invalid or absent.
  if (input.diagnosisCompleted) {
    const shortfall = patchShortfall({ hasPatch: input.hasPatch, status: input.patchValidationStatus });
    return {
      kind: 'follow-diagnosis',
      title: 'Follow the diagnosis',
      why: `A diagnosis explains the failure${shortfall ? `, but ${shortfall}` : ''}.`,
      primary: { label: 'Read the diagnosis', action: 'read-diagnosis', payload: withCluster },
      secondary: [{ label: 'Re-diagnose', action: 're-diagnose', payload: withCluster }],
    };
  }

  // 6 — a fix regressed: see what changed since it landed.
  if (input.fixVerification === 'regressed') {
    const commit = input.fixCommit?.trim() ? shortCommit(input.fixCommit.trim()) : null;
    return {
      kind: 'see-what-changed',
      title: `See what changed since the fix${commit ? ` in ${commit}` : ''} — it did not hold`,
      why: 'A recorded fix regressed; the failure is back.',
      primary: { label: 'What changed', action: 'what-changed', payload: withCluster },
      secondary:
        input.clusterStatus === 'resolved' ? [{ label: 'Reopen', action: 'reopen', payload: withCluster }] : [],
    };
  }

  // 7 — a flaky test the Flake Lab reproduced: verify the fix under that condition.
  const lab = input.flakeLab;
  if (lab?.nextStep === 'verify' && lab.command) {
    const under = lab.reproducedBy ? ` under ${lab.reproducedBy}` : '';
    const labPayload = { testCaseId: lab.testCaseId };
    return {
      kind: 'verify-flake-fix',
      title: `Verify the flake fix${under}`,
      why: 'The Flake Lab reproduced this flake; rerunning that condition after the fix shows whether it holds.',
      primary: { label: 'Copy verify command', action: 'copy-flake-command', payload: { command: lab.command } },
      secondary: [
        ...(lab.ciAvailable
          ? [{ label: 'Verify in CI', action: 'flake-lab-ci', payload: { ...labPayload, kind: 'verify' } }]
          : []),
        { label: 'Flakiness', action: 'flakiness-tab', payload: labPayload },
      ],
    };
  }

  // 8 — a flaky test with an untested suspect: reproduce it under the top one.
  if (lab?.nextStep === 'reproduce' && lab.command && lab.suspect?.standing === 'untested') {
    const others = lab.untestedSuspects - 1;
    const labPayload = { testCaseId: lab.testCaseId, suspect: lab.suspect.id };
    return {
      kind: 'reproduce-flake',
      title: `Reproduce this flake under ${lab.suspect.label}`,
      why:
        others > 0
          ? `Its history points at this suspect first, and ${others} more the Flake Lab has not tested; the lab applies each next to a control.`
          : 'Its history points at this suspect and the Flake Lab has not tested it; the lab applies it next to a control.',
      primary: { label: 'Copy lab command', action: 'copy-flake-command', payload: { command: lab.command } },
      secondary: [
        ...(lab.ciAvailable
          ? [{ label: 'Reproduce in CI', action: 'flake-lab-ci', payload: { ...labPayload, kind: 'reproduce' } }]
          : []),
        { label: 'Flakiness', action: 'flakiness-tab', payload: labPayload },
        { label: 'Attempts', action: 'attempts-tab', payload: withExecution },
      ],
    };
  }

  // 9 — a flaky or retry-passing failure: compare the attempts.
  if (input.why === 'passed-on-retry' || input.why === 'new-flaky') {
    return {
      kind: 'compare-attempts',
      title: 'Compare the failing attempt with the passing one',
      why: 'The test failed then passed, so the difference is between attempts, not in the test.',
      primary: { label: 'Attempts', action: 'attempts-tab', payload: withExecution },
      secondary: [{ label: 'Quarantine this test', action: 'quarantine', payload: withExecution }],
    };
  }

  // 10 — an environment-looking crash or navigation, with a CI re-run configured.
  if ((input.errorKind === 'crash' || input.errorKind === 'navigation') && input.ciRerunAvailable) {
    return {
      kind: 'rerun-in-ci',
      title: 'Re-run in CI — this looks like the environment, not the test',
      why: 'A crash or navigation failure often comes from the environment; a clean re-run tells them apart.',
      primary: { label: 'Re-run in CI', action: 'rerun-in-ci', payload: withCluster ?? withExecution },
      secondary: [{ label: 'Reproduce locally', action: 'reproduce', payload: withExecution }],
    };
  }

  // 11 — AI is configured and the cluster has no diagnosis yet.
  if (input.aiConfigured && !input.diagnosisCompleted) {
    return {
      kind: 'diagnose',
      title: 'Diagnose with AI',
      why: 'A diagnosis reads the clues, the evidence and the recent commits together and proposes a fix.',
      primary: { label: 'Diagnose with AI', action: 'diagnose', payload: withCluster ?? withExecution },
      secondary: [{ label: 'Reproduce locally', action: 'reproduce', payload: withExecution }],
    };
  }

  // 12 — reproduce locally.
  return {
    kind: 'reproduce',
    title: 'Reproduce locally',
    why: 'Run it on the recorded commit and browser to watch it fail.',
    primary: { label: 'Copy recipe', action: 'copy-recipe', payload: withExecution },
    secondary: [
      { label: 'Copy AI prompt', action: 'copy-ai-prompt', payload: withExecution },
      { label: 'Configure AI', action: 'configure-ai' },
    ],
  };
}
