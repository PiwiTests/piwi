<script setup lang="ts">
/**
 * Picks the SCM credential something of a project carries: the project's
 * repository calls, or a GitHub, GitLab or Bitbucket CI action's dispatch. It
 * lists the source control credentials shared with the project whose
 * destination holds the repository's API (or, before the project has a
 * repository, the ones for its host), and creates one for it (New credential,
 * shared with the project and sent to the host's API). With none picked, the
 * fallback `noneLabel` names applies.
 */
import type { CredentialOption, CredentialSummary } from '#shared/credentials';
import { isUnderBaseUrl } from '#shared/ci-server';
import { SCM_API_DESTINATIONS, scmDestinationHost, scmRepositoryApiUrl, type ScmProviderName } from '#shared/scm-urls';
import type { ApiResponse } from '~~/types/api';

const props = defineProps<{
  projectId: number;
  /** The repository host, whose API the credential must be sent to; null lists every SCM credential. */
  host: ScmProviderName | null;
  /** The project's repository, whose API URL the credential's destination must hold; null before it has one. */
  repositoryUrl?: string | null;
  /** The destination a new credential starts with: the API of the project's repository host. */
  destination?: string | null;
  /** What applies with none picked: the instance's credentials, or the project's. */
  noneLabel: string;
  /** The picker's accessible name. */
  label: string;
  /** Whether it lists per-user credentials, which only a CI action names. */
  perUser?: boolean;
}>();
const model = defineModel<number | null>({ required: true });

type CredentialsAnswer = ApiResponse<typeof import('~~/server/api/credentials/index.get').default>;
const { data, refresh, status } = useFetch<CredentialsAnswer>('/api/credentials', {
  key: `scm-credentials-${props.projectId}`,
  query: { projectId: props.projectId, service: 'scm' },
  server: false,
});
const listedOk = computed(() => status.value === 'success');
const canEncrypt = computed(() => data.value?.canEncrypt ?? true);

/** The host a destination is for; a destination on another host is a GitLab of `PIWI_SCM_GITLAB_HOSTS`. */
const hostOf = (destination: string): ScmProviderName => scmDestinationHost(destination) ?? 'gitlab';
const apiUrl = computed(() => scmRepositoryApiUrl(props.repositoryUrl));
/** Whether a credential would go with the repository's calls. */
const fits = (c: { destination: string }) =>
  apiUrl.value ? isUnderBaseUrl(c.destination, apiUrl.value) : !props.host || hostOf(c.destination) === props.host;
const credentials = computed(() =>
  ((data.value?.credentials ?? []) as CredentialOption[]).filter((c) => fits(c) && (props.perUser || !c.perUser)),
);
const chosen = computed(() => credentials.value.find((c) => c.id === model.value) ?? null);

const NONE = -1;
const items = computed(() => [
  { label: props.noneLabel, value: NONE },
  ...credentials.value.map((c) => ({
    label: c.disabled ? `${c.name} (disabled)` : c.name,
    value: c.id,
    description: c.perUser ? `In the name of whoever starts it · ${c.destination}` : c.destination,
  })),
  // The credential named, while it is not among them: named, so the select never shows a bare id.
  ...(model.value !== null && !chosen.value
    ? [{ label: listedOk.value ? 'A credential that does not fit' : 'Reading the credentials…', value: model.value }]
    : []),
]);
const value = computed({
  get: () => model.value ?? NONE,
  set: (picked: number) => {
    model.value = picked === NONE ? null : picked;
  },
});

const description = computed(() => {
  if (model.value === null) return null;
  if (!listedOk.value) {
    return status.value === 'error'
      ? 'The credentials shared with this project could not be read.'
      : 'Reading the credentials shared with this project…';
  }
  const credential = chosen.value;
  if (!credential) {
    return 'The credential named is not shared with this project, or is not sent to this repository’s API: pick another one.';
  }
  if (credential.disabled) return `“${credential.name}” is disabled: every call goes without it until it is enabled.`;
  if (credential.secretEnvSet === false) {
    return `“${credential.name}” reads its secret from ${credential.secretEnv}, which is not set on the server.`;
  }
  return `“${credential.name}” is sent to ${credential.destination}, and each use is logged.`;
});

const creating = ref(false);
const newDestination = computed(() => props.destination ?? (props.host ? SCM_API_DESTINATIONS[props.host] : null));

const toast = useToast();
async function created(credential: CredentialSummary) {
  await refresh();
  const shared = credential.scope.allProjects || credential.scope.projectIds.includes(props.projectId);
  if (shared && fits(credential)) {
    model.value = credential.id;
    return;
  }
  toast.add({
    title: 'Not picked',
    description: `“${credential.name}” is saved, but it is not shared with this project or not sent to this repository’s API.`,
    color: 'neutral',
  });
}
</script>

<template>
  <div class="space-y-1" data-testid="scm-credential-picker">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <USelect v-model="value" :items="items" :aria-label="label" class="w-full sm:max-w-sm" />
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-key-round"
        :disabled="!canEncrypt"
        :title="canEncrypt ? undefined : 'Set PIWI_SECRET_KEY on the server to save a credential'"
        data-testid="scm-credential-new"
        @click="creating = true"
      >
        New credential
      </UButton>
    </div>
    <p v-if="description" class="text-xs text-muted" data-testid="scm-credential-description">{{ description }}</p>
    <CredentialFormModal
      v-model:open="creating"
      :credential="null"
      service="scm"
      :project-id="projectId"
      :destination="newDestination"
      @saved="created"
    />
  </div>
</template>
