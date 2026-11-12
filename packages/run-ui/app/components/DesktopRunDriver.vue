<script setup lang="ts">
/**
 * Desktop shell only: who drives a worker's stop, at the foot of its page card in the Local runs tray, as Piwi Picker's
 * Runs window says it (`.run-driver`): the words, then **Take control** while another tool or an agent drives it, or
 * while an agent may act on it, or **Give back** while this window drives it (`mine`). A press waits while a command of
 * the worker is on its way (`busy`), the button keeping the focus.
 */
import { desktopSay } from '../utils/run-view';

const props = defineProps<{
  /** Who drives the stop, in the run model's words. */
  words: string;
  /** This window drives it. */
  mine: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{ take: []; give: [] }>();

function press(): void {
  if (props.busy) return;
  if (props.mine) emit('give');
  else emit('take');
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="desktop-stop-driver">
    <span class="min-w-0 text-xs text-muted">{{ words }}</span>
    <UButton
      data-focus="drive"
      size="xs"
      color="neutral"
      variant="outline"
      :icon="mine ? 'i-lucide-undo-2' : 'i-lucide-hand'"
      :title="desktopSay(mine ? 'runs_giveBackTitle' : 'runs_takeControlTitle')"
      :aria-disabled="busy || undefined"
      @click="press"
    >
      {{ desktopSay(mine ? 'runs_giveBack' : 'runs_takeControl') }}
    </UButton>
  </div>
</template>
