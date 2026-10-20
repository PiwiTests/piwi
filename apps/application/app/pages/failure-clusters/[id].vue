<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui';
import {
  describeCluster,
  clusterErrorTypeLabel,
  clusterSignatureLine,
  headlineAddsValue,
} from '#shared/describe-cluster';
import { parsePlaywrightError } from '#shared/error-parse';
import type { FailureCluesResult } from '#shared/handlers/test-cases';
import type { ComponentPublicInstance } from 'vue';
import type { FailureClusterDetail, TraceInfo } from '~~/types/api';
import type { FixPlan } from '#shared/fix-plan.types';
import type { LocatorHealingResult } from '#shared/locator-healing.types';
import { hasHealingAlternatives } from '#shared/locator-healing';
import { pickMostLikely, nextStepSourceLine } from '#shared/most-likely';
import { fixPlanToMarkdown } from '#shared/fix-plan-markdown';
import type { FixSectionKey } from '~/utils/fix-sections';
import type { RerunInfo } from '~/composables/useCiRerun';
import { renderAnsi } from '~/utils';
import { stripAnsi } from '~/utils/text-format';
import { buildRetryCommand } from '~/utils/retry-command';
import { coverageLossPreview } from '~/utils/coverage-insights';
import { clusterSectionLocatorKey } from '~/composables/useClusterSectionLocator';
import { EVIDENCE_SECTION_TAB } from '~/utils/evidence-sections';
import { relativeTimeAgo, durationApprox, toEpochMs } from '#shared/relative-time';
import { safeHttpUrl } from '#shared/utils/safe-url';
import { getProviderIcon, type LinkProvider } from '#shared/link-detect';
import { issueLineForm } from '~/utils/issue-line';
import { buildNextStepChange } from '~/utils/next-step-change';

const route = useRoute();
const clusterId = parseInt(String(route.params.id));
// Share links need the server; the public demo has no share-link routes.
const isDemoMode = Boolean(useRuntimeConfig().public.demoMode);

// What the viewer may do on the cluster's project, matching each action's route.
const { can } = useAuth();

// Provide shared diagnosis/investigation state (consumed by WhatChangedLine,
// ClusterInvestigation and DiagnosisPanel). Must run before the top-level await
// below so provide() and lifecycle hooks register against the active setup
// instance. The page keeps what it renders on: whether the What changed card
// has anything to show, and the commit coverage behind the More menu's Copy git
// log.
const {
  hasChangesToShow,
  coverage: contextCoverage,
  scmChanges,
  suspectLines: clusterSuspectLines,
} = provideClusterDiagnosis(clusterId);

const {
  data: cluster,
  error: clusterError,
  refresh: refreshCluster,
} = await useFetch<FailureClusterDetail>(`/api/failure-clusters/${clusterId}`);
if (clusterError.value) showPageLoadError(clusterError.value, 'failure cluster');
const clusterProjectId = computed(() => cluster.value?.project?.id ?? null);
const canTriage = computed(() => can('triage:write', clusterProjectId.value));
const canQuarantine = computed(() => can('quarantine:write', clusterProjectId.value));
const canRerun = computed(() => can('run:control', clusterProjectId.value));

// The fix plan — the one artifact bundling diagnosis, edits, failing tests, owner
// and the verify command. Same endpoint the `get_fix_plan` MCP tool returns.
const { data: fixPlan } = await useFetch<FixPlan>(`/api/failure-clusters/${clusterId}/fix-plan`);

const describable = computed(() => ({
  ...(cluster.value as FailureClusterDetail),
  filePath: cluster.value?.affectedTestCases?.[0]?.filePath ?? null,
}));
const clusterName = computed(() => (cluster.value ? describeCluster(describable.value) : 'Failure cluster'));
const signatureLine = computed(() => (cluster.value ? clusterSignatureLine(describable.value) : null));

useHead(computed(() => ({ title: `${clusterName.value} — Piwi Dashboard` })));

// ── Selected affected execution ─────────────────────────────────────────────
// The evidence and the clues are shown for one affected test at a time; the
// default is the most-affected case's latest execution (the representative the
// cluster handler orders first).
const affectedCases = computed(() => cluster.value?.affectedTestCases ?? []);
// The latest occurrence — the execution in the last-seen run — is the default
// the evidence opens on.
const latestExecId = computed(
  () => cluster.value?.latestTestRunsCaseId ?? affectedCases.value[0]?.recentTestRunsCaseId ?? null,
);
const latestCaseId = computed(() => cluster.value?.latestTestCaseId ?? affectedCases.value[0]?.testCaseId);
const selectedCaseId = ref<number | undefined>(latestCaseId.value);
watch(latestCaseId, (id) => {
  if (selectedCaseId.value === undefined) selectedCaseId.value = id;
});
watch(affectedCases, (list) => {
  if (!list.some((c) => c.testCaseId === selectedCaseId.value)) selectedCaseId.value = latestCaseId.value;
});
const selectedCase = computed(
  () => affectedCases.value.find((c) => c.testCaseId === selectedCaseId.value) ?? affectedCases.value[0] ?? null,
);
// The default case opens on its latest occurrence; switching cases shows that
// case's own most-recent execution.
const selectedExecId = computed(() =>
  selectedCase.value?.testCaseId === latestCaseId.value
    ? latestExecId.value
    : (selectedCase.value?.recentTestRunsCaseId ?? null),
);
const isLatestOccurrence = computed(() => selectedExecId.value === latestExecId.value);
// A cluster with one affected test names it in the Occurrences line and needs
// no selector; the rule reads the full count, not the listed page.
const singleTest = computed(() => (cluster.value?.affectedTests === 1 ? (affectedCases.value[0] ?? null) : null));

