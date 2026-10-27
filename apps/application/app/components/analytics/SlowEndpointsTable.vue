<script setup lang="ts">
import type { AnalyticsSlowEndpoints } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string> }>();

const {
  data: slow,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsSlowEndpoints>('slow-endpoints', () => props.query);

// The cross-project view follows the instance-level fixtures decision: declined
// hides the block, undecided replaces the pitch with one naming line.
const { state: capState } = await useInstanceCapabilities();
const fixturesDeclined = computed(() => capState('fixtures') === 'declined');
const fixturesUndecided = computed(() => capState('fixtures') === 'undecided');

function latencyClass(ms: number): string {
  if (ms >= 1000) return 'text-red-600 dark:text-red-400';
  if (ms >= 500) return 'text-amber-600 dark:text-amber-400';
  return 'text-gray-600 dark:text-gray-300';
}

function methodColor(method: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
  const map: Record<string, 'success' | 'info' | 'warning' | 'error' | 'neutral'> = {
    GET: 'info',
    POST: 'success',
    PUT: 'warning',
    PATCH: 'warning',
    DELETE: 'error',
  };
  return map[method.toUpperCase()] ?? 'neutral';
}
</script>

<template>
  <SectionCard
    v-if="!fixturesDeclined"
    icon="i-lucide-gauge"
    title="Slow endpoints"
    :count="slow?.endpoints.length || undefined"
    subtitle="Backend calls across all projects, slowest first"
    help="analytics.slow-endpoints"
    data-tour="analytics-slow-endpoints"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load slow endpoints: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <p v-else-if="(!slow || slow.endpoints.length === 0) && fixturesUndecided" class="py-6 text-sm text-muted">
      Network timing is not captured on this instance.
    </p>
    <EmptyState
      v-else-if="!slow || slow.endpoints.length === 0"
      icon="i-lucide-network"
      text="No network requests captured in this period."
    />
    <template v-else>
      <!-- Mobile: card list -->
      <div class="md:hidden space-y-3">
        <div
          v-for="ep in slow.endpoints"
          :key="`${ep.method} ${ep.route}`"
          class="rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-1.5"
        >
          <div class="flex items-center gap-2 min-w-0">
            <UBadge :color="methodColor(ep.method)" variant="subtle" size="sm">{{ ep.method }}</UBadge>
            <code class="text-xs truncate">{{ ep.route }}</code>
          </div>
          <div class="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span
              >p90 <span class="tabular-nums font-medium" :class="latencyClass(ep.p90Ms)">{{ ep.p90Ms }} ms</span></span
            >
            <span>{{ ep.requests }} reqs · {{ ep.projectCount }} proj</span>
            <span v-if="ep.errorRate > 0" class="text-red-600 dark:text-red-400 tabular-nums"
              >{{ ep.errorRate }}% err</span
            >
          </div>
        </div>
      </div>

      <!-- Desktop: table -->
      <div class="hidden md:block">
        <TableScroller min-width="44rem">
          <table class="w-full text-sm">
            <thead>
              <tr
                class="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-gray-200 dark:border-gray-800"
              >
                <th class="py-2 pr-4 font-medium">Endpoint</th>
                <th class="py-2 pr-4 font-medium text-right">Requests</th>
                <th class="py-2 pr-4 font-medium text-right">p50</th>
                <th class="py-2 pr-4 font-medium text-right">p90</th>
                <th class="py-2 pr-4 font-medium text-right">Max</th>
                <th class="py-2 pr-4 font-medium text-right">Errors</th>
                <th class="py-2 font-medium text-right">Projects</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
              <tr v-for="ep in slow.endpoints" :key="`${ep.method} ${ep.route}`">
                <td class="py-2.5 pr-4">
                  <div class="flex items-center gap-2 min-w-0">
                    <UBadge :color="methodColor(ep.method)" variant="subtle" size="sm">{{ ep.method }}</UBadge>
                    <code class="text-xs truncate max-w-[22rem]" :title="ep.route">{{ ep.route }}</code>
                  </div>
                </td>
                <td class="py-2.5 pr-4 text-right tabular-nums">{{ ep.requests }}</td>
                <td class="py-2.5 pr-4 text-right tabular-nums text-gray-500">{{ ep.p50Ms }} ms</td>
                <td class="py-2.5 pr-4 text-right tabular-nums font-medium" :class="latencyClass(ep.p90Ms)">
                  {{ ep.p90Ms }} ms
                </td>
                <td class="py-2.5 pr-4 text-right tabular-nums text-gray-500">{{ ep.maxMs }} ms</td>
                <td
                  class="py-2.5 pr-4 text-right tabular-nums"
                  :class="ep.errorRate > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400'"
                >
                  {{ ep.errorRate }}%
                </td>
                <td class="py-2.5 text-right tabular-nums">{{ ep.projectCount }}</td>
              </tr>
            </tbody>
          </table>
        </TableScroller>
      </div>
    </template>
  </SectionCard>
</template>
