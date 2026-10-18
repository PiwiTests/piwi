<script setup lang="ts">
/**
 * Ranked alternative locators for a failing locator: the top recommendation,
 * the ranked list and the source note. It renders the healing answer the host
 * page fetched under the key `locator-healing-<testRunsCaseId>`, and refreshes
 * that key after a pick. Used on both the cluster detail page and the test-case
 * detail page.
 */

import { defineComponent, h } from 'vue';
import { recommendLocatorFix, locatorExpression, hasHealingAlternatives } from '#shared/locator-healing';
import type { RankedLocator, LocatorFixRecommendation, LocatorHealingResult } from '#shared/locator-healing.types';
import { healingSourcePhrase } from '#shared/healing-source';
import type { AiStepIntent, TraceInfo } from '~~/types/api';
import SectionCard from './SectionCard.vue';
import CollapsibleSectionCard from './CollapsibleSectionCard.vue';
import SnapshotLocatorPicker from './SnapshotLocatorPicker.vue';

interface HealActionChip {
  id: number;
  status: 'pending' | 'processing' | 'opened' | 'failed' | 'skipped';
  prNumber: number | null;
  prUrl: string | null;
  branch: string;
}

const props = defineProps<{
  testRunsCaseId: number;
  /** The execution's locator healing, as the host page fetched it (null until it lands). */
  healing: (LocatorHealingResult & { healAction?: HealActionChip | null }) | null;
  /** When set, the panel folds to a header with a peek (persisted per user). */
  storageKey?: string;
  /**
   * Render the panel body without a card wrapper — for embedding inside another
   * card's section (More ways to fix). The provenance note leads, then the
   * recommendation and the alternatives; the card title, icon and count are
   * dropped since the host section already labels it.
   */
  chrome?: boolean;
  /**
   * Number of tests this failure affects (cluster context). When > 1, the panel
   * notes that one fix covers them all — a cluster is one masked-locator root
   * cause, so the recommended locator applies across the group.
   */
  affectedCount?: number;
  /**
   * AI-step intent mappings from the execution's usage manifest. When the
   * failing locator was compiled from a natural-language prompt, the panel
   * shows that prompt next to it — the *intent* behind the broken selector.
   */
  aiIntents?: AiStepIntent[] | null;
  /** True when a structural page diff is available for this execution — enables the "looks renamed" link to it. */
  hasPageDiff?: boolean;
}>();

// Asks the host to reveal the page diff — the structural proof of a rename.
const emit = defineEmits<{ 'show-page-diff': [] }>();

// A card-less wrapper for the embedded (More ways to fix) variant: renders the
// provenance note first, then the actions, then the body — and swallows the
// card-only props so they never leak onto the DOM. `data-shot` still falls
// through to the root so the docs scene keeps its target.
const BareCard = defineComponent({
  name: 'LocatorHealingBare',
  props: {
    subtitle: { type: String, default: '' },
    icon: { type: String, default: '' },
    title: { type: String, default: '' },
    count: { type: Number, default: null },
    help: { type: String, default: '' },
  },
  setup(bareProps, { slots }) {
    return () =>
      h('div', { class: 'space-y-3' }, [
        // Below `sm` the actions drop to their own full-width row under the
        // provenance line, so the sentence spans the card width instead of being
        // squeezed into a one-word-per-line column beside the buttons.
        slots.subtitle || bareProps.subtitle
          ? h('div', { class: 'flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between' }, [
              h('p', { class: 'text-xs min-w-0' }, slots.subtitle ? slots.subtitle() : bareProps.subtitle),
              slots.actions ? h('div', { class: 'sm:shrink-0' }, slots.actions()) : null,
            ])
          : slots.actions
            ? h('div', { class: 'flex justify-end' }, slots.actions())
            : null,
        slots.default ? slots.default() : null,
      ]);
  },
});

// Card-less inside More ways to fix (`chrome` false); a folding card when the
// host passes `storageKey`; else a plain card (the standalone test-case page).
const cardComponent = computed(() =>
  props.chrome === false ? BareCard : props.storageKey ? CollapsibleSectionCard : SectionCard,
);
const cardBind = computed(() => (props.chrome !== false && props.storageKey ? { storageKey: props.storageKey } : {}));

const hasData = computed(() => hasHealingAlternatives(props.healing));

