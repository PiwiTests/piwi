<script setup lang="ts">
/**
 * The per-project test management binding form (admin, project Settings → Integrations): which connection and project
 * of the tool the project's tests are matched against, where a test's case key comes from, the runs in scope, how a
 * test run is named, the status names a result carries, and below the form the mapping summary and the catalog of test
 * cases. Saves the whole binding to PUT /api/projects/:id/test-management.
 *
 * The binding and the catalog work today; nothing is sent to the tool yet, and the form says so.
 */
import {
  emptyTestManagementBinding,
  type ResolvedTestManagementBinding,
} from '#shared/integrations/test-management-binding';
import type { TestManagementConnectionSummary } from '#shared/integrations/types';
import type { TestManagementPickerOptions } from '#shared/integrations/test-management-picker';
import {
  applyConnectionChange,
  hasTestManagementProblem,
  setFlakyStatus,
  setTypedProject,
  setTypedStatus,
  testManagementFromForm,
  testManagementProblems,
  testManagementToForm,
  type StatusField,
  type TestManagementForm,
} from '~/utils/test-management-form';

const props = defineProps<{ projectId: number }>();
const toast = useToast();

const form = reactive<TestManagementForm>(testManagementToForm(emptyTestManagementBinding()));
const connections = ref<TestManagementConnectionSummary[]>([]);
const options = ref<TestManagementPickerOptions>({ projects: [], statuses: [], folders: [] });
const optionsError = ref<string | null>(null);
const loading = ref(true);
const saving = ref(false);
/** The binding as last saved, so Save is offered only for a change; and the key that remounts the summary on a save. */
const savedJson = ref('');
const savedCount = ref(0);

const connectionItems = computed(() => [
  { label: 'None — unbound', value: 0 },
  ...connections.value.map((c) => ({ label: c.name, value: c.id })),
]);
const projectItems = computed(() => [
  ...options.value.projects.map((p) => ({
    label: p.enabled ? p.key : `${p.key} — test management is off`,
    value: p.key,
  })),
  // A key the tool does not list, typed or saved, stays visible once chosen.
  ...(form.providerProjectKey && !options.value.projects.some((p) => p.key === form.providerProjectKey)
    ? [{ label: form.providerProjectKey, value: form.providerProjectKey }]
    : []),
]);
const folderItems = computed(() => [
  { label: 'None — the project’s root', value: '' },
  ...options.value.folders.map((f) => ({ label: f.path, value: f.id })),
  // A stored folder the tool no longer lists stays visible, so a save does not silently drop it.
  ...(form.folderId && !options.value.folders.some((f) => f.id === form.folderId)
    ? [{ label: `Folder ${form.folderId}`, value: form.folderId }]
    : []),
]);
const statusItems = computed(() => options.value.statuses.map((s) => s.name));
const flakyItems = [
  { label: 'Pass', value: 'pass' },
  { label: 'Fail', value: 'fail' },
  { label: 'The flaky status below', value: 'flaky' },
];
const skippedItems = [
  { label: 'Leave it out', value: '' },
  { label: 'Report it as Not Executed', value: 'notExecuted' },
];

function createProject(raw: string) {
  if (!setTypedProject(form, raw)) {
    toast.add({
      title: 'Not a project key',
      description: 'A project key starts with a letter and holds letters, digits and underscores, like SHOP.',
      color: 'warning',
    });
  }
}

function createStatus(field: StatusField, raw: string) {
  if (!setTypedStatus(form, field, raw) && raw.trim()) {
    toast.add({ title: 'That status name is too long', color: 'warning' });
  }
}

const flakyStatus = computed({
  get: () => form.statuses.flaky || undefined,
  set: (value: string | null | undefined) => setFlakyStatus(form, value),
});

const problems = computed(() => testManagementProblems(form));
const dirty = computed(() => JSON.stringify(testManagementFromForm(form)) !== savedJson.value);
const bound = computed(() => form.connectionId > 0);
const selectedConnection = computed(() => connections.value.find((c) => c.id === form.connectionId) ?? null);

function applyBinding(binding: ResolvedTestManagementBinding) {
  Object.assign(form, testManagementToForm(binding));
  savedJson.value = JSON.stringify(testManagementFromForm(form));
}

