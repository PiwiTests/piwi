<script setup lang="ts">
import { computed, nextTick, watch, ref } from 'vue';
import type { RunClusterMeta, TestCaseResult } from '~~/types/api';
import type { LiveStepInfo, LiveStepsByWorker } from '~/utils/live-steps';
import { summarizeRunCases } from '#shared/utils/test-counts';
import { isFixmeSkip } from '#shared/utils/skip-kind';
import { stripAnsi } from '#shared/error-parse';
import { parseLocation } from '#shared/parse-location';
import {
  RUN_SEARCH_FIELDS,
  collectTestSearchValues,
  compileTestSearch,
  parseTestSearch,
  testSearchHighlights,
  type TestSearchSubject,
} from '#shared/test-search';
import {
  compareFileOrder,
  compareRunOrder,
  describeGroupKeys,
  fileGroupKey,
  fileGroupRows,
  type TestPosition,
} from '~/utils/test-list-order';

/** Cluster id → its display name and triage status, for the row chip and the
 *  cluster group header. Supplied by the page from the failure-groups payload. */
type GroupBy = 'cluster' | 'file' | 'file-describe' | 'lock' | 'none';

const props = defineProps<{
  testCases: TestCaseResult[];
  isLive: boolean;
  /** Planned suite size — the "N / total completed" denominator while live, so
   *  it counts toward the whole run, not just the tests seen so far. */
  total?: number | null;
  /** Worker index → current step, rendered inline on the matching running rows. */
  liveSteps?: LiveStepsByWorker | null;
  clusterMeta?: RunClusterMeta | null;
  /** Stable test-case ids currently quarantined — marks the matching rows. */
  quarantinedCaseIds?: Set<number> | null;
  /** Piwi project id + name, threaded so the IDE opener can resolve a workspace root. */
  projectKey?: string | number | null;
  projectName?: string | null;
}>();

const emit = defineEmits<{ 'quarantine-changed': [] }>();

function isQuarantined(tc: TestCaseResult): boolean {
  return Boolean(props.quarantinedCaseIds?.has(tc.testCaseId));
}

function clusterName(id: number): string {
  return props.clusterMeta?.[id]?.name ?? `Cluster #${id}`;
}

function clusterIssue(id: number | null | undefined) {
  return id != null ? (props.clusterMeta?.[id]?.issue ?? null) : null;
}

function liveStep(tc: TestCaseResult): LiveStepInfo | null {
  return liveStepForCase(props.liveSteps, tc);
}

// Filter state is owned by the parent page so it survives tab switches.
const testCaseSearch = defineModel<string>('search', { default: '' });
const activeStatuses = defineModel<string[]>('activeStatuses', { default: () => [] });

const showNewRegressionsOnly = ref(false);
const showNewFlakyOnly = ref(false);

/** True when at least one execution in the run carries a lock. */
const hasAnyLocks = computed(() => props.testCases.some((tc) => (tc.locks?.length ?? 0) > 0));

// ── Search ──────────────────────────────────────────────────────────────────
// The search box's language (`file:`, `describe:`, `tag:`, `browser:`, `-…`)
// is shared with the project catalog; here it runs in memory over the run.
const parsedSearch = computed(() => parseTestSearch(testCaseSearch.value, RUN_SEARCH_FIELDS));
const searchMatcher = computed(() => compileTestSearch(parsedSearch.value));
const searchHighlights = computed(() =>
  parsedSearch.value.terms.length > 0 ? testSearchHighlights(parsedSearch.value) : null,
);

// What search, sort and grouping read from an execution, built once per row
// object (a live row is replaced by a new object when it changes).
const subjectCache = new WeakMap<TestCaseResult, TestSearchSubject>();
function searchSubject(tc: TestCaseResult): TestSearchSubject {
  let subject = subjectCache.get(tc);
  if (!subject) {
    subject = {
      title: tc.title,
      suitePath: tc.suitePath ?? [],
      filePath: tc.filePath || tc.location ? positionOf(tc).filePath : null,
      error: tc.error ? stripAnsi(tc.error) : null,
      tags: tc.tags ?? [],
      locks: tc.locks ?? [],
      browser: tc.browser?.projectName ?? null,
      owner: tc.testMeta?.owner ?? null,
      priority: tc.testMeta?.priority ?? null,
      feature: tc.testMeta?.feature ?? null,
    };
    subjectCache.set(tc, subject);
  }
  return subject;
}

