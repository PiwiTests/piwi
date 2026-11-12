<script setup lang="ts">
/**
 * Full-screen viewer for a list of images: arrow keys and buttons step through
 * them, Escape closes, and a capture larger than the stage toggles to actual
 * size. Beside the image (below it on a phone) a details panel says what the
 * page shows — the test, the name the test attached the screenshot under (its
 * expected result on a line of its own), the step it was captured at, the
 * error raised on it and facts about the image — whenever the caller supplied
 * any of them; it can be hidden to give the image the whole screen.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useElementSize } from '@vueuse/core';
import { splitExpected, type LightboxImage, type LightboxSubject } from '~/utils/lightbox';

const props = defineProps<{
  images: LightboxImage[];
  modelValue: number | null;
  /** The test the images belong to, named in the details panel. */
  subject?: LightboxSubject | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: number | null];
}>();

const isOpen = computed(() => props.modelValue !== null);

const currentImage = computed(() => {
  if (props.modelValue === null) return null;
  return props.images[props.modelValue] ?? null;
});

// ── Details panel ───────────────────────────────────────────────────────────
// Listed for the whole set once any image or the subject has something to say,
// so stepping through the images never makes the stage jump.
const hasDetails = computed(
  () =>
    Boolean(props.subject?.title || props.subject?.location) ||
    props.images.some((img) => img.attachmentName || img.step || img.error || img.facts?.length),
);
const detailsOpen = ref(true);
const detailsShown = computed(() => hasDetails.value && detailsOpen.value);
// The attached name in full, the header's caption being cut to one line.
const attachedName = computed(() => {
  const name = currentImage.value?.attachmentName;
  return name ? splitExpected(name) : null;
});
// The caller's facts, after the image's own size once it has loaded.
const imageFacts = computed(() => [
  ...(natural.value ? [`${natural.value.w}×${natural.value.h} px`] : []),
  ...(currentImage.value?.facts ?? []),
]);

// ── Zoom ────────────────────────────────────────────────────────────────────
// Natural size of the shown image, read on load — drives whether "actual size"
// can reveal more than the fitted view already shows.
const natural = ref<{ w: number; h: number } | null>(null);
const zoomed = ref(false);
const stage = ref<HTMLElement | null>(null);
const { width: stageW, height: stageH } = useElementSize(stage);

// The fitted view caps the image at the stage's content box, so it can only zoom
// past the fit when the source is larger than that. Small screenshots never offer
// the toggle.
const canZoom = computed(() => !!natural.value && (natural.value.w > stageW.value || natural.value.h > stageH.value));

function close() {
  emit('update:modelValue', null);
}

function prev() {
  if (props.modelValue !== null && props.modelValue > 0) {
    emit('update:modelValue', props.modelValue - 1);
  }
}

function next() {
  if (props.modelValue !== null && props.modelValue < props.images.length - 1) {
    emit('update:modelValue', props.modelValue + 1);
  }
}

function toggleZoom() {
  if (canZoom.value) zoomed.value = !zoomed.value;
}

function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement;
  natural.value = { w: img.naturalWidth, h: img.naturalHeight };
}

// Reset the per-image state whenever the shown image (or open state) changes, so
// a zoomed-in view never carries over to the next screenshot.
watch(
  () => props.modelValue,
  () => {
    zoomed.value = false;
    natural.value = null;
  },
);

