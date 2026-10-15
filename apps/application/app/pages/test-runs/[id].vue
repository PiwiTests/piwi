<script setup lang="ts">
import { computed, nextTick, watch, onUnmounted } from 'vue';
import type {
  TestRunDetails,
  TestCaseResult,
  ReportInfo,
  TestStepEvent,
  FailureGroup,
  RunClusterMeta,
} from '~~/types/api';
import type { LiveStepsByWorker } from '~/utils/live-steps';
import { subscribeDemoEvents } from '~/demo/run-events';
import { useRunStream } from '~/composables/useRunStream';
import { summarizeRunCases } from '#shared/utils/test-counts';

const route = useRoute();
const router = useRouter();
const runId = route.params.id;
const isDemoMode = Boolean(useRuntimeConfig().public.demoMode);
const { can } = useAuth();

const { data: testRun, error: testRunError, refresh } = await useFetch<TestRunDetails>(`/api/test-runs/${runId}`);
if (testRunError.value) showPageLoadError(testRunError.value, 'test run');

// Lightweight poll for latest run info — avoids reloading full page data on run events
const projectId = testRun.value?.projectId;
type LatestRunInfo = { id: number; status: string } | null;
const { data: latestRunInfo, refresh: refreshLatestRun } = projectId
  ? await useFetch<LatestRunInfo>(`/api/projects/${projectId}/latest-run`, { key: `latest-run-${projectId}` })
  : { data: ref<LatestRunInfo>(null), refresh: async () => {} };
useRunStream(refreshLatestRun);

// Which of this project's tests are quarantined — marks the matching rows in the
// executions list. `candidates=false` skips the heavier flaky-analysis proposal.
const { data: quarantineData, refresh: refreshQuarantine } = projectId
  ? await useFetch<{ entries: Array<{ testCaseId: number }> }>(
      `/api/projects/${projectId}/quarantine?candidates=false`,
      { key: `run-quarantine-${projectId}` },
    )
  : { data: ref<{ entries: Array<{ testCaseId: number }> } | null>(null), refresh: async () => {} };
const quarantinedCaseIds = computed(() => new Set((quarantineData.value?.entries ?? []).map((e) => e.testCaseId)));

const latestRunId = computed(() => latestRunInfo.value?.id ?? testRun.value?.project?.latestRunId ?? null);
const latestRunStatus = computed(() => latestRunInfo.value?.status ?? testRun.value?.project?.latestRunStatus ?? null);
const isLatestRunActive = computed(() => latestRunStatus.value === 'running' || latestRunStatus.value === 'finalizing');

useHead(
  computed(() => {
    // The tab title names the run and its project (display label first); on
    // the page the breadcrumb carries the project.
    const project = testRun.value?.project?.label || testRun.value?.project?.name;
    return {
      title: `Test run #${runId}${project ? ` — ${project}` : ''} — Piwi Dashboard`,
    };
  }),
);

const { copy } = useCopy();
const isDeleteConfirmOpen = ref(false);
const isKeepOpen = ref(false);
const { release: releaseKeep, canRelease } = useRunKeep();

// Live streaming state
const isLive = computed(() => testRun.value?.status === 'running' || testRun.value?.status === 'finalizing');
const isFinalizing = ref(false);
const liveTestCases = ref<TestCaseResult[]>([]);
const liveTestCaseKeys = new Map<string, true>();
// Worker index → the step the worker is currently on (from transient SSE step
// events; nothing is persisted from them). Rendered inline on the matching
// running rows in the test-case views.
const liveSteps = ref<LiveStepsByWorker>({});
let eventSource: EventSource | null = null;

// Combined test cases: from server data + live stream. Includes every attempt
// (a retried test has one row per attempt) — the timeline and the per-execution
// links need them all.
const displayTestCases = ref<TestCaseResult[]>([]);

/**
 * One entry per test — the final attempt (highest retry count) — so a retried
 * test is a single row whose outcome is its last attempt. Keyed by the
 * persisted test-case id + browser once known, else the streaming key (title +
 * location + browser), so it collapses live placeholder rows and finished
 * attempt rows alike. Feeds the header counts, the count bar and the grouped
 * list; the timeline keeps the full attempt list.
 */
