<script setup lang="ts" generic="T extends string | boolean">
/**
 * A segmented single choice of Settings → AI, as a radio group: the checked
 * option is the one Tab stop, and the arrow keys move the choice.
 */
import { SEGMENTED_SELECTED_CLASS } from '~/utils';

interface SegmentedOption<V> {
  value: V;
  label: string;
  /** Shown after the label, muted. */
  detail?: string;
  disabled?: boolean;
}

const props = defineProps<{
  options: SegmentedOption<T>[];
  label?: string;
  labelledby?: string;
  disabled?: boolean;
}>();

const model = defineModel<T>({ required: true });

const buttons = ref<HTMLButtonElement[]>([]);

function choose(option: SegmentedOption<T>) {
  if (props.disabled || option.disabled || option.value === model.value) return;
  model.value = option.value;
}

function move(from: number, step: 1 | -1) {
  const count = props.options.length;
  for (let i = 1; i <= count; i++) {
    const index = (from + step * i + count) % count;
    const option = props.options[index]!;
    if (option.disabled) continue;
    choose(option);
    nextTick(() => buttons.value[index]?.focus());
    return;
  }
}
</script>

<template>
  <div
    role="radiogroup"
    :aria-label="label"
    :aria-labelledby="labelledby"
    class="inline-flex max-w-full flex-wrap gap-0.5 rounded-md bg-elevated/60 p-0.5"
  >
    <button
      v-for="(option, i) in options"
      :key="String(option.value)"
      ref="buttons"
      type="button"
      role="radio"
      :aria-checked="option.value === model ? 'true' : 'false'"
      :tabindex="option.value === model ? 0 : -1"
      :disabled="disabled || option.disabled"
      class="rounded px-2.5 py-1 text-sm whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
      :class="option.value === model ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'"
      @click="choose(option)"
      @keydown.right.prevent="move(i, 1)"
      @keydown.down.prevent="move(i, 1)"
      @keydown.left.prevent="move(i, -1)"
      @keydown.up.prevent="move(i, -1)"
    >
      {{ option.label }}<span v-if="option.detail" class="text-muted"> · {{ option.detail }}</span>
    </button>
  </div>
</template>
