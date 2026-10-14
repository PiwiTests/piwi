<script setup lang="ts">
/**
 * Interactive DOM snapshot locator picker. Opens as a modal, renders the
 * failure-time DOM snapshot in an iframe, and lets the user click the element
 * the failing locator should have targeted. The picked element is probed for
 * its attributes, ranked alternative locators are generated client-side, and
 * the user confirms one — which is saved back to the server. Without a failing
 * locator (a failure that was not about one) it is an inspector: any element's
 * locators, to copy. `at` names the trace action snapshot to open on, so the
 * picker shows the same page as the view it was opened from.
 */
import {
  generateAlternatives,
  approximateAccessibleName,
  CAPTURED_ATTRIBUTES,
  type RankedLocator,
  type ElementAttributes,
} from '#shared/locator-generation';
import type { LocatorFixRecommendation, LocatorHealingResult } from '#shared/locator-healing.types';
import { locatorExpression, recommendLocatorFix } from '#shared/locator-healing';
import { buildPickerDocument, deriveHighlightHints } from '~/utils/snapshot-picker-script';
import type { DomSnapshotMoment } from '~/composables/useDomSnapshot';
import LocatorAlternativeRow from './LocatorAlternativeRow.vue';

const props = defineProps<{
  testRunsCaseId: number;
  /** The locator that failed; null opens the picker as an inspector. */
  failingLocator: { method: string; args: Record<string, unknown> } | null;
  /** The healing result — its candidate names pre-highlight the likely element. */
  healing?: LocatorHealingResult | null;
  /** The trace action snapshot to open on; the failure-time snapshot when absent. */
  at?: DomSnapshotMoment | null;
}>();

// The `at` moment as query parameters, shared by the snapshot request and the frame.
function momentParams(): Record<string, string> {
  return props.at ? { callId: props.at.callId, phase: props.at.phase } : {};
}

const emit = defineEmits<{
  confirmed: [pick: RankedLocator];
}>();

const isOpen = defineModel<boolean>('open', { required: true });

type SnapshotSource = 'dom' | 'aria';

interface DomSnapshotResponse {
  status: 'ok' | 'no-trace' | 'no-snapshot';
  html?: string;
  snapshotName?: string;
  viewport?: { width: number; height: number };
  source?: SnapshotSource;
  availableSources?: SnapshotSource[];
}

const snapshotPending = ref(false);
const snapshot = ref<DomSnapshotResponse | null>(null);
const snapshotError = ref<string | null>(null);
// Which representation to request — undefined lets the server choose (trace
// DOM when available, else the ARIA tree). Set from the response and by the
// view toggle so the ARIA tree can be viewed even when a trace exists.
const viewSource = ref<SnapshotSource | undefined>(undefined);

async function fetchSnapshot() {
  snapshotPending.value = true;
  snapshotError.value = null;
  try {
    // Same endpoint as the read-only DOM snapshot card — trace-derived DOM with
    // an ARIA-tree fallback (or ?source=aria on demand) — for the status, the
    // viewport and the available views. The served frame comes from
    // `dom-snapshot-frame`, which embeds the trace's stylesheets and images
    // itself; only the demo builds the frame from this HTML.
    const query: Record<string, string> = momentParams();
    if (viewSource.value) query.source = viewSource.value;
    snapshot.value = await $fetch<DomSnapshotResponse>(`/api/test-run-cases/${props.testRunsCaseId}/dom-snapshot`, {
      query,
    });
    // Reflect what the server actually rendered so the toggle stays in sync.
    if (snapshot.value?.source) viewSource.value = snapshot.value.source;
  } catch (err: unknown) {
    snapshotError.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    snapshotPending.value = false;
  }
}

const availableSources = computed<SnapshotSource[]>(() => snapshot.value?.availableSources ?? []);

/** Switch representation (DOM ⇄ ARIA tree) and reload the picker on the new view. */
function selectSource(src: SnapshotSource) {
  if (src === viewSource.value || snapshotPending.value) return;
  viewSource.value = src;
  iframeReady.value = false;
  step.value = 'pick-element';
  contentHeight.value = 0;
  userZoomed.value = false;
  pickedAttrs.value = null;
  alternatives.value = [];
  selectedAlt.value = null;
  searchQuery.value = '';
  searchCount.value = 0;
  searchIndex.value = -1;
  fetchSnapshot();
}

