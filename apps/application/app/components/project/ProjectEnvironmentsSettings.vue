<script setup lang="ts">
/**
 * Project settings → Environments: the deployments this project's tests run against (Local, Integration, Staging,
 * Production), in the order every picker shows them, the archived ones apart. A run's label resolves to one by its key
 * or an alias; a label nothing takes adds a discovered one. The project's managers add, edit, reorder, archive and
 * delete them, and copy another project's; everyone else reads the list.
 */
import type { ProjectWithStats, ProjectWithTestRuns } from '~~/types/api';
import type { EnvironmentRecord } from '#shared/environments';
import { environmentMoves } from '~/utils/environment-form';

const props = defineProps<{ project: ProjectWithTestRuns }>();

const toast = useToast();
const { can } = useAuth();
const canManage = computed(() => can('project:manage', props.project.id));
const { environments, loaded, refresh } = useProjectEnvironments(() => props.project.id);

const reading = ref(true);
const failed = ref(false);
async function reload() {
  reading.value = true;
  await refresh();
  reading.value = false;
  failed.value = !loaded.value;
}
onMounted(reload);

const ordered = computed(() => [...environments.value].sort((a, b) => a.position - b.position || a.id - b.id));
const current = computed(() => ordered.value.filter((environment) => !environment.archived));
const archived = computed(() => ordered.value.filter((environment) => environment.archived));

/** One environment's facts in a line: its key, aliases, run variables, env file, and how it runs. */
function facts(environment: EnvironmentRecord): string[] {
  const parts: string[] = [];
  if (environment.aliases.length) parts.push(`also ${environment.aliases.join(', ')}`);
  const variables = environment.runVariables.length;
  if (variables) parts.push(variables === 1 ? '1 run variable' : `${variables} run variables`);
  if (environment.envFile) parts.push(environment.envFile);
  if (environment.appFromCheckout) parts.push('built from the checkout');
  if (environment.protected) parts.push(`protected, ${environment.requiredTags.join(' ')}`);
  if (environment.discovered) parts.push('discovered from a run’s label');
  return parts;
}

const busy = ref<number | null>(null);

async function patch(environment: EnvironmentRecord, body: Record<string, unknown>, done: string) {
  busy.value = environment.id;
  try {
    await $fetch<{ environment: EnvironmentRecord }>(
      `/api/projects/${props.project.id}/environments/${environment.id}`,
      { method: 'PATCH', body },
    );
    toast.add({ title: done, color: 'success' });
  } catch (e) {
    toast.add({ title: 'The environment could not be changed', description: errorMessage(e), color: 'error' });
  } finally {
    busy.value = null;
    await refresh();
  }
}

async function move(environment: EnvironmentRecord, step: -1 | 1) {
  const moves = environmentMoves(current.value, environment.id, step);
  if (moves.length === 0) return;
  busy.value = environment.id;
  try {
    for (const { id, position } of moves) {
      await $fetch<{ environment: EnvironmentRecord }>(`/api/projects/${props.project.id}/environments/${id}`, {
        method: 'PATCH',
        body: { position },
      });
    }
  } catch (e) {
    toast.add({ title: 'The environments could not be reordered', description: errorMessage(e), color: 'error' });
  } finally {
    busy.value = null;
    await refresh();
  }
}

// ── Add and edit ──────────────────────────────────────────────────────────
const editorOpen = ref(false);
const editing = ref<EnvironmentRecord | null>(null);
const others = computed(() => environments.value.filter((environment) => environment.id !== editing.value?.id));

function add() {
  editing.value = null;
  editorOpen.value = true;
}

function edit(environment: EnvironmentRecord) {
  editing.value = environment;
  editorOpen.value = true;
}

async function onSaved(environment: EnvironmentRecord) {
  toast.add({ title: `${environment.name} saved`, color: 'success' });
  await refresh();
}

// ── Delete ────────────────────────────────────────────────────────────────
const deleting = ref<EnvironmentRecord | null>(null);
const deleteOpen = computed({
  get: () => deleting.value !== null,
  set: (value: boolean) => {
    if (!value) deleting.value = null;
  },
});
const removing = ref(false);

async function confirmDelete() {
  const environment = deleting.value;
  if (!environment) return;
  removing.value = true;
  try {
    await $fetch<{ deleted: boolean }>(`/api/projects/${props.project.id}/environments/${environment.id}`, {
      method: 'DELETE',
    });
    toast.add({ title: `${environment.name} deleted`, color: 'success' });
    deleting.value = null;
  } catch (e) {
    toast.add({ title: 'The environment could not be deleted', description: errorMessage(e), color: 'error' });
  } finally {
    removing.value = false;
    await refresh();
  }
}

async function archiveInstead() {
  const environment = deleting.value;
  if (!environment) return;
  deleting.value = null;
  await patch(environment, { archived: true }, `${environment.name} archived`);
}

