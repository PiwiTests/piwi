<script setup lang="ts">
/**
 * **Debug in my editor**, beside the failing line's open link: the IDE the
 * visitor picked (`useOpenInIde`) opens that line through Piwi's own client,
 * the JetBrains plugin or the VS Code extension, then offers to run the test
 * there, headed, one worker, stopping at that line, with the healing's
 * suggested locator outlined on the page. The IDE asks before it runs
 * anything. Once asked, the button follows the run by the name the page gave
 * it (`DebugAsked.ref`): "Following run #81 in VS Code · Open" once the run
 * reaches the instance, "No run from VS Code reached Piwi" after ten
 * minutes. Below `sm` it is hidden, as the open link's chooser is: a phone
 * reaches no editor.
 */
import type { DebugAsked, DebugInIdeTarget } from '~/composables/useOpenInIde';

const props = defineProps<{
  /** The failing line and the test to run there (`debugTargetOf`), with the Piwi project. */
  target: DebugInIdeTarget;
}>();

/** How often the run is looked for, and for how long once asked: the editor asks the person first. */
const LOOK_MS = 3000;
const LOOK_FOR_MS = 10 * 60_000;

const { debugInIde } = useOpenInIde();
const where = computed(() => `${props.target.filePath}:${props.target.line}`);
/** What the last click asked, and the run the editor started under its name once it reached the instance. */
const asked = ref<(DebugAsked & { at: number }) | null>(null);
const runId = ref<number | null>(null);
const projectId = computed(() => {
  const id = Number(props.target.projectKey);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
});

/** Whether the run was looked for `LOOK_FOR_MS` without being found. */
const lost = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
let unmounted = false;
function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Looks for the run the editor started under the page's name, until it is found or `LOOK_FOR_MS` passed. */
async function look() {
  timer = null;
  const now = asked.value;
  if (!now || projectId.value === null || runId.value !== null) return;
  const query = new URLSearchParams({ origin: 'editor', ref: now.ref });
  const found = await $fetch<{ id: number } | null>(`/api/projects/${projectId.value}/latest-run?${query}`).catch(
    () => null,
  );
  // Another click, or the button gone, ends this look: its answer belongs to no run shown.
  if (unmounted || asked.value !== now) return;
  if (found?.id) {
    runId.value = found.id;
    return;
  }
  if (Date.now() - now.at < LOOK_FOR_MS) timer = setTimeout(() => void look(), LOOK_MS);
  else lost.value = true;
}

async function debug() {
  stop();
  asked.value = null;
  runId.value = null;
  lost.value = false;
  const answer = await debugInIde(props.target);
  if (unmounted) return;
  asked.value = answer ? { ...answer, at: Date.now() } : null;
  if (answer) void look();
}

onBeforeUnmount(() => {
  unmounted = true;
  stop();
});
</script>

<template>
  <span class="max-sm:hidden inline-flex items-center gap-2 shrink-0">
    <UButton
      size="xs"
      variant="ghost"
      color="neutral"
      label="Debug in my editor"
      :title="`Open ${where} in your editor, which offers to run this test there: headed, one worker, stopping at that line`"
      data-shot="debug-in-editor"
      @click="debug"
    />
    <span v-if="asked && projectId !== null" class="text-xs text-muted" data-testid="debug-following">
      <template v-if="runId !== null">
        Following run #{{ runId }} in {{ asked.ide }} ·
        <NuxtLink
          :to="`/test-runs/${runId}`"
          class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
          :aria-label="`Open run #${runId}`"
          >Open</NuxtLink
        >
      </template>
      <template v-else-if="lost">No run from {{ asked.ide }} reached Piwi</template>
      <template v-else>Waiting for {{ asked.ide }} to run the test…</template>
    </span>
  </span>
</template>
