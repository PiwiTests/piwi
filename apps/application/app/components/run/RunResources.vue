<script setup lang="ts">
/**
 * The run's Resources tab: what its reporters found left open or piling up,
 * the pages open in each worker test after test, what the run cost each
 * machine it ran on, and the tests that used the most CPU. Fetched when the
 * tab opens, from `GET /api/test-runs/:id/resources`.
 */
import type { RunResources } from '#shared/handlers/run-resources';
import type { WireResourceFinding, WireResourceReport } from '#shared/types';
import { findingView, formatCpuTime, formatSize } from '#shared/resource-copy';
import { resourceFingerprint } from '#shared/resource-fingerprint.mjs';
import { machineFacts, machineHead, resourceTotals } from '~/utils/resources';
import { ALL_RESOURCE_TRACKS, type ResourceTrackVisibility } from '~/utils/resource-tracks';

const props = defineProps<{
  runId: number;
  /** Piwi project id and name, for the open-in-IDE links. */
  projectKey?: number | null;
  projectName?: string | null;
  /** Increments when the run finishes so the tab refetches. */
  refreshKey?: number;
}>();

const emit = defineEmits<{ openTimeline: [] }>();

const data = ref<RunResources | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    data.value = await $fetch<RunResources>(`/api/test-runs/${props.runId}/resources`);
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || 'Failed to load resources';
  } finally {
    loading.value = false;
  }
}

watch([() => props.runId, () => props.refreshKey], load, { immediate: true });

const parts = computed<WireResourceReport[]>(() => data.value?.report?.parts ?? []);
const sharded = computed(() => parts.value.length > 1);
const totals = computed(() => (data.value?.report ? resourceTotals(data.value.report) : null));

/** Every finding of every shard, with its shard when the run had several. */
const findings = computed(() =>
  parts.value.flatMap((part) =>
    part.findings.map((finding: WireResourceFinding, i: number) => {
      const view = findingView(finding);
      const facts = sharded.value ? [...view.facts, `shard ${part.shardIndex ?? '?'}`] : view.facts;
      return {
        key: `${part.shardIndex ?? 0}-${i}`,
        label: view.label,
        where: view.where ? splitWhere(view.where, view.site) : null,
        facts: facts.join(' · '),
        history: data.value?.history[resourceFingerprint(finding)] ?? null,
      };
    }),
  ),
);

/**
 * The ledger ran when a reporter counted per-test objects: a finding other than
 * a probable one, or the pages open in a worker.
 */
const ledgerRan = computed(() =>
  parts.value.some(
    (part) =>
      part.workers.length > 0 || part.workerHealth !== null || part.findings.some((f) => f.verdict !== 'probable'),
  ),
);

/** Split a finding's place around its `file:line`, so the line opens in the IDE. */
function splitWhere(where: string, site: string | null): { before: string; site: string | null; after: string } {
  if (!site) return { before: where, site: null, after: '' };
  const at = where.indexOf(site);
  if (at < 0) return { before: where, site: null, after: '' };
  return { before: where.slice(0, at), site, after: where.slice(at + site.length) };
}

/** Whether the run has open pages over time for the timeline to draw. */
const pagesOnTimeline = computed(() => parts.value.some((part) => (part.timeline?.pages?.length ?? 0) > 0));

// The timeline's pages track, the same per-browser preference its Resources menu writes.
const trackVisibility = useLocalStorage<ResourceTrackVisibility>(
  'piwi-timeline-resource-tracks',
  { ...ALL_RESOURCE_TRACKS },
  // Synchronous, so showing the track lands before the tab switch unmounts this component.
  { initOnMounted: true, mergeDefaults: true, writeDefaults: false, flush: 'sync' },
);
const pagesShown = computed(() => trackVisibility.value.pages !== false);

function togglePagesOnTimeline(): void {
  const show = !pagesShown.value;
  trackVisibility.value = { ...trackVisibility.value, pages: show };
  if (show) emit('openTimeline');
}

