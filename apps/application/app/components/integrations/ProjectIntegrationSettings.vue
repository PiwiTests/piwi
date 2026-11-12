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
  pruneDeclaredIssueTypes,
  runScopeFromForm,
  runScopeToForm,
  type AutoCreateRuleForm,
} from '~/utils/tracker-binding-form';
import { SUPPORTED_LOCALES } from '#shared/integrations/messages';
import { normalizeTitlePrefix, TITLE_PREFIX_MAX_LENGTH } from '#shared/integrations/title-prefix';
import { JIRA_NO_PROJECTS_HINT, jiraProjectUrl } from '#shared/integrations/jira-setup';
import { requiredFieldsToAsk, type FieldValues } from '#shared/integrations/fields';
import type { TrackerSummary, TrackerProjectOption, TrackerIssueTypeOption } from '#shared/integrations/types';

const props = defineProps<{ projectId: number }>();
const toast = useToast();
const { offered: offersShareLinks, load: loadShareLinks } = useShareLinksOfferedOnOpen();

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
  declaredIssueTypes: [] as string[],
  defaultAssignee: '',
  locale: '' as '' | 'en' | 'fr',
  titlePrefix: '',
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
/** The prefix the bound connection sets for projects that set none. */
const inheritedTitlePrefix = computed(
  () => connections.value.find((c) => c.id === form.connectionId)?.titlePrefix ?? null,
);
const connectionItems = computed(() => [
  { label: 'None — unbound', value: 0 },
  ...connections.value.map((c) => ({ label: c.name, value: c.id })),
]);
const trackerIcon = useTrackerIcon();
const projectKeyItems = computed(() => [
  ...jiraProjects.value.map((p) => ({
    label: `${p.key} — ${p.name}`,
    value: p.key,
    avatar: trackerIcon(form.connectionId, p.icon),
  })),
  // A key Jira does not list, typed or saved, stays visible once chosen.
  ...(form.projectKey && !jiraProjects.value.some((p) => p.key === form.projectKey)
    ? [{ label: form.projectKey, value: form.projectKey, avatar: undefined }]
    : []),
]);
const issueTypeItems = computed(() =>
  issueTypes.value.map((t) => ({ label: t.name, value: t.id, avatar: trackerIcon(form.connectionId, t.icon) })),
);
const tagIssueTypePlaceholder = computed(() =>
  form.issueType ? 'The issue type above' : 'None: nothing is linked from tags',
);
const projectAvatar = computed(() => projectKeyItems.value.find((p) => p.value === form.projectKey)?.avatar);
const issueTypeAvatar = computed(() => issueTypeItems.value.find((t) => t.value === form.issueType)?.avatar);

/** The connection the project list was last loaded for, so an empty list is not shown while loading. */
const projectsLoadedFor = ref(0);

