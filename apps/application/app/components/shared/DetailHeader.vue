<script setup lang="ts">
/**
 * The header of a detail page: one status chip, the title and the exceptional
 * badges on the first line with a primary action, then one line of facts with a
 * Details popover holding the rest. Built for the execution, cluster and run
 * pages to share; each page fills the facts, primary-action, details and menu
 * slots with its own content.
 */

interface HeaderBadge {
  label: string;
  color?: 'error' | 'warning' | 'neutral' | 'info' | 'success';
  /** Tooltip / accessible description. */
  title?: string;
  icon?: string;
  /** Render monospaced (Playwright annotation marks such as `@fixme`). */
  mono?: boolean;
}

defineProps<{
  /** The execution status chip; omitted on pages whose object has no run status (a cluster). */
  status?: string;
  title: string;
  /** Exceptional badges only: regression, passed on retry, newly flaky, marks. */
  badges?: HeaderBadge[];
}>();
</script>

<template>
  <div class="rounded-lg border border-default bg-default p-3 sm:p-4 space-y-2 max-sm:rounded-none max-sm:border-x-0">
    <!-- Line 1: status, title, exceptional badges, primary action -->
    <div class="flex items-start gap-2.5">
      <StatusChip v-if="status" :status="status" class="mt-0.5 shrink-0" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <h1 class="text-base sm:text-lg font-bold min-w-0 break-words">{{ title }}</h1>
          <template v-for="badge in badges" :key="badge.label">
            <UBadge
              :color="badge.color ?? 'neutral'"
              variant="subtle"
              size="xs"
              :title="badge.title"
              :class="['inline-flex items-center gap-1', badge.mono ? 'font-mono' : '']"
            >
              <UIcon v-if="badge.icon" :name="badge.icon" class="size-3 shrink-0" />
              {{ badge.label }}
            </UBadge>
          </template>
          <slot name="badges-extra" />
        </div>
      </div>
      <div v-if="$slots.primary || $slots.menu" class="flex items-center gap-1.5 shrink-0">
        <slot name="primary" />
        <slot name="menu" />
      </div>
    </div>

    <!-- Line 2: the facts line, with a Details popover for everything else -->
    <div v-if="$slots.facts || $slots.details" class="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs text-muted">
      <slot name="facts" />
      <UPopover v-if="$slots.details">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          trailing-icon="i-lucide-chevron-down"
          label="Details"
          class="shrink-0"
          data-tour="run-details"
        />
        <template #content>
          <div class="p-3 space-y-2 text-sm max-w-sm">
            <slot name="details" />
          </div>
        </template>
      </UPopover>
    </div>

    <!-- An optional row under the facts line (the cluster page's triage control). -->
    <div v-if="$slots.below"><slot name="below" /></div>

    <!-- Optional third line: a count bar (the run variant fills it). -->
    <div v-if="$slots['count-bar']">
      <slot name="count-bar" />
    </div>
  </div>
</template>
