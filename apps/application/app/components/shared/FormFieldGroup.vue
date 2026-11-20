<script setup lang="ts">
/**
 * A form field made of several controls (a switch and a list, inputs side by
 * side, rows of inputs), laid out as a `UFormField` is: a label row with an
 * optional `HelpHint`, a description, the controls, then a note. It is a
 * `fieldset` whose `legend` names the controls, so each control keeps its own
 * id and its own label; a `UFormField` gives its one input id to every control
 * inside it. Attributes such as `data-tour` land on the `fieldset`.
 */
import type { HelpTopicKey } from '~/utils/help-content';

const props = defineProps<{
  label: string;
  /** Help-registry topic key, rendered as a `HelpHint` next to the label. */
  help?: HelpTopicKey;
  /** Above the controls. */
  description?: string;
  /** Below the controls, as `UFormField`'s `help`. */
  note?: string;
  required?: boolean;
}>();

/** The asterisk `UFormField` draws after a required field's label. */
const REQUIRED_CLASS = "after:ms-0.5 after:text-error after:content-['*']";

const descriptionId = useId();
const noteId = useId();
const describedBy = computed(
  () => [props.description && descriptionId, props.note && noteId].filter(Boolean).join(' ') || undefined,
);
</script>

<template>
  <fieldset class="min-w-0 text-sm" :aria-describedby="describedBy">
    <legend class="inline-flex items-center gap-1 font-medium text-default">
      <span :class="required ? REQUIRED_CLASS : undefined"
        ><slot name="label">{{ label }}</slot></span
      >
      <HelpHint v-if="help" :topic="help" />
    </legend>
    <p v-if="description" :id="descriptionId" class="text-muted">{{ description }}</p>
    <div class="mt-1">
      <slot />
    </div>
    <p v-if="note" :id="noteId" class="mt-2 text-muted">{{ note }}</p>
  </fieldset>
</template>
