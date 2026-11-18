<script setup lang="ts">
/**
 * What a filter with nothing picked reads: the project's default (its default
 * branch, its default environment), or every value. Picking values by hand
 * overrides it, so callers show it beside their select only while none is
 * picked. Attributes land on the select.
 */
import type { HelpTopicKey } from '~/utils/help-content';

defineOptions({ inheritAttrs: false });

/** True for every value, false for the default. */
const all = defineModel<boolean>({ required: true });

const props = defineProps<{
  /** The words of the default ("Default branch (main)"). */
  defaultLabel: string;
  /** The words of every value ("All branches"). */
  allLabel: string;
  icon: string;
  /** The select's accessible name ("Branch policy"). */
  accessibleName: string;
  help?: HelpTopicKey;
}>();

const items = computed(() => [
  { label: props.defaultLabel, value: 'default' },
  { label: props.allLabel, value: 'all' },
]);

const policy = computed({
  get: () => (all.value ? 'all' : 'default'),
  set: (value: string) => {
    all.value = value === 'all';
  },
});
</script>

<template>
  <div class="flex items-center gap-1">
    <USelect
      v-model="policy"
      :items="items"
      size="sm"
      :icon="icon"
      class="min-w-[150px]"
      :aria-label="accessibleName"
      v-bind="$attrs"
    />
    <HelpHint v-if="help" :topic="help" />
  </div>
</template>
