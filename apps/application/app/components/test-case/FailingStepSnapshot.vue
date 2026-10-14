<script setup lang="ts">
/**
 * The page at the failing step, one view at a time behind a tab strip: its
 * Screenshot, its DOM and its Accessibility tree, all of the same moment. It
 * sits in the failing step's block on the timeline and leads the Screen tab
 * (`full`), where the tab lists its own views after these (`extraViews`, each
 * rendered from the slot named by its value and kept mounted so it can report
 * whether it has anything to show).
 *
 * - Screenshot: with Playwright 1.63 per-action snapshots, the page before the
 *   failing action beside the page at the failure; otherwise the attached
 *   screenshot of the page the test failed on, when one is known to be (see
 *   `failurePageScreenshot`). The Screen tab adds every other screenshot the
 *   execution attached, and says so when none of several is known to be it.
 *   Each opens full-screen in the shared lightbox, whose details name the
 *   test, the failing step and, beside the page at the failure, the error
 *   raised on it.
 * - DOM: the trace's DOM snapshot of the moment the screenshot at the failure
 *   shows (the failing action's after-phase, its before-phase when that is the
 *   only screenshot), else the failure-time snapshot, rendered as the page.
 * - Accessibility tree: the trace's tree at the failing action, else the
 *   execution's failure-time ARIA snapshot.
 *
 * "Open in picker" sits beside the strip whichever view is showing: it opens
 * the locator picker on the DOM the DOM view renders, on the failing locator
 * the healing data names, or as an inspector when the failure named none. The
 * DOM and Accessibility tree views each carry a Copy action.
 *
 * On the timeline a view with nothing to show is left out, the strip only
 * appears for two views or more, and the block renders nothing when no view
 * has content. On the Screen tab the three page views are listed even when
 * empty (dimmed, saying why), except an ARIA tree the project declined.
 */
import type { AttachmentInfo } from '~~/types/api';
import type { EvidenceState } from '#shared/evidence-state';
import type { LocatorHealingResult } from '#shared/locator-healing.types';
import type { LightboxImage, LightboxSubject } from '~/utils/lightbox';
import { isImageFile } from '~/utils/text-format';
import { FAILURE_SCREENSHOT_ATTACHMENT } from '@piwitests/core/wire';
import { failurePageFirst, failurePageScreenshot } from '#shared/file-classify';
import { useTraceSnapshots } from '~/composables/useTraceSnapshots';
import { useDomSnapshot, type DomSnapshotMoment } from '~/composables/useDomSnapshot';
import DomSnapshotFrame from './DomSnapshotFrame.vue';

const props = defineProps<{
  testRunsCaseId: number;
  /** The execution's attachments — the screenshot of the failing page when the trace has no 1.63 `screen` snapshot. */
  attachments?: AttachmentInfo[] | null;
  /** The execution's failure-time ARIA tree, shown when the trace carries no per-action aria. */
  ariaSnapshot?: string | null;
  /** Why the ARIA tree is absent, for the Screen tab's empty view. */
  ariaState?: EvidenceState | null;
  /** The ARIA tree was recovered from the trace rather than the capture fixtures. */
  ariaDerived?: boolean;
  /** The Screen tab's version: every view listed, every attached screenshot, larger frames. */
  full?: boolean;
  /** Views listed after the page's own; each renders the slot named by its `value`. */
  extraViews?: Array<{ value: string; label: string; shown: boolean }>;
  /** The failing step's label; the trace's action title stands in without it. */
  step?: string | null;
  /** The error raised at the failure, shown beside the enlarged page at the failure. */
  error?: string | null;
  /** The test, named in the enlarged screenshot's details. */
  subject?: LightboxSubject | null;
}>();

/** The view on show; null lets the component open on the first view with content. */
const view = defineModel<string | null>('view', { default: null });

const config = useRuntimeConfig();
const {
  failingStep,
  failingAriaText,
  snapshotUrl,
  pending: traceSnapshotsPending,
} = useTraceSnapshots(() => props.testRunsCaseId);

// ── Screenshot ──────────────────────────────────────────────────────────────
type Shot = LightboxImage & { failed: boolean };

const stepLabel = computed(() => props.step || failingStep.value?.title || null);
const errorText = computed(() => props.error || null);

