<script setup lang="ts">
/**
 * A file's coverage: which of the project's tests run it, line by line
 * (`/projects/:id/coverage?file=<path>`). It reads the file's coverage
 * (`GET /api/projects/:id/coverage`, each test's latest run with coverage on
 * the branch) and shows the version of the file the most tests recorded, or
 * the one `?blob=` names, with a selector when the tests recorded several. The
 * source at that version (`GET /api/projects/:id/source`) marks each line with
 * how many tests ran it, and the executable lines no test runs when a run
 * recorded them; without the source, the lines show as numbers grouped by the
 * tests that ran them. A click on a line (`?line=40`), or a Shift-click for a
 * range (`?line=40-42`), lists the tests that ran it with their latest
 * outcome; on lines no test runs, the nearest test to copy. A file recorded
 * by function marks its functions, and one recorded by file lists its tests
 * only. `?branch=` reads another branch than the default one. On a project
 * that records no coverage the page says so in one sentence.
 *
 * Without `?file=`, the page is the project's combined coverage at a commit
 * (`?commit=`, else the one whose coverage arrived last on `?branch=`),
 * broken down by `?folder=` (`GET /api/projects/:id/coverage-summary`). The file view adds,
 * at the commit, which suites ran the file's lines; with `?marks=suites`, or
 * for a file no test recorded, each line is marked by the kinds of suite that
 * ran it, read from the commit's combined coverage alone. The previous and
 * next range of lines not run (no test, or no suite, ran them) are one click
 * away. Every link
 * between the overview and a file keeps the pinned commit, the branch and
 * the area. The notes on the commit's suites (one carried, one incomplete,
 * only the commit's totals kept) sit above the file.
 */
import { countLines, decodeLineRanges, type LineRange } from '@piwitests/core/coverage';
import { coveragePercent } from '#shared/coverage-combine';
import type { ApiResponse, ProjectDetails } from '~~/types/api';
import { SEGMENTED_SELECTED_CLASS } from '~/utils';
import type { FileCoverage } from '~~/server/utils/coverage';
import { compactFileCoverage, nearestTest } from '#shared/coverage-insights';
import { COVERAGE_PRECISION_LABEL, COVERAGE_PRECISION_TITLE, functionNameAt } from '~/utils/coverage-view';
import {
  fileCoverageSentence,
  fileCoverageVersions,
  fileVersionLabel,
  lineSelectionQuery,
  lineTestCounts,
  nearestTestSentence,
  parseLineSelection,
  testsOnLines,
} from '~/utils/file-coverage';
import { lineRangesText } from '~/utils/suspect-lines';
import {
  coverageLink,
  enclosingFunction,
  fileViewNotes,
  folderTrail,
  formatCount,
  formatPercent,
  rangeSteps,
  plural,
  suitesOnLines,
  type CoverageLinkContext,
} from '~/utils/combined-coverage';
import type { CoverageSummary } from '~~/server/utils/coverage-summary';

type SourceResponse = ApiResponse<typeof import('~~/server/api/projects/[id]/source.get').default>;

const route = useRoute();
const router = useRouter();
const projectId = Number(route.params.id);

const { data: project } = await useFetch<ProjectDetails>(`/api/projects/${projectId}`);
const { state: capabilityState } = await useProjectCapabilities(projectId);
const coverageActive = computed(() => capabilityState('coverage') === 'active');

const file = computed(() => (typeof route.query.file === 'string' ? route.query.file.trim() : ''));
const branch = computed(() =>
  typeof route.query.branch === 'string' && route.query.branch ? route.query.branch : undefined,
);
const fileName = computed(() => file.value.split('/').pop() || 'Coverage');
const commit = computed(() =>
  typeof route.query.commit === 'string' && route.query.commit ? route.query.commit : undefined,
);
const folder = computed(() => (typeof route.query.folder === 'string' ? route.query.folder : undefined));
const area = computed(() => (typeof route.query.area === 'string' && route.query.area ? route.query.area : undefined));

