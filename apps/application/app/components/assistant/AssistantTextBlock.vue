<script setup lang="ts">
/**
 * An answer's formatted text, in the page's body style: links to the entities
 * this conversation's tool results named, any other entity as plain text.
 */
defineProps<{
  text: string;
  /** `assistantEntityKey` of each entity a link may name. */
  known: ReadonlySet<string>;
}>();
</script>

<template>
  <MarkdownPreview :text="text" variant="prose" :entities="known" />
</template>
