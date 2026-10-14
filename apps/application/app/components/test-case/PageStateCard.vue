<script setup lang="ts">
/**
 * App state at test end — URL, history state, storage key names + value
 * lengths, cookie names + flags, and what the page was doing: the focused
 * element, the one under the mouse, a text selection's length, indeterminate
 * checkboxes. Values are never captured, so there is nothing sensitive to
 * display. Rendered from the case detail's `pageState`.
 */

import type { PageState } from '~~/types/api';
import { describeFocus } from '#shared/page-state';
import SectionCard from '../shared/SectionCard.vue';
import CollapsibleSectionCard from '../shared/CollapsibleSectionCard.vue';

const props = defineProps<{
  pageState: PageState;
  /** When set, the card folds to a header with a peek (persisted per user). */
  storageKey?: string;
  /** Render the content without a card wrapper (for embedding in an existing section). */
  plain?: boolean;
  /** Keep the heading row but drop the card frame and padding. */
  embedded?: boolean;
}>();

const cardComponent = computed(() =>
  props.plain ? 'div' : props.embedded ? SectionCard : props.storageKey ? CollapsibleSectionCard : SectionCard,
);
const cardBind = computed(() =>
  props.plain
    ? {}
    : props.embedded
      ? { embedded: true, title: '' }
      : {
          icon: 'i-lucide-database',
          title: 'App state at test end',
          help: 'page-state',
          ...(props.storageKey ? { storageKey: props.storageKey } : {}),
        },
);

const interactionRows = computed(() =>
  [
    { label: 'Focus', text: props.pageState.focus ? describeFocus(props.pageState.focus) : null },
    { label: 'Mouse over', text: props.pageState.hover?.label ?? null },
    {
      label: 'Text selected',
      text: props.pageState.selection ? `${props.pageState.selection.length} characters` : null,
    },
    { label: 'Indeterminate', text: props.pageState.indeterminate?.map((box) => box.label).join(', ') || null },
  ].filter((row): row is { label: string; text: string } => !!row.text),
);

const cookieFlags = (c: PageState['cookies'][number]) =>
  [c.httpOnly ? 'HttpOnly' : null, c.secure ? 'Secure' : null, c.sameSite ?? null].filter(Boolean).join(', ');

const foldedText = computed(() => {
  const s = props.pageState;
  const bits = [
    `${s.localStorage.length} localStorage`,
    `${s.sessionStorage.length} sessionStorage`,
    `${s.cookies.length} cookie${s.cookies.length === 1 ? '' : 's'}`,
  ];
  return bits.join(' · ');
});

// Forward the fold/scroll so a clue or AI citation to `appState` can reveal it.
const cardRef = ref<{ reveal?: () => void } | null>(null);
defineExpose({ reveal: () => cardRef.value?.reveal?.() });
</script>

<template>
  <component :is="cardComponent" ref="cardRef" v-bind="cardBind">
    <template v-if="storageKey && !plain" #folded>
      <span>{{ foldedText }}</span>
    </template>

    <div class="space-y-3 text-sm">
      <div v-if="pageState.url" class="flex flex-col gap-0.5">
        <span class="text-xs font-medium text-gray-500 dark:text-gray-400">URL</span>
        <code class="text-xs font-mono break-all">{{ pageState.url }}{{ pageState.hash ?? '' }}</code>
      </div>

      <div v-if="pageState.historyState" class="flex flex-col gap-0.5">
        <span class="text-xs font-medium text-gray-500 dark:text-gray-400">History state</span>
        <code class="text-xs font-mono break-all">{{ pageState.historyState }}</code>
      </div>

      <div v-for="row in interactionRows" :key="row.label" class="flex flex-col gap-0.5">
        <span class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ row.label }}</span>
        <code class="text-xs font-mono break-all">{{ row.text }}</code>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div
          v-for="(entries, label) in { localStorage: pageState.localStorage, sessionStorage: pageState.sessionStorage }"
          :key="label"
        >
          <span class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ label }} ({{ entries.length }})</span>
          <p v-if="entries.length === 0" class="text-xs text-gray-400">empty</p>
          <ul v-else class="mt-1 space-y-0.5">
            <li v-for="entry in entries" :key="entry.key" class="text-xs font-mono truncate">
              {{ entry.key }} <span class="text-gray-400">({{ entry.length }} ch)</span>
            </li>
          </ul>
        </div>
      </div>

      <div>
        <span class="text-xs font-medium text-gray-500 dark:text-gray-400"
          >Cookies ({{ pageState.cookies.length }})</span
        >
        <p v-if="pageState.cookies.length === 0" class="text-xs text-gray-400">none</p>
        <ul v-else class="mt-1 space-y-0.5">
          <li v-for="cookie in pageState.cookies" :key="cookie.name + cookie.domain" class="text-xs font-mono truncate">
            {{ cookie.name }}
            <span v-if="cookieFlags(cookie)" class="text-gray-400">[{{ cookieFlags(cookie) }}]</span>
            <span class="text-gray-400">· {{ cookie.domain }}</span>
          </li>
        </ul>
      </div>

      <p class="text-[11px] text-gray-400 dark:text-gray-500">
        Storage values and cookie values are never captured — key names, lengths and flags only. Focus, mouse and
        selection name elements, never a field's value or the selected text.
      </p>
    </div>
  </component>
</template>
