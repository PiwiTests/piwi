<script setup lang="ts">
/**
 * The input's usage gauge: the largest share spent among the assistant's
 * limits, opening what each one leaves: the daily token allowance and, with
 * the Claude Code CLI, the Claude subscription's window, each with when it
 * frees up or resets.
 */
import { ASSISTANT_USAGE_WARNING, type AssistantUsageView } from '~/utils/assistant/usage';

const props = defineProps<{ usage: AssistantUsageView }>();

const peak = computed(() => (props.usage.peak === null ? null : Math.round(props.usage.peak * 100)));

const GAUGE_CLASS = { primary: 'text-muted', warning: 'text-warning', error: 'text-error' } as const;

function tone(share: number | null): 'error' | 'warning' | 'primary' {
  if (share !== null && share >= 1) return 'error';
  if (share !== null && share >= ASSISTANT_USAGE_WARNING) return 'warning';
  return 'primary';
}
</script>

<template>
  <UPopover :content="{ side: 'top', align: 'end' }">
    <button
      type="button"
      class="inline-flex shrink-0 items-center gap-1 rounded text-xs hover:text-highlighted focus-visible:outline-2 focus-visible:outline-primary"
      :class="GAUGE_CLASS[tone(usage.peak)]"
      :aria-label="peak === null ? 'Usage limits' : `Usage limits: ${peak}% spent`"
      data-assistant-usage
    >
      <UIcon name="i-lucide-gauge" class="size-3.5" aria-hidden="true" />
      <span v-if="peak !== null">{{ peak }}%</span>
    </button>
    <template #content>
      <div class="w-72 space-y-3 p-3" data-assistant-usage-details>
        <div v-for="meter in usage.meters" :key="meter.id" class="space-y-1">
          <p class="text-xs font-semibold text-highlighted">{{ meter.label }}</p>
          <UProgress
            v-if="meter.share !== null"
            :model-value="meter.share * 100"
            size="xs"
            :color="tone(meter.share)"
          />
          <p class="text-xs text-muted">{{ meter.detail }}</p>
          <p v-if="meter.resets" class="text-xs text-muted">{{ meter.resets }}</p>
        </div>
      </div>
    </template>
  </UPopover>
</template>
