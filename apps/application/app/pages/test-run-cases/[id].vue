<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui';
import type { AiStepIntent, ApiResponse, TestCaseHistoryPoint, TraceInfo } from '~~/types/api';
import { isPiwiAnnotation } from '@piwitests/core/test-meta';
import { isExpectedFailurePassed } from '@piwitests/core/status-classify';
import { renderAnsi } from '~/utils';
import { buildRetryCommand } from '~/utils/retry-command';
import type { FailureVerdict } from '#shared/failure-verdict';
import type { FailureCluesResult } from '#shared/handlers/test-cases';
import { clusterSectionLocatorKey } from '~/composables/useClusterSectionLocator';
import { EVIDENCE_SECTION_TAB } from '~/utils/evidence-sections';
import type { FixSectionKey } from '~/utils/fix-sections';
import type { RerunInfo } from '~/composables/useCiRerun';
import type { BlockedCaseRef } from '~~/types/api';
import type { ReproRecipe, BisectResult, ReproduceDesktopContext } from '#shared/reproduce';
import type { FixedBeforeMatch, FixPlan } from '#shared/fix-plan.types';
import type { Situation } from '#shared/situation';
import type { IssueFilingFailure, KnownIssueRef } from '#shared/handlers/known-issues';
import type { NextStep } from '#shared/next-step';
import type { DidNotRunExplanation } from '#shared/did-not-run';
import { pickMostLikely, nextStepSourceLine } from '#shared/most-likely';
import { shouldNudgeFixtures } from '#shared/capability-nudge';
import { getProviderIcon, type LinkProvider } from '#shared/link-detect';
import { safeHttpUrl } from '#shared/utils/safe-url';
import { issueLineForm } from '~/utils/issue-line';
import { buildNextStepChange } from '~/utils/next-step-change';
import type { LocatorHealingResult } from '#shared/locator-healing.types';
import { hasHealingAlternatives } from '#shared/locator-healing';
import type { SuspectLinesAnswer } from '#shared/suspect-lines';
import { suspectLinesSentence } from '~/utils/suspect-lines';
import { coverageLossPreview } from '~/utils/coverage-insights';

const route = useRoute();
const testCaseId = route.params.id;

const {
  data: testCase,
  error: testCaseError,
  refresh,
} = await useFetch<ApiResponse<typeof import('~~/server/api/test-run-cases/[id].get').default>>(
  `/api/test-run-cases/${testCaseId}`,
);
if (testCaseError.value) showPageLoadError(testCaseError.value, 'execution');

// Server-rendered fetches carry the viewer's session.
const requestFetch = useRequestFetch();

// The rows ride in the SSR payload, so the server and the client agree on the
// History block's strip at hydration.
const { data: historyData } = await useAsyncData(
  `test-run-case-history-${testCaseId}`,
  () => {
    const tcId = testCase.value?.testCaseId;
    return tcId
      ? requestFetch<{ items: TestCaseHistoryPoint[] }>(`/api/test-cases/${tcId}/history`).then((r) => r.items)
      : Promise.resolve([]);
  },
  { default: (): TestCaseHistoryPoint[] => [], watch: [() => testCase.value?.testCaseId] },
);

// The story, situation and next lines are only for a problem execution; a passing
// one shows identity and facts alone, and one that passed on retry adds the
// failed attempt's headline, the line under it and the next step.
const isProblem = computed(() => {
  const s = testCase.value?.status;
  return s === 'failed' || s === 'timedout' || s === 'timedOut' || s === 'didnotrun';
});
const isPassedOnRetry = computed(() => statusPaletteKey(testCase.value?.status, testCase.value?.retries) === 'flaky');

// The deterministic clues and the story that chains them: Most likely chooses
// between them and the cluster's diagnosis, folds every clue under its
// disclosure, and the top clue's section chooses the default evidence tab. A
// passing execution has no failure to explain, so they are not fetched.
const { data: cluesData } = await useFetch<FailureCluesResult>(`/api/test-run-cases/${testCaseId}/clues`, {
  default: (): FailureCluesResult => ({ clues: [], story: null, failureAt: null }),
  immediate: isProblem.value,
});
const clues = computed(() => cluesData.value?.clues ?? []);
const story = computed(() => cluesData.value?.story ?? null);
const cluesFailureAt = computed(() => cluesData.value?.failureAt ?? null);

// The evidence opens on the story: the first member clue's cited section and the
// story's strength (or the top clue's, when no combination matched) tell the tab
// strip which view leads, and what Most likely cites is marked in the card.
const defaultHint = useEvidenceHint(clues, story, () => mostLikely.value);

const { data: traceData, refresh: refreshTraces } = await useFetch(`/api/test-run-cases/${testCaseId}/traces`, {
  transform: (r: { items: TraceInfo[] }) => r.items,
});

/** Whether a trace file exists for this execution — unlocks the "go deeper" evidence views. */
const hasTrace = computed(() => (traceData.value?.length ?? 0) > 0);

useHead(
  computed(() => ({
    title: testCase.value?.title
      ? `${testCase.value.title} — execution — Piwi Dashboard`
      : `Execution #${testCaseId} — Piwi Dashboard`,
  })),
);

const runIsActive = computed(() => {
  const status = testCase.value?.testRun?.status;
  return status === 'running' || status === 'finalizing';
});

/** The one-line verdict on a failing execution, built server-side from the stored error and signals. */
const verdict = computed(() => (testCase.value as { verdict?: FailureVerdict | null } | null)?.verdict ?? null);

const failureCluster = computed(() => {
  return (testCase.value?.failureCluster ?? null) as {
    id: number;
    signature: string;
    title: string | null;
    selector: string | null;
    errorType: string | null;
    status: string | null;
    triageNote: string | null;
    occurrences: number;
    sameRunCaseCount: number;
    isNew: boolean;
    firstSeenRunId: number;
    firstSeenAt: string | null;
    diagnosis: {
      status?: string | null;
      category?: string | null;
      confidence?: string | null;
      summary?: string | null;
      provider?: string | null;
    } | null;
    knownIssue?: KnownIssueRef | null;
    /** Read when the issue is Done: the failure goes on in the latest finished run. */
    failureGoesOn?: boolean | null;
    issueFilingQueued?: boolean;
    /** The cluster's newest issue filing failed for good. */
    issueFilingFailure?: IssueFilingFailure | null;
  } | null;
});