const positionCache = new WeakMap<TestCaseResult, TestPosition>();
function positionOf(tc: TestCaseResult): TestPosition {
  let position = positionCache.get(tc);
  if (!position) {
    const parsed = tc.location ? parseLocation(tc.location) : null;
    // A retried test is listed by its final attempt; it ran first when its first attempt did.
    const starts = [tc.startedAt, ...(tc.attempts ?? []).map((a) => a.startedAt)].filter(
      (t): t is number => typeof t === 'number' && t > 0,
    );
    position = {
      filePath: tc.filePath || parsed?.filePath || 'unknown',
      suitePath: tc.suitePath ?? [],
      line: parsed?.line ?? null,
      column: parsed?.column ?? null,
      startedAt: starts.length > 0 ? Math.min(...starts) : null,
    };
    positionCache.set(tc, position);
  }
  return position;
}

/** Every value the search qualifiers can take in this run, for completion. */
const searchValues = computed(() => collectTestSearchValues(props.testCases.map(searchSubject), RUN_SEARCH_FIELDS));

const STATUS_OPTIONS = [
  { label: 'Passed', value: 'passed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Passed on retry', value: 'flaky' },
  { label: 'Skipped', value: 'skipped' },
  { label: 'Fixme', value: 'fixme' },
  { label: "Didn't run", value: 'didnotrun' },
] as const;

function toggleStatus(value: string) {
  activeStatuses.value = activeStatuses.value.includes(value)
    ? activeStatuses.value.filter((s) => s !== value)
    : [...activeStatuses.value, value];
}

function matchesStatus(tc: TestCaseResult, filter: string): boolean {
  if (filter === 'failed') return isFailedStatus(tc.status);
  // Passed and passed on retry are disjoint here, like skipped and fixme, so
  // each chip and bar segment lands on exactly the rows it counts.
  if (filter === 'passed') return tc.status === 'passed' && (tc.retries ?? 0) === 0;
  if (filter === 'flaky') return tc.status === 'passed' && (tc.retries ?? 0) > 0;
  if (filter === 'fixme') return isFixmeSkip(tc);
  if (filter === 'skipped') return tc.status === 'skipped' && !isFixmeSkip(tc);
  return tc.status === filter;
}

const filteredTestCases = computed<TestCaseResult[]>(() => {
  let cases = props.testCases;
  if (activeStatuses.value.length > 0) {
    cases = cases.filter((tc) => activeStatuses.value.some((s) => matchesStatus(tc, s)));
  }
  if (parsedSearch.value.terms.length > 0) {
    // A free word looks in the title, the describe blocks, the path AND the
    // error text, so a failure is findable by what broke, not only by which test broke.
    const matches = searchMatcher.value;
    cases = cases.filter((tc) => matches(searchSubject(tc)));
  }
  if (showNewRegressionsOnly.value) cases = cases.filter((tc) => tc.isNewRegression);
  if (showNewFlakyOnly.value) cases = cases.filter((tc) => tc.isNewFlaky);
  return cases;
});

const failedCount = computed(() => props.testCases.filter((tc) => isFailedStatus(tc.status)).length);

// ── Grouping ────────────────────────────────────────────────────────────────
const { raw: storedGroup, set: setGroup } = useGroupByCookie('run-tests', [
  'cluster',
  'file',
  'file-describe',
  'lock',
  'none',
]);
const groupBy = computed<GroupBy>({
  // A red run opens on the cluster grouping; a green run has no clusters, so it
  // opens flat. A saved choice always wins.
  get: () => {
    const stored = storedGroup.value as GroupBy | null;
    // A saved "lock" choice is meaningless on a run with no locks — fall back.
    if (stored === 'lock' && !hasAnyLocks.value) return failedCount.value > 0 ? 'cluster' : 'none';
    return stored ?? (failedCount.value > 0 ? 'cluster' : 'none');
  },
  set: (v) => setGroup(v),
});
const groupByItems = computed(() => [
  { label: 'Cluster', value: 'cluster' },
  { label: 'File', value: 'file' },
  { label: 'File + Describe', value: 'file-describe' },
  // Only offer lock grouping when the run actually declared locks.
  ...(hasAnyLocks.value ? [{ label: 'Lock', value: 'lock' }] : []),
  { label: 'None', value: 'none' },
]);
const groupedByFile = computed(() => groupBy.value === 'file' || groupBy.value === 'file-describe');
/** The describe blocks are on the row unless the grouping shows them as headers. */
const showSuitePath = computed(() => groupBy.value !== 'file-describe');

// ── Sort (inside each group) ────────────────────────────────────────────────
// Run order is when each test first started; file order is where it is
// declared. Until a sort is picked, the file groupings read in file order and
// the others in run order.
type SortKey =
  | 'run'
  | 'file'
  | 'failures'
  | 'title'
  | 'status'
  | 'duration'
  | 'workerIndex'
  | 'retries'
  | 'wastedTimeMs';
