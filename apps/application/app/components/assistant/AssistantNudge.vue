<script setup lang="ts" generic="P extends NudgePage">
/**
 * One nudge, inline where a page places it: a suggestion offered when a rule
 * over what the page already loaded holds (`app/utils/nudges/`), with the
 * offer's button (**Show me** starts an authored guide, **Ask** opens the
 * assistant's panel and asks the question) and **Don't show again**, which
 * dismisses it for good, in every browser. A page view shows one nudge at
 * most, and only while this browser's weekly budget has room. A guide needs
 * no model, so its nudge shows while the assistant is declined; a question's
 * shows only while the assistant can answer it. It renders in the browser only.
 */
import { pickNudge, nudgeGuide, type Nudge, type NudgePage, type NudgePageFacts } from '~/utils/nudges/nudges';

const props = defineProps<{
  /** The page's pattern of `app/pages`. */
  page: P;
  /** What the page loaded that the rules read; null while it is still loading. */
  facts: NudgePageFacts[P] | null;
}>();

const { state, isHidden } = await useInstanceCapabilities();
const { canAnywhere } = useAuth();
const { start } = await useAuthoredGuides();
const assistant = useAssistant();
const { dismissed, loadDismissals, dismiss, takeBudget } = useNudges();

const titleId = useId();
const mounted = ref(false);

/** The assistant answers here: neither declined nor without a model. */
const canAsk = computed(() => assistant.available.value && state('assistant') !== 'declined');

/** The nudge whose rule holds now, for this user; none until the dismissals are read. */
const candidate = computed<Nudge | null>(() => {
  if (!mounted.value || !props.facts || !dismissed.value) return null;
  return pickNudge(props.page, props.facts, {
    isHidden,
    holds: canAnywhere,
    canAsk: canAsk.value,
    dismissed: dismissed.value,
  });
});

// The page view asks the budget once, for its first candidate, and shows that
// nudge while its rule holds.
const shown = ref<Nudge | null>(null);
let budgetAsked = false;
watch(candidate, (next) => {
  if (shown.value) {
    if (next?.id !== shown.value.id) shown.value = null;
    return;
  }
  if (!next || budgetAsked) return;
  budgetAsked = true;
  if (takeBudget()) shown.value = next;
});

const guide = computed(() => (shown.value ? nudgeGuide(shown.value) : null));

function offer(): void {
  const nudge = shown.value;
  if (!nudge) return;
  if (guide.value) void start(guide.value);
  else if (nudge.offer.kind === 'question') void assistant.openPanel(nudge.offer.question);
}

onMounted(() => {
  mounted.value = true;
  void loadDismissals();
  if (state('assistant') !== 'declined') void assistant.loadStatus();
});
</script>

<template>
  <aside
    v-if="shown"
    :aria-labelledby="titleId"
    :data-nudge="shown.id"
    data-shot="assistant-nudge"
    class="flex flex-col gap-2 rounded-lg border border-default bg-elevated/40 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4 sm:px-4"
  >
    <div class="min-w-0 flex-1">
      <p :id="titleId" class="text-sm font-semibold text-highlighted">{{ shown.title }}</p>
      <p class="text-sm text-highlighted leading-relaxed">{{ shown.body }}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2 shrink-0">
      <UButton color="neutral" variant="outline" size="sm" :label="guide ? 'Show me' : 'Ask'" @click="offer" />
      <UButton color="neutral" variant="ghost" size="sm" label="Don't show again" @click="dismiss(shown.id)" />
    </div>
  </aside>
</template>
