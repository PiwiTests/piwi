<script setup lang="ts">
/** The locator fix card's ways to pick a locator by hand: on the failure-time DOM snapshot, or in the trace viewer. */
defineProps<{
  /** Offer the DOM snapshot picker (the failing locator is known). */
  snapshot: boolean;
  /** The trace viewer address of the failure trace, when there is one. */
  traceUrl?: string | null;
}>();

const emit = defineEmits<{
  'pick-snapshot': [];
  /** The trace link was clicked; a listener may cancel the navigation to open it another way. */
  'pick-trace': [event: MouseEvent];
}>();
</script>

<template>
  <div class="flex items-center gap-1">
    <UButton
      v-if="snapshot"
      size="xs"
      color="neutral"
      variant="outline"
      icon="i-lucide-mouse-pointer"
      title="Open the failure-time DOM snapshot and click the element to pick a locator"
      @click="emit('pick-snapshot')"
    >
      Pick from snapshot
    </UButton>
    <UButton
      v-if="traceUrl"
      :to="traceUrl"
      target="_blank"
      size="xs"
      color="neutral"
      variant="outline"
      icon="i-lucide-crosshair"
      title="Open the failure trace in the trace viewer — its Pick locator tool works on the recorded page snapshots"
      @click="emit('pick-trace', $event)"
    >
      Pick from trace
    </UButton>
  </div>
</template>
