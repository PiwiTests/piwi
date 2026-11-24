<script setup lang="ts">
/**
 * One place's run button (`useRunPlace`), a neutral outline split button hidden when nothing can run here. Its label
 * names the destinations available: "Run on my machine", "Run on CI" or "Run on my machine or CI". A click opens the
 * run dialog on the last Where sent to; the chevron's menu holds one-click runs of the place's first What, one per CI
 * action that takes it, the default first, and one per online app, each with the defaults (the branch, each choice),
 * shown in the dialog once sent.
 */
import type { DropdownMenuItem } from '@nuxt/ui';
import type { RunPlace } from '~/composables/useRunPlace';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{ place: RunPlace; size?: 'xs' | 'sm' }>(), { size: 'xs' });

const menuItems = computed<DropdownMenuItem[]>(() => {
  const items: DropdownMenuItem[] = props.place.shortcuts.map((shortcut) => ({
    label: shortcut.label,
    onSelect: () => void props.place.sendShortcut(shortcut),
  }));
  if (props.place.shortcutsLoading) items.push({ label: 'Reading your apps…', disabled: true });
  else if (items.length === 0) items.push({ label: 'Nothing to run in one click: open the dialog', disabled: true });
  return items;
});
</script>

<template>
  <UFieldGroup v-if="place.visible" v-bind="$attrs" :size="size" data-testid="run-button">
    <UButton
      :size="size"
      color="neutral"
      variant="outline"
      icon="i-lucide-play"
      :aria-label="place.label"
      :title="place.label"
      @click="place.openDialog()"
    >
      <span class="hidden sm:inline">{{ place.label }}</span>
    </UButton>
    <UDropdownMenu
      :items="menuItems"
      :content="{ align: 'end' }"
      :ui="{ content: 'min-w-56 max-w-md' }"
      @update:open="(isOpen: boolean) => isOpen && place.loadShortcuts()"
    >
      <UButton
        :size="size"
        color="neutral"
        variant="outline"
        icon="i-lucide-chevron-down"
        aria-label="One-click runs"
        title="One-click runs"
      />
    </UDropdownMenu>
  </UFieldGroup>
</template>