const traceShots = computed<Shot[]>(() => {
  const step = failingStep.value;
  if (!step) return [];
  const list: Shot[] = [];
  if (step.screen.before) {
    list.push({
      src: snapshotUrl(step.callId, 'screen', 'before'),
      name: 'Before the failing action',
      failed: false,
      step: stepLabel.value,
    });
  }
  if (step.screen.after) {
    list.push({
      src: snapshotUrl(step.callId, 'screen', 'after'),
      name: 'At the failure',
      failed: true,
      step: stepLabel.value,
      error: errorText.value,
    });
  }
  return list;
});

const attachedImages = computed(() =>
  (props.attachments ?? []).filter((att) => isImageFile(att.path, att.contentType)),
);
// The attached screenshot of the page the test failed on, when one is known to be.
const failureImage = computed(() => failurePageScreenshot(attachedImages.value, (att) => att.name));
// Playwright names each of its screenshots `screenshot`: the file name tells them apart.
function shotName(att: AttachmentInfo): string {
  if (att.name === FAILURE_SCREENSHOT_ATTACHMENT) return 'Page the test failed on';
  if (att.name && att.name !== 'screenshot') return att.name;
  return att.path.split('/').pop() || att.path;
}
const attachedShots = computed<Shot[]>(() =>
  failurePageFirst(attachedImages.value, (att) => att.name).map((att) => ({
    src: fileApiUrl(att.path, att.contentType, config.app?.baseURL),
    name: shotName(att),
    failed: false,
  })),
);
// Several screenshots, none known to show the page the test failed on.
const unplacedShots = computed(
  () => !traceShots.value.length && !failureImage.value && attachedImages.value.length > 1,
);

// The failing step's screenshots: the trace's pair, else the attached screenshot
// of the page the test failed on (the page at the moment it failed, which is this
// step). The Screen tab lists every other attached screenshot after them. The
// same list feeds the frames and the lightbox, so a frame's index addresses it in
// the enlarged view.
const shots = computed<Shot[]>(() => {
  if (traceShots.value.length) return props.full ? [...traceShots.value, ...attachedShots.value] : traceShots.value;
  if (!failureImage.value) return props.full ? attachedShots.value : [];
  const [first, ...rest] = attachedShots.value;
  const atFailure = { ...first!, name: 'At the failure', failed: true, step: stepLabel.value, error: errorText.value };
  return props.full ? [atFailure, ...rest] : [atFailure];
});
const lightboxIndex = ref<number | null>(null);

// ── DOM ─────────────────────────────────────────────────────────────────────
// The DOM of the same moment as the screenshot at the failure, asked for once
// the trace's screenshots are known; the failure-time DOM without them.
const domAt = computed<DomSnapshotMoment | null>(() => {
  const step = failingStep.value;
  if (!step || !traceShots.value.length) return null;
  return { callId: step.callId, phase: step.screen.after ? 'after' : 'before' };
});
const dom = useDomSnapshot(
  () => props.testRunsCaseId,
  () => domAt.value,
  () => !traceSnapshotsPending.value,
);
const hasDom = computed(() => dom.hasDom.value);
const domCaption = computed(() => (domAt.value?.phase === 'before' ? 'Before the failing action' : 'At the failure'));
// The rendered page loads the first time the DOM view opens, then stays.
const domOpened = ref(false);

// ── Accessibility tree ──────────────────────────────────────────────────────
const ariaText = computed(() => failingAriaText.value ?? props.ariaSnapshot ?? null);
const hasAria = computed(() => Boolean(ariaText.value));
// The execution's own ARIA snapshot is on show (not the trace's per-action tree).
const ariaFromExecution = computed(() => !failingAriaText.value && Boolean(props.ariaSnapshot));

// ── Views ───────────────────────────────────────────────────────────────────
interface ViewTab {
  value: string;
  label: string;
  hasContent: boolean;
}

