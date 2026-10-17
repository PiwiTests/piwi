<script setup lang="ts">
/**
 * A project's combined coverage at one commit (`/projects/:id/coverage`
 * without `?file=`), read top to bottom: the share of lines every suite ran
 * together, each suite's share on the same lines and each named area's, then
 * the files. Every bar splits lines the way the source marks do, by the kinds
 * of suite that ran them, in the colors of one legend.
 *
 * The files are an explorer: a foldable tree of the repository, each folder
 * and file with its bar, beside the selected folder (`?folder=`) with its
 * suites and its files with the most lines no suite ran. An area keeps both
 * to its files (`?area=`); the tree sorts by name or by lines not run, kept
 * in this browser. A file opens its view, marked by suite. Every link keeps
 * the commit `?commit=` pinned, the branch and the area. The card's menu
 * exports the commit's combined coverage as LCOV or Cobertura.
 */
import type { CoverageSummary } from '~~/server/utils/coverage-summary';
import { CODE_CHIP_CLASS, SEGMENTED_SELECTED_CLASS, SELECTED_ROW_CLASS } from '~/utils';
import { downloadBlob } from '~/utils/chart-export';
import {
  carriedSentence,
  coverageFileLink,
  coverageLink,
  folderTrail,
  formatCount,
  formatPercent,
  functionsSentence,
  plural,
  splitSentence,
  suiteKindLabel,
  totalsSentence,
  undeterminedSentence,
  type CoverageLinkContext,
} from '~/utils/combined-coverage';

const props = defineProps<{
  projectId: number;
  summary: CoverageSummary;
}>();

const route = useRoute();
const router = useRouter();

const trail = computed(() => folderTrail(props.summary.folder));
const meta = computed(() =>
  [
    undeterminedSentence(props.summary.totals),
    functionsSentence(props.summary.totals),
    splitSentence(props.summary.totals),
  ].filter((line): line is string => !!line),
);

/** What every link keeps: the commit when the page pins one, the branch and the area. */
const linkContext = computed<CoverageLinkContext>(() => ({
  commit: typeof route.query.commit === 'string' && route.query.commit ? props.summary.commit : null,
  branch: typeof route.query.branch === 'string' ? route.query.branch : null,
  area: props.summary.area,
}));

/** A link to this page with other query values, the commit, branch and area kept. */
function pageLink(query: Record<string, string | undefined>) {
  return coverageLink(props.projectId, linkContext.value, query);
}

function fileLink(path: string) {
  return coverageFileLink(props.projectId, linkContext.value, path);
}

function selectFolder(folder: string) {
  void router.replace(pageLink({ folder: folder || undefined }));
}

const ALL_FILES = '__all__';
const areaItems = computed(() => [
  { label: 'Every file', value: ALL_FILES },
  ...props.summary.areas.map((a) => ({ label: a.name, value: a.name })),
]);
function pickArea(value: string) {
  void router.replace(pageLink({ area: value === ALL_FILES ? undefined : value, folder: undefined }));
}

const sort = useLocalStorage<'name' | 'unrun'>('piwi-coverage-tree-sort', 'name', { initOnMounted: true });
const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'unrun', label: 'Least covered' },
] as const;

/** The selected folder's sentence: its share of lines run, and its lines no suite ran. */
const folderSentence = computed(() => {
  const t = props.summary.folderTotals;
  if (t.executableLines === 0) return 'No line to count here.';
  return `${formatPercent(t.linePercent)} of ${plural(t.executableLines, 'line')} ran · ${formatCount(t.unrunLines)} no suite ran.`;
});

const toast = useToast();

/** Download the commit's combined coverage in another tool's format. */
async function exportCoverage(format: 'lcov' | 'cobertura') {
  try {
    const body = await $fetch<string>(`/api/projects/${props.projectId}/coverage-export`, {
      query: { commit: props.summary.commit, format },
      responseType: 'text',
    });
    const name = `piwi-coverage-${props.summary.commit.slice(0, 12)}`;
    downloadBlob(
      new Blob([body], { type: format === 'lcov' ? 'text/plain' : 'application/xml' }),
      format === 'lcov' ? `${name}.info` : `${name}.xml`,
    );
  } catch (error) {
    toast.add({ title: 'Couldn’t export the coverage', description: errorMessage(error), color: 'error' });
  }
}

