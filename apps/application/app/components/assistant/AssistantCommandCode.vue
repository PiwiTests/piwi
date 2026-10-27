<script setup lang="ts">
/**
 * A shell command of an answer: with the Linux / macOS ↔ Windows toggle when
 * the answer gives a PowerShell form, as a plain bash block otherwise.
 */
import type { AssistantCommand } from '#shared/assistant';

defineProps<{ command: AssistantCommand }>();
</script>

<template>
  <PlatformCodeBlock
    v-if="command.powershell"
    :bash="command.bash"
    :powershell="command.powershell"
    storage-key="piwi-assistant-shell"
  />
  <CodeBlock v-else :code="command.bash" lang="bash" />
</template>