let optionsRequest = 0;
async function loadOptions() {
  if (!form.connectionId) {
    options.value = { projects: [], statuses: [], folders: [] };
    optionsError.value = null;
    return;
  }
  const request = ++optionsRequest;
  const query: Record<string, string | number> = { connectionId: form.connectionId };
  if (form.providerProjectKey.trim()) query.projectKey = form.providerProjectKey.trim();
  try {
    const loaded = await $fetch<TestManagementPickerOptions>(
      `/api/projects/${props.projectId}/test-management/options`,
      {
        query,
      },
    );
    if (request !== optionsRequest) return;
    options.value = loaded;
    optionsError.value = null;
  } catch (err) {
    if (request !== optionsRequest) return;
    options.value = { projects: [], statuses: [], folders: [] };
    optionsError.value = errorMessage(err, 'The tool could not be read.');
  }
}

async function load() {
  loading.value = true;
  try {
    const loaded = await $fetch<{
      binding: ResolvedTestManagementBinding;
      connections: TestManagementConnectionSummary[];
    }>(`/api/projects/${props.projectId}/test-management`);
    connections.value = loaded.connections;
    applyBinding(loaded.binding);
    await loadOptions();
  } catch (err) {
    toast.add({ title: 'Could not load the test management binding', description: errorMessage(err), color: 'error' });
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (hasTestManagementProblem(problems.value)) return;
  saving.value = true;
  try {
    const saved = await $fetch<{ binding: ResolvedTestManagementBinding }>(
      `/api/projects/${props.projectId}/test-management`,
      { method: 'PUT', body: testManagementFromForm(form) },
    );
    applyBinding(saved.binding);
    savedCount.value += 1;
    toast.add({ title: 'Test management binding saved', color: 'success' });
  } catch (err) {
    toast.add({ title: 'Could not save the binding', description: errorMessage(err), color: 'error' });
  } finally {
    saving.value = false;
  }
}

// Another connection or project means other projects, statuses and folders; the old project and folder do not carry over.
watch(
  () => form.connectionId,
  (_, previous) => {
    if (loading.value) return;
    applyConnectionChange(form, previous);
    void loadOptions();
  },
);
watch(
  () => form.providerProjectKey,
  (_, previous) => {
    if (loading.value) return;
    if (previous) form.folderId = '';
    void loadOptions();
  },
);
onMounted(load);
</script>

<template>
  <div data-shot="project-test-management-binding" data-testid="test-management-binding">
    <SectionCard
      icon="i-lucide-list-checks"
      title="Test management"
      subtitle="Match this project’s tests against the test cases of a Zephyr Scale Cloud project"
    >
      <template #actions>
        <HelpHint topic="integrations.test-management" />
        <UButton
          label="Save"
          icon="i-lucide-check"
          size="sm"
          :loading="saving"
          :disabled="loading || !dirty || hasTestManagementProblem(problems)"
          data-testid="test-management-save"
          @click="save"
        />
      </template>

      <LoadingState v-if="loading" />
      <div v-else-if="connections.length === 0" class="text-sm text-muted" data-testid="test-management-no-connection">
        No test management connection yet — connect Zephyr Scale Cloud in
        <ULink to="/settings/integrations" class="underline decoration-dotted">Settings → Integrations</ULink> first.
      </div>
      <div v-else class="space-y-6">
        <UAlert
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          title="Piwi sends nothing to Zephyr Scale Cloud yet"
          description="The binding, the catalog of test cases and the mapping summary below work today. Dry run is on for a new binding, and results are not sent to the tool either way."
          data-testid="test-management-truthful-copy"
        />

        <UAlert
          v-if="bound && optionsError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="The tool’s projects, statuses and folders could not be read"
          :description="optionsError"
          data-testid="test-management-options-error"
        />

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Connection">
            <USelectMenu
              v-model="form.connectionId"
              :items="connectionItems"
              value-key="value"
              class="w-full"
              data-testid="test-management-connection"
            />
          </UFormField>
          <UFormField label="Project" :error="problems.project ?? undefined" :class="{ 'opacity-60': !bound }">
            <USelectMenu
              v-model="form.providerProjectKey"
              :items="projectItems"
              value-key="value"
              searchable
              create-item
              :disabled="!bound"
              placeholder="Project key"
              class="w-full"
              data-testid="test-management-project"
              @create="createProject"
            >
              <template #create-item-label="{ item }">Use {{ item.trim().toUpperCase() }}</template>
            </USelectMenu>
          </UFormField>
        </div>

        <template v-if="bound">
          <div class="grid gap-2 sm:grid-cols-2">
            <USwitch v-model="form.enabled" label="Enabled" description="Off keeps the binding but pauses its use" />
            <USwitch
              v-model="form.dryRun"
              label="Dry run"
              description="On for a new binding. Nothing is sent to the tool for now, either way."
              data-testid="test-management-dry-run"
            />
          </div>

          <div>
            <p class="text-xs font-medium text-muted mb-2">Where a test’s case key comes from</p>
            <div class="grid gap-2 sm:grid-cols-2">
              <USwitch
                v-model="form.keySources.tags"
                label="Its tags"
                description="A tag that matches the test case key pattern, with no @"
                data-testid="test-management-key-tags"
              />
              <USwitch
                v-model="form.keySources.externalId"
                label="Its external ID"
                description="When the ID matches the same pattern"
                data-testid="test-management-key-external-id"
              />
            </div>
            <p v-if="problems.keySources" class="mt-1 text-xs text-error">{{ problems.keySources }}</p>
          </div>

          <div>
            <p class="text-sm font-semibold text-highlighted mb-2">Runs in scope</p>
            <TrackerRunScopeFields v-model="form.scope" />
          </div>

          <div class="space-y-4" data-tour="test-management-run-name">
            <p class="text-sm font-semibold text-highlighted flex items-center gap-1">
              Test run <HelpHint topic="integrations.test-management-run-name" />
            </p>
            <UFormField label="Name" :error="problems.nameTemplate ?? undefined">
              <UInput
                v-model="form.nameTemplate"
                class="w-full font-mono"
                placeholder="Automation · {branch} · {environment} · Piwi #{runId}"
                aria-label="Test run name"
                data-testid="test-management-name-template"
              />
            </UFormField>
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField label="Folder">
                <USelectMenu v-model="form.folderId" :items="folderItems" value-key="value" class="w-full" />
              </UFormField>
              <UFormField label="Version">
                <UInput v-model="form.version" placeholder="Optional" class="w-full" />
              </UFormField>
            </div>
          </div>

          <div class="space-y-4">
            <p class="text-sm font-semibold text-highlighted">Result statuses</p>
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField label="Pass">
                <USelectMenu
                  v-model="form.statuses.pass"
                  :items="statusItems"
                  searchable
                  create-item
                  class="w-full"
                  @create="(name: string) => createStatus('pass', name)"
                />
              </UFormField>
              <UFormField label="Fail">
                <USelectMenu
                  v-model="form.statuses.fail"
                  :items="statusItems"
                  searchable
                  create-item
                  class="w-full"
                  @create="(name: string) => createStatus('fail', name)"
                />
              </UFormField>
              <UFormField label="Flaky (optional)" :error="problems.flaky ?? undefined">
                <USelectMenu
                  v-model="flakyStatus"
                  :items="statusItems"
                  searchable
                  create-item
                  clear
                  placeholder="None"
                  data-testid="test-management-status-flaky"
                  class="w-full"
                  @create="(name: string) => createStatus('flaky', name)"
                />
              </UFormField>
              <UFormField label="Not executed">
                <USelectMenu
                  v-model="form.statuses.notExecuted"
                  :items="statusItems"
                  searchable
                  create-item
                  class="w-full"
                  @create="(name: string) => createStatus('notExecuted', name)"
                />
              </UFormField>
              <UFormField label="A flaky test is reported as" description="A test that passed only after a retry">
                <USelectMenu v-model="form.flakyAs" :items="flakyItems" value-key="value" class="w-full" />
              </UFormField>
              <UFormField label="A skipped test">
                <USelectMenu v-model="form.skippedAs" :items="skippedItems" value-key="value" class="w-full" />
              </UFormField>
            </div>
            <USwitch
              v-model="form.includeError"
              label="Add the first line of the error to a failed result"
              description="Off by default: an error message can carry data from the application"
            />
          </div>

          <div v-if="selectedConnection?.status === 'failed'" class="text-xs text-warning">
            The tool refused this connection’s token. Check it in
            <ULink to="/settings/integrations" class="underline decoration-dotted">Settings → Integrations</ULink>.
          </div>
        </template>

        <TestManagementMappingSummary v-if="bound && !dirty" :key="savedCount" :project-id="projectId" />
        <p v-else-if="bound" class="text-sm text-muted">
          Save your changes to see how your tests map onto the catalog.
        </p>
      </div>
    </SectionCard>
  </div>
</template>
