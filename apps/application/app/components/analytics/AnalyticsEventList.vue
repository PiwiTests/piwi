<script setup lang="ts">
import type { AnalyticsEvents } from '#shared/analytics/types';

const props = defineProps<{ query: Record<string, string>; options?: Record<string, unknown>; title?: string }>();

const { data, pending, error, refresh } = await useAnalyticsWidget<AnalyticsEvents>(
  'markers',
  () => props.query,
  () => props.options,
);
</script>

<template>
  <SectionCard
    icon="i-lucide-flag"
    :title="title ?? 'Timeline markers'"
    help="analytics.markers"
    data-tour="analytics-markers"
    data-shot="analytics-events"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the events: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <EmptyState v-else-if="!data || data.markers.length === 0" text="No timeline marker in this period." />
    <ul v-else class="space-y-2">
      <li v-for="m in data.markers" :key="m.id" class="min-w-0">
        <p class="text-sm text-highlighted break-words">{{ m.label }}</p>
        <p class="text-xs text-muted">
          <ClientDate :date="m.occurredAt" /> · {{ m.category }}
          <template v-if="m.description"> · {{ m.description }}</template>
        </p>
      </li>
    </ul>
  </SectionCard>
</template>