/** AI-step intent mappings from the execution's usage manifest (locator-fix probe). */
const aiIntents = computed<AiStepIntent[] | null>(() => {
  const usage = testCase.value?.aiUsage as unknown as { intents?: AiStepIntent[] } | null;
  return usage?.intents ?? null;
});

// ── More ways to fix ────────────────────────────────────────────────────────
/** Whether the desktop (Tauri) bridge is present — set on mount below. */
const desktopBridge = ref(false);

// The local reproduction recipe and generated bisect for this execution.
const { data: reproduceData } = await useFetch<{
  reproduce: ReproRecipe;
  bisect: BisectResult;
  desktop: ReproduceDesktopContext;
} | null>(`/api/test-run-cases/${testCaseId}/reproduce`);

/** The cluster's stored diagnosis, only when it completed and has a summary. */
const clusterDiagnosis = computed(() => {
  const d = failureCluster.value?.diagnosis;
  return d && d.status === 'completed' && d.summary ? d : null;
});
const confidenceColor = (c?: string | null): 'success' | 'warning' | 'neutral' =>
  c === 'high' ? 'success' : c === 'medium' ? 'warning' : 'neutral';

// The one explanation on the first screen, by the rule the cluster page follows
// too: a strong or medium story, else the cluster's diagnosis, else a weak story,
// else the top clue.
const mostLikelyDiagnosis = computed(() =>
  clusterDiagnosis.value
    ? {
        summary: clusterDiagnosis.value.summary as string,
        confidence: clusterDiagnosis.value.confidence ?? null,
        provider: clusterDiagnosis.value.provider ?? null,
      }
    : null,
);
const mostLikely = computed(() =>
  pickMostLikely({ story: story.value, clues: clues.value, diagnosis: mostLikelyDiagnosis.value }),
);

// The situation lines (since when and whether a newer execution failed again,
// under the headline; the cluster, in the Cluster line) and the single next
// step, built server-side from the verdict and the same healing / diagnosis
// facts the toolbox reads.
const situation = computed(() => (testCase.value as { situation?: Situation | null } | null)?.situation ?? null);
const nextStep = computed(() => (testCase.value as { nextStep?: NextStep | null } | null)?.nextStep ?? null);
// Why a test that did not run never started: its Most likely line.
const didNotRun = computed(
  () => (testCase.value as { didNotRun?: DidNotRunExplanation | null } | null)?.didNotRun ?? null,
);

// A commit in the situation links to the SCM host only when the run has a repository.
const repositoryUrl = computed(() => reproduceData.value?.desktop?.repositoryUrl ?? null);

// The What changed line of a failing execution: how many of the lines changed
// since the last passing run it ran (its suspect lines), linked to the
// cluster's What changed card. They read source control and coverage, so they
// load in the browser and the line shows only once they are available.
const isFailedExecution = isFailedStatus(testCase.value?.status);
const { data: suspectLinesData } = useFetch<SuspectLinesAnswer>(`/api/test-run-cases/${testCaseId}/suspect-lines`, {
  key: `suspect-lines-${testCaseId}`,
  server: false,
  lazy: true,
  immediate: isFailedExecution,
});
const suspectSentence = computed(() =>
  failureCluster.value ? suspectLinesSentence(suspectLinesData.value, 'execution') : null,
);

const blockedTests = computed(() => (testCase.value as { blockedTests?: BlockedCaseRef[] } | null)?.blockedTests ?? []);

// The capture-fixtures nudge: one contextual line under the headline that offers
// to decline the fixtures, shown only to an administrator, only where fixtures
// are undecided for the project, and only when the leading clue (or a timeout)
// would have used what the fixtures capture. It replaces the evidence footer's
// naming line on this page.
const {
  state: projectCapState,
  isHidden: capHidden,
  canDecide: canDecideCap,
  decide: decideProjectCap,
} = await useProjectCapabilities(testCase.value?.testRun?.project?.id ?? 0);
const { decide: decideInstanceCap } = await useInstanceCapabilities();

// The evidence footer's decline controls: both write a `declined` decision, one
// per level, and the resolver hides the sources everywhere on the next read.
async function declineFixtures(level: 'project' | 'instance') {
  if (level === 'project') await decideProjectCap('fixtures', 'declined');
  else await decideInstanceCap('fixtures', 'declined');
}
const isTimeoutFailure = computed(() => {
  const s = testCase.value?.status;
  return s === 'timedout' || s === 'timedOut';
});
const showFixturesNudge = computed(
  () =>
    canDecideCap.value &&
    shouldNudgeFixtures({
      clueSection: defaultHint.value.section,
      isTimeout: isTimeoutFailure.value,
      fixturesState: projectCapState('fixtures'),
    }),
);
const nudgeDeciding = ref(false);
async function declineFixturesForProject() {
  if (nudgeDeciding.value) return;
  nudgeDeciding.value = true;
  try {
    await decideProjectCap('fixtures', 'declined');
  } finally {
    nudgeDeciding.value = false;
  }
}

/** A locator-resolution failure of this execution — the only case the Locator fix section applies to. */
const isLocatorFailure = computed(() =>
  Boolean(isProblem.value && verdict.value?.isLocatorResolutionFailure && testCase.value?.testRun?.id),
);

