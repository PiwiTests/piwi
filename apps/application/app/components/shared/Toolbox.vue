<script setup lang="ts">
/**
 * "More ways to fix" — every other way to fix, verify or reproduce a failure,
 * placed after the Evidence card. Each section is folded to one line (a
 * sentence-case label plus a one-line summary the page supplies) except the one
 * the next step points at, which opens with the page. A folded section's body is
 * not rendered, so its code blocks never count against the first screen. The
 * `FixSectionKey` union (`app/utils/fix-sections.ts`) and the per-section slot
 * contract are the same the two pages fill; the card renders the sections it is
 * given in one fixed order.
 *
 * With `lead`, the section the next step points at is not a fold of the card: it
 * is a card of its own, titled with the section's label and always open, followed
 * by the `between` slot (what the page shows between the fix and the rest), then
 * "More ways to fix" with every other section folded. Without a section for the
 * next step, `lead` renders the `between` slot, then the card.
 */
import type { HelpTopicKey } from '~/utils/help-content';
import type { NextStepKind } from '#shared/next-step';
import { FIX_SECTION_LABELS, FIX_SECTION_ORDER, fixSectionForNextStep, type FixSectionKey } from '~/utils/fix-sections';

const props = defineProps<{
  /** Which sections have content; the toolbox renders them in its canonical order. */
  sections: FixSectionKey[];
  /** The next step's kind — decides which section opens with the page. */
  nextStepKind?: NextStepKind | null;
  /** The next step's section leads as a card of its own, above the `between` slot. */
  lead?: boolean;
  help?: HelpTopicKey;
}>();

const defaultOpen = computed<FixSectionKey | null>(() => fixSectionForNextStep(props.nextStepKind, props.sections));

// The section that leads as its own card, in lead mode.
const leadKey = computed<FixSectionKey | null>(() => (props.lead ? defaultOpen.value : null));

const active = computed(() =>
  FIX_SECTION_ORDER.filter((key) => props.sections.includes(key) && key !== leadKey.value).map((key) => ({
    key,
    label: FIX_SECTION_LABELS[key],
  })),
);

// The open section is the next step's, until the user toggles one open — a
// component-only state, never persisted. In lead mode that section is the lead
// card, so the card's sections all start folded.
const initialOpen = () => (props.lead ? null : defaultOpen.value);
const openKey = ref<FixSectionKey | null>(initialOpen());
watch([defaultOpen, () => props.lead], () => {
  openKey.value = initialOpen();
});

// Each section's guide anchor: on its toggle, which a guide clicks to unfold it,
// or on its card when it leads.
const SECTION_ANCHORS: Record<FixSectionKey, Record<string, string>> = {
  diagnosis: { 'data-tour': 'fix-section-diagnosis' },
  'locator-fix': { 'data-tour': 'fix-section-locator-fix' },
  verify: { 'data-tour': 'fix-section-verify' },
  reproduce: { 'data-tour': 'fix-section-reproduce' },
  'fixed-before': { 'data-tour': 'fix-section-fixed-before' },
  blocked: { 'data-tour': 'fix-section-blocked' },
  'fix-plan': { 'data-tour': 'fix-section-fix-plan' },
};

function toggle(key: FixSectionKey) {
  openKey.value = openKey.value === key ? null : key;
}

// A folded summary truncates to one line; mirror its text into the element's
// `title` so the clipped tail stays readable on hover. The summaries are slot
// content, so read the rendered text rather than threading a second prop.
const vTitleFromText = {
  mounted: (el: HTMLElement) => {
    el.title = el.textContent?.trim() ?? '';
  },
  updated: (el: HTMLElement) => {
    el.title = el.textContent?.trim() ?? '';
  },
};

const rootEl = ref<HTMLElement | null>(null);
const leadEl = ref<HTMLElement | null>(null);

/**
 * Open a section. Resolves once its body is mounted, so a caller can then act on
 * a panel the section renders. A key the toolbox does not show leaves the open
 * section as it is; the lead section is always open.
 */
async function openSection(key: FixSectionKey): Promise<void> {
  if (!props.sections.includes(key)) return;
  if (key !== leadKey.value) openKey.value = key;
  await nextTick();
}

/**
 * Open a section and scroll it into view, at the element whose `data-shot` is
 * `anchor` when the section holds one; resolves once its body is mounted.
 */
async function scrollToSection(key: FixSectionKey, anchor?: string): Promise<void> {
  await openSection(key);
  const scope = key === leadKey.value ? leadEl.value : rootEl.value;
  const section = scope?.querySelector<HTMLElement>(`[data-shot="fix-${key}"]`);
  const target = (anchor ? section?.querySelector<HTMLElement>(`[data-shot="${anchor}"]`) : null) ?? section;
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

defineExpose({ openSection, scrollToSection });
</script>

<template>
  <!-- The next step's section, as a card of its own -->
  <div v-if="leadKey" ref="leadEl" class="scroll-mt-4">
    <SectionCard :title="FIX_SECTION_LABELS[leadKey]" data-shot="fix-lead" v-bind="SECTION_ANCHORS[leadKey]">
      <template v-if="$slots[`${leadKey}-actions`]" #actions>
        <slot :name="`${leadKey}-actions`" />
      </template>
      <section :data-shot="`fix-${leadKey}`" class="space-y-2">
        <slot :name="leadKey" />
      </section>
    </SectionCard>
  </div>

  <slot v-if="lead" name="between" />

  <SectionCard
    v-if="active.length || !lead"
    icon="i-lucide-wrench"
    icon-class="text-primary"
    title="More ways to fix"
    :help="help"
    data-shot="fix"
  >
    <div ref="rootEl" class="divide-y divide-default" data-tour="more-ways-to-fix">
      <section v-for="s in active" :key="s.key" class="first:pt-0 last:pb-0" :data-shot="`fix-${s.key}`">
        <div class="flex items-center justify-between gap-2 py-3">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-primary"
            :aria-expanded="openKey === s.key"
            v-bind="SECTION_ANCHORS[s.key]"
            @click="toggle(s.key)"
          >
            <UIcon
              :name="openKey === s.key ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
              class="size-4 shrink-0 text-gray-400"
            />
            <span class="text-sm font-medium shrink-0">{{ s.label }}</span>
            <span v-if="openKey !== s.key" v-title-from-text class="min-w-0 flex-1 truncate text-sm text-muted">
              <slot :name="`${s.key}-summary`" />
            </span>
          </button>
          <div v-if="openKey === s.key" class="flex items-center gap-1 shrink-0">
            <slot :name="`${s.key}-actions`" />
          </div>
        </div>
        <div v-if="openKey === s.key" class="pb-3 space-y-2">
          <slot :name="s.key" />
        </div>
      </section>
    </div>
  </SectionCard>
</template>