const PICKER_STEP = { PICK_ELEMENT: 'pick-element', REVIEW: 'review' } as const;
type PickerStep = (typeof PICKER_STEP)[keyof typeof PICKER_STEP];

const step = ref<PickerStep>('pick-element');
const iframeRef = ref<HTMLIFrameElement | null>(null);
const iframeReady = ref(false);
// Set when the picker script fails to start (a thrown init error reported over
// postMessage, or the readiness timeout below) so the host shows why instead of
// an endless "Initializing picker…" spinner.
const pickerError = ref<string | null>(null);
const isDesktop = useIsDesktop();
const pickedAttrs = ref<ElementAttributes | null>(null);
const alternatives = ref<RankedLocator[]>([]);

// ── Build iframe content ────────────────────────────────────

// The snapshot loads into a HARDENED iframe — sandbox="allow-scripts" with NO
// allow-same-origin, so the picker runs on an opaque origin and can reach the
// host only via postMessage; a sanitizer bypass in the snapshot cannot touch the
// dashboard's cookies/storage/API. <base> is stripped so subresources can't be
// redirected to the tested app.
//
// The served app (web + desktop) loads the frame from a same-origin endpoint via
// `src`, so it carries the endpoint's own `sandbox allow-scripts` CSP. A `srcdoc`
// frame instead INHERITS the page CSP, and the desktop build's `strict-dynamic`
// policy then blocks the picker's inline script — the picker never starts. The
// demo is a static SPA with no server and no such CSP, so it keeps building the
// document inline as a `srcdoc` (its snapshots come from the in-browser router,
// not an API route an iframe `src` could reach).
const config = useRuntimeConfig();
const isDemo = !!config.public.demoMode;
const apiBase = (config.app.baseURL || '/').replace(/\/$/, '');

const srcDoc = computed(() =>
  isDemo && import.meta.client && snapshot.value?.html
    ? buildPickerDocument(snapshot.value.html, { probedAttrs: CAPTURED_ATTRIBUTES })
    : undefined,
);

// Bumped to force the iframe to reload — restarting the picker script — when
// re-picking or switching source (remounts via `:key`, and busts `frameSrc`).
const renderKey = ref(0);
function reloadFrame() {
  renderKey.value += 1;
}

// The served-app frame source. `renderKey` in the query busts the URL so a
// re-pick / reload re-runs the picker script (the endpoint is `no-store`, so
// this only forces a fresh navigation rather than defeating a cache).
const frameSrc = computed(() => {
  if (isDemo || snapshot.value?.status !== 'ok' || !snapshot.value.html) return undefined;
  const params = new URLSearchParams({ mode: 'pick', ...momentParams() });
  if (viewSource.value) params.set('source', viewSource.value);
  params.set('r', String(renderKey.value));
  return `${apiBase}/api/test-run-cases/${props.testRunsCaseId}/dom-snapshot-frame?${params.toString()}`;
});

// The picker signals `pickerReady` once its in-iframe script has run. If that
// never arrives — the script hung, or was blocked before it could run (a CSP
// block executes no code, so it can't even report an error) — surface a message
// instead of spinning forever. Armed whenever the frame (re)loads a document,
// cleared the moment it reports ready.
const READY_TIMEOUT_MS = 8000;
let readyTimer: ReturnType<typeof setTimeout> | null = null;
function clearReadyTimer() {
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
}
function armReadyTimer() {
  clearReadyTimer();
  pickerError.value = null;
  if (!import.meta.client) return;
  readyTimer = setTimeout(() => {
    if (iframeReady.value) return;
    pickerError.value = isDesktop
      ? 'The picker did not start. In the desktop app this is usually the Content-Security-Policy blocking the sandboxed snapshot frame — relaunch with --devtools (or PIWI_DEBUG=1) and check the console and logs/server.log to confirm.'
      : 'The picker did not start. Try reopening it; if it persists, the DOM snapshot may be malformed.';
  }, READY_TIMEOUT_MS);
}
// (Re)load of the frame — a new snapshot, a source switch, or a re-pick
// (renderKey bump) — re-arms the timer; a frame going away clears it.
watch([frameSrc, srcDoc, renderKey], () => {
  if (frameSrc.value || srcDoc.value) armReadyTimer();
  else clearReadyTimer();
});
watch(iframeReady, (ready) => {
  if (ready) clearReadyTimer();
});
onBeforeUnmount(clearReadyTimer);

