<script setup lang="ts">
import type { ApiResponse, TestCasesPage, TestCaseWithStats } from '~~/types/api';
import type { TestCasesSort } from '#shared/handlers/projects';
import {
  CATALOG_SEARCH_FIELDS,
  formatTestSearchTerm,
  parseTestSearch,
  testSearchHighlights,
  type TestSearchValues,
} from '#shared/test-search';
import { parseLockFilter, parseTagFilter } from '#shared/utils/tag-filter';
import { splitSuitePath } from '#shared/utils/suites';
import { buildTestRowBadges } from '~/utils/test-row-badges';
import { fileGroupRows, type TestPosition } from '~/utils/test-list-order';
import { projectRunScopeQuery, type ProjectRunScope } from '#shared/project-run-scope';

const props = defineProps<{
  projectId: string | number;
  /** Project name — forwarded to OpenInIdeLink for the JetBrains project hint. */
  projectName?: string | null;
  /** Mirror search/filter/sort/page state into the route query (shareable URLs, survives tab switches). */
  syncQuery?: boolean;
  /** The project page's run scope: each test's numbers count its runs only. */
  scope?: ProjectRunScope | null;
}>();

const emit = defineEmits<{ total: [total: number] }>();

const route = useRoute();
const router = useRouter();

// Group by File (and File + Describe) shows each file's numbers as headers;
// None is the flat, paged list.
const GROUP_OPTIONS = ['none', 'file', 'file-describe'] as const;
type GroupBy = (typeof GROUP_OPTIONS)[number];
const { raw: groupByRaw, set: setGroupBy } = useGroupByCookie('project-test-cases', GROUP_OPTIONS);
const groupBy = computed<GroupBy>({
  get: () => (groupByRaw.value as GroupBy) ?? 'none',
  set: (v) => setGroupBy(v),
});
const grouped = computed(() => groupBy.value !== 'none');
/** The describe blocks are on the row unless the grouping shows them as headers. */
const showSuitePath = computed(() => groupBy.value !== 'file-describe');
const GROUP_BY_ITEMS = [
  { label: 'File', value: 'file' },
  { label: 'File + Describe', value: 'file-describe' },
  { label: 'None', value: 'none' },
];

const GROUP_LIMIT = 1000;
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [
  { label: '10 / page', value: 10 },
  { label: '25 / page', value: 25 },
  { label: '50 / page', value: 50 },
  { label: '100 / page', value: 100 },
];
const AGE_OPTIONS = [
  { label: 'Last 7 days', value: 7 },
  { label: 'Last 30 days', value: 30 },
  { label: 'Last 90 days', value: 90 },
  { label: 'Last year', value: 365 },
  { label: 'All time', value: 0 },
];
const STATUS_OPTIONS = [
  { label: 'Passed', value: 'passed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Flaky', value: 'flaky' },
  { label: 'Skipped', value: 'skipped' },
  { label: "Didn't run", value: 'didnotrun' },
] as const;

// File order is where each test is declared: file, then line — the order
// Playwright lists and runs them. Each sort starts in its useful direction.
const DEFAULT_SORT: TestCasesSort = 'file';
const SORT_DIRECTIONS: Record<TestCasesSort, 'asc' | 'desc'> = {
  file: 'asc',
  lastRun: 'desc',
  title: 'asc',
  status: 'asc',
  totalRuns: 'desc',
  passRate: 'asc',
  avgDuration: 'desc',
};
const SORT_OPTIONS: { label: string; value: TestCasesSort }[] = [
  { label: 'File order', value: 'file' },
  { label: 'Last run', value: 'lastRun' },
  { label: 'Test', value: 'title' },
  { label: 'Status', value: 'status' },
  { label: 'Runs', value: 'totalRuns' },
  { label: 'Pass rate', value: 'passRate' },
  { label: 'Avg duration', value: 'avgDuration' },
];

// The public demo's seed data is anchored at a fixed past date, so an age
// window would render the catalog empty there — default to all time instead.
const defaultAge = useRuntimeConfig().public.demoMode ? 0 : 30;

// With `syncQuery` the URL holds the search, filters, sort and page. A URL that
// names none of them (the project page reached from a breadcrumb or a link)
// takes the ones the catalog last had, kept for the page (`useViewState`).
const CATALOG_QUERY_KEYS = ['q', 'status', 'tags', 'locks', 'owner', 'age', 'sort', 'dir', 'page', 'pageSize'];
const savedQuery = useViewState<Record<string, string>>('catalog:query', () => ({}));
const restoringSavedQuery =
  props.syncQuery &&
  !CATALOG_QUERY_KEYS.some((key) => route.query[key] != null) &&
  Object.keys(savedQuery.value).length > 0;
