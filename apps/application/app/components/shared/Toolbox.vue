<script setup lang="ts">
/**
 * "More ways to fix": every other way to fix, verify or reproduce a failure, as
 * one line above the Evidence card. The line holds one button per section, its
 * one-line summary (which the page supplies) in the button's tooltip; a click
 * opens the section in a side panel, which closes on Escape or on a click
 * outside it, and does not hold the focus, so the evidence stays usable beside
 * it. Only the open section's body is rendered. The `FixSectionKey` union
 * (`app/utils/fix-sections.ts`) and the per-section slot contract are the same
 * the two pages fill; the line lists the sections it is given in one fixed order.
 *
 * With `lead`, the section the next step points at is not in the line: it is a
 * card of its own above it, titled with the section's label and always open.
 */
import type { HelpTopicKey } from '~/utils/help-content';
import type { NextStepKind } from '#shared/next-step';
import { FIX_SECTION_LABELS, FIX_SECTION_ORDER, fixSectionForNextStep, type FixSectionKey } from '~/utils/fix-sections';

const props = defineProps<{
  /** Which sections have content; the toolbox renders them in its canonical order. */
  sections: FixSectionKey[];
  /** The next step's kind: in `lead` mode, decides which section leads as a card of its own. */
  nextStepKind?: NextStepKind | null;
  /** The next step's section leads as a card of its own, above the line. */
  lead?: boolean;
  help?: HelpTopicKey;
}>();

// The section that leads as its own card, in lead mode.
const leadKey = computed<FixSectionKey | null>(() =>
  props.lead ? fixSectionForNextStep(props.nextStepKind, props.sections) : null,
);

const active = computed(() =>
  FIX_SECTION_ORDER.filter((key) => props.sections.includes(key) && key !== leadKey.value).map((key) => ({
    key,
    label: FIX_SECTION_LABELS[key],
  })),
);

// The section the side panel shows, and whether it is open: component-only
// state, never persisted. The key outlives the panel's closing so its leave
// transition keeps its content.
const openKey = ref<FixSectionKey | null>(null);
const panelOpen = ref(false);

// Each section's guide anchor: on its button in the line, which opens it in the
// side panel, or on its card when it leads.
const SECTION_ANCHORS: Record<FixSectionKey, Record<string, string>> = {
  diagnosis: { 'data-tour': 'fix-section-diagnosis' },
  'locator-fix': { 'data-tour': 'fix-section-locator-fix' },
  verify: { 'data-tour': 'fix-section-verify' },
  reproduce: { 'data-tour': 'fix-section-reproduce' },
  'fixed-before': { 'data-tour': 'fix-section-fixed-before' },
  blocked: { 'data-tour': 'fix-section-blocked' },
  'fix-plan': { 'data-tour': 'fix-section-fix-plan' },
};

const lineEl = ref<HTMLElement | null>(null);
const leadEl = ref<HTMLElement | null>(null);
const panelSectionEl = ref<HTMLElement | null>(null);

function toggle(key: FixSectionKey) {
  if (panelOpen.value && openKey.value === key) {
    panelOpen.value = false;
    return;
  }
  openKey.value = key;
  panelOpen.value = true;
}

// The side panel spans the page's height, as the page does: under the demo's
// banner and above the desktop app's docked Local runs tray, which stays usable.
// Important, to win over the theme's `inset-y-0`.
const PANEL_CLASS = 'sm:max-w-3xl top-[var(--demo-banner-height,0px)]! bottom-[var(--desktop-runs-height,0px)]!';

// A press on the line's buttons is theirs to answer: it switches or closes the
// panel, so the panel's own outside-press closing does not run first.
function onInteractOutside(event: Event) {
  const detail = (event as CustomEvent<{ originalEvent?: Event }>).detail;
  const target = (detail?.originalEvent?.target ?? event.target) as Node | null;
  if (target && lineEl.value?.contains(target)) event.preventDefault();
}

/** Resolves once the side panel shows `key`'s section, or after a few frames without it. */
async function panelShows(key: FixSectionKey): Promise<HTMLElement | null> {
  for (let frame = 0; frame < 20; frame++) {
    await nextTick();
    const el = panelSectionEl.value;
    if (el?.isConnected && el.dataset.shot === `fix-${key}`) return el;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return null;
}

/**
 * Open a section: the side panel on it, or nothing for the lead card, which is
 * always open. Resolves once its body is mounted, so a caller can then act on a
 * panel the section renders. A key the toolbox does not show changes nothing.
 */
async function openSection(key: FixSectionKey): Promise<void> {
  if (!props.sections.includes(key)) return;
  if (key === leadKey.value) {
    await nextTick();
    return;
  }
  openKey.value = key;
  panelOpen.value = true;
  await panelShows(key);
}

/**
 * Open a section and bring it into view, at the element whose `data-shot` is
 * `anchor` when the section holds one; resolves once its body is mounted. The
 * lead card scrolls the page; a section of the side panel scrolls the panel.
 */
async function scrollToSection(key: FixSectionKey, anchor?: string): Promise<void> {
  if (!props.sections.includes(key)) return;
  await openSection(key);
  const section =
    key === leadKey.value ? leadEl.value?.querySelector<HTMLElement>(`[data-shot="fix-${key}"]`) : panelSectionEl.value;
  const target = (anchor ? section?.querySelector<HTMLElement>(`[data-shot="${anchor}"]`) : null) ?? section;
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Close the side panel, as before showing the evidence it points at. */
function closePanel() {
  panelOpen.value = false;
}

defineExpose({ openSection, scrollToSection, closePanel });
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

  <!-- Every other section, one button each, on one line -->
  <UCard v-if="active.length" :ui="{ header: 'p-2.5 sm:px-4 sm:py-3' }" data-shot="fix">
    <template #header>
      <div ref="lineEl" class="flex flex-wrap items-center gap-x-3 gap-y-2" data-tour="more-ways-to-fix">
        <div class="flex items-center gap-2 shrink-0">
          <UIcon name="i-lucide-wrench" class="size-5 shrink-0" :class="CARD_ICON_CLASS" data-card-icon />
          <h3 class="text-lg font-medium inline-flex items-center gap-1">
            More ways to fix<HelpHint v-if="help" :topic="help" />
          </h3>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 min-w-0">
          <UTooltip v-for="s in active" :key="s.key" :ui="{ content: 'h-auto max-w-sm whitespace-normal py-1.5' }">
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :label="s.label"
              aria-haspopup="dialog"
              :aria-expanded="panelOpen && openKey === s.key ? 'true' : 'false'"
              :class="panelOpen && openKey === s.key ? PRESSED_TOGGLE_CLASS : ''"
              v-bind="SECTION_ANCHORS[s.key]"
              @click="toggle(s.key)"
            />
            <template #content><slot :name="`${s.key}-summary`" /></template>
          </UTooltip>
        </div>
      </div>
    </template>
  </UCard>

  <!-- The open section, beside the page: no overlay and no focus trap -->
  <USlideover
    v-model:open="panelOpen"
    :modal="false"
    :overlay="false"
    :title="openKey ? FIX_SECTION_LABELS[openKey] : 'More ways to fix'"
    :content="{ onInteractOutside }"
    :ui="{ content: PANEL_CLASS }"
  >
    <template v-if="openKey && $slots[`${openKey}-actions`]" #actions>
      <slot :name="`${openKey}-actions`" />
    </template>
    <template #body>
      <section v-if="openKey" ref="panelSectionEl" :data-shot="`fix-${openKey}`" class="space-y-2">
        <slot :name="openKey" />
      </section>
    </template>
  </USlideover>
</template>
