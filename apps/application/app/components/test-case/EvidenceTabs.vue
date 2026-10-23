<script setup lang="ts">
/**
 * One evidence card with content-level tabs — Timeline, Screen, Source,
 * Locators, Network, Console, State, Performance — each wrapping the evidence captured for
 * an execution. A tab that lists items shows their count as plain text, an
 * empty tab is dimmed and still opens to state why it is empty, and the open
 * tab is marked in neutral tones: the primary color belongs to the page's
 * primary action. A pass that needed a retry opens on Attempts; otherwise the
 * default tab is the one the strongest clue cites, else Timeline when it can
 * place two or more items, else Screen. The Screen tab is one strip of views of
 * the page at the failure (`FailingStepSnapshot`), over the execution's files.
 * The Source tab adds what the test ran (`ExecutionCoverageSection`) where the
 * project's coverage capability is active. The tabs holding what the Most
 * likely line cites carry a mark, and so do its rows on the Timeline. A clue or
 * diagnosis citation switches to the tab (and the Screen view) that holds the
 * evidence and scrolls the card so its tab strip stays in view; a citation of
 * one request or console entry rings that row for a moment. A link opens
 * another tab with `?evidence=<tab>`. The Playwright trace opens from the
 * card's header, whichever tab is showing. A test that never ran and left
 * nothing behind shows no card at all.
 */
import type { AttachmentInfo, NetworkRequest, PerformanceStep, TraceInfo, WebVitals } from '~~/types/api';
import type { WireExecutionResources } from '#shared/types';
import { isVideoFile } from '~/utils/text-format';
import { getPerformanceHints } from '~/utils/performance-hints';
import { resolveEvidenceState, type EvidenceState } from '#shared/evidence-state';
import type { CapabilityState } from '#shared/capabilities';
import type { HelpTopicKey } from '~/utils/help-content';
import { EVIDENCE_SECTION_TAB, type EvidenceTabValue } from '~/utils/evidence-sections';
import type { TimelineCitation } from '~/utils/timeline-rows';
import { extractStepLocatorUses } from '#shared/locator-chain';
import type { LightboxSubject } from '~/utils/lightbox';
import type { SuspectLinesAnswer } from '#shared/suspect-lines';

const props = defineProps<{
  /** The fetched execution — every tab reads its evidence off this object. */
  testCase: any;
  /** Traces for this execution (fetched at page level). */
  traces: TraceInfo[];
  hasTrace: boolean;
  /**
   * The story's leading clue and its strength — picks the default tab. The
   * section is the citation of the story's first member clue (or the top clue
   * when no story matched); the strength is the story's (or the top clue's). A
   * strong or medium hint opens its tab; a weak one never picks. `cited` is what
   * the Most likely line cites: its tabs and Timeline rows are marked.
   */
  defaultHint?: {
    section: string | null;
    strength: 'strong' | 'medium' | 'weak' | null;
    cited?: TimelineCitation[];
  };
  /** Inline-help topic for the card header. */
  help?: HelpTopicKey;
  /**
   * The page's contextual nudge already offers the fixtures decision under the
   * headline, so the footer sentence stays off to avoid saying it twice.
   */
  suppressFixturesFooter?: boolean;
  /** The project's resolved fixtures state, from the page's capability composable. */
  fixturesState?: CapabilityState;
  /** Whether the viewer may write the footer's decline decisions. */
  canDecideFixtures?: boolean;
  /**
   * The project's resolved coverage state: the Source tab lists what the test
   * ran only when it is active, and says nothing of coverage otherwise.
   */
  coverageState?: CapabilityState;
  /** The execution's suspect lines, fetched by the page: they mark the covered files they name. */
  suspectLines?: SuspectLinesAnswer | null;
  /** Where a covered file's suspect mark leads: the cluster's What changed card. */
  whatChangedTo?: string | null;
}>();

// The footer's decline controls are the page's to write (it owns the capability
// composable); the strip and the fixture-backed tabs read the resolved state.
const emit = defineEmits<{ 'decline-fixtures': [level: 'project' | 'instance'] }>();

type TabValue = EvidenceTabValue;

const config = useRuntimeConfig();
const runId = computed<number | null>(() => props.testCase?.testRun?.id ?? null);
const projectKey = computed(() => props.testCase?.testRun?.project?.id ?? undefined);