// Server-rendered fetches carry the viewer's session.
const requestFetch = useRequestFetch();
const { data: execution } = await useAsyncData<Record<string, unknown> | null>(
  `cluster-selected-exec-${clusterId}`,
  () =>
    selectedExecId.value
      ? requestFetch<Record<string, unknown>>(`/api/test-run-cases/${selectedExecId.value}`)
      : Promise.resolve(null),
  { watch: [selectedExecId] },
);
const { data: execTraces } = await useAsyncData<TraceInfo[]>(
  `cluster-selected-traces-${clusterId}`,
  () =>
    selectedExecId.value
      ? requestFetch<{ items: TraceInfo[] }>(`/api/test-run-cases/${selectedExecId.value}/traces`).then((r) => r.items)
      : Promise.resolve([]),
  { default: (): TraceInfo[] => [], watch: [selectedExecId] },
);
const { data: cluesData } = await useAsyncData<FailureCluesResult>(
  `cluster-selected-clues-${clusterId}`,
  () =>
    selectedExecId.value
      ? requestFetch<FailureCluesResult>(`/api/test-run-cases/${selectedExecId.value}/clues`)
      : Promise.resolve({ clues: [], story: null, failureAt: null }),
  { default: (): FailureCluesResult => ({ clues: [], story: null, failureAt: null }), watch: [selectedExecId] },
);

const clues = computed(() => cluesData.value?.clues ?? []);
const story = computed(() => cluesData.value?.story ?? null);
const cluesFailureAt = computed(() => cluesData.value?.failureAt ?? null);
// The evidence opens on the story: the first member clue's cited section and the
// story's strength (or the top clue's, when no combination matched), and what
// Most likely cites is marked in the card.
const defaultHint = useEvidenceHint(clues, story, () => mostLikely.value);
const hasTrace = computed(() => (execTraces.value?.length ?? 0) > 0);
const selectedRunId = computed(() => (execution.value as { testRun?: { id?: number } } | null)?.testRun?.id ?? null);
/** The line the selected test is declared on, from its execution. */
const selectedLine = computed(() => (execution.value as { line?: number | null } | null)?.line ?? null);

// ── The heading: the latest occurrence's headline when it says more ─────────
// The server builds the headline from the latest occurrence, so the heading
// never follows the Affected tests selection. It leads only when it carries a
// value the name lacks (an expected/received pair, a timeout, a count), and the
// name then sits under it.
const latestHeadline = computed(() => cluster.value?.latestHeadline ?? null);
const headlineLeads = computed(() =>
  headlineAddsValue(clusterName.value, latestHeadline.value?.parts.map((p) => p.text).join('') ?? ''),
);
// Where the headline comes from, on hover.
const headlineSource = computed(() => {
  const h = latestHeadline.value;
  return h ? `From the ${h.source === 'latest' ? 'latest' : 'first'} occurrence, run #${h.runId}` : undefined;
});

// The name as prose and the locators written into it, each rendered as code.
const clusterNameParts = computed(() => splitLocatorParts(clusterName.value));
const errorTypeLabel = computed(() => clusterErrorTypeLabel(cluster.value?.errorType));

// The selected execution's stored error, else the cluster's sample error: the
// Locator fix section applies only to a locator-resolution failure.
const execError = computed(() => (execution.value as { error?: string | null } | null)?.error ?? null);
const isLocatorFailure = computed(() => {
  const error = execError.value ?? cluster.value?.sampleError ?? null;
  return Boolean(error && parsePlaywrightError(error).isLocatorResolutionFailure);
});

// ── Cluster state, occurrences and the next step (served on the endpoint) ────
const clusterState = computed(() => cluster.value?.clusterState ?? null);
// The situation block's edge, in the color the state line's dot carries.
const stateEdge = computed(() => clusterStateColor(clusterState.value?.kind).edge);
const occurrenceSeries = computed(() => cluster.value?.occurrenceSeries ?? []);
const nextStep = computed(() => cluster.value?.nextStep ?? null);

// The cluster's completed diagnosis.
const clusterDiagnosis = computed(() => {
  const d = cluster.value?.diagnosis;
  return d && d.status === 'completed' && d.summary
    ? { summary: d.summary, confidence: d.confidence ?? null, provider: d.provider ?? null }
    : null;
});
// The one explanation on the first screen, by the rule the execution page follows
// too: a strong or medium story of the selected execution, else the diagnosis,
// else a weak story, else the top clue.
const mostLikely = computed(() =>
  pickMostLikely({ story: story.value, clues: clues.value, diagnosis: clusterDiagnosis.value }),
);

// The occurrence sentence: the span (first → last) is stable, the "last X ago" is
// client-only so the server and browser time zones never disagree.
const occurrenceSpan = computed(() => {
  const c = cluster.value;
  const first = toEpochMs(c?.firstSeenAt ?? null);
  const last = toEpochMs(c?.lastSeenAt ?? null);
  if (first == null || last == null || last - first < 60_000) return null;
  return durationApprox(last - first);
});
const occurrencesText = computed(() => {
  const n = cluster.value?.occurrences ?? 0;
  return `${n} occurrence${n === 1 ? '' : 's'}`;
});
const occurrenceSpanText = computed(() => (occurrenceSpan.value ? ` over ${occurrenceSpan.value}` : ''));
const occurrenceCountText = computed(() => {
  const c = cluster.value;
  if (!c) return '';
  const tests = `${c.affectedTests} test${c.affectedTests === 1 ? '' : 's'}`;
  return `${occurrencesText.value} in ${tests}${occurrenceSpanText.value}`;
});
const lastSeenAgo = computed(() => relativeTimeAgo(cluster.value?.lastSeenAt ?? null));
// The sparkline opens the folded Occurrences over time card and scrolls to it.
const occurrenceTrend = ref<{ reveal: () => void } | null>(null);
const occurrenceAria = computed(() =>
  [occurrenceCountText.value, lastSeenAgo.value ? `last ${lastSeenAgo.value}` : null].filter(Boolean).join(' · '),
);

