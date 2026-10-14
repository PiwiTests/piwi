<script setup lang="ts">
/**
 * The one block at the top of a failure page: what broke, what is going on and
 * what to do next. An identity kicker and the page's `<h1>` on top, then a
 * labelled list whose labels sit in one narrow column so the lines read as a
 * structured record rather than a paragraph, then the facts line under a divider.
 * The list follows one order on every page (`SITUATION_ROWS`): the explanation,
 * then the action (the state right above the next step), then the context.
 * Every line is an optional named slot; a line with no slot collapses, so the same
 * frame serves a failing execution (with a what-changed line when its suspect
 * lines are known), a passing one (identity and facts only), the cluster page,
 * which adds its state, occurrence and what-changed lines, and a bug report.
 *
 * The block uses four text styles and no more: the heading, one body style for
 * the sentences, one label style, one meta style; code in a heading or a sentence
 * sits in a chip. Its left edge carries the status color the page passes — the
 * execution's outcome, the cluster's state — so the page's situation reads before
 * a word of it. It carries the page's help hint; a line adds one of its own only to
 * explain a setup gap, as What changed does when the runs lack what Piwi needs
 * to read the commits.
 */
import type { HelpTopicKey } from '~/utils/help-content';
import { SITUATION_ROWS } from '~/utils/situation-rows';

const props = defineProps<{
  help?: HelpTopicKey;
  /** The status color of the left edge, a CSS color (`var(--color-status-failed)`); none without. */
  edge?: string | null;
}>();

// A 4px edge in the status color, on every width (the phone layout drops the side borders).
const edgeStyle = computed(() => (props.edge ? { borderLeftWidth: '4px', borderLeftColor: props.edge } : undefined));

// The explanation and action lines lead, under the headline; the context lines follow.
const CONTEXT_START = SITUATION_ROWS.findIndex((r) => r.slot === 'cluster');
const LEAD_ROWS = SITUATION_ROWS.slice(0, CONTEXT_START);
const CONTEXT_ROWS = SITUATION_ROWS.slice(CONTEXT_START);
/** Both lists of lines: one narrow label column, one content column. */
const LINES_CLASS = 'mt-4 grid grid-cols-1 gap-y-4 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-x-4';
</script>

<template>
  <div
    data-shot="situation-block"
    class="rounded-lg border border-default bg-default p-3 sm:p-4 max-sm:rounded-none max-sm:border-x-0"
    :style="edgeStyle"
  >
    <!-- What broke, why and what to do: the part the demo's guided tour points at -->
    <div data-tour="situation">
      <!-- Identity kicker, with the block's one help hint and any actions -->
      <div v-if="$slots.identity || $slots.actions || help" class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1 text-sm text-muted"><slot name="identity" /></div>
        <div v-if="$slots.actions || help" class="flex items-center gap-1.5 shrink-0">
          <slot name="actions" />
          <HelpHint v-if="help" :topic="help" />
        </div>
      </div>

      <!-- The headline — the page's h1 -->
      <div v-if="$slots.headline" class="mt-1.5"><slot name="headline" /></div>

      <!-- The labelled lines that explain and act -->
      <dl v-if="LEAD_ROWS.some((r) => $slots[r.slot])" :class="LINES_CLASS">
        <template v-for="row in LEAD_ROWS" :key="row.slot">
          <template v-if="$slots[row.slot]">
            <dt class="text-sm font-semibold text-highlighted leading-relaxed max-sm:-mb-3">{{ row.label }}</dt>
            <dd class="min-w-0 text-sm text-highlighted leading-relaxed"><slot :name="row.slot" /></dd>
          </template>
        </template>
      </dl>
    </div>

    <!-- The labelled lines that give the context, in the same two columns -->
    <dl v-if="CONTEXT_ROWS.some((r) => $slots[r.slot])" :class="LINES_CLASS">
      <template v-for="row in CONTEXT_ROWS" :key="row.slot">
        <template v-if="$slots[row.slot]">
          <dt class="text-sm font-semibold text-highlighted leading-relaxed max-sm:-mb-3">{{ row.label }}</dt>
          <dd class="min-w-0 text-sm text-highlighted leading-relaxed"><slot :name="row.slot" /></dd>
        </template>
      </template>
    </dl>

    <!-- The facts line, one size smaller, under a divider -->
    <div v-if="$slots.facts" class="mt-4 border-t border-default pt-2.5 text-xs text-muted">
      <slot name="facts" />
    </div>
  </div>
</template>
