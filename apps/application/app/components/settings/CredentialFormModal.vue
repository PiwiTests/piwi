<script setup lang="ts">
/**
 * Create or change a credential in a modal: its service (when it is created
 * with none given), name, secret, destination and the projects that may use
 * it; for a CI server, the user, the inputs a request carrying it may send,
 * and whether a Custom request may carry it. An SCM credential's destination
 * is a repository host's API, offered as one click per host. The secret is
 * write-only: left empty on a change, the stored one stays, and a new
 * destination asks for it again. An administrator may have it read from a
 * `PIWI_CREDENTIAL_*` variable of the server instead.
 */
import { normalizeCiServerBaseUrl } from '#shared/ci-server';
import {
  CREDENTIAL_SECRET_ENV_PREFIX,
  credentialDestinationProblem,
  isCredentialSecretEnv,
  MAX_CREDENTIAL_DESCRIPTION_LENGTH,
  MAX_CREDENTIAL_NAME_LENGTH,
  CREDENTIAL_SERVICE_LABELS,
  CREDENTIAL_SERVICES,
  type CredentialService,
  type CredentialSummary,
} from '#shared/credentials';
import { SCM_API_DESTINATIONS } from '#shared/scm-urls';
import type { ApiResponse, ProjectMenuItem } from '~~/types/api';

const props = defineProps<{
  /** The credential to change, or null to create one. */
  credential: CredentialSummary | null;
  /** The service of a credential to create; absent, the form asks for it. */
  service?: CredentialService;
  /** The project a credential created from its settings starts shared with. */
  projectId?: number;
  /** The destination a credential to create starts with (the API of a project's repository host). */
  destination?: string | null;
  /** Whether a credential to create starts shared with all projects (the instance's source control). */
  allProjects?: boolean;
}>();
const emit = defineEmits<{ saved: [credential: CredentialSummary] }>();
const open = defineModel<boolean>('open', { default: false });

const { can } = useAuth();
const toast = useToast();
const shareAll = computed(() => can('credentials:manage'));

const { data: menu, execute: loadMenu } = useFetch('/api/projects/menu', {
  immediate: false,
  default: () => [] as ProjectMenuItem[],
  transform: (r: { items: ProjectMenuItem[] }) => r.items,
});
/** The projects the scope may name: every project for an administrator, the ones a Project admin manages. */
const projectItems = computed(() =>
  menu.value
    .filter((p) => can('project:manage', p.id))
    .map((p) => ({ label: p.label || p.name, value: p.id }))
    .sort((a, b) => a.label.localeCompare(b.label)),
);

const blank = () => ({
  service: (props.service ?? 'ci-server') as CredentialService,
  name: '',
  description: '',
  user: '',
  secret: '',
  secretSource: 'saved' as 'saved' | 'env',
  secretEnv: '',
  destination: '',
  allProjects: false,
  projectIds: [] as number[],
  everyInput: true,
  allowedInputs: '',
  customRequests: false,
});
const form = ref(blank());
const saving = ref(false);
const error = ref<string | null>(null);

watch(open, (isOpen) => {
  if (!isOpen) return;
  error.value = null;
  if (menu.value.length === 0) void loadMenu();
  const c = props.credential;
  form.value = c
    ? {
        service: c.service,
        name: c.name,
        description: c.description ?? '',
        user: c.user ?? '',
        secret: '',
        secretSource: c.secretEnv ? ('env' as const) : ('saved' as const),
        secretEnv: c.secretEnv ?? '',
        destination: c.destination,
        allProjects: c.scope.allProjects,
        projectIds: c.scope.allProjects ? [] : [...c.scope.projectIds],
        everyInput: c.allowedInputs === null,
        allowedInputs: (c.allowedInputs ?? []).join(', '),
        customRequests: c.customRequests,
      }
    : {
        ...blank(),
        destination: props.destination ?? '',
        allProjects: Boolean(props.allProjects && shareAll.value),
        projectIds: props.projectId ? [props.projectId] : [],
      };
});

