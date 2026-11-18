<script setup lang="ts">
/**
 * A deployment environment (`Production`, `Staging`, …). By default the
 * outlined pill the run header uses; with `inline`, a subtle icon + name that
 * flows inside a sentence without the border breaking the line. Both keep the
 * server icon the filter bar pairs with environments, so an environment reads
 * the same everywhere. Renders "no environment" (muted) when the run has none.
 * `name` is the environment's name, else the run's label; `label`, the label
 * the run reported, shows on hover when it differs from the name.
 */
const props = defineProps<{
  name: string | null | undefined;
  /** The label the run reported, when `name` is its environment's name. */
  label?: string | null;
  /** Borderless form for use inside flowing text. */
  inline?: boolean;
}>();

const reported = computed(() =>
  props.label && props.name && props.label !== props.name ? `Reported as ${props.label}` : undefined,
);
</script>

<template>
  <span
    class="inline-flex items-center gap-1 align-middle whitespace-nowrap"
    :class="[
      !name && 'text-muted',
      !inline && 'rounded-full border border-default px-2 py-0.5 leading-none bg-elevated/60',
    ]"
    :title="reported"
  >
    <UIcon name="i-lucide-server" class="size-3 shrink-0 text-muted" />
    {{ name ?? 'no environment' }}
  </span>
</template>
