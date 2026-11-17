<script setup lang="ts">
/**
 * Project settings → Run variables: up to 10 environment variables, `NAME=value`, that every run Piwi starts for the
 * project gets (the desktop app's runs, Run on my machine, the editors' runs) and every command it gives to copy
 * starts with. The section checks each name and value with core's rules as they are typed, refuses the names that
 * change which code runs or where results go, and says that a value is never a secret.
 */
import {
  RUN_VARIABLE_LIMITS,
  runVariableNameProblem,
  runVariableValueProblem,
  withRunVariables,
  type RunVariable,
} from '@piwitests/core/run-variables';
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const stored = () => ({ rows: (props.project.runVariables ?? []).map((v) => ({ name: v.name, value: v.value })) });
const { state, dirty } = useStoredForm(stored);
const { saving, save } = useProjectPatch(() => props.project.id);
const { remember } = useProjectRunVariables(() => props.project.id);
const shellKey = COMMAND_SHELL_KEY;

/** The rows to save: those with a name or a value, the name without spaces around it. */
const written = computed<RunVariable[]>(() =>
  state.value.rows
    .map((row) => ({ name: row.name.trim(), value: row.value }))
    .filter((row) => row.name !== '' || row.value !== ''),
);

/** The problem of each row, by its place in the form, or undefined. */
const rowProblems = computed(() => {
  const seen = new Set<string>();
  return state.value.rows.map((row) => {
    const name = row.name.trim();
    if (name === '' && row.value === '') return undefined;
    const problem = runVariableNameProblem(name) ?? runVariableValueProblem(name, row.value);
    if (problem) return problem;
    if (seen.has(name)) return `${name} is set twice.`;
    seen.add(name);
    return undefined;
  });
});
const hasProblem = computed(() => rowProblems.value.some(Boolean));
const full = computed(() => state.value.rows.length >= RUN_VARIABLE_LIMITS.count);

function addRow() {
  if (!full.value) state.value.rows.push({ name: '', value: '' });
}

function removeRow(index: number) {
  state.value.rows.splice(index, 1);
}

const example = computed(() => {
  const variables = written.value.length > 0 ? written.value : [{ name: 'TENANT', value: 'acme' }];
  return {
    bash: withRunVariables('npx playwright test', variables, 'bash'),
    powershell: withRunVariables('npx playwright test', variables, 'powershell'),
  };
});

async function submit() {
  if (hasProblem.value) return;
  const variables = written.value;
  state.value.rows = variables.map((v) => ({ ...v }));
  const saved = await save({ runVariables: variables }, 'Run variables saved');
  if (!saved) return;
  remember(variables);
  emit('saved');
}
</script>

<template>
  <UForm :state="state" @submit="submit">
    <SectionCard
      icon="i-lucide-variable"
      title="Run variables"
      subtitle="Environment variables every run Piwi starts for this project gets"
      help="project.run-variables"
      data-shot="project-run-variables-settings"
    >
      <div class="space-y-4">
        <p class="text-sm text-highlighted leading-relaxed">
          The desktop app's runs, Run on my machine and the editors' runs get them, and every command Piwi gives to copy
          starts with them. They are shown wherever the command is: never put a secret here, keep it in each machine's
          own <code>.env</code>.
        </p>

        <div class="space-y-2" data-testid="run-variables-rows">
          <div v-for="(row, index) in state.rows" :key="index" class="space-y-1">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
              <UInput
                v-model="row.name"
                class="sm:w-56 font-mono"
                placeholder="TENANT"
                :aria-label="`Name of run variable ${index + 1}`"
                autocomplete="off"
                spellcheck="false"
              />
              <span class="hidden text-muted sm:inline" aria-hidden="true">=</span>
              <UInput
                v-model="row.value"
                class="min-w-0 flex-1 font-mono"
                placeholder="acme"
                :aria-label="`Value of run variable ${index + 1}`"
                autocomplete="off"
                spellcheck="false"
              />
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-trash-2"
                :aria-label="`Remove run variable ${index + 1}`"
                class="self-end sm:self-auto"
                @click="removeRow(index)"
              />
            </div>
            <p v-if="rowProblems[index]" class="text-xs text-error" role="alert">{{ rowProblems[index] }}</p>
          </div>
          <p v-if="state.rows.length === 0" class="text-sm text-muted">No run variables: runs get none.</p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <UButton color="neutral" variant="outline" icon="i-lucide-plus" :disabled="full" @click="addRow">
            Add a variable
          </UButton>
          <span class="text-xs text-muted">
            {{ RUN_VARIABLE_LIMITS.count }} at most. Names are capital letters, digits and <code>_</code>; values are
            letters, digits, spaces and <code>_ - . , : / @ + =</code>.
          </span>
        </div>

        <div class="space-y-1">
          <p class="text-sm font-semibold text-highlighted">A copied command</p>
          <PlatformCodeBlock :bash="example.bash" :powershell="example.powershell" :storage-key="shellKey" />
        </div>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty || hasProblem">
            Save changes
          </UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>