const fixturesState = computed<CapabilityState>(() => props.fixturesState ?? 'undecided');
const canDecide = computed(() => props.canDecideFixtures ?? false);
const projectName = computed(() => props.testCase?.testRun?.project?.name ?? undefined);
const testRunsCaseId = computed<number>(() => Number(props.testCase?.id ?? props.testCase?.executionId ?? 0));
const status = computed<string | null>(() => props.testCase?.status ?? null);
const hasError = computed(() => Boolean(props.testCase?.error));
// The test an enlarged screenshot belongs to, named in the lightbox's details.
const imageSubject = computed<LightboxSubject>(() => ({
  title: props.testCase?.title ?? null,
  location: props.testCase?.location ?? null,
  projectKey: projectKey.value ?? null,
  projectName: projectName.value ?? null,
}));

const steps = computed<PerformanceStep[]>(() => (props.testCase?.steps as PerformanceStep[]) ?? []);
const webVitals = computed<WebVitals | null>(() => (props.testCase?.webVitals as unknown as WebVitals | null) ?? null);
const performanceHints = computed(() => (props.testCase ? getPerformanceHints(props.testCase) : []));
const networkRequests = computed<NetworkRequest[]>(
  () => (props.testCase?.networkRequests as unknown as NetworkRequest[] | null) ?? [],
);
const consoleLogs = computed<{ type: string; text: string; timestamp?: number; location?: string | null }[]>(
  () => props.testCase?.consoleLogs ?? [],
);
const ariaSnapshot = computed<string | null>(() => props.testCase?.ariaSnapshot ?? null);
const pageState = computed(() => props.testCase?.pageState ?? null);
const attachments = computed(() => props.testCase?.attachments ?? []);
const testSourceFrames = computed(() => props.testCase?.testSourceFrames ?? null);
const testSource = computed<string | null>(() => props.testCase?.testSource ?? null);

// ── Three-state evidence (never captured / nothing happened / not applicable) ──
const evidenceSources = computed(
  () => (props.testCase?.evidenceSources as { console?: 'trace'; network?: 'trace'; aria?: 'trace' } | null) ?? null,
);
const fixturesActive = computed(() => {
  const tc = props.testCase;
  if (!tc) return false;
  const src = evidenceSources.value ?? {};
  return (
    (consoleLogs.value.length > 0 && src.console !== 'trace') ||
    (networkRequests.value.length > 0 && src.network !== 'trace') ||
    (Boolean(ariaSnapshot.value) && src.aria !== 'trace') ||
    Boolean(pageState.value) ||
    Boolean(webVitals.value) ||
    Boolean(tc.aiUsage)
  );
});
const mk = (hasData: boolean, traced?: boolean) => ({
  hasData,
  source: traced ? ('trace' as const) : ('fixture' as const),
  fixturesActive: fixturesActive.value,
  // The fixture-backed cards read the project's fixtures decision so a declined
  // project names the decision rather than offering to switch it on.
  capability: fixturesState.value,
});
const consoleState = computed(() =>
  resolveEvidenceState('console', mk(consoleLogs.value.length > 0, evidenceSources.value?.console === 'trace')),
);
const networkState = computed(() =>
  resolveEvidenceState(
    'network',
    mk(networkRequests.value.length > 0 || props.hasTrace, evidenceSources.value?.network === 'trace'),
  ),
);
const appStateState = computed(() => resolveEvidenceState('appState', mk(Boolean(pageState.value))));
const ariaState = computed(() =>
  resolveEvidenceState('ariaSnapshot', mk(Boolean(ariaSnapshot.value), evidenceSources.value?.aria === 'trace')),
);
const webVitalsState = computed(() => resolveEvidenceState('webVitals', mk(Boolean(webVitals.value))));

const derived = (st: EvidenceState) => st.state === 'present' && st.derivedFromTrace;
const consoleDerived = computed(() => derived(consoleState.value));
const networkDerived = computed(() => derived(networkState.value));
const ariaDerived = computed(() => derived(ariaState.value));

