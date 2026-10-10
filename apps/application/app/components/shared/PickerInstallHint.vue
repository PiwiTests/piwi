<script setup lang="ts">
/**
 * Suggests Piwi Picker where it is the next step: what it does here, the
 * store of this browser, and Don't show again. Only where
 * `usePickerInstallHint` finds a store, no mark from the extension and no
 * earlier Don't show again.
 */
defineProps<{
  /** What the extension does on this page, in one sentence. */
  text: string;
}>();

const { store, dismiss } = usePickerInstallHint();
</script>

<template>
  <UAlert
    v-if="store"
    color="neutral"
    variant="subtle"
    icon="i-lucide-mouse-pointer-click"
    title="Piwi Picker browser extension"
    :description="text"
    :actions="[
      { label: store.name, to: store.url, target: '_blank', icon: 'i-lucide-download', size: 'xs', variant: 'soft' },
      { label: 'Don’t show again', size: 'xs', color: 'neutral', variant: 'ghost', onClick: dismiss },
    ]"
    class="text-left"
    data-testid="picker-install-hint"
  />
</template>