// ── Viewport-accurate rendering (trace-viewer style) ────────────────────────
// Size the iframe to the recorded page viewport width and its full content
// height, then scale it with a CSS transform so the page keeps its true
// proportions and can be zoomed / fit to the pane instead of reflowing to a
// narrow column.

const stageRef = ref<HTMLElement | null>(null);
const stageWidth = ref(0);
const contentHeight = ref(0);
const zoom = ref(1);
// Once the user zooms manually, stop auto-fitting on resize.
const userZoomed = ref(false);

const viewport = computed(() => snapshot.value?.viewport ?? null);

/** Scale that fits the viewport width into the pane (never upscales past 100%). */
const fitZoom = computed(() => {
  const vp = viewport.value;
  if (!vp?.width || !stageWidth.value) return 1;
  return Math.min(stageWidth.value / vp.width, 1);
});

const canvasStyle = computed(() => {
  const vp = viewport.value;
  // No viewport (ARIA tree): fill the pane width, but grow to the reported
  // content height once known so the stage — not the iframe — scrolls, which
  // lets find-by-text jump to a match the same way the DOM view does.
  if (!vp) return { width: '100%', height: contentHeight.value ? `${contentHeight.value}px` : '100%' };
  const h = contentHeight.value || vp.height;
  return { width: `${Math.round(vp.width * zoom.value)}px`, height: `${Math.round(h * zoom.value)}px` };
});
const iframeStyle = computed(() => {
  const vp = viewport.value;
  if (!vp) return { width: '100%', height: contentHeight.value ? `${contentHeight.value}px` : '100%', border: '0' };
  const h = contentHeight.value || vp.height;
  return {
    width: `${vp.width}px`,
    height: `${h}px`,
    transform: `scale(${zoom.value})`,
    transformOrigin: 'top left',
    border: '0',
  };
});

const zoomPct = computed(() => Math.round(zoom.value * 100));
const clampZoom = (n: number): number => Math.min(4, Math.max(0.1, n));
function zoomBy(factor: number) {
  userZoomed.value = true;
  zoom.value = clampZoom(zoom.value * factor);
}
function fitToPane() {
  userZoomed.value = false;
  zoom.value = fitZoom.value;
}

// Auto-fit to the pane until the user takes manual control.
watch([fitZoom, viewport], () => {
  if (!userZoomed.value) zoom.value = fitZoom.value;
});

// The iframe's full content height arrives over postMessage from the in-iframe
// ResizeObserver (see `piwiContentHeight` in handleMessage) — the opaque-origin
// sandbox keeps the host from reading the iframe's document to measure it.

// Track the pane width for the fit calculation.
let stageObserver: ResizeObserver | null = null;
watch(stageRef, (el) => {
  stageObserver?.disconnect();
  if (!el) return;
  stageWidth.value = el.clientWidth;
  stageObserver = new ResizeObserver((entries) => {
    for (const e of entries) stageWidth.value = e.contentRect.width;
  });
  stageObserver.observe(el);
});
onBeforeUnmount(() => {
  stageObserver?.disconnect();
});

// ── Message handler from iframe ──────────────────────────────────────────────