// The Locator fix section rides on the healing data. The page fetches it once and
// hands it to the panel, so the toolbox adds the section only when there is
// something to show — and never when healing is hidden for this project. When
// the next step replaces the locator, the page waits for the healing, so the
// section and its panel are in the first render.
const healingLeads = nextStep.value?.kind === 'replace-locator';
const { data: locatorHealingData } = await useFetch<LocatorHealingResult>(
  () => `/api/test-run-cases/${testCaseId}/locator-healing`,
  {
    lazy: !healingLeads,
    immediate: isLocatorFailure.value || healingLeads,
    key: `locator-healing-${testCaseId}`,
  },
);
const locatorHealingHasData = computed(() => hasHealingAlternatives(locatorHealingData.value));
const showLocatorFix = computed(
  () => isLocatorFailure.value && locatorHealingHasData.value && !capHidden('locator-healing'),
);

// CI re-run for the cluster this failure belongs to, for the Verify section.
const { data: rerunInfo, refresh: refreshRerun } = await useAsyncData<RerunInfo | null>(
  `test-run-case-rerun-${testCaseId}`,
  () => {
    const id = failureCluster.value?.id;
    return id ? requestFetch<RerunInfo>(`/api/failure-clusters/${id}/rerun`) : Promise.resolve(null);
  },
  { default: (): RerunInfo | null => null, watch: [() => failureCluster.value?.id] },
);
// "Fixed before" for the cluster this failure belongs to.
const { data: fixedBeforeData, refresh: refreshFixedBefore } = await useAsyncData<FixedBeforeMatch[]>(
  `test-run-case-fixed-before-${testCaseId}`,
  () => {
    const id = failureCluster.value?.id;
    return id
      ? requestFetch<{ items: FixedBeforeMatch[] }>(`/api/failure-clusters/${id}/fixed-before`).then((r) => r.items)
      : Promise.resolve([]);
  },
  { default: (): FixedBeforeMatch[] => [], watch: [() => failureCluster.value?.id] },
);
const fixedBefore = computed(() => fixedBeforeData.value ?? []);

// The cluster's fix plan — its diagnosis patch is the change an apply step
// shows and copies, and the Diagnosis section shows it whole, so it is fetched
// once here rather than by each action.
const { data: fixPlanData } = await useAsyncData<FixPlan | null>(
  `test-run-case-fix-plan-${testCaseId}`,
  () => {
    const id = failureCluster.value?.id;
    return id ? requestFetch<FixPlan>(`/api/failure-clusters/${id}/fix-plan`).catch(() => null) : Promise.resolve(null);
  },
  { default: (): FixPlan | null => null, watch: [() => failureCluster.value?.id] },
);
const fixPlanPatch = computed(() => fixPlanData.value?.diagnosis?.patch ?? null);

// The change the next step copies, from the fix plan or the healing the page
// already loaded: the Next row shows it and its actions copy it.
const nextStepChange = computed(() =>
  buildNextStepChange(nextStep.value, {
    diagnosis: fixPlanData.value?.diagnosis ?? null,
    healing: locatorHealingData.value ?? null,
  }),
);

// Where the next step's change comes from: the cluster's diagnosis, named in full
// unless Most likely already shows it, or locator healing.
const nextStepSource = computed(() =>
  nextStepSourceLine(nextStep.value, {
    mostLikely: mostLikely.value,
    diagnosis: mostLikelyDiagnosis.value && {
      ...mostLikelyDiagnosis.value,
      hasPatch: fixPlanData.value?.diagnosis ? Boolean(fixPlanPatch.value) : null,
      patchStatus: fixPlanData.value?.diagnosis?.patchValidation?.status ?? null,
    },
    healing: locatorHealingData.value ?? null,
    scope: 'execution',
  }),
);

const { applyingId, applyTriage } = useApplyClusterTriage({
  clusterId: () => failureCluster.value?.id ?? null,
  status: () => failureCluster.value?.status,
  currentNote: () => (failureCluster.value as { triageNote?: string | null } | null)?.triageNote,
  onApplied: () => Promise.all([refresh(), refreshFixedBefore()]),
});

const { rerunning, triggerRerun } = useCiRerun(() => failureCluster.value?.id ?? null, refreshRerun);

/** The Verify section shows when a CI re-run is configured, or in the desktop shell. */
const showVerify = computed(() => Boolean(rerunInfo.value?.available) || desktopBridge.value);

/** Reproduce shows for a failing execution once its recipe is available. */
const showReproduce = computed(() => Boolean(verdict.value) && Boolean(reproduceData.value?.reproduce?.steps?.length));

/** The sections of More ways to fix this execution offers; the toolbox orders them. */
const fixSections = computed<FixSectionKey[]>(() => {
  const s: FixSectionKey[] = [];
  if (showLocatorFix.value) s.push('locator-fix');
  if (failureCluster.value) s.push('fix-plan');
  s.push('diagnosis');
  if (fixedBefore.value.length) s.push('fixed-before');
  if (showVerify.value) s.push('verify');
  if (showReproduce.value) s.push('reproduce');
  if (blockedTests.value.length) s.push('blocked');
  return s;
});

// More ways to fix covers a failing execution (something to fix) or one that blocked
// others. A pass that needed a retry has nothing to fix here: its failed
// attempt's page holds the tools.
const showFix = computed(() => (Boolean(verdict.value) && !isPassedOnRetry.value) || blockedTests.value.length > 0);

// ── Folded one-line summaries for the toolbox sections ───────────────────────
const { aiStatus } = useAiStatus();
const diagnosisSummary = computed(() =>
  diagnosisSectionSummary(failureCluster.value?.diagnosis, aiStatus.value?.configured),
);
const reproduceSummary = computed(() =>
  reproduceSectionSummary(
    reproduceData.value?.reproduce?.steps?.length ?? 0,
    Boolean(reproduceData.value?.bisect?.available),
  ),
);
const verifySummary = computed(() =>
  verifySectionSummary(retryCommand.value ?? '', Boolean(rerunInfo.value?.available), 'Re-run the failing test'),
);

// ── Header: identity, exceptional badges ─────────────────────────────────────
// Playwright test marks only — `piwi:` annotations are ownership, not marks.
const annotations = computed(() =>
  (testCase.value?.testAnnotations ?? []).filter(
    (ann: { type: string; description?: string | null }) => !isPiwiAnnotation(ann.type),
  ),
);