/** The direction each sort starts in: the slowest, most retried and most wasteful first. */
const SORT_DIRECTIONS: Record<SortKey, 'asc' | 'desc'> = {
  run: 'asc',
  file: 'asc',
  failures: 'asc',
  title: 'asc',
  status: 'asc',
  duration: 'desc',
  workerIndex: 'asc',
  retries: 'desc',
  wastedTimeMs: 'desc',
};
const SORT_OPTIONS: Array<{ label: string; value: SortKey }> = [
  { label: 'Run order', value: 'run' },
  { label: 'File order', value: 'file' },
  { label: 'Failures first', value: 'failures' },
  { label: 'Title', value: 'title' },
  { label: 'Status', value: 'status' },
  { label: 'Duration', value: 'duration' },
  { label: 'Worker', value: 'workerIndex' },
  { label: 'Retries', value: 'retries' },
  { label: 'Wasted', value: 'wastedTimeMs' },
];
const chosenSort = ref<SortKey | null>(null);
const sortDir = ref<'asc' | 'desc'>('asc');
const sortKey = computed<SortKey>({
  get: () => chosenSort.value ?? (groupedByFile.value ? 'file' : 'run'),
  set: (value) => {
    chosenSort.value = value;
    sortDir.value = SORT_DIRECTIONS[value];
  },
});
/** The sort follows where tests sit, so describe blocks sit among the tests by position. */
const positionalSort = computed(() => sortKey.value === 'run' || sortKey.value === 'file');

function sortValue(tc: TestCaseResult, key: SortKey): string | number {
  switch (key) {
    case 'title':
      return tc.title ?? '';
    case 'status':
      return isFailedStatus(tc.status) ? 'failed' : (tc.status ?? '');
    case 'duration':
      return tc.duration ?? 0;
    case 'workerIndex':
      return tc.workerIndex ?? -1;
    case 'retries':
      return tc.retries ?? 0;
    case 'wastedTimeMs':
      return tc.wastedTimeMs ?? 0;
    default:
      return '';
  }
}

const runOrder = (a: TestCaseResult, b: TestCaseResult) =>
  compareRunOrder(positionOf(a), positionOf(b)) || a.executionId - b.executionId;

const compareCases = computed<(a: TestCaseResult, b: TestCaseResult) => number>(() => {
  const key = sortKey.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  switch (key) {
    case 'run':
      return (a, b) => runOrder(a, b) * dir;
    case 'file':
      return (a, b) => (compareFileOrder(positionOf(a), positionOf(b)) || runOrder(a, b)) * dir;
    case 'failures':
      return (a, b) => failureFirstCompare(a.status, b.status) || runOrder(a, b);
    default:
      return (a, b) => {
        const va = sortValue(a, key);
        const vb = sortValue(b, key);
        const order = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
        return order * dir || runOrder(a, b);
      };
  }
});

function sortCases(cases: TestCaseResult[]): TestCaseResult[] {
  return [...cases].sort(compareCases.value);
}