// The combined coverage at the commit: the page's subject without a file, the suites of each line with one.
const {
  data: summary,
  status: summaryStatus,
  error: summaryError,
} = useFetch<CoverageSummary>(`/api/projects/${projectId}/coverage-summary`, {
  server: false,
  lazy: true,
  query: computed(() => ({
    commit: commit.value,
    branch: branch.value,
    folder: file.value ? undefined : folder.value,
    file: file.value || undefined,
    area: file.value ? undefined : area.value,
  })),
});
const summaryLoading = computed(() => summaryStatus.value === 'idle' || summaryStatus.value === 'pending');
/** The overview's first read: a later one, for another folder or area, keeps the overview and its tree in place. */
const summaryFirstLoading = computed(() => summaryLoading.value && !summary.value);
/** What the links back to the overview keep: the commit when the page pins one, the branch and the area. */
const linkContext = computed<CoverageLinkContext>(() => ({
  commit: commit.value ? (summary.value?.commit ?? commit.value) : null,
  branch: branch.value,
  area: area.value,
}));
/** No combined coverage at all: the summary answered 404. */
const noCombined = computed(() => summaryError.value?.statusCode === 404);

useHead(
  computed(() => ({
    title: `${file.value ? `Coverage of ${fileName.value}` : 'Coverage'} — ${project.value?.label || project.value?.name || 'Project'} — Piwi Dashboard`,
  })),
);

// Client-side only: a file many tests run has a large answer, with no place in the SSR payload. The key
// follows the file and the branch, so opening a file from the overview reads it; the overview reads nothing.
const {
  data: coverage,
  status,
  error,
} = useAsyncData<FileCoverage | null>(
  () => `file-coverage-${projectId}-${branch.value ?? ''}-${file.value}`,
  () =>
    coverageActive.value && file.value
      ? $fetch<FileCoverage>(`/api/projects/${projectId}/coverage`, {
          query: { file: file.value, branch: branch.value },
        })
      : Promise.resolve(null),
  { server: false, lazy: true, watch: [coverageActive] },
);

/**
 * The file at the commit's combined coverage: when it is the version the tests
 * recorded, or the tests recorded no version (none ran it, or they recorded it
 * by file only).
 */
const combinedFile = computed(() => {
  const at = summary.value?.file;
  if (!at || !at.blob) return null;
  return !version.value?.blob || at.blob === version.value.blob ? at : null;
});
/** How lines are marked: by the suites of the commit, or by how many tests ran them. */
const marks = computed<'suites' | 'tests'>(() =>
  combinedFile.value && (!version.value?.blob || route.query.marks === 'suites') ? 'suites' : 'tests',
);
const MARK_OPTIONS = [
  { value: 'tests', label: 'By tests' },
  { value: 'suites', label: 'By suites' },
] as const;
function pickMarks(next: 'suites' | 'tests') {
  void router.replace({ query: { ...route.query, marks: next === 'suites' ? 'suites' : undefined } });
}
/** The path and version the page shows: the commit's with marks by suite, else the tests'. */
const shownPath = computed(() => (marks.value === 'suites' ? file.value : (version.value?.path ?? null)));
const shownBlob = computed(() =>
  marks.value === 'suites' ? (combinedFile.value?.blob ?? null) : (version.value?.blob ?? null),
);
const combinedFileSentence = computed(() => {
  const at = combinedFile.value;
  if (!at || !summary.value) return null;
  const executable = countLines(at.executable);
  const ran = formatPercent(coveragePercent(countLines(at.executed), executable));
  const { unitOnly, e2eOnly, both } = at.classes;
  return `With every suite at ${summary.value.commit.slice(0, 7)}: ${ran} of its ${plural(executable, 'line')} ran — unit only ${formatCount(countLines(unitOnly))}, end to end only ${formatCount(countLines(e2eOnly))}, both ${formatCount(countLines(both))}.`;
});
/** The file's lines by class, for its bar. */
const combinedCounts = computed(() => {
  const at = combinedFile.value;
  if (!at) return null;
  return {
    executableLines: countLines(at.executable),
    bothLines: countLines(at.classes.both),
    unitOnlyLines: countLines(at.classes.unitOnly),
    e2eOnlyLines: countLines(at.classes.e2eOnly),
    undeterminedLines: countLines(at.classes.undetermined),
  };
});
/** The file's folders, each a link to the explorer at that folder. */
const fileTrail = computed(() => folderTrail(file.value.split('/').slice(0, -1).join('/')));
const selectionSuites = computed(() =>
  combinedFile.value && selection.value ? suitesOnLines(combinedFile.value.bySuite, selection.value) : null,
);
const selectionSuitesSentence = computed(() => {
  const picked = selection.value;
  const suites = selectionSuites.value;
  if (!picked || !suites) return '';
  const lines = picked[0] === picked[1] ? `Line ${picked[0]}` : `Lines ${picked[0]}–${picked[1]}`;
  return suites.length ? `${lines} ran in ${suites.join(', ')}.` : `No suite ran ${lines.toLowerCase()}.`;
});
const loading = computed(
  () => (coverageActive.value && (status.value === 'idle' || status.value === 'pending')) || summaryLoading.value,
);