function handleMessage(event: MessageEvent) {
  // Only trust messages from our own iframe — ignore stray postMessages from
  // other frames, extensions, or the snapshot's own (script-stripped) content.
  if (!iframeRef.value || event.source !== iframeRef.value.contentWindow) return;
  const data = event.data;
  if (data?.type === 'pickerReady') {
    iframeReady.value = true;
    // Pre-highlight the element the failing locator meant to hit, so the user
    // does not have to hunt for it in a full-page snapshot.
    postHighlightHints();
    return;
  }
  if (data?.type === 'piwiError') {
    // The picker script threw while starting — show why rather than spin
    // forever. The desktop error bridge also forwards this to logs/server.log.
    clearReadyTimer();
    pickerError.value =
      typeof data.message === 'string' && data.message ? data.message : 'The picker failed to initialize.';
    return;
  }
  if (data?.type === 'piwiContentHeight' && typeof data.height === 'number') {
    contentHeight.value = Math.max(data.height, viewport.value?.height ?? 0);
    return;
  }
  if (data?.type === 'piwiScrollTo' && typeof data.y === 'number') {
    // A match the picker found, or where the page was scrolled or the dialog it
    // showed: scroll the stage so it's in view (content-space y → stage-space
    // via the current zoom).
    const stage = stageRef.value;
    if (stage) stage.scrollTo({ top: Math.max(0, data.y * zoom.value - 80), behavior: 'smooth' });
    return;
  }
  if (data?.type === 'piwiSearchResult') {
    searchCount.value = typeof data.count === 'number' ? data.count : 0;
    searchIndex.value = typeof data.index === 'number' ? data.index : -1;
    return;
  }
  if (data?.type === 'elementPicked' && data.attrs) {
    // The in-page probe can't compute the browser's real accessible name —
    // approximate one from the probed attributes and label text so
    // getByRole(name)/getByLabel alternatives are generated for picks too.
    const { labelText, ...probed } = data.attrs as ElementAttributes;
    pickedAttrs.value = { ...probed, accessibleName: approximateAccessibleName({ ...probed, labelText }) };
    alternatives.value = generateAlternatives(pickedAttrs.value);
    selectedAlt.value = null;
    step.value = 'review';
  }
  if (data?.type === 'pickerClosed') {
    // Esc inside the iframe tears the picker down — close the whole modal rather
    // than leaving a blank iframe with no way to re-pick.
    close();
  }
}

function postToPicker(message: Record<string, unknown>) {
  iframeRef.value?.contentWindow?.postMessage(message, '*');
}

// ── Guidance: pre-highlight + text search ────────────────────────────────────

function postHighlightHints() {
  const hints = deriveHighlightHints({
    failingLocator: props.failingLocator,
    fromElementMatch: props.healing?.fromElementMatch ?? null,
    fromAriaSnapshot: props.healing?.fromAriaSnapshot ?? null,
  });
  if (hints.length) postToPicker({ type: 'piwiHighlight', hints });
}

const searchQuery = ref('');
const searchCount = ref(0);
const searchIndex = ref(-1);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

watch(searchQuery, (q) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => postToPicker({ type: 'piwiSearch', q }), 180);
});
function searchNext() {
  postToPicker({ type: 'piwiSearchNext' });
}
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});

// Forward arrow/Esc keys to the picker: the iframe rarely holds focus (the
// modal's focus-trap keeps it in the host document), so keydown never reaches
// the in-iframe listener. We relay them via postMessage while picking.
function forwardKeyToPicker(e: KeyboardEvent) {
  if (!isOpen.value || step.value !== 'pick-element' || !iframeReady.value) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  // Don't hijack arrow keys while the user is typing in the search field.
  const tag = (document.activeElement?.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  const win = iframeRef.value?.contentWindow;
  if (!win) return;
  e.preventDefault(); // stop the modal/page from scrolling on arrow keys
  win.postMessage({ type: 'piwiPickerKey', key: e.key }, '*');
}

onMounted(() => {
  window.addEventListener('message', handleMessage);
  window.addEventListener('keydown', forwardKeyToPicker, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('message', handleMessage);
  window.removeEventListener('keydown', forwardKeyToPicker, true);
});

// ── Confirmation ─────────────────────────────────────────────────────────────

const selectedAlt = ref<RankedLocator | null>(null);
const saving = ref(false);

// Every open starts a fresh session. `immediate` also starts one when the host
// mounts the picker already open, as the page-structure card does.
watch(
  isOpen,
  (open) => {
    if (!open) return;
    snapshot.value = null;
    iframeReady.value = false;
    step.value = 'pick-element';
    contentHeight.value = 0;
    userZoomed.value = false;
    // Let the server choose the default view again on each open.
    viewSource.value = undefined;
    // A previous session's pick must not leak into this one — Confirm would
    // otherwise already be enabled with a stale selection.
    pickedAttrs.value = null;
    alternatives.value = [];
    selectedAlt.value = null;
    searchQuery.value = '';
    searchCount.value = 0;
    searchIndex.value = -1;
    fetchSnapshot();
  },
  { immediate: true },
);

function selectAlternative(alt: RankedLocator) {
  selectedAlt.value = alt;
}

const recommendation = computed<LocatorFixRecommendation>(() =>
  recommendLocatorFix(props.failingLocator?.method, alternatives.value),
);

/** The failing locator as Playwright source, named in the header. */
const failingLocatorText = computed(() =>
  props.failingLocator ? locatorExpression(props.failingLocator.method, props.failingLocator.args) : null,
);

const toast = useToast();

async function confirm() {
  if (!selectedAlt.value || !props.failingLocator) return;
  saving.value = true;
  try {
    const result = await $fetch<{ status: string }>(`/api/test-run-cases/${props.testRunsCaseId}/locator-pick`, {
      method: 'POST',
      body: {
        failingLocator: props.failingLocator,
        pickedLocator: selectedAlt.value,
        element: pickedAttrs.value,
      },
    });
    if (result.status === 'ok') {
      emit('confirmed', selectedAlt.value);
    } else {
      // Persisted nowhere — the stored error has no call site or locator
      // signature to key the pick on. Copy still works from the review list.
      toast.add({
        title: 'Pick not saved',
        description: 'This failure has no call-site or locator signature to attach the pick to.',
        color: 'warning',
        icon: 'i-lucide-alert-triangle',
      });
    }
    isOpen.value = false;
  } catch (err: unknown) {
    // Keep the modal open so the user can retry, or copy the locator instead.
    toast.add({
      title: 'Could not save the pick',
      description: errorMessage(err),
      color: 'error',
      icon: 'i-lucide-alert-triangle',
    });
  } finally {
    saving.value = false;
  }
}

function close() {
  isOpen.value = false;
}

function resetPicker() {
  pickedAttrs.value = null;
  alternatives.value = [];
  selectedAlt.value = null;
  step.value = 'pick-element';
  iframeReady.value = false;
  pickerError.value = null;
  searchQuery.value = '';
  searchCount.value = 0;
  searchIndex.value = -1;
  // Reload the iframe to restore the picker, re-running the appended picker
  // script over the same document.
  reloadFrame();
}

// ── Copy ────────────────────────────────────────────────────────────────────

const { copy } = useCopy();
const copiedKey = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function copyLocator(text: string, key: string) {
  copy(text, { toast: 'Locator copied' });
  copiedKey.value = key;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedKey.value = null;
  }, 2000);
}
onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});
</script>