function dedupeFinalAttempts(cases: TestCaseResult[]): TestCaseResult[] {
  const byKey = new Map<string, TestCaseResult>();
  for (const tc of cases) {
    const key = testAttemptKey(tc);
    const prev = byKey.get(key);
    if (!prev || (tc.retries ?? 0) >= (prev.retries ?? 0)) byKey.set(key, tc);
  }
  return [...byKey.values()];
}

const dedupedDisplayCases = computed(() => dedupeFinalAttempts(displayTestCases.value));

watch(
  [isLive, testRun],
  () => {
    if (isLive.value && liveTestCases.value.length > 0) {
      displayTestCases.value = [...liveTestCases.value];
    } else if (testRun.value?.testCases) {
      displayTestCases.value = testRun.value.testCases;
    } else {
      displayTestCases.value = [];
    }
  },
  { immediate: true },
);

// Initialise liveTestCases from persisted data when SSE connects
function seedLiveFromPersisted(cases: TestCaseResult[]) {
  for (const tc of cases) {
    const key = `${tc.title}@@${tc.location}@@${JSON.stringify(tc.browser)}`;
    if (!liveTestCaseKeys.has(key)) {
      liveTestCaseKeys.set(key, true);
      liveTestCases.value = [...liveTestCases.value, tc];
    }
  }
  displayTestCases.value = [...liveTestCases.value];
}

