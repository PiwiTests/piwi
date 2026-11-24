<script setup lang="ts">
/**
 * What was sent and where it stands, for a run request to one of the person's apps or a CI dispatch alike: its dot
 * and sentence, what it runs, where and by whom, the CI's page for it, and the run it started with that run's result.
 * A dispatch whose run has not reported after a while lists the likely causes. With `line`, one line in the meta
 * style headed by it, as a failure page's "Last re-run" reads.
 */
import { safeHttpUrl } from '#shared/utils/safe-url';
import { runFollowUpFacts, type RunFollowUpView } from '#shared/run-follow-up';

const props = defineProps<{
  followUp: RunFollowUpView;
  /** One line headed by this, in the meta style. */
  line?: string;
  /** Tests a request left out: no recorded line, or a path the request refuses. */
  skipped?: number;
  error?: string | null;
}>();

const ciLink = computed(() => safeHttpUrl(props.followUp.ciUrl));
const testCount = (n: number) => `${n} test${n === 1 ? '' : 's'}`;
/** What it runs, through what and on which branch, without the time, which renders in the browser. */
const facts = computed(() => runFollowUpFacts(props.followUp));
const causesTitle = computed(() => props.followUp.causes.join(' '));
</script>

<template>
  <span v-if="line" class="text-xs text-muted" data-testid="ci-rerun-last-dispatch">
    {{ line }}{{ followUp.tests ? ` of ${testCount(followUp.tests)}` : '' }}, dispatched to {{ followUp.target }}
    <ClientOnly>
      <span :title="prettyDateFormat(followUp.at)">{{ formatRelativeTime(followUp.at) }}</span>
      <template #fallback>{{ formatRelativeTime(followUp.at) }}</template>
    </ClientOnly>
    <template v-if="followUp.by"> by {{ followUp.by }}</template>
    <template v-if="ciLink">
      · <a :href="ciLink" target="_blank" rel="noopener noreferrer" :class="SENTENCE_LINK_CLASS">Open in CI</a>
    </template>
    <template v-if="followUp.run">
      ·
      <NuxtLink :to="`/test-runs/${followUp.run.id}`" :class="SENTENCE_LINK_CLASS" data-testid="ci-rerun-last-run"
        >run #{{ followUp.run.id }}</NuxtLink
      >
      {{ followUp.run.result }}
    </template>
    <span v-else-if="followUp.causes.length" :title="causesTitle">
      · {{ followUp.final ? 'no run reported' : 'no run reported yet' }}</span
    >
  </span>

  <div v-else class="space-y-3" data-shot="run-follow-up">
    <div class="flex items-start gap-2">
      <span :class="['size-2.5 rounded-full mt-1.5 shrink-0', STATUS_PALETTE[followUp.status].bg]" aria-hidden="true" />
      <p class="text-sm text-highlighted leading-relaxed break-words" data-testid="run-follow-up-state">
        {{ followUp.sentence }}
      </p>
    </div>
    <p class="text-xs text-muted break-words">
      {{ facts }}
      <template v-if="followUp.kind === 'dispatch'">
        · sent
        <ClientOnly>
          <span :title="prettyDateFormat(followUp.at)">{{ formatRelativeTime(followUp.at) }}</span>
          <template #fallback>{{ formatRelativeTime(followUp.at) }}</template>
        </ClientOnly>
        <template v-if="followUp.by"> by {{ followUp.by }}</template>
      </template>
      <template v-if="skipped"> · {{ skipped }} left out: no recorded line, or a path the request refuses</template>
    </p>
    <p v-if="followUp.kind === 'request' && followUp.run" class="text-sm text-highlighted">
      The run reports here, and only you see it:
      <NuxtLink :to="`/test-runs/${followUp.run.id}`" :class="SENTENCE_LINK_CLASS"
        >open run #{{ followUp.run.id }}</NuxtLink
      >
    </p>
    <div v-else-if="followUp.kind === 'dispatch' && (ciLink || followUp.run)" class="flex flex-wrap gap-2">
      <UButton
        v-if="followUp.run"
        size="xs"
        color="neutral"
        variant="outline"
        :to="`/test-runs/${followUp.run.id}`"
        data-testid="run-follow-up-run"
        >Open run #{{ followUp.run.id }}</UButton
      >
      <UButton
        v-if="ciLink"
        size="xs"
        color="neutral"
        variant="outline"
        trailing-icon="i-lucide-external-link"
        :href="ciLink"
        target="_blank"
        rel="noopener noreferrer"
        >Open in CI</UButton
      >
    </div>
    <div v-if="followUp.causes.length" class="space-y-1" data-testid="run-follow-up-causes">
      <p class="text-sm text-highlighted">
        {{ followUp.final ? 'No run reported.' : 'Matching goes on for six hours.' }} Most likely:
      </p>
      <ul class="list-disc pl-5 text-sm text-highlighted space-y-0.5">
        <li v-for="cause in followUp.causes" :key="cause">{{ cause }}</li>
      </ul>
      <DocLink to="features/ci-rerun#matching-the-run" no-icon :class="['text-xs', SENTENCE_LINK_CLASS]"
        >How a run is matched</DocLink
      >
    </div>
    <p v-if="error" class="text-xs text-error">{{ error }}</p>
  </div>
</template>
