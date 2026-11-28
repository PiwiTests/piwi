<script setup lang="ts">
/**
 * Visual diff between the failing screenshot and the same test's last passing
 * screenshot. Self-contained: fetches (and thereby lazily computes) the diff
 * for a test-run case, then offers an overlay view and a side-by-side view.
 * Used on the test-case detail page and the cluster evidence column.
 */

import SectionCard from '../shared/SectionCard.vue';
import CollapsibleSectionCard from '../shared/CollapsibleSectionCard.vue';
import type { LightboxImage, LightboxSubject } from '~/utils/lightbox';

const props = defineProps<{
  testRunsCaseId: number;
  /** When set, the card folds to a header with a peek (persisted per user). */
  storageKey?: string;
  /** Drop the card frame and padding — render a plain heading row over the body. */
  embedded?: boolean;
  /** The execution's error, shown beside the enlarged failing screenshot. */
  error?: string | null;
  /** The test, named in the enlarged screenshots' details. */
  subject?: LightboxSubject | null;
}>();

interface VisualDiffResponse {
  status: 'ok' | 'no-screenshot' | 'no-baseline' | 'not-found' | 'error' | 'read-only';
  diff?: {
    path: string;
    changedPixels: number;
    changedPixelRatio: number;
    width: number;
    height: number;
    dimensionMismatch: boolean;
    baselineTestRunsCaseId: number;
    baselineRunId: number;
    failingPath: string;
    baselinePath: string;
    /** Set when the baseline came from another environment than the failing run. */
    baselineNote?: string | null;
  };
}

const cardComponent = computed(() =>
  props.embedded ? SectionCard : props.storageKey ? CollapsibleSectionCard : SectionCard,
);
const cardBind = computed(() =>
  props.embedded ? { embedded: true } : props.storageKey ? { storageKey: props.storageKey } : {},
);

const config = useRuntimeConfig();

const {
  data: result,
  pending,
  error,
} = useFetch<VisualDiffResponse>(() => `/api/test-run-cases/${props.testRunsCaseId}/visual-diff`, {
  lazy: true,
});

const diff = computed(() => (result.value?.status === 'ok' ? (result.value.diff ?? null) : null));

// The card renders only for a usable diff; the page reads `available` to show
// its jump chip for exactly the same condition.
const emit = defineEmits<{ available: [value: boolean] }>();
const available = computed(() => !pending.value && !error.value && !!diff.value);
watch(available, (value) => emit('available', value), { immediate: true });

const view = ref<'overlay' | 'side-by-side'>('overlay');
const viewItems = [
  { label: 'Overlay', value: 'overlay' as const },
  { label: 'Side by side', value: 'side-by-side' as const },
];

const overlaySrc = computed(() => (diff.value ? fileApiUrl(diff.value.path, 'image/png', config.app?.baseURL) : ''));
const failingSrc = computed(() => (diff.value ? fileApiUrl(diff.value.failingPath, null, config.app?.baseURL) : ''));
const baselineSrc = computed(() => (diff.value ? fileApiUrl(diff.value.baselinePath, null, config.app?.baseURL) : ''));

const changedPct = computed(() => (diff.value ? (diff.value.changedPixelRatio * 100).toFixed(2) : '0'));

const ratioColor = computed<'success' | 'warning' | 'error'>(() => {
  const r = diff.value?.changedPixelRatio ?? 0;
  if (r > 0.1) return 'error';
  if (r > 0.01) return 'warning';
  return 'success';
});

const foldedText = computed(() => {
  if (!diff.value) return 'No comparable screenshots';
  if (diff.value.dimensionMismatch) return `${changedPct.value}% changed — dimensions differ, unreliable`;
  return `${changedPct.value}% of pixels changed vs visual baseline`;
});

// Lightbox over the three views (failing / baseline / overlay), each with the
// comparison's facts in its details.
const lightboxImages = computed<LightboxImage[]>(() => {
  const d = diff.value;
  if (!d) return [];
  const changed = [
    `${changedPct.value}% of pixels changed against the visual baseline`,
    ...(d.dimensionMismatch ? ['Dimensions differ: the changed-pixel ratio is unreliable'] : []),
  ];
  const baselineNote = d.baselineNote ? [d.baselineNote] : [];
  return [
    { src: failingSrc.value, name: 'Failing screenshot', failed: true, error: props.error || null, facts: changed },
    {
      src: baselineSrc.value,
      name: 'Last passing screenshot',
      facts: [`From run #${d.baselineRunId}`, ...baselineNote],
    },
    {
      src: overlaySrc.value,
      name: 'Diff overlay (red = changed pixels)',
      facts: [...changed, `Baseline from run #${d.baselineRunId}`, ...baselineNote],
    },
  ];
});
const lightboxIndex = ref<number | null>(null);

