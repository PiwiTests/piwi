<script setup lang="ts">
/**
 * Empty state for a block whose data depends on an optional capability the user
 * may simply never have switched on.
 *
 * A plain "no data" message is indistinguishable from a broken feature, which
 * is the fastest way to make a tool feel thin. This says *why* it is empty and
 * links to the fix. Use it only where emptiness has a known cause — a genuinely
 * empty-but-working block should keep using `EmptyState`.
 */
const props = withDefaults(
  defineProps<{
    /** What's missing, e.g. "Network capture". */
    title: string;
    /** One line naming the requirement, e.g. "needs the Piwi capture fixtures". */
    text: string;
    icon?: string;
    /** Docs page (+ optional `#anchor`) for the setup instructions. */
    doc?: string;
    /** In-app route that switches it on, when one exists. Defaults to Settings → Capabilities; pass `""` to hide the action. */
    to?: string;
    toLabel?: string;
    padded?: boolean;
    /**
     * Tighter left-aligned single-column layout for a folded evidence card,
     * where the full centered panel is too tall.
     */
    compact?: boolean;
  }>(),
  { icon: 'i-lucide-plug-zap', to: '/settings/capabilities', toLabel: 'How to enable', padded: true, compact: false },
);
</script>

<template>
  <div
    v-if="props.compact"
    class="flex flex-col items-start gap-1.5 text-left text-gray-500"
    :class="props.padded && 'py-3'"
  >
    <div class="flex items-center gap-2">
      <UIcon :name="props.icon" class="size-4 opacity-60 shrink-0" />
      <p class="text-sm font-medium text-gray-600 dark:text-gray-300">{{ props.title }}</p>
    </div>
    <p class="text-sm">{{ props.text }}</p>
    <div class="flex items-center gap-3 mt-0.5">
      <UButton v-if="props.to" :to="props.to" size="xs" variant="soft" icon="i-lucide-rocket">
        {{ props.toLabel }}
      </UButton>
      <DocLink v-if="props.doc" :to="props.doc" class="text-sm">Docs</DocLink>
    </div>
    <slot />
  </div>
  <div
    v-else
    class="flex flex-col items-center justify-center gap-2 text-center text-gray-500"
    :class="props.padded && 'py-8'"
  >
    <UIcon :name="props.icon" class="size-6 opacity-60" />
    <p class="text-sm font-medium text-gray-600 dark:text-gray-300">{{ props.title }}</p>
    <p class="text-sm max-w-md">{{ props.text }}</p>
    <div class="flex items-center gap-3 mt-1">
      <UButton v-if="props.to" :to="props.to" size="xs" variant="soft" icon="i-lucide-rocket">
        {{ props.toLabel }}
      </UButton>
      <DocLink v-if="props.doc" :to="props.doc" class="text-sm">Docs</DocLink>
    </div>
    <slot />
  </div>
</template>
