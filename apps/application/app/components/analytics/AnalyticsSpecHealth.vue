<script setup lang="ts">
import type { AnalyticsProjectAnalysis } from '#shared/analytics/types';
import type { SpecHealthData } from '#shared/handlers/analytics/project-analyses';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const { data, pending, error, refresh } = await useAnalyticsWidget<AnalyticsProjectAnalysis<SpecHealthData>>(
  'spec-health',
  () => props.query,
  () => props.options,
);
</script>

<template>
  <SectionCard
    icon="i-lucide-heart-pulse"
    :title="title ?? 'Spec health'"
    :subtitle="data?.project?.name"
    help="analytics.spec-health"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load spec health: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="data && !data.project" icon="i-lucide-folder" :text="data.reason" />
    <EmptyState v-else-if="!data?.project || data.data.specs.length === 0" text="No run in this period." />
    <TableScroller v-else min-width="22rem">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-xs text-muted text-left">
            <th class="py-1 pr-2 font-medium">Spec directory</th>
            <th class="py-1 px-2 font-medium text-right">Pass rate</th>
            <th class="py-1 px-2 font-medium text-right">Flaky</th>
            <th class="py-1 pl-2 font-medium text-right">Runs</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="spec in data.data.specs" :key="spec.prefix">
            <td class="py-1 pr-2 font-mono text-xs break-all">{{ spec.prefix }}</td>
            <td
              class="py-1 px-2 text-right tabular-nums"
              :class="passRateTextClass(spec.passRate === null ? null : spec.passRate * 100)"
            >
              {{ spec.passRate === null ? '—' : `${Math.round(spec.passRate * 100)}%` }}
            </td>
            <td class="py-1 px-2 text-right tabular-nums">
              {{ spec.flakyRate === null ? '—' : `${Math.round(spec.flakyRate * 100)}%` }}
            </td>
            <td class="py-1 pl-2 text-right tabular-nums">{{ spec.testCount }}</td>
          </tr>
        </tbody>
      </table>
    </TableScroller>
  </SectionCard>
</template>