const pageTabs = computed<ViewTab[]>(() => [
  { value: 'screenshot', label: 'Screenshot', hasContent: shots.value.length > 0 },
  { value: 'dom', label: 'DOM', hasContent: hasDom.value },
  { value: 'aria', label: 'Accessibility tree', hasContent: hasAria.value },
]);
// On the Screen tab an empty view stays listed to say why, except an ARIA tree
// the project declined, which is not offered at all.
function listed(tab: ViewTab): boolean {
  if (tab.hasContent) return true;
  return props.full && !(tab.value === 'aria' && props.ariaState?.state === 'declined');
}
const tabs = computed<ViewTab[]>(() => [
  ...pageTabs.value.filter(listed),
  ...(props.extraViews ?? [])
    .filter((extra) => extra.shown)
    .map((extra) => ({ value: extra.value, label: extra.label, hasContent: true })),
]);
const hasPageContent = computed(() => pageTabs.value.some((tab) => tab.hasContent));
const render = computed(() => props.full || hasPageContent.value);
const stripShown = computed(() => props.full || tabs.value.length > 1);

// A chosen view that is not listed (a cited diff still loading) falls back to
// the first view with content; the choice is kept, so it shows once listed.
const activeView = computed(() => {
  if (view.value && tabs.value.some((tab) => tab.value === view.value)) return view.value;
  return tabs.value.find((tab) => tab.hasContent)?.value ?? tabs.value[0]?.value ?? null;
});
watch(
  activeView,
  (value) => {
    if (value === 'dom') domOpened.value = true;
  },
  { immediate: true },
);

// ── Actions ─────────────────────────────────────────────────────────────────
const { copy, copied } = useCopy();
const copyAction = computed(() => {
  if (activeView.value === 'dom' && hasDom.value) return { label: 'Copy HTML', text: dom.html.value };
  if (activeView.value === 'aria' && hasAria.value) return { label: 'Copy tree', text: ariaText.value };
  return null;
});

// The locator picker over the DOM the DOM view renders (or the page rendered
// from the ARIA tree when there is no trace DOM). It opens on the failing
// locator the healing data names — the same request the Locator fix section
// makes, shared by key — or as an inspector when the failure named none.
const canPick = computed(() => dom.hasSnapshot.value);
const pickerOpen = ref(false);
const { data: healing, execute: loadHealing } = useFetch<LocatorHealingResult>(
  () => `/api/test-run-cases/${props.testRunsCaseId}/locator-healing`,
  { key: `locator-healing-${props.testRunsCaseId}`, immediate: false, lazy: true },
);
async function openPicker() {
  if (!healing.value) await loadHealing().catch(() => {});
  pickerOpen.value = true;
}

const frameHeight = computed(() => (props.full ? 'max-h-[32rem]' : 'max-h-80'));
</script>