// ── Tabs ──────────────────────────────────────────────────────────────────
// The data indicators read only from the already-fetched execution, never from
// a child card's later "available" signal — a cross-component write during the
// first render would tear the server and client tab strips apart.
const screenHasData = computed(
  () => attachments.value.length > 0 || props.traces.length > 0 || props.hasTrace || Boolean(ariaSnapshot.value),
);
const sourceHasData = computed(() => Boolean(testSourceFrames.value?.length || testSource.value || props.hasTrace));
const stateHasData = computed(() => Boolean(pageState.value));
const resources = computed<WireExecutionResources | null>(() => props.testCase?.resources ?? null);
const performanceHasData = computed(
  () => Boolean(webVitals.value) || performanceHints.value.length > 0 || Boolean(resources.value),
);
const timelineHasData = computed(() => steps.value.length > 0);
// Distinct locator uses in the stored steps — the same count the Locators tab lists.
const locatorCount = computed(
  () =>
    new Set(extractStepLocatorUses(steps.value).map((u) => `${u.location ?? ''}\x00${u.action}\x00${u.locator}`)).size,
);

// Every attempt of this execution (each retry is its own row), already fetched.
const attemptsList = computed<
  Array<{ retry: number; status: string; duration: number | null; executionId: number | null }>
>(() => props.testCase?.attempts ?? []);
const hasMultipleAttempts = computed(() => attemptsList.value.length > 1);

interface TabDef {
  value: TabValue;
  label: string;
  icon: string;
  hasData: boolean;
  count: number | null;
}

// A fixture-backed tab shows only when its evidence is present or the fixtures
// ran and simply found nothing. A never-captured, declined or not-applicable
// state removes the tab from the strip rather than dimming it — data always wins
// in the resolver, so the tab returns on its own once evidence arrives.
const FIXTURE_TAB_STATE: Partial<Record<TabValue, ComputedRef<EvidenceState>>> = {
  network: networkState,
  console: consoleState,
  state: appStateState,
  performance: webVitalsState,
};
function tabShown(value: TabValue): boolean {
  const st = FIXTURE_TAB_STATE[value];
  if (!st) return true;
  return st.value.state === 'present' || st.value.state === 'nothing-happened';
}

const tabs = computed<TabDef[]>(() =>
  (
    [
      { value: 'timeline', label: 'Timeline', icon: 'i-lucide-activity', hasData: timelineHasData.value, count: null },
      {
        value: 'attempts',
        label: 'Attempts',
        icon: 'i-lucide-repeat',
        hasData: hasMultipleAttempts.value,
        count: hasMultipleAttempts.value ? attemptsList.value.length : null,
      },
      { value: 'screen', label: 'Screen', icon: 'i-lucide-camera', hasData: screenHasData.value, count: null },
      { value: 'source', label: 'Source', icon: 'i-lucide-file-code-2', hasData: sourceHasData.value, count: null },
      {
        value: 'locators',
        label: 'Locators',
        icon: 'i-lucide-crosshair',
        hasData: locatorCount.value > 0,
        count: locatorCount.value || null,
      },
      {
        value: 'network',
        label: 'Network',
        icon: 'i-lucide-arrow-left-right',
        hasData: networkRequests.value.length > 0 || props.hasTrace,
        count: networkRequests.value.length || null,
      },
      {
        value: 'console',
        label: 'Console',
        icon: 'i-lucide-terminal',
        hasData: consoleLogs.value.length > 0,
        count: consoleLogs.value.length || null,
      },
      { value: 'state', label: 'State', icon: 'i-lucide-database', hasData: stateHasData.value, count: null },
      {
        value: 'performance',
        label: 'Performance',
        icon: 'i-lucide-gauge',
        hasData: performanceHasData.value,
        count: null,
      },
    ] satisfies TabDef[]
  ).filter(
    (tab) =>
      tabShown(tab.value) &&
      // Locators and Attempts only exist when there is something to list: a
      // single attempt has nothing to compare.
      ((tab.value !== 'locators' && tab.value !== 'attempts') || tab.hasData),
  ),
);

// The tabs that hold what the Most likely line cites.
const cited = computed<TimelineCitation[]>(() => props.defaultHint?.cited ?? []);
const citedTabs = computed(
  () => new Set(cited.value.map((cite) => EVIDENCE_SECTION_TAB[cite.section]).filter((tab) => tab != null)),
);

// The trace the header opens: this execution's own (one per attempt row).
const primaryTrace = computed(() => props.traces[0] ?? null);
const {
  viewUrl: traceViewUrl,
  viewUnavailable: traceViewUnavailable,
  onView: onViewTrace,
} = useTraceLinks(primaryTrace);

