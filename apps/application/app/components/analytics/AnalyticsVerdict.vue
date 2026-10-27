<script setup lang="ts">
import type { AnalyticsVerdict, VerdictTone } from '#shared/analytics/types';
import { sentencesFor } from '#shared/reports/sentences';

const props = defineProps<{ query: Record<string, string>; title?: string }>();

const {
  data: verdict,
  pending,
  error,
  refresh,
} = await useAnalyticsWidget<AnalyticsVerdict>('verdict', () => props.query);

const sentence = computed(() =>
  verdict.value ? sentencesFor('en').verdict(verdict.value.facts, metricFormatter()) : '',
);

/** The tone dot: the pass-rate scale's good, fair and poor colors. */
const TONE_DOT: Record<VerdictTone, string> = {
  good: PASS_RATE_TONES.good.bg,
  mixed: PASS_RATE_TONES.fair.bg,
  bad: PASS_RATE_TONES.poor.bg,
};
const TONE_LABEL: Record<VerdictTone, string> = { good: 'Good', mixed: 'Mixed', bad: 'Bad' };
</script>

<template>
  <SectionCard
    icon="i-lucide-scale"
    :title="title ?? 'Verdict'"
    help="analytics.verdict"
    data-tour="analytics-verdict"
    data-shot="analytics-verdict"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" :text="`Couldn't load the verdict: ${errorMessage(error)}`">
      <template #action>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">
          Retry
        </UButton>
      </template>
    </ErrorState>
    <div v-else-if="verdict" class="flex items-start gap-3">
      <span
        class="mt-1.5 size-2.5 shrink-0 rounded-full"
        :class="TONE_DOT[verdict.tone]"
        :title="TONE_LABEL[verdict.tone]"
        role="img"
        :aria-label="`Verdict: ${TONE_LABEL[verdict.tone]}`"
      />
      <p class="text-sm text-highlighted leading-relaxed" data-testid="verdict-sentence">{{ sentence }}</p>
    </div>
  </SectionCard>
</template>