<template>
  <div v-if="render" class="space-y-2.5" :class="full ? '' : 'rounded-lg border border-default bg-elevated/40 p-3'">
    <!-- On the timeline the label and the actions share the first row and the
         strip takes the second; on the Screen tab the strip leads the row. -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p v-if="!full" class="text-xs font-medium text-muted">Page at the failing step</p>
      <div v-if="stripShown" :class="full ? '' : 'order-last basis-full'">
        <div
          role="tablist"
          :aria-label="full ? 'Screen view' : 'Page at the failing step'"
          class="inline-flex flex-wrap gap-1 rounded-md bg-elevated/60 p-0.5"
        >
          <button
            v-for="tab in tabs"
            :key="tab.value"
            type="button"
            role="tab"
            :aria-selected="activeView === tab.value ? 'true' : 'false'"
            class="rounded whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-primary transition-colors"
            :class="[
              full ? 'px-2.5 py-1 text-sm' : 'px-2 py-0.5 text-xs',
              activeView === tab.value ? SEGMENTED_SELECTED_CLASS : 'text-muted hover:text-default',
              !tab.hasContent && activeView !== tab.value ? 'opacity-50' : '',
            ]"
            @click="view = tab.value"
          >
            {{ tab.label }}
          </button>
        </div>
      </div>
      <div v-if="copyAction || canPick" class="ml-auto flex items-center gap-1">
        <UButton
          v-if="copyAction"
          size="xs"
          color="neutral"
          variant="ghost"
          :icon="copied ? 'i-lucide-check' : undefined"
          :label="copyAction.label"
          @click="copy(copyAction.text)"
        />
        <UButton
          v-if="canPick"
          size="xs"
          color="neutral"
          variant="outline"
          label="Open in picker"
          title="Click an element of this page to get the locators that target it"
          @click="openPicker"
        />
      </div>
    </div>

    <!-- ── Screenshot ──────────────────────────────────────────── -->
    <template v-if="activeView === 'screenshot'">
      <p v-if="unplacedShots" class="text-xs text-muted">
        Playwright took one screenshot per page the test had open, and none says which page it failed on. The
        <DocLink to="guide/capture-fixtures#what-gets-captured" no-icon>capture fixtures</DocLink> add a screenshot of
        that page.
      </p>
      <div v-if="shots.length" :class="shots.length > 1 ? 'grid gap-3 sm:grid-cols-2' : ''">
        <figure v-for="(shot, idx) in shots" :key="shot.src" class="min-w-0 space-y-1">
          <figcaption class="flex items-center gap-1 text-xs text-muted">
            <span
              v-if="shot.failed"
              class="inline-block size-1.5 shrink-0 rounded-full"
              :class="STATUS_PALETTE.failed.bg"
              aria-hidden="true"
            />
            <span class="truncate" :title="shot.name">{{ shot.name }}</span>
          </figcaption>
          <ZoomableImage
            inline
            :src="shot.src"
            :alt="shot.name"
            :failed="shot.failed"
            frame-class="rounded-lg bg-default"
            :img-class="`${full ? 'max-h-[28rem]' : 'max-h-72'} w-auto max-w-full object-contain`"
            @open="lightboxIndex = idx"
          />
        </figure>
      </div>
      <p v-else class="text-xs text-muted">
        No screenshot for this execution. Playwright takes one when a test fails with
        <code class="font-mono">screenshot: 'only-on-failure'</code>.
      </p>
    </template>

    <!-- ── DOM ─────────────────────────────────────────────────── -->
    <!-- Rendered as the page, never as escaped markup; kept once opened. -->
    <figure v-if="domOpened && hasDom" v-show="activeView === 'dom'" class="min-w-0 space-y-1">
      <figcaption class="flex items-center gap-1 text-xs text-muted">
        <span
          v-if="domAt?.phase !== 'before'"
          class="inline-block size-1.5 shrink-0 rounded-full"
          :class="STATUS_PALETTE.failed.bg"
          aria-hidden="true"
        />
        {{ domCaption }}
      </figcaption>
      <DomSnapshotFrame
        :frame-src="dom.frameSrc.value"
        :src-doc="dom.srcDoc.value"
        :viewport="dom.viewport.value"
        :title="`DOM ${domCaption.toLowerCase()}`"
        :stage-class="frameHeight"
      />
    </figure>
    <template v-if="activeView === 'dom' && !hasDom">
      <p v-if="dom.pending.value || traceSnapshotsPending" class="flex items-center gap-2 text-xs text-muted">
        <UIcon name="i-lucide-loader" class="size-4 animate-spin" /> Rendering the page…
      </p>
      <p v-else class="text-xs text-muted">
        No DOM snapshot for this execution. It comes from the Playwright trace — keep traces for failures with
        <code class="font-mono">trace: 'retain-on-failure'</code>.
      </p>
    </template>

    <!-- ── Accessibility tree ──────────────────────────────────── -->
    <template v-if="activeView === 'aria'">
      <div v-if="hasAria" class="space-y-1.5">
        <div v-if="ariaDerived && ariaFromExecution" class="flex justify-end">
          <TraceDerivedChip />
        </div>
        <div class="overflow-y-auto" :class="frameHeight">
          <MarkdownPreview :text="'```yaml\n' + ariaText + '\n```'" />
        </div>
      </div>
      <EvidenceEmptyState v-else-if="ariaState" :state="ariaState" doc="/capture-fixtures" compact />
      <p v-else class="text-xs text-muted">No accessibility tree for this execution.</p>
    </template>

    <!-- ── The host's views, kept mounted so each can report its content ── -->
    <div v-for="extra in extraViews ?? []" v-show="activeView === extra.value" :key="extra.value">
      <slot :name="extra.value" />
    </div>

    <ScreenshotLightbox v-model="lightboxIndex" :images="shots" :subject="subject" />
    <SnapshotLocatorPicker
      v-if="pickerOpen && canPick"
      v-model:open="pickerOpen"
      :test-runs-case-id="testRunsCaseId"
      :failing-locator="healing?.failingLocator ?? null"
      :healing="healing"
      :at="hasDom ? domAt : null"
    />
  </div>
</template>
