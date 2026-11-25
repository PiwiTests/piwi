<script setup lang="ts">
/**
 * Settings → Source control: the instance's SCM credentials, which every
 * project without its own reads its repository with (the commits behind a
 * failure, uncovered changes, ownership) and writes to it with (pull-request
 * feedback, auto-heal, re-runs in CI). For each repository, the one whose
 * destination holds the repository's API applies, the narrowest first. Only a
 * credential of Settings → Credentials shared with all projects can be listed.
 * Saved alone through the AI settings endpoint.
 */
import type { CredentialSummary } from '#shared/credentials';
import type { AiSettings, ApiResponse } from '~~/types/api';

type CredentialsAnswer = ApiResponse<typeof import('~~/server/api/credentials/index.get').default>;

const toast = useToast();
const { data: settings, refresh } = await useFetch<AiSettings>('/api/settings/ai');
const {
  data: listed,
  refresh: refreshList,
  status: listStatus,
} = await useFetch<CredentialsAnswer>('/api/credentials');

/** The credentials the instance may list: source control, set in the database, shared with all projects. */
const candidates = computed(() =>
  ((listed.value?.credentials ?? []) as CredentialSummary[]).filter(
    (c) => c.service === 'scm' && c.managedBy === 'db' && c.scope.allProjects && !c.perUser,
  ),
);
const items = computed(() => [
  ...candidates.value.map((c) => ({
    label: c.disabled ? `${c.name} (disabled)` : c.name,
    value: c.id,
    description: c.destination,
  })),
  // A listed id the answer does not hold (it could not be read): named, so the menu never shows a bare id.
  ...(settings.value?.scmCredentialIds ?? [])
    .filter((id) => !candidates.value.some((c) => c.id === id))
    .map((id) => ({ label: `Credential ${id}`, value: id, description: 'Not readable here' })),
]);
const canEncrypt = computed(() => listed.value?.canEncrypt ?? true);

const picked = ref<number[]>([]);
watch(
  () => settings.value?.scmCredentialIds,
  (ids) => (picked.value = [...(ids ?? [])]),
  { immediate: true },
);
const dirty = computed(
  () =>
    JSON.stringify([...picked.value].sort()) !== JSON.stringify([...(settings.value?.scmCredentialIds ?? [])].sort()),
);
const saving = ref(false);

async function save() {
  saving.value = true;
  try {
    await $fetch('/api/settings/ai', { method: 'PUT', body: { scmCredentialIds: picked.value } });
    await refresh();
    toast.add({ title: 'Source control saved', color: 'success' });
  } catch (error) {
    toast.add({ title: 'Could not save the credentials', description: errorMessage(error), color: 'error' });
  } finally {
    saving.value = false;
  }
}

const creating = ref(false);
async function created(credential: CredentialSummary) {
  await refreshList();
  if (!credential.scope.allProjects) {
    toast.add({
      title: 'Not listed here',
      description: `“${credential.name}” is not shared with all projects: a project picks it in its Source control settings.`,
      color: 'neutral',
    });
    return;
  }
  if (!picked.value.includes(credential.id)) picked.value = [...picked.value, credential.id];
}
</script>

<template>
  <UForm :state="{ picked }" @submit="save">
    <SectionCard
      icon="i-lucide-git-branch"
      title="Repository access"
      subtitle="The credentials every project without its own reads and writes its repository with."
      data-tour="source-control-token"
      data-shot="source-control-token"
    >
      <SettingsField
        label="SCM credentials"
        help="project.scm-token"
        description="For each repository, the credential sent to its host’s API, the narrowest destination first. Read access lets diagnosis, What changed and uncovered changes read commits and diffs; pull-request feedback, auto-heal and re-runs in CI need write access. A public repository needs none for reading, and a project’s own credential, picked in its Source control settings, goes first."
      >
        <div class="flex flex-col gap-2 sm:flex-row sm:items-start">
          <USelectMenu
            v-model="picked"
            :items="items"
            value-key="value"
            multiple
            placeholder="No credential: public repositories only"
            aria-label="Instance repository credentials"
            class="w-full sm:max-w-md"
          />
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-key-round"
            :disabled="!canEncrypt"
            :title="canEncrypt ? undefined : 'Set PIWI_SECRET_KEY on the server to save a credential'"
            data-testid="source-control-credential-new"
            @click="creating = true"
          >
            New credential
          </UButton>
        </div>
        <ErrorText v-if="listStatus === 'error'" text="The credentials could not be read." class="mt-1" />
        <p class="mt-1 text-xs text-muted">
          Only a credential shared with all projects is listed.
          <NuxtLink to="/settings/credentials" :class="SENTENCE_LINK_CLASS">Settings → Credentials</NuxtLink>
          holds them, and logs each use.
        </p>
      </SettingsField>

      <template #footer>
        <div class="flex justify-end">
          <UButton type="submit" icon="i-lucide-check" :loading="saving" :disabled="!dirty">Save</UButton>
        </div>
      </template>
    </SectionCard>
    <CredentialFormModal
      v-model:open="creating"
      :credential="null"
      service="scm"
      :all-projects="true"
      @saved="created"
    />
  </UForm>
</template>
