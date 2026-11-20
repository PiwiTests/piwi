<script setup lang="ts">
/**
 * An on/off switch of the failure timeline's toolbar (the Screen lane, the
 * Resources rows): solid while on, dashed while off, its title saying what a
 * press does.
 */
defineProps<{
  icon: string;
  label: string;
  /** What a press does while it is on, and while it is off. */
  titleOn: string;
  titleOff: string;
}>();
const on = defineModel<boolean>({ required: true });
</script>

<template>
  <button
    type="button"
    :aria-pressed="on ? 'true' : 'false'"
    :title="on ? titleOn : titleOff"
    class="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium select-none outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary"
    :class="
      on
        ? 'border-default bg-default text-default hover:bg-elevated/60'
        : 'border-dashed border-accented text-muted hover:bg-elevated/60'
    "
    @click="on = !on"
  >
    <UIcon :name="icon" class="size-3.5 shrink-0" />
    {{ label }}
  </button>
</template>
