<script setup lang="ts">
/**
 * Settings → Credentials: the secrets Piwi sends to other services, each saved
 * once and named by the CI actions that use it. A credential opens in a panel
 * with what names it and its log; the environment's is listed read-only.
 */
import { CREDENTIAL_SERVICE_LABELS, type CredentialSummary } from '#shared/credentials';
import type { ApiResponse, ProjectMenuItem } from '~~/types/api';

type ListAnswer = ApiResponse<typeof import('~~/server/api/credentials/index.get').default>;

const toast = useToast();
const { can, canAnywhere } = useAuth();
const canManage = computed(() => can('credentials:manage'));
/** A Project admin creates credentials for the projects they manage; an administrator for any. */
const canCreate = computed(() => canManage.value || canAnywhere('project:manage'));

const { data, refresh } = await useFetch<ListAnswer>('/api/credentials');
const credentials = computed(() => (data.value?.credentials ?? []) as CredentialSummary[]);
const canEncrypt = computed(() => data.value?.canEncrypt ?? true);

const { data: menu } = useFetch('/api/projects/menu', {
  server: false,
  default: () => [] as ProjectMenuItem[],
  transform: (r: { items: ProjectMenuItem[] }) => r.items,
});
const projectName = (id: number) => {
  const project = menu.value.find((p) => p.id === id);
  return project ? project.label || project.name : `Project ${id}`;
};
const scopeText = (c: CredentialSummary) =>
  c.scope.allProjects
    ? 'All projects'
    : c.scope.projectIds.length === 1
      ? projectName(c.scope.projectIds[0]!)
      : `${c.scope.projectIds.length} projects`;

const formOpen = ref(false);
const editing = ref<CredentialSummary | null>(null);
function openForm(credential: CredentialSummary | null) {
  editing.value = credential;
  formOpen.value = true;
}

const selectedId = ref<number | null>(null);
const selected = computed(() => credentials.value.find((c) => c.id === selectedId.value) ?? null);
const panelOpen = computed({
  get: () => selected.value !== null,
  set: (open: boolean) => {
    if (!open) selectedId.value = null;
  },
});

async function saved(credential: CredentialSummary) {
  await refresh();
  selectedId.value = credential.id;
}

async function setDisabled(credential: CredentialSummary, disabled: boolean) {
  try {
    await $fetch(`/api/credentials/${credential.id}`, { method: 'PATCH', body: { disabled } });
    toast.add({ title: disabled ? 'Credential disabled' : 'Credential enabled', color: 'success' });
    await refresh();
  } catch (e) {
    toast.add({ title: 'The credential could not be changed', description: errorMessage(e), color: 'error' });
  }
}

const deleting = ref<CredentialSummary | null>(null);
async function remove() {
  const credential = deleting.value;
  deleting.value = null;
  if (!credential) return;
  try {
    await $fetch(`/api/credentials/${credential.id}`, { method: 'DELETE' });
    toast.add({ title: 'Credential deleted', color: 'success' });
    selectedId.value = null;
    await refresh();
  } catch (e) {
    toast.add({ title: 'The credential could not be deleted', description: errorMessage(e), color: 'error' });
  }
}
</script>