// Debounced batch processing of SSE events to avoid cascading re-renders
let pendingEvents: Record<string, unknown>[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingEvents() {
  if (pendingEvents.length === 0) return;
  const events = pendingEvents;
  pendingEvents = [];
  for (const parsed of events) {
    const data = parsed.data as Record<string, unknown>;
    // 'init' and 'run-progress' carry the server's running counters; the header
    // and bar are derived from the de-duplicated case list instead (see
    // displayProgress), so those snapshots are not applied here.
    if (parsed.type === 'test-begin') {
      const d = data as {
        title: string;
        filePath?: string;
        suitePath?: string[] | null;
        location: string;
        workerIndex?: number;
        startedAt?: number;
        browser?: { projectName?: string } | null;
        stepCategory?: string | null;
      };
      // Hook/fixture step-begin events are published as `test-begin` with a
      // `stepCategory`. They are not test cases — ignore them so they don't
      // create phantom rows (which left orphaned "running" dots on the
      // timeline). Hooks render from `stepEvents` once their test completes.
      if (d.stepCategory) continue;
      const key = `${d.title}@@${d.location}@@${JSON.stringify(d.browser)}`;
      if (!liveTestCaseKeys.has(key)) {
        liveTestCaseKeys.set(key, true);
        liveTestCases.value = [
          ...liveTestCases.value,
          {
            // The persisted execution row only exists once the test completes —
            // a unique negative placeholder keeps the row keyed (and unlinked)
            // until test-completed delivers the real id.
            executionId: -(liveTestCases.value.length + 1),
            testCaseId: 0,
            title: d.title,
            filePath: d.filePath,
            suitePath: d.suitePath ?? undefined,
            status: 'running',
            location: d.location,
            workerIndex: d.workerIndex ?? null,
            startedAt: d.startedAt ?? Date.now(),
            browser: d.browser ?? null,
          },
        ];
        displayTestCases.value = [...liveTestCases.value];
      }
    } else if (parsed.type === 'test-completed') {
      const d = data as {
        title: string;
        filePath?: string;
        suitePath?: string[] | null;
        location: string;
        status: string;
        duration?: number;
        error?: string | null;
        stepEvents?: TestStepEvent[] | null;
        wastedTimeMs?: number | null;
        workerIndex?: number;
        startedAt?: number;
        browser?: { projectName?: string } | null;
        stepCategory?: string | null;
        retries?: number | null;
        executionId?: number | null;
        testCaseId?: number | null;
      };
      // Ignore hook/fixture step-end events (published as `test-completed`
      // with a `stepCategory`) — they are not test cases. The hook segments
      // arrive via the owning test's `stepEvents` below.
      if (d.stepCategory) continue;
      const key = `${d.title}@@${d.location}@@${JSON.stringify(d.browser)}`;
      if (liveTestCaseKeys.has(key)) {
        const idx = liveTestCases.value.findIndex(
          (tc) => `${tc.title}@@${tc.location}@@${JSON.stringify(tc.browser)}` === key,
        );
        if (idx >= 0) {
          const existing = liveTestCases.value[idx]!;
          const copy = [...liveTestCases.value];
          copy[idx] = {
            ...existing,
            filePath: d.filePath ?? existing.filePath,
            suitePath: d.suitePath ?? existing.suitePath,
            status: d.status,
            duration: d.duration,
            error: d.error,
            stepEvents: d.stepEvents ?? existing.stepEvents,
            wastedTimeMs: d.wastedTimeMs ?? existing.wastedTimeMs,
            workerIndex: d.workerIndex ?? existing.workerIndex,
            startedAt: d.startedAt ? d.startedAt : existing.startedAt,
            browser: d.browser ?? existing.browser,
            // A later attempt's higher retry count wins, so a fail-then-pass
            // test ends up as passed-on-retry rather than a plain pass.
            retries: d.retries ?? existing.retries,
            // The real ids replace the placeholder once persistence happens;
            // a duplicate event without ids keeps whatever the row already has.
            executionId: d.executionId ?? existing.executionId,
            testCaseId: d.testCaseId ?? existing.testCaseId,
          };
          liveTestCases.value = copy;
          displayTestCases.value = [...copy];
        }
      } else {
        liveTestCaseKeys.set(key, true);
        liveTestCases.value = [
          ...liveTestCases.value,
          {
            executionId: d.executionId ?? -(liveTestCases.value.length + 1),
            testCaseId: d.testCaseId ?? 0,
            title: d.title,
            filePath: d.filePath,
            suitePath: d.suitePath ?? undefined,
            status: d.status,
            duration: d.duration,
            location: d.location,
            error: d.error,
            stepEvents: d.stepEvents ?? null,
            wastedTimeMs: d.wastedTimeMs ?? null,
            workerIndex: d.workerIndex ?? null,
            startedAt: d.startedAt ?? undefined,
            browser: d.browser ?? null,
            retries: d.retries ?? null,
          },
        ];
        displayTestCases.value = [...liveTestCases.value];
      }
    } else if (parsed.type === 'step-begin') {
      const d = parsed.data as {
        title: string;
        subtitle?: string | null;
        stepCategory?: string | null;
        parentTitle?: string | null;
        workerIndex?: number;
      };
      // Suite-level hooks (no worker) keep flowing to the timeline instead.
      if (d.workerIndex == null) continue;
      liveSteps.value = {
        ...liveSteps.value,
        [d.workerIndex]: {
          title: d.title,
          subtitle: d.subtitle ?? null,
          category: d.stepCategory ?? null,
          status: undefined,
          parentTitle: d.parentTitle ?? null,
        },
      };
    } else if (parsed.type === 'step-end') {
      const d = parsed.data as {
        title: string;
        subtitle?: string | null;
        stepCategory?: string | null;
        parentTitle?: string | null;
        status?: string;
        workerIndex?: number;
      };
      if (d.workerIndex == null) continue;
      // Keep the ended step visible (with its outcome) until the next step
      // begins, so the readout shows "last thing this worker did".
      liveSteps.value = {
        ...liveSteps.value,
        [d.workerIndex]: {
          title: d.title,
          subtitle: d.subtitle ?? null,
          category: d.stepCategory ?? null,
          status: d.status ?? 'passed',
          parentTitle: d.parentTitle ?? null,
        },
      };
    } else if (parsed.type === 'run-finalizing') {
      // Tests are done, reports/traces are uploading — show progress bar
      isFinalizing.value = true;
    } else if (parsed.type === 'run-finished') {
      isFinalizing.value = false;
      liveSteps.value = {};
      disconnectStream();
      refresh();
      // Nudge the Changes tab to refetch — it keeps its own fetch state and
      // would otherwise show stale/partial data from before the run finalized.
      runRefreshKey.value++;
      pollForReports();
    }
  }
}

function pollForReports(attempts = 0): void {
  // The reporter may upload HTML/Monocart reports and traces AFTER the run
  // finishes. Poll for a few iterations so they appear without a manual
  // refresh. We keep polling a fixed number of times regardless of whether
  // some files already arrived, because uploads land in several batches
  // (report directory, then per-case traces/attachments) — stopping at the
  // first file would miss the rest.
  if (isDemoMode) return; // demo mode has no file uploads
  if (attempts >= 5) return;
  setTimeout(
    async () => {
      await refresh();
      pollForReports(attempts + 1);
    },
    1500 * (attempts + 1),
  );
}

function enqueueEvent(event: Record<string, unknown>) {
  pendingEvents.push(event);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPendingEvents, 200);
}

