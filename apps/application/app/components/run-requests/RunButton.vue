<script setup lang="ts">
/**
 * One place's run button (`useRunPlace`), a neutral outline split button hidden when nothing can run here. Its label
 * names the destinations available: "Run on my machine", "Run on CI" or "Run on my machine or CI". A click opens the
 * run dialog on the last Where sent to; the chevron's menu holds one-click runs of the place's first What, one per CI
 * action that takes it, the default first, and one per online app, each with the defaults (the branch, each choice),
 * shown in the dialog once sent.
 *
 * In the desktop window, where the first What runs on this computer (`useThisComputer`), the face says what it runs
 * and runs it there at once, unless the last Where is a CI action that takes it ("Run on this computer or CI", which
 * opens the dialog); it shows a run of those tests while it goes on and just after, and a click then opens the Local
 * runs tray. The menu is then This computer's (the command, the one-off runs, the options of the button, Run with
 * options…), with the one-click runs on CI among them. `primary` gives the idle face the accent color, where the button
 * is the page's primary action.
 */
import type { DropdownMenuItem } from '@nuxt/ui';
import type { RunPlace } from '~/composables/useRunPlace';
import type { ThisComputerFace } from '~/composables/useThisComputer';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{ place: RunPlace; size?: 'xs' | 'sm'; primary?: boolean }>(), {
  size: 'xs',
  primary: false,
});

const here = computed(() => props.place.here);
/** The place's first What runs on this computer: the menu is This computer's. */
const hereFirst = computed(() => here.value.takesMain);

const face = computed<ThisComputerFace>(() => {
  const status = here.value.available ? here.value.statusFace : null;
  if (status) return status;
  if (props.place.mainHere) return here.value.idleFace(props.primary);
  return {
    label: props.place.label,
    color: props.primary ? 'primary' : 'neutral',
    variant: props.primary ? 'solid' : 'outline',
    icon: 'i-lucide-play',
    tooltip: '',
    status: false,
  };
});
/** The face says what it runs here, at every width; the destinations' label hides below `sm`, beside its icon. */
const faceRunsHere = computed(() => face.value.status || props.place.mainHere);

function onClick() {
  if (face.value.status) {
    here.value.openTray();
    return;
  }
  if (!props.place.mainHere) {
    void props.place.openDialog();
    return;
  }
  if (here.value.attention) void props.place.openDialog({ where: 'local' });
  // The menu says why nothing runs.
  else if (here.value.noPlan) menuOpen.value = true;
  else here.value.runNow();
}

const menuOpen = ref(false);
watch(menuOpen, (isOpen) => {
  if (isOpen) props.place.loadShortcuts();
});

const shortcutItems = computed<DropdownMenuItem[]>(() =>
  props.place.shortcuts.map((shortcut) => ({
    label: shortcut.label,
    onSelect: () => void props.place.sendShortcut(shortcut),
  })),
);
const menuItems = computed<DropdownMenuItem[] | DropdownMenuItem[][]>(() => {
  if (hereFirst.value) {
    return here.value.menuGroups(shortcutItems.value, () => void props.place.openDialog({ where: 'local' }));
  }
  const items = [...shortcutItems.value];
  if (props.place.shortcutsLoading) items.push({ label: 'Reading your apps…', disabled: true });
  else if (items.length === 0) items.push({ label: 'Nothing to run in one click: open the dialog', disabled: true });
  return items;
});
const menuLabel = computed(() => (hereFirst.value ? 'Run options' : 'One-click runs'));
/** The folder needs a fix before a run here: the menu holds it. */
const attention = computed(() => hereFirst.value && here.value.linkLoaded && here.value.attention);
</script>

<template>
  <UFieldGroup v-if="place.visible" v-bind="$attrs" :size="size" data-testid="run-button">
    <UTooltip :text="face.tooltip" :disabled="!face.tooltip">
      <UButton
        :size="size"
        :color="face.color"
        :variant="face.variant"
        :icon="face.icon"
        :loading="face.status && !face.icon"
        :disabled="!face.status && place.mainHere && here.waiting"
        :aria-label="faceRunsHere ? undefined : face.label"
        :title="faceRunsHere ? undefined : face.label"
        @click="onClick"
      >
        <span :class="faceRunsHere ? undefined : 'hidden sm:inline'">{{ face.label }}</span>
      </UButton>
    </UTooltip>
    <UDropdownMenu
      v-model:open="menuOpen"
      :items="menuItems"
      :content="{ align: 'end' }"
      :ui="{ content: 'min-w-56 max-w-md' }"
    >
      <UButton
        :size="size"
        :color="face.color"
        :variant="face.variant"
        icon="i-lucide-chevron-down"
        :aria-label="menuLabel"
        :title="menuLabel"
        :disabled="hereFirst && !here.linkLoaded"
        class="relative"
      >
        <span v-if="attention" class="absolute -top-1 -right-1 size-2 rounded-full bg-warning" />
      </UButton>
    </UDropdownMenu>
  </UFieldGroup>
</template>
