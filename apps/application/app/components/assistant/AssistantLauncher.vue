<script setup lang="ts">
/**
 * The sidebar's **Ask Piwi** button, under the search: opens the assistant's
 * panel. Absent when the assistant is declined on this instance; in the
 * collapsed rail it is an icon with a tooltip, like the search beside it.
 */
defineProps<{ collapsed?: boolean }>();

const emit = defineEmits<{
  /** The panel opened. */
  open: [];
}>();

const { status, loadStatus, openPanel } = useAssistant();
const { state } = await useInstanceCapabilities();

const declined = computed(() => state('assistant') === 'declined' || status.value?.reason === 'declined');

function launch(): void {
  emit('open');
  void openPanel();
}

onMounted(() => void loadStatus());
</script>

<template>
  <UTooltip v-if="!declined" text="Ask Piwi" :disabled="!collapsed" :content="{ side: 'right' }" :delay-duration="0">
    <UButton
      icon="i-lucide-sparkles"
      :label="collapsed ? undefined : 'Ask Piwi'"
      color="neutral"
      :variant="collapsed ? 'ghost' : 'outline'"
      :square="collapsed"
      :class="collapsed ? '' : 'bg-transparent ring-default'"
      aria-label="Ask Piwi"
      @click="launch"
    />
  </UTooltip>
</template>
