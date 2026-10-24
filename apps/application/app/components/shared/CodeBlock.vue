<script setup lang="ts">
import { highlightCode } from '#shared/highlight';

const props = defineProps<{
  code: string;
  /** A highlight.js language; `text` shows the code as written, wrapped to the block's width. */
  lang?: string;
  /** Shown in place of the language label: the file the code goes in, or where it runs. */
  filename?: string;
}>();

const { copy, copied } = useCopy();

const detectedLang = ref('');

const isText = computed(() => props.lang === 'text');

const highlighted = computed(() => {
  if (isText.value) {
    detectedLang.value = '';
    return props.code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  const result = highlightCode(props.code, props.lang);
  detectedLang.value = result.language;
  return result.html;
});
</script>

<template>
  <div class="relative">
    <pre
      class="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-4 max-sm:px-2 pt-8 pb-3 text-sm font-mono overflow-x-auto leading-relaxed"
      :class="isText ? 'whitespace-pre-wrap break-words' : ''"
    ><code class="hljs !bg-transparent" v-html="highlighted" /></pre>
    <!-- File name, else the language label -->
    <span
      v-if="filename"
      class="absolute top-2 left-3 max-sm:left-2 text-xs font-mono text-muted select-none pointer-events-none"
      >{{ filename }}</span
    >
    <span
      v-else-if="detectedLang"
      class="absolute top-2 left-3 text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 select-none pointer-events-none"
      >{{ detectedLang }}</span
    >
    <!-- Copy button -->
    <UButton
      size="xs"
      color="neutral"
      variant="ghost"
      :icon="copied ? 'i-lucide-check' : 'i-lucide-clipboard'"
      :title="copied ? 'Copied!' : copyPreview(code)"
      class="absolute top-1.5 right-1.5 opacity-40 hover:opacity-100 transition-opacity"
      @click="copy(code, { toast: true })"
    />
  </div>
</template>