const alternatives = computed<RankedLocator[]>(() => {
  if (!props.healing) return [];
  return (
    props.healing.fromDiffRename ??
    props.healing.fromElementMatch ??
    props.healing.fromPriorSuccess ??
    props.healing.fromAriaSnapshot ??
    []
  );
});

// A locator a human confirmed with the failure-time picker — surfaced as a
// prominent callout at the top so it never hides in the ranked list.
const userPick = computed<RankedLocator | null>(() => alternatives.value.find((a) => a.pickedByUser) ?? null);

// The single recommended fix — convention-preserving where possible. Computed
// server-side, and null when the server withheld it (every stored alternative
// looks stale, or every candidate finds the element the failing locator
// already names): recomputing it here would resurrect a pick that is no fix.
// The shared picker runs only for a payload that lacks the field.
const recommendation = computed<LocatorFixRecommendation | null>(() => {
  if (!props.healing) return null;
  if (props.healing.recommendation !== undefined) return props.healing.recommendation;
  if (!alternatives.value.length) return null;
  return recommendLocatorFix(props.healing?.failingLocator?.method, alternatives.value);
});

// Failing-page candidates shown alongside a stale stored list — the server
// populates fromAriaSnapshot next to fromPriorSuccess only in that case.
const supplement = computed<RankedLocator[]>(() =>
  props.healing?.priorNameMayBeStale && props.healing.fromPriorSuccess?.length
    ? (props.healing.fromAriaSnapshot ?? [])
    : [],
);

const recommendationNote = computed(() => {
  const r = recommendation.value;
  if (!r?.recommended) return '';
  if (r.recommended.pickedByUser) return 'Confirmed with the locator picker on the failing page';
  if (r.preservesConvention) return 'Keeps your original locator style — minimal, idiomatic edit';
  if (r.suggestAddTestId) return 'Most stable available, but still fragile';
  return 'Most stable available — a sturdier style than the original';
});

const sourceNote = computed(() => {
  const stale = props.healing?.priorNameMayBeStale;
  const note = (() => {
    switch (props.healing?.source) {
      case 'diff-rename': {
        const d = props.healing.diffRename;
        const where = d ? `${d.file.split('/').pop()}:${d.line}` : 'this change';
        return d
          ? `“${d.before}” became “${d.after}” in ${where} — the same locator with the new text`
          : 'This change renamed the text the locator finds its element by';
      }
      case 'prior-run':
        return stale
          ? 'Pre-captured from the last passing run — the element looks changed since'
          : 'Pre-captured from the last passing run — highest confidence';
      case 'element-match':
        return 'The element looks renamed or moved — these are fresh locators for its current identity on the failing page';
      case 'fingerprint':
        return 'Matched by locator signature (line numbers shifted)';
      case 'cross-test':
        return 'Captured by another test in this project that uses the same locator';
      case 'aria-snapshot':
        return 'Generated from the failure-time ARIA snapshot — limited, no HTML attributes';
      default:
        return '';
    }
  })();
  // Stored snapshots age — surface when the data was last captured.
  const captured = props.healing?.capturedAt;
  return captured ? `${note} · captured ${formatRelativeTime(captured)}` : note;
});

// Subtitle color: green for pre-captured (high confidence), primary for a
// fresh current-page match, amber for the limited ARIA-only fallback — and for
// a stored list whose element looks changed since capture.
const sourceClass = computed(() => {
  if (props.healing?.priorNameMayBeStale) return 'text-warning-600 dark:text-warning-400';
  switch (props.healing?.source) {
    case 'diff-rename':
    case 'prior-run':
    case 'fingerprint':
    case 'cross-test':
      return 'text-success-600 dark:text-success-400';
    case 'element-match':
      return 'text-primary-600 dark:text-primary-400';
    default:
      return 'text-warning-600 dark:text-warning-400';
  }
});

/** The failing locator as Playwright source, the same form every alternative renders in. */
const failingLocatorText = computed(() => {
  const f = props.healing?.failingLocator;
  return f ? locatorExpression(f.method, f.args) : '';
});

/**
 * Quote/whitespace/bracket-insensitive form so the failing locator can be
 * compared against an AI-step intent locator regardless of quoting or spacing
 * — both collapse to `getbyrole(textbox,name:email)`.
 */
