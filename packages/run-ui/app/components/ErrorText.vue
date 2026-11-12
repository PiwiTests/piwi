<script setup lang="ts">
/**
 * Error text as Playwright printed it, with its ANSI colors rendered instead
 * of leaking as `[31m` fragments. The base color is muted — the status icon
 * next to it already says "failed" — and the ANSI highlights (received in red,
 * expected in green, dimmed punctuation) carry the emphasis.
 *
 * `line` (default) is the one-line preview for lists and table cells: the
 * whole message collapsed onto one line and truncated, so the locator or the
 * received value that follows the first line still shows, with the plain full
 * text as a tooltip. `block` keeps every line for a step's or an error card's
 * full message.
 */
import { renderAnsi, stripAnsi } from '../utils/ansi';

const props = withDefaults(defineProps<{ text: string; mode?: 'line' | 'block' }>(), { mode: 'line' });

const html = computed(() => renderAnsi(props.text));
const plain = computed(() => stripAnsi(props.text).trim());
</script>

<template>
  <!-- eslint-disable vue/no-v-html — renderAnsi escapes the text before wrapping it in styled spans -->
  <p
    v-if="mode === 'line'"
    class="font-mono text-xs text-gray-600 dark:text-gray-400 truncate min-w-0"
    :title="plain"
    v-html="html"
  />
  <div
    v-else
    class="font-mono text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words"
    v-html="html"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>
