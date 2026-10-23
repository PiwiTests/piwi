<script setup lang="ts">
/** A snippet of an answer, with its language and a copy button. */
defineProps<{ code: string; language: string; title?: string }>();
</script>

<template>
  <div class="space-y-1.5 min-w-0">
    <p v-if="title" class="text-sm font-semibold text-highlighted">{{ title }}</p>
    <CodeBlock :code="code" :lang="language" />
  </div>
</template>
