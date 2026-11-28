<script setup lang="ts">
/**
 * A failure page's line about its last CI re-run, as the follow-up view reads it (`RunFollowUp`): what it re-ran,
 * where it was dispatched, when (the full date and time on hover) and by whom, a link to it in CI, and the run that
 * answered it with its result, or that none did. While the page is open it reads the dispatch again until it is final.
 */
import type { CiDispatchView } from '#shared/ci-dispatches';

const props = defineProps<{ dispatch: CiDispatchView }>();

const { view, follow } = useRunFollowUp();
watch(
  () => props.dispatch,
  (dispatch) => follow({ kind: 'dispatch', view: dispatch }),
  { immediate: true },
);
</script>

<template>
  <RunFollowUp v-if="view" :follow-up="view" line="Last re-run" />
</template>
