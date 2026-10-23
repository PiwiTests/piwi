<script setup lang="ts">
/**
 * Project settings → AI: instructions added to the global ones for this
 * project's diagnoses, and the language its AI prose is written in.
 */
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const { state, dirty } = useStoredForm(() => ({
  diagnosisInstructions: props.project.diagnosisInstructions || '',
  aiLanguage: props.project.aiLanguage || '',
}));

const { saving, save } = useProjectPatch(() => props.project.id);

async function submit() {
  const stored = await save(
    {
      diagnosisInstructions: state.value.diagnosisInstructions || null,
      aiLanguage: state.value.aiLanguage || null,
    },
    'AI settings saved',
  );
  if (stored) emit('saved');
}
</script>

<template>
  <UForm :state="state" @submit="submit">
    <SectionCard icon="i-lucide-sparkles" title="AI diagnosis" subtitle="How the AI reads this project’s failures">
      <div class="space-y-5">
        <UFormField
          name="diagnosisInstructions"
          data-tour="project-ai-instructions"
          description="Combined with the global instructions from Settings → AI."
        >
          <template #label>
            <span class="inline-flex items-center gap-1">
              Instructions <HelpHint topic="project.ai-instructions" />
            </span>
          </template>
          <UTextarea
            v-model="state.diagnosisInstructions"
            placeholder="e.g. This project tests the payment checkout flow. The backend uses Stripe for payments and the payment API is at /api/v2/payments. Database errors are usually caused by connection pool exhaustion under load."
            :rows="6"
            class="w-full font-mono text-sm"
          />
        </UFormField>

        <UFormField
          name="aiLanguage"
          label="Response language"
          description="Overrides Settings → AI for this project. Blank inherits the instance-wide language. Code, locators, paths and error text stay verbatim."
        >
          <UInput v-model="state.aiLanguage" placeholder="e.g. French" class="w-full sm:max-w-xs" />
        </UFormField>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty">Save changes</UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>