const exportItems = [
  [
    { label: 'Download LCOV', icon: 'i-lucide-download', onSelect: () => exportCoverage('lcov') },
    { label: 'Download Cobertura', icon: 'i-lucide-download', onSelect: () => exportCoverage('cobertura') },
  ],
];
</script>

<template>
  <div class="space-y-4" data-shot="coverage-overview">
    <SectionCard title="Combined coverage" help="coverage.combined" data-tour="coverage-overview">
      <template #actions>
        <UDropdownMenu :items="exportItems" :content="{ align: 'end' }">
          <UButton
            icon="i-lucide-ellipsis-vertical"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Export the combined coverage"
            title="Export as LCOV or Cobertura"
            data-testid="coverage-export"
          />
        </UDropdownMenu>
      </template>
      <div class="space-y-3">
        <p class="text-sm text-highlighted leading-relaxed" data-testid="coverage-totals">
          At <span :class="CODE_CHIP_CLASS" :title="summary.commit">{{ summary.commit.slice(0, 7) }}</span
          ><template v-if="summary.branch"> on <BranchLabel :name="summary.branch" inherit /></template>:
          {{ totalsSentence(summary) }}
        </p>
        <CoverageBar :counts="summary.totals" size="md" />
        <CoverageClassLegend />
        <ul v-if="meta.length" class="space-y-0.5 text-xs text-muted">
          <li v-for="line in meta" :key="line">{{ line }}</li>
        </ul>
        <StatTileGrid>
          <StatTile
            label="Lines"
            :value="formatPercent(summary.totals.linePercent)"
            :hint="`${formatCount(summary.totals.executedLines)} of ${formatCount(summary.totals.executableLines)}`"
          />
          <StatTile
            label="Functions"
            :value="formatPercent(summary.totals.functionPercent)"
            :hint="`${formatCount(summary.totals.runFunctions)} of ${formatCount(summary.totals.knownFunctions)}`"
          />
          <StatTile
            label="Undetermined"
            :value="formatPercent(summary.totals.undeterminedPercent)"
            hint="in functions that ran"
          />
          <StatTile
            label="Without data"
            :value="summary.filesWithoutData.count ?? '—'"
            :hint="summary.filesWithoutData.count === null ? 'no inventory uploaded' : 'files in scope, greyed below'"
          />
        </StatTileGrid>
      </div>
    </SectionCard>

    <div class="grid gap-4" :class="summary.areas.length ? 'lg:grid-cols-2 lg:items-start' : ''">
      <SectionCard title="Suites" :count="summary.suites.length">
        <ul class="divide-y divide-default" data-testid="coverage-suites">
          <li
            v-for="suite in summary.suites"
            :key="suite.name"
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-2"
            :data-suite="suite.name"
          >
            <div class="min-w-0">
              <p class="truncate font-mono text-sm font-semibold text-highlighted" :title="suite.name">
                {{ suite.name }}
              </p>
              <p class="text-xs text-muted">
                {{ suiteKindLabel(suite.kind)
                }}<template v-if="carriedSentence(suite)"> · {{ carriedSentence(suite) }}</template
                ><template v-if="suite.incomplete"> · incomplete</template>
              </p>
            </div>
            <p class="text-sm tabular-nums text-highlighted text-right">{{ formatPercent(suite.linePercent) }}</p>
            <CoverageBar class="col-span-2" :share="suite.linePercent" :kind="suite.kind" />
            <p v-if="suite.knownFunctions" class="col-span-2 text-xs tabular-nums text-muted">
              {{ formatPercent(suite.functionPercent) }} of functions
            </p>
          </li>
        </ul>
      </SectionCard>

      <SectionCard v-if="summary.areas.length" title="Areas" :count="summary.areas.length" help="coverage.areas">
        <ul class="divide-y divide-default" data-testid="coverage-areas-list">
          <li
            v-for="area in summary.areas"
            :key="area.name"
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-md px-2 py-2"
            :class="summary.area === area.name ? SELECTED_ROW_CLASS : ''"
            :data-area="area.name"
          >
            <div class="min-w-0">
              <NuxtLink
                :to="pageLink({ area: summary.area === area.name ? undefined : area.name, folder: undefined })"
                class="text-sm font-semibold text-highlighted hover:underline"
                :title="summary.area === area.name ? 'Show every file' : `Keep the files to ${area.name}`"
                :aria-current="summary.area === area.name ? 'true' : undefined"
              >
                {{ area.name }}
              </NuxtLink>
              <p class="text-xs text-muted tabular-nums">
                {{ plural(area.files, 'file') }} · {{ plural(area.executableLines, 'line') }}
              </p>
            </div>
            <p class="text-sm tabular-nums text-highlighted text-right">{{ formatPercent(area.linePercent) }}</p>
            <CoverageBar class="col-span-2" :counts="area" />
            <p class="col-span-2 text-xs tabular-nums text-muted">
              <template v-for="(suite, i) in area.suites" :key="suite.name"
                ><template v-if="i > 0"> · </template>{{ suite.name }} {{ formatPercent(suite.linePercent) }}</template
              >
            </p>
          </li>
        </ul>
      </SectionCard>
    </div>

    <SectionCard title="Files" help="coverage.tree">
      <template #actions>
        <USelect
          v-if="summary.areas.length"
          :model-value="summary.area ?? ALL_FILES"
          :items="areaItems"
          size="xs"
          color="neutral"
          class="w-36"
          aria-label="Area"
          data-testid="coverage-area-select"
          @update:model-value="pickArea(String($event))"
        />
        <div
          class="inline-flex shrink-0 gap-0.5 rounded-md bg-elevated/60 p-0.5"
          role="group"
          aria-label="Sort the files by"
        >
          <button
            v-for="option in SORT_OPTIONS"
            :key="option.value"
            type="button"
            class="rounded px-2 py-0.5 text-xs whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary"
            :class="sort === option.value ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'"
            :aria-pressed="sort === option.value ? 'true' : 'false'"
            :data-testid="`coverage-sort-${option.value}`"
            @click="sort = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </template>

      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <CoverageTree
          :project-id="projectId"
          :commit="summary.commit"
          :area="summary.area"
          :selected="summary.folder"
          :sort="sort"
          :link="linkContext"
          class="min-w-0"
          @select="selectFolder"
        />

        <aside
          class="min-w-0 space-y-3 rounded-md border border-default p-3 lg:sticky lg:top-0"
          aria-label="Selected folder"
          data-testid="coverage-folder"
        >
          <nav class="flex flex-wrap items-center gap-1 text-xs text-muted" aria-label="Folder">
            <NuxtLink :to="pageLink({ folder: undefined })" class="hover:underline">Repository</NuxtLink>
            <template v-for="part in trail" :key="part.path">
              <span>/</span>
              <NuxtLink :to="pageLink({ folder: part.path })" class="font-mono hover:underline">{{
                part.name
              }}</NuxtLink>
            </template>
            <template v-if="summary.area"> · in {{ summary.area }}</template>
          </nav>
          <CoverageBar :counts="summary.folderTotals" size="md" />
          <p class="text-sm text-highlighted" data-testid="coverage-folder-totals">{{ folderSentence }}</p>
          <ul v-if="summary.folderTotals.executableLines" class="space-y-1.5" data-testid="coverage-folder-suites">
            <li v-for="suite in summary.folderTotals.suites" :key="suite.name" class="space-y-0.5">
              <p class="flex justify-between gap-2 text-xs">
                <span class="truncate font-mono text-highlighted">{{ suite.name }}</span>
                <span class="tabular-nums text-muted">{{ formatPercent(suite.linePercent) }}</span>
              </p>
              <CoverageBar :share="suite.linePercent" :kind="suite.kind" />
            </li>
          </ul>

          <div v-if="summary.leastCovered.length" class="space-y-1 border-t border-default pt-3">
            <p class="inline-flex items-center gap-1 text-xs font-medium text-muted">
              Least covered here <HelpHint topic="coverage.least-covered" />
            </p>
            <ol class="space-y-1" data-testid="coverage-least-covered">
              <li v-for="entry in summary.leastCovered" :key="entry.path" :data-least-covered="entry.path">
                <NuxtLink
                  :to="fileLink(entry.path)"
                  class="block truncate font-mono text-xs text-primary hover:underline"
                  :title="entry.path"
                >
                  {{ entry.path.slice(summary.folder ? summary.folder.length + 1 : 0) }}
                </NuxtLink>
                <p class="text-xs tabular-nums text-muted">
                  {{ plural(entry.unrunLines, 'line') }} no suite ran · {{ formatPercent(entry.linePercent) }} of
                  {{ formatCount(entry.executableLines) }} ran
                </p>
              </li>
            </ol>
          </div>
        </aside>
      </div>
    </SectionCard>
  </div>
</template>
