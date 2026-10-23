<script setup lang="ts">
/**
 * Project settings → Source control: the repository, its token and default branch,
 * whether quarantined failures fail the commit status, whether the gate verdict
 * gets a commit status of its own, the CI re-run target per
 * provider with its optional Flake Lab target, and where the specs generated from bug reports go. The token is write-only: a blank field keeps the stored one.
 */
import type { ProjectWithTestRuns } from '~~/types/api';

const props = defineProps<{ project: ProjectWithTestRuns; showGeneratedSpecs: boolean }>();
const emit = defineEmits<{ saved: [] }>();

const { state, dirty } = useStoredForm(() => {
  const ci = props.project.ciRerun;
  return {
    repositoryUrl: props.project.repositoryUrl || '',
    defaultBranch: props.project.defaultBranch || '',
    quarantineFailsStatus: props.project.quarantineFailsStatus === true,
    gateStatus: props.project.gateStatus === true,
    ciRerun: {
      enabled: ci?.enabled ?? false,
      github: {
        workflow: ci?.github?.workflow ?? '',
        ref: ci?.github?.ref ?? '',
        inputName: ci?.github?.inputName ?? '',
        dispatchIdInput: ci?.github?.dispatchIdInput ?? '',
      },
      gitlab: { ref: ci?.gitlab?.ref ?? '', variableName: ci?.gitlab?.variableName ?? '' },
      bitbucket: { pipeline: ci?.bitbucket?.pipeline ?? '', variableName: ci?.bitbucket?.variableName ?? '' },
      flakeLab: {
        github: {
          workflow: ci?.flakeLab?.github?.workflow ?? '',
          inputName: ci?.flakeLab?.github?.inputName ?? '',
        },
        gitlab: { variableName: ci?.flakeLab?.gitlab?.variableName ?? '' },
        bitbucket: {
          pipeline: ci?.flakeLab?.bitbucket?.pipeline ?? '',
          variableName: ci?.flakeLab?.bitbucket?.variableName ?? '',
        },
      },
    },
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
      ciRerun: state.value.ciRerun,
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

        <UFormField
          label="Commit status"
          name="quarantineFailsStatus"
          description="The run's commit status stays green when only quarantined tests failed, and counts them. Turn this on to fail it on any failure."
        >
          <USwitch v-model="state.quarantineFailsStatus" label="Quarantined failures fail the commit status" />
        </UFormField>

        <UFormField
          label="Gate status"
          name="gateStatus"
          description="Post each piwi gate verdict as its own commit status, beside the run's, so a branch rule can require it. Needs pull-request feedback with commit statuses on."
        >
          <USwitch v-model="state.gateStatus" label="Post the gate verdict as a commit status" />
        </UFormField>

        <UFormField
          name="ciRerun"
          data-tour="project-ci-rerun"
          description="Let reporters and admins re-run a cluster's affected tests in CI from its page, using the SCM token above. Off by default; fill in the block for your provider."
        >
          <template #label>
            <span class="inline-flex items-center gap-1">CI re-run <HelpHint topic="project.ci-rerun" /></span>
          </template>
          <div class="space-y-3">
            <USwitch v-model="state.ciRerun.enabled" label="Enable re-run from the dashboard" />
            <div v-if="state.ciRerun.enabled" class="space-y-4 rounded-md border border-default p-3">
              <div class="space-y-2">
                <p class="text-xs text-muted">GitHub — workflow_dispatch</p>
                <div class="grid gap-2 sm:grid-cols-3">
                  <UInput
                    v-model="state.ciRerun.github.workflow"
                    placeholder="workflow file, e.g. e2e.yml"
                    aria-label="GitHub workflow file"
                    class="font-mono"
                  />
                  <UInput
                    v-model="state.ciRerun.github.ref"
                    placeholder="ref, e.g. main"
                    aria-label="GitHub ref"
                    class="font-mono"
                  />
                  <UInput
                    v-model="state.ciRerun.github.inputName"
                    placeholder="input name, e.g. args"
                    aria-label="GitHub input name"
                    class="font-mono"
                  />
                </div>
                <UInput
                  v-model="state.ciRerun.github.dispatchIdInput"
                  placeholder="dispatch id input (optional), e.g. piwi_dispatch"
                  aria-label="GitHub dispatch id input"
                  class="font-mono w-full sm:max-w-xs"
                />
              </div>
              <div class="space-y-2">
                <p class="text-xs text-muted">GitLab — pipeline</p>
                <div class="grid gap-2 sm:grid-cols-2">
                  <UInput
                    v-model="state.ciRerun.gitlab.ref"
                    placeholder="ref, e.g. main"
                    aria-label="GitLab ref"
                    class="font-mono"
                  />
                  <UInput
                    v-model="state.ciRerun.gitlab.variableName"
                    placeholder="variable name, e.g. PW_ARGS"
                    aria-label="GitLab variable name"
                    class="font-mono"
                  />
                </div>
              </div>
              <div class="space-y-2">
                <p class="text-xs text-muted">Bitbucket — custom pipeline</p>
                <div class="grid gap-2 sm:grid-cols-2">
                  <UInput
                    v-model="state.ciRerun.bitbucket.pipeline"
                    placeholder="custom pipeline name, e.g. rerun"
                    aria-label="Bitbucket custom pipeline"
                    class="font-mono"
                  />
                  <UInput
                    v-model="state.ciRerun.bitbucket.variableName"
                    placeholder="variable name, e.g. PW_ARGS"
                    aria-label="Bitbucket variable name"
                    class="font-mono"
                  />
                </div>
              </div>
              <div class="space-y-2 border-t border-default pt-3" data-testid="ci-rerun-flake-lab">
                <p class="text-sm text-highlighted">Flake Lab (optional)</p>
                <p class="text-xs text-muted">
                  A workflow or pipeline that runs <code class="font-mono">npx @piwitests/reporter</code> with the
                  arguments it receives (<code class="font-mono">flake 12</code>,
                  <code class="font-mono">flake verify 12</code>), so a flaky test's experiment can run in CI from its
                  page. GitHub and GitLab use the ref above.
                </p>
                <div class="grid gap-2 sm:grid-cols-2">
                  <UInput
                    v-model="state.ciRerun.flakeLab.github.workflow"
                    placeholder="GitHub workflow, e.g. flake.yml"
                    aria-label="Flake Lab GitHub workflow file"
                    class="font-mono"
                  />
                  <UInput
                    v-model="state.ciRerun.flakeLab.github.inputName"
                    placeholder="input name, e.g. piwi_flake"
                    aria-label="Flake Lab GitHub input name"
                    class="font-mono"
                  />
                  <UInput
                    v-model="state.ciRerun.flakeLab.gitlab.variableName"
                    placeholder="GitLab variable, e.g. FLAKE_ARGS"
                    aria-label="Flake Lab GitLab variable name"
                    class="font-mono"
                  />
                  <div class="hidden sm:block" />
                  <UInput
                    v-model="state.ciRerun.flakeLab.bitbucket.pipeline"
                    placeholder="Bitbucket custom pipeline, e.g. flake"
                    aria-label="Flake Lab Bitbucket custom pipeline"
                    class="font-mono"
                  />
                  <UInput
                    v-model="state.ciRerun.flakeLab.bitbucket.variableName"
                    placeholder="variable name, e.g. FLAKE_ARGS"
                    aria-label="Flake Lab Bitbucket variable name"
                    class="font-mono"
                  />
                </div>
              </div>
            </div>
          </div>
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