const versions = computed(() => (coverage.value ? fileCoverageVersions(coverage.value) : []));
/** `?blob=` value of a version whose coverage names no lines. */
const NO_BLOB = 'none';
const version = computed(() => {
  const wanted = typeof route.query.blob === 'string' ? route.query.blob : null;
  const named = wanted
    ? versions.value.find((v) => (wanted === NO_BLOB ? v.blob === null : v.blob?.startsWith(wanted)))
    : undefined;
  return named ?? versions.value[0] ?? null;
});
const severalPaths = computed(() => new Set(versions.value.map((v) => v.path)).size > 1);
const versionItems = computed(() =>
  versions.value.map((v) => ({ label: fileVersionLabel(v, severalPaths.value), value: v.key })),
);
/** The selected line or range, kept in `?line=`. */
const selection = ref<LineRange | null>(parseLineSelection(route.query.line));
let anchor: number | null = selection.value?.[0] ?? null;
const testsPanel = ref<HTMLElement | null>(null);
// A link to this page with another file or line, followed from the page itself, selects what it names.
watch(
  () => [file.value, route.query.line] as const,
  ([, raw]) => {
    const named = parseLineSelection(raw);
    if (named?.[0] === selection.value?.[0] && named?.[1] === selection.value?.[1]) return;
    selection.value = named;
    anchor = named?.[0] ?? null;
  },
);

