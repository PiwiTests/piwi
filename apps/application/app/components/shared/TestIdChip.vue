<script setup lang="ts">
/**
 * A test's external ID (`piwi:id`, or read from its title), shown before its title: monospace and neutral, so it
 * reads as an identifier rather than a tag or a status, and the same width per character, so IDs line up down a
 * list. A click copies the ID and never triggers the row's own link.
 */
const props = defineProps<{ externalId: string }>();

const { copy, copied } = useCopy();
</script>

<template>
  <button
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
