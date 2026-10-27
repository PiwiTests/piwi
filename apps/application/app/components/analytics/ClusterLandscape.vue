<script setup lang="ts">
import { describeCluster } from '#shared/describe-cluster';
import type { AnalyticsClusterLandscape } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string> }>();

const {
  data: landscape,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsClusterLandscape>('cluster-landscape', () => props.query);

function ageClass(ageDays: number): string {
  if (ageDays >= 30) return 'text-red-600 dark:text-red-400';
  if (ageDays >= 14) return 'text-amber-600 dark:text-amber-400';
  return 'text-gray-500';
}
</script>

<template>
  <SectionCard
    icon="i-lucide-layers"
    title="Failure clusters"
    subtitle="Open root causes across all projects"
    help="analytics.cluster-landscape"
    data-tour="analytics-cluster-landscape"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load clusters: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState
      v-else-if="!landscape || (landscape.totalOpen === 0 && landscape.resolvedInPeriod === 0)"
      icon="i-lucide-check-circle"
      text="No open failure clusters."
    />
    <div v-else class="space-y-4">
      <StatTileGrid>
        <StatTile
          label="Open"
          :value="landscape.totalOpen"
          :value-class="landscape.totalOpen > 0 ? 'text-red-600 dark:text-red-400' : ''"
        />
        <StatTile label="Resolved this period" :value="landscape.resolvedInPeriod" />
        <StatTile
          label="Oldest open"
          :value="landscape.clusters.length > 0 ? `${Math.max(...landscape.clusters.map((c) => c.ageDays))} d` : '—'"
          size="lg"
        />
      </StatTileGrid>

      <div v-if="landscape.byErrorType.length > 0" class="flex flex-wrap gap-1.5">
        <UBadge
          v-for="entry in landscape.byErrorType"
          :key="entry.errorType"
          :color="clusterErrorTypeColor(entry.errorType)"
          variant="subtle"
          size="sm"
        >
          {{ entry.errorType }} · {{ entry.count }}
        </UBadge>
      </div>

      <div class="divide-y divide-gray-100 dark:divide-gray-800">
        <NuxtLink
          v-for="cluster in landscape.clusters.slice(0, 8)"
          :key="cluster.id"
          :to="`/failure-clusters/${cluster.id}`"
          class="flex items-center gap-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/60 rounded transition-colors"
        >
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium truncate" :title="cluster.signature">{{ describeCluster(cluster) }}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400 truncate">
              {{ cluster.projectLabel || cluster.projectName }}
              <template v-if="cluster.errorType"> · {{ cluster.errorType }}</template>
            </p>
          </div>
          <div class="text-right text-xs shrink-0">
            <p class="tabular-nums font-medium">{{ cluster.occurrences }}×</p>
            <p class="tabular-nums" :class="ageClass(cluster.ageDays)">{{ cluster.ageDays }} d open</p>
          </div>
        </NuxtLink>
      </div>
    </div>
  </SectionCard>
</template>