const editing = computed(() => props.credential !== null);
/** The service is asked only for a credential created with none given. */
const asksService = computed(() => !editing.value && !props.service);
const SERVICE_ITEMS = CREDENTIAL_SERVICES.map((value) => ({ label: CREDENTIAL_SERVICE_LABELS[value], value }));
const isScm = computed(() => form.value.service === 'scm');
/** One click per repository host, for an SCM credential's destination. */
const SCM_HOSTS = [
  { label: 'GitHub', destination: SCM_API_DESTINATIONS.github },
  { label: 'GitLab', destination: SCM_API_DESTINATIONS.gitlab },
  { label: 'Bitbucket', destination: SCM_API_DESTINATIONS.bitbucket },
];
const SOURCE_ITEMS = [
  { label: 'Saved here, encrypted', value: 'saved' },
  { label: 'Read from a server variable', value: 'env' },
];
const ENV_PLACEHOLDER = `${CREDENTIAL_SECRET_ENV_PREFIX}JENKINS`;
const readsEnv = computed(() => form.value.secretSource === 'env');
/** Whether the variable to send differs from the stored one: a new one, or one the credential did not read. */
const envChanged = computed(
  () => readsEnv.value && form.value.secretEnv.trim() !== (props.credential?.secretEnv ?? ''),
);
/** Whether the destination typed differs from the stored one, which needs the secret again. */
const destinationMoved = computed(
  () =>
    editing.value &&
    normalizeCiServerBaseUrl(form.value.destination) !== null &&
    normalizeCiServerBaseUrl(form.value.destination) !== props.credential!.destination,
);

function problem(): string | null {
  const f = form.value;
  if (!f.name.trim()) return 'Give the credential a name.';
  if (!f.destination.trim()) {
    return isScm.value
      ? 'Pick the host whose API the token is sent to.'
      : 'Enter the base URL the secret may be sent under.';
  }
  const destination = credentialDestinationProblem(f.destination.trim());
  if (destination) return destination;
  if (readsEnv.value) {
    if (!isCredentialSecretEnv(f.secretEnv.trim())) {
      return `Name a variable of the server that starts with ${CREDENTIAL_SECRET_ENV_PREFIX}, in capitals.`;
    }
  } else {
    if ((!editing.value || props.credential!.secretEnv) && !f.secret.trim()) return 'Enter the secret.';
    if (destinationMoved.value && !f.secret.trim()) return 'Enter the secret again: the destination changed.';
  }
  if (!f.allProjects && f.projectIds.length === 0) return 'Pick the projects that may use it.';
  return null;
}

