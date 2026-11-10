<script setup lang="ts">
/**
 * Project settings → Integrations → Keys in test tags: the patterns that read an issue key (the bug a failure is
 * tracked in) and a test case key (the case a test covers) out of a test's tags. Each is a regular expression tested
 * against a tag without its `@`; an empty field turns it off. When both are on, the tags of the last complete run that
 * both patterns match are listed, each with a test that carries it.
 */
import { validateTagKeyPattern } from '#shared/integrations/tag-keys';
import type { TagKeyOverlapReport } from '#shared/handlers/tag-key-overlap';
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const stored = () => ({
  issue: props.project.tagKeys?.issue ?? '',
  testCase: props.project.tagKeys?.testCase ?? '',
});
const { state, dirty } = useStoredForm(stored);
const { saving, save } = useProjectPatch(() => props.project.id);

function problem(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const check = validateTagKeyPattern(value);
  return check.ok ? undefined : check.message;
}
const issueError = computed(() => problem(state.value.issue));
const testCaseError = computed(() => problem(state.value.testCase));

async function submit() {
  if (issueError.value || testCaseError.value) return;
  const saved = await save(
    {
      tagKeys: {
        issue: state.value.issue.trim() ? state.value.issue : null,
        testCase: state.value.testCase.trim() ? state.value.testCase : null,
      },
    },
    'Tag key patterns saved',
  );
  if (saved) emit('saved');
}

const bothOn = computed(() => !!props.project.tagKeys?.issue && !!props.project.tagKeys?.testCase);
const report = ref<TagKeyOverlapReport | null>(null);
const loading = ref(false);
const failure = ref<string | null>(null);

async function loadOverlaps() {
  report.value = null;
  failure.value = null;
  if (!bothOn.value) return;
  loading.value = true;
  try {
    report.value = await $fetch<TagKeyOverlapReport>(`/api/projects/${props.project.id}/tag-key-overlaps`);
  } catch (error) {
    failure.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}
watch(() => JSON.stringify(props.project.tagKeys ?? null), loadOverlaps, { immediate: true });
const overlaps = computed(() => report.value?.overlaps ?? []);
</script>

<template>
  <UForm :state="state" @submit="submit">
    <SectionCard
      icon="i-lucide-tags"
      title="Keys in test tags"
      subtitle="The patterns that read an issue key and a test case key out of a test’s tags"
      help="project.tag-keys"
      data-shot="project-tag-keys-settings"
    >
      <div class="space-y-5">
        <UFormField
          label="Issue key"
          name="issue"
          :error="issueError"
          description="A tag naming the issue a test is tracked in. Tested without its @; leave empty to turn it off."
        >
          <UInput
            v-model="state.issue"
            class="w-full font-mono"
            placeholder="^[A-Z][A-Z0-9]+-[0-9]+$"
            aria-label="Issue key pattern"
            data-testid="tag-keys-issue"
          />
        </UFormField>

        <UFormField
          label="Test case key"
          name="testCase"
          :error="testCaseError"
          description="A tag naming the test case a test covers. Tested without its @; leave empty to turn it off."
        >
          <UInput
            v-model="state.testCase"
            class="w-full font-mono"
            placeholder="^SHOP-T[0-9]+$"
            aria-label="Test case key pattern"
            data-testid="tag-keys-test-case"
          />
        </UFormField>

        <div v-if="bothOn" role="status" aria-live="polite" data-testid="tag-keys-overlaps">
          <p v-if="loading" class="text-sm text-muted">Reading the last complete run’s tags…</p>
          <UAlert
            v-else-if="failure"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            title="Couldn’t read the last run’s tags"
            :description="failure"
          />
          <p v-else-if="report && report.runId === null" class="text-sm text-muted">
            No complete run yet, so there are no tags to check the patterns against.
          </p>
          <p v-else-if="!overlaps.length" class="text-sm text-muted">
            No tag of the last complete run matches both patterns.
          </p>
          <UAlert
            v-else
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Both patterns match these tags"
          >
            <template #description>
              <p>
                A tag both patterns match is read as an issue and as a test case. Anchor the patterns so each tag has
                one meaning.
              </p>
              <ul class="mt-2 space-y-1">
                <li v-for="overlap in overlaps" :key="overlap.tag" class="text-sm">
                  <code class="font-mono">{{ overlap.tag }}</code>
                  <span class="text-muted"> on {{ overlap.testTitle }}</span>
                </li>
              </ul>
            </template>
          </UAlert>
        </div>
      </div>

      <template #footer>
        <div class="flex flex-wrap justify-end gap-2">
          <UButton
            type="submit"
            icon="i-lucide-check"
            :loading="saving"
            :disabled="!dirty || !!issueError || !!testCaseError"
          >
            Save changes
          </UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>