// Nothing was captured for a test that never started — the Most likely line above
// says why, so the evidence card stays away rather than showing empty tabs.
const hasNoEvidence = computed(
  () => status.value === 'didnotrun' && !primaryTrace.value && tabs.value.every((tab) => !tab.hasData),
);

// The footer names the sources the capture fixtures would add, shown only while
// the project has not decided on them. A declined project drops it entirely (the
// tabs are already gone), and the page's nudge suppresses it when it offers the
// same decision under the headline.
const showFixturesFooter = computed(() => !props.suppressFixturesFooter && fixturesState.value === 'undecided');

function computeDefault(): TabValue {
  // A pass that needed a retry leads with what differed between its attempts.
  const retries = Number(props.testCase?.retries ?? 0);
  if (status.value === 'passed' && retries > 0 && hasMultipleAttempts.value) return 'attempts';
  // A passing execution has no failure to lead with — open on the Timeline.
  if (!hasError.value) return 'timeline';

  // The Timeline is the best "what happened" view when it can place two or more
  // of the items a story chains — steps, network requests, console entries — so
  // a story that plays out over time (a blocked element waiting on a request the
  // console warned about) opens there, where all three read against one clock,
  // rather than on the single tab its leading clue happens to cite.
  const placeable = steps.value.length + networkRequests.value.length + consoleLogs.value.length >= 2;

  // The story's tab — only when the hint is strong or medium (a weak hint never
  // picks) and the tab is not State (State is never a default). A hint whose
  // evidence lives on the timeline (network / console / a moment on screen)
  // defers to a rich Timeline; only an off-timeline focus (the test source, the
  // performance panel) pre-empts it.
  const hint = props.defaultHint;
  if (hint?.section && (hint.strength === 'strong' || hint.strength === 'medium')) {
    const cited = EVIDENCE_SECTION_TAB[hint.section];
    if (cited && cited !== 'state') {
      const offTimeline = cited === 'source' || cited === 'performance';
      if (offTimeline || !placeable) return cited;
    }
  }

  if (placeable) return 'timeline';
  // Else Screen when a screenshot or video exists; else Source.
  if (screenHasData.value) return 'screen';
  return 'source';
}

// A link may name the tab to open (`?evidence=source`); one the strip does not show is ignored.
const route = useRoute();
const requestedTab = computed(() => {
  const asked = route.query.evidence;
  return tabs.value.find((tab) => tab.value === asked)?.value ?? null;
});
const activeTab = ref<TabValue>(requestedTab.value ?? computeDefault());

// A fixture-backed default can be filtered out (the clue cited a source the
// project never captured); fall back to the first tab that is actually shown.
watch(tabs, (list) => {
  if (!list.some((tab) => tab.value === activeTab.value)) {
    activeTab.value = list[0]?.value ?? 'timeline';
  }
});

// The failure timeline, held here for the Timeline and Network tabs so a tab
// switch never fetches it again: the Network tab colors each request against
// the usual duration it carries, by the request's index.
const { data: timeline } = useExecutionTimeline(
  testRunsCaseId,
  () => hasError.value && (activeTab.value === 'timeline' || activeTab.value === 'network'),
);
const usualByRequest = computed(
  () =>
    new Map(
      hasError.value
        ? (timeline.value?.lanes.network ?? []).flatMap((item) =>
            item.usual != null ? [[item.ref.index, item.usual] as const] : [],
          )
        : [],
    ),
);

// The Screen tab is one strip of views of the page at the failure: the page's
// own (Screenshot, DOM, Accessibility tree), then the visual diff and the page
// diff once their cards report a diff, then the video when one was recorded.
// Null opens it on the first view with content.
const screenView = ref<string | null>(null);
const visualDiffAvailable = ref(false);
const pageDiffAvailable = ref(false);
const traceDiffAvailable = ref(false);
const videos = computed(() =>
  (attachments.value as AttachmentInfo[])
    .filter((att) => isVideoFile(att.path, att.contentType))
    .map((att) => ({
      src: fileApiUrl(att.path, att.contentType, config.app?.baseURL),
      name: att.name || att.path.split('/').pop() || att.path,
    })),
);
const screenExtraViews = computed(() => [
  { value: 'visual-diff', label: 'Visual diff', shown: visualDiffAvailable.value },
  { value: 'page-diff', label: 'Page diff', shown: pageDiffAvailable.value || traceDiffAvailable.value },
  { value: 'video', label: 'Video', shown: videos.value.length > 0 },
]);