const quarantined = computed(() => Boolean((testCase.value as { quarantined?: boolean } | null)?.quarantined));

// The situation block's edge, in this execution's outcome color.
const statusEdge = computed(() =>
  testCase.value ? statusPalette(testCase.value.status, testCase.value.retries).color : null,
);

/**
 * Exceptional badges only. The status chip says a pass needed a retry, and the
 * why-signals (regression, newly flaky) lead the line under the headline when
 * there is a headline, so they show here only for an execution with none (a
 * pass whose failed attempt is not stored) — a fact appears once. Playwright
 * marks always show.
 */
const headerBadges = computed(() => {
  const tc = testCase.value;
  type Badge = {
    label: string;
    color?: 'error' | 'flaky' | 'neutral' | 'success';
    icon?: string;
    title?: string;
    mono?: boolean;
  };
  if (!tc) return [] as Badge[];
  const out: Badge[] = [];
  if (isExpectedFailurePassed(tc.status, tc.expectedStatus))
    out.push({
      label: 'Looks fixed',
      color: 'success',
      icon: 'i-lucide-bug-off',
      title: 'Marked test.fail() and passed: the bug it reproduces no longer shows. Remove test.fail() with the fix.',
    });
  if (!verdict.value) {
    if (tc.isNewRegression)
      out.push({
        label: 'New regression',
        color: 'error',
        icon: 'i-lucide-git-pull-request-arrow',
        title: 'Passed in the baseline run, failing here',
      });
    if (tc.isNewFlaky)
      out.push({
        label: 'Newly flaky',
        color: 'flaky',
        icon: 'i-lucide-shuffle',
        title: 'Newly started passing only on retry',
      });
  }
  for (const ann of annotations.value)
    out.push({ label: `@${ann.type}`, color: 'neutral', mono: true, title: ann.description || ann.type });
  return out;
});

// ── Retry command ────────────────────────────────────────────────────────────
// In the next-step line's overflow menu, the More menu and the Verify section.
const retryCases = computed(() => [
  {
    filePath: testCase.value?.filePath ?? '',
    title: testCase.value?.title ?? '',
    line: testCase.value?.line ?? null,
    projectName: (testCase.value?.browser as { projectName?: string } | null)?.projectName ?? null,
  },
]);
const retryCommand = computed(() => buildRetryCommand(retryCases.value));
const { copy: copyRetry } = useCopy();

onMounted(() => {
  desktopBridge.value = !!tauriCore();
});

// ── What the viewer may do on the execution's project ───────────────────────
const { can } = useAuth();
const executionProjectId = computed(() => testCase.value?.testRun?.project?.id ?? null);
const canQuarantine = computed(() => can('quarantine:write', executionProjectId.value));
const canTriage = computed(() => can('triage:write', executionProjectId.value));
const canCreateIssue = computed(() => can('issue:create', executionProjectId.value));
const canEditLinks = computed(() => can('link:write', executionProjectId.value));

// ── Quarantine ──────────────────────────────────────────────────────────────
const { quarantineOne, releaseOne } = useQuarantine(() => executionProjectId.value);
// What quarantining the test leaves to no other trusted test, or releasing it covers again: read when the More
// menu opens, where the project records coverage, and said under the menu's action.
const { load: loadQuarantineLoss, answerFor: quarantineLossFor } = useCoverageLoss(
  () => executionProjectId.value,
  () => projectCapState('coverage') === 'active',
);
function onMoreMenu(open: boolean) {
  const stableId = testCase.value?.testCaseId;
  if (open && canQuarantine.value && stableId) void loadQuarantineLoss([stableId]);
}
const quarantineLossText = computed(() => {
  const stableId = testCase.value?.testCaseId;
  if (!stableId) return undefined;
  return coverageLossPreview(quarantineLossFor([stableId]), quarantined.value ? 'release' : 'quarantine')?.headline;
});
const quarantineBusy = ref(false);
async function toggleQuarantine() {
  const stableId = testCase.value?.testCaseId;
  if (!stableId || quarantineBusy.value) return;
  quarantineBusy.value = true;
  try {
    const ok = quarantined.value
      ? await releaseOne(stableId)
      : await quarantineOne(stableId, 'Quarantined from execution');
    if (ok) await refresh();
  } finally {
    quarantineBusy.value = false;
  }
}