// ── Copy from another project ─────────────────────────────────────────────
const copyOpen = ref(false);
const copyFrom = ref<number | undefined>(undefined);
const copying = ref(false);
const copyError = ref<string | null>(null);
const copyResult = ref<{ copied: EnvironmentRecord[]; skipped: string[] } | null>(null);
const sources = ref<ProjectWithStats[]>([]);
const sourcesLoaded = ref(false);

const sourceItems = computed(() =>
  sources.value
    .filter((source) => source.id !== props.project.id)
    .map((source) => ({ label: source.label || source.name, value: source.id })),
);

async function openCopy() {
  copyFrom.value = undefined;
  copyError.value = null;
  copyResult.value = null;
  copyOpen.value = true;
  if (sourcesLoaded.value) return;
  try {
    sources.value = (await $fetch<{ items: ProjectWithStats[] }>('/api/projects')).items;
  } catch (e) {
    copyError.value = errorMessage(e, 'The projects could not be listed.');
  } finally {
    sourcesLoaded.value = true;
  }
}

async function copy() {
  if (copyFrom.value == null || copying.value) return;
  copying.value = true;
  copyError.value = null;
  try {
    copyResult.value = await $fetch<{ copied: EnvironmentRecord[]; skipped: string[] }>(
      `/api/projects/${props.project.id}/environments/copy`,
      { method: 'POST', body: { fromProjectId: copyFrom.value } },
    );
  } catch (e) {
    copyError.value = errorMessage(e, 'The environments could not be copied.');
  } finally {
    copying.value = false;
    await refresh();
  }
}

const copySummary = computed(() => {
  const result = copyResult.value;
  if (!result) return null;
  const copied =
    result.copied.length === 0
      ? 'No environment copied.'
      : `Copied ${result.copied.length === 1 ? '1 environment' : `${result.copied.length} environments`}: ${result.copied.map((environment) => environment.name).join(', ')}.`;
  const skipped =
    result.skipped.length === 0
      ? ''
      : ` Left as they were, since this project already names them: ${result.skipped.join(', ')}.`;
  return copied + skipped;
});

/** The Playwright config that reads an environment's run variables, as the docs show it. */
const CONFIG_PATTERN = `import { config as loadEnv } from 'dotenv';
import { defineConfig } from '@playwright/test';
import { wrapConfig } from '@piwitests/reporter';

const testEnv = process.env.TEST_ENV ?? 'local';
loadEnv({ path: \`.env.\${testEnv}\` }); // this environment's secrets, never committed

export default wrapConfig(
  defineConfig({
    use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000' },
    webServer:
      testEnv === 'local'
        ? { command: 'npm start', url: 'http://localhost:3000', reuseExistingServer: !process.env.CI }
        : undefined,
  }),
  { environment: testEnv },
);`;
</script>

