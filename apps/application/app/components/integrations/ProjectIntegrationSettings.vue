<script setup lang="ts">
/**
 * The per-project tracker binding form (admin, project Settings tab): which
 * connection and Jira project/issue type a failure files into, the default
 * labels and assignee, values for the fields that issue type requires, the
 * ticket language, what a ticket carries, the write-back policies and the runs
 * they follow, with values for the fields their transitions ask for, the owner
 * routes, and automatic creation with its rules, guards and a preview of what
 * the rules file. Saves the whole resolved binding to
 * PUT /api/projects/:id/integrations.
 *
 * The form holds strings (never null) so the inputs bind cleanly; the server
 * normalizes and clamps the payload on save.
 */
import { DEFAULT_PROJECT_INTEGRATION, type ResolvedProjectIntegration } from '#shared/integrations/binding';
import { NOTE_INTERVALS, type NoteInterval } from '#shared/integrations/automation';
import {
  autoCreateRuleFromForm,
  autoCreateRuleToForm,
  runScopeFromForm,
  runScopeToForm,
  type AutoCreateRuleForm,
} from '~/utils/tracker-binding-form';
import { SUPPORTED_LOCALES } from '#shared/integrations/messages';
import { JIRA_NO_PROJECTS_HINT, jiraProjectUrl } from '#shared/integrations/jira-setup';
import { requiredFieldsToFill, type FieldValues } from '#shared/integrations/fields';
import type { TrackerSummary, TrackerProjectOption, TrackerIssueTypeOption } from '#shared/integrations/types';

const props = defineProps<{ projectId: number }>();
const toast = useToast();

interface RouteForm {
  owner: string;
  projectKey: string;
  componentId: string;
  assigneeAccountId: string;
  labels: string;
}

const form = reactive({
  connectionId: 0,
  projectKey: '',
  issueType: '',
  defaultAssignee: '',
  locale: '' as '' | 'en' | 'fr',
  labels: '',
  fieldDefaults: {} as FieldValues,
  include: { ...DEFAULT_PROJECT_INTEGRATION.include },
  policies: {
    ...DEFAULT_PROJECT_INTEGRATION.policies,
    scope: runScopeToForm(DEFAULT_PROJECT_INTEGRATION.policies.scope),
    fixTransitionId: '',
    reopenTransitionId: '',
  },
  ownerRoutes: [] as RouteForm[],
  autoCreate: {
    ...DEFAULT_PROJECT_INTEGRATION.autoCreate,
    rules: DEFAULT_PROJECT_INTEGRATION.autoCreate.rules.map(autoCreateRuleToForm) as AutoCreateRuleForm[],
  },
});

const connections = ref<TrackerSummary[]>([]);
const jiraProjects = ref<TrackerProjectOption[]>([]);
const issueTypes = ref<TrackerIssueTypeOption[]>([]);
const loading = ref(true);
const saving = ref(false);

const noteIntervalItems: Array<{ label: string; value: NoteInterval }> = NOTE_INTERVALS.map((interval) => ({
  label: interval === 'day' ? 'once a day' : 'once a week',
  value: interval,
}));

const localeItems = [
  { label: 'Inherit from connection', value: '' },
  ...SUPPORTED_LOCALES.map((l) => ({ label: l, value: l })),
];
const connectionItems = computed(() => [
  { label: 'None — unbound', value: 0 },
  ...connections.value.map((c) => ({ label: c.name, value: c.id })),
]);
const trackerIcon = useTrackerIcon();
const projectKeyItems = computed(() =>
  jiraProjects.value.map((p) => ({
    label: `${p.key} — ${p.name}`,
    value: p.key,
    avatar: trackerIcon(form.connectionId, p.icon),
  })),
);
const issueTypeItems = computed(() =>
  issueTypes.value.map((t) => ({ label: t.name, value: t.id, avatar: trackerIcon(form.connectionId, t.icon) })),
);
const projectAvatar = computed(() => projectKeyItems.value.find((p) => p.value === form.projectKey)?.avatar);
const issueTypeAvatar = computed(() => issueTypeItems.value.find((t) => t.value === form.issueType)?.avatar);

