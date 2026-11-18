<script setup lang="ts">
/**
 * Desktop shell only: asks the person to confirm Run again against a protected environment, naming it and what the
 * run is limited to, each time. The Local runs tray mounts it; the store asks (`askToConfirm`) and hears the answer
 * (`answerEnvironmentQuestion`), and the shell runs it only with the key confirmed here.
 */
import { protectedRunScope } from '#shared/desktop-environments';

const store = useDesktopLocalRuns();
const question = store.environmentQuestion;

const open = computed({
  get: () => !!question.value,
  set: (value) => {
    if (!value) store.answerEnvironmentQuestion(false);
  },
});
</script>

<template>
  <UModal
    v-model:open="open"
    :title="question ? `Run again against ${question.name}?` : ''"
    :ui="{ content: 'max-w-md' }"
    data-testid="desktop-environment-question"
  >
    <template #body>
      <p v-if="question" class="text-sm text-highlighted leading-relaxed">
        {{ question.name }} is protected. {{ protectedRunScope(question) }}
      </p>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" @click="store.answerEnvironmentQuestion(false)">Cancel</UButton>
        <UButton icon="i-lucide-lock" @click="store.answerEnvironmentQuestion(true)">
          Run against {{ question?.name }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