function normalizeLocator(text: string): string {
  return text.toLowerCase().replace(/[\s'"`{}[\]]/g, '');
}

/** The AI-step prompt the failing locator was compiled from, when there is one. */
const failingIntent = computed<AiStepIntent | null>(() => {
  if (!props.aiIntents?.length || !failingLocatorText.value) return null;
  const failing = normalizeLocator(failingLocatorText.value);
  return props.aiIntents.find((i) => normalizeLocator(i.locator) === failing) ?? null;
});

// The execution's failure trace, when one was uploaded — its recorded page
// snapshots power the trace viewer's own "Pick locator" tool, so a locator
// can be picked visually even for CI failures nobody watched live.
const config = useRuntimeConfig();
const { data: traces } = useFetch(() => `/api/test-run-cases/${props.testRunsCaseId}/traces`, {
  lazy: true,
  transform: (r: { items: TraceInfo[] }) => r.items,
});
const pickTraceUrl = computed(() => {
  const trace = traces.value?.[0];
  if (!trace) return null;
  // Demo mode serves its committed sample trace as a static asset (the
  // viewer's service worker bypasses the demo API SW).
  const isDemoStaticAsset = !!config.public.demoMode && trace.filePath.startsWith('demo/');
  return getTraceViewerUrl(trace.filePath, config.app?.baseURL, isDemoStaticAsset);
});

// `target="_blank"` is inert in the desktop shell, so the viewer opens in a new
// app window there instead; on web the anchor opens a new tab as usual.
const { isDesktop, openWindow } = useDesktopWindow();
function onPickFromTrace(event: MouseEvent) {
  if (!isDesktop || !pickTraceUrl.value) return;
  event.preventDefault();
  openWindow(pickTraceUrl.value);
}

// Interactive DOM snapshot picker
const pickerOpen = ref(false);

// The host page fetched the healing under this key; a confirmed pick refreshes it.
async function refreshHealing() {
  await refreshNuxtData(`locator-healing-${props.testRunsCaseId}`);
}

const { copy } = useCopy();
// Track which row was last copied so only that button shows the check icon —
// useCopy's `copied` is a single shared ref and would flip every button at once.
const copiedKey = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function copyText(text: string, key: string, toast: string) {
  copy(text, { toast });
  copiedKey.value = key;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copiedKey.value = null;
  }, 2000);
}
function copyLocator(text: string, key: string) {
  copyText(text, key, 'Locator copied');
}
onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});

// ── Suggested edit: rewrite the failing test line with the recommended fix ───

const recommended = computed(() => recommendation.value?.recommended ?? null);

// One recommendation heals every test in the cluster (same masked-locator root
// cause) — surface the leverage when the panel is shown in cluster context.
const appliesToNote = computed(() =>
  props.affectedCount && props.affectedCount > 1 && recommended.value
    ? `Same break affects ${props.affectedCount} tests in this cluster — one fix`
    : '',
);

// Plain-words provenance for the recommendation, echoed in the hero block so it
// reads even when the source subtitle is folded away (cluster page). The Next
// line names the same provenance in the same words.
const recommendationSourceLabel = computed(
  () => healingSourcePhrase(props.healing?.source, recommended.value?.pickedByUser) ?? '',
);

// The one-line diff (old source line → line with the failing call rewritten),
// when the captured source line and a confident replacement are both available.
const suggestedEdit = computed(() => {
  const line = props.healing?.sourceLine;
  const rec = recommended.value;
  if (!line || !rec) return null;
  const edit = buildLocatorEdit(line.text, props.healing?.failingLocator?.method, rec.locator);
  return edit ? { edit, patch: locatorEditPatch(edit, props.healing?.location ?? null) } : null;
});

// Fallback when there's no source line to rewrite but the recommendation keeps
// the method family — show just the changed args (name 'Old' → 'New').
const argChanges = computed(() => {
  if (suggestedEdit.value) return [];
  const f = props.healing?.failingLocator;
  const rec = recommended.value;
  if (!f || !rec || rec.method !== f.method) return [];
  return diffLocatorArgs(f.args, rec.args);
});

function copyFixPrompt() {
  const rec = recommended.value;
  if (!rec || !props.healing) return;
  copyText(
    buildLocatorFixPrompt({
      location: props.healing.location ?? null,
      sourceLine: props.healing.sourceLine ?? null,
      failing: failingLocatorText.value,
      recommended: rec.locator,
    }),
    'fix-prompt',
    'Fix prompt copied',
  );
}