const init: Record<string, unknown> = props.syncQuery ? (restoringSavedQuery ? savedQuery.value : route.query) : {};

/**
 * The `tags`, `locks` and `owner` URL parameters, as search qualifiers: links
 * that filter the catalog by them keep working and show up in the search box.
 */
function qualifiersFromUrl(query: Record<string, unknown>): string {
  const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const terms = [
    ...parseTagFilter(str(query.tags)).map((tag) => formatTestSearchTerm('tag', tag)),
    ...parseLockFilter(str(query.locks)).map((lock) => formatTestSearchTerm('lock', lock)),
  ];
  const owner = str(query.owner)?.trim();
  if (owner) terms.push(formatTestSearchTerm('owner', owner));
  return terms.join(' ');
}

const page = ref(Math.max(1, Number(init.page) || 1));
const q = ref([typeof init.q === 'string' ? init.q.trim() : '', qualifiersFromUrl(init)].filter(Boolean).join(' '));
const searchInput = ref(q.value);
const statuses = ref<string[]>(typeof init.status === 'string' ? init.status.split(',').filter(Boolean) : []);
const age = ref(typeof init.age === 'string' && init.age !== '' ? Math.max(0, Number(init.age) || 0) : defaultAge);
const sort = ref<TestCasesSort>(
  SORT_OPTIONS.some((o) => o.value === init.sort) ? (init.sort as TestCasesSort) : DEFAULT_SORT,
);
const dir = ref<'asc' | 'desc'>(init.dir === 'asc' || init.dir === 'desc' ? init.dir : SORT_DIRECTIONS[sort.value]);
/** Picking a sort starts it in its own direction. */
const sortModel = computed<TestCasesSort>({
  get: () => sort.value,
  set: (value) => {
    sort.value = value;
    dir.value = SORT_DIRECTIONS[value];
  },
});
const initialPageSize = Number(init.pageSize);
const pageSize = ref(PAGE_SIZE_OPTIONS.some((o) => o.value === initialPageSize) ? initialPageSize : DEFAULT_PAGE_SIZE);

watch(
  searchInput,
  useDebounceFn((value: string) => {
    q.value = value.trim();
  }, 300),
);
const scopeQuery = computed(() => (props.scope ? projectRunScopeQuery(props.scope) : {}));

// A scope that is rebuilt with the same values is not a change, so the page stays.
watch([q, statuses, age, sort, dir, pageSize, grouped, () => JSON.stringify(scopeQuery.value)], () => {
  page.value = 1;
});

const query = computed(() => ({
  limit: grouped.value ? GROUP_LIMIT : pageSize.value,
  offset: grouped.value ? 0 : (page.value - 1) * pageSize.value,
  ...(q.value ? { q: q.value } : {}),
  ...(statuses.value.length > 0 ? { status: statuses.value.join(',') } : {}),
  maxAgeDays: age.value,
  sort: sort.value,
  dir: dir.value,
  ...scopeQuery.value,
}));

const { data, status, error, refresh } = useFetch<TestCasesPage>(`/api/projects/${props.projectId}/test-cases`, {
  query,
});

watch(
  () => data.value?.total,
  (total) => {
    if (total != null) emit('total', total);
  },
  { immediate: true },
);

