<script setup lang="ts">
/**
 * The sidebar's **Ask Piwi** button, under the search: opens the assistant's
 * panel, and shows its shortcut (Ctrl+I, ⌘I on a Mac) as the search shows
 * its own. Absent when the assistant is declined on this instance, which the
 * capability states already say, so a page load asks for no status; in the
 * collapsed rail it is an icon with a tooltip, like the search beside it.
 */
defineProps<{ collapsed?: boolean }>();

const emit = defineEmits<{
  /** The panel opened. */
  open: [];
}>();

const { status, openPanel } = useAssistant();
const { state } = await useInstanceCapabilities();

const declined = computed(() => state('assistant') === 'declined' || status.value?.reason === 'declined');

function launch(): void {
  emit('open');
  void openPanel();
}
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
      aria-keyshortcuts="Control+I Meta+I"
      data-tour="assistant-launcher"
      @click="launch"
    >
      <template v-if="!collapsed" #trailing>
        <span class="hidden lg:flex items-center gap-0.5 ms-auto">
          <UKbd value="meta" variant="subtle" />
          <UKbd value="i" variant="subtle" />
        </span>
      </template>
    </UButton>
  </UTooltip>
</template>