// ── Section locator: switch to the tab holding a cited section, then scroll ──
const timelineWrap = ref<HTMLElement | null>(null);
const sourceWrap = ref<HTMLElement | null>(null);
const networkWrap = ref<HTMLElement | null>(null);
const consoleWrap = ref<HTMLElement | null>(null);
const pageStateWrap = ref<HTMLElement | null>(null);
const envDiffWrap = ref<HTMLElement | null>(null);
const screenViewsWrap = ref<HTMLElement | null>(null);
const screenFilesWrap = ref<HTMLElement | null>(null);
const performanceWrap = ref<HTMLElement | null>(null);
const WRAP_REF: Record<string, Ref<HTMLElement | null>> = {
  timeline: timelineWrap,
  source: sourceWrap,
  network: networkWrap,
  console: consoleWrap,
  pageState: pageStateWrap,
  envDiff: envDiffWrap,
  screenViews: screenViewsWrap,
  screenFiles: screenFilesWrap,
  performance: performanceWrap,
};
const SECTION_WRAP: Record<string, keyof typeof WRAP_REF> = {
  steps: 'timeline',
  failingSteps: 'timeline',
  testSource: 'source',
  sourceFiles: 'source',
  traceCallStack: 'source',
  networkRequests: 'network',
  serverTraces: 'network',
  serverLogs: 'network',
  backendLogs: 'network',
  traceNetwork: 'network',
  console: 'console',
  appState: 'pageState',
  environmentDiff: 'envDiff',
  visualDiff: 'screenViews',
  pageDiff: 'screenViews',
  domSnapshot: 'screenViews',
  ariaSnapshot: 'screenViews',
  screenshots: 'screenViews',
  tracePointers: 'screenFiles',
  artifacts: 'screenFiles',
  webVitals: 'performance',
};
// The Screen tab's view each cited section shows.
const SECTION_SCREEN_VIEW: Record<string, string> = {
  screenshots: 'screenshot',
  domSnapshot: 'dom',
  ariaSnapshot: 'aria',
  visualDiff: 'visual-diff',
  pageDiff: 'page-diff',
};

const networkComp = ref<{ showTraceMode?: () => void } | null>(null);
const tabStrip = ref<HTMLElement | null>(null);

// A citation of one entry of a list rings that entry's row in its tab for a
// moment: a request (its backend logs cite the request too) or a console entry.
const ROW_SECTION_TAB: Record<string, 'network' | 'console'> = {
  networkRequests: 'network',
  serverLogs: 'network',
  backendLogs: 'network',
  console: 'console',
};
const citedRow = ref<{ tab: 'network' | 'console'; index: number } | null>(null);
let citedRowTimer: ReturnType<typeof setTimeout> | null = null;
function ringRow(row: { tab: 'network' | 'console'; index: number } | null) {
  if (citedRowTimer) clearTimeout(citedRowTimer);
  citedRowTimer = null;
  citedRow.value = row;
  if (row) citedRowTimer = setTimeout(() => (citedRow.value = null), CITED_ROW_MS);
}
onBeforeUnmount(() => {
  if (citedRowTimer) clearTimeout(citedRowTimer);
});
const networkRowIndex = computed(() => (citedRow.value?.tab === 'network' ? citedRow.value.index : null));
const consoleRowIndex = computed(() => (citedRow.value?.tab === 'console' ? citedRow.value.index : null));

const REVEAL_MARGIN = 16;

/** The nearest ancestor that scrolls vertically, else the document's scroller. */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/**
 * Scroll the page so the tab strip sits at the top of the view with the cited
 * row under it; a row too far down for both wins, and the strip scrolls out. A
 * list that scrolls on its own (the network and console lists) first brings
 * the row into its middle.
 */