if (props.syncQuery) {
  const syncUrl = () => {
    const catalogQuery = {
      q: q.value || undefined,
      status: statuses.value.length > 0 ? statuses.value.join(',') : undefined,
      age: age.value !== defaultAge ? String(age.value) : undefined,
      sort: sort.value !== DEFAULT_SORT ? sort.value : undefined,
      dir: dir.value !== SORT_DIRECTIONS[sort.value] ? dir.value : undefined,
      page: page.value > 1 ? String(page.value) : undefined,
      pageSize: pageSize.value !== DEFAULT_PAGE_SIZE ? String(pageSize.value) : undefined,
    };
    savedQuery.value = Object.fromEntries(
      Object.entries(catalogQuery).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    // `tags`, `locks` and `owner` are folded into the search.
    void replaceQuery(router, { ...catalogQuery, tags: undefined, locks: undefined, owner: undefined });
  };
  watch([q, statuses, age, sort, dir, page, pageSize], syncUrl);
  // A link that filtered by tags, locks or owner shows them as search terms, and
  // a catalog restored from the page's view state shows its filters, in the URL too.
  onMounted(() => {
    if (restoringSavedQuery || route.query.tags != null || route.query.locks != null || route.query.owner != null)
      syncUrl();
  });
}

function toggleStatus(value: string) {
  statuses.value = statuses.value.includes(value)
    ? statuses.value.filter((s) => s !== value)
    : [...statuses.value, value];
}

function toggleDir() {
  dir.value = dir.value === 'asc' ? 'desc' : 'asc';
}

// ── Search completion and highlighting ─────────────────────────────────────────
// The values each qualifier can take (files, describe blocks, tags…) come from
// the whole catalog, fetched the first time the search box is focused.
type FacetsResponse = ApiResponse<typeof import('~~/server/api/projects/[id]/test-cases/facets.get').default>;
const searchValues = ref<TestSearchValues | null>(null);
/** The age window and run scope the loaded values cover. */
let facetsKey: string | null = null;
async function loadFacets() {
  const query = { maxAgeDays: age.value, ...scopeQuery.value };
  const key = JSON.stringify(query);
  if (facetsKey === key) return;
  facetsKey = key;
  try {
    const response = await $fetch<FacetsResponse>(`/api/projects/${props.projectId}/test-cases/facets`, { query });
    if (facetsKey === key) searchValues.value = response.values as TestSearchValues;
  } catch {
    // Completion falls back to the qualifiers alone.
    facetsKey = null;
  }
}
watch([age, scopeQuery], () => {
  if (facetsKey !== null) loadFacets();
});

/** What the applied search matched, marked in each row. */
const searchHighlights = computed(() => {
  const parsed = parseTestSearch(q.value, CATALOG_SEARCH_FIELDS);
  return parsed.terms.length > 0 ? testSearchHighlights(parsed) : null;
});

/** Tags and ownership metadata rendered as the row's badges. */
function catalogBadges(tc: TestCaseWithStats) {
  return buildTestRowBadges({
    tags: tc.tags,
    locks: tc.locks,
    meta: {
      owner: tc.owner ?? undefined,
      priority: toTestPriority(tc.priority),
      feature: tc.feature ?? undefined,
    },
  });
}

/** `file:line:column` when a run reported where the test is, so the IDE opens at it. */
function catalogLocation(tc: TestCaseWithStats): string | null {
  return tc.line != null ? `${tc.filePath}:${tc.line}:${tc.column ?? 1}` : null;
}

const items = computed(() => data.value?.items ?? []);
const total = computed(() => data.value?.total ?? 0);
const showingFrom = computed(() => (total.value === 0 ? 0 : (page.value - 1) * pageSize.value + 1));
const showingTo = computed(() =>
  grouped.value ? items.value.length : Math.min(page.value * pageSize.value, total.value),
);

// ── Group by File / File + Describe ──────────────────────────────────────────
// The rows keep the server's sort inside each group; under file order the
// describe blocks sit among the tests where they are declared.
const suitePathCache = new WeakMap<TestCaseWithStats, string[]>();
function suitePathOf(tc: TestCaseWithStats): string[] {
  let path = suitePathCache.get(tc);
  if (!path) {
    path = splitSuitePath(tc.suitePath);
    suitePathCache.set(tc, path);
  }
  return path;
}

function positionOf(tc: TestCaseWithStats): TestPosition {
  return { filePath: tc.filePath, suitePath: suitePathOf(tc), line: tc.line, column: tc.column, startedAt: null };
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** A group's numbers, from the rows under it: the same window as the rows themselves. */
function groupMetrics(rows: TestCaseWithStats[]) {
  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let runs = 0;
  let durationTotal = 0;
  let timedRuns = 0;
  for (const row of rows) {
    passed += row.passedRuns;
    failed += row.failedRuns;
    flaky += row.flakyRuns;
    runs += row.totalRuns;
    const executed = row.totalRuns - row.skippedRuns - row.didNotRunRuns;
    if (row.avgDuration != null && executed > 0) {
      durationTotal += row.avgDuration * executed;
      timedRuns += executed;
    }
  }
  const executed = passed + failed;
  const passRate = executed > 0 ? passed / executed : null;
  return [
    {
      label: 'Pass',
      value: passRate != null ? `${Math.round(passRate * 100)}%` : '—',
      // A group whose executions were all skipped has no pass rate to judge.
      tone: passRate != null ? passRateTone(passRate * 100) : ('muted' as const),
    },
    { label: 'Flaky', value: executed > 0 ? `${Math.round((flaky / executed) * 100)}%` : '—', tone: 'muted' as const },
    { label: 'Failures', value: String(failed), tone: failed > 0 ? ('poor' as const) : ('muted' as const) },
    { label: 'Executions', value: String(runs), tone: 'muted' as const },
    { label: 'Avg', value: timedRuns > 0 ? formatMs(durationTotal / timedRuns) : '—', tone: 'muted' as const },
  ];
}

const collapsedGroupKeys = useViewState<string[]>('catalog:collapsed-groups', () => []);
const collapsedGroups = computed(() => new Set(collapsedGroupKeys.value));
function toggleGroup(key: string) {
  const next = new Set(collapsedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedGroupKeys.value = [...next];
}

const hasSearchOrStatusFilter = computed(() => q.value !== '' || statuses.value.length > 0);
const hasAnyFilter = computed(() => hasSearchOrStatusFilter.value || age.value !== 0);

// A search or status filter opens every group, so no match hides behind a closed header.
function isOpen(key: string): boolean {
  return hasSearchOrStatusFilter.value || !collapsedGroups.value.has(key);
}

const groupRows = computed(() => {
  if (!grouped.value) return [];
  const serverOrder = new Map(items.value.map((tc, index) => [tc.id, index]));
  return fileGroupRows(items.value, {
    describe: groupBy.value === 'file-describe',
    position: positionOf,
    compare: (a, b) => serverOrder.get(a.id)! - serverOrder.get(b.id)!,
    positional: sort.value === 'file',
    isOpen,
    testKey: (tc) => `t${tc.id}`,
  }).map((row) => (row.kind === 'group' ? { ...row, metrics: groupMetrics(row.tests) } : row));
});

/** Clears every filter but the age window, which has its own "Show all time". */
function clearFilters() {
  searchInput.value = '';
  q.value = '';
  statuses.value = [];
}
const initialLoading = computed(() => status.value === 'pending' && !data.value);

defineExpose({ refresh });
</script>

<template>
  <SectionCard
    title="Tests"
    icon="i-lucide-flask-conical"
    :count="data?.total"
    help="project.test-cases"
    data-shot="test-cases-catalog"
  >
    <template #actions>
      <UButton
        icon="i-lucide-refresh-cw"
        size="sm"
        color="neutral"
        variant="ghost"
        aria-label="Refresh tests"
        :loading="status === 'pending' && !!data"
        @click="() => refresh()"
      />
    </template>

    <!-- Filters, in two rows: the search (words and file:, describe:, tag:…
         qualifiers) with the age window, then outcomes. How the rows are
         grouped and sorted sits on the list's own header. -->
    <div class="mb-3 space-y-2">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
        <TestSearchInput
          v-model="searchInput"
          :fields="CATALOG_SEARCH_FIELDS"
          :values="searchValues"
          placeholder="Search tests, or filter with file:, describe:, tag:…"
          class="w-full sm:flex-1"
          @focus="loadFacets"
        />
        <USelect v-model="age" :items="AGE_OPTIONS" size="sm" class="w-full sm:w-36" aria-label="Last run age filter" />
      </div>

      <div class="flex flex-wrap items-center gap-1">
        <StatusFilterChip
          v-for="opt in STATUS_OPTIONS"
          :key="opt.value"
          :status="opt.value"
          :label="opt.label"
          :pressed="statuses.includes(opt.value)"
          @click="toggleStatus(opt.value)"
        />
        <UButton
          v-if="hasSearchOrStatusFilter"
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

    <LoadingState v-if="initialLoading" text="Loading test cases..." />

    <ErrorState v-else-if="error" :text="errorMessage(error, 'Failed to load test cases')">
      <template #action>
        <UButton size="sm" variant="outline" @click="() => refresh()">Retry</UButton>
      </template>
    </ErrorState>

    <template v-else-if="total === 0">
      <EmptyState v-if="!hasAnyFilter" icon="i-lucide-flask-conical" text="No test cases yet for this project." />
      <EmptyState v-else icon="i-lucide-search-x" text="No test cases match your filters.">
        <div class="mt-3 flex items-center justify-center gap-2">
          <UButton v-if="age !== 0" size="sm" variant="outline" @click="age = 0">Show all time</UButton>
          <UButton v-if="hasSearchOrStatusFilter" size="sm" variant="ghost" @click="clearFilters"
            >Clear filters</UButton
          >
        </div>
      </EmptyState>
    </template>

    <template v-else>
      <div :class="{ 'opacity-60 pointer-events-none': status === 'pending' }" class="transition-opacity">
        <UAlert
          v-if="grouped && items.length < total"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          class="mb-3"
          :title="`Showing the first ${items.length} of ${total} tests — narrow the search or filters to see the rest.`"
        />
        <div class="rounded-lg border border-default overflow-hidden">
          <!-- List header: the count on the left, how the rows are grouped and
               sorted on the right. -->
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-default bg-elevated/40 px-3 py-1.5">
            <span class="text-xs text-muted tabular-nums">{{ total }} {{ total === 1 ? 'test' : 'tests' }}</span>
            <div class="grid w-full grid-cols-2 gap-2 sm:ml-auto sm:flex sm:w-auto sm:items-center sm:gap-3">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="text-xs text-muted whitespace-nowrap">Group by</span>
                <USelect
                  v-model="groupBy"
                  :items="GROUP_BY_ITEMS"
                  size="xs"
                  class="min-w-0 flex-1 sm:w-32 sm:flex-none"
                  aria-label="Group tests by"
                />
              </div>
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="text-xs text-muted">Sort</span>
                <USelect
                  v-model="sortModel"
                  :items="SORT_OPTIONS"
                  size="xs"
                  class="min-w-0 flex-1 sm:w-32 sm:flex-none"
                  aria-label="Sort by"
                />
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="dir === 'asc' ? 'i-lucide-arrow-up' : 'i-lucide-arrow-down'"
                  :title="dir === 'asc' ? 'Ascending' : 'Descending'"
                  aria-label="Toggle sort direction"
                  @click="toggleDir"
                />
              </div>
            </div>
          </div>

          <!-- Group by File (+ Describe): a header per file and describe block, with its numbers -->
          <template v-if="grouped">
            <template v-for="row in groupRows" :key="row.key">
              <TestRowGroup
                v-if="row.kind === 'group'"
                :label="row.label"
                :count="row.tests.length"
                :open="isOpen(row.key)"
                :depth="row.depth"
                :metrics="row.metrics"
                :icon="row.isFile ? 'i-lucide-file-code-2' : 'i-lucide-folder'"
                :file-path="row.isFile ? row.filePath : null"
                :highlight="row.isFile ? searchHighlights?.file : searchHighlights?.describe"
                :project-key="projectId"
                :project-name="projectName"
                @toggle="toggleGroup(row.key)"
              />
              <TestRow
                v-else
                :href="`/test-cases/${row.test.id}`"
                :title="row.test.title"
                :display-title="row.test.displayTitle"
                :external-id="row.test.externalId"
                :status="row.test.status"
                :location="catalogLocation(row.test)"
                :file-path="catalogLocation(row.test) ? null : row.test.filePath"
                :suite-path="showSuitePath ? suitePathOf(row.test) : null"
                :highlight="searchHighlights"
                :badges="catalogBadges(row.test)"
                :indent="row.depth * 16"
                :project-key="projectId"
                :project-name="projectName"
              >
                <template #metrics>
                  <CatalogRowFacts :tc="row.test" />
                </template>
              </TestRow>
            </template>
          </template>

          <!-- Flat list: one TestRow per test -->
          <template v-else>
            <TestRow
              v-for="tc in items"
              :key="tc.id"
              :href="`/test-cases/${tc.id}`"
              :title="tc.title"
              :display-title="tc.displayTitle"
              :external-id="tc.externalId"
              :status="tc.status"
              :location="catalogLocation(tc)"
              :file-path="catalogLocation(tc) ? null : tc.filePath"
              :suite-path="suitePathOf(tc)"
              :highlight="searchHighlights"
              :badges="catalogBadges(tc)"
              :project-key="projectId"
              :project-name="projectName"
            >
              <template #metrics>
                <CatalogRowFacts :tc="tc" />
              </template>
            </TestRow>
          </template>
        </div>

        <template v-if="!grouped">
          <!-- Pagination footer -->
          <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-sm text-muted tabular-nums"
                >Showing {{ showingFrom }}–{{ showingTo }} of {{ total }}</span
              >
              <div class="flex items-center gap-1.5">
                <span class="text-sm text-muted">Rows per page</span>
                <USelect
                  v-model="pageSize"
                  :items="PAGE_SIZE_OPTIONS"
                  size="sm"
                  class="w-28"
                  aria-label="Rows per page"
                />
              </div>
            </div>
            <UPagination
              v-if="total > pageSize"
              v-model:page="page"
              :total="total"
              :items-per-page="pageSize"
              size="sm"
            />
          </div>
        </template>
      </div>
    </template>
  </SectionCard>
</template>
