<script setup lang="ts">
/**
 * Project settings → Source control: the repository, the SCM credential its
 * calls carry (Settings → Credentials) and its default branch, whether
 * quarantined failures fail the commit status, whether the gate verdict gets a
 * commit status of its own, and where the specs generated from bug reports go.
 */
import { detectScmHost, scmApiDestination } from '#shared/scm-urls';
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns; showGeneratedSpecs: boolean }>();
const emit = defineEmits<{ saved: [] }>();
const isDesktop = useIsDesktop();

const { state, dirty } = useStoredForm(() => {
  return {
    repositoryUrl: props.project.repositoryUrl || '',
    scmCredentialId: props.project.scmCredentialId ?? null,
    defaultBranch: props.project.defaultBranch || '',
    quarantineFailsStatus: props.project.quarantineFailsStatus === true,
    gateStatus: props.project.gateStatus === true,
    generatedSpecs: {
      bugsFolder: props.project.generatedSpecs?.bugsFolder ?? '',
      testImport: props.project.generatedSpecs?.testImport ?? '',
    },
  };
});
/** The repository's host, whose API the credential is sent to, as the field reads now. */
const host = computed(() => detectScmHost(state.value.repositoryUrl.trim() || props.project.repositoryUrl));
const destination = computed(() => scmApiDestination(state.value.repositoryUrl.trim() || props.project.repositoryUrl));

const { saving, save } = useProjectPatch(() => props.project.id);

async function submit() {
  const stored = await save(
    {
      scmCredentialId: state.value.scmCredentialId,
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
  emit('saved');
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
          description="The repository Piwi reads commits, diffs and source from with the SCM credential. The first run that names one sets it; runs from another repository are left out of every SCM call."
        >
          <UInput
            v-model="state.repositoryUrl"
            placeholder="https://git.example.com/owner/repo"
            class="w-full font-mono"
          />
        </UFormField>

        <FormFieldGroup
          label="Credential"
          help="project.scm-token"
          data-tour="project-scm-token"
          data-shot="project-scm-credential"
          description="The token Piwi reads and writes the repository with, saved once under Settings → Credentials. Without one, the instance’s credential for the repository’s host, from Settings → Source control."
        >
          <ScmCredentialPicker
            v-model="state.scmCredentialId"
            :project-id="project.id"
            :host="host"
            :destination="destination"
            none-label="The instance’s credential"
            label="Repository credential"
          />
        </FormFieldGroup>

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

        <FormFieldGroup
          v-if="showGeneratedSpecs"
          label="Generated specs"
          help="bug-report.spec"
          description="For the failing test Piwi writes from a bug report: where it goes and what it imports test and expect from, such as ../fixtures when your tests use their own."
        >
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
        </FormFieldGroup>
      </div>

      <template #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty"> Save changes </UButton>
        </div>
      </template>
    </SectionCard>
  </UForm>
</template>
