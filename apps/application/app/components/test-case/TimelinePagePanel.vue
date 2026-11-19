<script setup lang="ts">
/**
 * The page at one moment of the failure timeline, from the trace's screencast:
 * for a step, the page before it ran or after it (at the failure for the
 * failing step), with a line when no new frame was painted while it ran; for
 * a request, a console entry, a dialog or a backend log, the page when it
 * happened; for a moment, the page then and the step running. The frame is the
 * one the page in front had painted by then (`pageInFront`); a click opens the
 * frames full screen there, and the arrows move to the previous or next frame
 * of that page. Beside the step list from `xl`, under the tapped row below it
 * (`inline`, without the arrows).
 */
import {
  frameIndexAt,
  pageInFront,
  subjectMoment,
  type PageSubject,
  type PlacedFramePage,
} from '~/utils/timeline-frames';

const props = defineProps<{
  subject: PageSubject;
  pages: PlacedFramePage[];
  frameUrl: (name: string) => string;
  /** A moment as the timeline writes it (`t-1.2s`). */
  formatTime: (at: number) => string;
  failureAt: number;
  /** Under its row: no arrows, a plainer frame. */
  inline?: boolean;
}>();

const emit = defineEmits<{
  /** Open the frames of `page` full screen at `frame`. */
  open: [page: number, frame: number];
  /** Show the page at another moment. */
  move: [at: number];
  /** Show a step before or after it ran. */
  phase: [phase: 'before' | 'after'];
}>();

const moment = computed(() => subjectMoment(props.subject, props.failureAt));
const shown = computed(() => pageInFront(props.pages, moment.value));
const frame = computed(() => (shown.value ? props.pages[shown.value.page]!.frames[shown.value.frame]! : null));

const EVENT_TITLES: Record<Extract<PageSubject, { kind: 'event' }>['event'], string> = {
  network: 'When the request started',
  console: 'When the console wrote this',
  dialogs: 'When the dialog opened',
  backend: 'When the backend logged this',
};

const title = computed(() => {
  const s = props.subject;
  if (s.kind === 'event') return EVENT_TITLES[s.event];
  if (s.kind === 'moment') return 'The page then';
  if (s.phase === 'before') return 'Before the step';
  return s.failed ? 'At the failure' : 'After the step';
});

/** For a step: whether the page painted no new frame while it ran. */
const unchanged = computed(() => {
  const s = props.subject;
  if (s.kind !== 'step' || !shown.value) return false;
  const page = props.pages[shown.value.page]!;
  const before = frameIndexAt(page.frames, s.at);
  const after = frameIndexAt(page.frames, subjectMoment({ ...s, phase: 'after' }, props.failureAt));
  return before >= 0 && before === after;
});

const neighbours = computed(() => {
  if (!shown.value) return { previous: null, next: null };
  const frames = props.pages[shown.value.page]!.frames;
  const i = shown.value.frame;
  return { previous: frames[i - 1]?.at ?? null, next: frames[i + 1]?.at ?? null };
});

const phases = computed<{ value: 'before' | 'after'; label: string }[]>(() => [
  { value: 'before', label: 'Before' },
  {
    value: 'after',
    label: props.subject.kind === 'step' && props.subject.failed ? 'At the failure' : 'After',
  },
]);

const aspect = computed(() =>
  frame.value && frame.value.width > 0 && frame.value.height > 0 ? frame.value.width / frame.value.height : 16 / 9,
);
</script>

<template>
  <section
    :aria-label="`${title}, ${formatTime(moment)}`"
    data-testid="timeline-page-panel"
    class="space-y-2"
    :class="inline ? '' : 'rounded-lg border border-default p-3'"
  >
    <div class="flex items-center justify-between gap-2">
      <p class="text-sm font-semibold text-highlighted">
        {{ title }} <span class="font-normal text-muted tabular-nums">· {{ formatTime(moment) }}</span>
      </p>
      <div v-if="!inline && shown" class="flex shrink-0 gap-1">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-chevron-left"
          aria-label="The page at its previous frame"
          :disabled="neighbours.previous == null"
          @click="neighbours.previous != null && emit('move', neighbours.previous)"
        />
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-chevron-right"
          aria-label="The page at its next frame"
          :disabled="neighbours.next == null"
          @click="neighbours.next != null && emit('move', neighbours.next)"
        />
      </div>
    </div>

    <div
      v-if="subject.kind === 'step'"
      role="group"
      aria-label="Before or after the step"
      class="inline-flex gap-0.5 rounded-md bg-elevated/60 p-0.5"
    >
      <button
        v-for="option in phases"
        :key="option.value"
        type="button"
        :aria-pressed="subject.phase === option.value ? 'true' : 'false'"
        class="rounded px-2 py-0.5 text-xs whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:outline-primary"
        :class="subject.phase === option.value ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default'"
        @click="emit('phase', option.value)"
      >
        {{ option.label }}
      </button>
    </div>

    <button
      v-if="frame && shown"
      type="button"
      class="block w-full overflow-hidden rounded-md border bg-elevated cursor-zoom-in outline-none focus-visible:outline-2 focus-visible:outline-primary"
      :class="
        subject.kind === 'step' && subject.failed && subject.phase === 'after'
          ? 'border-status-failed'
          : 'border-default'
      "
      :aria-label="`Open the page full screen, ${formatTime(frame.at)}`"
      @click="emit('open', shown.page, shown.frame)"
    >
      <img
        :src="frameUrl(frame.name)"
        alt=""
        class="block w-full object-cover object-top"
        :style="{ aspectRatio: String(aspect) }"
      />
    </button>
    <p v-else class="text-xs text-muted">The page painted nothing yet at this moment.</p>

    <p v-if="subject.kind !== 'moment' || subject.label" class="text-sm break-words">{{ subject.label }}</p>
    <p v-if="unchanged" class="text-xs text-muted">No new frame was painted while this step ran.</p>
    <p v-if="subject.kind === 'event' && subject.event === 'dialogs'" class="text-xs text-muted">
      A native dialog does not show in the screencast: this is the page behind it.
    </p>
    <p v-if="frame" class="text-xs text-muted tabular-nums">
      Painted at {{ formatTime(frame.at) }}<template v-if="pages.length > 1"> · page {{ shown!.page + 1 }}</template>
    </p>
  </section>
</template>