<template>
  <div class="space-y-4" data-tour="credentials-page">
    <SectionCard
      title="Credentials"
      icon="i-lucide-key-round"
      :count="credentials.length"
      help="settings.credentials"
      data-tour="credentials-list"
      data-shot="credentials-list"
    >
      <template #actions>
        <UButton
          v-if="canCreate"
          label="New credential"
          icon="i-lucide-plus"
          size="sm"
          :disabled="!canEncrypt"
          data-testid="credential-new"
          @click="openForm(null)"
        />
      </template>

      <p v-if="!canEncrypt" class="mb-3 text-sm text-muted">
        Set <code class="font-mono">PIWI_SECRET_KEY</code> to save a credential: its secret is encrypted with it.
      </p>

      <EmptyState
        v-if="credentials.length === 0"
        icon="i-lucide-key-round"
        text="No credential yet. Save one here, then name it in a project’s CI actions."
      />
      <ul v-else class="divide-y divide-default" data-testid="credential-list">
        <li v-for="credential in credentials" :key="credential.id">
          <button
            type="button"
            class="w-full text-left py-3 px-2 flex flex-col gap-0.5 rounded-md hover:bg-elevated/50"
            :data-testid="`credential-row-${credential.id}`"
            @click="selectedId = credential.id"
          >
            <span class="flex flex-wrap items-baseline justify-between gap-x-3">
              <span class="flex items-center gap-1 text-sm font-semibold text-highlighted">
                {{ credential.name }}
                <EnvManagedBadge v-if="credential.managedBy === 'env'" :env-vars="['PIWI_CI_SERVER_TOKEN']" size="xs" />
              </span>
              <span class="text-xs text-muted">
                <template v-if="credential.disabled">Disabled</template>
                <template v-else-if="credential.secretEnvSet === false">Variable not set</template>
                <ClientOnly v-else-if="credential.lastUsedAt">
                  <span :title="prettyDateFormat(credential.lastUsedAt)">
                    Used {{ formatRelativeTime(credential.lastUsedAt) }}
                  </span>
                </ClientOnly>
                <template v-else>Never used</template>
              </span>
            </span>
            <span class="text-xs text-muted">
              {{ CREDENTIAL_SERVICE_LABELS[credential.service]
              }}<template v-if="credential.user"> · {{ credential.user }}</template> · {{ scopeText(credential) }} ·
              used by {{ credential.usedBy.length }} {{ credential.usedBy.length === 1 ? 'action' : 'actions' }}
            </span>
            <span class="text-xs text-muted font-mono break-all">{{ credential.destination }}</span>
          </button>
        </li>
      </ul>
    </SectionCard>

    <SectionCard
      v-if="canManage"
      title="Log"
      icon="i-lucide-scroll-text"
      subtitle="Every use of every credential, deleted ones included"
      help="settings.credentials.log"
      data-testid="credentials-log"
      data-tour="credentials-log"
      data-shot="credentials-log"
    >
      <CredentialActivity />
    </SectionCard>

    <USlideover v-model:open="panelOpen" :title="selected?.name ?? 'Credential'">
      <template #body>
        <div v-if="selected" class="space-y-5" data-testid="credential-panel">
          <p v-if="selected.description" class="text-sm text-highlighted">{{ selected.description }}</p>
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-muted">Service</dt>
            <dd class="text-highlighted">{{ CREDENTIAL_SERVICE_LABELS[selected.service] }}</dd>
            <dt class="text-muted">User</dt>
            <dd class="text-highlighted font-mono">{{ selected.user ?? '—' }}</dd>
            <dt class="text-muted">Destination</dt>
            <dd class="text-highlighted font-mono break-all">{{ selected.destination }}</dd>
            <dt class="text-muted">Projects</dt>
            <dd class="text-highlighted">
              <template v-if="selected.scope.allProjects">All projects</template>
              <template v-else>{{ selected.scope.projectIds.map(projectName).join(', ') }}</template>
            </dd>
            <dt class="text-muted">Inputs</dt>
            <dd class="text-highlighted">
              <template v-if="selected.allowedInputs === null">Every input</template>
              <template v-else-if="selected.allowedInputs.length === 0">None</template>
              <span v-else class="font-mono">{{ selected.allowedInputs.join(', ') }}</span>
            </dd>
            <dt class="text-muted">Custom requests</dt>
            <dd class="text-highlighted">{{ selected.customRequests ? 'Allowed' : 'Refused' }}</dd>
            <dt class="text-muted">Secret</dt>
            <dd class="text-highlighted">
              <template v-if="selected.managedBy === 'env'"
                >In <code class="font-mono">PIWI_CI_SERVER_TOKEN</code></template
              >
              <template v-else-if="selected.secretEnv">
                Read from <code class="font-mono">{{ selected.secretEnv }}</code
                ><template v-if="selected.secretEnvSet === false">, which is not set on the server</template>
              </template>
              <template v-else>Saved <ClientDate :date="selected.rotatedAt" /></template>
            </dd>
            <dt class="text-muted">State</dt>
            <dd class="text-highlighted">{{ selected.disabled ? 'Disabled: every use is refused' : 'Active' }}</dd>
          </dl>

          <div class="space-y-1">
            <p class="text-sm font-semibold text-highlighted">Used by</p>
            <p v-if="selected.usedBy.length === 0" class="text-sm text-muted">
              No CI action names it{{ selected.managedBy === 'env' ? ': the actions that name none send it' : '' }}.
            </p>
            <ul v-else class="space-y-0.5">
              <li v-for="use in selected.usedBy" :key="`${use.projectId}-${use.actionId}`" class="text-sm">
                <NuxtLink
                  :to="`/projects/${use.projectId}?tab=settings&section=ci`"
                  class="text-primary hover:underline"
                >
                  {{ use.actionName }}
                </NuxtLink>
                <span class="text-muted"> · {{ use.projectName }}</span>
              </li>
            </ul>
          </div>

          <div v-if="selected.canManage" class="flex flex-wrap gap-2">
            <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-pencil" @click="openForm(selected)">
              Edit or rotate
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              :icon="selected.disabled ? 'i-lucide-play' : 'i-lucide-ban'"
              data-testid="credential-toggle"
              @click="setDisabled(selected, !selected.disabled)"
            >
              {{ selected.disabled ? 'Enable' : 'Disable' }}
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-trash-2"
              data-testid="credential-delete"
              @click="deleting = selected"
            >
              Delete
            </UButton>
          </div>

          <CredentialActivity :credential-id="selected.id" />
        </div>
      </template>
    </USlideover>

    <CredentialFormModal v-model:open="formOpen" :credential="editing" service="ci-server" @saved="saved" />

    <UModal
      :open="deleting !== null"
      title="Delete this credential?"
      :description="
        deleting
          ? `“${deleting.name}” and its secret are deleted. Its log stays, under its name, until it expires.`
          : undefined
      "
      @update:open="(open: boolean) => !open && (deleting = null)"
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="outline" label="Cancel" @click="deleting = null" />
          <UButton color="error" label="Delete credential" icon="i-lucide-trash-2" @click="remove" />
        </div>
      </template>
    </UModal>
  </div>
</template>