/** The connection the project list was last loaded for, so an empty list is not shown while loading. */
const projectsLoadedFor = ref(0);

async function loadPickers() {
  if (!form.connectionId) {
    jiraProjects.value = [];
    issueTypes.value = [];
    return;
  }
  const connectionId = form.connectionId;
  try {
    const { projects } = await $fetch<{ projects: TrackerProjectOption[] }>(
      `/api/integrations/connections/${connectionId}/projects`,
    );
    jiraProjects.value = projects;
  } catch {
    jiraProjects.value = [];
  }
  projectsLoadedFor.value = connectionId;
  await loadIssueTypes();
}

const selectedConnection = computed(() => connections.value.find((c) => c.id === form.connectionId) ?? null);
/** The chosen Jira project's page, to check it (and its permissions) in Jira. */
const projectLink = computed(() =>
  selectedConnection.value?.baseUrl && form.projectKey
    ? jiraProjectUrl(selectedConnection.value.baseUrl, form.projectKey)
    : null,
);
const noProjectsHelp = computed(() =>
  form.connectionId && projectsLoadedFor.value === form.connectionId && jiraProjects.value.length === 0
    ? JIRA_NO_PROJECTS_HINT
    : undefined,
);

async function loadIssueTypes() {
  if (!form.connectionId || !form.projectKey) {
    issueTypes.value = [];
    return;
  }
  try {
    const { issueTypes: t } = await $fetch<{ issueTypes: TrackerIssueTypeOption[] }>(
      `/api/integrations/connections/${form.connectionId}/projects/${encodeURIComponent(form.projectKey)}/issue-types`,
    );
    issueTypes.value = t;
  } catch {
    issueTypes.value = [];
  }
}

function fromBinding(b: ResolvedProjectIntegration) {
  form.connectionId = b.connectionId ?? 0;
  form.projectKey = b.projectKey ?? '';
  form.issueType = b.issueType ?? '';
  form.defaultAssignee = b.defaultAssignee ?? '';
  form.fieldDefaults = { ...(b.fieldDefaults ?? {}) };
  form.locale = b.locale ?? '';
  form.labels = (b.labels ?? []).join(', ');
  form.include = { ...b.include };
  form.policies = {
    ...b.policies,
    scope: runScopeToForm(b.policies.scope),
    fixTransitionId: b.policies.fixTransitionId ?? '',
    reopenTransitionId: b.policies.reopenTransitionId ?? '',
  };
  form.ownerRoutes = (b.ownerRoutes ?? []).map((r) => ({
    owner: r.owner,
    projectKey: r.projectKey ?? '',
    componentId: r.componentId ?? '',
    assigneeAccountId: r.assigneeAccountId ?? '',
    labels: (r.labels ?? []).join(', '),
  }));
  form.autoCreate = { ...b.autoCreate, rules: b.autoCreate.rules.map(autoCreateRuleToForm) };
}

function toBinding(): Partial<ResolvedProjectIntegration> {
  const list = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    connectionId: form.connectionId || null,
    projectKey: form.projectKey || null,
    issueType: form.issueType || null,
    defaultAssignee: form.defaultAssignee || null,
    fieldDefaults: form.fieldDefaults,
    locale: form.locale || null,
    labels: list(form.labels),
    include: { ...form.include },
    policies: {
      ...form.policies,
      scope: runScopeFromForm(form.policies.scope),
      fixTransitionId: form.policies.fixTransitionId || null,
      reopenTransitionId: form.policies.reopenTransitionId || null,
    },
    ownerRoutes: form.ownerRoutes
      .filter((r) => r.owner.trim())
      .map((r) => ({
        owner: r.owner.trim(),
        projectKey: r.projectKey || null,
        componentId: r.componentId || null,
        assigneeAccountId: r.assigneeAccountId || null,
        labels: list(r.labels),
      })),
    autoCreate: { ...form.autoCreate, rules: form.autoCreate.rules.map(autoCreateRuleFromForm) },
  };
}

/** The binding as the form holds it, for the automatic-creation preview. */
const draftBinding = computed(() => toBinding());