// The server rewrites the failing line and ships it as a git-applyable unified
// diff; hand it over verbatim so `git apply` (or an agent) can patch the file.
function copyGitApply() {
  const diff = props.healing?.edit?.unifiedDiff;
  if (diff) copyText(diff, 'git-apply', 'Patch copied');
}

// ── Collapse the long tail of alternatives ───────────────────────────────────
const ALT_PREVIEW = 3;
const showAllAlternatives = ref(false);
const visibleAlternatives = computed<RankedLocator[]>(() =>
  showAllAlternatives.value ? alternatives.value : alternatives.value.slice(0, ALT_PREVIEW),
);

const narrowing = computed(() => props.healing?.narrowingSuggestion ?? null);

// Forward the fold/scroll so a clue or AI citation to `locatorHealing` can reveal it.
const cardRef = ref<{ reveal?: () => void } | null>(null);
// The next-step line drives the panel's own pick and alternatives rather than
// duplicating them: reveal the panel, then run the same action its buttons do.
defineExpose({
  reveal: () => cardRef.value?.reveal?.(),
  openPicker: () => {
    cardRef.value?.reveal?.();
    pickerOpen.value = true;
  },
  expandAlternatives: () => {
    cardRef.value?.reveal?.();
    showAllAlternatives.value = true;
  },
});
</script>

