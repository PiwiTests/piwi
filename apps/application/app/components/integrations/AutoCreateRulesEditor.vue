<script setup lang="ts">
/**
 * The automatic-creation rules of the tracker binding form, in order: each a
 * run scope, test tags, its three thresholds and extra labels, with the rule in
 * words under it. The first rule a failure meets files it.
 */
import { MAX_AUTO_CREATE_RULES, describeAutoCreateRule } from '#shared/integrations/automation';
import { autoCreateRuleFromForm, newAutoCreateRuleForm, type AutoCreateRuleForm } from '~/utils/tracker-binding-form';

const rules = defineModel<AutoCreateRuleForm[]>({ required: true });
defineProps<{
  /** The project whose environments each rule's scope picks from. */
  projectId: number;
}>();

function addRule() {
  rules.value.push(newAutoCreateRuleForm());
}
function removeRule(index: number) {
  rules.value.splice(index, 1);
}
</script>

<template>
  <div class="space-y-3">
    <p v-if="rules.length === 0" class="text-sm text-muted">No rule: nothing is filed automatically.</p>
    <div
      v-for="(rule, i) in rules"
      :key="i"
      class="rounded-lg border border-default p-3 space-y-3"
      :data-shot="`auto-create-rule-${i + 1}`"
    >
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm font-semibold text-highlighted">Rule {{ i + 1 }}</p>
        <UButton
          icon="i-lucide-trash-2"
          size="xs"
          color="neutral"
          variant="ghost"
          :title="`Remove rule ${i + 1}`"
          @click="removeRule(i)"
        />
      </div>
      <TrackerRunScopeFields v-model="rules[i]!" :project-id="projectId" hide-summary />
      <div class="grid gap-3 grid-cols-3">
        <UFormField label="Occurrences">
          <UInput v-model.number="rule.minOccurrences" type="number" min="1" class="w-full" />
        </UFormField>
        <UFormField label="Runs">
          <UInput v-model.number="rule.minRuns" type="number" min="1" class="w-full" />
        </UFormField>
        <UFormField label="Days">
          <UInput v-model.number="rule.minDays" type="number" min="0" class="w-full" />
        </UFormField>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <UFormField label="Test tags">
          <UInput v-model="rule.tags" placeholder="@critical, @smoke" class="w-full" />
        </UFormField>
        <UFormField label="Extra labels">
          <UInput v-model="rule.labels" placeholder="e2e-auto" class="w-full" />
        </UFormField>
      </div>
      <p class="text-xs text-muted">{{ describeAutoCreateRule(autoCreateRuleFromForm(rule)) }}.</p>
    </div>
    <UButton
      label="Add rule"
      icon="i-lucide-plus"
      size="xs"
      variant="outline"
      color="neutral"
      :disabled="rules.length >= MAX_AUTO_CREATE_RULES"
      @click="addRule"
    />
  </div>
</template>
