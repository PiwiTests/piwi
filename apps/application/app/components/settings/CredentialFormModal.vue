<script setup lang="ts">
/**
 * Create or change a credential in a modal: its name, user, secret,
 * destination, the projects that may use it, the inputs a request carrying it
 * may send, and whether a Custom request may carry it. The secret is
 * write-only: left empty on a change, the stored one stays, and a new
 * destination asks for it again.
 */
import { normalizeCiServerBaseUrl } from '#shared/ci-server';
import {
  credentialDestinationProblem,
  MAX_CREDENTIAL_DESCRIPTION_LENGTH,
  MAX_CREDENTIAL_NAME_LENGTH,
  type CredentialService,
  type CredentialSummary,
} from '#shared/credentials';
import type { ApiResponse, ProjectMenuItem } from '~~/types/api';

const props = defineProps<{
  /** The credential to change, or null to create one. */
  credential: CredentialSummary | null;
  service: CredentialService;
  /** The project a credential created from its settings starts shared with. */
  projectId?: number;
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
  name: '',
  description: '',
  user: '',
  secret: '',
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
        name: c.name,
        description: c.description ?? '',
        user: c.user ?? '',
        secret: '',
        destination: c.destination,
        allProjects: c.scope.allProjects,
        projectIds: c.scope.allProjects ? [] : [...c.scope.projectIds],
        everyInput: c.allowedInputs === null,
        allowedInputs: (c.allowedInputs ?? []).join(', '),
        customRequests: c.customRequests,
      }
    : { ...blank(), projectIds: props.projectId ? [props.projectId] : [] };
});

const editing = computed(() => props.credential !== null);
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
  if (!f.destination.trim()) return 'Enter the base URL the secret may be sent under.';
  const destination = credentialDestinationProblem(f.destination.trim());
  if (destination) return destination;
  if (!editing.value && !f.secret.trim()) return 'Enter the secret.';
  if (destinationMoved.value && !f.secret.trim()) return 'Enter the secret again: the destination changed.';
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
    service: props.service,
    user: f.user.trim() || null,
    destination: f.destination.trim(),
    scope: f.allProjects ? { allProjects: true } : { allProjects: false, projectIds: f.projectIds },
    allowedInputs: f.everyInput
      ? null
      : f.allowedInputs
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
    customRequests: f.customRequests,
    ...(f.secret.trim() ? { secret: f.secret.trim() } : {}),
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
        <UFormField label="Name" name="credentialName" required>
          <UInput
            v-model="form.name"
            :maxlength="MAX_CREDENTIAL_NAME_LENGTH"
            placeholder="e.g. Jenkins · piwi-bot"
            aria-label="Credential name"
            class="w-full"
          />
        </UFormField>
        <UFormField
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
          <UFormField label="User" name="credentialUser" description="For Basic auth, with the secret.">
            <UInput
              v-model="form.user"
              autocomplete="off"
              placeholder="e.g. piwi-bot"
              aria-label="Credential user"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField
            label="Secret"
            name="credentialSecret"
            :required="!editing || destinationMoved"
            :description="editing ? 'Leave empty to keep the stored one.' : 'Encrypted, and never shown again.'"
          >
            <UInput
              v-model="form.secret"
              type="password"
              autocomplete="new-password"
              :placeholder="editing ? '•••••••• (unchanged)' : 'API token'"
              aria-label="Credential secret"
              class="w-full font-mono"
            />
          </UFormField>
        </div>
        <FormFieldGroup label="Projects" description="The projects whose CI actions may name it.">
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