// Demo mode: live events arrive over a BroadcastChannel from the service
// worker instead of an SSE stream (see app/demo/run-events.ts).
let demoUnsubscribe: (() => void) | null = null;

function connectToDemoStream() {
  if (demoUnsubscribe) return;

  // Seed liveTestCases from persisted data so existing cases are visible
  // immediately with correct ids, browser, startedAt, etc.
  if (testRun.value?.testCases?.length) {
    seedLiveFromPersisted(testRun.value.testCases);
  }

  demoUnsubscribe = subscribeDemoEvents((message) => {
    if (message.scope === 'run' && message.runId === Number(runId)) {
      enqueueEvent(message.event as unknown as Record<string, unknown>);
    } else if (
      message.scope === 'global' &&
      message.event.runId === Number(runId) &&
      message.event.type === 'run-started'
    ) {
      // Run transitioned from 'initializing' to 'running' — refetch so
      // isLive flips and progress counters appear.
      refresh();
    }
  });
}

function connectToStream() {
  if (!import.meta.client) return;

  if (isDemoMode) {
    connectToDemoStream();
    return;
  }

  if (eventSource) return;
  if (!isLive.value) return;

  // Seed liveTestCases from persisted data so existing cases are visible
  // immediately with correct ids, browser, startedAt, etc.
  if (testRun.value?.testCases?.length) {
    seedLiveFromPersisted(testRun.value.testCases);
  }

  eventSource = new EventSource(`/api/test-runs/${runId}/stream`);

  eventSource.onmessage = (event) => {
    try {
      enqueueEvent(JSON.parse(event.data) as Record<string, unknown>);
    } catch {
      // Ignore parse errors
    }
  };

  eventSource.onerror = () => {
    // EventSource will auto-reconnect
  };
}

function disconnectStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (demoUnsubscribe) {
    demoUnsubscribe();
    demoUnsubscribe = null;
  }
}

// In demo mode also stream while 'initializing' so the page picks up the
// transition to 'running' pushed by the simulator.
const shouldStream = computed(() => isLive.value || (isDemoMode && testRun.value?.status === 'initializing'));

watch(
  shouldStream,
  (live) => {
    if (live) {
      connectToStream();
    } else {
      disconnectStream();
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  disconnectStream();
});

// Throttled version for child components that don't need frame-perfect reactivity
let rafId: number | null = null;
const throttledTestCases = ref<TestCaseResult[]>([]);

watch(
  displayTestCases,
  (val) => {
    if (!import.meta.client) {
      throttledTestCases.value = val;
      return;
    }
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      throttledTestCases.value = val;
      rafId = null;
    });
  },
  { immediate: true },
);

