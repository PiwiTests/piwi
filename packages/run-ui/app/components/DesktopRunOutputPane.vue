<script setup lang="ts">
/**
 * A run's output as its terminal printed it, the same in every view of a run the shell starts (the dashboard's Local
 * runs tray, its run page and output window, Piwi Runner's window): each line in Playwright's colors (`renderAnsi`), a
 * stderr line in red, on a dark pane that follows the newest line until the person scrolls up, then offers **Go to the
 * latest line**. Above it, a filter that keeps the lines holding its text (case and accents ignored), **Go to the first
 * error** (`runOutputFirstError`), a toggle that wraps long lines, and **Copy output**, which copies every line kept,
 * without colors. The pane can be dragged taller; `fill` makes it take its container's height instead (a window of its
 * own).
 */
import { renderAnsi } from '@piwitests/run-ui/ansi';
import { PRESSED_TOGGLE_CLASS } from '@piwitests/run-ui/ui-classes';
import type { RunOutputLine } from '@piwitests/run-ui/run-output';

const props = defineProps<{ lines: readonly RunOutputLine[]; fill?: boolean }>();

/** How close to the end, in pixels, the reader still follows the newest line. */
const AT_END_PX = 24;
/** How long the line Go to the first error reached stays marked. */
const MARKED_MS = 2_000;

const words = useRunUiWords();
const { t, tn } = words;
const { copy, copied } = useCopy();

const pane = useTemplateRef<HTMLElement>('pane');
const pinned = ref(true);
const query = ref('');
const wrap = ref(true);
const marked = ref<number | null>(null);

const shown = computed(() => runOutputMatching(props.lines, query.value));
const filtering = computed(() => query.value.trim() !== '');
const firstError = computed(() => runOutputFirstError(props.lines));

/** Each colored line's HTML, rendered once. */
const rendered = new WeakMap<RunOutputLine, string>();
function coloredHtml(line: RunOutputLine): string {
  let html = rendered.get(line);
  if (html === undefined) {
    html = renderAnsi(line.ansi ?? line.text, { onDark: true });
    rendered.set(line, html);
  }
  return html;
}

function onScroll() {
  const el = pane.value;
  if (!el) return;
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
}

function toLatest() {
  pinned.value = true;
  pane.value?.scrollTo({ top: pane.value.scrollHeight });
}

/** Scrolls to the first error, marked a moment; the filter goes when it hides that line. */
async function toFirstError() {
  const line = firstError.value;
  if (!line) return;
  if (!shown.value.includes(line)) query.value = '';
  pinned.value = false;
  marked.value = line.id;
  await nextTick();
  // The pane scrolls alone, never the window or the tray around it: it is the line's offset parent.
  const el = pane.value;
  const target = el?.querySelector<HTMLElement>(`[data-line="${line.id}"]`);
  if (el && target) el.scrollTo({ top: Math.max(0, target.offsetTop - el.clientHeight / 3) });
  setTimeout(() => {
    if (marked.value === line.id) marked.value = null;
  }, MARKED_MS);
}

// The newest line, not the count: a run that keeps only its last lines drops one for each it adds.
watch(
  () => [props.lines.at(-1)?.id, query.value],
  async () => {
    if (!pinned.value) return;
    await nextTick();
    pane.value?.scrollTo({ top: pane.value.scrollHeight });
  },
);

onMounted(() => pane.value?.scrollTo({ top: pane.value.scrollHeight }));
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1" :class="fill ? 'h-full' : ''" data-testid="run-output">
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <UInput
        v-model="query"
        size="xs"
        icon="i-lucide-search"
        :placeholder="t('runui_outputFilter')"
        :aria-label="t('runui_outputFilter')"
        class="w-44 min-w-0 sm:w-56"
      />
      <!-- Drawn while empty too, so the first count is read out. -->
      <span class="text-xs text-muted tabular-nums" aria-live="polite">{{
        filtering ? tn('runui_outputMatches', lines.length, { shown: words.number(shown.length) }) : ''
      }}</span>
      <span class="flex-1" />
      <UTooltip v-if="firstError" :text="t('runui_outputFirstError')">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-circle-alert"
          :aria-label="t('runui_outputFirstError')"
          @click="toFirstError"
        />
      </UTooltip>
      <UTooltip :text="t('runui_outputWrap')">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-wrap-text"
          :aria-label="t('runui_outputWrap')"
          :aria-pressed="wrap"
          :class="wrap ? PRESSED_TOGGLE_CLASS : ''"
          @click="wrap = !wrap"
        />
      </UTooltip>
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        :disabled="lines.length === 0"
        @click="copy(runOutputText(lines))"
      >
        {{ copied ? t('runui_commonCopied') : t('runui_outputCopy') }}
      </UButton>
    </div>
    <div class="relative min-h-0" :class="fill ? 'flex-1' : ''">
      <!-- The pane scrolls with the keyboard too: it takes the focus. -->
      <div
        ref="pane"
        role="region"
        tabindex="0"
        :aria-label="t('runui_outputLabel')"
        class="relative overflow-auto rounded-md bg-neutral-950 p-3 font-mono text-xs leading-5 text-neutral-300 ring ring-neutral-800 focus-visible:outline-2 focus-visible:outline-primary"
        :class="fill ? 'h-full' : 'h-48 min-h-24 resize-y'"
        @scroll.passive="onScroll"
      >
        <template v-for="line in shown" :key="line.id">
          <!-- eslint-disable-next-line vue/no-v-html — renderAnsi escapes the text before wrapping it in styled spans -->
          <p
            v-if="line.ansi"
            :data-line="line.id"
            :class="[
              wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
              line.error ? 'text-red-400' : '',
              marked === line.id ? 'bg-red-500/20' : '',
            ]"
            v-html="coloredHtml(line)"
          />
          <p
            v-else
            :data-line="line.id"
            :class="[
              wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
              line.error ? 'text-red-400' : '',
              marked === line.id ? 'bg-red-500/20' : '',
            ]"
          >
            {{ line.text || ' ' }}
          </p>
        </template>
        <p v-if="lines.length === 0" class="text-neutral-500">{{ t('runui_outputWaiting') }}</p>
        <p v-else-if="shown.length === 0" class="text-neutral-500">{{ t('runui_outputNoMatch') }}</p>
      </div>
      <UButton
        v-if="!pinned && shown.length > 0"
        size="xs"
        color="neutral"
        variant="solid"
        icon="i-lucide-arrow-down"
        class="absolute right-4 bottom-3 shadow"
        @click="toLatest"
      >
        {{ t('runui_outputLatest') }}
      </UButton>
    </div>
  </div>
</template>
