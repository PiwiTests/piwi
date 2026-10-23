<script setup lang="ts">
/**
 * Storage analysis for the Storage settings page: headline usage, growth over
 * the retained data's lifetime, the split by evidence family and the projects
 * that consume the most space. Presentational — the page fetches
 * `/api/admin/storage` and passes it in, so a cleanup refresh re-renders here.
 */
import type { StorageAnalysis } from '~~/types/api';
import { STORAGE_KIND_SERIES, barGeometry, dayTickIndices, formatTickDate } from '~/utils/chart';

const props = defineProps<{
  analysis: StorageAnalysis | null;
  pending?: boolean;
  error?: unknown;
}>();
const emit = defineEmits<{ refresh: [] }>();

/** Projects beyond this rank fold into a single "Other projects" row. */
const TOP_PROJECTS = 8;
/** One accent hue for the single-measure marks (growth area, project bars). */
const ACCENT = 'rgb(59, 130, 246)';

const kindColor = Object.fromEntries(STORAGE_KIND_SERIES.map((s) => [s.key, s.color])) as Record<string, string>;
const kindLabel = Object.fromEntries(STORAGE_KIND_SERIES.map((s) => [s.key, s.label])) as Record<string, string>;

const totalBytes = computed(() => props.analysis?.totalBytes ?? 0);
const hasData = computed(() => !!props.analysis && props.analysis.totalFiles > 0);
const showLoading = computed(() => props.pending && !props.analysis);

const pctOfTotal = (bytes: number) => (totalBytes.value > 0 ? Math.round((bytes / totalBytes.value) * 100) : 0);

// KPIs ----------------------------------------------------------------------
const largestProject = computed(() => props.analysis?.byProject[0] ?? null);
const onDisk = computed(() => props.analysis?.storageSizeOnDisk ?? null);
/**
 * Bytes on disk with no tracked row behind them — a leak signal. Shown only
 * when clearly above the tracked total, so rounding and the odd temp file stay
 * quiet.
 */
const untrackedHint = computed(() => {
  if (onDisk.value == null) return 'measured on disk';
  const untracked = onDisk.value - totalBytes.value;
  if (untracked > 1024 * 1024 && untracked > totalBytes.value * 0.05) {
    return `${formatBytes(untracked)} untracked`;
  }
  return 'measured on disk';
});

// By file kind (composition) ------------------------------------------------
const byKind = computed(() => props.analysis?.byKind ?? []);
const kindMax = computed(() => Math.max(1, ...byKind.value.map((k) => k.bytes)));

// Top projects (ranking) ----------------------------------------------------
const topProjects = computed(() => props.analysis?.byProject.slice(0, TOP_PROJECTS) ?? []);
const projectMax = computed(() => Math.max(1, ...topProjects.value.map((p) => p.bytes)));
const otherProjects = computed(() => props.analysis?.byProject.slice(TOP_PROJECTS) ?? []);
const otherBytes = computed(() => otherProjects.value.reduce((sum, p) => sum + p.bytes, 0));

/** Bar width relative to the group's largest, floored so a sliver stays visible. */
const barWidth = (bytes: number, max: number) => `${Math.max(1.5, (bytes / max) * 100)}%`;

/** Compact byte label for the y-axis, kept narrow enough to fit the axis gutter. */
function axisBytes(value: number): string {
  if (value <= 0) return '0';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 ? Math.round(n) : Math.round(n * 10) / 10}${units[i]}`;
}

// Storage over time (cumulative area) ---------------------------------------
type TimePoint = { date: Date; added: number; cumulative: number };
const timePoints = computed<TimePoint[]>(
  () =>
    props.analysis?.overTime.map((b) => ({
      date: new Date(`${b.date}T00:00:00Z`),
      added: b.bytes,
      cumulative: b.cumulativeBytes,
    })) ?? [],
);
const hasTimeSeries = computed(() => timePoints.value.length > 1);
const timeMax = computed(() => Math.max(1, ...timePoints.value.map((p) => p.cumulative)));

function centers(plotWidth: number): number[] {
  const { centerOf } = barGeometry(timePoints.value.length, plotWidth);
  return timePoints.value.map((_, i) => centerOf(i));
}
function linePath(plotWidth: number, yScale: (v: number) => number): string {
  const xs = centers(plotWidth);
  return timePoints.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs[i]},${yScale(p.cumulative)}`).join('');
}
function areaPath(plotWidth: number, plotHeight: number, yScale: (v: number) => number): string {
  const xs = centers(plotWidth);
  if (xs.length === 0) return '';
  return `${linePath(plotWidth, yScale)}L${xs[xs.length - 1]},${plotHeight}L${xs[0]},${plotHeight}Z`;
}
function xTicks(plotWidth: number) {
  const { centerOf } = barGeometry(timePoints.value.length, plotWidth);
  const dates = timePoints.value.map((p) => p.date);
  return dayTickIndices(dates, Math.max(2, Math.floor(plotWidth / 80))).map((i) => ({
    x: centerOf(i),
    label: formatTickDate(dates[i] as Date),
  }));
}

const { data: hovered, pos: tooltipPos, show, move, hide } = useChartTooltip<TimePoint>(240);

const growthSubtitle = computed(() => {
  if (!props.analysis || timePoints.value.length === 0) return undefined;
  const days = props.analysis.bucketDays;
  return `${formatBytes(totalBytes.value)} total · ${days === 1 ? 'daily' : `${days}-day`} buckets`;
});
</script>

