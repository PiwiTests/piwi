<script setup lang="ts">
/**
 * Project settings → General: the read-only project key, then the label,
 * description and tags shared with the create form, and the link from a test's
 * external ID to the team's test management tool.
 */
import type { ProjectWithTestRuns, TagsResponse } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns }>();
const emit = defineEmits<{ saved: [] }>();

const { data: tagsData, refresh: refreshTags } = await useFetch<TagsResponse>('/api/tags');
const allTags = computed(() => tagsData.value?.items || []);

const { state, dirty } = useStoredForm(() => ({
  label: props.project.label || '',
  description: props.project.description || '',
  tags: props.project.tags || [],
  externalIdUrl: props.project.externalIdUrl || '',
}));

const { saving, save } = useProjectPatch(() => props.project.id);

async function submit() {
  const stored = await save(
    {
      label: state.value.label || null,
      description: state.value.description || null,
      tagIds: state.value.tags.map((t) => t.id),
      externalIdUrl: state.value.externalIdUrl.trim() || null,
    },
    'Project updated',
  );
  if (stored) emit('saved');
}
</script>

<template>
  <UForm :state="state" @submit="submit">
    <SectionCard icon="i-lucide-settings" title="General" subtitle="How this project is named and grouped">
      <div class="space-y-5">
        <UFormField label="Project key" description="Matches the results the reporter sends; it cannot be changed.">
          <p class="font-mono text-sm text-highlighted break-all">{{ project.name }}</p>
        </UFormField>
        <ProjectFormFields
          v-model:label="state.label"
          v-model:description="state.description"
          v-model:tags="state.tags"
          mode="edit"
          :all-tags="allTags"
          @tag-created="refreshTags()"
        />
        <UFormField
          label="Test ID link"
          name="externalIdUrl"
          description="Where a test's external ID opens in your test management tool: an http(s) URL holding {id}, which the ID replaces. Leave empty for no link."
        >
          <UInput
            v-model="state.externalIdUrl"
            placeholder="https://tcm.example.com/case/{id}"
            class="w-full"
            data-testid="project-external-id-url"
          />
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