// The cluster's known issue (the newest tracker link), one rule for every place
// that names it, and the Issue line's form.
const knownIssue = computed(() => cluster.value?.knownIssue ?? null);
const { hasTracker } = useTrackerStatus();
const canFileIssue = computed(() => hasTracker.value && can('issue:create', clusterProjectId.value));
const canLinkIssue = computed(() => can('link:write', clusterProjectId.value));
const issueForm = computed(() =>
  issueLineForm({
    hasKnownIssue: Boolean(knownIssue.value),
    filingQueued: Boolean(cluster.value?.issueFilingQueued),
    clusterStatus: cluster.value?.status,
    snoozed: clusterState.value?.kind === 'snoozed',
    canFile: canFileIssue.value,
    canLink: canLinkIssue.value,
  }),
);
const issueModalOpen = ref(false);
const linkIssueOpen = ref(false);
function onIssueChanged() {
  issueModalOpen.value = false;
  linkIssueOpen.value = false;
  refresh();
}

// The facts line carries the raw-error disclosure; a citation reveals it through
// the exposed method.
const factsLine = ref<{ revealRawError: () => void } | null>(null);

// ── Copy summary ─────────────────────────────────────────────────────────────
const { copyRich } = useCopyRich();
function copyCluster() {
  const c = cluster.value;
  if (!c) return;
  const url = window.location.href;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const meta = [
    errorTypeLabel.value,
    `${c.occurrences} occurrence${c.occurrences === 1 ? '' : 's'}`,
    `${c.affectedTests} test${c.affectedTests === 1 ? '' : 's'} affected`,
    c.status !== 'open' ? formatTriageStatus(c.status) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const aiSummary =
    c.diagnosis?.status === 'completed' && c.diagnosis.summary
      ? `AI diagnosis (${c.diagnosis.category ?? 'unknown'}, ${c.diagnosis.confidence ?? '?'} confidence): ${c.diagnosis.summary}`
      : null;

  const issue = knownIssue.value;
  const tracked = issue ? `Tracked in ${issue.key}${issue.status ? ` (${issue.status})` : ''}: ${issue.url}` : null;

  const plain = [
    `❌ Failure cluster: ${clusterName.value}`,
    ...(clusterName.value !== c.signature ? [`Signature: ${c.signature}`] : []),
    meta,
    ...(tracked ? [tracked] : []),
    '',
    ...(c.sampleError ? ['Sample error:', stripAnsi(c.sampleError), ''] : []),
    ...(aiSummary ? [aiSummary, ''] : []),
    `Cluster: ${url}`,
  ].join('\n');

  const html = [
    `<p><strong>❌ Failure cluster</strong>: ${esc(clusterName.value)}</p>`,
    clusterName.value !== c.signature ? `<p><code>${esc(c.signature)}</code></p>` : '',
    `<p><em>${esc(meta)}</em></p>`,
    issue
      ? `<p>Tracked in <a href="${esc(issue.url)}">${esc(issue.key)}</a>${issue.status ? ` (${esc(issue.status)})` : ''}</p>`
      : '',
    c.sampleError ? `<p><strong>Sample error:</strong></p><pre>${renderAnsi(c.sampleError)}</pre>` : '',
    aiSummary
      ? `<p><strong>AI diagnosis</strong> (${esc(c.diagnosis?.category ?? 'unknown')}, ${esc(c.diagnosis?.confidence ?? '?')} confidence):<br>${esc(c.diagnosis!.summary!)}</p>`
      : '',
    `<p>🔗 <a href="${url}">View failure cluster</a></p>`,
  ].join('');

  copyRich(plain, html, { toast: 'Failure cluster copied' });
}

// ── Retry command / CI re-run (header primary action) ────────────────────────
const affectedRetryCases = computed(() =>
  (cluster.value?.affectedTestCases ?? []).map((tc) => ({
    filePath: tc.filePath,
    title: tc.title,
    line: null,
    projectName: null,
  })),
);
const retryCommand = computed(() => buildRetryCommand(affectedRetryCases.value));
const { copy: copyRetry } = useCopy();

const { data: rerunInfo, refresh: refreshRerun } = await useFetch<RerunInfo>(
  `/api/failure-clusters/${clusterId}/rerun`,
);
const { rerunning, triggerRerun } = useCiRerun(clusterId, refreshRerun);

function refresh() {
  refreshCluster();
  refreshRerun();
}

// ── More ways to fix ─────────────────────────────────────────────────────────
// Diagnosis first, then the locator fix, the verify command and the fix plan.
// The Locator fix section applies only to a locator-resolution failure — the same
// gate the execution page uses; a count mismatch or a value assertion has none.
// It reads the latest occurrence, the execution the next step checked.
const locatorCaseId = latestExecId.value;
const hasLocatorPanel = computed(() => Boolean(isLocatorFailure.value && locatorCaseId));

// The page fetches the healing once and hands it to the panel, so the Locator fix
// section appears only when there is something to show, and never when healing
// is hidden for this project. When the next step replaces the locator, the page
// waits for the healing, so the section and its panel are in the first render.
const healingLeads = nextStep.value?.kind === 'replace-locator';
const { data: clusterLocatorHealing } = await useFetch<LocatorHealingResult>(
  () => `/api/test-run-cases/${locatorCaseId}/locator-healing`,
  {
    lazy: !healingLeads,
    immediate: Boolean(locatorCaseId) && (hasLocatorPanel.value || healingLeads),
    key: `locator-healing-${locatorCaseId}`,
  },
);
const clusterLocatorHasData = computed(() => hasHealingAlternatives(clusterLocatorHealing.value));

// The change the next step copies, from the fix plan or the healing the page
// already loaded: the Next row shows it and its actions copy it.
const nextStepChange = computed(() =>
  buildNextStepChange(nextStep.value, {
    diagnosis: fixPlan.value?.diagnosis ?? null,
    healing: clusterLocatorHealing.value ?? null,
  }),
);

// Where the next step's change comes from: the diagnosis, named in full unless
// Most likely already shows it, or locator healing.
const nextStepSource = computed(() =>
  nextStepSourceLine(nextStep.value, {
    mostLikely: mostLikely.value,
    diagnosis: clusterDiagnosis.value && {
      ...clusterDiagnosis.value,
      hasPatch: fixPlan.value?.diagnosis ? Boolean(fixPlan.value.diagnosis.patch) : null,
      patchStatus: fixPlan.value?.diagnosis?.patchValidation?.status ?? null,
    },
    healing: clusterLocatorHealing.value ?? null,
    scope: 'cluster',
  }),
);
const {
  state: clusterCapState,
  isHidden: clusterCapHidden,
  canDecide: canDecideClusterCap,
  decide: decideClusterProjectCap,
} = await useProjectCapabilities(cluster.value?.project?.id ?? 0);
const { decide: decideClusterInstanceCap } = await useInstanceCapabilities();

async function declineClusterFixtures(level: 'project' | 'instance') {
  if (level === 'project') await decideClusterProjectCap('fixtures', 'declined');
  else await decideClusterInstanceCap('fixtures', 'declined');
}
const showLocatorFix = computed(
  () => hasLocatorPanel.value && clusterLocatorHasData.value && !clusterCapHidden('locator-healing'),
);
const showVerify = computed(() => Boolean(fixPlan.value?.verify?.command));
const showReproduce = computed(() => Boolean(fixPlan.value?.reproduce?.steps?.length));
const fixedBefore = computed(() => fixPlan.value?.fixedBefore ?? []);
const fixSections = computed<FixSectionKey[]>(() => {
  const s: FixSectionKey[] = ['diagnosis'];
  if (fixedBefore.value.length) s.push('fixed-before');
  if (showLocatorFix.value) s.push('locator-fix');
  if (showVerify.value) s.push('verify');
  if (showReproduce.value) s.push('reproduce');
  if (fixPlan.value) s.push('fix-plan');
  return s;
});

// ── Folded one-line summaries for the toolbox sections ───────────────────────
const diagnosisSummary = computed(() => diagnosisSectionSummary(cluster.value?.diagnosis, aiStatus.value?.configured));
const reproduceSummary = computed(() =>
  reproduceSectionSummary(fixPlan.value?.reproduce?.steps?.length ?? 0, Boolean(fixPlan.value?.bisect?.available)),
);
const verifySummary = computed(() =>
  verifySectionSummary(fixPlan.value?.verify?.command ?? '', Boolean(rerunInfo.value?.available), 'The verify command'),
);

// ── Apply the same triage ─────────────────────────────────────────────────────
const { applyingId, applyTriage } = useApplyClusterTriage({
  clusterId: () => clusterId,
  status: () => cluster.value?.status,
  currentNote: () => cluster.value?.triageNote,
  onApplied: () => refresh(),
});

// The diagnosis panel exposes its context and re-diagnose actions for the page's
// More menu and next step.
interface DiagnosisPanelActions {
  openContext: () => void;
  openHistory: () => void;
  reDiagnose?: () => void;
}
const diagnosisPanel = ref<DiagnosisPanelActions | null>(null);
const { aiStatus } = useAiStatus();

// The prompt a diagnosis would send, copied by the More menu and the next step.
const diagnosisContextEndpoint = `/api/failure-clusters/${clusterId}/context`;
const { copyPrompt: copyAiPrompt } = useCopyAiPrompt();

const { copy: copyMarkdown, copied: markdownCopied } = useCopy();
function copyFixPlanMarkdown() {
  if (!fixPlan.value) return;
  const url = typeof window !== 'undefined' ? window.location.href : undefined;
  copyMarkdown(fixPlanToMarkdown(fixPlan.value, { url }), { toast: 'Fix plan copied as Markdown' });
}

// A setup gap leaves What changed with the range alone: the command that lists
// it in a local clone is a More menu copy.
const scmStatus = computed(() => describeScmStatus(contextCoverage.value?.scm));
const gitLogCommand = computed(() =>
  scmStatus.value.setupGap && !scmChanges.value ? scmStatus.value.gitCommand : null,
);
const { copy: copyGitLog } = useCopy();

// ── Bulk actions (More menu) ─────────────────────────────────────────────────
const quarantineAll = ref<{ trigger: () => void } | null>(null);
const pendingQuarantine = computed(() => affectedCases.value.filter((c) => !c.quarantined));
// What quarantining them leaves to no other trusted test, read when the menu opens, where the project records coverage.
const pendingQuarantineIds = computed(() => pendingQuarantine.value.map((c) => c.testCaseId));
const { load: loadQuarantineLoss, answerFor: quarantineLossFor } = useCoverageLoss(
  () => cluster.value?.project?.id,
  () => clusterCapState('coverage') === 'active',
);
function onMoreMenu(open: boolean) {
  if (open && canQuarantine.value && pendingQuarantineIds.value.length > 0) {
    void loadQuarantineLoss(pendingQuarantineIds.value);
  }
}

// Grouped as on the execution page: the ticket, the test actions, the copies,
// then Refresh.
const moreMenuItems = computed<DropdownMenuItem[][]>(() => {
  // The ticket first: open it, or file or link one, from any scroll depth.
  const issue: DropdownMenuItem[] = [];
  if (knownIssue.value) {
    issue.push({
      label: `Open ${knownIssue.value.key}`,
      icon: getProviderIcon(knownIssue.value.provider as LinkProvider),
      to: safeHttpUrl(knownIssue.value.url) ?? undefined,
      target: '_blank',
    });
  } else if (canFileIssue.value && cluster.value?.issueFilingQueued) {
    issue.push({
      label: 'Filing queued · Retry',
      icon: 'i-lucide-clock',
      onSelect: () => (issueModalOpen.value = true),
    });
  } else if (canFileIssue.value) {
    issue.push({ label: 'Create issue', icon: 'i-lucide-file-plus', onSelect: () => (issueModalOpen.value = true) });
  }
  if (canLinkIssue.value) {
    issue.push({ label: 'Link an issue', icon: 'i-lucide-link', onSelect: () => (linkIssueOpen.value = true) });
  }

  const testActions: DropdownMenuItem[] = [];
  if (canQuarantine.value && pendingQuarantine.value.length > 0)
    testActions.push({
      label: 'Quarantine all affected tests',
      description: coverageLossPreview(quarantineLossFor(pendingQuarantineIds.value), 'quarantine')?.headline,
      icon: 'i-lucide-shield-alert',
      color: 'warning',
      onSelect: () => quarantineAll.value?.trigger(),
    });
  if (canRerun.value && rerunInfo.value?.available)
    testActions.push({
      label: 'Re-run in CI',
      icon: 'i-lucide-refresh-cw',
      onSelect: () => void triggerRerun(),
    });

  const copies: DropdownMenuItem[] = [
    { label: 'Copy summary', icon: 'i-lucide-clipboard-list', onSelect: copyCluster },
  ];
  if (rerunInfo.value?.available && retryCommand.value)
    copies.push({
      label: 'Copy retry command',
      icon: 'i-lucide-clipboard',
      onSelect: () => copyRetry(retryCommand.value, { toast: 'Retry command copied' }),
    });
  if (gitLogCommand.value) {
    const command = gitLogCommand.value;
    copies.push({
      label: 'Copy git log',
      icon: 'i-lucide-git-commit-horizontal',
      onSelect: () => copyGitLog(command, { toast: 'Copied the git log command' }),
    });
  }
  if (aiStatus.value?.configured)
    copies.push({
      label: 'Show context',
      icon: 'i-lucide-eye',
      onSelect: () => void onDiagnosisPanel((panel) => panel.openContext()),
    });
  copies.push({
    label: 'Copy prompt',
    icon: 'i-lucide-clipboard-copy',
    onSelect: () => void copyAiPrompt(diagnosisContextEndpoint),
  });

  const refreshItem: DropdownMenuItem = { label: 'Refresh', icon: 'i-lucide-refresh-cw', onSelect: refresh };
  return [issue, testActions, copies, [refreshItem]].filter((group) => group.length > 0);
});

// ── Section locator ──────────────────────────────────────────────────────────
// A clue or diagnosis citation reveals the evidence it came from: the evidence
// tabs handle the tabbed sections, the fix plan and the raw error scroll in place.
const scmEl = ref<HTMLElement | null>(null);
const whatChangedLine = ref<ComponentPublicInstance | null>(null);
const evidenceTabs = ref<{
  revealSection: (id: string, index?: number) => boolean;
  selectTab: (t: string) => void;
} | null>(null);
const clusterLocatorPanel = ref<{
  openPicker: () => void;
  expandAlternatives: () => void;
} | null>(null);
const toolbox = ref<{
  openSection: (k: FixSectionKey) => Promise<void>;
  scrollToSection: (k: FixSectionKey, anchor?: string) => Promise<void>;
} | null>(null);

// The Diagnosis section renders its panel only while open: open it (and scroll to
// it with `scroll`), wait for the panel to mount, then act on it.
const toast = useToast();
async function onDiagnosisPanel(act: (panel: DiagnosisPanelActions) => void, scroll = false) {
  await (scroll ? toolbox.value?.scrollToSection('diagnosis') : toolbox.value?.openSection('diagnosis'));
  if (diagnosisPanel.value) act(diagnosisPanel.value);
  else
    toast.add({
      title: 'Diagnosis not available',
      description: 'This page has no Diagnosis section to act on.',
      color: 'error',
    });
}

function scrollToEl(el: HTMLElement | null) {
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function openFixPlan() {
  toolbox.value?.scrollToSection('fix-plan');
}
const scrollToScm = () => scrollToEl(scmEl.value);

const pageSections: Record<string, () => void> = {
  fixPlan: openFixPlan,
  sampleError: () => factsLine.value?.revealRawError(),
  executionError: () => factsLine.value?.revealRawError(),
  scmInvestigation: scrollToScm,
  suspectLines: scrollToScm,
  selectedCommits: scrollToScm,
  topSuspectedCommit: scrollToScm,
  failingAction: scrollToScm,
};
provide(clusterSectionLocatorKey, {
  canLocate: (id: string) => id in pageSections || id in EVIDENCE_SECTION_TAB,
  open: (id: string, index?: number) => {
    if (id in pageSections) pageSections[id]!();
    else evidenceTabs.value?.revealSection(id, index);
  },
});

// ── Next step: turn one action id into the real behaviour ────────────────────
// The next-step line stays presentation-only; the page owns the wiring through
// the shared composable, reusing the same panels the toolbox does. Page-specific
// targets are callbacks.
const { quarantineOne } = useQuarantine(() => cluster.value?.project?.id ?? null);
const { setClusterStatus } = useClusterTriage(clusterId, { onSaved: () => refresh() });

const { handle: handleNextStepAction } = useNextStepActions({
  clusterId: () => clusterId,
  change: () => nextStepChange.value,
  ideProject: () => cluster.value?.project ?? null,
  locatorPanel: () => clusterLocatorPanel.value,
  reproRecipe: () => fixPlan.value?.reproduce ?? null,
  diagnosisContextEndpoint: () => diagnosisContextEndpoint,
  scrollToSection: (k, anchor) => toolbox.value?.scrollToSection(k, anchor),
  selectAttemptsTab: () => evidenceTabs.value?.selectTab('attempts'),
  setClusterStatus,
  quarantine: async () => {
    if (selectedCase.value) {
      const ok = await quarantineOne(selectedCase.value.testCaseId, `Quarantined from cluster #${clusterId}`);
      if (ok) refresh();
    }
  },
  rerunInCi: () => triggerRerun(),
  whatChanged: () => scrollToEl(scmEl.value ?? whatChangedLine.value?.$el ?? null),
  reDiagnose: () => onDiagnosisPanel((panel) => panel.reDiagnose?.(), true),
});

// Deep links from the execution page: its fix-plan link opens the fix-plan
// section, its suspect lines scroll to the What changed card, now when it is
// already there, else once it renders (it waits for the context, fetched after
// mount).
onMounted(() => {
  if (route.hash === '#fix-plan') nextTick(() => openFixPlan());
  if (route.hash === '#what-changed') {
    const stop = watch(
      scmEl,
      (el) => {
        if (!el) return;
        scrollToEl(el);
        queueMicrotask(() => stop());
      },
      { flush: 'post', immediate: true },
    );
  }
});

// Breadcrumbs
const breadcrumbItems = computed(() => [
  { label: 'Home', icon: 'i-lucide-house', to: '/' },
  { label: 'Projects', to: '/projects' },
  ...(cluster.value?.project
    ? [
        {
          label: cluster.value.project.label || cluster.value.project.name || 'Project',
          to: `/projects/${cluster.value.project.id}?tab=failure-clusters`,
        },
      ]
    : [{ label: 'Project' }]),
  { label: `Failure cluster #${clusterId}` },
]);
</script>

<template>
  <UDashboardPanel id="failure-cluster-detail">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav :items="breadcrumbItems" />
        </template>
        <template #right>
          <ShareLinksModal
            v-if="cluster && !isDemoMode"
            :endpoint="`/api/failure-clusters/${cluster.id}/share-links`"
            :project-id="cluster.project?.id ?? null"
          />
          <ExportMenu
            v-if="cluster"
            :endpoint="`/api/failure-clusters/${cluster.id}/export`"
            :base-name="`piwi-cluster-${cluster.id}`"
          />
          <UDropdownMenu v-if="cluster" :items="moreMenuItems" @update:open="onMoreMenu">
            <UButton
              size="sm"
              color="neutral"
              variant="ghost"
              icon="i-lucide-ellipsis-vertical"
              aria-label="More actions"
              title="More actions"
            />
          </UDropdownMenu>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="cluster" class="flex flex-col gap-4 p-4 max-sm:px-0 max-w-6xl mx-auto w-full">
        <!-- ── One block: identity, name, most likely, state, next, issue, occurrences, what changed ── -->
        <SituationBlock help="cluster.state" :edge="stateEdge">
          <!-- Line 1: identity kicker — cluster #, error type, project, owner -->
          <template #identity>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="text-highlighted">Failure cluster #{{ clusterId }}</span>
              <template v-if="errorTypeLabel">
                <span aria-hidden="true">·</span>
                <span>{{ errorTypeLabel }}</span>
              </template>
              <template v-if="cluster.project">
                <span aria-hidden="true">·</span>
                <NuxtLink :to="`/projects/${cluster.project.id}?tab=failure-clusters`" :class="SENTENCE_LINK_CLASS">
                  {{ cluster.project.label || cluster.project.name }}
                </NuxtLink>
              </template>
              <template v-if="cluster.owner">
                <span aria-hidden="true">·</span>
                <span :title="`Owner from ${cluster.owner.source}`">{{ cluster.owner.name }}</span>
              </template>
            </div>
          </template>

          <!-- Line 2: the h1, the latest headline when it says more than the name, the name under it -->
          <template #headline>
            <template v-if="headlineLeads && latestHeadline">
              <h1
                data-shot="failure-headline"
                class="text-lg sm:text-xl font-semibold leading-snug text-highlighted break-words"
                :title="headlineSource"
              >
                <FailureHeadline :parts="latestHeadline.parts" chip />
              </h1>
              <p data-shot="cluster-name" class="mt-1 text-xs text-muted break-words">
                <template v-for="(part, i) in clusterNameParts" :key="i">
                  <LocatorCode v-if="part.kind === 'locator'" :locator="part.text" chip class="text-[0.92em]" />
                  <template v-else>{{ part.text }}</template>
                </template>
              </p>
            </template>
            <h1 v-else class="text-lg sm:text-xl font-semibold leading-snug text-highlighted break-words">
              <template v-for="(part, i) in clusterNameParts" :key="i">
                <LocatorCode v-if="part.kind === 'locator'" :locator="part.text" chip class="text-[0.92em]" />
                <template v-else>{{ part.text }}</template>
              </template>
            </h1>
          </template>

          <!-- Line 3: most likely — the one explanation, by the rule both failure pages follow -->
          <template v-if="mostLikely" #story>
            <StoryLine :most-likely="mostLikely" :clues="clues" :failure-at="cluesFailureAt" />
          </template>

          <!-- Line 4: the state, one sentence with one verb and the control that changes it -->
          <template v-if="clusterState" #state>
            <ClusterStateLine
              :cluster="cluster"
              :state="clusterState"
              :action-in-next="!!clusterState.action && nextStep?.primary?.action === clusterState.action"
              @saved="refresh"
            />
          </template>

          <!-- Line 5: the next step -->
          <template v-if="nextStep" #next>
            <NextStepLine
              :next-step="nextStep"
              :retry-command="retryCommand"
              :source="nextStepSource"
              :change="nextStepChange"
              :ide-project="cluster.project ?? null"
              @action="handleNextStepAction"
            />
          </template>

          <!-- Line 6: the issue, the ticket the cluster is tracked in or the way to file or link one -->
          <template v-if="issueForm" #issue>
            <IssueLine
              :form="issueForm"
              :project-id="clusterProjectId"
              :cluster-status="cluster.status"
              :failure-goes-on="cluster.failureGoesOn"
              :known-issue="knownIssue"
              :filing-failure="cluster.issueFilingFailure"
              @create="issueModalOpen = true"
              @link="linkIssueOpen = true"
            />
          </template>

          <!-- Line 7: the occurrences, the sparkline and its sentence -->
          <template #occurrences>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <OccurrenceSparkline
                v-if="occurrenceSeries.length"
                :series="occurrenceSeries"
                :label="`Occurrences per run — ${occurrenceAria}`"
                @open="occurrenceTrend?.reveal()"
              />
              <span>
                <template v-if="singleTest"
                  >{{ occurrencesText }} in
                  <NuxtLink :to="`/test-cases/${singleTest.testCaseId}`" :class="SENTENCE_LINK_CLASS">{{
                    singleTest.title
                  }}</NuxtLink
                  >{{ occurrenceSpanText
                  }}<template v-if="singleTest.quarantined">
                    ·
                    <span
                      data-shot="single-test-quarantined"
                      title="Still runs and reports, but excluded from the CI gate's verdict"
                      >quarantined</span
                    ></template
                  ></template
                >
                <template v-else>{{ occurrenceCountText }}</template>
                <ClientOnly
                  ><template v-if="lastSeenAgo"> · last {{ lastSeenAgo }}</template></ClientOnly
                >
              </span>
            </div>
          </template>

          <!-- Line 8: what changed, the commits since the last passing run in one line -->
          <template #whatChanged>
            <WhatChangedLine
              ref="whatChangedLine"
              :coverage-active="clusterCapState('coverage') === 'active'"
              @see="scrollToEl(scmEl)"
            />
          </template>

          <!-- Line 9: the facts line: Details, Raw error, Copy summary -->
          <template #facts>
            <ClusterFactsLine ref="factsLine" :cluster="cluster" :signature-line="signatureLine" @refresh="refresh" />
          </template>
        </SituationBlock>

        <!-- ── The fix the next step points at, then the context and the evidence, then More ways to fix ── -->
        <Toolbox ref="toolbox" lead :sections="fixSections" :next-step-kind="nextStep?.kind ?? null" help="fix.toolbox">
          <template #between>
            <!-- ── What changed, in full: the baseline picker, the commits and the diff — only with something to show ── -->
            <div v-if="hasChangesToShow" ref="scmEl" data-shot="what-changed-card" class="scroll-mt-4">
              <ClusterInvestigation :project="cluster.project ?? null" />
            </div>

            <!-- ── Affected tests: the evidence selector, above the evidence, with several tests ── -->
            <ClusterAffectedTests
              v-if="!singleTest"
              v-model:selected-case-id="selectedCaseId"
              :cluster-id="clusterId"
              :cases="cluster.affectedTestCases ?? []"
              :project-id="cluster.project?.id"
              :project-key="cluster.project?.id"
              :project-name="cluster.project?.name"
              @changed="refresh"
            />

            <!-- ── Evidence ───────────────────────────────────────────────── -->
            <div v-if="selectedExecId" class="scroll-mt-4">
              <EvidenceTabs
                v-if="execution"
                ref="evidenceTabs"
                :test-case="execution"
                :traces="execTraces ?? []"
                :has-trace="hasTrace"
                :default-hint="defaultHint"
                :fixtures-state="clusterCapState('fixtures')"
                :coverage-state="clusterCapState('coverage')"
                :suspect-lines="clusterSuspectLines"
                :can-decide-fixtures="canDecideClusterCap"
                help="case.evidence"
                @decline-fixtures="declineClusterFixtures"
              >
                <!-- The test (its title path), the run and the occurrence the evidence is of -->
                <template v-if="selectedCase" #subject>
                  <TestTitlePath
                    :file-path="selectedCase.filePath"
                    :line="selectedLine"
                    :suite-path="selectedCase.suitePath"
                    :project-key="cluster.project?.id"
                    :project-name="cluster.project?.name"
                    >{{ selectedCase.title }}</TestTitlePath
                  >
                  <template v-if="selectedRunId">
                    ·
                    <NuxtLink :to="`/test-runs/${selectedRunId}`" :class="SENTENCE_LINK_CLASS"
                      >run #{{ selectedRunId }}</NuxtLink
                    >, {{ isLatestOccurrence ? 'latest occurrence' : "this test's latest occurrence" }}
                  </template>
                  ·
                  <NuxtLink :to="`/test-run-cases/${selectedExecId}`" :class="SENTENCE_LINK_CLASS"
                    >Open execution</NuxtLink
                  >
                </template>
              </EvidenceTabs>
            </div>
          </template>

          <template #diagnosis-summary>{{ diagnosisSummary }}</template>
          <template #locator-fix-summary>Ranked replacement locators from the failing page</template>
          <template #verify-summary>{{ verifySummary }}</template>
          <template #reproduce-summary>{{ reproduceSummary }}</template>
          <template #fixed-before-summary
            >{{ fixedBefore.length }} similar resolved cluster{{ fixedBefore.length === 1 ? '' : 's' }}</template
          >
          <template #fix-plan-summary>Copy as Markdown · the same plan an agent gets from get_fix_plan</template>

          <!-- Diagnosis — the unified panel; result shows with or without a provider -->
          <template #diagnosis>
            <div data-shot="cluster-diagnosis">
              <DiagnosisPanel
                ref="diagnosisPanel"
                scope="cluster"
                context-in-menu
                :cluster-id="clusterId"
                :project-id="cluster.project?.id ?? null"
                :last-seen-run-id="cluster.lastSeenRunId"
                :cluster-status="cluster.status"
                :fix-verification="cluster.fixVerification"
                :last-seen-at="cluster.lastSeenAt"
                :affected-test-cases="cluster.affectedTestCases ?? []"
              />
            </div>
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

          <!-- Locator fix — the recommendation, its provenance and alternatives, once -->
          <template #locator-fix>
            <LocatorHealingPanel
              ref="clusterLocatorPanel"
              :test-runs-case-id="locatorCaseId!"
              :healing="clusterLocatorHealing ?? null"
              :affected-count="affectedCases.length"
              :chrome="false"
            />
          </template>

          <!-- Verify — the command and how to re-run it -->
          <template v-if="fixPlan" #verify>
            <div class="space-y-1.5">
              <CodeBlock :code="fixPlan.verify.command" lang="bash" />
              <p class="text-xs text-muted">{{ fixPlan.verify.expectation }}</p>
              <div class="flex flex-wrap items-center gap-2">
                <DesktopRunLocallyButton
                  :project-id="cluster.project?.id"
                  :project-label="cluster.project?.label ?? cluster.project?.name"
                  :cases="affectedRetryCases"
                />
                <ClientOnly>
                  <span v-if="rerunInfo?.lastDispatch" class="text-xs text-muted">
                    Last re-run {{ formatRelativeTime(rerunInfo.lastDispatch.at) }}
                    <template v-if="rerunInfo.lastDispatch.byName">by {{ rerunInfo.lastDispatch.byName }}</template>
                  </span>
                </ClientOnly>
              </div>
            </div>
          </template>

          <!-- Reproduce — the local recipe and a generated git bisect -->
          <template v-if="fixPlan && showReproduce" #reproduce>
            <ReproduceSection
              :reproduce="fixPlan.reproduce"
              :bisect="fixPlan.bisect"
              :context="fixPlan.reproduceDesktop"
              :project-label="cluster?.project?.label ?? cluster?.project?.name"
            />
          </template>

          <!-- Fix plan — the whole plan assembled for a ticket or an agent -->
          <template v-if="fixPlan" #fix-plan-actions>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :icon="markdownCopied ? 'i-lucide-check' : 'i-lucide-clipboard'"
              title="Copy the whole plan as Markdown for a ticket or an agent"
              @click="copyFixPlanMarkdown"
            >
              Copy as Markdown
            </UButton>
          </template>
          <template v-if="fixPlan" #fix-plan>
            <p class="flex items-center gap-1 text-xs text-muted">
              <UIcon name="i-lucide-bot" class="size-3 shrink-0" />
              The diagnosis, edits, failing tests, owner and verify command in one document —
              <code class="font-mono">get_fix_plan</code> returns the same to your AI agent via the
              <NuxtLink to="/mcp" class="text-primary hover:underline">MCP server</NuxtLink>.
            </p>
          </template>
        </Toolbox>

        <!-- ── The history, folded: occurrences over time, then the activity ── -->
        <ClusterOccurrenceTrend ref="occurrenceTrend" :cluster-id="cluster.id" :first-seen-at="cluster.firstSeenAt" />
        <ClusterActivity :cluster-id="cluster.id" />
      </div>

      <ErrorState v-else text="Cluster not found." icon="i-lucide-search-x" class="h-64">
        <template #action>
          <UButton to="/projects" size="xs" color="neutral" variant="outline">Back to projects</UButton>
        </template>
      </ErrorState>
    </template>
  </UDashboardPanel>

  <!-- The ticket dialogs, opened from the Issue line and the More menu. -->
  <CreateIssueModal
    v-if="cluster && canFileIssue"
    v-model:open="issueModalOpen"
    entity-type="failure_cluster"
    :entity-id="cluster.id"
    :known-issue-key="knownIssue?.key ?? null"
    @created="onIssueChanged"
    @linked="onIssueChanged"
    @queued="onIssueChanged"
    @failed="refresh"
  />
  <LinkIssueModal
    v-if="cluster && canLinkIssue"
    v-model:open="linkIssueOpen"
    :cluster-id="cluster.id"
    :known-issue-key="knownIssue?.key ?? null"
    @linked="onIssueChanged"
  />

  <!-- Bulk actions triggered from the More menu. -->
  <QuarantineAllButton
    v-if="cluster && canQuarantine"
    ref="quarantineAll"
    hide-trigger
    :project-id="cluster.project?.id"
    :cases="cluster.affectedTestCases ?? []"
    :reason="`Quarantined from cluster #${cluster.id}`"
    @changed="refresh"
  />
</template>