async function load() {
  loading.value = true;
  try {
    const [binding, status] = await Promise.all([
      $fetch<ResolvedProjectIntegration>(`/api/projects/${props.projectId}/integrations`),
      $fetch<{ trackers: TrackerSummary[] }>(`/api/integrations/status`).catch(() => ({ trackers: [] })),
    ]);
    fromBinding(binding);
    connections.value = status.trackers ?? [];
    await loadPickers();
  } catch (err) {
    toast.add({ title: 'Could not load the binding', description: errorMessage(err), color: 'error' });
  } finally {
    loading.value = false;
  }
}

function addRoute() {
  form.ownerRoutes.push({ owner: '', projectKey: '', componentId: '', assigneeAccountId: '', labels: '' });
}
function removeRoute(i: number) {
  form.ownerRoutes.splice(i, 1);
}

async function save() {
  saving.value = true;
  try {
    const saved = await $fetch<ResolvedProjectIntegration>(`/api/projects/${props.projectId}/integrations`, {
      method: 'PUT',
      body: toBinding(),
    });
    fromBinding(saved);
    toast.add({ title: 'Integration binding saved', color: 'success' });
  } catch (err) {
    toast.add({ title: 'Could not save the binding', description: errorMessage(err), color: 'error' });
  } finally {
    saving.value = false;
  }
}

watch(() => form.connectionId, loadPickers);
watch(() => form.projectKey, loadIssueTypes);
onMounted(load);

// ── Jira fields: what the chosen issue type's create screen requires ──────────
const {
  fields: screenFields,
  loading: fieldsLoading,
  error: fieldsError,
} = useTrackerFields(
  () => form.connectionId || null,
  () => form.projectKey || null,
  () => form.issueType || null,
);
/** The required fields to give a default: required, not filled by Jira, not managed by Piwi. */
const requiredFields = computed(() => requiredFieldsToFill(screenFields.value));
</script>