// ── Copy failure ────────────────────────────────────────────────────────────
const { copyRich } = useCopyRich();
function copyFailure() {
  const tc = testCase.value;
  if (!tc?.error) return;
  const origin = window.location.origin;
  const title = tc.title ?? 'Unknown test';
  const loc = tc.location ?? '';
  // eslint-disable-next-line no-control-regex
  const rawError = tc.error.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const clusterUrl = failureCluster.value ? `${origin}/failure-clusters/${failureCluster.value.id}` : null;
  const testCaseUrl = `${origin}/test-run-cases/${testCaseId}`;
  const stableUrl = testCase.value?.testCaseId ? `${origin}/test-cases/${testCase.value.testCaseId}` : null;

  const issue = knownIssue.value;
  const plain = [
    `❌ Test failed: ${title}`,
    loc ? `Location: ${loc}` : null,
    issue ? `Tracked in ${issue.key}${issue.status ? ` (${issue.status})` : ''}: ${issue.url}` : null,
    '',
    'Error:',
    rawError,
    '',
    clusterUrl ? `Failure cluster: ${clusterUrl}` : null,
    `Execution: ${testCaseUrl}`,
    stableUrl ? `History: ${stableUrl}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n');

  const html = [
    `<p><strong>❌ Test failed: ${esc(title)}</strong>${loc ? `<br><code>${esc(loc)}</code>` : ''}</p>`,
    issue
      ? `<p>Tracked in <a href="${esc(issue.url)}">${esc(issue.key)}</a>${issue.status ? ` (${esc(issue.status)})` : ''}</p>`
      : '',
    `<p><strong>Error:</strong></p><pre>${renderAnsi(tc.error)}</pre>`,
    `<p>🔗 ${clusterUrl ? `<a href="${clusterUrl}">View failure cluster</a> · ` : ''}<a href="${testCaseUrl}">Execution details</a>${stableUrl ? ` · <a href="${stableUrl}">Test history</a>` : ''}</p>`,
  ].join('');

  copyRich(plain, html, { toast: 'Failure copied' });
}

// ── The cluster's issue: the Cluster line's ticket, the menu, and their dialogs
const { hasTracker } = useTrackerStatus();
// The execution carries its cluster's issue, so it is current right after a create.
const knownIssue = computed(() => failureCluster.value?.knownIssue ?? null);
const canFileIssue = computed(() => hasTracker.value && canCreateIssue.value);
const issueForm = computed(() =>
  failureCluster.value
    ? issueLineForm({
        hasKnownIssue: Boolean(knownIssue.value),
        filingQueued: Boolean(failureCluster.value.issueFilingQueued),
        clusterStatus: failureCluster.value.status,
        snoozed: false,
        canFile: canFileIssue.value,
        canLink: canEditLinks.value,
      })
    : null,
);
const issueModalOpen = ref(false);
const linkIssueOpen = ref(false);

function onIssueCreated() {
  issueModalOpen.value = false;
  linkIssueOpen.value = false;
  void refresh();
}

// ── Navbar More menu ────────────────────────────────────────────────────────
// Grouped as on the cluster page: the ticket, the test actions, the copies, then
// Refresh.
const moreMenuItems = computed<DropdownMenuItem[][]>(() => {
  // The cluster's ticket: open it, or file or link one. The links of the
  // execution, its test and its run are edited in the facts line's Details.
  const issue: DropdownMenuItem[] = [];
  if (knownIssue.value) {
    issue.push({
      label: `Open ${knownIssue.value.key}`,
      icon: getProviderIcon(knownIssue.value.provider as LinkProvider),
      to: safeHttpUrl(knownIssue.value.url) ?? undefined,
      target: '_blank',
    });
  } else if (canFileIssue.value && failureCluster.value?.issueFilingQueued) {
    issue.push({
      label: 'Filing queued · Retry',
      icon: 'i-lucide-clock',
      onSelect: () => (issueModalOpen.value = true),
    });
  } else if (canFileIssue.value && failureCluster.value) {
    issue.push({ label: 'Create issue', icon: 'i-lucide-file-plus', onSelect: () => (issueModalOpen.value = true) });
  }
  if (canEditLinks.value && failureCluster.value) {
    issue.push({ label: 'Link an issue', icon: 'i-lucide-link', onSelect: () => (linkIssueOpen.value = true) });
  }

  const testActions: DropdownMenuItem[] = [];
  if (canQuarantine.value && testCase.value?.testCaseId) {
    testActions.push(
      quarantined.value
        ? {
            label: 'Release from quarantine',
            description: quarantineLossText.value,
            icon: 'i-lucide-shield-check',
            color: 'warning',
            onSelect: toggleQuarantine,
          }
        : {
            label: 'Quarantine this test',
            description: quarantineLossText.value,
            icon: 'i-lucide-shield-alert',
            color: 'warning',
            onSelect: toggleQuarantine,
          },
    );
  }

  const copies: DropdownMenuItem[] = [];
  if (testCase.value?.error) copies.push({ label: 'Copy failure', icon: 'i-lucide-clipboard', onSelect: copyFailure });
  // The retry command also appears on the next-step line (for code-change
  // steps) and in the Verify section.
  if (retryCommand.value && !desktopBridge.value) {
    copies.push({
      label: 'Copy retry command',
      icon: 'i-lucide-clipboard',
      onSelect: () => copyRetry(retryCommand.value, { toast: 'Retry command copied' }),
    });
  }

  const refreshItem: DropdownMenuItem = { label: 'Refresh', icon: 'i-lucide-refresh-cw', onSelect: () => refresh() };
  return [issue, testActions, copies, [refreshItem]].filter((group) => group.length > 0);
});

// ── Live streaming ──────────────────────────────────────────────────────────
const isDemoMode = Boolean(useRuntimeConfig().public.demoMode);
let eventSource: EventSource | null = null;
function connectToRunStream() {
  if (!import.meta.client || isDemoMode || eventSource) return;
  const runId = testCase.value?.testRun?.id;
  if (!runId) return;
  eventSource = new EventSource(`/api/test-runs/${runId}/stream`);
  eventSource.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      if (parsed.type === 'case-files' && parsed.data?.executionId === Number(testCaseId)) {
        refresh();
        refreshTraces();
      } else if (parsed.type === 'run-finished') {
        refresh();
        refreshTraces();
        disconnectRunStream();
      }
    } catch {
      // Ignore non-JSON messages (e.g. heartbeat comments)
    }
  };
  eventSource.onerror = () => {
    // EventSource will auto-reconnect
  };
}
function disconnectRunStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}
watch(
  runIsActive,
  (active) => {
    if (active) connectToRunStream();
    else disconnectRunStream();
  },
  { immediate: true },
);
onUnmounted(disconnectRunStream);

// ── Section locator ─────────────────────────────────────────────────────────
// A clue or diagnosis citation reveals the evidence it came from: the evidence
// tabs handle the tabbed sections (switch tab + scroll), while the raw error and
// locator-fix blocks scroll in place.
const evidenceEl = ref<HTMLElement | null>(null);
const factsLine = ref<{ revealRawError: () => void } | null>(null);
const locatorPanel = ref<{
  openPicker: () => void;
  expandAlternatives: () => void;
} | null>(null);
const evidenceTabs = ref<{
  canLocate: (id: string) => boolean;
  revealSection: (id: string, index?: number) => boolean;
  selectTab: (t: string) => void;
} | null>(null);
const toolbox = ref<{
  openSection: (k: FixSectionKey) => Promise<void>;
  scrollToSection: (k: FixSectionKey, anchor?: string) => Promise<void>;
} | null>(null);

function scrollToEl(el: HTMLElement | null) {
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// The raw error is a disclosure on the facts line; the locator fix lives in the
// toolbox. A citation reveals or scrolls to the block that holds it.
const pageSections: Record<string, () => void> = {
  sampleError: () => factsLine.value?.revealRawError(),
  executionError: () => factsLine.value?.revealRawError(),
  locatorHealing: () => toolbox.value?.scrollToSection('locator-fix'),
};
provide(clusterSectionLocatorKey, {
  // Answered from static maps so a citation renders as a button at SSR time too,
  // not only once the evidence card has mounted and registered its ref.
  canLocate: (id: string) => id in pageSections || id in EVIDENCE_SECTION_TAB,
  open: (id: string, index?: number) => {
    if (id in pageSections) pageSections[id]!();
    else evidenceTabs.value?.revealSection(id, index);
  },
});

// ── Next step: turn one action id into the real behaviour ────────────────────
// The next-step line stays presentation-only; the page owns the wiring through
// the shared composable, reusing the same fetches and panels the toolbox does
// rather than issuing new requests. Page-specific targets are callbacks.
const { setClusterStatus } = useClusterTriage(() => failureCluster.value?.id ?? null, { onSaved: () => refresh() });

const { handle: handleNextStepAction } = useNextStepActions({
  clusterId: () => failureCluster.value?.id ?? null,
  change: () => nextStepChange.value,
  ideProject: () => testCase.value?.testRun?.project ?? null,
  locatorPanel: () => locatorPanel.value,
  reproRecipe: () => reproduceData.value?.reproduce ?? null,
  diagnosisContextEndpoint: () => `/api/test-run-cases/${testCaseId}/diagnosis-context`,
  scrollToSection: (k, anchor) => toolbox.value?.scrollToSection(k, anchor),
  selectAttemptsTab: () => {
    evidenceTabs.value?.selectTab('attempts');
    nextTick(() => scrollToEl(evidenceEl.value));
  },
  setClusterStatus,
  quarantine: () => toggleQuarantine(),
  rerunInCi: () => triggerRerun(),
  whatChanged: () => {
    if (failureCluster.value) navigateTo(`/failure-clusters/${failureCluster.value.id}`);
  },
  reDiagnose: () => {
    if (failureCluster.value) navigateTo(`/failure-clusters/${failureCluster.value.id}#fix-plan`);
  },
});
</script>