// Display progress: the header counts, the count bar and the grouped list are
// all derived from the same de-duplicated case list (one row per test, its
// final attempt), so they cannot disagree — clicking a bar segment always lands
// on exactly that many rows. A flaky test passed on a retry, so it counts as
// passed and as flaky, never as a failure via its earlier failed attempt. While
// live the planned suite size the reporter reports at /start is the denominator
// (right from the first render); once finished the persisted case list is
// complete. The stored run columns are only a fallback for a run whose cases are
// not loaded.
const displayProgress = computed(() => {
  if (!testRun.value) return null;
  const cases = dedupedDisplayCases.value;
  if (isLive.value || cases.length > 0) {
    const s = summarizeRunCases(cases);
    return {
      totalTests: Math.max(testRun.value.totalTests ?? 0, s.total),
      passedTests: s.passed,
      failedTests: s.failed,
      skippedTests: s.skipped,
      fixmeTests: s.fixme,
      didNotRunTests: s.didNotRun,
      flakyTests: s.flaky,
    };
  }
  return {
    totalTests: testRun.value.totalTests,
    passedTests: testRun.value.passedTests,
    failedTests: testRun.value.failedTests,
    skippedTests: testRun.value.skippedTests,
    fixmeTests: 0,
    didNotRunTests: testRun.value.didNotRunTests ?? 0,
    flakyTests: testRun.value.flakyTests ?? 0,
  };
});

const runToDelete = computed(() => [{ id: Number(runId), keptAt: testRun.value?.keptAt ?? null }]);

// A plain-text run summary for the navbar's Copy run summary action.
function buildRunSummary(): string {
  const run = testRun.value;
  if (!run) return '';
  const statusEmoji =
    run.status === 'passed' ? '✅' : run.status === 'failed' ? '❌' : run.status === 'running' ? '🔄' : '⚠️';
  const label = run.label ? ` — ${run.label}` : '';
  const project = run.project?.label ?? run.project?.name ?? '';
  // Count from the same source as the header so the copied summary matches what
  // is on screen; fall back to the stored columns when the cases aren't loaded.
  const p = displayProgress.value;
  const total = p?.totalTests ?? run.totalTests ?? 0;
  const passed = p?.passedTests ?? run.passedTests ?? 0;
  const failed = p?.failedTests ?? run.failedTests ?? 0;
  const skipped = p?.skippedTests ?? run.skippedTests ?? 0;
  const fixme = p?.fixmeTests ?? 0;
  const flaky = p?.flakyTests ?? run.flakyTests ?? 0;
  const didNotRun = p?.didNotRunTests ?? run.didNotRunTests ?? 0;
  const flakyPart = flaky > 0 ? ` · ${flaky} passed on retry` : '';
  const didNotRunPart = didNotRun > 0 ? ` · ${didNotRun} didn't run` : '';
  const fixmePart = fixme > 0 ? ` (${fixme} fixme)` : '';
  return [
    `*Run #${run.id}*${label}`,
    `Status: ${statusEmoji} ${run.status} | Project: ${project}`,
    `Tests: ${total} total · ${passed} passed · ${failed} failed · ${skipped} skipped${fixmePart}${didNotRunPart}${flakyPart}`,
    `Duration: ${formatDuration(run.duration)}`,
  ].join('\n');
}

// Test-cases filter state — lifted here so it survives tab switches
const testCaseSearch = ref('');
const testCaseActiveStatuses = ref<string[]>([]);

// The count-bar segments toggle into the same set the Tests list chips use, and
// switch to the Tests tab so the filtered rows are on screen.
function handleFilterStatus(status: string) {
  if (!status || status === 'all') {
    testCaseActiveStatuses.value = [];
  } else {
    testCaseActiveStatuses.value = testCaseActiveStatuses.value.includes(status)
      ? testCaseActiveStatuses.value.filter((s) => s !== status)
      : [...testCaseActiveStatuses.value, status];
  }
  activeTab.value = 'test-cases';
}

// Reports from the files table
const allReports = computed<ReportInfo[]>(() => testRun.value?.reports || []);

// Total wasted time across all displayed test cases (live or persisted)
const totalWastedTime = computed(() => {
  const cases = displayTestCases.value;
  if (!cases) return 0;
  return cases.reduce((sum, tc) => sum + (tc.wastedTimeMs ?? 0), 0);
});

