<script setup lang="ts">
/**
 * The search box of the test lists (a run's Tests tab, a project's Tests
 * catalog). It takes free words, "quoted phrases" and qualifiers such as
 * `file:cart.spec.ts` or `-tag:slow`, and completes the term under the caret:
 * an empty term lists the qualifiers the list knows, a qualifier lists the
 * values it can take, a word lists the qualifiers and values it starts or
 * contains. Ctrl+F (⌘F) focuses it; pressed again, the browser's find opens.
 * The Video tab's checklist uses it for titles alone, with neither the
 * completion list nor the shortcut.
 *
 * It only edits the text: the language, matching and highlighting live in
 * `#shared/test-search`.
 */
import {
  applyTestSearchSuggestion,
  completeTestSearch,
  testSearchFieldDef,
  type TestSearchField,
  type TestSearchSuggestion,
  type TestSearchValues,
} from '#shared/test-search';

const props = withDefaults(
  defineProps<{
    /** The qualifiers this list understands, in the order to offer them. */
    fields: readonly TestSearchField[];
    /** The values each qualifier can take here, for completion. */
    values?: TestSearchValues | null;
    placeholder?: string;
    /** The box's accessible name. */
    label?: string;
    /** Ctrl+F (⌘F) focuses the box. */
    findShortcut?: boolean;
    /** The list of qualifiers and values opens under the box; off for a list that searches its titles alone. */
    suggest?: boolean;
  }>(),
  { values: null, placeholder: 'Search tests', label: 'Search tests', findShortcut: true, suggest: true },
);

// The attributes a caller sets (class, data-shot) belong on the box, not on the popover root.
defineOptions({ inheritAttrs: false });

const query = defineModel<string>({ default: '' });
const emit = defineEmits<{ focus: [] }>();

const anchor = useTemplateRef<HTMLElement>('anchor');
const inputComponent = useTemplateRef<{ inputRef: HTMLInputElement | null }>('input');
const inputEl = () => inputComponent.value?.inputRef ?? null;

const focused = ref(false);
/** The suggestions were closed (Escape, a pick, a click away) until the next edit. */
const dismissed = ref(false);
const caret = ref(0);
const activeIndex = ref(-1);

const completion = computed(() =>
  completeTestSearch({ query: query.value, caret: caret.value, fields: props.fields, values: props.values ?? {} }),
);
const suggestions = computed(() => completion.value.suggestions);
/** A text qualifier with no values to offer (`title:`, `error:`) says how it matches instead. */
const hint = computed(() => {
  const field = completion.value.field;
  if (!field || suggestions.value.length > 0) return null;
  const def = testSearchFieldDef(field);
  return def.match === 'contains' ? def : null;
});
const open = computed(
  () => props.suggest && focused.value && !dismissed.value && (suggestions.value.length > 0 || hint.value !== null),
);
const listingQualifiers = computed(
  () => suggestions.value.length > 0 && suggestions.value.every((s) => s.kind === 'field'),
);

const uid = useId();
const listboxId = `${uid}-suggestions`;
const optionId = (index: number) => `${uid}-suggestion-${index}`;

// Typing a qualifier's value highlights the best match, so Enter or Tab takes
// it; a bare word keeps no highlight, so Enter never swaps the word for a filter.
function defaultActive(): number {
  const c = completion.value;
  return c.field && c.value.trim() !== '' && c.suggestions.length > 0 ? 0 : -1;
}
watch([query, caret], () => {
  activeIndex.value = defaultActive();
});
// Values can arrive after the typing (a catalog fetches them on focus) or
// change under it (a live run): keep the highlight, or give it one.
watch(suggestions, (list) => {
  if (activeIndex.value >= list.length) activeIndex.value = list.length - 1;
  else if (activeIndex.value < 0) activeIndex.value = defaultActive();
});

if (props.findShortcut) useFindShortcut(inputEl);

function readCaret() {
  const el = inputEl();
  caret.value = el?.selectionStart ?? query.value.length;
}

function onFocus() {
  focused.value = true;
  dismissed.value = false;
  readCaret();
  emit('focus');
}

function onBlur() {
  focused.value = false;
}

function onInput() {
  dismissed.value = false;
  readCaret();
}

function onClick() {
  dismissed.value = false;
  readCaret();
}

const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);
function onKeyup(event: KeyboardEvent) {
  if (CARET_KEYS.has(event.key)) readCaret();
}

function moveActive(step: 1 | -1) {
  const count = suggestions.value.length;
  if (count === 0) return;
  activeIndex.value = activeIndex.value < 0 ? (step === 1 ? 0 : count - 1) : (activeIndex.value + step + count) % count;
  nextTick(() => document.getElementById(optionId(activeIndex.value))?.scrollIntoView({ block: 'nearest' }));
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      event.preventDefault();
      if (!open.value) {
        dismissed.value = false;
        readCaret();
      } else {
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
      }
      break;
    case 'Enter':
      if (open.value && activeIndex.value >= 0) {
        event.preventDefault();
        choose(activeIndex.value);
      } else {
        dismissed.value = true;
      }
      break;
    case 'Tab':
      if (open.value && activeIndex.value >= 0) {
        event.preventDefault();
        choose(activeIndex.value);
      }
      break;
    case 'Escape':
      if (open.value) {
        event.preventDefault();
        dismissed.value = true;
      }
      break;
  }
}

