<script setup lang="ts">
import type { EntityLinkInfo } from '~~/types/api';
import { getProviderIcon } from '#shared/link-detect';
import { safeHttpUrl } from '#shared/utils/safe-url';

/**
 * A pinned link as a chip: the provider icon, the key and title as one link to
 * the page (a new tab; a link with no address, such as a Zephyr Scale test run,
 * is named without one), the synced status, where a link the tests declared came
 * from, and a remove button for writers.
 * The chip wraps inside a narrow container rather than overflowing it, and the
 * remove button shows on hover, on keyboard focus and on touch screens.
 */
const props = defineProps<{
  link: EntityLinkInfo;
  removable?: boolean;
}>();

const emit = defineEmits<{
  remove: [id: number];
}>();

const displayLabel = computed(() => {
  return props.link.title || props.link.key || props.link.url.replace(/^https?:\/\//, '').slice(0, 50);
});

// A link with no address, such as a Zephyr Scale test run, is named without a link.
const href = computed(() => safeHttpUrl(props.link.url));
const providerIcon = computed(() => getProviderIcon(props.link.provider as any));
const name = computed(() => props.link.key || displayLabel.value);
// Where a link the tests declared came from; Piwi does not write to it until a person pins it.
const source = computed(() => (props.link.origin === 'annotation' ? "From the test's annotation" : null));
</script>

<template>
  <span
    class="inline-flex max-w-full items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 group hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
  >
    <UIcon :name="providerIcon" class="w-3.5 h-3.5 shrink-0" />

    <component
      :is="href ? 'a' : 'span'"
      :href="href ?? undefined"
      :target="href ? '_blank' : undefined"
      :rel="href ? 'noopener noreferrer' : undefined"
      class="inline-flex min-w-0 items-center gap-1.5 outline-none"
      :class="href ? 'hover:underline focus-visible:underline' : ''"
      :title="href ? (link.title ? `${link.title} (${link.url})` : link.url) : (link.title ?? undefined)"
      data-testid="link-chip-open"
    >
      <span v-if="link.key" class="shrink-0 font-mono text-primary font-medium whitespace-nowrap">{{ link.key }}</span>
      <span v-if="link.title || !link.key" class="max-w-48 truncate">{{ displayLabel }}</span>
    </component>

    <UBadge
      v-if="link.statusText"
      :color="(link.statusColor as any) || 'neutral'"
      variant="subtle"
      size="xs"
      class="shrink-0 whitespace-nowrap"
    >
      {{ link.statusText }}
    </UBadge>

    <span v-if="source" class="min-w-0 truncate font-normal text-muted" :title="source" data-testid="link-chip-source">
      {{ source }}
    </span>

    <UButton
      v-if="removable"
      size="xs"
      variant="ghost"
      color="error"
      icon="i-lucide-x"
      :aria-label="`Remove ${name}`"
      :title="`Remove ${name}`"
      class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity -my-1"
      @click="emit('remove', link.id)"
    />
  </span>
</template>