function bringIntoView(row: HTMLElement | null) {
  const strip = tabStrip.value;
  if (!strip) return;
  const page = scrollParent(strip);
  if (row) {
    const list = scrollParent(row);
    if (list !== page && !list.contains(strip)) {
      const rowRect = row.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      list.scrollTop += rowRect.top - listRect.top - (listRect.height - rowRect.height) / 2;
    }
  }
  const isDocument = page === document.scrollingElement || page === document.documentElement;
  const viewTop = isDocument ? 0 : page.getBoundingClientRect().top;
  const viewHeight = isDocument ? window.innerHeight : page.clientHeight;
  let delta = strip.getBoundingClientRect().top - viewTop - REVEAL_MARGIN;
  if (row) delta = Math.max(delta, row.getBoundingClientRect().bottom - viewTop - viewHeight + REVEAL_MARGIN);
  page.scrollBy({ top: delta, behavior: 'smooth' });
}

function canLocate(sectionId: string): boolean {
  return sectionId in EVIDENCE_SECTION_TAB;
}

/**
 * Open the tab that holds a cited section (and its Screen view), keep the tab
 * strip in view and bring the cited row under it: with `index`, the request or
 * console entry it names, which is ringed for a moment; on the Timeline, the
 * first row the Most likely line cites.
 */
function revealSection(sectionId: string, index?: number): boolean {
  const tab = EVIDENCE_SECTION_TAB[sectionId];
  if (!tab) return false;
  activeTab.value = tab;
  const citedView = SECTION_SCREEN_VIEW[sectionId];
  if (citedView) screenView.value = citedView;
  const rowTab = ROW_SECTION_TAB[sectionId];
  ringRow(rowTab && index != null ? { tab: rowTab, index } : null);
  nextTick(() => {
    if (sectionId === 'traceNetwork') networkComp.value?.showTraceMode?.();
    const wrapKey = SECTION_WRAP[sectionId];
    const wrap = wrapKey ? WRAP_REF[wrapKey]?.value : null;
    // The Timeline lays its rows out twice (phone cards, table): the shown one counts.
    const row =
      [...(wrap?.querySelectorAll<HTMLElement>('[data-cited]') ?? [])].find((el) => el.getClientRects().length > 0) ??
      null;
    bringIntoView(row);
  });
  return true;
}

defineExpose({ canLocate, revealSection, selectTab: (t: TabValue) => (activeTab.value = t) });
</script>