function cpuPath(series: number[], plotWidth: number, yScale: (v: number) => number): string {
  if (series.length < 2) return '';
  const step = plotWidth / (series.length - 1);
  return series
    .map((value, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${yScale(value).toFixed(1)}`)
    .join(' ');
}

/** The memory-peak label beside its line, on the side with room for it. */
function peakLabel(at: number, plotWidth: number): { x: number; 'text-anchor': 'start' | 'end' } {
  const x = at * plotWidth;
  return at > 0.7 ? { x: x - 4, 'text-anchor': 'end' } : { x: x + 4, 'text-anchor': 'start' };
}

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const costliest = computed(() => data.value?.costliest ?? []);
</script>

<template>
  <div class="p-4">
    <ErrorState v-if="error" :text="error" padded>
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" @click="load">Retry</UButton>
      </template>
    </ErrorState>

    <LoadingState v-else-if="loading && !data" padded />

    <EmptyState v-else-if="!data?.report && costliest.length === 0" icon="i-lucide-cpu" text="No resource report">
      <p class="text-sm text-muted max-w-sm text-center">
        The reporter sends what a run cost and left open from version 0.45.
        <DocLink to="features/resource-leaks#in-the-dashboard" />
      </p>
    </EmptyState>

    <div v-else class="space-y-6" data-shot="run-resources">
      <StatTileGrid v-if="totals" data-shot="run-resources-tiles">
        <StatTile label="Leaked" :value="totals.counts.leaked" hint="left open past their scope" />
        <StatTile label="Never used" :value="totals.counts.idle" hint="pages opened, never driven" />
        <StatTile label="Piling up" :value="totals.counts.piling" hint="pages, listeners or routes" />
        <StatTile v-if="totals.counts.handle" label="Left running" :value="totals.counts.handle" hint="Node handles" />
        <StatTile
          v-if="totals.counts.probable"
          label="Probable leaks"
          :value="totals.counts.probable"
          hint="counted from steps"
        />
        <StatTile
          label="CPU"
          :value="totals.cpuMs !== null ? formatCpuTime(totals.cpuMs) : null"
          :hint="totals.runWaitMs ? `waited ${formatCpuTime(totals.runWaitMs)} for a CPU` : 'every process sampled'"
        />
        <StatTile
          label="Peak memory"
          :value="totals.peakMemoryBytes !== null ? formatSize(totals.peakMemoryBytes) : null"
          :hint="sharded ? 'the largest shard' : undefined"
        />
        <StatTile label="Artifacts" :value="formatSize(totals.artifactBytes)" hint="traces, videos, screenshots" />
      </StatTileGrid>

      <!-- Findings -->
      <SectionCard
        v-if="data?.report"
        title="Findings"
        :count="findings.length"
        help="run.resource-findings"
        data-shot="run-resources-findings"
      >
        <ul v-if="findings.length > 0" class="divide-y divide-default -my-2" data-tour="run-leaks">
          <li v-for="item in findings" :key="item.key" class="py-2.5 min-w-0">
            <p class="text-sm text-highlighted break-words">
              <span class="font-semibold">{{ item.label }}</span>
              <template v-if="item.where">
                <span class="text-muted"> · </span>
                <span class="font-mono text-xs">{{ item.where.before }}</span>
                <OpenInIdeLink
                  v-if="item.where.site"
                  :location="item.where.site"
                  :project-key="projectKey"
                  :project-name="projectName"
                  class="text-xs"
                />
                <span class="font-mono text-xs">{{ item.where.after }}</span>
              </template>
            </p>
            <p v-if="item.facts" class="text-xs text-muted mt-0.5 break-words">{{ item.facts }}</p>
            <p v-if="item.history" class="text-xs text-muted mt-0.5" data-testid="finding-history">
              <template v-if="item.history.reopened">Back after its fix</template>
              <template v-else-if="item.history.isNew">
                New: never seen on <span class="font-mono">{{ data?.baseBranch }}</span> before this run
              </template>
              <template v-else-if="item.history.firstSeenRunId && item.history.firstSeenRunId !== runId">
                Since
                <NuxtLink :to="`/test-runs/${item.history.firstSeenRunId}?tab=resources`" :class="SENTENCE_LINK_CLASS"
                  >run #{{ item.history.firstSeenRunId }}</NuxtLink
                >
                · {{ item.history.runs }} runs
              </template>
            </p>
          </li>
        </ul>
        <p v-else-if="ledgerRan" class="text-sm text-highlighted leading-relaxed">
          Nothing left open: every browser, context and page closed with the test or block that opened it.
        </p>
        <p v-else class="text-sm text-highlighted leading-relaxed">
          No findings. Without the capture fixtures the reporter only counts browsers and contexts opened and closed in
          each file's steps; the fixtures name the line that left each object open.
          <DocLink to="guide/capture-fixtures" />
        </p>
      </SectionCard>

      <!-- Open pages over time -->
      <SectionCard
        v-if="pagesOnTimeline"
        title="Open pages over time"
        subtitle="Each worker's pages are drawn on the timeline, above its row"
        help="run.resource-pages"
        data-shot="run-resources-pages"
        data-tour="run-open-pages"
      >
        <div class="flex flex-wrap items-center gap-3">
          <p class="text-sm text-highlighted leading-relaxed flex-1 min-w-40">
            A line that climbs test after test is a page left open; a clean worker stays flat.
          </p>
          <UButton size="sm" color="neutral" variant="outline" @click="togglePagesOnTimeline">
            {{ pagesShown ? 'Hide on the timeline' : 'Show on the timeline' }}
          </UButton>
        </div>
      </SectionCard>

      <!-- The machine each reporter ran on -->
      <template v-for="part in parts" :key="`machine-${part.shardIndex ?? 0}`">
        <SectionCard
          v-if="part.profile"
          :title="sharded ? `Shard ${part.shardIndex ?? '?'} machine` : 'Machine'"
          :subtitle="machineHead(part.profile)"
          help="run.resource-machine"
          data-shot="run-resources-machine"
          data-tour="run-machine"
        >
          <div class="space-y-3">
            <div v-if="part.profile.cpu.series.length >= 2">
              <p class="text-xs text-muted mb-1">CPU busy over the run</p>
              <ChartFrame
                v-slot="{ plotWidth, plotHeight, yScale }"
                :height="120"
                :y-max="100"
                :y-format="(v) => `${v}%`"
              >
                <path
                  :d="cpuPath(part.profile.cpu.series, plotWidth, yScale)"
                  fill="none"
                  class="stroke-gray-600 dark:stroke-gray-300"
                  stroke-width="1.5"
                />
                <template v-if="part.profile.memory.peakAtMs !== null && part.profile.wallMs > 0">
                  <line
                    :x1="(part.profile.memory.peakAtMs / part.profile.wallMs) * plotWidth"
                    :x2="(part.profile.memory.peakAtMs / part.profile.wallMs) * plotWidth"
                    :y1="0"
                    :y2="plotHeight"
                    class="stroke-gray-400 dark:stroke-gray-500"
                    stroke-dasharray="3 3"
                  />
                  <text
                    v-bind="peakLabel(part.profile.memory.peakAtMs / part.profile.wallMs, plotWidth)"
                    :y="plotHeight - 4"
                    class="fill-gray-500 dark:fill-gray-400 text-[10px]"
                  >
                    memory peak
                  </text>
                </template>
                <text :x="0" :y="plotHeight + 14" class="fill-gray-400 dark:fill-gray-500 text-[10px] tabular-nums">
                  0:00
                </text>
                <text
                  :x="plotWidth"
                  :y="plotHeight + 14"
                  text-anchor="end"
                  class="fill-gray-400 dark:fill-gray-500 text-[10px] tabular-nums"
                >
                  {{ clock(part.profile.wallMs) }}
                </text>
              </ChartFrame>
            </div>
            <dl class="grid grid-cols-1 sm:grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5">
              <template v-for="fact in machineFacts(part)" :key="fact.label">
                <dt class="text-sm font-semibold text-highlighted">{{ fact.label }}</dt>
                <dd class="text-sm text-highlighted leading-relaxed mb-1.5 sm:mb-0">{{ fact.facts.join(' · ') }}</dd>
              </template>
            </dl>
          </div>
        </SectionCard>
      </template>

      <!-- The tests that cost the most -->
      <SectionCard
        v-if="costliest.length > 0"
        title="Costliest tests"
        :subtitle="`By CPU in their worker and browser processes · ${costliest.length} of ${data?.measuredExecutions ?? 0} measured`"
        help="run.resource-costliest"
        data-shot="run-resources-costliest"
        data-tour="run-costliest-tests"
      >
        <ul class="divide-y divide-default -my-2">
          <li v-for="execution in costliest" :key="execution.executionId" class="py-2.5 flex items-start gap-3 min-w-0">
            <div class="min-w-0 flex-1">
              <NuxtLink
                :to="`/test-run-cases/${execution.executionId}`"
                class="text-sm text-highlighted hover:underline break-words"
              >
                {{ execution.title }}
              </NuxtLink>
              <p class="text-xs text-muted mt-0.5 break-words">
                <span class="font-mono">{{
                  execution.line ? `${execution.filePath}:${execution.line}` : execution.filePath
                }}</span>
                <template v-if="execution.browserCpuMs !== null">
                  · browser processes {{ formatCpuTime(execution.browserCpuMs) }}</template
                >
                <template v-if="execution.peakRssMb !== null">
                  · largest browser process {{ formatSize(execution.peakRssMb * 1024 * 1024) }}</template
                >
                <template v-if="execution.openAtStartPages > 0">
                  · {{ execution.openAtStartPages }} page{{ execution.openAtStartPages === 1 ? '' : 's' }} already
                  open</template
                >
                <template v-if="execution.leftOpen > 0"> · left {{ execution.leftOpen }} open</template>
              </p>
            </div>
            <span class="text-sm text-highlighted tabular-nums shrink-0">{{ formatCpuTime(execution.cpuMs) }}</span>
          </li>
        </ul>
      </SectionCard>
    </div>
  </div>
</template>
