<script setup lang="ts">
/**
 * A report's steps in words, the way the reporter took them. A step marked as
 * wrong shows what should have happened, what the page showed and the note.
 */
import { describeExpectationInParts, describeStepInParts } from '@piwitests/core/bug-report';
import type { PiwiSteps } from '@piwitests/core/steps';

const props = defineProps<{ steps: PiwiSteps }>();

const rows = computed(() =>
  props.steps.steps.map((step, index) => ({
    index,
    parts: step.action === 'assert' ? describeExpectationInParts(step) : describeStepInParts(step),
    marked: step.action === 'assert' && !!step.assertion,
    actual: step.assertion?.actual ?? null,
    note: step.assertion?.note ?? null,
    redacted: step.redacted,
  })),
);
</script>

<template>
  <ol class="space-y-2" data-shot="bug-report-steps">
    <li v-for="row in rows" :key="row.index" class="flex gap-3">
      <span class="w-6 shrink-0 text-right text-xs text-muted tabular-nums pt-0.5">{{ row.index + 1 }}</span>
      <div class="min-w-0 flex-1 text-sm text-default leading-relaxed break-words">
        <p>
          <span v-if="row.marked" class="font-semibold text-highlighted">Expected: </span
          ><BugStepText :parts="row.parts" />
          <span v-if="row.redacted" class="text-xs text-muted">(value not recorded)</span>
        </p>
        <p v-if="row.marked && row.actual != null" class="text-xs text-muted">The page showed "{{ row.actual }}"</p>
        <p v-if="row.note" class="text-xs text-muted">“{{ row.note }}”</p>
      </div>
    </li>
  </ol>
</template>