// Forward reveal so a diagnosis citation can unfold + scroll to this card.
const card = ref<{ reveal?: () => void } | null>(null);
defineExpose({ reveal: () => card.value?.reveal?.() });
</script>

<template>
  <component
    :is="cardComponent"
    v-if="available && diff"
    ref="card"
    v-bind="cardBind"
    icon="i-lucide-images"
    title="Visual diff"
    help="visual-diff"
  >
    <template v-if="storageKey" #folded>
      <span>{{ foldedText }}</span>
    </template>
    <template #subtitle>
      <span
        >vs visual baseline (run #{{ diff.baselineRunId }}){{
          diff.baselineNote ? ` · ${diff.baselineNote}` : ''
        }}</span
      >
    </template>
    <template #actions>
      <UBadge :color="ratioColor" variant="subtle" size="sm" class="font-mono tabular-nums">
        {{ changedPct }}% changed
      </UBadge>
    </template>

    <UAlert
      v-if="diff.dimensionMismatch"
      class="mb-3"
      color="warning"
      icon="i-lucide-alert-triangle"
      variant="subtle"
      title="Screenshot dimensions differ"
      description="The failing and passing screenshots have different sizes (viewport change?). They are compared on a padded canvas, so the changed-pixel ratio is inflated and unreliable."
    />

    <div class="flex justify-end mb-2">
      <UTabs
        v-model="view"
        :items="viewItems"
        size="xs"
        :content="false"
        :ui="{ list: 'overflow-x-auto', trigger: 'shrink-0' }"
      />
    </div>

    <!-- Overlay: red pixels mark what changed against the last pass -->
    <div v-if="view === 'overlay'" class="rounded overflow-hidden border border-default bg-gray-50 dark:bg-gray-900">
      <img
        :src="overlaySrc"
        alt="Diff overlay (red = changed pixels)"
        class="w-full max-h-96 object-contain cursor-zoom-in outline-none focus-visible:outline-2 focus-visible:outline-primary"
        loading="lazy"
        role="button"
        tabindex="0"
        aria-label="Open diff overlay in lightbox"
        @click="lightboxIndex = 2"
        @keydown.enter="lightboxIndex = 2"
        @keydown.space.prevent="lightboxIndex = 2"
      />
      <p class="px-2 py-1 text-[10px] text-gray-500">Red pixels mark differences against the last passing run</p>
    </div>

    <!-- Side by side: stacks vertically on phones -->
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <div class="rounded overflow-hidden border border-red-200 dark:border-red-900 bg-gray-50 dark:bg-gray-900">
        <p class="px-2 py-1 text-[10px] font-medium text-red-600 dark:text-red-400">Failing</p>
        <img
          :src="failingSrc"
          alt="Failing screenshot"
          class="w-full max-h-80 object-contain cursor-zoom-in outline-none focus-visible:outline-2 focus-visible:outline-primary"
          loading="lazy"
          role="button"
          tabindex="0"
          aria-label="Open failing screenshot in lightbox"
          @click="lightboxIndex = 0"
          @keydown.enter="lightboxIndex = 0"
          @keydown.space.prevent="lightboxIndex = 0"
        />
      </div>
      <div class="rounded overflow-hidden border border-green-200 dark:border-green-900 bg-gray-50 dark:bg-gray-900">
        <p class="px-2 py-1 text-[10px] font-medium text-green-600 dark:text-green-400">
          Visual baseline (run #{{ diff.baselineRunId }})
        </p>
        <img
          :src="baselineSrc"
          alt="Last passing screenshot"
          class="w-full max-h-80 object-contain cursor-zoom-in outline-none focus-visible:outline-2 focus-visible:outline-primary"
          loading="lazy"
          role="button"
          tabindex="0"
          aria-label="Open last passing screenshot in lightbox"
          @click="lightboxIndex = 1"
          @keydown.enter="lightboxIndex = 1"
          @keydown.space.prevent="lightboxIndex = 1"
        />
      </div>
    </div>

    <ScreenshotLightbox v-model="lightboxIndex" :images="lightboxImages" :subject="subject" />
  </component>
</template>
