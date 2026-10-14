<script setup lang="ts">
/**
 * The sentence a What changed line says about the suspect lines: how many of
 * the changed lines the failing tests ran (or how many hunks they reached),
 * then the most suspect file in a code chip with its lines, and how many more
 * there are. The file links to the What changed card that lists them all:
 * `to` when the card is on another page, else a click the page handles.
 */
import type { SuspectSentence } from '~/utils/suspect-lines';

defineProps<{
  sentence: SuspectSentence;
  /** The page holding the What changed card; without it the file emits `open`. */
  to?: string | null;
}>();

const emit = defineEmits<{
  /** The file was clicked: show the card's list. */
  open: [];
}>();
</script>

<template>
  <span data-shot="suspect-lines-sentence"
    >{{ sentence.lead
    }}<template v-if="sentence.first"
      ><NuxtLink
        v-if="to"
        :to="to"
        :class="[SENTENCE_LINK_CLASS, CODE_CHIP_CLASS]"
        :title="`${sentence.first.path}: the list of suspect lines`"
        >{{ sentence.first.name }}</NuxtLink
      ><button
        v-else
        type="button"
        :class="[SENTENCE_LINK_CLASS, CODE_CHIP_CLASS]"
        :title="`${sentence.first.path}: the list of suspect lines`"
        @click="emit('open')"
      >
        {{ sentence.first.name }}</button
      >{{ ' ' }}{{ sentence.first.lines
      }}<template v-if="sentence.first.granularity"> ({{ sentence.first.granularity }})</template
      >{{ sentence.more }}</template
    ></span
  >
</template>