<template>
  <UModal v-model:open="isOpen" :ui="{ content: 'max-w-6xl w-[95vw]' }" @after-leave="close">
    <template #header>
      <div>
        <h3 class="text-lg font-medium">
          {{ failingLocator ? 'Pick a locator from the DOM snapshot' : 'Find a locator on the failure-time page' }}
        </h3>
        <p class="text-sm text-muted mt-0.5">
          <template v-if="failingLocatorText">
            Click the element <LocatorCode :locator="failingLocatorText" plain /> should target.
          </template>
          <template v-else>Click any element to get the locators that target it.</template>
          Use &uarr;&darr; to walk the DOM tree.
        </p>
      </div>
    </template>

    <template #body>
      <!-- Loading state -->
      <div v-if="snapshotPending" class="flex items-center justify-center py-20">
        <UIcon name="i-lucide-loader" class="size-6 animate-spin text-gray-400" />
        <span class="ml-2 text-sm text-gray-500">Loading DOM snapshot...</span>
      </div>

      <!-- Error state -->
      <div v-else-if="snapshotError" class="py-8 text-center">
        <UIcon name="i-lucide-alert-triangle" class="size-8 text-red-300 mx-auto mb-2" />
        <p class="text-sm text-red-500">Failed to load snapshot</p>
        <p class="text-xs text-gray-400 mt-1">{{ snapshotError }}</p>
        <UButton size="xs" variant="outline" color="neutral" class="mt-3" @click="fetchSnapshot">Retry</UButton>
      </div>

      <!-- No snapshot available -->
      <div v-else-if="snapshot?.status !== 'ok' || !snapshot.html" class="py-8 text-center">
        <UIcon name="i-lucide-file-x" class="size-8 text-gray-300 mx-auto mb-2" />
        <p class="text-sm text-gray-500">No DOM snapshot or ARIA data available for this execution</p>
        <p class="text-xs text-gray-400 mt-1">This test run has no stored trace or ARIA snapshot to pick from.</p>
      </div>

      <template v-else>
        <!-- Source note + view toggle (DOM ⇄ accessibility tree) -->
        <div class="mb-2 flex items-center gap-2 flex-wrap">
          <div
            v-if="snapshot.source"
            class="text-xs flex items-center gap-1"
            :class="
              snapshot.source === 'aria' ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'
            "
          >
            <UIcon
              :name="snapshot.source === 'aria' ? 'i-lucide-accessibility' : 'i-lucide-check'"
              class="size-3.5 shrink-0"
            />
            <template v-if="snapshot.source === 'aria'">
              Accessibility tree from the failure-time ARIA snapshot — element styles are approximate
            </template>
            <template v-else> Rendered from the failure-time DOM snapshot </template>
          </div>

          <!-- Only offered when the case has both representations -->
          <div
            v-if="availableSources.length > 1"
            class="ml-auto inline-flex rounded-md border border-default overflow-hidden text-xs"
          >
            <button
              type="button"
              class="px-2 py-1 flex items-center gap-1 transition-colors"
              :class="
                viewSource === 'dom' ? 'bg-primary/10 text-primary font-medium' : 'text-gray-500 hover:bg-elevated'
              "
              title="Rendered page from the trace"
              @click="selectSource('dom')"
            >
              <UIcon name="i-lucide-layout-panel-top" class="size-3.5" />
              DOM
            </button>
            <button
              type="button"
              class="px-2 py-1 flex items-center gap-1 border-l border-default transition-colors"
              :class="
                viewSource === 'aria' ? 'bg-primary/10 text-primary font-medium' : 'text-gray-500 hover:bg-elevated'
              "
              title="Accessibility tree from the ARIA snapshot"
              @click="selectSource('aria')"
            >
              <UIcon name="i-lucide-accessibility" class="size-3.5" />
              Tree
            </button>
          </div>
        </div>

        <!-- Zoom toolbar — only when the recorded viewport is known -->
        <div v-if="viewport" class="flex items-center gap-1 mb-1.5 text-xs text-gray-500">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-zoom-out"
            title="Zoom out"
            @click="zoomBy(1 / 1.25)"
          />
          <span class="tabular-nums w-11 text-center select-none">{{ zoomPct }}%</span>
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-zoom-in"
            title="Zoom in"
            @click="zoomBy(1.25)"
          />
          <UButton size="xs" variant="outline" color="neutral" class="ml-1" @click="fitToPane">Fit</UButton>
          <span class="ml-auto text-gray-400 tabular-nums">{{ viewport.width }}&times;{{ viewport.height }}</span>
        </div>

        <!-- Find-by-text: jump to the element the failing locator meant to hit -->
        <div v-if="step === 'pick-element'" class="flex items-center gap-2 mb-1.5">
          <UInput
            v-model="searchQuery"
            size="xs"
            icon="i-lucide-search"
            placeholder="Find an element by its text…"
            class="max-w-xs"
            @keydown.enter.prevent="searchNext"
          />
          <span v-if="searchQuery && searchCount > 0" class="text-xs text-gray-500 tabular-nums">
            {{ searchIndex + 1 }}/{{ searchCount }}
          </span>
          <span v-else-if="searchQuery" class="text-xs text-gray-400">no matches</span>
          <UButton
            v-if="searchCount > 1"
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-chevron-down"
            title="Next match (Enter)"
            @click="searchNext"
          />
        </div>

        <!-- Iframe with the snapshot. When the viewport is known the iframe is
           sized to it and scaled with a CSS transform (proportions preserved);
           otherwise it fills the pane width and grows to its content height so
           the stage scrolls (the ARIA tree has no viewport). -->
        <div
          ref="stageRef"
          class="relative border border-default rounded-lg overflow-auto"
          :class="[step === 'pick-element' ? 'h-[75vh]' : 'h-80', viewport ? 'bg-gray-100 dark:bg-gray-800' : '']"
        >
          <!-- Error overlay: the picker script threw or never started -->
          <div
            v-if="pickerError"
            class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white dark:bg-gray-900 z-10 p-6 text-center"
          >
            <UIcon name="i-lucide-alert-triangle" class="size-6 text-amber-500" />
            <p class="text-sm text-gray-600 dark:text-gray-300 max-w-md">{{ pickerError }}</p>
            <UButton size="xs" variant="outline" color="neutral" @click="resetPicker">Retry</UButton>
          </div>
          <!-- Loading overlay until the picker script initializes -->
          <div
            v-else-if="!iframeReady"
            class="absolute inset-0 flex items-center justify-center bg-white dark:bg-gray-900 z-10"
          >
            <UIcon name="i-lucide-loader" class="size-5 animate-spin text-gray-400" />
            <span class="ml-2 text-sm text-gray-500">Initializing picker...</span>
          </div>
          <div :style="canvasStyle">
            <!-- Hardened: allow-scripts WITHOUT allow-same-origin → opaque origin,
                 postMessage-only bridge. Served app loads the picker document from
                 the `dom-snapshot-frame` endpoint (`src`, its own sandbox CSP); the
                 demo builds it inline (`srcdoc`). `renderKey` remounts the frame to
                 re-run the picker on re-pick. -->
            <iframe
              ref="iframeRef"
              :key="renderKey"
              :src="frameSrc"
              :srcdoc="srcDoc"
              :style="iframeStyle"
              class="bg-white"
              sandbox="allow-scripts"
              title="DOM snapshot"
            />
          </div>
        </div>

        <!-- Review step: picked element + alternatives -->
        <div v-if="step === 'review' && pickedAttrs" class="mt-4 space-y-3">
          <!-- Picked element summary -->
          <div class="flex items-center gap-3 bg-elevated rounded-lg p-3">
            <UIcon name="i-lucide-crosshair" class="size-5 text-primary shrink-0" />
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium">
                Picked: <code class="text-xs">{{ pickedAttrs.tagName }}</code>
                <template v-if="pickedAttrs.attributes['id']">
                  <code class="text-xs text-gray-400 ml-1">#{{ pickedAttrs.attributes['id'] }}</code>
                </template>
                <template v-if="pickedAttrs.attributes['data-testid']">
                  <UBadge size="xs" color="primary" variant="subtle" class="ml-1">
                    {{ pickedAttrs.attributes['data-testid'] }}
                  </UBadge>
                </template>
              </p>
              <p v-if="pickedAttrs.textContent" class="text-xs text-gray-500 mt-0.5 truncate">
                "{{ pickedAttrs.textContent }}"
              </p>
            </div>
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-rotate-ccw"
              title="Pick a different element"
              @click="resetPicker"
            />
          </div>

          <!-- Alternatives list -->
          <div class="space-y-1" role="radiogroup" aria-label="Locator alternatives">
            <LocatorAlternativeRow
              v-for="(alt, i) in alternatives"
              :key="i"
              :alt="alt"
              :copied="copiedKey === `picked-${i}`"
              :dense="true"
              :selectable="true"
              :selected="selectedAlt?.locator === alt.locator"
              @copy="copyLocator(alt.locator, `picked-${i}`)"
              @select="selectAlternative(alt)"
            />
          </div>

          <!-- Recommendation — click selects it for Confirm; Copy stays separate -->
          <div
            v-if="recommendation.recommended"
            class="rounded-lg border border-primary/40 bg-primary/5 p-3 flex items-center gap-3 cursor-pointer"
            role="button"
            tabindex="0"
            title="Select this locator for Confirm"
            @click="selectAlternative(recommendation.recommended)"
            @keydown.enter.prevent="selectAlternative(recommendation.recommended)"
          >
            <UIcon name="i-lucide-star" class="size-5 text-primary shrink-0" />
            <div class="flex-1 min-w-0">
              <p class="text-xs font-medium text-primary">
                Recommended (score: {{ recommendation.recommended.score }})
              </p>
              <LocatorCode :locator="recommendation.recommended.locator" truncate class="text-sm mt-0.5" />
            </div>
            <UButton
              size="sm"
              color="primary"
              variant="solid"
              :trailing-icon="copiedKey === 'rec' ? 'i-lucide-check' : 'i-lucide-copy'"
              @click.stop="copyLocator(recommendation.recommended.locator, 'rec')"
            >
              Copy
            </UButton>
          </div>
        </div>
      </template>
    </template>

    <template #footer>
      <div class="flex justify-between w-full">
        <UButton
          v-if="step === 'review'"
          size="sm"
          variant="outline"
          color="neutral"
          icon="i-lucide-rotate-ccw"
          @click="resetPicker"
        >
          Pick a different element
        </UButton>
        <div v-else />
        <div class="flex gap-2">
          <UButton size="sm" variant="outline" color="neutral" @click="close">Cancel</UButton>
          <UButton
            v-if="step === 'review' && failingLocator"
            size="sm"
            color="primary"
            :loading="saving"
            :disabled="!selectedAlt"
            @click="confirm"
          >
            Confirm pick
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