<template>
  <section
    v-if="!hasNoEvidence"
    data-shot="evidence-card"
    class="rounded-lg border border-default bg-default max-sm:rounded-none max-sm:border-x-0"
  >
    <!-- Header: the section title, its help, the trace, and the content-level tab strip -->
    <div class="p-3 sm:px-4 sm:py-3 border-b border-default" data-tour="evidence">
      <div class="flex items-center gap-2 mb-2.5">
        <UIcon name="i-lucide-microscope" class="size-5 shrink-0" :class="CARD_ICON_CLASS" data-card-icon />
        <h2 class="text-lg font-medium">Evidence</h2>
        <HelpHint v-if="help" :topic="help" />
        <!-- The viewer URL carries the page origin, known only in the browser. -->
        <ClientOnly v-if="primaryTrace">
          <UButton
            :to="traceViewUrl ?? undefined"
            target="_blank"
            size="xs"
            color="neutral"
            variant="outline"
            label="Open trace"
            :title="traceViewUnavailable ?? 'Open the Playwright trace of this execution in the trace viewer'"
            :disabled="!!traceViewUnavailable"
            class="ml-auto"
            data-tour="open-trace"
            @click="onViewTrace"
          />
          <template #fallback>
            <UButton size="xs" color="neutral" variant="outline" label="Open trace" class="ml-auto" disabled />
          </template>
        </ClientOnly>
      </div>
      <!-- What the evidence is of, when the page shows one execution among several -->
      <p v-if="$slots.subject" data-shot="evidence-subject" class="-mt-1 mb-2.5 text-xs text-muted break-words">
        <slot name="subject" />
      </p>
      <!-- The strip wraps onto as many rows as it needs, so no tab is ever
           hidden off the edge of the card. -->
      <div ref="tabStrip" class="flex flex-wrap items-center gap-1" role="tablist" aria-label="Evidence sections">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.value ? 'true' : 'false'"
          :title="citedTabs.has(tab.value) ? 'The Most likely line cites this tab' : undefined"
          :data-cited="citedTabs.has(tab.value) ? '' : undefined"
          class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-primary transition-colors"
          :class="[
            activeTab === tab.value ? SELECTED_TAB_CLASS : 'text-muted hover:bg-elevated/60',
            !tab.hasData && activeTab !== tab.value ? 'opacity-50' : '',
          ]"
          @click="activeTab = tab.value"
        >
          <UIcon :name="tab.icon" class="size-4 shrink-0" />
          {{ tab.label }}
          <span v-if="tab.count" class="text-xs font-normal text-muted tabular-nums">{{ tab.count }}</span>
          <span v-if="citedTabs.has(tab.value)" class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div class="p-3 sm:p-4">
      <!-- ── Timeline ─────────────────────────────────────────────── -->
      <!-- One view: the axis (for a failed execution) over a single steps table,
           with network / console / backend items interleaved by time. A passing
           execution shows the same table without the axis or offsets. -->
      <div v-if="activeTab === 'timeline'" ref="timelineWrap" class="scroll-mt-4" data-tour="evidence-timeline">
        <FailureTimelineCard
          embedded
          :test-runs-case-id="testRunsCaseId"
          :steps="steps"
          :duration-ms="testCase?.duration ?? null"
          :has-error="hasError"
          :error="testCase?.error ?? null"
          :status="status"
          :test-file-path="testCase?.filePath ?? null"
          :project-key="projectKey"
          :project-name="projectName"
          :attachments="attachments"
          :aria-snapshot="ariaSnapshot"
          :subject="imageSubject"
          :cited="cited"
        />
      </div>

      <!-- ── Attempts ─────────────────────────────────────────────── -->
      <!-- Lazy: this card mounts only when the tab opens, fetching the diff then. -->
      <div v-else-if="activeTab === 'attempts'" class="scroll-mt-4" data-tour="evidence-attempts">
        <AttemptsCard :test-runs-case-id="testRunsCaseId" :attempts="attemptsList" :project-id="projectKey ?? null" />
      </div>

      <!-- ── Screen ───────────────────────────────────────────────── -->
      <!-- One strip of views of the page at the failure, then the files. -->
      <div v-else-if="activeTab === 'screen'" data-shot="screen-evidence" data-tour="evidence-screen" class="space-y-4">
        <div ref="screenViewsWrap" class="scroll-mt-4">
          <FailingStepSnapshot
            v-model:view="screenView"
            full
            :test-runs-case-id="testRunsCaseId"
            :attachments="attachments"
            :aria-snapshot="ariaSnapshot"
            :aria-state="ariaState"
            :aria-derived="ariaDerived"
            :extra-views="screenExtraViews"
            :error="testCase?.error ?? null"
            :subject="imageSubject"
          >
            <template #visual-diff>
              <VisualDiffCard
                v-if="runId"
                embedded
                :test-runs-case-id="testRunsCaseId"
                :error="testCase?.error ?? null"
                :subject="imageSubject"
                @available="visualDiffAvailable = $event"
              />
            </template>
            <template #page-diff>
              <div class="space-y-4">
                <TracePageDiffCard
                  embedded
                  :test-runs-case-id="testRunsCaseId"
                  @available="traceDiffAvailable = $event"
                />
                <PageDiffCard
                  v-if="runId"
                  embedded
                  :run-id="runId"
                  :test-runs-case-id="testRunsCaseId"
                  @available="pageDiffAvailable = $event"
                />
              </div>
            </template>
            <template #video>
              <div class="space-y-2">
                <VideoPlayer v-for="video in videos" :key="video.src" :src="video.src" :label="video.name" />
              </div>
            </template>
          </FailingStepSnapshot>
        </div>
        <div ref="screenFilesWrap" class="scroll-mt-4">
          <TestEvidenceFiles :attachments="attachments" :traces="traces" />
        </div>
      </div>

      <!-- ── Source ───────────────────────────────────────────────── -->
      <!-- The test's source, then what it ran where the project records coverage. -->
      <div
        v-else-if="activeTab === 'source'"
        ref="sourceWrap"
        class="scroll-mt-4 space-y-6"
        data-tour="evidence-source"
      >
        <TestSourceCard
          v-if="sourceHasData"
          embedded
          :frames="testSourceFrames"
          :test-source="testSource"
          :run-id="runId"
          :test-runs-case-id="testRunsCaseId"
          :has-trace="hasTrace"
          :project-key="projectKey"
          :project-name="projectName"
        />
        <EmptyState v-else icon="i-lucide-file-code-2" text="No test source captured for this execution" />
        <ExecutionCoverageSection
          v-if="coverageState === 'active'"
          :test-runs-case-id="testRunsCaseId"
          :run-id="runId"
          :project-id="projectKey ?? null"
          :project-name="projectName ?? null"
          :suspects="suspectLines ?? null"
          :what-changed-to="whatChangedTo ?? null"
          :status="status"
        />
      </div>

      <!-- ── Network ──────────────────────────────────────────────── -->
      <div v-else-if="activeTab === 'network'" ref="networkWrap" class="scroll-mt-4" data-tour="evidence-network">
        <TestCaseNetworkRequests
          v-if="networkRequests.length > 0 || hasTrace"
          ref="networkComp"
          embedded
          :requests="networkRequests"
          :run-id="runId"
          :test-runs-case-id="testRunsCaseId"
          :has-trace="hasTrace"
          :derived-from-trace="networkDerived"
          :test-duration-ms="testCase?.duration ?? null"
          :usual-by-index="usualByRequest"
          :highlight-index="networkRowIndex"
        />
        <SectionCard v-else embedded title="">
          <EvidenceEmptyState :state="networkState" compact />
        </SectionCard>
      </div>

      <!-- ── Console ──────────────────────────────────────────────── -->
      <div v-else-if="activeTab === 'console'" ref="consoleWrap" class="scroll-mt-4" data-tour="evidence-console">
        <TestCaseConsoleCard
          v-if="consoleLogs.length"
          embedded
          :entries="consoleLogs"
          :derived-from-trace="consoleDerived"
          :highlight-index="consoleRowIndex"
        />
        <SectionCard v-else embedded title="">
          <EvidenceEmptyState :state="consoleState" compact />
        </SectionCard>
      </div>

      <!-- ── State ────────────────────────────────────────────────── -->
      <div v-else-if="activeTab === 'state'" class="space-y-4" data-tour="evidence-state">
        <div ref="pageStateWrap" class="scroll-mt-4">
          <PageStateCard v-if="pageState" embedded :page-state="pageState" />
          <SectionCard v-else embedded title="">
            <EvidenceEmptyState :state="appStateState" compact />
          </SectionCard>
        </div>
        <div ref="envDiffWrap" class="scroll-mt-4">
          <EnvironmentDiffCard v-if="runId" embedded :run-id="runId" :test-runs-case-id="testRunsCaseId" />
        </div>
      </div>

      <!-- ── Locators ─────────────────────────────────────────────── -->
      <!-- Lazy: fetched when the tab opens. -->
      <div v-else-if="activeTab === 'locators'" class="scroll-mt-4" data-tour="evidence-locators">
        <ExecutionLocatorsCard
          :test-runs-case-id="testRunsCaseId"
          :project-key="projectKey"
          :project-name="projectName"
        />
      </div>

      <!-- ── Performance ──────────────────────────────────────────── -->
      <div
        v-else-if="activeTab === 'performance'"
        ref="performanceWrap"
        class="scroll-mt-4"
        data-tour="evidence-performance"
      >
        <TestCasePerformancePanel
          embedded
          :performance-hints="performanceHints"
          :web-vitals="webVitals"
          :resources="resources"
          :state="webVitalsState"
        />
      </div>
    </div>

    <!-- One line naming the sources the capture fixtures would add, with the
         decline controls for an administrator. Gone once the project decides. -->
    <div
      v-if="showFixturesFooter"
      data-shot="evidence-fixtures-footer"
      class="border-t border-default px-3 py-2.5 sm:px-4 text-xs text-muted"
    >
      <p class="leading-relaxed">
        Network, console, state and performance are not captured for this project.
        <template v-if="canDecide">
          <NuxtLink to="/setup" :class="SENTENCE_LINK_CLASS">Add fixtures</NuxtLink>
          <span aria-hidden="true"> · </span>
          <button type="button" :class="SENTENCE_LINK_CLASS" @click="emit('decline-fixtures', 'project')">
            Not for this project
          </button>
          <span aria-hidden="true"> · </span>
          <button type="button" :class="SENTENCE_LINK_CLASS" @click="emit('decline-fixtures', 'instance')">
            Not for this instance
          </button>
        </template>
      </p>
    </div>
  </section>
</template>
