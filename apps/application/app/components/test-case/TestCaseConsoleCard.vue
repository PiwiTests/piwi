<script setup lang="ts">
/**
 * Browser console output captured while the test ran. With a `storageKey` the
 * card folds to its header with a one-line peek (entry count plus the first
 * entry, ANSI-stripped) and the fold state persists per user; without one it is
 * a plain always-open card.
 */
import { stripAnsi } from '@piwitests/run-ui/ansi';
import SectionCard from '../shared/SectionCard.vue';
import CollapsibleSectionCard from '../shared/CollapsibleSectionCard.vue';

const props = defineProps<{
  entries: Array<{
    type: string;
    text: string;
    timestamp?: number;
    location?: string | null;
  }>;
  /** When set, the card folds to a header with a peek (persisted per user). */
  storageKey?: string;
  /** Whether the card starts folded on first visit (no stored cookie). */
  defaultFolded?: boolean;
  /** Mark the entries as recovered from the trace (the capture fixtures were absent). */
  derivedFromTrace?: boolean;
  /** Drop the card frame and padding — render a plain heading row over the body. */
  embedded?: boolean;
  /** The entry a citation just opened (its index in `entries`): ringed. */
  highlightIndex?: number | null;
}>();

const cardComponent = computed(() =>
  props.embedded ? SectionCard : props.storageKey ? CollapsibleSectionCard : SectionCard,
);
const cardBind = computed(() =>
  props.embedded
    ? { embedded: true }
    : props.storageKey
      ? { storageKey: props.storageKey, defaultFolded: props.defaultFolded }
      : {},
);

const peek = computed(() => {
  const n = props.entries.length;
  const first = props.entries[0];
  const head = `${n} entr${n === 1 ? 'y' : 'ies'}`;
  return first ? `${head} · ${first.type}: ${stripAnsi(first.text).trim()}` : head;
});

// Forward reveal so a jump chip or diagnosis citation can unfold + scroll to this card.
const card = ref<{ reveal?: () => void; $el?: HTMLElement } | null>(null);
function reveal() {
  if (card.value?.reveal) card.value.reveal();
  else card.value?.$el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
defineExpose({ reveal });

function consoleTypeColor(type: string): 'error' | 'warning' | 'neutral' {
  switch (type) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'assert':
      return 'error';
    default:
      return 'neutral';
  }
}

function consoleTypeIcon(type: string): string {
  switch (type) {
    case 'error':
      return 'i-lucide-octagon-x';
    case 'warning':
      return 'i-lucide-alert-triangle';
    case 'assert':
      return 'i-lucide-octagon-x';
    default:
      return 'i-lucide-message-square';
  }
}
</script>

<template>
  <component
    :is="cardComponent"
    v-if="entries.length > 0"
    ref="card"
    v-bind="cardBind"
    :icon="embedded ? undefined : 'i-lucide-terminal'"
    :title="embedded ? '' : 'Console output'"
    :count="embedded ? null : entries.length"
    :help="embedded ? undefined : 'case.console'"
  >
    <template v-if="derivedFromTrace" #actions><TraceDerivedChip /></template>
    <template v-if="storageKey" #folded>{{ peek }}</template>
    <div class="space-y-1 max-h-80 overflow-y-auto">
      <div
        v-for="(entry, index) in entries"
        :key="index"
        class="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-sm transition-shadow"
        :class="index === highlightIndex ? CITED_ROW_CLASS : ''"
        :data-cited="index === highlightIndex ? '' : undefined"
      >
        <UIcon
          :name="consoleTypeIcon(entry.type)"
          :class="
            entry.type === 'error' || entry.type === 'assert'
              ? 'text-red-500'
              : entry.type === 'warning'
                ? 'text-amber-500'
                : 'text-gray-400'
          "
          class="size-4 mt-0.5 shrink-0"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <UBadge :color="consoleTypeColor(entry.type)" variant="soft" size="xs" class="shrink-0">
              {{ entry.type }}
            </UBadge>
            <span class="truncate">{{ entry.text }}</span>
          </div>
          <div v-if="entry.location" class="text-xs text-gray-400 mt-0.5 ml-0">
            {{ entry.location }}
          </div>
        </div>
      </div>
    </div>
  </component>
</template>
