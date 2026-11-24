<script setup lang="ts">
/**
 * The line under a CI action's target in its editor: what is being read from
 * the target, or why something is not listed, and the button that reads the
 * target again, past what the server kept.
 */
defineProps<{
  /** What the listing says; null when it has nothing to say. */
  status: string | null;
  loading: boolean;
}>();
const emit = defineEmits<{ refresh: [] }>();
</script>

<template>
  <div class="flex items-start justify-between gap-2" data-testid="ci-action-listing-status">
    <p class="text-xs text-muted">{{ status }}</p>
    <UButton
      color="neutral"
      variant="ghost"
      size="xs"
      icon="i-lucide-refresh-cw"
      :loading="loading"
      title="Read the target again"
      aria-label="Read the target again"
      data-testid="ci-action-listing-refresh"
      @click="emit('refresh')"
    />
  </div>
</template>
