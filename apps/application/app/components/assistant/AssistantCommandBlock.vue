<script setup lang="ts">
/** A shell command of an answer, in bash and, when it differs, PowerShell. */
import type { AssistantCommand } from '#shared/assistant';

defineProps<{ command: AssistantCommand; title?: string }>();
</script>

<template>
  <div class="space-y-1.5 min-w-0" data-assistant-block="command">
    <p v-if="title" class="text-sm font-semibold text-highlighted">{{ title }}</p>
    <AssistantCommandCode :command="command" />
  </div>
</template>
