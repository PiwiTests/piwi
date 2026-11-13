<script setup lang="ts">
/**
 * Project settings → Source control: the repository, its token and default branch,
 * whether quarantined failures fail the commit status, whether the gate verdict
 * gets a commit status of its own, and where the specs generated from bug
 * reports go. The token is write-only: a blank field keeps the stored one.
 */
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns; showGeneratedSpecs: boolean }>();
const emit = defineEmits<{ saved: [] }>();
const isDesktop = useIsDesktop();

const { state, dirty } = useStoredForm(() => {
  return {
    repositoryUrl: props.project.repositoryUrl || '',
    defaultBranch: props.project.defaultBranch || '',
    quarantineFailsStatus: props.project.quarantineFailsStatus === true,
    gateStatus: props.project.gateStatus === true,
    generatedSpecs: {
      bugsFolder: props.project.generatedSpecs?.bugsFolder ?? '',
      testImport: props.project.generatedSpecs?.testImport ?? '',
    },
  };
});
const scmToken = ref('');
const hasToken = computed(() => Boolean(props.project.hasScmToken));

const { saving, save } = useProjectPatch(() => props.project.id);

async function submit() {
  const stored = await save(
    {
      scmToken: scmToken.value.trim() || undefined,
      repositoryUrl: state.value.repositoryUrl.trim() || null,
      defaultBranch: state.value.defaultBranch || null,
      quarantineFailsStatus: state.value.quarantineFailsStatus,
      gateStatus: state.value.gateStatus,
      generatedSpecs: {
        testImport: state.value.generatedSpecs.testImport.trim() || null,
        bugsFolder: state.value.generatedSpecs.bugsFolder.trim() || null,
      },
    },
    'Source control saved',
  );
  if (!stored) return;
  scmToken.value = '';
  emit('saved');
}

async function removeToken() {
  if (await save({ scmToken: null }, 'SCM token removed')) emit('saved');
}
</script>

<template>
  <UForm :state="state" @submit="submit">
    <SectionCard
      icon="i-lucide-git-branch"
      title="Source control"
      subtitle="The repository behind this project, and what Piwi may run or write in it"
    >
      <div class="space-y-5">
        <UFormField
          label="Repository"
          name="repositoryUrl"
          description="The repository Piwi reads commits, diffs and source from with the SCM token. The first run that names one sets it; runs from another repository are left out of every SCM call."
        >
          <UInput
            v-model="state.repositoryUrl"
            placeholder="https://git.example.com/owner/repo"
            class="w-full font-mono"
          />
        </UFormField>

        <UFormField
          name="scmToken"
          data-tour="project-scm-token"
          :description="
            hasToken
              ? 'Leave empty to keep the stored token, or enter a new value to replace it.'
              : 'For GitHub, GitLab, or Bitbucket. Falls back to the global SCM token if not set.'
          "
        >
          <template #label>
            <span class="inline-flex items-center gap-1">SCM token <HelpHint topic="project.scm-token" /></span>
          </template>
          <UInput
            v-model="scmToken"
            type="password"
            autocomplete="off"
            :placeholder="hasToken ? '•••••••• (unchanged)' : 'ghp_..., glpat-..., or bitbucket token'"
            class="w-full font-mono"
          />
          <UButton
            v-if="hasToken"
            size="xs"
            color="error"
            variant="link"
            class="px-0 mt-1"
            icon="i-lucide-trash-2"
            :disabled="saving"
            @click="removeToken"
          >
            Remove stored token
          </UButton>
        </UFormField>

        <UFormField
          label="Default branch"
          name="defaultBranch"
          description="Baselines, flakiness and trends fall back to this branch. Leave empty to resolve it from the SCM provider (else 'main')."
        >
          <UInput v-model="state.defaultBranch" placeholder="e.g. main" class="w-full sm:max-w-xs font-mono" />
        </UFormField>

        <!-- Both statuses are posted by pull-request feedback, which the desktop build does not offer. -->
        <UFormField
          v-if="!isDesktop"
          label="Commit status"
          name="quarantineFailsStatus"
          description="The run's commit status stays green when only quarantined tests failed, and counts them. Turn this on to fail it on any failure."
        >
          <USwitch v-model="state.quarantineFailsStatus" label="Quarantined failures fail the commit status" />
        </UFormField>

        <UFormField
          v-if="!isDesktop"
          label="Gate status"
          name="gateStatus"
          description="Post each piwi gate verdict as its own commit status, beside the run's, so a branch rule can require it. Needs pull-request feedback with commit statuses on."
        >
          <USwitch v-model="state.gateStatus" label="Post the gate verdict as a commit status" />
        </UFormField>

        <UFormField
          v-if="showGeneratedSpecs"
          name="generatedSpecs"
          description="For the failing test Piwi writes from a bug report: where it goes and what it imports test and expect from, such as ../fixtures when your tests use their own."
        >
          <template #label>
            <span class="inline-flex items-center gap-1">Generated specs <HelpHint topic="bug-report.spec" /></span>
          </template>
          <div class="grid gap-2 sm:grid-cols-2">
            <UInput
              v-model="state.generatedSpecs.bugsFolder"
              placeholder="folder for bug specs, tests/bugs"
              class="font-mono"
              aria-label="Folder for bug specs"
            />
            <UInput
              v-model="state.generatedSpecs.testImport"
              placeholder="test import, @playwright/test"
              class="font-mono"
              aria-label="Test import"
            />
          </div>
        </UFormField>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty && !scmToken.trim()">
            Save changes
          </UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>
