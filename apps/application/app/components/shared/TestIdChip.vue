<script setup lang="ts">
/**
 * A test's external ID (`piwi:id`, or read from its title), shown before its title: monospace and neutral, so it
 * reads as an identifier rather than a tag or a status, and the same width per character, so IDs line up down a
 * list. When the project links IDs to its test management tool (`externalIdUrl`), the chip opens the test there in a
 * new tab; otherwise a click copies the ID. Either way it never triggers the row's own link.
 */
import { externalIdLink } from '#shared/external-id-link';
import { safeHttpUrl } from '#shared/utils/safe-url';

const props = defineProps<{ externalId: string }>();

const template = useExternalIdUrl();
const href = computed(() => safeHttpUrl(externalIdLink(template.value, props.externalId)));
const { copy, copied } = useCopy();
</script>

<template>
  <a
    v-if="href"
    :href="href"
    target="_blank"
    rel="noopener noreferrer"
    class="inline-flex shrink-0 align-baseline"
    :title="`Open ${props.externalId} in your test management tool`"
    data-testid="test-id-chip"
    @click.stop
  >
    <UBadge color="neutral" variant="subtle" size="xs" class="font-mono tabular-nums gap-1 hover:underline">
      {{ props.externalId }}
      <UIcon name="i-lucide-external-link" class="size-3" />
    </UBadge>
  </a>
  <button
    v-else
    type="button"
    class="inline-flex shrink-0 align-baseline"
    :title="copied ? 'Copied' : `External test ID ${props.externalId} · click to copy`"
    :aria-label="`External test ID ${props.externalId}, copy`"
    data-testid="test-id-chip"
    @click.stop.prevent="copy(props.externalId)"
  >
    <UBadge color="neutral" variant="subtle" size="xs" class="font-mono tabular-nums cursor-copy">
      {{ props.externalId }}
    </UBadge>
  </button>
</template>