<template>
  <UDashboardPanel id="test-run-case-detail">
    <template #header>
      <!-- The breadcrumb's current crumb is the page title; a navbar title would repeat it. -->
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav
            :items="[
              { label: 'Home', icon: 'i-lucide-house', to: '/' },
              { label: 'Projects', to: '/projects' },
              ...(testCase?.testRun?.project?.id
                ? [
                    {
                      label: testCase.testRun.project.label || testCase.testRun.project.name || 'Project',
                      to: `/projects/${testCase.testRun.project.id}`,
                    },
                  ]
                : [{ label: 'Project' }]),
              ...(testCase?.testRun?.id
                ? [{ label: `Run #${testCase.testRun.id}`, to: `/test-runs/${testCase.testRun.id}` }]
                : [{ label: 'Test run' }]),
              { label: testCase?.title || `Execution #${testCaseId}` },
            ]"
          />
        </template>
        <template #right>
          <div class="flex items-center gap-1 shrink-0 min-w-0">
            <NuxtLink
              v-if="testCase?.testCaseId"
              :to="`/test-cases/${testCase.testCaseId}`"
              class="text-xs text-gray-500 hover:text-primary mr-2 flex items-center gap-1 shrink-0"
              title="View this test's history across runs"
              aria-label="Test history"
            >
              <UIcon name="i-lucide-trending-up" class="size-3.5" />
              <span class="hidden xl:inline">Test history</span>
            </NuxtLink>
            <ShareLinksModal
              v-if="testCase && !isDemoMode"
              :endpoint="`/api/test-run-cases/${testCase.id}/share-links`"
              :project-id="executionProjectId"
            />
            <ExportMenu
              v-if="testCase"
              :endpoint="`/api/test-run-cases/${testCase.id}/export`"
              :perfetto-endpoint="`/api/test-run-cases/${testCase.id}/perfetto`"
              :replay-endpoint="isFailedExecution ? `/api/test-run-cases/${testCase.id}` : undefined"
              :base-name="`piwi-execution-${testCase.id}`"
              class="mr-1"
            />
            <UDropdownMenu :items="moreMenuItems" @update:open="onMoreMenu">
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-lucide-ellipsis-vertical"
                aria-label="More actions"
                title="More actions"
              />
            </UDropdownMenu>
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- No side gutter below `sm`: the cards go full-bleed to the screen edge. -->
      <div class="flex flex-col gap-4 p-4 max-sm:px-0 max-w-6xl mx-auto w-full">
        <!-- ── One block: what broke, what is going on, what to do next ── -->
        <SituationBlock help="case.situation" :edge="statusEdge">
          <!-- Line 1: identity kicker — status, title, marks, quarantine -->
          <template #identity>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <StatusChip :status="testCase?.status ?? ''" :retries="testCase?.retries" class="shrink-0" />
              <span class="text-highlighted min-w-0 break-words">
                {{ testCase?.title || `Execution #${testCaseId}` }}
              </span>
              <span
                v-for="badge in headerBadges"
                :key="badge.label"
                :title="badge.title"
                :class="badge.mono ? 'font-mono text-xs' : ''"
              >
                {{ badge.label }}
              </span>
              <QuarantinedChip v-if="quarantined" />
            </div>
          </template>

          <!-- Line 2: the headline — the page's h1; for a retry pass, its failed attempt's -->
          <template v-if="verdict" #headline>
            <h1
              data-shot="failure-headline"
              class="text-lg sm:text-xl font-semibold leading-snug text-highlighted break-words"
            >
              <FailureHeadline :parts="verdict.parts" chip />
            </h1>
            <p
              v-if="verdict.detail && !story"
              class="font-mono text-xs text-muted truncate mt-1"
              :title="verdict.detail"
            >
              {{ verdict.detail }}
            </p>
            <!-- Since when it fails (for a retry pass, which attempt failed), on which commit, and whether a newer execution failed again or passed. -->
            <ExecutionMetaLine
              v-if="situation"
              :since="situation.since"
              :latest="situation.latest"
              :repository-url="repositoryUrl"
            />
            <!-- The capture-fixtures nudge, at the point where their absence is felt. -->
            <p v-if="showFixturesNudge" data-shot="fixtures-nudge" class="mt-2 text-xs text-muted">
              Capture fixtures would have recorded the network activity behind this failure.
              <button
                type="button"
                :class="SENTENCE_LINK_CLASS"
                :disabled="nudgeDeciding"
                @click="declineFixturesForProject"
              >
                Not for this project
              </button>
            </p>
          </template>

          <!-- Line 3: most likely — the one explanation, by the rule both failure pages follow; for a test that did not run, why -->
          <template v-if="isProblem && verdict && mostLikely" #story>
            <StoryLine :most-likely="mostLikely" :clues="clues" :failure-at="cluesFailureAt" />
          </template>
          <template v-else-if="didNotRun" #story>
            <DidNotRunLine :explanation="didNotRun" />
          </template>

          <!-- Line 4: the next step -->
          <template v-if="(isProblem || isPassedOnRetry) && nextStep" #next>
            <NextStepLine
              :next-step="nextStep"
              :retry-command="retryCommand"
              :source="nextStepSource"
              :change="nextStepChange"
              :ide-project="testCase?.testRun?.project ?? null"
              @action="handleNextStepAction"
            />
          </template>

          <!-- Line 5: the cluster, then its ticket or the way to file or link one -->
          <template v-if="isProblem && (situation?.cluster || issueForm)" #cluster>
            <div data-shot="cluster-line">
              <IssueLine
                v-if="issueForm"
                :form="issueForm"
                :project-id="executionProjectId"
                :cluster-status="failureCluster?.status"
                :failure-goes-on="failureCluster?.failureGoesOn === true"
                :known-issue="knownIssue"
                :filing-failure="failureCluster?.issueFilingFailure ?? null"
                @create="issueModalOpen = true"
                @link="linkIssueOpen = true"
              >
                <template v-if="situation?.cluster" #lead
                  ><SituationParts :parts="situation.cluster.parts" :repository-url="repositoryUrl"
                /></template>
              </IssueLine>
              <p v-else-if="situation?.cluster">
                <SituationParts :parts="situation.cluster.parts" :repository-url="repositoryUrl" />
              </p>
            </div>
          </template>

          <!-- Line 6: what changed, the changed lines this test ran (its suspect lines) -->
          <template v-if="isProblem && suspectSentence && failureCluster" #whatChanged>
            <p data-shot="execution-what-changed">
              <SuspectLinesSentence
                :sentence="suspectSentence"
                :to="`/failure-clusters/${failureCluster.id}#what-changed`"
              />
            </p>
          </template>

          <!-- Line 7: the facts line, one size smaller, with Details and Raw error -->
          <template #facts>
            <ExecutionFactsLine
              ref="factsLine"
              :test-case="testCase"
              :history="historyData"
              @copy-failure="copyFailure"
              @links-changed="refresh()"
            />
          </template>
        </SituationBlock>

        <!-- ── Evidence ───────────────────────────────────────────────── -->
        <!-- Hidden while the card renders nothing (a test that never ran), so it adds no gap. -->
        <div ref="evidenceEl" class="scroll-mt-4 empty:hidden">
          <EvidenceTabs
            ref="evidenceTabs"
            :test-case="testCase"
            :traces="(traceData as TraceInfo[]) ?? []"
            :has-trace="hasTrace"
            :default-hint="defaultHint"
            :suppress-fixtures-footer="showFixturesNudge"
            :fixtures-state="projectCapState('fixtures')"
            :coverage-state="projectCapState('coverage')"
            :suspect-lines="suspectLinesData ?? null"
            :what-changed-to="failureCluster ? `/failure-clusters/${failureCluster.id}#what-changed` : null"
            :can-decide-fixtures="canDecideCap"
            help="case.evidence"
            @decline-fixtures="declineFixtures"
          />
        </div>

        <!-- ── More ways to fix ───────────────────────────────────────── -->
        <div v-if="showFix" class="scroll-mt-4">
          <Toolbox ref="toolbox" :sections="fixSections" :next-step-kind="nextStep?.kind ?? null" help="fix.toolbox">
            <template #diagnosis-summary>{{ diagnosisSummary }}</template>
            <template #locator-fix-summary>Ranked replacement locators from the failing page</template>
            <template #verify-summary>{{ verifySummary }}</template>
            <template #reproduce-summary>{{ reproduceSummary }}</template>
            <template #fixed-before-summary
              >{{ fixedBefore.length }} similar resolved cluster{{ fixedBefore.length === 1 ? '' : 's' }}</template
            >
            <template #blocked-summary
              >{{ blockedTests.length }} test{{ blockedTests.length === 1 ? '' : 's' }}</template
            >
            <template #fix-plan-summary>The cluster's full fix plan — diagnosis, edits and verify command</template>

            <!-- Ranked replacement locators for a broken locator -->
            <template #locator-fix>
              <LocatorHealingPanel
                v-if="testCase"
                ref="locatorPanel"
                :test-runs-case-id="Number(testCaseId)"
                :healing="locatorHealingData ?? null"
                :ai-intents="aiIntents"
                :chrome="false"
                :has-page-diff="true"
                @show-page-diff="evidenceTabs?.revealSection('pageDiff')"
              />
            </template>

            <!-- A link to the cluster's full fix plan -->
            <template v-if="failureCluster" #fix-plan>
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <template v-if="failureCluster.diagnosis?.status === 'completed'">
                  <UBadge v-if="failureCluster.diagnosis.category" color="neutral" variant="soft" size="xs">
                    {{ failureCluster.diagnosis.category }}
                  </UBadge>
                  <UBadge
                    v-if="failureCluster.diagnosis.confidence"
                    :color="confidenceColor(failureCluster.diagnosis.confidence)"
                    variant="soft"
                    size="xs"
                  >
                    {{ failureCluster.diagnosis.confidence }} confidence
                  </UBadge>
                </template>
                <UButton
                  :to="`/failure-clusters/${failureCluster.id}#fix-plan`"
                  size="xs"
                  color="neutral"
                  variant="link"
                  trailing-icon="i-lucide-arrow-right"
                  class="px-0"
                >
                  Open on the cluster
                </UButton>
              </div>
            </template>

            <!-- The cluster's diagnosis summary and its whole patch, else the execution-scope diagnosis -->
            <template #diagnosis>
              <div v-if="clusterDiagnosis" class="space-y-1.5">
                <p class="text-sm text-toned">{{ clusterDiagnosis.summary }}</p>
                <UButton
                  :to="`/failure-clusters/${failureCluster!.id}`"
                  size="xs"
                  color="neutral"
                  variant="link"
                  trailing-icon="i-lucide-arrow-right"
                  class="px-0"
                >
                  Open
                </UButton>
                <PatchBlock
                  v-if="fixPlanPatch"
                  data-shot="diagnosis-patch"
                  data-copies="copy-git-apply"
                  class="scroll-mt-4"
                  :patch="fixPlanPatch"
                  :validation="fixPlanData?.diagnosis?.patchValidation ?? null"
                  :download-name="`piwi-fix-cluster-${failureCluster!.id}`"
                />
              </div>
              <DiagnosisPanel
                v-else
                scope="execution"
                :execution-id="Number(testCaseId)"
                :project-id="executionProjectId"
              />
            </template>

            <!-- Fixed before — resolved clusters this one resembles, and how each was fixed -->
            <template v-if="fixedBefore.length" #fixed-before>
              <FixedBeforeMatches
                :matches="fixedBefore"
                :can-triage="canTriage"
                :applying-id="applyingId"
                @apply="applyTriage"
              />
            </template>

            <!-- Re-run in CI, or run locally in the desktop shell -->
            <template v-if="showVerify" #verify>
              <div class="flex flex-wrap items-center gap-2">
                <UButton
                  v-if="rerunInfo?.available"
                  size="xs"
                  color="primary"
                  variant="soft"
                  icon="i-lucide-refresh-cw"
                  :loading="rerunning"
                  @click="triggerRerun"
                >
                  Re-run in CI
                </UButton>
                <DesktopRunLocallyButton
                  :project-id="testCase?.testRun?.project?.id"
                  :project-label="testCase?.testRun?.project?.label ?? testCase?.testRun?.project?.name"
                  :cases="retryCases"
                />
                <ClientOnly>
                  <span v-if="rerunInfo?.lastDispatch" class="text-xs text-muted">
                    Last re-run {{ formatRelativeTime(rerunInfo.lastDispatch.at) }}
                    <template v-if="rerunInfo.lastDispatch.byName">by {{ rerunInfo.lastDispatch.byName }}</template>
                  </span>
                </ClientOnly>
              </div>
            </template>

            <!-- Reproduce locally, then bisect the regression -->
            <template v-if="showReproduce" #reproduce>
              <ReproduceSection
                :reproduce="reproduceData!.reproduce"
                :bisect="reproduceData!.bisect"
                :context="reproduceData!.desktop"
                :project-label="testCase?.testRun?.project?.label ?? testCase?.testRun?.project?.name"
              />
            </template>

            <!-- The downstream tests this failure blocked from running -->
            <template #blocked>
              <ul class="space-y-1 text-sm">
                <li v-for="t in blockedTests" :key="t.id" class="flex items-center gap-2 min-w-0">
                  <UIcon name="i-lucide-circle-slash" class="size-3.5 shrink-0 text-amber-500" />
                  <NuxtLink :to="`/test-run-cases/${t.id}`" class="text-primary hover:underline truncate">
                    {{ t.title }}
                  </NuxtLink>
                </li>
              </ul>
            </template>
          </Toolbox>
        </div>

        <!-- ── History ────────────────────────────────────────────────── -->
        <SectionCard icon="i-lucide-history" title="History" data-shot="execution-history">
          <template #actions>
            <UButton
              v-if="testCase?.testCaseId"
              :to="`/test-cases/${testCase.testCaseId}`"
              size="xs"
              variant="outline"
              color="neutral"
              trailing-icon="i-lucide-arrow-right"
            >
              Test history
            </UButton>
          </template>
          <ClientOnly>
            <HistoryStrip v-if="historyData?.length" :history="historyData" :current-id="Number(testCaseId)" />
            <p v-else class="text-sm text-muted">No prior executions of this test yet.</p>
          </ClientOnly>
        </SectionCard>
      </div>
    </template>
  </UDashboardPanel>

  <!-- Link an issue to the execution's cluster: its known issue, on every execution of it. -->
  <LinkIssueModal
    v-if="failureCluster && canEditLinks"
    v-model:open="linkIssueOpen"
    :cluster-id="failureCluster.id"
    :known-issue-key="knownIssue?.key ?? null"
    @linked="onIssueCreated"
  />

  <CreateIssueModal
    v-if="testCase?.id"
    v-model:open="issueModalOpen"
    entity-type="test_runs_case"
    :entity-id="testCase.id"
    :known-issue-key="knownIssue?.key ?? null"
    @created="onIssueCreated"
    @linked="onIssueCreated"
    @queued="onIssueCreated"
    @failed="refresh()"
  />
</template>