function setSelection(next: LineRange | null) {
  selection.value = next;
  void router.replace({ query: { ...route.query, line: next ? lineSelectionQuery(next) : undefined } });
  if (!next) return;
  // Below `lg` the tests sit under the source: bring them into view.
  nextTick(() => {
    const panel = testsPanel.value;
    if (!panel || window.matchMedia('(min-width: 1024px)').matches) return;
    const box = panel.getBoundingClientRect();
    if (box.top > window.innerHeight - 80 || box.bottom < 0)
      panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function pickVersion(key: string) {
  const picked = versions.value.find((v) => v.key === key);
  if (!picked || picked.key === version.value?.key) return;
  selection.value = null;
  void router.replace({ query: { ...route.query, blob: picked.blob ?? NO_BLOB, line: undefined } });
}

/** Select a range of the line groups shown without the source. */
function selectRange(range: LineRange) {
  anchor = range[0];
  setSelection(range);
}

function selectLine(line: number, extend: boolean) {
  if (extend && anchor != null) {
    setSelection([Math.min(anchor, line), Math.max(anchor, line)]);
    return;
  }
  anchor = line;
  const current = selection.value;
  setSelection(current && current[0] === line && current[1] === line ? null : [line, line]);
}

const counts = computed(() => (version.value ? lineTestCounts(version.value) : new Map<number, number>()));
const firstLine = computed(
  () =>
    selection.value?.[0] ??
    (marks.value === 'suites' ? combinedFile.value?.classes.none[0]?.[0] : version.value?.executed[0]?.[0]) ??
    null,
);

/** Lines not run: no test ran them, or no suite with marks by suite. What to cover next. */
const unrunRanges = computed<LineRange[]>(() =>
  marks.value === 'suites' ? (combinedFile.value?.classes.none ?? []) : (version.value?.notExecuted ?? []),
);
const steps = computed(() => rangeSteps(unrunRanges.value, selection.value));
const sourceView = ref<{ reveal: (line: number, flash?: boolean) => void } | null>(null);
function goToRange(range: LineRange | null) {
  if (!range) return;
  anchor = range[0];
  setSelection(range);
  sourceView.value?.reveal(range[0], true);
}
/** Who did not run the lines: no suite with marks by suite, else no test. */
const unrunBy = computed(() => (marks.value === 'suites' ? 'suite' : 'test'));
const unrunSentence = computed(() => {
  const n = unrunRanges.value.length;
  if (n === 0) return marks.value === 'suites' ? 'Every line of this file ran in a suite.' : null;
  const i = steps.value.index;
  if (i === null) {
    const lines = `${plural(countLines(unrunRanges.value), 'line')} no ${unrunBy.value} ran`;
    return n === 1 ? `${lines}.` : `${lines}, in ${n} ranges.`;
  }
  const range = unrunRanges.value[i]!;
  const functions =
    marks.value === 'suites' ? (combinedFile.value?.knownFunctions ?? []) : (version.value?.functions ?? []);
  const fn = enclosingFunction(functions, range[0]);
  const name = fn ? functionNameAt(sourceLines.value?.[fn[0] - 1]) : null;
  const lines = range[0] === range[1] ? `line ${range[0]}` : `lines ${range[0]}–${range[1]}`;
  return `Lines no ${unrunBy.value} ran, range ${i + 1} of ${n} · ${lines}${name ? ` · in ${name}` : ''}`;
});

// The source at the version shown, read when the version changes.
const source = ref<string | null>(null);
const sourcePending = ref(false);
watch(
  () => [shownPath.value, shownBlob.value] as const,
  async ([path, blob], _old, onCleanup) => {
    let stale = false;
    onCleanup(() => (stale = true));
    source.value = null;
    if (!path || !blob) {
      sourcePending.value = false;
      return;
    }
    sourcePending.value = true;
    const read = await $fetch<SourceResponse>(`/api/projects/${projectId}/source`, { query: { path, blob } }).catch(
      () => null,
    );
    if (stale) return;
    source.value = read?.content ?? null;
    sourcePending.value = false;
  },
  { immediate: true },
);
const sourceLines = computed(() => source.value?.split('\n') ?? null);

/**
 * Without the source: the version's lines grouped by the exact tests that ran
 * them, most tests first, then the executable lines no test runs.
 */
const lineGroups = computed(() => {
  const v = version.value;
  const view = coverage.value;
  if (!v || !view || source.value !== null) return [];
  const [compact] = compactFileCoverage({ ...view, fragments: v.fragments, executable: [] }).versions;
  const groups = (compact?.lines ?? compact?.functions ?? []).map((group) => ({
    ranges: decodeLineRanges(group.lines),
    tests: group.tests.length,
  }));
  if (v.notExecuted?.length) groups.push({ ranges: v.notExecuted, tests: 0 });
  return groups;
});
const groupTestsText = (n: number) => (n === 0 ? 'run by no test' : `${n} test${n === 1 ? '' : 's'}`);

/** On lines no test runs, the test that runs most of the code around them. */
const nearest = computed(() => {
  const v = version.value;
  const view = coverage.value;
  const picked = selection.value;
  if (!v?.blob || !view || !picked || testsOnLines(v, picked).length > 0) return null;
  const fragments = view.fragments.filter((f) => f.path === v.path && f.runtime === v.runtime);
  return nearestTest({ fragments, tests: view.tests }, [picked], { blob: v.blob });
});
const nearestSentence = computed(() => {
  if (!nearest.value || !selection.value) return null;
  const start = nearest.value.function?.[0];
  const name = start ? functionNameAt(sourceLines.value?.[start - 1]) : null;
  return nearestTestSentence(nearest.value, selection.value, name);
});
</script>

<template>
  <UDashboardPanel id="project-coverage">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav
            :items="[
              { label: 'Home', icon: 'i-lucide-house', to: '/' },
              { label: 'Projects', to: '/projects' },
              { label: project?.label || project?.name || 'Project', to: `/projects/${projectId}` },
              file ? { label: 'Coverage', to: coverageLink(projectId, linkContext) } : { label: 'Coverage' },
              ...(file ? [{ label: fileName }] : []),
            ]"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="!file" class="p-4 space-y-4">
        <LoadingState v-if="summaryFirstLoading" text="Combining the suites’ coverage…" />
        <EmptyState
          v-else-if="noCombined"
          text="No combined coverage yet: upload a suite’s coverage report with piwi coverage upload, or record run coverage with the reporter."
        />
        <ErrorState v-else-if="summaryError || !summary" text="The combined coverage could not be read." />
        <ProjectCoverageOverview v-else :project-id="projectId" :summary="summary" :aria-busy="summaryLoading" />
      </div>
      <div v-else class="p-4 space-y-4" data-shot="coverage-file">
        <LoadingState v-if="loading" text="Reading the file’s coverage…" />
        <EmptyState v-else-if="!coverageActive && !combinedFile" text="This project records no coverage." />
        <ErrorState v-else-if="error && !combinedFile" text="The coverage of this file could not be read." />
        <template v-else-if="!version && !combinedFile">
          <CoverageDataNotes
            v-if="summary"
            :project-id="projectId"
            :notes="fileViewNotes(summary.notes)"
            :branch="summary.branch"
            :link="{ branch: linkContext.branch, area: linkContext.area }"
          />
          <EmptyState
            :text="
              summary?.detailRemoved
                ? `Only the totals of ${summary.commit.slice(0, 7)} are kept, and no test recorded coverage of ${file} on ${coverage?.branch ?? 'this branch'}.`
                : `No test or suite recorded coverage of ${file} on ${coverage?.branch ?? 'this branch'}.`
            "
          />
        </template>

        <template v-else>
          <CoverageDataNotes
            v-if="summary"
            :project-id="projectId"
            :notes="fileViewNotes(summary.notes)"
            :branch="summary.branch"
            :link="{ branch: linkContext.branch, area: linkContext.area }"
          />
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0 space-y-1">
              <nav class="flex flex-wrap items-center gap-1 text-xs text-muted" aria-label="Folder">
                <NuxtLink :to="coverageLink(projectId, linkContext)" class="hover:underline">Repository</NuxtLink>
                <template v-for="part in fileTrail" :key="part.path">
                  <span>/</span>
                  <NuxtLink
                    :to="coverageLink(projectId, linkContext, { folder: part.path })"
                    class="font-mono hover:underline"
                    >{{ part.name }}</NuxtLink
                  >
                </template>
              </nav>
              <p class="text-sm text-highlighted break-words" data-testid="coverage-file-path">
                <OpenInIdeLink
                  :file-path="shownPath ?? file"
                  :line="firstLine"
                  :project-key="projectId"
                  :project-name="project?.name"
                  >{{ shownPath ?? file }}</OpenInIdeLink
                >
              </p>
              <p
                v-if="version && coverage"
                class="text-sm text-highlighted leading-relaxed"
                data-testid="coverage-file-summary"
              >
                {{ fileCoverageSentence(version, coverage.branch) }}
              </p>
              <p
                v-if="combinedFileSentence"
                class="text-sm text-highlighted leading-relaxed"
                data-testid="coverage-file-combined"
              >
                {{ combinedFileSentence }}
                <template v-if="selectionSuites">
                  {{ selectionSuitesSentence }}
                </template>
              </p>
              <CoverageBar v-if="combinedCounts && marks === 'suites'" :counts="combinedCounts" class="max-w-md" />
              <p class="text-xs text-muted inline-flex flex-wrap items-center gap-x-1">
                <span v-if="marks === 'suites'">Marked by the suites that ran each line</span>
                <template v-else-if="version">
                  <span>{{ version.runtime === 'server' ? 'Server file' : 'Browser file' }}</span>
                  ·
                  <span :title="COVERAGE_PRECISION_TITLE[version.granularity]"
                    >recorded {{ COVERAGE_PRECISION_LABEL[version.granularity] }}</span
                  >
                </template>
                <template v-if="shownBlob">
                  · version <span class="font-mono">{{ shownBlob.slice(0, 7) }}</span>
                </template>
                <HelpHint topic="coverage.file" />
              </p>
            </div>
            <div class="flex flex-col gap-2 sm:items-end shrink-0">
              <div
                v-if="version?.blob && combinedFile"
                class="inline-flex shrink-0 gap-0.5 rounded-md bg-elevated/60 p-0.5"
                role="group"
                aria-label="Mark lines by"
                data-testid="coverage-file-marks"
              >
                <button
                  v-for="option in MARK_OPTIONS"
                  :key="option.value"
                  type="button"
                  class="rounded px-2 py-0.5 text-xs whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary"
                  :class="marks === option.value ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'"
                  :aria-pressed="marks === option.value ? 'true' : 'false'"
                  @click="pickMarks(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
              <USelect
                v-if="versions.length > 1 && version"
                :model-value="version.key"
                :items="versionItems"
                color="neutral"
                size="sm"
                icon="i-lucide-git-commit-horizontal"
                class="w-full sm:w-64"
                aria-label="Version"
                title="The tests recorded several versions of this file; line numbers belong to one"
                data-testid="coverage-file-version"
                @update:model-value="pickVersion(String($event))"
              />
            </div>
          </div>

          <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
            <div v-if="shownBlob" class="min-w-0 space-y-2">
              <div
                v-if="unrunSentence"
                class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted"
                data-testid="coverage-file-unrun"
              >
                <span class="tabular-nums">{{ unrunSentence }}</span>
                <span v-if="unrunRanges.length" class="inline-flex gap-1">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-chevron-up"
                    :disabled="!steps.previous"
                    :title="`The previous lines no ${unrunBy} ran`"
                    data-testid="coverage-unrun-previous"
                    @click="goToRange(steps.previous)"
                    >Previous range</UButton
                  >
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    trailing-icon="i-lucide-chevron-down"
                    :disabled="!steps.next"
                    :title="`The next lines no ${unrunBy} ran`"
                    data-testid="coverage-unrun-next"
                    @click="goToRange(steps.next)"
                    >Next range</UButton
                  >
                </span>
              </div>
              <LoadingState v-if="sourcePending" text="Reading the source…" />
              <CoverageSourceView
                v-else-if="marks === 'suites' && combinedFile"
                ref="sourceView"
                :key="`suites-${combinedFile.blob}`"
                :path="shownPath ?? file"
                :content="source"
                :executed="combinedFile.executed"
                :not-executed="combinedFile.classes.none"
                :functions="combinedFile.runFunctions"
                :classes="combinedFile.classes"
                :focus-line="firstLine"
                :selected="selection ? [selection] : []"
                selectable
                scroll-class="max-h-[60vh] lg:max-h-[calc(100vh-14rem)]"
                executed-title="Ran in a suite"
                not-executed-title="Ran in no suite"
                @select-line="selectLine"
              />
              <CoverageSourceView
                v-else-if="version && source !== null"
                ref="sourceView"
                :key="version.key"
                :path="version.path"
                :content="source"
                :executed="version.executed"
                :not-executed="version.notExecuted"
                :functions="version.functions"
                :focus-line="firstLine"
                :selected="selection ? [selection] : []"
                selectable
                scroll-class="max-h-[60vh] lg:max-h-[calc(100vh-14rem)]"
                :executed-title="version.granularity === 'lines' ? 'Run by a test' : 'In a function a test ran'"
                not-executed-title="Run by no test"
                @select-line="selectLine"
              >
                <template #annotation="{ line, executed, notExecuted }">
                  <button
                    v-if="executed || notExecuted"
                    type="button"
                    class="inline-block min-w-6 rounded text-right tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1"
                    :class="executed ? 'text-highlighted' : 'text-muted'"
                    :data-tests="counts.get(line) ?? 0"
                    :aria-label="`Line ${line}: ${counts.get(line) ?? 0} test${counts.get(line) === 1 ? '' : 's'}`"
                    @click.stop="selectLine(line, $event.shiftKey)"
                  >
                    {{ counts.get(line) ?? 0 }}
                  </button>
                  <span v-else class="inline-block min-w-6" />
                </template>
              </CoverageSourceView>
              <div v-else class="space-y-3" data-testid="coverage-file-no-source">
                <p class="text-xs text-muted inline-flex items-center gap-1">
                  The repository could not serve this version of the file, so its lines show as numbers.
                  <HelpHint topic="coverage.file-source" />
                </p>
                <ul class="rounded-md border border-default divide-y divide-default">
                  <li v-for="group in lineGroups" :key="group.ranges[0]![0]">
                    <button
                      type="button"
                      class="flex w-full flex-wrap items-baseline gap-x-3 px-3 py-1.5 text-left hover:bg-elevated/60"
                      :class="
                        selection && selection[0] === group.ranges[0]![0] && selection[1] === group.ranges[0]![1]
                          ? 'bg-elevated'
                          : ''
                      "
                      :data-line-group="lineRangesText(group.ranges)"
                      :title="`Show the tests of ${lineRangesText(group.ranges.slice(0, 1))}`"
                      @click="selectRange(group.ranges[0]!)"
                    >
                      <span class="text-sm text-highlighted">{{ lineRangesText(group.ranges) }}</span>
                      <span class="text-xs text-muted">{{ groupTestsText(group.tests) }}</span>
                    </button>
                  </li>
                </ul>
              </div>
            </div>

            <div
              ref="testsPanel"
              class="min-w-0 lg:sticky lg:top-0 scroll-mt-4"
              :class="shownBlob ? '' : 'lg:col-span-2'"
            >
              <FileCoverageTests
                v-if="version && coverage && (marks === 'tests' || version.blob)"
                :project-id="projectId"
                :project-name="project?.name"
                :tests="coverage.tests"
                :version="version"
                :selection="selection"
                :nearest="nearest"
                :nearest-sentence="nearestSentence"
                @clear="setSelection(null)"
              />
              <SectionCard v-else title="Suites on these lines" data-testid="coverage-file-suites">
                <p class="text-sm text-highlighted">
                  {{
                    selectionSuites
                      ? selectionSuitesSentence
                      : version
                        ? 'Select a line to see which suites ran it. The tests recorded this file by file only.'
                        : 'Select a line to see which suites ran it. No end-to-end test recorded this file.'
                  }}
                </p>
              </SectionCard>
              <FileTestMapCard :project-id="projectId" :path="shownPath ?? file" class="mt-4" />
            </div>
          </div>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