/** Put the suggestion in place of the term being typed, and keep typing after it. */
function choose(index: number) {
  const suggestion = suggestions.value[index];
  if (!suggestion) return;
  const next = applyTestSearchSuggestion(query.value, completion.value, suggestion);
  query.value = next.query;
  caret.value = next.caret;
  // A qualifier opens its values; a value is complete, so the list steps aside.
  dismissed.value = suggestion.kind === 'value';
  nextTick(() => {
    const el = inputEl();
    if (!el) return;
    el.focus();
    el.setSelectionRange(next.caret, next.caret);
  });
}

function clear() {
  query.value = '';
  caret.value = 0;
  inputEl()?.focus();
}

function suggestionKey(suggestion: TestSearchSuggestion): string {
  return suggestion.kind === 'field' ? `f:${suggestion.key}` : `v:${suggestion.key}:${suggestion.value}`;
}

/** Keep the list open while the pointer works in the box it belongs to. */
function onInteractOutside(event: Event) {
  const original = (event as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent;
  const target = (original?.target ?? event.target) as Node | null;
  if (target && anchor.value?.contains(target)) event.preventDefault();
}

const popoverContent = {
  side: 'bottom' as const,
  align: 'start' as const,
  sideOffset: 4,
  collisionPadding: 8,
  onOpenAutoFocus: (event: Event) => event.preventDefault(),
  onCloseAutoFocus: (event: Event) => event.preventDefault(),
  onInteractOutside,
};

function onOpenChange(value: boolean) {
  if (!value) dismissed.value = true;
}
</script>

<template>
  <UPopover
    :open="open"
    :content="popoverContent"
    :ui="{ content: 'w-(--reka-popper-anchor-width) min-w-64 max-w-[calc(100vw-1rem)] p-0' }"
    @update:open="onOpenChange"
  >
    <template #anchor>
      <div ref="anchor" class="min-w-0" v-bind="$attrs">
        <UInput
          ref="input"
          v-model="query"
          icon="i-lucide-search"
          size="sm"
          class="w-full"
          :placeholder="placeholder"
          :role="suggest ? 'combobox' : undefined"
          :aria-autocomplete="suggest ? 'list' : undefined"
          :aria-label="label"
          :aria-expanded="suggest ? open : undefined"
          :aria-controls="open ? listboxId : undefined"
          :aria-activedescendant="open && activeIndex >= 0 ? optionId(activeIndex) : undefined"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          @focus="onFocus"
          @blur="onBlur"
          @input="onInput"
          @click="onClick"
          @keydown="onKeydown"
          @keyup="onKeyup"
        >
          <template #trailing>
            <UButton
              v-if="query"
              color="neutral"
              variant="link"
              size="xs"
              icon="i-lucide-x"
              aria-label="Clear search"
              title="Clear search"
              class="-me-1"
              @click="clear"
            />
            <!-- Always an element: an empty slot would bring back the input's own trailing icon. -->
            <span v-else class="hidden sm:inline-flex items-center gap-0.5 pointer-events-none" aria-hidden="true">
              <template v-if="findShortcut && !focused">
                <UKbd value="meta" size="sm" />
                <UKbd value="f" size="sm" />
              </template>
            </span>
          </template>
        </UInput>
      </div>
    </template>

    <template #content>
      <!-- A press anywhere in the list keeps the focus, and so the list, in the box. -->
      <div @mousedown.prevent>
        <div
          :id="listboxId"
          role="listbox"
          :aria-label="`${label}: suggestions`"
          class="max-h-72 overflow-y-auto"
          :class="suggestions.length > 0 ? 'p-1' : 'pt-2'"
        >
          <p v-if="listingQualifiers" class="px-2 pt-1 pb-1 text-xs text-muted" aria-hidden="true">Filter by</p>
          <div
            v-for="(suggestion, index) in suggestions"
            :id="optionId(index)"
            :key="suggestionKey(suggestion)"
            role="option"
            :aria-selected="index === activeIndex"
            class="flex items-center gap-2 min-w-0 rounded-md px-2 py-1.5 text-sm cursor-pointer select-none"
            :class="index === activeIndex ? 'bg-elevated' : 'hover:bg-elevated/60'"
            @mousemove="activeIndex = index"
            @click="choose(index)"
          >
            <template v-if="suggestion.kind === 'field'">
              <span class="font-mono text-highlighted shrink-0"
                >{{ completion.negated ? '-' : '' }}{{ suggestion.key }}:</span
              >
              <span class="text-xs text-muted truncate">{{ suggestion.description }}</span>
            </template>
            <template v-else>
              <span class="font-mono min-w-0 truncate">
                <span class="text-muted">{{ completion.negated ? '-' : '' }}{{ suggestion.key }}:</span>
                <span class="text-highlighted"
                  ><SearchHighlight :text="suggestion.value" :patterns="[completion.value]"
                /></span>
              </span>
              <span
                class="ml-auto shrink-0 text-xs text-muted tabular-nums"
                :title="`${suggestion.count} ${suggestion.count === 1 ? 'test' : 'tests'}`"
                >{{ suggestion.count }}</span
              >
            </template>
          </div>
        </div>
        <p v-if="hint" class="px-3 pb-2 text-xs text-muted">
          <span class="font-mono text-highlighted">{{ hint.key }}:</span> {{ hint.description }}, matched anywhere in it
          — <span class="font-mono">*</span> stands for any characters.
        </p>
        <p class="hidden sm:block border-t border-default px-3 py-1.5 text-xs text-muted">
          <span class="font-mono">-</span> excludes · <span class="font-mono">"…"</span> keeps spaces ·
          <span class="font-mono">*</span> matches anything
        </p>
      </div>
    </template>
  </UPopover>
</template>