const activeTab = ref('test-cases');

const hasFailures = computed(() => (displayProgress.value?.failedTests ?? 0) > 0);

// A run whose only problem is flakiness has no failures — the change tabs still
// have content, so they stay enabled whenever there are failures OR flaky tests.
const showFailureTabs = computed(() => hasFailures.value || (testRun.value?.flakyTests ?? 0) > 0);

// Cluster names + triage status for the row chips and the cluster group headers,
// taken from the same failure-groups payload. Fetched whenever the failure tabs
// become available: a flaky-only run has no failedTests yet still has clusters,
// and a live run can gain its first failure mid-stream.
const clusterMeta = ref<RunClusterMeta>({});

async function fetchClusterMeta() {
  if (!import.meta.client) return;
  try {
    const r = await $fetch<{ items: FailureGroup[] }>(`/api/test-runs/${runId}/failure-groups`);
    clusterMeta.value = Object.fromEntries(
      r.items.map((g) => [
        g.clusterId,
        { name: g.title || `Cluster #${g.clusterId}`, status: g.status ?? null, issue: g.knownIssue ?? null },
      ]),
    );
  } catch {
    // chips fall back to plain cluster ids, headers to no triage badge
  }
}

watch(
  showFailureTabs,
  (show) => {
    if (show) fetchClusterMeta();
  },
  { immediate: true },
);

// Increments when a live run finishes, so child tabs that keep their own
// fetch state can refetch instead of showing stale pre-finish data.
const runRefreshKey = ref(0);

// A finishing run can grow its failure-groups payload (new clusters); refetch
// the display names so newly-appearing chips are labelled.
watch(runRefreshKey, () => {
  if (showFailureTabs.value) fetchClusterMeta();
});

const uniqueWorkerCount = computed(() => {
  const cases = isLive.value ? displayTestCases.value : testRun.value?.testCases;
  if (!cases || cases.length === 0) return 0;
  const workers = new Set<number>();
  for (const tc of cases) {
    if (tc.workerIndex != null && tc.workerIndex >= 0) workers.add(tc.workerIndex);
  }
  return workers.size;
});

const tabItems = computed(() => [
  {
    label: `Tests (${dedupedDisplayCases.value.length})`,
    icon: 'i-lucide-beaker',
    value: 'test-cases',
    slot: 'test-cases',
  },
  {
    label: 'Changes',
    icon: 'i-lucide-git-compare-arrows',
    value: 'changes',
    slot: 'changes',
    disabled: isLive.value,
    disabledReason: isLive.value ? 'available once the run finishes' : undefined,
  },
  {
    label: `Timeline${uniqueWorkerCount.value > 0 ? ` (${uniqueWorkerCount.value})` : ''}`,
    icon: 'i-lucide-timeline',
    value: 'workers',
    slot: 'workers',
  },
  ...(testRun.value?.hasResources
    ? [{ label: 'Resources', icon: 'i-lucide-cpu', value: 'resources', slot: 'resources' }]
    : []),
]);

const tabPanelClass: Record<string, string> = {
  'test-cases': 'overflow-hidden flex flex-col',
};

// The former Failure clusters tab is now the Tests tab's cluster grouping;
// `?tab=failure-groups` lands there. The grouping cookie is written client-side
// so the list opens grouped by cluster.
if (route.query.tab === 'failure-groups') {
  activeTab.value = 'test-cases';
  if (import.meta.client) {
    document.cookie = 'piwi-group-by-run-tests=cluster; path=/; max-age=31536000; sameSite=lax';
    onMounted(() => {
      const query = { ...route.query };
      delete query.cluster;
      query.tab = 'test-cases';
      router.replace({ query });
    });
  }
}