function onKeydown(e: KeyboardEvent) {
  if (!isOpen.value) return;
  if (e.key === 'Escape') {
    if (zoomed.value) zoomed.value = false;
    else close();
  }
  if (e.key === 'ArrowLeft') prev();
  if (e.key === 'ArrowRight') next();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

const roundButton =
  'flex size-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20';
</script>

<template>
  <Teleport to="body">
    <Transition name="lightbox">
      <div
        v-if="isOpen && currentImage"
        class="fixed inset-0 z-50 flex flex-col bg-black/95"
        role="dialog"
        aria-modal="true"
        :aria-label="currentImage.name"
      >
        <!-- Counter, caption and actions -->
        <div class="flex shrink-0 items-center gap-3 px-4 py-3">
          <span
            v-if="images.length > 1"
            class="shrink-0 rounded-full bg-white/10 px-3 py-1 text-sm font-medium text-white/80 tabular-nums"
          >
            {{ (modelValue ?? 0) + 1 }} / {{ images.length }}
          </span>
          <p class="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-white/90">
            <span
              v-if="currentImage.failed"
              class="inline-block size-2 shrink-0 rounded-full"
              :class="STATUS_PALETTE.failed.bg"
              aria-hidden="true"
            />
            <span class="truncate" :title="currentImage.name">{{ currentImage.name }}</span>
          </p>
          <div class="flex shrink-0 items-center gap-2">
            <button
              v-if="canZoom"
              type="button"
              :class="roundButton"
              :title="zoomed ? 'Fit to screen' : 'Actual size'"
              :aria-label="zoomed ? 'Fit to screen' : 'Actual size'"
              @click="toggleZoom"
            >
              <UIcon :name="zoomed ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'" class="size-5" />
            </button>
            <button
              v-if="hasDetails"
              type="button"
              :class="roundButton"
              :title="detailsOpen ? 'Hide details' : 'Show details'"
              :aria-label="detailsOpen ? 'Hide details' : 'Show details'"
              :aria-pressed="detailsOpen ? 'true' : 'false'"
              @click="detailsOpen = !detailsOpen"
            >
              <!-- The panel sits below the image on a phone, beside it from `lg`. -->
              <UIcon
                :name="detailsOpen ? 'i-lucide-panel-bottom-close' : 'i-lucide-panel-bottom-open'"
                class="size-5 lg:hidden"
              />
              <UIcon
                :name="detailsOpen ? 'i-lucide-panel-right-close' : 'i-lucide-panel-right-open'"
                class="hidden size-5 lg:block"
              />
            </button>
            <button type="button" :class="roundButton" title="Close" aria-label="Close" @click="close">
              <UIcon name="i-lucide-x" class="size-6" />
            </button>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
          <!-- Stage: centers the fitted image, and pans it when zoomed. -->
          <div class="relative min-h-0 min-w-0 flex-1">
            <div
              ref="stage"
              class="absolute inset-0 flex overflow-auto p-4 sm:px-16 sm:pb-10 sm:pt-2"
              @click.self="close"
            >
              <img
                :src="currentImage.src"
                :alt="currentImage.name"
                class="m-auto rounded-lg shadow-2xl"
                :class="[
                  zoomed ? 'max-w-none' : 'max-h-full max-w-full object-contain',
                  canZoom ? (zoomed ? 'cursor-zoom-out' : 'cursor-zoom-in') : '',
                ]"
                @click.stop="toggleZoom"
                @load="onImgLoad"
              />
            </div>

            <button
              v-if="images.length > 1 && (modelValue ?? 0) > 0"
              type="button"
              class="absolute top-1/2 left-2 -translate-y-1/2 sm:left-4"
              :class="roundButton"
              title="Previous"
              aria-label="Previous screenshot"
              @click="prev"
            >
              <UIcon name="i-lucide-chevron-left" class="size-6" />
            </button>
            <button
              v-if="images.length > 1 && (modelValue ?? 0) < images.length - 1"
              type="button"
              class="absolute top-1/2 right-2 -translate-y-1/2 sm:right-4"
              :class="roundButton"
              title="Next"
              aria-label="Next screenshot"
              @click="next"
            >
              <UIcon name="i-lucide-chevron-right" class="size-6" />
            </button>
          </div>

          <!-- What the page shows: the test, the step, the error raised on it. -->
          <aside
            v-if="detailsShown"
            aria-label="Screenshot details"
            data-shot="lightbox-details"
            class="max-h-[45vh] shrink-0 overflow-y-auto border-t border-default bg-default p-4 lg:max-h-none lg:w-96 lg:border-t-0 lg:border-l"
          >
            <dl class="space-y-4">
              <div v-if="subject?.title || subject?.location" class="space-y-1">
                <dt class="text-sm font-semibold text-highlighted">Test</dt>
                <dd v-if="subject.title" class="text-sm text-highlighted leading-relaxed break-words">
                  {{ subject.title }}
                </dd>
                <dd v-if="subject.location" class="text-xs text-muted">
                  <OpenInIdeLink
                    :location="subject.location"
                    :project-key="subject.projectKey ?? undefined"
                    :project-name="subject.projectName ?? undefined"
                  />
                </dd>
              </div>
              <div v-if="attachedName" class="space-y-1">
                <dt class="text-sm font-semibold text-highlighted">Screenshot</dt>
                <dd class="text-sm text-highlighted leading-relaxed break-words">{{ attachedName.step }}</dd>
                <template v-if="attachedName.expected">
                  <dt class="pt-2 text-sm font-semibold text-highlighted">Expected</dt>
                  <dd class="text-sm text-highlighted leading-relaxed break-words">{{ attachedName.expected }}</dd>
                </template>
              </div>
              <div v-if="currentImage.step" class="space-y-1">
                <dt class="text-sm font-semibold text-highlighted">Step</dt>
                <dd class="font-mono text-sm text-highlighted leading-relaxed break-words">
                  {{ currentImage.step }}
                </dd>
              </div>
              <div v-if="currentImage.error" class="space-y-1">
                <dt class="text-sm font-semibold text-highlighted">Error</dt>
                <dd><ErrorText :text="currentImage.error" mode="block" /></dd>
              </div>
              <div v-if="imageFacts.length" class="space-y-1">
                <dt class="text-sm font-semibold text-highlighted">Image</dt>
                <dd v-for="fact in imageFacts" :key="fact" class="text-xs text-muted">{{ fact }}</dd>
              </div>
            </dl>
          </aside>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.lightbox-enter-active,
.lightbox-leave-active {
  transition: opacity 0.2s ease;
}
.lightbox-enter-from,
.lightbox-leave-to {
  opacity: 0;
}
</style>
