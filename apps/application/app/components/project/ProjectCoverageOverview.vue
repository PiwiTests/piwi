<script setup lang="ts">
/**
 * A project's combined coverage at one commit (`/projects/:id/coverage`
 * without `?file=`): the share of lines and functions every suite ran
 * together, each suite's share on the same lines, then a folder's files and
 * folders with theirs. A folder opens its contents (`?folder=`), a file the
 * file view. The files of the commit no suite names close the page. The
 * card's menu exports the commit's combined coverage as LCOV or Cobertura.
 */
import type { CoverageSummary } from '~~/server/utils/coverage-summary';
import { CODE_CHIP_CLASS } from '~/utils';
import { downloadBlob } from '~/utils/chart-export';
import {
  carriedSentence,
  folderTrail,
  formatCount,
  formatPercent,
  functionsSentence,
  splitSentence,
  suiteKindLabel,
  totalsSentence,
  undeterminedSentence,
} from '~/utils/combined-coverage';

const props = defineProps<{
  projectId: number;
  summary: CoverageSummary;
}>();

const route = useRoute();

const trail = computed(() => folderTrail(props.summary.folder));
const meta = computed(() =>
  [
    undeterminedSentence(props.summary.totals),
    functionsSentence(props.summary.totals),
    splitSentence(props.summary.totals),
  ].filter((line): line is string => !!line),
);

/** A link to this page with other query values, the commit kept. */
function pageLink(query: Record<string, string | undefined>) {
  return {
    path: `/projects/${props.projectId}/coverage`,
    query: { commit: route.query.commit as string | undefined, ...query },
  };
}

function entryLink(entry: CoverageSummary['entries'][number]) {
  return entry.kind === 'folder'
    ? pageLink({ folder: entry.path })
    : { path: `/projects/${props.projectId}/coverage`, query: { file: entry.path } };
}

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

const entryName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const barWidth = (percent: number | null) => `${Math.max(0, Math.min(100, percent ?? 0))}%`;
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
            :hint="summary.filesWithoutData.count === null ? 'no inventory uploaded' : 'files in scope'"
          />
        </StatTileGrid>
      </div>
    </SectionCard>

    <SectionCard title="Suites" :count="summary.suites.length">
      <ul class="divide-y divide-default" data-testid="coverage-suites">
        <li
          v-for="suite in summary.suites"
          :key="suite.name"
          class="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-4"
          :data-suite="suite.name"
        >
          <div class="min-w-0 sm:w-48 shrink-0">
            <p class="text-sm font-semibold text-highlighted font-mono truncate" :title="suite.name">
              {{ suite.name }}
            </p>
            <p class="text-xs text-muted">
              {{ suiteKindLabel(suite.kind)
              }}<template v-if="carriedSentence(suite)"> · {{ carriedSentence(suite) }}</template
              ><template v-if="suite.incomplete"> · incomplete</template>
            </p>
          </div>
          <div class="flex-1 min-w-0">
            <div class="h-1.5 rounded-full bg-[var(--color-coverage-not-run)]/25 overflow-hidden" aria-hidden="true">
              <div class="h-full bg-[var(--color-coverage-run)]" :style="{ width: barWidth(suite.linePercent) }" />
            </div>
          </div>
          <p class="text-xs text-muted tabular-nums sm:w-56 sm:text-right shrink-0">
            {{ formatPercent(suite.linePercent) }} of lines · {{ formatPercent(suite.functionPercent) }} of functions
          </p>
        </li>
      </ul>
    </SectionCard>

    <SectionCard title="Files" :count="summary.entries.length">
      <nav class="mb-2 flex flex-wrap items-center gap-1 text-xs text-muted" aria-label="Folder">
        <NuxtLink :to="pageLink({ folder: undefined })" class="hover:underline">Repository</NuxtLink>
        <template v-for="part in trail" :key="part.path">
          <span>/</span>
          <NuxtLink :to="pageLink({ folder: part.path })" class="font-mono hover:underline">{{ part.name }}</NuxtLink>
        </template>
      </nav>
      <EmptyState v-if="summary.entries.length === 0" text="No file of this folder has coverage at this commit." />
      <ul v-else class="divide-y divide-default" data-testid="coverage-entries">
        <li
          v-for="entry in summary.entries"
          :key="entry.path"
          class="flex flex-col gap-1 py-1.5 sm:flex-row sm:items-center sm:gap-4"
          :data-entry="entry.path"
        >
          <NuxtLink
            :to="entryLink(entry)"
            class="min-w-0 sm:w-72 shrink-0 text-sm text-primary font-mono truncate hover:underline"
            :title="entry.path"
          >
            {{ entryName(entry.path) }}{{ entry.kind === 'folder' ? '/' : '' }}
          </NuxtLink>
          <div class="flex-1 min-w-0">
            <div class="h-1.5 rounded-full bg-[var(--color-coverage-not-run)]/25 overflow-hidden" aria-hidden="true">
              <div class="h-full bg-[var(--color-coverage-run)]" :style="{ width: barWidth(entry.linePercent) }" />
            </div>
          </div>
          <p class="text-xs text-muted tabular-nums sm:w-80 sm:text-right shrink-0">
            {{ formatPercent(entry.linePercent) }} · {{ formatCount(entry.executedLines) }} of
            {{ formatCount(entry.executableLines) }} lines · unit only {{ formatCount(entry.unitOnlyLines) }} · end to
            end only {{ formatCount(entry.e2eOnlyLines) }}
          </p>
        </li>
      </ul>
    </SectionCard>

    <CollapsibleSectionCard
      v-if="summary.filesWithoutData.paths.length"
      title="Files without coverage data"
      :count="summary.filesWithoutData.count"
      storage-key="coverage-without-data"
    >
      <p class="mb-2 text-xs text-muted">
        Tracked files in the coverage scope that no suite names: a tool may have left them out, or nothing loads them.
      </p>
      <ul class="space-y-0.5 text-xs font-mono text-highlighted" data-testid="coverage-without-data">
        <li v-for="path in summary.filesWithoutData.paths" :key="path" class="break-all">{{ path }}</li>
      </ul>
    </CollapsibleSectionCard>
  </div>
</template>
