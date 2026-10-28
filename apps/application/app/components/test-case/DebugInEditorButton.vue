<script setup lang="ts">
/**
 * **Debug in my editor**, beside the failing line's open link: the IDE the
 * visitor picked (`useOpenInIde`) opens that line through Piwi's own client,
 * the JetBrains plugin or the VS Code extension, then offers to run the test
 * there, headed, one worker, stopping at that line, with the healing's
 * suggested locator outlined on the page. The IDE asks before it runs
 * anything. Below `sm` it is hidden, as the open link's chooser is:
 * a phone reaches no editor.
 */
import type { DebugInIdeTarget } from '~/composables/useOpenInIde';

const props = defineProps<{
  /** The failing line and the test to run there (`debugTargetOf`), with the Piwi project. */
  target: DebugInIdeTarget;
}>();

const { debugInIde } = useOpenInIde();
const where = computed(() => `${props.target.filePath}:${props.target.line}`);
</script>

<template>
  <UButton
    size="xs"
    variant="ghost"
    color="neutral"
    label="Debug in my editor"
    :title="`Open ${where} in your editor, which offers to run this test there: headed, one worker, stopping at that line`"
    class="max-sm:hidden shrink-0"
    data-shot="debug-in-editor"
    @click="debugInIde(target)"
  />
</template>