<template>
  <SectionCard
    icon="i-lucide-server"
    title="Environments"
    subtitle="The deployments this project's tests run against"
    help="project.environments"
    data-shot="project-environments-settings"
  >
    <template v-if="canManage" #actions>
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-copy"
        data-testid="environments-copy"
        @click="openCopy"
      >
        Copy from another project
      </UButton>
    </template>

    <div class="space-y-4">
      <p class="text-sm text-highlighted leading-relaxed">
        A run's label goes to the environment whose key or alias it matches; a label nothing matches adds a discovered
        one. Where Piwi starts a run or gives a command to copy, you pick one: its run variables and
        <code>PIWI_ENVIRONMENT</code> go with it.
      </p>

      <LoadingState v-if="reading && !loaded" text="Reading the project's environments…" />
      <ErrorState v-else-if="failed" text="Could not read the project's environments." />
      <template v-else>
        <p v-if="current.length === 0" class="text-sm text-muted" data-testid="environments-empty">
          No environment yet. The first run that reports a label adds it, or add one here.
        </p>
        <ul v-else class="divide-y divide-default rounded-md border border-default" data-testid="environments-list">
          <li
            v-for="(environment, index) in current"
            :key="environment.id"
            class="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between"
            data-testid="environment-row"
            :data-environment-key="environment.key"
          >
            <div class="min-w-0 space-y-0.5">
              <p class="text-sm text-highlighted break-words">
                {{ environment.name }}
                <span v-if="environment.key !== environment.name" class="text-xs text-muted font-mono">{{
                  environment.key
                }}</span>
              </p>
              <p v-if="facts(environment).length" class="text-xs text-muted break-words">
                {{ facts(environment).join(' · ') }}
              </p>
              <p v-if="environment.description" class="text-xs text-muted break-words">
                {{ environment.description }}
              </p>
            </div>
            <div v-if="canManage" class="flex shrink-0 flex-wrap items-center gap-1">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-arrow-up"
                :disabled="index === 0 || busy !== null"
                :aria-label="`Move ${environment.name} up`"
                title="Move up: pickers show the environments in this order"
                @click="move(environment, -1)"
              />
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-arrow-down"
                :disabled="index === current.length - 1 || busy !== null"
                :aria-label="`Move ${environment.name} down`"
                title="Move down: pickers show the environments in this order"
                @click="move(environment, 1)"
              />
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                data-testid="environment-edit"
                @click="edit(environment)"
              >
                Edit
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :loading="busy === environment.id"
                title="Leaves the pickers; its runs keep it"
                data-testid="environment-archive"
                @click="patch(environment, { archived: true }, `${environment.name} archived`)"
              >
                Archive
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                data-testid="environment-delete"
                @click="deleting = environment"
              >
                Delete
              </UButton>
            </div>
          </li>
        </ul>

        <div v-if="archived.length" class="space-y-2" data-testid="environments-archived">
          <p class="text-sm font-semibold text-highlighted">Archived</p>
          <p class="text-xs text-muted">Out of the pickers, and no run starts for them. Their runs keep them.</p>
          <ul class="divide-y divide-default rounded-md border border-default">
            <li
              v-for="environment in archived"
              :key="environment.id"
              class="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid="environment-archived-row"
            >
              <p class="min-w-0 text-sm text-highlighted break-words">
                {{ environment.name }}
                <span v-if="environment.key !== environment.name" class="text-xs text-muted font-mono">{{
                  environment.key
                }}</span>
              </p>
              <div v-if="canManage" class="flex shrink-0 flex-wrap items-center gap-1">
                <UButton
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :loading="busy === environment.id"
                  data-testid="environment-unarchive"
                  @click="patch(environment, { archived: false }, `${environment.name} back in the pickers`)"
                >
                  Unarchive
                </UButton>
                <UButton size="xs" color="neutral" variant="outline" @click="deleting = environment">Delete</UButton>
              </div>
            </li>
          </ul>
        </div>
      </template>

      <UButton
        v-if="canManage"
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-plus"
        data-testid="environment-add"
        @click="add"
      >
        Add an environment
      </UButton>

      <UCollapsible class="border-t border-default pt-2">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          class="-ml-2.5"
          :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform' }"
        >
          The config that reads it
        </UButton>
        <template #content>
          <div class="space-y-2 pt-1">
            <p class="text-xs text-muted">
              Give Staging the run variable <code>TEST_ENV=staging</code> and the env file <code>.env.staging</code>;
              the config loads the file's secrets on each machine, and CI sets <code>TEST_ENV</code> and the secrets
              itself. <code>dotenv</code> never overrides a variable already set, so Piwi's values win over the file.
            </p>
            <CodeBlock :code="CONFIG_PATTERN" lang="ts" filename="playwright.config.ts" />
          </div>
        </template>
      </UCollapsible>
    </div>

    <ProjectEnvironmentEditor
      v-if="canManage"
      v-model:open="editorOpen"
      :project-id="project.id"
      :environment="editing"
      :others="others"
      @saved="onSaved"
    />

    <UModal v-model:open="deleteOpen" :title="deleting ? `Delete ${deleting.name}?` : 'Delete the environment?'">
      <template #body>
        <p v-if="deleting" class="text-sm text-highlighted leading-relaxed" data-testid="environment-delete-confirm">
          Its runs keep their label and lose their environment. A later run that reports
          <code>{{ deleting.key }}</code> creates it again, as a discovered environment.
          <template v-if="!deleting.archived">
            To keep it out of the pickers and its runs with it, archive it instead.</template
          >
        </p>
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="deleting = null" />
          <UButton
            v-if="deleting && !deleting.archived"
            color="neutral"
            variant="outline"
            label="Archive instead"
            @click="archiveInstead"
          />
          <UButton
            color="error"
            icon="i-lucide-trash-2"
            label="Delete"
            :loading="removing"
            data-testid="environment-delete-confirm-button"
            @click="confirmDelete"
          />
        </div>
      </template>
    </UModal>

    <UModal v-model:open="copyOpen" title="Copy from another project" :ui="{ content: 'max-w-lg' }">
      <template #body>
        <div class="space-y-3" data-testid="environments-copy-form">
          <p class="text-sm text-highlighted leading-relaxed">
            Copies the environments declared in a project you can read, every field but its URL patterns. Each copy is
            this project's from then on. An environment whose key this project already names is left as it is.
          </p>
          <USelectMenu
            v-model="copyFrom"
            :items="sourceItems"
            value-key="value"
            placeholder="Pick a project"
            :loading="!sourcesLoaded"
            class="w-full"
            aria-label="Project to copy from"
          />
          <p v-if="copySummary" class="text-sm text-highlighted" data-testid="environments-copy-result">
            {{ copySummary }}
          </p>
          <p v-if="copyError" class="text-sm text-error" role="alert">{{ copyError }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" :label="copyResult ? 'Close' : 'Cancel'" @click="copyOpen = false" />
          <UButton
            icon="i-lucide-copy"
            label="Copy"
            :disabled="copyFrom == null"
            :loading="copying"
            data-testid="environments-copy-submit"
            @click="copy"
          />
        </div>
      </template>
    </UModal>
  </SectionCard>
</template>
