<script setup lang="ts">
/**
 * A filmstrip of the page *before* each step, from this run's trace screen
 * snapshots (Playwright 1.63 `snapshots.screen`). One thumbnail per step in
 * order, the failing step marked, each opening full-screen in the shared
 * lightbox with its step, and the error beside the failing one. Renders nothing
 * when the trace carries no screen snapshots.
 */
import { useTraceSnapshots } from '~/composables/useTraceSnapshots';
import type { LightboxImage, LightboxSubject } from '~/utils/lightbox';

const props = withDefaults(
  defineProps<{
    testRunsCaseId: number;
    /** The execution's error, shown beside the enlarged failing step. */
    error?: string | null;
    /** The execution failed: only a failed execution has a failing step to mark. */
    failed?: boolean;
    /** The test, named in the enlarged screenshot's details. */
    subject?: LightboxSubject | null;
  }>(),
  { failed: true },
);

const { steps, hasScreen, snapshotUrl } = useTraceSnapshots(() => props.testRunsCaseId);

// One frame per step that recorded a before screenshot, in trace order. With no failing action the trace
// names the last step, so a frame is marked failed only when the execution failed.
const frames = computed(() =>
  steps.value
    .filter((s) => s.screen.before)
    .map((s) => ({ ...s, failed: props.failed && s.failed, src: snapshotUrl(s.callId, 'screen', 'before') })),
);

// The same list, shaped for the lightbox (a frame's index addresses it there).
const lightboxImages = computed<LightboxImage[]>(() =>
  frames.value.map((frame, i) => ({
    src: frame.src,
    name: `Before step ${i + 1}`,
    failed: frame.failed,
    step: frame.title,
    error: frame.failed ? props.error || null : null,
  })),
);
const lightboxIndex = ref<number | null>(null);
</script>

<template>
  <section v-if="hasScreen && frames.length" aria-label="Filmstrip of the page before each step" class="space-y-1.5">
    <div class="flex items-center gap-1.5 text-[11px] font-medium text-muted">
      <UIcon name="i-lucide-film" class="size-3.5" />
      <span>Before each step</span>
    </div>
    <ol class="flex gap-2 overflow-x-auto pb-1">
      <li v-for="(frame, i) in frames" :key="frame.callId" class="shrink-0">
        <figure class="w-40 space-y-1">
          <ZoomableImage
            :src="frame.src"
            :alt="`Page before step ${i + 1}: ${frame.title}`"
            :failed="frame.failed"
            frame-class="rounded"
            img-class="h-24 w-full object-cover object-top"
            @open="lightboxIndex = i"
          />
          <figcaption
            class="truncate text-[11px]"
            :class="frame.failed ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted'"
          >
            <span class="tabular-nums">{{ i + 1 }}.</span> {{ frame.title }}
            <span v-if="frame.failed" class="ml-0.5" aria-label="failed">✗</span>
          </figcaption>
        </figure>
      </li>
    </ol>

    <ScreenshotLightbox v-model="lightboxIndex" :images="lightboxImages" :subject="subject" />
  </section>
</template>