// Deep-links naming the insights, regression or compare tab open the Changes
// tab, and endpoints opens the Tests tab (slow endpoints are on the project
// page), so shared URLs land somewhere sensible.
const LEGACY_TAB_REDIRECTS: Record<string, string> = {
  insights: 'changes',
  regression: 'changes',
  compare: 'changes',
  endpoints: 'test-cases',
};
if (typeof route.query.tab === 'string' && LEGACY_TAB_REDIRECTS[route.query.tab]) {
  const target = LEGACY_TAB_REDIRECTS[route.query.tab]!;
  activeTab.value = target;
  if (import.meta.client) {
    onMounted(() => {
      router.replace({ query: { ...route.query, tab: target } });
    });
  }
}

// Deep-link the active tab via ?tab= so run views can be shared and cross-page
// links land on the right tab. The Changes tab is disabled while a run is live,
// so validate against the currently *enabled* tabs.
const runTabValues = computed(() => tabItems.value.filter((t) => !t.disabled).map((t) => t.value));
if (typeof route.query.tab === 'string' && runTabValues.value.includes(route.query.tab)) {
  activeTab.value = route.query.tab;
}
watch(runTabValues, (vals) => {
  if (!vals.includes(activeTab.value)) activeTab.value = 'test-cases';
});
watch(activeTab, (tab) => {
  const query = { ...route.query };
  delete query.cluster;
  query.tab = tab;
  if (JSON.stringify(query) === JSON.stringify({ ...route.query })) return;
  router.replace({ query });
});

// Ref for TestCasesList to call scrollToCase
const testCasesListRef: {
  value: { scrollToCase: (id: number) => void } | null;
} = ref(null);

function handleSelectTestCase(id: number) {
  activeTab.value = 'test-cases';
  // The timeline lists every attempt, but the Tests list shows one row per test
  // (its final attempt), so redirect a non-final attempt's id to its test's row.
  const source = displayTestCases.value.find((tc) => tc.executionId === id);
  const rowId =
    source && source.testCaseId > 0
      ? (dedupedDisplayCases.value.find(
          (tc) =>
            tc.testCaseId === source.testCaseId &&
            (tc.browser?.projectName ?? '') === (source.browser?.projectName ?? ''),
        )?.executionId ?? id)
      : id;
  nextTick(() => {
    testCasesListRef.value?.scrollToCase(rowId);
  });
}

// ── Navbar More menu ────────────────────────────────────────────────────────
const moreMenuItems = computed(() => {
  const items: { label: string; icon: string; color?: 'error'; disabled?: boolean; onSelect: () => void }[] = [];
  items.push({
    label: 'Copy run summary',
    icon: 'i-lucide-clipboard',
    onSelect: () => copy(buildRunSummary(), { toast: 'Run summary copied' }),
  });
  items.push({ label: 'Refresh', icon: 'i-lucide-refresh-cw', onSelect: () => refresh() });
  const kept = !!testRun.value?.keptAt;
  if (!kept) {
    items.push({ label: 'Keep forever…', icon: 'i-lucide-lock', onSelect: () => (isKeepOpen.value = true) });
  } else if (canRelease(testRun.value?.projectId)) {
    items.push({
      label: 'Release keep',
      icon: 'i-lucide-lock-open',
      onSelect: async () => {
        if (await releaseKeep(Number(runId))) refresh();
      },
    });
  }
  if (can('run:delete', testRun.value?.projectId)) {
    // A kept run cannot be deleted until it is released.
    items.push({
      label: kept ? 'Delete run (release it first)' : 'Delete run',
      icon: 'i-lucide-trash-2',
      color: 'error',
      disabled: kept,
      onSelect: () => (isDeleteConfirmOpen.value = true),
    });
  }
  return items;
});
</script>