async function submit() {
  error.value = problem();
  if (error.value) return;
  const f = form.value;
  const body = {
    name: f.name.trim(),
    description: f.description.trim() || null,
    ...(editing.value ? {} : { service: f.service }),
    destination: f.destination.trim(),
    scope: f.allProjects ? { allProjects: true } : { allProjects: false, projectIds: f.projectIds },
    ...(isScm.value
      ? {}
      : {
          user: f.user.trim() || null,
          allowedInputs: f.everyInput
            ? null
            : f.allowedInputs
                .split(',')
                .map((name) => name.trim())
                .filter(Boolean),
          customRequests: f.customRequests,
        }),
    ...(readsEnv.value
      ? envChanged.value || destinationMoved.value || !editing.value
        ? { secretEnv: f.secretEnv.trim() }
        : {}
      : f.secret.trim()
        ? { secret: f.secret.trim() }
        : {}),
  };
  saving.value = true;
  try {
    const answer = editing.value
      ? await $fetch<ApiResponse<typeof import('~~/server/api/credentials/[id].patch').default>>(
          `/api/credentials/${props.credential!.id}`,
          { method: 'PATCH', body },
        )
      : await $fetch<ApiResponse<typeof import('~~/server/api/credentials/index.post').default>>('/api/credentials', {
          method: 'POST',
          body,
        });
    toast.add({ title: editing.value ? 'Credential saved' : 'Credential created', color: 'success' });
    open.value = false;
    emit('saved', answer.credential);
  } catch (e) {
    error.value = errorMessage(e, 'The credential could not be saved.');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="editing ? 'Edit credential' : 'New credential'">
    <template #body>
      <form method="post" class="space-y-4" data-testid="credential-form" @submit.prevent="submit">
        <UFormField
          v-if="asksService"
          label="Service"
          name="credentialService"
          description="What it is sent to: a CI server, or a repository host's API."
        >
          <USelect
            v-model="form.service"
            :items="SERVICE_ITEMS"
            aria-label="Credential service"
            class="w-full"
            data-testid="credential-service"
          />
        </UFormField>
        <UFormField label="Name" name="credentialName" required>
          <UInput
            v-model="form.name"
            :maxlength="MAX_CREDENTIAL_NAME_LENGTH"
            :placeholder="isScm ? 'e.g. GitHub · acme' : 'e.g. Jenkins · piwi-bot'"
            aria-label="Credential name"
            class="w-full"
          />
        </UFormField>
        <FormFieldGroup
          v-if="isScm"
          label="Destination"
          :description="`The API the token is sent to. A path under its repositories narrows it (${SCM_API_DESTINATIONS.github}repos/acme/); a self-hosted GitLab must be in PIWI_SCM_GITLAB_HOSTS.`"
        >
          <div class="space-y-2">
            <div class="flex flex-wrap gap-2">
              <UButton
                v-for="host in SCM_HOSTS"
                :key="host.label"
                size="xs"
                color="neutral"
                variant="outline"
                :class="form.destination === host.destination ? PRESSED_TOGGLE_CLASS : undefined"
                :aria-pressed="form.destination === host.destination"
                :label="host.label"
                @click="form.destination = host.destination"
              />
            </div>
            <UInput
              v-model="form.destination"
              :placeholder="SCM_API_DESTINATIONS.github"
              aria-label="Credential destination"
              class="w-full font-mono"
            />
          </div>
        </FormFieldGroup>
        <UFormField
          v-else
          label="Destination"
          name="credentialDestination"
          required
          description="The base URL the secret may be sent under. A request elsewhere is refused."
        >
          <UInput
            v-model="form.destination"
            placeholder="https://jenkins.example.com/"
            aria-label="Credential destination"
            class="w-full font-mono"
          />
        </UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField v-if="!isScm" label="User" name="credentialUser" description="For Basic auth, with the secret.">
            <UInput
              v-model="form.user"
              autocomplete="off"
              placeholder="e.g. piwi-bot"
              aria-label="Credential user"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField
            v-if="shareAll"
            label="Secret source"
            name="credentialSecretSource"
            description="Saved here, or read on the server."
          >
            <USelect
              v-model="form.secretSource"
              :items="SOURCE_ITEMS"
              aria-label="Secret source"
              class="w-full"
              data-testid="credential-secret-source"
            />
          </UFormField>
        </div>
        <UFormField
          v-if="readsEnv"
          label="Variable"
          name="credentialSecretEnv"
          required
          :description="`Read on the server at each use. Only a variable named ${CREDENTIAL_SECRET_ENV_PREFIX}…, so no other variable of the server can be sent.`"
        >
          <UInput
            v-model="form.secretEnv"
            autocomplete="off"
            :placeholder="ENV_PLACEHOLDER"
            aria-label="Variable the secret is read from"
            class="w-full font-mono"
            data-testid="credential-secret-env"
          />
        </UFormField>
        <UFormField
          v-else
          label="Secret"
          name="credentialSecret"
          :required="!editing || destinationMoved || Boolean(credential?.secretEnv)"
          :description="
            editing && !credential?.secretEnv
              ? 'Leave empty to keep the stored one.'
              : 'Encrypted, and never shown again.'
          "
        >
          <UInput
            v-model="form.secret"
            type="password"
            autocomplete="new-password"
            :placeholder="
              editing && !credential?.secretEnv ? '•••••••• (unchanged)' : isScm ? 'Access token' : 'API token'
            "
            aria-label="Credential secret"
            class="w-full font-mono"
          />
        </UFormField>
        <FormFieldGroup
          label="Projects"
          :description="
            isScm
              ? 'The projects whose source control and CI actions may name it.'
              : 'The projects whose CI actions may name it.'
          "
        >
          <div class="space-y-2">
            <USwitch v-if="shareAll" v-model="form.allProjects" label="All projects, present and future" />
            <USelectMenu
              v-if="!form.allProjects"
              v-model="form.projectIds"
              :items="projectItems"
              value-key="value"
              multiple
              placeholder="Pick projects"
              aria-label="Projects that may use the credential"
              class="w-full"
            />
          </div>
        </FormFieldGroup>
        <FormFieldGroup
          v-if="!isScm"
          label="Inputs"
          description="The CI action inputs a request carrying it may send, beside the arguments and the dispatch id."
        >
          <div class="space-y-2">
            <USwitch v-model="form.everyInput" label="Every input" />
            <UInput
              v-if="!form.everyInput"
              v-model="form.allowedInputs"
              placeholder="TARGET_ENV, SUITE (empty: none)"
              aria-label="Inputs a request may send"
              class="w-full font-mono"
            />
          </div>
        </FormFieldGroup>
        <USwitch
          v-if="!isScm"
          v-model="form.customRequests"
          label="Custom requests may carry it"
          description="A Custom request reaches any path under the destination, a script console included."
        />
        <UFormField label="Description" name="credentialDescription">
          <UTextarea
            v-model="form.description"
            :maxlength="MAX_CREDENTIAL_DESCRIPTION_LENGTH"
            :rows="2"
            autoresize
            placeholder="What it is for, who owns the account"
            aria-label="Credential description"
            class="w-full"
          />
        </UFormField>
        <p v-if="error" class="text-sm text-error" data-testid="credential-form-error">{{ error }}</p>
        <button type="submit" class="hidden" aria-hidden="true" tabindex="-1" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="outline" label="Cancel" @click="open = false" />
        <UButton
          :label="editing ? 'Save credential' : 'Create credential'"
          icon="i-lucide-check"
          :loading="saving"
          data-testid="credential-save"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
