<script setup lang="ts">
/**
 * A failure page's line about its cluster's last CI re-run: what it re-ran,
 * where it was dispatched, when (the full date and time on hover) and by whom, a link to it in CI (the
 * build the run recorded once it started; before, what the CI answered), and the run that answered it with its
 * result, or that none did within the matching window.
 */
import { safeHttpUrl } from '#shared/utils/safe-url';
import { dispatchRunResult, lastRerunScope, rerunDispatchTarget, type RerunInfo } from '~/composables/useCiRerun';

const props = defineProps<{ dispatch: NonNullable<RerunInfo['lastDispatch']> }>();

const link = computed(() => safeHttpUrl(props.dispatch.url));
</script>

<template>
  <span class="text-xs text-muted" data-testid="ci-rerun-last-dispatch">
    Last re-run{{ lastRerunScope(dispatch) }}, dispatched to {{ rerunDispatchTarget(dispatch) }}
    <ClientOnly>
      <span :title="prettyDateFormat(dispatch.at)">{{ formatRelativeTime(dispatch.at) }}</span>
      <template #fallback>{{ formatRelativeTime(dispatch.at) }}</template>
    </ClientOnly>
    <template v-if="dispatch.byName"> by {{ dispatch.byName }}</template>
    <template v-if="link">
      ·
      <a
        :href="link"
        target="_blank"
        rel="noopener noreferrer"
        class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
        >Open in CI</a
      >
    </template>
    <template v-if="dispatch.run">
      ·
      <NuxtLink :to="`/test-runs/${dispatch.run.id}`" :class="SENTENCE_LINK_CLASS" data-testid="ci-rerun-last-run"
        >run #{{ dispatch.run.id }}</NuxtLink
      >
      {{ dispatchRunResult(dispatch.run) }}
    </template>
    <template v-else-if="dispatch.state === 'unreported'"> · no run reported</template>
  </span>
</template>
