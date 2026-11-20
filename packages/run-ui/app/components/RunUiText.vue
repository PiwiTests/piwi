<script setup lang="ts">
/**
 * A message of the layer's catalog whose placeholders may hold markup (a `<strong>`, a `<code>`): each named slot fills
 * the placeholder of its name, and the other placeholders take `args`. The message itself stays text.
 */
const props = defineProps<{
  /** The message's key in the layer's catalog. */
  name: RunUiKey;
  /** The values of the placeholders no slot fills. */
  args?: Record<string, string | number>;
}>();

const slots = useSlots();
const { t } = useRunUiWords();

const MARK = '\u0000';

/** The message as text and slots, in order: a slot by its name. */
const parts = computed(() => {
  const values: Record<string, string | number> = { ...props.args };
  for (const slot of Object.keys(slots)) values[slot] = `${MARK}${slot}${MARK}`;
  const text = (t as (key: string, args?: Record<string, string | number>) => string)(props.name, values);
  return text.split(new RegExp(`${MARK}([^${MARK}]+)${MARK}`)).map((part, i) => (i % 2 === 0 ? part : { slot: part }));
});
</script>

<template>
  <template v-for="(part, i) in parts" :key="i">
    <template v-if="typeof part === 'string'">{{ part }}</template>
    <slot v-else :name="part.slot" />
  </template>
</template>