<template>
  <div class="space-y-6" data-shot="storage-analysis">
    <!-- Headline usage -->
    <SectionCard
      icon="i-lucide-hard-drive"
      title="Storage usage"
      help="settings.storage-stats"
      data-tour="storage-usage"
    >
      <template #actions>
        <UButton
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="outline"
          size="sm"
          :loading="pending"
          label="Refresh"
          @click="emit('refresh')"
        />
      </template>

      <LoadingState v-if="showLoading" />
      <ErrorState v-else-if="error" :text="`Couldn't load storage analysis: ${errorMessage(error)}`">
        <template #action>
          <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="emit('refresh')">
            Retry
          </UButton>
        </template>
      </ErrorState>
      <EmptyState
        v-else-if="!hasData"
        text="No stored evidence yet. Reports, traces, screenshots and videos show up here as runs are ingested."
      />
      <StatTileGrid v-else>
        <StatTile
          label="Total storage"
          :value="formatBytes(totalBytes)"
          :hint="`${analysis!.totalFiles.toLocaleString()} files`"
        />
        <StatTile label="Projects" :value="analysis!.projectCount" hint="hold stored data" />
        <StatTile
          label="Largest project"
          :value="formatBytes(largestProject?.bytes)"
          :hint="largestProject?.name ?? undefined"
        />
        <StatTile label="On disk" :value="onDisk == null ? 'Remote' : formatBytes(onDisk)" :hint="untrackedHint" />
      </StatTileGrid>
    </SectionCard>

    <template v-if="hasData">
      <!-- Growth over time -->
      <ChartCard icon="i-lucide-trending-up" title="Storage over time" :subtitle="growthSubtitle">
        <EmptyState v-if="!hasTimeSeries" text="Not enough history yet to chart growth." />
        <div v-else class="w-full">
          <ChartFrame v-slot="{ plotWidth, plotHeight, yScale }" :height="220" :y-max="timeMax" :y-format="axisBytes">
            <path :d="areaPath(plotWidth, plotHeight, yScale)" :fill="ACCENT" fill-opacity="0.14" />
            <path :d="linePath(plotWidth, yScale)" fill="none" :stroke="ACCENT" stroke-width="2" />

            <text
              v-for="tick in xTicks(plotWidth)"
              :key="tick.x"
              :x="tick.x"
              :y="plotHeight + 14"
              text-anchor="middle"
              class="fill-gray-400 dark:fill-gray-500 text-[10px]"
            >
              {{ tick.label }}
            </text>

            <rect
              v-for="(p, i) in timePoints"
              :key="`hit-${p.date.getTime()}`"
              :x="i * (plotWidth / timePoints.length)"
              :y="0"
              :width="plotWidth / timePoints.length"
              :height="plotHeight"
              :fill="hovered === p ? 'rgb(148 163 184 / 0.15)' : 'transparent'"
              @mouseenter="show($event, p)"
              @mousemove="move($event)"
              @mouseleave="hide()"
            />
          </ChartFrame>

          <ChartTooltip v-if="hovered" :pos="tooltipPos">
            <div class="font-semibold mb-1">
              <ClientOnly>{{
                hovered.date.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  timeZone: 'UTC',
                })
              }}</ClientOnly>
            </div>
            <div>{{ formatBytes(hovered.cumulative) }} total</div>
            <div class="text-gray-400 text-xs">+{{ formatBytes(hovered.added) }} added</div>
          </ChartTooltip>
        </div>
      </ChartCard>

      <div class="grid gap-6 lg:grid-cols-2">
        <!-- By file kind -->
        <ChartCard icon="i-lucide-shapes" title="By file kind">
          <ul class="space-y-3">
            <li v-for="k in byKind" :key="k.kind">
              <div class="flex items-center justify-between gap-2 mb-1">
                <span class="text-sm text-highlighted truncate">{{ kindLabel[k.kind] ?? k.kind }}</span>
                <span class="text-xs text-muted tabular-nums shrink-0">
                  {{ formatBytes(k.bytes) }} · {{ pctOfTotal(k.bytes) }}%
                </span>
              </div>
              <div class="h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                <div
                  class="h-full rounded-full"
                  :style="{ width: barWidth(k.bytes, kindMax), backgroundColor: kindColor[k.kind] ?? ACCENT }"
                />
              </div>
            </li>
          </ul>
        </ChartCard>

        <!-- Top projects -->
        <ChartCard icon="i-lucide-folders" title="Top projects" subtitle="Which projects use the most storage">
          <ul class="space-y-3">
            <li v-for="p in topProjects" :key="p.projectId">
              <div class="flex items-center justify-between gap-2 mb-1">
                <NuxtLink
                  :to="`/projects/${p.projectId}`"
                  class="text-sm text-highlighted truncate hover:underline decoration-dotted underline-offset-2"
                >
                  {{ p.name }}
                </NuxtLink>
                <span class="text-xs text-muted tabular-nums shrink-0">
                  {{ formatBytes(p.bytes) }} · {{ p.files.toLocaleString() }} files
                </span>
              </div>
              <div class="h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                <div
                  class="h-full rounded-full"
                  :style="{ width: barWidth(p.bytes, projectMax), backgroundColor: ACCENT }"
                />
              </div>
            </li>
            <li v-if="otherProjects.length" class="flex items-center justify-between gap-2 pt-1 text-xs text-muted">
              <span>{{ otherProjects.length }} more {{ otherProjects.length === 1 ? 'project' : 'projects' }}</span>
              <span class="tabular-nums">{{ formatBytes(otherBytes) }}</span>
            </li>
          </ul>
        </ChartCard>
      </div>
    </template>
  </div>
</template>