<template>
  <component
    :is="cardComponent"
    v-if="hasData"
    ref="cardRef"
    v-bind="cardBind"
    data-shot="alternative-locators"
    icon="i-lucide-bandage"
    title="Locator fix"
    :count="alternatives.length"
    help="locator-healing"
  >
    <template v-if="storageKey" #folded>
      <LocatorCode v-if="recommendation?.recommended" :locator="recommendation.recommended.locator" class="text-xs" />
      <span v-else>{{ alternatives.length }} alternative{{ alternatives.length === 1 ? '' : 's' }}</span>
    </template>
    <template #subtitle>
      <span :class="sourceClass">
        {{ sourceNote }}
      </span>
    </template>
    <template v-if="pickTraceUrl || healing?.failingLocator" #actions>
      <div class="flex items-center gap-1">
        <UButton
          v-if="healing?.failingLocator"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-mouse-pointer"
          title="Open the failure-time DOM snapshot and click the element to pick a locator"
          @click="pickerOpen = true"
        >
          Pick from snapshot
        </UButton>
        <UButton
          v-if="pickTraceUrl"
          :to="pickTraceUrl"
          target="_blank"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-crosshair"
          title="Open the failure trace in the trace viewer — its Pick locator tool works on the recorded page snapshots"
          @click="onPickFromTrace"
        >
          Pick from trace
        </UButton>
      </div>
    </template>

    <!-- Closed loop: the recommended locator now passes at this call site -->
    <UAlert
      v-if="healing?.healedInRunId"
      class="mb-3"
      color="success"
      icon="i-lucide-circle-check"
      variant="subtle"
      title="Locator healed"
    >
      <template #description>
        The recommended locator now passes at this call site &mdash;
        <NuxtLink :to="`/test-runs/${healing.healedInRunId}`" class="underline font-medium">
          see run #{{ healing.healedInRunId }}</NuxtLink
        >.
      </template>
    </UAlert>

    <!-- Auto-heal opened (or queued) a PR covering this call site -->
    <UAlert
      v-if="healing?.healAction"
      class="mb-3"
      :color="healing.healAction.status === 'opened' ? 'primary' : 'neutral'"
      icon="i-lucide-bandage"
      variant="subtle"
      :title="healing.healAction.status === 'opened' ? 'Piwi opened a heal PR' : 'Heal PR queued'"
    >
      <template #description>
        <template v-if="healing.healAction.status === 'opened' && healing.healAction.prUrl">
          Auto-heal opened
          <a :href="healing.healAction.prUrl" target="_blank" rel="noopener" class="underline font-medium">
            PR #{{ healing.healAction.prNumber }}</a
          >
          to rewrite this locator.
        </template>
        <template v-else>
          Auto-heal has queued a fix for this locator on branch <code>{{ healing.healAction.branch }}</code
          >.
        </template>
      </template>
    </UAlert>

    <!-- Human-confirmed pick — prominent callout at the very top -->
    <div v-if="userPick" class="rounded-lg border border-primary/50 bg-primary/10 p-3 mb-3 flex items-center gap-3">
      <UIcon name="i-lucide-user-check" class="size-5 text-primary shrink-0" />
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium text-primary flex items-center gap-1.5">
          Your pick
          <UBadge size="sm" color="primary" variant="subtle">confirmed on the failing page</UBadge>
        </p>
        <LocatorCode :locator="userPick.locator" truncate class="text-sm mt-0.5" />
      </div>
      <UButton
        size="sm"
        color="primary"
        variant="solid"
        :trailing-icon="copiedKey === 'user-pick' ? 'i-lucide-check' : 'i-lucide-copy'"
        @click="copyLocator(userPick.locator, 'user-pick')"
      >
        Copy
      </UButton>
    </div>

    <!-- The failing locator and the fix for it, which the demo's guided tour points at -->
    <div v-if="healing?.failingLocator || healing?.priorNameMayBeStale || recommended" data-tour="locator-fix">
      <!-- Failing locator -->
      <div
        v-if="healing?.failingLocator"
        class="bg-elevated rounded p-2 mb-3 border border-red-200 dark:border-red-800"
      >
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-x-circle" class="size-4 text-red-500 shrink-0" />
          <LocatorCode :locator="failingLocatorText" truncate class="text-xs flex-1 min-w-0" />
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            :icon="copiedKey === 'failing' ? 'i-lucide-check' : 'i-lucide-copy'"
            :title="copiedKey === 'failing' ? 'Copied!' : 'Copy'"
            @click="copyLocator(failingLocatorText, 'failing')"
          />
        </div>
        <!-- AI-step intent: the natural-language prompt this locator was compiled from -->
        <div v-if="failingIntent" class="flex items-center gap-2 mt-1.5 pl-6">
          <UIcon name="i-lucide-wand-sparkles" class="size-3.5 text-primary shrink-0" />
          <span class="text-xs text-gray-500">
            Compiled from prompt
            <span class="font-medium text-gray-700 dark:text-gray-300">“{{ failingIntent.template }}”</span>
            <template v-if="failingIntent.kind === 'run'"> (a <code class="text-xs">piwiRun</code> flow step)</template>
          </span>
        </div>
      </div>

      <!-- The stored accessible name is gone from the failing page — name-based
           alternatives below probably broke together with the failing locator -->
      <UAlert
        v-if="healing?.priorNameMayBeStale"
        class="mb-3"
        color="warning"
        icon="i-lucide-alert-triangle"
        variant="subtle"
        title="The element's name looks changed"
      >
        <template #description>
          <p>
            The captured accessible name no longer appears on the failing page, so name-based alternatives (and the
            failing locator itself) probably no longer match. Prefer the structural options, or the failing-page
            candidates below.
          </p>
          <UButton
            v-if="hasPageDiff"
            class="mt-1.5 -ml-1.5"
            variant="link"
            color="warning"
            size="xs"
            icon="i-lucide-file-diff"
            label="See it in the page diff"
            @click="emit('show-page-diff')"
          />
        </template>
      </UAlert>

      <!-- Recommended fix — the hero action, above the full menu. Keeps the
           original locator style where it's stable enough, and offers the exact
           one-line edit for the failing test. -->
      <div v-if="recommended" class="rounded-lg border border-primary/40 bg-primary/5 p-3 max-sm:p-2 mb-3 space-y-2">
        <div class="flex items-center gap-2 min-w-0">
          <UIcon name="i-lucide-star" class="size-4 text-primary shrink-0" />
          <p class="text-xs font-medium text-primary shrink-0">Recommended fix</p>
          <span v-if="recommendationSourceLabel" class="text-[11px] text-gray-500 truncate min-w-0">
            · {{ recommendationSourceLabel }}
          </span>
          <span class="flex-1" />
          <UBadge size="xs" color="primary" variant="subtle" class="font-mono tabular-nums shrink-0">
            {{ recommended.score }}
          </UBadge>
        </div>

        <!-- Ready-to-apply one-line edit, when the failing source line is known -->
        <div
          v-if="suggestedEdit"
          data-copies="copy-git-apply copy-locator"
          class="rounded border border-default overflow-hidden bg-default"
        >
          <DiffPatch :patch="suggestedEdit.patch" :file="healing?.location" />
        </div>
        <template v-else>
          <LocatorCode :locator="recommended.locator" truncate class="text-sm" />
          <!-- Only the changed args, when the fix keeps the method family -->
          <p v-if="argChanges.length" class="text-xs flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <template v-for="(c, i) in argChanges" :key="i">
              <span class="font-mono text-gray-500">{{ c.key }}:</span>
              <span v-if="c.from" class="font-mono text-red-500 line-through">{{ c.from }}</span>
              <span v-else class="text-gray-400">—</span>
              <UIcon name="i-lucide-arrow-right" class="size-3 text-gray-400" />
              <span v-if="c.to" class="font-mono text-green-600 dark:text-green-400">{{ c.to }}</span>
              <span v-else class="text-gray-400">removed</span>
            </template>
          </p>
        </template>

        <p v-if="recommendationNote" class="text-xs text-gray-500">{{ recommendationNote }}</p>
        <p v-if="appliesToNote" class="text-xs text-primary/90 flex items-center gap-1">
          <UIcon name="i-lucide-layers" class="size-3 shrink-0" />{{ appliesToNote }}
        </p>

        <div class="flex items-center gap-2">
          <UButton
            size="xs"
            color="primary"
            variant="solid"
            :trailing-icon="copiedKey === 'top' ? 'i-lucide-check' : 'i-lucide-copy'"
            @click="copyLocator(recommended.locator, 'top')"
          >
            Copy locator
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            :icon="copiedKey === 'fix-prompt' ? 'i-lucide-check' : 'i-lucide-sparkles'"
            title="Copy an instruction an AI coding agent can apply directly to the test"
            @click="copyFixPrompt"
          >
            Copy fix prompt
          </UButton>
          <UButton
            v-if="healing?.edit?.unifiedDiff"
            size="xs"
            color="neutral"
            variant="outline"
            :icon="copiedKey === 'git-apply' ? 'i-lucide-check' : 'i-lucide-copy'"
            title="Copy a git apply patch that rewrites the failing locator line"
            @click="copyGitApply"
          >
            Copy patch
          </UButton>
        </div>
      </div>
    </div>

    <!-- Narrowing suggestion — add .visible() when only one match is visible -->
    <div v-if="narrowing" class="rounded-lg border border-default bg-elevated p-3 mb-3 flex items-center gap-3">
      <UIcon name="i-lucide-eye" class="size-5 text-primary shrink-0" />
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium text-primary">Or narrow with <code>.visible()</code></p>
        <p class="text-xs text-gray-500 mt-0.5">
          The locator matched {{ narrowing.matchCount }} elements but only one is visible — adding
          <code>.visible()</code> keeps it without changing the locator.
        </p>
      </div>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        :trailing-icon="copiedKey === 'narrowing' ? 'i-lucide-check' : 'i-lucide-copy'"
        @click="copyLocator('.visible()', 'narrowing')"
      >
        Copy
      </UButton>
    </div>

    <!-- Sturdier option — surfaced when the recommended fix keeps the original (less stable) style -->
    <div
      v-if="recommendation?.hasDurableAlternative && recommendation.durable"
      class="rounded-lg border border-default bg-elevated p-3 mb-3 flex items-center gap-3"
    >
      <UIcon name="i-lucide-shield-check" class="size-5 text-success shrink-0" />
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium text-success-600 dark:text-success-400">
          Most stable option (score: {{ recommendation.durable.score }})
        </p>
        <LocatorCode :locator="recommendation.durable.locator" truncate class="text-sm mt-0.5" />
        <p class="text-xs text-gray-500 mt-0.5">Sturdier, but changes the locator style</p>
      </div>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        :trailing-icon="copiedKey === 'durable' ? 'i-lucide-check' : 'i-lucide-copy'"
        @click="copyLocator(recommendation.durable.locator, 'durable')"
      >
        Copy
      </UButton>
    </div>

    <!-- Ranked alternatives — the full menu, collapsed to the top few -->
    <div class="space-y-2">
      <p class="text-xs font-medium text-gray-500">All alternatives</p>
      <LocatorAlternativeRow
        v-for="(alt, i) in visibleAlternatives"
        :key="i"
        :alt="alt"
        :copied="copiedKey === `alt-${i}`"
        @copy="copyLocator(alt.locator, `alt-${i}`)"
      />
      <UButton
        v-if="alternatives.length > ALT_PREVIEW"
        size="xs"
        variant="ghost"
        color="neutral"
        block
        :icon="showAllAlternatives ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        @click="showAllAlternatives = !showAllAlternatives"
      >
        {{ showAllAlternatives ? 'Show fewer' : `Show all ${alternatives.length} alternatives` }}
      </UButton>
    </div>

    <!-- Failing-page candidates (stale stored list only) -->
    <div v-if="supplement.length" class="mt-3">
      <p class="text-xs font-medium text-gray-500 mb-2">From the failing page</p>
      <div class="space-y-2">
        <LocatorAlternativeRow
          v-for="(alt, i) in supplement"
          :key="i"
          :alt="alt"
          note="candidate from the failure-time ARIA snapshot"
          :copied="copiedKey === `supp-${i}`"
          @copy="copyLocator(alt.locator, `supp-${i}`)"
        />
      </div>
    </div>

    <!-- Nothing stable enough — recommend adding a data-testid to the app -->
    <UAlert
      v-if="recommendation?.suggestAddTestId"
      class="mt-3"
      color="warning"
      icon="i-lucide-info"
      variant="subtle"
      title="All alternatives are fragile"
      description="Every captured locator scores below 50. Add a stable data-testid attribute to this element in the app for a durable fix."
    />

    <!-- ARIA-snapshot fallback hint -->
    <UAlert v-if="healing?.source === 'aria-snapshot'" class="mt-3" color="info" icon="i-lucide-info" variant="subtle">
      <template #description>
        No HTML attributes were available.
        <DocLink to="guide/capture-fixtures" no-icon class="text-primary hover:underline"
          >Enable Piwi fixture capture</DocLink
        >
        for full alternatives including data-testid and CSS selectors.
      </template>
    </UAlert>
  </component>

  <!-- Healing does not apply: the locator resolved (or the failure is a
       navigation error, or names no locator). One line, no ranked menu. -->
  <component
    :is="cardComponent"
    v-else-if="chrome !== false && healing?.applicable === false"
    v-bind="cardBind"
    data-shot="alternative-locators"
    icon="i-lucide-bandage"
    title="Locator fix"
    subtitle="Not a locator problem"
    help="locator-healing"
  >
    <template v-if="storageKey" #folded>
      <span>{{ healing.reason }}</span>
    </template>
    <p class="text-sm text-gray-600 dark:text-gray-400">{{ healing.reason }}</p>
  </component>

  <!-- No data -->
  <component
    :is="cardComponent"
    v-else-if="healing"
    v-bind="cardBind"
    icon="i-lucide-bandage"
    title="Locator fix"
    subtitle="No alternatives available"
    help="locator-healing"
  >
    <template v-if="storageKey" #folded>
      <span>No alternatives available</span>
    </template>
    <template v-if="pickTraceUrl || healing?.failingLocator" #actions>
      <div class="flex items-center gap-1">
        <UButton
          v-if="healing?.failingLocator"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-mouse-pointer"
          title="Open the failure-time DOM snapshot and click the element to pick a locator"
          @click="pickerOpen = true"
        >
          Pick from snapshot
        </UButton>
        <UButton
          v-if="pickTraceUrl"
          :to="pickTraceUrl"
          target="_blank"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-crosshair"
          title="Open the failure trace in the trace viewer — its Pick locator tool works on the recorded page snapshots"
          @click="onPickFromTrace"
        >
          Pick from trace
        </UButton>
      </div>
    </template>
    <UAlert color="neutral" icon="i-lucide-info" variant="subtle">
      <template #description>
        No pre-captured alternatives — this locator has never passed in a previous run.
        <DocLink to="guide/capture-fixtures" no-icon class="text-primary hover:underline"
          >Enable Piwi dashboard fixtures</DocLink
        >
        to capture element attributes at test time, or use “Pick from snapshot” above to choose a locator by hand on the
        failure-time page. In local headed runs,
        <DocLink
          to="features/locator-healing#pick-a-replacement-locator-on-the-failing-page-local-runs"
          no-icon
          class="text-primary hover:underline"
          >pickLocatorOnFailure</DocLink
        >
        opens the same picker on the still-open failing page, and the
        <DocLink to="features/extension" no-icon class="text-primary hover:underline"
          >Piwi Picker browser extension</DocLink
        >
        picks from any live page without a test run.
      </template>
    </UAlert>
  </component>

  <!-- Interactive DOM snapshot picker modal -->
  <SnapshotLocatorPicker
    v-if="healing?.failingLocator"
    v-model:open="pickerOpen"
    :test-runs-case-id="testRunsCaseId"
    :failing-locator="healing.failingLocator"
    :healing="healing"
    @confirmed="refreshHealing"
  />
</template>