// The quiet buckets (passed, skipped, fixme, didn't run) start collapsed; every other
// group starts open. A user click flips a group from its default; a filter
// forces everything open so a match is never hidden behind a collapsed header.
const DEFAULT_COLLAPSED_BUCKETS = new Set([
  'bucket:passed',
  'bucket:skipped',
  'bucket:fixme',
  'bucket:didnotrun',
  'lock:none',
]);
const userToggled = ref(new Set<string>());
const hasFilter = computed(
  () =>
    parsedSearch.value.terms.length > 0 ||
    activeStatuses.value.length > 0 ||
    showNewRegressionsOnly.value ||
    showNewFlakyOnly.value,
);
function clearFilters() {
  testCaseSearch.value = '';
  activeStatuses.value = [];
  showNewRegressionsOnly.value = false;
  showNewFlakyOnly.value = false;
}
function defaultOpen(key: string): boolean {
  return !DEFAULT_COLLAPSED_BUCKETS.has(key);
}
function isOpen(key: string): boolean {
  if (hasFilter.value) return true;
  return userToggled.value.has(key) ? !defaultOpen(key) : defaultOpen(key);
}
function toggleGroup(key: string) {
  const next = new Set(userToggled.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  userToggled.value = next;
}

interface GroupHeaderItem {
  kind: 'group';
  key: string;
  label: string;
  count: number;
  icon?: string;
  triageStatus?: string | null;
  clusterId?: number | null;
  stats?: { passed: number; failed: number; skipped: number; didnotrun: number; running: number } | null;
  filePath?: string | null;
  /** Nesting depth for the File + Describe grouping (0 = file). */
  depth?: number;
  /** Which search matches to mark in the label: a file's or a describe block's. */
  labelField?: 'file' | 'describe';
}
interface TestItem {
  kind: 'test';
  key: string;
  tc: TestCaseResult;
  /** Nesting depth of the row's group, so a nested test indents under it. */
  depth?: number;
}
type Row = GroupHeaderItem | TestItem;

function computeStats(cases: TestCaseResult[]) {
  const s = summarizeRunCases(cases);
  return { passed: s.passed, failed: s.failed, skipped: s.skipped, didnotrun: s.didNotRun, running: s.running };
}

/** The remainder buckets (non-failing) shown as their own groups; the quiet
 *  ones start collapsed (see `DEFAULT_COLLAPSED_BUCKETS`). */
const REMAINDER_BUCKETS: Array<{ key: string; label: string; match: (tc: TestCaseResult) => boolean }> = [
  { key: 'running', label: 'Running', match: (tc) => tc.status === 'running' },
  { key: 'passed', label: 'Passed', match: (tc) => tc.status === 'passed' },
  { key: 'skipped', label: 'Skipped', match: (tc) => tc.status === 'skipped' && !isFixmeSkip(tc) },
  { key: 'fixme', label: 'Fixme', match: isFixmeSkip },
  { key: 'didnotrun', label: "Didn't run", match: (tc) => tc.status === 'didnotrun' },
];

const rows = computed<Row[]>(() => {
  const cases = filteredTestCases.value;

  if (groupBy.value === 'none') {
    return sortCases(cases).map((tc) => ({ kind: 'test', key: `t${tc.executionId}`, tc }) as TestItem);
  }

  const out: Row[] = [];

  if (groupedByFile.value) {
    for (const row of fileGroupRows(cases, {
      describe: groupBy.value === 'file-describe',
      position: positionOf,
      compare: compareCases.value,
      positional: positionalSort.value,
      isOpen,
      testKey: (tc) => `t${tc.executionId}`,
    })) {
      if (row.kind === 'test') {
        out.push({ kind: 'test', key: row.key, tc: row.test, depth: row.depth });
      } else {
        out.push({
          kind: 'group',
          key: row.key,
          label: row.label,
          count: row.tests.length,
          icon: row.isFile ? 'i-lucide-file-code-2' : 'i-lucide-folder',
          filePath: row.isFile ? row.filePath : null,
          stats: computeStats(row.tests),
          depth: row.depth,
          labelField: row.isFile ? 'file' : 'describe',
        });
      }
    }
    return out;
  }

  if (groupBy.value === 'lock') {
    // A group per lock name; a test holding several locks appears under each.
    // Tests with no lock fall into a trailing "No lock" group.
    const byLock = new Map<string, TestCaseResult[]>();
    const noLock: TestCaseResult[] = [];
    for (const tc of cases) {
      const locks = tc.locks ?? [];
      if (locks.length === 0) noLock.push(tc);
      else
        for (const lock of locks) {
          if (!byLock.has(lock)) byLock.set(lock, []);
          byLock.get(lock)!.push(tc);
        }
    }
    for (const [lock, lockCases] of [...byLock.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const key = `lock:${lock}`;
      out.push({
        kind: 'group',
        key,
        label: lock,
        count: lockCases.length,
        icon: 'i-lucide-lock',
        stats: computeStats(lockCases),
      });
      if (isOpen(key))
        for (const tc of sortCases(lockCases)) out.push({ kind: 'test', key: `t${tc.executionId}:${lock}`, tc });
    }
    if (noLock.length > 0) {
      const key = 'lock:none';
      out.push({ kind: 'group', key, label: 'No lock', count: noLock.length, stats: computeStats(noLock) });
      if (isOpen(key))
        for (const tc of sortCases(noLock)) out.push({ kind: 'test', key: `t${tc.executionId}:nolock`, tc });
    }
    return out;
  }

  // Cluster grouping: failing clustered tests first (largest cluster first),
  // then ungrouped failures, then the non-failing remainder as collapsed groups.
  const failing = cases.filter((tc) => isFailedStatus(tc.status));
  const byCluster = new Map<number, TestCaseResult[]>();
  const ungrouped: TestCaseResult[] = [];
  for (const tc of failing) {
    if (tc.failureClusterId != null) {
      if (!byCluster.has(tc.failureClusterId)) byCluster.set(tc.failureClusterId, []);
      byCluster.get(tc.failureClusterId)!.push(tc);
    } else {
      ungrouped.push(tc);
    }
  }
  const clusterGroups = [...byCluster.entries()].sort(([, a], [, b]) => b.length - a.length);
  for (const [clusterId, clusterCases] of clusterGroups) {
    const key = `cluster:${clusterId}`;
    out.push({
      kind: 'group',
      key,
      label: clusterName(clusterId),
      count: clusterCases.length,
      icon: 'i-lucide-layers',
      clusterId,
      triageStatus: props.clusterMeta?.[clusterId]?.status ?? null,
    });
    if (isOpen(key))
      for (const tc of sortCases(clusterCases)) out.push({ kind: 'test', key: `t${tc.executionId}`, tc });
  }
  if (ungrouped.length > 0) {
    const key = 'cluster:none';
    out.push({ kind: 'group', key, label: 'Ungrouped failures', count: ungrouped.length, icon: 'i-lucide-circle-x' });
    if (isOpen(key)) for (const tc of sortCases(ungrouped)) out.push({ kind: 'test', key: `t${tc.executionId}`, tc });
  }
  for (const bucket of REMAINDER_BUCKETS) {
    const bucketCases = cases.filter(bucket.match);
    if (bucketCases.length === 0) continue;
    const key = `bucket:${bucket.key}`;
    out.push({ kind: 'group', key, label: bucket.label, count: bucketCases.length });
    if (isOpen(key)) for (const tc of sortCases(bucketCases)) out.push({ kind: 'test', key: `t${tc.executionId}`, tc });
  }
  return out;
});

// Every group key an execution sits under (a nested describe row has several),
// so a jump from the timeline can open the whole chain even when collapsed —
// derived from the data, not the visible rows, so a hidden row is locatable.
const groupKeysByExecution = computed(() => {
  const map = new Map<number, string[]>();
  if (groupBy.value === 'none') return map;
  for (const tc of filteredTestCases.value) {
    if (groupBy.value === 'lock') {
      const locks = tc.locks ?? [];
      map.set(tc.executionId, locks.length ? locks.map((l) => `lock:${l}`) : ['lock:none']);
    } else if (groupBy.value === 'file') {
      map.set(tc.executionId, [fileGroupKey(positionOf(tc).filePath)]);
    } else if (groupBy.value === 'file-describe') {
      map.set(tc.executionId, describeGroupKeys(positionOf(tc)));
    } else if (isFailedStatus(tc.status)) {
      map.set(tc.executionId, [tc.failureClusterId != null ? `cluster:${tc.failureClusterId}` : 'cluster:none']);
    } else {
      const bucket = REMAINDER_BUCKETS.find((b) => b.match(tc));
      if (bucket) map.set(tc.executionId, [`bucket:${bucket.key}`]);
    }
  }
  return map;
});

const finishedCount = computed(() => props.testCases.filter((tc) => tc.status !== 'running').length);
const visibleTestCount = computed(() => rows.value.filter((r) => r.kind === 'test').length);

// ── Bulk triage (works in every grouping) ────────────────────────────────────
const toast = useToast();
const { can } = useAuth();
const { quarantineMany } = useQuarantine(() => props.projectKey ?? null);
// Each bulk action shows to the holders of its permission on the run's project.
const canQuarantine = computed(() => can('quarantine:write', props.projectKey));
const canTriage = computed(() => can('triage:write', props.projectKey));
// What quarantining the selection leaves uncovered, beside its button and in its confirmation, where the project
// records coverage: read once a test is selected, so the page's render reads nothing for it.
const { active: coverageActive, resolve: resolveCoverageActive } = useLazyCoverageActive(() => props.projectKey);

const selectionEnabled = computed(() => (canQuarantine.value || canTriage.value) && failedCount.value > 0);
const selectedIds = ref<Set<number>>(new Set());

const selectableRows = computed(() => filteredTestCases.value.filter((tc) => isFailedStatus(tc.status)));
const selectedRows = computed(() => selectableRows.value.filter((tc) => selectedIds.value.has(tc.executionId)));
const selectedCount = computed(() => selectedRows.value.length);
watch(selectedCount, (count) => {
  if (count > 0 && canQuarantine.value) void resolveCoverageActive();
});
const allSelectableSelected = computed(
  () => selectableRows.value.length > 0 && selectableRows.value.every((tc) => selectedIds.value.has(tc.executionId)),
);
const someSelectableSelected = computed(
  () => selectableRows.value.some((tc) => selectedIds.value.has(tc.executionId)) && !allSelectableSelected.value,
);

function toggleRow(tc: TestCaseResult) {
  const next = new Set(selectedIds.value);
  if (next.has(tc.executionId)) next.delete(tc.executionId);
  else next.add(tc.executionId);
  selectedIds.value = next;
}
function toggleAll() {
  selectedIds.value = allSelectableSelected.value
    ? new Set()
    : new Set(selectableRows.value.map((tc) => tc.executionId));
}
function clearSelection() {
  selectedIds.value = new Set();
}

// Drop ids no longer selectable when the filter/data changes.
watch([selectableRows, selectionEnabled], () => {
  if (!selectionEnabled.value) {
    if (selectedIds.value.size > 0) selectedIds.value = new Set();
    return;
  }
  const stillSelectable = new Set(selectableRows.value.map((tc) => tc.executionId));
  const filtered = new Set([...selectedIds.value].filter((id) => stillSelectable.has(id)));
  if (filtered.size !== selectedIds.value.size) selectedIds.value = filtered;
});

const selectedTestCaseIds = computed(() => [...new Set(selectedRows.value.map((tc) => tc.testCaseId))]);
const selectedClusterIds = computed(() => [
  ...new Set(selectedRows.value.map((tc) => tc.failureClusterId).filter((id): id is number => id != null)),
]);
const allSelectedInCluster = computed(
  () => selectedCount.value > 0 && selectedRows.value.every((tc) => tc.failureClusterId != null),
);

const bulkBusy = ref(false);
const quarantineConfirmOpen = ref(false);
const { load: loadQuarantineLoss, answerFor: quarantineLossFor } = useCoverageLoss(
  () => props.projectKey,
  coverageActive,
);
watch(quarantineConfirmOpen, (open) => {
  if (open) void loadQuarantineLoss(selectedTestCaseIds.value);
});

async function runBulkQuarantine() {
  const ids = selectedTestCaseIds.value;
  if (ids.length === 0) return;
  bulkBusy.value = true;
  try {
    const { succeeded, failed } = await quarantineMany(ids, () => 'Quarantined from run');
    if (failed === 0) {
      toast.add({ title: `Quarantined ${succeeded} test${succeeded === 1 ? '' : 's'}`, color: 'success' });
    } else {
      toast.add({
        title: `Quarantined ${succeeded} of ${ids.length}`,
        description: `${failed} could not be quarantined.`,
        color: succeeded > 0 ? 'warning' : 'error',
      });
    }
    if (succeeded > 0) {
      emit('quarantine-changed');
      clearSelection();
    }
  } finally {
    bulkBusy.value = false;
    quarantineConfirmOpen.value = false;
  }
}

async function setClusterStatus(status: 'open' | 'resolved' | 'ignored') {
  const clusterIds = selectedClusterIds.value;
  if (clusterIds.length === 0) return;
  bulkBusy.value = true;
  let succeeded = 0;
  let failed = 0;
  try {
    for (const clusterId of clusterIds) {
      try {
        await $fetch(`/api/failure-clusters/${clusterId}/status`, { method: 'PATCH', body: { status } });
        succeeded++;
      } catch {
        failed++;
      }
    }
    const label = `${succeeded} cluster${succeeded === 1 ? '' : 's'} set to ${status}`;
    if (failed === 0) toast.add({ title: label, color: 'success' });
    else
      toast.add({
        title: label,
        description: `${failed} could not be updated.`,
        color: succeeded > 0 ? 'warning' : 'error',
      });
    if (succeeded > 0) clearSelection();
  } finally {
    bulkBusy.value = false;
  }
}

const QUARANTINE_CONFIRM_THRESHOLD = 3;
function onBulkQuarantine() {
  if (selectedTestCaseIds.value.length > QUARANTINE_CONFIRM_THRESHOLD) quarantineConfirmOpen.value = true;
  else runBulkQuarantine();
}

// ── Virtualized scroller ─────────────────────────────────────────────────────
const scrollerRef = ref<{
  scrollToItem: (index: number, options?: ScrollToOptions) => void;
  scrollToBottom: () => void;
} | null>(null);
const userScrolledAway = ref(false);
const highlightedCaseId = ref<number | null>(null);

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
}
function onScrollerScroll(event: Event) {
  const el = event.target as HTMLElement | null;
  if (el) userScrolledAway.value = !isAtBottom(el);
}
watch(
  () => props.isLive,
  (live) => {
    if (!live) userScrolledAway.value = false;
  },
);
watch(
  () => rows.value.length,
  () => {
    if (!props.isLive || userScrolledAway.value) return;
    nextTick(() => scrollerRef.value?.scrollToBottom());
  },
);

function scrollToCase(id: number) {
  // Open every group in the row's chain, then scroll to it and flash it.
  const groupKeys = groupKeysByExecution.value.get(id) ?? [];
  const next = new Set(userToggled.value);
  for (const groupKey of groupKeys) {
    if (isOpen(groupKey)) continue;
    // Flip the group toward open: for a default-open group that the user closed,
    // drop the toggle; for a default-collapsed bucket, add the toggle.
    if (defaultOpen(groupKey)) next.delete(groupKey);
    else next.add(groupKey);
  }
  userToggled.value = next;
  highlightedCaseId.value = id;
  const doScroll = () => {
    const index = rows.value.findIndex((r) => r.kind === 'test' && r.tc.executionId === id);
    if (index >= 0) scrollerRef.value?.scrollToItem(index, { behavior: 'smooth' });
  };
  nextTick(() => {
    if (scrollerRef.value) doScroll();
    else setTimeout(doScroll, 60);
    setTimeout(() => {
      highlightedCaseId.value = null;
    }, 3000);
  });
}

defineExpose({ scrollToCase });
</script>

<template>
  <div class="flex flex-col min-h-0">
    <!-- Filters, in two rows: the search (words and file:, describe:, tag:,
         browser:… qualifiers), then outcomes. How the rows are grouped and
         sorted sits on the list's own header. -->
    <div class="mb-3 shrink-0 space-y-2">
      <TestSearchInput
        v-model="testCaseSearch"
        :fields="RUN_SEARCH_FIELDS"
        :values="searchValues"
        placeholder="Search tests, or filter with file:, describe:, tag:…"
      />

      <div class="flex flex-wrap items-center gap-1">
        <StatusFilterChip
          v-for="opt in STATUS_OPTIONS"
          :key="opt.value"
          :status="opt.value"
          :label="opt.label"
          :pressed="activeStatuses.includes(opt.value)"
          @click="toggleStatus(opt.value)"
        />
        <!-- The two signals join the status chips as toggles, not checkboxes. -->
        <template v-if="!isLive">
          <span class="mx-1 h-4 w-px bg-accented" aria-hidden="true" />
          <StatusFilterChip
            status="failed"
            label="New regressions"
            icon="i-lucide-flame"
            :pressed="showNewRegressionsOnly"
            @click="showNewRegressionsOnly = !showNewRegressionsOnly"
          />
          <StatusFilterChip
            status="flaky"
            label="Newly flaky"
            icon="i-lucide-shuffle"
            :pressed="showNewFlakyOnly"
            @click="showNewFlakyOnly = !showNewFlakyOnly"
          />
        </template>
        <UButton
          v-if="hasFilter"
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-x"
          label="Clear filters"
          class="ml-auto"
          @click="clearFilters"
        />
      </div>
    </div>

    <!-- Bulk triage bar — appears once failing rows are selected. -->
    <div
      v-if="selectionEnabled && selectedCount > 0"
      class="mb-3 shrink-0 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
    >
      <span class="text-sm font-medium" aria-live="polite">{{ selectedCount }} selected</span>
      <div class="flex flex-wrap items-center gap-2 ml-auto">
        <CoverageLossPopover
          v-if="canQuarantine"
          :project-id="projectKey ?? 0"
          :project-name="projectName"
          :test-case-ids="selectedTestCaseIds"
          :active="coverageActive"
        >
          <UButton
            size="xs"
            color="warning"
            variant="soft"
            icon="i-lucide-shield-alert"
            :loading="bulkBusy"
            @click="onBulkQuarantine"
          >
            Quarantine selected
          </UButton>
        </CoverageLossPopover>
        <UDropdownMenu
          v-if="canTriage && allSelectedInCluster"
          :items="[
            { label: 'Open', onSelect: () => setClusterStatus('open') },
            { label: 'Resolved', onSelect: () => setClusterStatus('resolved') },
            { label: 'Ignored', onSelect: () => setClusterStatus('ignored') },
          ]"
        >
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-triangle-alert"
            trailing-icon="i-lucide-chevron-down"
            :loading="bulkBusy"
          >
            Set cluster status…
          </UButton>
        </UDropdownMenu>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" @click="clearSelection">Clear</UButton>
      </div>
    </div>

    <div v-if="rows.length > 0" class="flex-1 min-h-0 rounded-lg border border-default bg-default flex flex-col">
      <!-- List header: select-all failing and the count on the left, how the
           rows are grouped and sorted on the right. -->
      <div
        class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-default bg-elevated/40 px-3 py-1.5 shrink-0"
      >
        <div v-if="selectionEnabled" class="flex items-center gap-2">
          <input
            type="checkbox"
            class="size-4 cursor-pointer accent-primary focus-visible:ring-2 focus-visible:ring-primary rounded"
            :checked="allSelectableSelected"
            :indeterminate.prop="someSelectableSelected"
            :aria-label="allSelectableSelected ? 'Deselect all failing tests' : 'Select all failing tests'"
            @change="toggleAll"
          />
          <span class="text-xs text-muted">Select all failing</span>
        </div>
        <span v-if="isLive" aria-live="polite" class="text-xs text-muted tabular-nums inline-flex items-center gap-1">
          {{ finishedCount }} / {{ Math.max(total ?? 0, testCases.length) }} completed <HelpHint topic="run.live" />
        </span>
        <span v-else class="text-xs text-muted tabular-nums inline-flex items-center gap-1">
          {{ visibleTestCount }}{{ visibleTestCount !== testCases.length ? ` / ${testCases.length}` : '' }} executions
          <HelpHint topic="run.test-cases" />
        </span>
        <div class="grid w-full grid-cols-2 gap-2 sm:ml-auto sm:flex sm:w-auto sm:items-center sm:gap-3">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-xs text-muted whitespace-nowrap">Group by</span>
            <USelect
              v-model="groupBy"
              :items="groupByItems"
              size="xs"
              class="min-w-0 flex-1 sm:w-32 sm:flex-none"
              aria-label="Group tests by"
            />
          </div>
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-xs text-muted">Sort</span>
            <USelect
              v-model="sortKey"
              :items="SORT_OPTIONS"
              size="xs"
              class="min-w-0 flex-1 sm:w-32 sm:flex-none"
              aria-label="Sort tests by"
            />
            <UButton
              size="xs"
              variant="outline"
              color="neutral"
              :disabled="sortKey === 'failures'"
              :icon="sortDir === 'asc' ? 'i-lucide-arrow-up-narrow-wide' : 'i-lucide-arrow-down-wide-narrow'"
              :title="sortDir === 'asc' ? 'Sorted ascending' : 'Sorted descending'"
              :aria-label="sortDir === 'asc' ? 'Sorted ascending' : 'Sorted descending'"
              @click="sortDir = sortDir === 'asc' ? 'desc' : 'asc'"
            />
          </div>
        </div>
      </div>

      <ClientOnly>
        <DynamicScroller
          ref="scrollerRef"
          :items="rows"
          :min-item-size="44"
          key-field="key"
          class="flex-1 min-h-0"
          @scroll.passive="onScrollerScroll"
        >
          <template #default="{ item, index, active }">
            <DynamicScrollerItem
              :item="item"
              :active="active"
              :size-dependencies="
                item.kind === 'test'
                  ? [
                      item.tc.title,
                      item.tc.location,
                      item.tc.isNewRegression,
                      item.tc.isNewFlaky,
                      item.tc.testAnnotations,
                      item.tc.tags,
                      item.tc.locks,
                      liveStep(item.tc)?.title,
                      showSuitePath,
                      item.tc.suitePath,
                    ]
                  : [item.label, item.count, item.triageStatus]
              "
              :data-index="index"
            >
              <TestRowGroup
                v-if="item.kind === 'group'"
                :label="item.label"
                :count="item.count"
                :open="isOpen(item.key)"
                :icon="item.icon"
                :depth="item.depth ?? 0"
                :triage-status="item.triageStatus"
                :cluster-id="item.clusterId"
                :stats="item.stats"
                :file-path="item.filePath"
                :highlight="item.labelField ? searchHighlights?.[item.labelField] : null"
                :project-key="projectKey"
                :project-name="projectName"
                @toggle="toggleGroup(item.key)"
              />
              <TestRow
                v-else
                :test-case="item.tc"
                :cluster-name="item.tc.failureClusterId != null ? clusterName(item.tc.failureClusterId) : null"
                :issue="clusterIssue(item.tc.failureClusterId)"
                :quarantined="isQuarantined(item.tc)"
                :selectable="selectionEnabled && isFailedStatus(item.tc.status)"
                :selected="selectedIds.has(item.tc.executionId)"
                :live-step="liveStep(item.tc)"
                :highlighted="highlightedCaseId === item.tc.executionId"
                :indent="(item.depth ?? 0) * 16"
                :suite-path="showSuitePath ? item.tc.suitePath : null"
                :highlight="searchHighlights"
                :project-key="projectKey"
                :project-name="projectName"
                @toggle="toggleRow(item.tc)"
              />
            </DynamicScrollerItem>
          </template>
        </DynamicScroller>

        <template #fallback>
          <div class="flex-1 min-h-0 flex items-center justify-center py-10 text-sm text-zinc-500">
            <UIcon name="i-lucide-loader-circle" class="size-4 mr-2 animate-spin" />
            Loading tests…
          </div>
        </template>
      </ClientOnly>
    </div>

    <EmptyState v-else-if="testCases.length === 0" icon="i-lucide-beaker" text="No tests recorded for this run." />

    <EmptyState v-else icon="i-lucide-search-x" text="No tests match your filters.">
      <UButton size="xs" variant="outline" color="neutral" label="Clear filters" @click="clearFilters" />
    </EmptyState>

    <!-- Confirm quarantining a larger selection. -->
    <UModal v-model:open="quarantineConfirmOpen" title="Quarantine selected tests">
      <template #body>
        <p class="text-sm text-muted">
          This quarantines {{ selectedTestCaseIds.length }} tests. Each keeps running and reporting but is excluded from
          the CI gate's verdict until released.
        </p>
        <CoverageLossPreview
          v-if="coverageActive && projectKey != null"
          class="mt-3"
          :answer="quarantineLossFor(selectedTestCaseIds)"
          :project-id="projectKey"
          :project-name="projectName"
        />
      </template>
      <template #footer>
        <div class="flex items-center gap-3 w-full justify-end">
          <UButton color="neutral" variant="ghost" :disabled="bulkBusy" @click="quarantineConfirmOpen = false">
            Cancel
          </UButton>
          <UButton color="warning" :loading="bulkBusy" @click="runBulkQuarantine">
            Quarantine {{ selectedTestCaseIds.length }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
