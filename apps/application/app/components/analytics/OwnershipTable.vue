<script setup lang="ts">
import type { AnalyticsOwnership, AnalyticsOwnershipRow } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const {
  data: ownership,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsOwnership>(
  'ownership',
  () => props.query,
  () => props.options,
);

const f = computed(() => metricFormatter());
const rows = computed(() => ownership.value?.rows ?? []);

function ownerName(row: AnalyticsOwnershipRow): string {
  return row.owner ?? 'Unowned';
}

function share(row: AnalyticsOwnershipRow): string | null {
  const total = ownership.value?.totalOpenClusters ?? 0;
  if (total === 0 || row.openClusters === 0) return null;
  return `${Math.round((row.openClusters / total) * 100)}%`;
}
</script>

<template>
  <SectionCard
    icon="i-lucide-users"
    :title="title ?? 'Ownership'"
    :count="rows.length || undefined"
    subtitle="Open failure causes by assignee; flaky tests and wasted time by test owner"
    help="analytics.ownership"
    data-tour="analytics-ownership"
    data-shot="analytics-ownership"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the ownership: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="rows.length === 0" text="Nothing to share out in this period." />
    <template v-else>
      <!-- Mobile: card list -->
      <ul class="md:hidden divide-y divide-default">
        <li v-for="row in rows" :key="row.owner ?? ''" class="py-2 space-y-0.5" data-testid="ownership-row">
          <p class="text-sm text-highlighted" :class="row.owner ? '' : 'text-muted'">{{ ownerName(row) }}</p>
          <p class="text-xs text-muted">
            {{ row.openClusters }} open failure causes<template v-if="share(row)"> ({{ share(row) }})</template> ·
            {{ row.flakyTests }} flaky tests · {{ f.minutes(row.wastedMinutes) }} wasted · median time to fix
            {{ f.value(row.medianTimeToFixDays, 'days', 1) }}
          </p>
        </li>
      </ul>

      <!-- Desktop: table -->
      <div class="hidden md:block">
        <TableScroller min-width="40rem">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-muted border-b border-default">
                <th class="py-2 pr-4 font-medium">Owner</th>
                <th class="py-2 pr-4 font-medium text-right">Open failure causes</th>
                <th class="py-2 pr-4 font-medium text-right">Flaky tests</th>
                <th class="py-2 pr-4 font-medium text-right">Wasted CI minutes</th>
                <th class="py-2 font-medium text-right">Median time to fix</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr v-for="row in rows" :key="row.owner ?? ''" data-testid="ownership-row">
                <td class="py-2 pr-4" :class="row.owner ? 'text-highlighted' : 'text-muted'">{{ ownerName(row) }}</td>
                <td class="py-2 pr-4 text-right tabular-nums">
                  {{ row.openClusters }}
                  <span v-if="share(row)" class="text-xs text-muted">({{ share(row) }})</span>
                </td>
                <td class="py-2 pr-4 text-right tabular-nums">{{ row.flakyTests }}</td>
                <td class="py-2 pr-4 text-right tabular-nums">{{ f.minutes(row.wastedMinutes) }}</td>
                <td class="py-2 text-right tabular-nums">{{ f.value(row.medianTimeToFixDays, 'days', 1) }}</td>
              </tr>
            </tbody>
          </table>
        </TableScroller>
      </div>
    </template>
  </SectionCard>
</template>