<template>
  <div data-shot="project-integration-binding">
    <SectionCard
      icon="i-lucide-ticket"
      title="Issue tracker"
      subtitle="File this project's failures into Jira and keep the ticket in sync"
    >
      <template #actions>
        <UButton label="Save" icon="i-lucide-check" size="sm" :loading="saving" :disabled="loading" @click="save" />
      </template>

      <LoadingState v-if="loading" />
      <div v-else-if="connections.length === 0" class="text-sm text-muted">
        No tracker connection yet — connect Jira in
        <ULink to="/settings/integrations" class="underline decoration-dotted">Settings → Integrations</ULink> first.
      </div>
      <div v-else class="space-y-6">
        <!-- Destination -->
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Connection">
            <USelectMenu v-model="form.connectionId" :items="connectionItems" value-key="value" class="w-full" />
          </UFormField>
          <UFormField label="Ticket language">
            <USelectMenu v-model="form.locale" :items="localeItems" value-key="value" class="w-full" />
          </UFormField>
          <UFormField label="Jira project" :help="noProjectsHelp">
            <template v-if="projectLink" #hint>
              <OutboundLink :href="projectLink">Open in Jira</OutboundLink>
            </template>
            <USelectMenu
              v-model="form.projectKey"
              :items="projectKeyItems"
              :avatar="projectAvatar"
              value-key="value"
              searchable
              create-item
              placeholder="Project key"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Issue type">
            <USelectMenu
              v-model="form.issueType"
              :items="issueTypeItems"
              :avatar="issueTypeAvatar"
              value-key="value"
              placeholder="Issue type"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Default assignee (account id)">
            <UInput v-model="form.defaultAssignee" placeholder="Jira account id" class="w-full" />
          </UFormField>
          <UFormField label="Labels" description="Comma-separated; added to every ticket.">
            <UInput v-model="form.labels" placeholder="team-checkout, e2e" class="w-full" />
          </UFormField>
        </div>

        <!-- Jira fields: values for what the issue type requires, and optional defaults -->
        <div v-if="form.connectionId && form.projectKey && form.issueType" data-shot="binding-jira-fields">
          <p class="text-xs font-medium text-muted mb-2 flex items-center gap-1">
            Jira fields <HelpHint topic="integrations.required-fields" />
          </p>
          <CheckResultLine v-if="fieldsLoading" state="pending" text="Reading the issue type's fields from Jira…" />
          <CheckResultLine
            v-else-if="fieldsError"
            state="warning"
            :text="fieldsError"
            hint="The binding still saves; fields Jira requires are then only checked when an issue is created."
          />
          <div v-else class="space-y-3">
            <p v-if="requiredFields.length" class="text-sm text-highlighted">
              Jira requires {{ requiredFields.length === 1 ? 'this field' : 'these fields' }} for this issue type. A
              value set here fills every issue filed from this project.
            </p>
            <p v-else class="text-sm text-muted">This issue type requires no field beyond what Piwi fills.</p>
            <TrackerFieldDefaults
              v-model="form.fieldDefaults"
              :fields="screenFields"
              :connection-id="form.connectionId"
              :project-key="form.projectKey"
            />
          </div>
        </div>

        <!-- What the ticket carries -->
        <div>
          <p class="text-xs font-medium text-muted mb-2">What the ticket carries</p>
          <div class="grid gap-2 sm:grid-cols-2">
            <USwitch v-model="form.include.includeDiagnosis" label="Diagnosis" />
            <USwitch v-model="form.include.includePatch" label="Suggested patch" />
            <USwitch v-model="form.include.includeShareLink" label="Shareable report link" />
          </div>
        </div>

        <!-- Sync policies -->
        <div data-shot="binding-sync-policies">
          <p class="text-xs font-medium text-muted mb-2">Keep the ticket honest</p>
          <div class="mb-4" data-shot="binding-write-scope">
            <p class="text-sm font-semibold text-highlighted mb-2 flex items-center gap-1">
              Runs that write to the ticket <HelpHint topic="integrations.run-scope" />
            </p>
            <TrackerRunScopeFields v-model="form.policies.scope" />
          </div>
          <div class="space-y-2">
            <USwitch v-model="form.policies.commentOnFix" label="Comment when the fix lands" />
            <div class="flex items-center gap-2">
              <USwitch v-model="form.policies.transitionOnFix" label="Transition on fix" />
              <UInput
                v-model="form.policies.fixTransitionId"
                :disabled="!form.policies.transitionOnFix"
                placeholder="transition id or status name (e.g. Done)"
                size="xs"
                class="flex-1"
              />
            </div>
            <TransitionFields
              v-if="form.policies.transitionOnFix && form.connectionId && form.projectKey"
              v-model="form.policies.fixTransitionFields"
              :connection-id="form.connectionId"
              :project-key="form.projectKey"
              :issue-type="form.issueType || null"
              from="open"
              :transition="form.policies.fixTransitionId"
              class="ps-11"
              @pick="(value) => (form.policies.fixTransitionId = value)"
            />
            <div class="flex items-center gap-2">
              <USwitch v-model="form.policies.commentOnRegression" label="Comment on regression" />
              <UInput
                v-model="form.policies.reopenTransitionId"
                placeholder="reopen transition id or status name (optional)"
                size="xs"
                class="flex-1"
              />
            </div>
            <TransitionFields
              v-if="form.policies.reopenTransitionId.trim() && form.connectionId && form.projectKey"
              v-model="form.policies.reopenTransitionFields"
              :connection-id="form.connectionId"
              :project-key="form.projectKey"
              :issue-type="form.issueType || null"
              from="done"
              :transition="form.policies.reopenTransitionId"
              class="ps-11"
              @pick="(value) => (form.policies.reopenTransitionId = value)"
            />
            <div class="flex flex-wrap items-center gap-2">
              <USwitch v-model="form.policies.commentOnNewOccurrences" label="'Still failing' note" />
              <USelect
                v-model="form.policies.newOccurrencesEvery"
                :items="noteIntervalItems"
                :disabled="!form.policies.commentOnNewOccurrences"
                size="xs"
                class="w-36"
                title="At most one note per day, or per week"
              />
              <span class="text-xs text-muted">after</span>
              <UInput
                v-model.number="form.policies.newOccurrencesMin"
                type="number"
                min="1"
                :disabled="!form.policies.commentOnNewOccurrences"
                size="xs"
                class="w-20"
                title="New occurrences since the last note before another note"
              />
              <span class="text-xs text-muted">new occurrences</span>
            </div>
            <USwitch
              v-model="form.policies.commentOnDiagnosis"
              :disabled="!form.include.includeDiagnosis"
              label="Comment when the failure is diagnosed"
              :description="
                form.include.includeDiagnosis
                  ? 'With the summary, the root cause and the category'
                  : 'Needs the diagnosis switched on in what the ticket carries, above'
              "
            />
            <USwitch
              v-model="form.policies.updateDescription"
              label="Keep the description up to date"
              description="Rewrite the description of an issue Piwi filed as the failure evolves, at most once a day and when a diagnosis completes. Never once someone edited it in the tracker."
            />
            <USwitch v-model="form.policies.resolveOnClose" label="Resolve the cluster when the ticket closes" />
            <USwitch v-model="form.policies.reopenOnTicketReopen" label="Reopen the cluster when the ticket reopens" />
            <USwitch v-model="form.policies.commentOnMerge" label="Comment on both tickets when clusters merge" />
            <USwitch
              v-model="form.policies.fileEveryBugReport"
              label="File every bug report"
              description="Create an issue for each bug report Piwi Picker sends to this project, whoever sends it"
            />
          </div>
          <UFormField
            label="Needs-ticket after (days)"
            class="mt-3 max-w-xs"
            description="How long an untracked cluster on the default branch waits before the needs-ticket queue lists it."
          >
            <UInput v-model.number="form.policies.needsTicketAfterDays" type="number" min="0" class="w-full" />
          </UFormField>
        </div>

        <!-- Owner routes -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <p class="text-xs font-medium text-muted">Owner routes</p>
            <UButton
              label="Add route"
              icon="i-lucide-plus"
              size="xs"
              variant="outline"
              color="neutral"
              @click="addRoute"
            />
          </div>
          <p class="text-xs text-muted mb-2">
            The cluster's owner picks the first matching route; its overrides fill in on top of the defaults above.
          </p>
          <div v-if="form.ownerRoutes.length === 0" class="text-xs text-muted">
            No routes — every cluster uses the defaults.
          </div>
          <div v-for="(route, i) in form.ownerRoutes" :key="i" class="grid gap-2 sm:grid-cols-5 mb-2 items-center">
            <UInput v-model="route.owner" placeholder="@team or email" size="xs" />
            <UInput v-model="route.projectKey" placeholder="project key" size="xs" />
            <UInput v-model="route.componentId" placeholder="component id" size="xs" />
            <UInput v-model="route.assigneeAccountId" placeholder="assignee id" size="xs" />
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              color="neutral"
              variant="ghost"
              :title="`Remove route ${i + 1}`"
              @click="removeRoute(i)"
            />
          </div>
        </div>

        <!-- Automatic creation -->
        <div class="rounded-lg border border-default p-3 space-y-4" data-shot="binding-auto-create">
          <div class="space-y-2">
            <p class="text-sm font-semibold text-highlighted flex items-center gap-1">
              Automatic creation <HelpHint topic="integrations.auto-create" />
            </p>
            <USwitch
              v-model="form.autoCreate.enabled"
              label="File issues automatically"
              description="After each run, file an issue for every failure that meets a rule below, through the destination and owner routes above."
            />
          </div>
          <AutoCreateRulesEditor v-model="form.autoCreate.rules" />
          <div class="space-y-2">
            <USwitch
              v-model="form.autoCreate.skipFlaky"
              label="Leave out failures that look flaky"
              description="A test of the failure passed on a retry, or passed at the commit it failed at"
            />
            <USwitch
              v-model="form.autoCreate.routeUnmatchedToDefault"
              label="File owners with no matching route into the default project"
              :description="
                form.ownerRoutes.length
                  ? 'Otherwise a failure whose owner matches no owner route is not filed'
                  : 'Applies once owner routes exist'
              "
            />
            <UFormField label="At most this many issues a day" class="max-w-xs">
              <UInput v-model.number="form.autoCreate.dailyCap" type="number" min="0" class="w-full" />
            </UFormField>
          </div>
          <AutoCreatePreviewList :project-id="projectId" :binding="draftBinding" />
        </div>
      </div>
    </SectionCard>
  </div>
</template>
