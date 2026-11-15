<script setup lang="ts">
/**
 * A setting made of several controls (a switch and a list, two inputs side by
 * side), laid out as a `UFormField` is: a label row with an optional `HelpHint`,
 * a description, then the controls. It renders a `fieldset` with a `legend`
 * because a `UFormField` hands its one input id to every control inside it, so
 * each control's label would point at the first. Attributes such as `data-tour`
 * land on the `fieldset`.
 */
import type { HelpTopicKey } from '~/utils/help-content';

defineProps<{
  label: string;
  /** Help-registry topic key, rendered as a `HelpHint` next to the label. */
  help?: HelpTopicKey;
  description?: string;
}>();
</script>

<template>
  <fieldset class="text-sm">
    <legend class="inline-flex items-center gap-1 font-medium text-default">
      {{ label }}
      <HelpHint v-if="help" :topic="help" />
    </legend>
    <p v-if="description" class="text-muted">{{ description }}</p>
    <div class="mt-1">
      <slot />
    </div>
  </fieldset>
</template>