<template>
  <UDashboardPanel id="test-run-detail">
    <template #header>
      <!-- The breadcrumb's current crumb is the page title; a navbar title would repeat it. -->
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav
            :items="[
              { label: 'Home', icon: 'i-lucide-house', to: '/' },
              { label: 'Projects', to: '/projects' },
              ...(testRun?.project?.id
                ? [
                    {
                      label: testRun.project.label || testRun.project.name || 'Project',
                      to: `/projects/${testRun.project.id}`,
                      slot: 'project',
                    },
                  ]
                : [{ label: 'Project' }]),
              { label: `Run #${runId}` + (testRun?.label ? ` — ${testRun.label}` : '') },
            ]"
          >
            <template #project="{ item }">
              <NuxtLink
                :to="item?.to"
                class="text-sm font-medium text-[var(--ui-text-muted)] hover:text-[var(--ui-text)] transition-colors"
              >
                {{ item?.label }}
              </NuxtLink>
              <RunFreshnessPill
                class="ml-1"
                :latest-run-id="latestRunId"
                :current-run-id="Number(runId)"
                :is-active="isLatestRunActive"
              />
            </template>
          </BreadcrumbNav>
        </template>
        <template #right>
          <div class="flex items-center shrink-0 min-w-0">
            <ExportMenu
              :perfetto-endpoint="`/api/test-runs/${runId}/perfetto`"
              :base-name="`piwi-run-${runId}`"
              class="mr-1"
            />
            <UDropdownMenu :items="moreMenuItems">
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
      <DetailPageLayout v-model="activeTab" :tab-items="tabItems" :tab-panel-class="tabPanelClass">
        <template #summary>
          <RunHeader
            v-if="testRun"
            :test-run="testRun"
            :display-progress="displayProgress"
            :all-reports="allReports"
            :finalizing="isFinalizing"
            :active-statuses="testCaseActiveStatuses"
            :total-wasted-time="totalWastedTime"
            @toggle-status="handleFilterStatus"
            @label-updated="refresh"
          />
        </template>

        <template #tab-test-cases>
          <TestCasesList
            ref="testCasesListRef"
            data-shot="failure-clusters"
            v-model:search="testCaseSearch"
            v-model:active-statuses="testCaseActiveStatuses"
            :test-cases="dedupedDisplayCases"
            :is-live="isLive"
            :total="displayProgress?.totalTests"
            :live-steps="liveSteps"
            :cluster-meta="clusterMeta"
            :quarantined-case-ids="quarantinedCaseIds"
            :project-key="testRun?.projectId"
            :project-name="testRun?.project?.name"
            class="flex-1 min-h-0"
            @quarantine-changed="refreshQuarantine"
          />
        </template>

        <template #tab-changes>
          <ChangesView
            :test-run="testRun"
            :test-cases="displayTestCases"
            :cluster-meta="clusterMeta"
            :project-key="testRun?.projectId"
            :project-name="testRun?.project?.name"
            :refresh-key="runRefreshKey"
          />
        </template>

        <template #tab-workers>
          <div class="space-y-6 p-1">
            <WorkersTimeline
              :test-cases="isLive ? throttledTestCases : displayTestCases"
              :setup-steps="testRun?.setupSteps ?? null"
              :shard-total="testRun?.shardTotal ?? null"
              :live="isLive"
              :wasted-patterns="testRun?.wastedWaitPatterns ?? null"
              :run-id="Number(runId)"
              :has-resources="testRun?.hasResources ?? false"
              @select-test-case="handleSelectTestCase"
            />
            <RunTimelineExtras
              v-if="!isLive"
              :test-cases="displayTestCases"
              :cluster-meta="clusterMeta"
              :project-key="testRun?.projectId"
              :project-name="testRun?.project?.name"
            />
          </div>
        </template>

        <template #tab-resources>
          <RunResources
            :run-id="Number(runId)"
            :project-key="testRun?.projectId"
            :project-name="testRun?.project?.name"
            :refresh-key="runRefreshKey"
            @open-timeline="activeTab = 'workers'"
          />
        </template>
      </DetailPageLayout>
    </template>
  </UDashboardPanel>

  <ClientOnly>
    <RunKeepModal v-model:open="isKeepOpen" :run-id="Number(runId)" @kept="refresh" />
  </ClientOnly>

  <ClientOnly>
    <RunsDeleteModal
      v-model:open="isDeleteConfirmOpen"
      :runs="runToDelete"
      @deleted="navigateTo(`/projects/${testRun?.project?.id}`)"
    />
  </ClientOnly>
</template>
