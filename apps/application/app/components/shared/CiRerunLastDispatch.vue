<script setup lang="ts">
/**
 * A failure page's line about its cluster's last CI re-run: what it re-ran,
 * where it was dispatched, when and by whom, and a link to it in CI (the
 * build the run recorded, once it finished; before, what the CI answered).
 */
import { safeHttpUrl } from '#shared/utils/safe-url';
import { lastRerunScope, rerunDispatchTarget, type RerunInfo } from '~/composables/useCiRerun';

const props = defineProps<{ dispatch: NonNullable<RerunInfo['lastDispatch']> }>();

const link = computed(() => safeHttpUrl(props.dispatch.url));
</script>

<template>
  <span class="text-xs text-muted" data-testid="ci-rerun-last-dispatch">
    Last re-run{{ lastRerunScope(dispatch) }}, dispatched to {{ rerunDispatchTarget(dispatch) }}
    {{ formatRelativeTime(dispatch.at) }}
    <template v-if="dispatch.byName">by {{ dispatch.byName }}</template>
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
  </span>
</template>
