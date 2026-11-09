<script setup lang="ts">
/**
 * The header row that opens a group of `TestRow`s. It sits directly above its
 * rows in a flat list, so a grouped list can still be virtualized (the parent
 * interleaves this header and the rows into one item array, exactly as the run's
 * Tests tab does).
 *
 * It covers three groupings: by cluster (the cluster name,
 * its triage status and an *Open cluster* link), by file (the path as an
 * open-in-IDE link with the per-file status tallies) and a plain *Passed (N)*
 * group. The caller owns the open/closed state and passes it back as `open`.
 */
interface GroupStats {
  passed: number;
  failed: number;
  skipped: number;
  didnotrun: number;
  running: number;
  /** Cut short by the run's interruption, in no outcome. */
  interrupted?: number;
}

/** A labelled figure on the right of a group header (spec-health numbers). */
interface GroupMetric {
  label: string;
  value: string;
  tone?: PassRateTone | 'muted';
}

const props = withDefaults(
  defineProps<{
    label: string;
    count: number;
    open: boolean;
    /** Nesting depth for file groups (0 = file). */
    depth?: number;
    icon?: string;
    /** Cluster grouping: the triage status and a link to the cluster page. */
    triageStatus?: string | null;
    clusterId?: number | null;
    /** File grouping: per-status tallies and the path rendered as an IDE link. */
    stats?: GroupStats | null;
    /** File grouping: labelled figures (spec-health) rendered in place of tallies. */
    metrics?: GroupMetric[] | null;
    filePath?: string | null;
    projectKey?: string | number | null;
    projectName?: string | null;
    /** Search values to mark in the label (`testSearchHighlights`). */
    highlight?: readonly string[] | null;
  }>(),
  {
    depth: 0,
    icon: undefined,
    triageStatus: null,
    clusterId: null,
    stats: null,
    metrics: null,
    filePath: null,
    projectKey: null,
    projectName: null,
    highlight: null,
  },
);

const metricToneClass: Record<NonNullable<GroupMetric['tone']>, string> = {
  good: PASS_RATE_TONES.good.text,
  fair: PASS_RATE_TONES.fair.text,
  poor: PASS_RATE_TONES.poor.text,
  muted: 'text-muted',
};

const emit = defineEmits<{ toggle: [] }>();

const STAT_KEYS = ['failed', 'passed', 'skipped', 'didnotrun', 'interrupted', 'running'] as const;

const visibleStats = computed(() => {
  const s = props.stats;
  if (!s) return [];
  return STAT_KEYS.filter((key) => (s[key] ?? 0) > 0).map((key) => ({
    key,
    count: s[key] ?? 0,
    label: formatStatusLabel(key),
  }));
});
</script>

<template>
  <div
    class="flex items-center gap-2 border-b border-default bg-elevated/60 px-3 py-2 select-none cursor-pointer hover:bg-elevated"
    :style="{ paddingLeft: `${depth * 16 + 12}px` }"
    @click="emit('toggle')"
  >
    <UIcon :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3.5 text-muted shrink-0" />
    <UIcon v-if="icon" :name="icon" class="size-4 shrink-0 text-muted" />

    <!-- Label: an open-in-IDE link for a file group, plain text otherwise. -->
    <span v-if="filePath" class="min-w-0" @click.stop>
      <OpenInIdeLink
        :file-path="filePath"
        :project-key="projectKey"
        :project-name="projectName"
        class="font-medium text-default"
      >
        <template v-if="highlight?.length" #default="{ label: pathLabel }"
          ><SearchHighlight :text="pathLabel" :patterns="highlight"
        /></template>
      </OpenInIdeLink>
    </span>
    <span v-else class="font-medium text-default truncate min-w-0"
      ><SearchHighlight v-if="highlight?.length" :text="label" :patterns="highlight" /><template v-else>{{
        label
      }}</template></span
    >

    <UBadge color="neutral" variant="soft" size="xs" class="shrink-0 tabular-nums">
      {{ count }} {{ count === 1 ? 'test' : 'tests' }}
    </UBadge>

    <UBadge v-if="triageStatus" :color="clusterStatusColor(triageStatus)" variant="subtle" size="xs" class="shrink-0">
      {{ formatTriageStatus(triageStatus) }}
    </UBadge>

    <div class="flex-1" />

    <!-- Spec-health figures (project catalog file grouping). -->
    <div v-if="metrics && metrics.length" class="flex items-center gap-2 sm:gap-3 shrink-0 tabular-nums">
      <span v-for="metric in metrics" :key="metric.label" class="text-xs inline-flex items-baseline gap-1">
        <span class="max-sm:sr-only text-muted">{{ metric.label }}</span>
        <span :class="metricToneClass[metric.tone ?? 'muted']" class="font-medium">{{ metric.value }}</span>
      </span>
    </div>

    <!-- File groups: the per-status tallies, failures first. -->
    <div v-else-if="visibleStats.length" class="flex items-center gap-1.5 sm:gap-2 shrink-0 tabular-nums">
      <span
        v-for="stat in visibleStats"
        :key="stat.key"
        class="text-xs inline-flex items-center gap-0.5"
        :class="[getStatusTextClass(stat.key), stat.key === 'failed' ? 'font-medium' : '']"
        :title="`${stat.count} ${stat.label}`"
      >
        <UIcon :name="getStatusIcon(stat.key)" class="size-3 shrink-0 sm:hidden" />
        {{ stat.count }}<span class="max-sm:sr-only"> {{ stat.label }}</span>
      </span>
    </div>

    <NuxtLink
      v-if="clusterId != null"
      :to="`/failure-clusters/${clusterId}`"
      class="shrink-0 inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
      @click.stop
    >
      Open cluster
      <UIcon name="i-lucide-arrow-right" class="size-3" />
    </NuxtLink>
  </div>
</template>