async function loadPickers(): Promise<TrackerIssueTypeOption[] | null> {
  if (!form.connectionId) {
    jiraProjects.value = [];
    issueTypes.value = [];
    return null;
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
  return loadIssueTypes();
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

/** Loads the chosen project's issue types; `null` when the project has none to load or the request failed. */
async function loadIssueTypes(): Promise<TrackerIssueTypeOption[] | null> {
  if (!form.connectionId || !form.projectKey) {
    issueTypes.value = [];
    return null;
  }
  try {
    const { issueTypes: t } = await $fetch<{ issueTypes: TrackerIssueTypeOption[] }>(
      `/api/integrations/connections/${form.connectionId}/projects/${encodeURIComponent(form.projectKey)}/issue-types`,
    );
    issueTypes.value = t;
    return t;
  } catch {
    issueTypes.value = [];
    return null;
  }
}

/** The types chosen for test tags are the previous project's: keep those the new project lists, or none if its list fails. */
function dropStaleDeclaredIssueTypes(listed: TrackerIssueTypeOption[] | null) {
  form.declaredIssueTypes = pruneDeclaredIssueTypes(form.declaredIssueTypes, listed);
}

function fromBinding(b: ResolvedProjectIntegration) {
  form.connectionId = b.connectionId ?? 0;
  form.projectKey = b.projectKey ?? '';
  form.issueType = b.issueType ?? '';
  form.declaredIssueTypes = [...(b.declaredIssueTypes ?? [])];
  form.defaultAssignee = b.defaultAssignee ?? '';
  form.fieldDefaults = { ...(b.fieldDefaults ?? {}) };
  form.locale = b.locale ?? '';
  form.titlePrefix = b.titlePrefix ?? '';
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
    // An empty choice is the default: the issue type above.
    declaredIssueTypes: form.declaredIssueTypes.length > 0 ? [...form.declaredIssueTypes] : null,
    defaultAssignee: form.defaultAssignee || null,
    fieldDefaults: form.fieldDefaults,
    locale: form.locale || null,
    titlePrefix: normalizeTitlePrefix(form.titlePrefix),
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
      loadShareLinks(),
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

// Choosing another connection or Jira project replaces the issue types the form can list, so the types chosen for test
// tags are checked against the new list. The first load of a saved binding keeps what it stored.
watch(
  () => form.connectionId,
  async (_, previous) => {
    const listed = await loadPickers();
    if (previous) dropStaleDeclaredIssueTypes(listed);
  },
);
watch(
  () => form.projectKey,
  async (_, previous) => {
    const listed = await loadIssueTypes();
    if (previous) dropStaleDeclaredIssueTypes(listed);
  },
);
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
/** The required fields to give a default: required and not managed by Piwi. */
const requiredFields = computed(() => requiredFieldsToAsk(screenFields.value));
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
        <div class="grid gap-4 sm:grid-cols-2" data-shot="issue-tracker-destination">
          <UFormField label="Connection">
            <USelectMenu v-model="form.connectionId" :items="connectionItems" value-key="value" class="w-full" />
          </UFormField>
          <UFormField label="Ticket language">
            <USelectMenu v-model="form.locale" :items="localeItems" value-key="value" class="w-full" />
          </UFormField>
          <UFormField
            label="Title prefix"
            description="Put before every issue title Piwi files; empty uses the connection's."
          >
            <UInput
              v-model="form.titlePrefix"
              :maxlength="TITLE_PREFIX_MAX_LENGTH"
              :placeholder="inheritedTitlePrefix ?? 'None'"
              class="w-full"
            />
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
              @create="(key: string) => (form.projectKey = key.trim().toUpperCase())"
            >
              <template #create-item-label="{ item }">Use {{ item.trim().toUpperCase() }}</template>
            </USelectMenu>
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
          <UFormField
            label="Issue types linked from test tags"
            :help="
              form.issueType || form.declaredIssueTypes.length > 0
                ? 'A key in a test tag is linked only when its issue is of one of these types. Set the tag pattern under Keys in test tags. A piwi:issue annotation is linked whatever its type.'
                : 'Nothing is linked from test tags until you choose an issue type here or above. Set the tag pattern under Keys in test tags.'
            "
          >
            <USelectMenu
              v-model="form.declaredIssueTypes"
              :items="issueTypeItems"
              value-key="value"
              multiple
              :placeholder="tagIssueTypePlaceholder"
              class="w-full"
              data-testid="binding-declared-issue-types"
            />
          </UFormField>
          <UFormField label="Default assignee">
            <TrackerAssigneePicker
              :model-value="form.defaultAssignee || undefined"
              :connection-id="form.connectionId"
              :project-key="form.projectKey"
              data-testid="binding-default-assignee"
              @update:model-value="(id) => (form.defaultAssignee = id ?? '')"
            />
          </UFormField>
          <UFormField label="Labels" description="Comma-separated; added to every ticket.">
            <UInput v-model="form.labels" placeholder="team-checkout, e2e" class="w-full" />
          </UFormField>
        </div>

        <!-- Jira fields: values for what the issue type requires, and optional defaults -->
        <div
          v-if="form.connectionId && form.projectKey && form.issueType"
          data-shot="binding-jira-fields"
          data-tour="issue-tracker-required-fields"
        >
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
            <USwitch v-if="offersShareLinks" v-model="form.include.includeShareLink" label="Shareable report link" />
          </div>
        </div>

        <!-- Sync policies -->
        <div data-shot="binding-sync-policies">
          <p class="text-xs font-medium text-muted mb-2">Keep the ticket honest</p>
          <div class="mb-4" data-shot="binding-write-scope" data-tour="issue-tracker-run-scope">
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
          <div v-for="(route, i) in form.ownerRoutes" :key="i" class="grid gap-2 sm:grid-cols-5 mb-2 items-start">
            <UInput v-model="route.owner" placeholder="@team or email" size="xs" />
            <UInput v-model="route.projectKey" placeholder="project key" size="xs" />
            <UInput v-model="route.componentId" placeholder="component id" size="xs" />
            <TrackerAssigneePicker
              :model-value="route.assigneeAccountId || undefined"
              :connection-id="form.connectionId"
              :project-key="route.projectKey || form.projectKey"
              placeholder="Default assignee"
              size="xs"
              @update:model-value="(id) => (route.assigneeAccountId = id ?? '')"
            />
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
        <div
          class="rounded-lg border border-default p-3 space-y-4"
          data-shot="binding-auto-create"
          data-tour="issue-tracker-auto-create"
        >
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
