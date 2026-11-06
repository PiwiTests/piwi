<script setup lang="ts">
import type {
  CreateIssueResponse,
  ExistingIssueCandidate,
  IssueDraft,
  IssueEntityType,
  IssueFieldProblem,
  IssueIncludeOptions,
  TrackerProjectOption,
  TrackerIssueTypeOption,
  TrackerUserOption,
} from '#shared/integrations/types';
import {
  fieldForProblem,
  hasFieldValue,
  joinFieldNames,
  MANAGED_FIELDS,
  missingRequiredFields,
  requiredFieldsToAsk,
  settableFields,
  type FieldValues,
  type TrackerField,
} from '#shared/integrations/fields';
import { withTypedValue } from '~/utils/text-format';
import { commentNodes, MAX_ISSUE_COMMENT_LENGTH, normalizeIssueComment } from '#shared/integrations/run-issue';
import { renderMarkdown } from '#shared/integrations/render-markdown';

const props = defineProps<{
  entityType: IssueEntityType;
  entityId: number;
  /** The cluster's issue, when it has one: a new issue is filed next to it, and it stays linked. */
  knownIssueKey?: string | null;
}>();

const open = defineModel<boolean>('open', { default: false });

const emit = defineEmits<{
  /** A ticket was created (key, url) or an existing one linked. */
  created: [{ key: string; url: string }];
  linked: [{ key: string; url: string }];
  /** The tracker did not answer yet: the filing is queued and the page shows it. */
  queued: [];
  /** The tracker refused the filing, which is recorded: the dialog stays open and the page shows the refusal. */
  failed: [];
}>();

const toast = useToast();
const isDesktop = useIsDesktop();

const loading = ref(false);
const creating = ref(false);
const error = ref<string | null>(null);
const draft = ref<IssueDraft | null>(null);
/** The error line at the top of the body, scrolled into view when a create or a link fails. */
const errorEl = ref<HTMLElement | null>(null);

/** What failed, as the error alert's title. */
const errorTitle = ref('Could not create the issue');

/** Show a failure where the reader is looking: the top of the body, scrolled into view. */
function showError(message: string, title = 'Could not create the issue') {
  error.value = message;
  errorTitle.value = title;
  void nextTick(() => errorEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

/** What an already-filed issue was filed for, in the toast that names it. */
const filedFor = computed(() => (props.entityType === 'bug_report' ? 'this bug report' : 'this cluster'));

/**
 * A run, or an execution with no failure cluster, may get several issues: the
 * ones already linked are listed, and never stand in for a new one.
 */
const perSubmission = computed(
  () =>
    props.entityType === 'test_run' ||
    (props.entityType === 'test_runs_case' && draft.value != null && draft.value.clusterId == null),
);

/** What the person writes, placed first in the issue under their name. */
const comment = ref('');
/** One id per opening of the dialog, or the one a queued filing holds: sending it again files nothing new. */
const submissionId = ref('');
/** The comment block as the issue will open, rendered with the server's own builder. */
const commentMarkdown = computed(() => {
  const text = normalizeIssueComment(comment.value);
  if (!text || !draft.value) return '';
  return renderMarkdown({ nodes: commentNodes(locale.value, { text, author: draft.value.filedBy ?? null }) });
});
/** What the Comment field says it does: on a cluster already tracked, it may go to the issue Piwi filed. */
const commentDescription = computed(() => {
  const under = draft.value?.filedBy ? ', under your name' : '';
  const tracked = !perSubmission.value && existing.value.length > 0;
  return tracked
    ? `What is wrong, what to improve, what test is missing. It opens the new issue${under}, or is added to the issue Piwi already filed for this cluster.`
    : `What is wrong, what to improve, what test is missing. It opens the issue${under}.`;
});
/** The linked issues with a key, as the per-submission list names them. */
const linkedKeys = computed(() => existing.value.filter((issue) => issue.key));
/** What the held submission ids are kept for. */
const submissionSubject = computed(() => `${props.entityType}:${props.entityId}`);
const previewMarkdown = computed(() =>
  commentMarkdown.value ? `${commentMarkdown.value}\n${draft.value?.markdown ?? ''}` : (draft.value?.markdown ?? ''),
);

// The editable form, seeded from the draft.
const title = ref('');
const connectionId = ref<number | undefined>(undefined);
const projectKey = ref<string | undefined>(undefined);
const issueType = ref<string | undefined>(undefined);
const labels = ref<string[]>([]);
const assignee = ref<string | undefined>(undefined);
const locale = ref<'en' | 'fr'>('en');
const LOCALE_ITEMS = [
  { label: 'English', value: 'en' },
  { label: 'Français', value: 'fr' },
];
const include = ref<IssueIncludeOptions>({
  includeDiagnosis: true,
  includePatch: true,
  includeScreenshot: false,
  includeShareLink: false,
});

// Picker options, loaded lazily from the connection.
const projects = ref<TrackerProjectOption[]>([]);
const issueTypes = ref<TrackerIssueTypeOption[]>([]);
const assignableUsers = ref<TrackerUserOption[]>([]);
const assigneeQuery = ref('');

const showAllCreate = ref(false);

const existing = computed<ExistingIssueCandidate[]>(() => draft.value?.existing ?? []);

// ── Jira fields: what the chosen issue type requires ─────────────────────────
const fieldValues = ref<FieldValues>({});
/** Fields the last create was refused over — shown even when the metadata does not mark them required. */
const fieldProblems = ref<IssueFieldProblem[]>([]);
const {
  fields: screenFields,
  loading: fieldsLoading,
  error: fieldsError,
  reload: reloadFields,
} = useTrackerFields(
  () => connectionId.value,
  () => projectKey.value,
  () => issueType.value,
);
/**
 * The fields to ask for: the required ones Piwi does not fill, those Jira
 * fills by default included, plus any Jira refused — even one its screen does
 * not list, which a workflow validator can require (a parent).
 */
const askedFields = computed(() => {
  const required = requiredFieldsToAsk(screenFields.value);
  const settable = settableFields(screenFields.value);
  const extra: TrackerField[] = [];
  for (const problem of fieldProblems.value) {
    if (MANAGED_FIELDS.has(problem.id) || [...required, ...extra].some((f) => f.id === problem.id)) continue;
    extra.push(settable.find((f) => f.id === problem.id) ?? fieldForProblem(problem));
  }
  return [...required, ...extra];
});
/** Optional fields added on demand for this issue, each shown with its input until removed. */
const addedFields = ref<TrackerField[]>([]);
/** The optional fields of the screen that can still be added. */
const addableFields = computed(() =>
  settableFields(screenFields.value).filter(
    (f) => !askedFields.value.some((a) => a.id === f.id) && !addedFields.value.some((a) => a.id === f.id),
  ),
);
function addField(field: TrackerField) {
  addedFields.value = [...addedFields.value, field];
}
/**
 * Removing added fields drops the values set for this issue: the project's
 * default, if any, applies again, and nothing else is sent for them.
 */
function removeFields(ids: string[]) {
  addedFields.value = addedFields.value.filter((f) => !ids.includes(f.id));
  const next = { ...fieldValues.value };
  for (const id of ids) {
    const fallback = draft.value?.fieldValues?.[id];
    if (fallback) next[id] = fallback;
    else delete next[id];
  }
  fieldValues.value = next;
}
const removeField = (id: string) => removeFields([id]);
// Another project or issue type has another screen: the fields added for this one go, with their values.
watch([connectionId, projectKey, issueType], () => removeFields(addedFields.value.map((f) => f.id)));
/** Optional project defaults that ride along without being asked for: "Components to Checkout". */
const projectDefaultsLine = computed(() =>
  joinFieldNames(
    addableFields.value
      .filter((f) => hasFieldValue(fieldValues.value[f.id]?.value))
      .map((f) => `${f.name} to ${fieldValues.value[f.id]!.label}`),
  ),
);
const missingFields = computed(() =>
  missingRequiredFields(screenFields.value, fieldValues.value, { assignee: !!assignee.value }),
);
const assigneeRequired = computed(() => missingFields.value.some((f) => f.id === 'assignee'));
const missingNames = computed(() => joinFieldNames(missingFields.value.map((f) => f.name)));

// Why Create is disabled, named in the footer next to the fields Jira still needs.
const blockedReason = computed(() => {
  if (draft.value && !draft.value.connectionId) return 'This project has no Jira connection to file through.';
  const need = [
    !title.value.trim() ? 'a title' : null,
    !projectKey.value ? 'a Jira project' : null,
    !issueType.value ? 'an issue type' : null,
  ].filter((x): x is string => !!x);
  if (!need.length) return null;
  const list = need.length > 1 ? `${need.slice(0, -1).join(', ')} and ${need.at(-1)}` : need[0];
  return `Pick ${list} to create the issue.`;
});

// What the issue is filed for: a cluster's issue shows on the cluster page and on
// every execution of it, whichever page it was filed from. A cluster that has an
// issue keeps it linked; the new one, its newest, becomes the issue it shows.
const description = computed(() => {
  if (props.entityType === 'bug_report')
    return 'File a Jira issue from this bug report, with its steps, evidence and failing test.';
  if (props.entityType === 'test_run')
    return 'File a Jira issue about this run, with its tests, results and failure clusters. A run can have several issues.';
  if (perSubmission.value)
    return 'File a Jira issue about this test, with its result and its run. A test with no failure cluster can have several issues.';
  const id = draft.value?.clusterId;
  if (props.knownIssueKey)
    return `Files a new issue for ${id ? `cluster #${id}` : 'the cluster'} next to ${props.knownIssueKey}, which stays linked. The new issue, with the fix plan as its body, becomes the cluster's issue on the cluster page and on each of its executions.`;
  return id
    ? `Files one issue for cluster #${id}, with its fix plan as the body. It shows on the cluster page and on each of its executions.`
    : 'File a Jira issue from this failure, with the fix plan as its body.';
});

// Setting the project's default Jira project needs the binding's permission.
const { can } = useAuth();
const canBind = computed(() => (draft.value ? can('project:manage', draft.value.projectId) : false));
/** A share link is public: only someone who may create one can put it in the ticket. */
const canShareLink = computed(() => draft.value != null && can('share:create', draft.value.projectId));
const { offered: offersShareLinks, load: loadShareLinks } = useShareLinksOfferedOnOpen();

const canCreate = computed(
  () =>
    !!connectionId.value &&
    !!projectKey.value &&
    !!issueType.value &&
    !!title.value.trim() &&
    missingFields.value.length === 0,
);

function applyDraft(d: IssueDraft) {
  draft.value = d;
  title.value = d.title;
  connectionId.value = d.connectionId ?? undefined;
  projectKey.value = d.projectKey ?? undefined;
  issueType.value = d.issueType ?? undefined;
  labels.value = [...d.labels];
  assignee.value = d.assignee ?? undefined;
  locale.value = d.locale;
  include.value = { ...d.include };
  fieldValues.value = { ...(d.fieldValues ?? {}) };
  fieldProblems.value = [];
  addedFields.value = [];
}

async function loadDraft() {
  loading.value = true;
  error.value = null;
  draft.value = null;
  try {
    const params = new URLSearchParams({ entityType: props.entityType, entityId: String(props.entityId) });
    params.set('includeDiagnosis', String(include.value.includeDiagnosis));
    params.set('includePatch', String(include.value.includePatch));
    params.set('includeScreenshot', String(include.value.includeScreenshot));
    params.set('includeShareLink', String(include.value.includeShareLink));
    const d = await $fetch<IssueDraft>(`/api/integrations/issue-draft?${params.toString()}`);
    applyDraft(d);
    // The pickers name the project and the type, with their icons, rather than a bare key and id.
    void loadProjects();
    if (projectKey.value) {
      void loadIssueTypes();
      // The prefilled assignee shows with its name and avatar rather than an account id.
      if (assignee.value) void searchAssignable();
    }
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

/** Re-fetch only the preview/labels when a toggle or the language changes. */
async function refreshPreview() {
  if (!draft.value) return;
  try {
    const params = new URLSearchParams({ entityType: props.entityType, entityId: String(props.entityId) });
    params.set('includeDiagnosis', String(include.value.includeDiagnosis));
    params.set('includePatch', String(include.value.includePatch));
    params.set('includeScreenshot', String(include.value.includeScreenshot));
    params.set('includeShareLink', String(include.value.includeShareLink));
    params.set('locale', locale.value);
    const d = await $fetch<IssueDraft>(`/api/integrations/issue-draft?${params.toString()}`);
    // Keep the person's field edits; refresh only the derived preview + labels.
    draft.value = { ...draft.value, markdown: d.markdown, document: d.document, existing: d.existing };
  } catch {
    /* a preview refresh failure is non-fatal */
  }
}

async function loadProjects() {
  if (!connectionId.value || projects.value.length) return;
  try {
    const { projects: p } = await $fetch<{ projects: TrackerProjectOption[] }>(
      `/api/integrations/connections/${connectionId.value}/projects`,
    );
    projects.value = p;
  } catch (err) {
    toast.add({ title: 'Could not load Jira projects', description: errorMessage(err), color: 'error' });
  }
}

async function loadIssueTypes() {
  if (!connectionId.value || !projectKey.value) return;
  try {
    const { issueTypes: t } = await $fetch<{ issueTypes: TrackerIssueTypeOption[] }>(
      `/api/integrations/connections/${connectionId.value}/projects/${encodeURIComponent(projectKey.value)}/issue-types`,
    );
    issueTypes.value = t;
  } catch (err) {
    toast.add({ title: 'Could not load issue types', description: errorMessage(err), color: 'error' });
  }
}

async function searchAssignable() {
  if (!connectionId.value || !projectKey.value) return;
  try {
    const params = new URLSearchParams({ project: projectKey.value, q: assigneeQuery.value });
    const { users } = await $fetch<{ users: TrackerUserOption[] }>(
      `/api/integrations/connections/${connectionId.value}/assignable?${params.toString()}`,
    );
    assignableUsers.value = users;
    for (const u of users) seenUsers.set(u.id, u);
  } catch {
    /* the modal falls back to the prefilled assignee */
  }
}

function addLabel(text: string) {
  labels.value = withTypedValue(labels.value, text);
}

// Jira's own icons beside the project and the issue type, as Jira shows them.
const trackerIcon = useTrackerIcon();
const projectItems = computed(() =>
  projects.value.map((p) => ({
    label: `${p.key} — ${p.name}`,
    value: p.key,
    avatar: trackerIcon(connectionId.value, p.icon),
  })),
);
const issueTypeItems = computed(() =>
  issueTypes.value.map((t) => ({ label: t.name, value: t.id, avatar: trackerIcon(connectionId.value, t.icon) })),
);
const projectAvatar = computed(() => projectItems.value.find((p) => p.value === projectKey.value)?.avatar);
const issueTypeAvatar = computed(() => issueTypeItems.value.find((t) => t.value === issueType.value)?.avatar);

/** Every person a search listed, so the chosen assignee keeps its name and avatar after another search. */
const seenUsers = reactive(new Map<string, TrackerUserOption>());
const userItem = (u: TrackerUserOption) => ({
  label: u.displayName || u.id,
  value: u.id,
  avatar: trackerIcon(connectionId.value, u.icon, 'round'),
});
const assigneeItems = computed(() => {
  const items = assignableUsers.value.map(userItem);
  const chosen = assignee.value ? seenUsers.get(assignee.value) : undefined;
  return chosen && !items.some((i) => i.value === chosen.id) ? [userItem(chosen), ...items] : items;
});
const assigneeAvatar = computed(() => assigneeItems.value.find((i) => i.value === assignee.value)?.avatar);

watch(open, (isOpen) => {
  if (isOpen) {
    comment.value = '';
    submissionId.value = submissionIdFor(submissionSubject.value);
    projects.value = [];
    issueTypes.value = [];
    showAllCreate.value = false;
    void loadDraft();
    void loadShareLinks();
  }
});

watch(projectKey, () => {
  issueTypes.value = [];
  void loadIssueTypes();
});

// The language rewrites the whole body, so re-render the preview.
watch(locale, () => void refreshPreview());

async function create() {
  if (!canCreate.value) return;
  creating.value = true;
  error.value = null;
  try {
    const res = await $fetch<CreateIssueResponse>('/api/integrations/issues', {
      method: 'POST',
      body: {
        entityType: props.entityType,
        entityId: props.entityId,
        connectionId: connectionId.value,
        title: title.value.trim(),
        projectKey: projectKey.value,
        issueType: issueType.value,
        labels: labels.value,
        assignee: assignee.value,
        locale: locale.value,
        include: include.value,
        fields: fieldValues.value,
        comment: normalizeIssueComment(comment.value) ?? undefined,
        submissionId: submissionId.value,
      },
    });
    if (res.status === 'done' && res.key && res.url) {
      toast.add({
        title: res.commentAdded
          ? `Your comment was added to ${res.key}`
          : res.alreadyFiled
            ? `${res.key} was already filed for ${filedFor.value}`
            : `${res.key} created`,
        ...(res.commentAdded ? { description: `${res.key} was already filed for ${filedFor.value}.` } : {}),
        color: res.alreadyFiled ? 'info' : 'success',
        actions: [{ label: 'Open', to: res.url, target: '_blank', color: 'neutral', variant: 'outline' }],
      });
      releaseSubmission(submissionSubject.value);
      emit('created', { key: res.key, url: res.url });
      open.value = false;
    } else if (res.status === 'pending') {
      toast.add({
        title: 'Filing queued',
        description: 'Jira did not answer yet. Piwi retries and links the issue once it is created.',
        color: 'info',
      });
      holdSubmission(submissionSubject.value, submissionId.value);
      emit('queued');
      open.value = false;
    } else {
      showError(res.error || 'The tracker gave no reason.');
      if (res.actionId) emit('failed');
      fieldProblems.value = [...(res.missingFields ?? []), ...(res.fieldErrors ?? [])];
      // The screen may have changed since it was read: read it again.
      if (fieldProblems.value.length) void reloadFields();
    }
  } catch (err) {
    showError(errorMessage(err));
  } finally {
    creating.value = false;
  }
}

async function linkExisting(candidate: ExistingIssueCandidate) {
  creating.value = true;
  error.value = null;
  try {
    await $fetch('/api/links', {
      method: 'POST',
      body: {
        entityType: props.entityType === 'bug_report' || perSubmission.value ? props.entityType : 'failure_cluster',
        entityId:
          props.entityType === 'bug_report' || perSubmission.value
            ? props.entityId
            : (draft.value?.clusterId ?? props.entityId),
        url: candidate.url,
        title: candidate.title,
      },
    });
    toast.add({ title: `Linked ${candidate.key}`, color: 'success' });
    emit('linked', { key: candidate.key, url: candidate.url });
    open.value = false;
  } catch (err) {
    showError(errorMessage(err), `Could not link ${candidate.key}`);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="knownIssueKey && entityType !== 'bug_report' ? 'File a new issue' : 'Create issue'"
    :description="description"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <LoadingState v-if="loading" text="Preparing the draft…" />

      <div v-else-if="!draft" class="space-y-3">
        <ErrorText v-if="error" :text="error" />
        <EmptyState v-else text="No tracker is connected." />
      </div>

      <div v-else class="space-y-4" data-tour="create-issue-draft">
        <div class="flex justify-end -mb-2">
          <HelpHint topic="integrations.create-issue" />
        </div>
        <!-- A failed create or link shows first, where the reader looks. -->
        <div v-if="error" ref="errorEl" class="scroll-mt-2" data-testid="create-issue-error">
          <UAlert color="error" variant="subtle" icon="i-lucide-circle-alert" :title="errorTitle">
            <template #description><ErrorText :text="error" mode="block" /></template>
          </UAlert>
        </div>
        <!-- Dedupe: lead with an issue that already tracks this failure. -->
        <UAlert
          v-if="existing.length && !showAllCreate && !perSubmission"
          color="warning"
          variant="subtle"
          icon="i-lucide-link"
          :title="`${existing[0]!.key} already tracks this${existing[0]!.statusText ? ` (${existing[0]!.statusText})` : ''}`"
          description="Link it to this failure instead of filing a duplicate."
        >
          <template #actions>
            <UButton size="xs" :loading="creating" @click="linkExisting(existing[0]!)"
              >Link {{ existing[0]!.key }}</UButton
            >
            <UButton size="xs" color="neutral" variant="outline" @click="showAllCreate = true">Create anyway</UButton>
          </template>
        </UAlert>

        <p v-if="perSubmission && linkedKeys.length" class="text-xs text-muted" data-testid="create-issue-linked">
          Already linked:
          <template v-for="(issue, i) in linkedKeys" :key="issue.key"
            ><template v-if="i">, </template
            ><a :href="issue.url" target="_blank" rel="noopener" :class="SENTENCE_LINK_CLASS">{{
              issue.key
            }}</a></template
          >. A new issue is filed next to them.
        </p>

        <template v-if="!existing.length || showAllCreate || perSubmission">
          <!-- No connection: a project's issues go only through the one it is bound to, with credentials. -->
          <p v-if="!draft.connectionId" class="text-xs text-muted" data-testid="create-issue-no-connection">
            This project has no Jira connection to file through: its issues go only through the connection its settings
            name, once that connection has credentials.
            <NuxtLink
              v-if="canBind"
              :to="`/projects/${draft.projectId}?tab=settings&section=issue-tracker`"
              :class="SENTENCE_LINK_CLASS"
              >Open the issue tracker settings</NuxtLink
            ><template v-else> A project admin sets it in the project settings.</template>
          </p>
          <!-- No default Jira project for this Piwi project: say so, and where to set one. -->
          <p v-else-if="!draft.projectBound" class="text-xs text-muted" data-testid="create-issue-unbound">
            This project has no default Jira project and issue type, so pick them for this issue.
            <NuxtLink
              v-if="canBind"
              :to="`/projects/${draft.projectId}?tab=settings&section=issue-tracker`"
              :class="SENTENCE_LINK_CLASS"
              >Set the defaults</NuxtLink
            ><template v-else> A project admin can set them in the project settings.</template>
          </p>
          <UFormField label="Comment" hint="Optional" :description="commentDescription">
            <UTextarea
              v-model="comment"
              :rows="3"
              autoresize
              :maxlength="MAX_ISSUE_COMMENT_LENGTH"
              class="w-full"
              data-testid="create-issue-comment"
            />
          </UFormField>
          <UFormField label="Title">
            <UInput v-model="title" class="w-full" />
          </UFormField>

          <!-- The pickers read the project's connection: none to read without one. -->
          <div v-if="draft.connectionId" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="Jira project">
              <USelectMenu
                v-model="projectKey"
                :items="projectItems"
                :avatar="projectAvatar"
                value-key="value"
                :placeholder="projectKey || 'Select a project'"
                class="w-full"
                @update:open="loadProjects"
              />
            </UFormField>
            <UFormField label="Issue type">
              <USelectMenu
                v-model="issueType"
                :items="issueTypeItems"
                :avatar="issueTypeAvatar"
                value-key="value"
                :placeholder="issueType || 'Select a type'"
                class="w-full"
                @update:open="loadIssueTypes"
              />
            </UFormField>
          </div>

          <template v-if="projectKey && issueType">
            <CheckResultLine v-if="fieldsLoading" state="pending" text="Reading the issue type's fields from Jira…" />
            <CheckResultLine
              v-else-if="fieldsError"
              state="warning"
              :text="fieldsError"
              hint="Jira still checks its required fields when the issue is created."
            />
            <div v-else-if="askedFields.length" class="space-y-2" data-shot="create-issue-fields">
              <p class="text-xs font-medium text-gray-500 flex items-center gap-1">
                Required by Jira <HelpHint topic="integrations.required-fields" />
              </p>
              <TrackerFieldsList
                v-model="fieldValues"
                :fields="askedFields"
                :connection-id="connectionId"
                :project-key="projectKey"
              />
            </div>
            <div v-if="addedFields.length" class="space-y-2" data-shot="create-issue-added-fields">
              <p class="text-xs font-medium text-gray-500">Other fields</p>
              <TrackerFieldsList
                v-model="fieldValues"
                :fields="addedFields"
                :connection-id="connectionId"
                :project-key="projectKey"
                removable
                @remove="removeField"
              />
            </div>
            <p v-if="projectDefaultsLine" class="text-xs text-muted">
              The project settings also set {{ projectDefaultsLine }}.
            </p>
            <TrackerFieldPicker
              v-if="!fieldsLoading && addableFields.length"
              :fields="addableFields"
              label="Add a field"
              @pick="addField"
            />
          </template>

          <UFormField v-if="draft.connectionId" label="Assignee">
            <USelectMenu
              v-model="assignee"
              :items="assigneeItems"
              :avatar="assigneeAvatar"
              value-key="value"
              searchable
              :placeholder="assignee || 'Unassigned'"
              class="w-full"
              @update:open="searchAssignable"
              @update:search-term="
                (q: string) => {
                  assigneeQuery = q;
                  searchAssignable();
                }
              "
            />
            <CheckResultLine
              v-if="assigneeRequired"
              state="warning"
              text="Jira requires an assignee for this issue type."
              class="mt-1"
            />
          </UFormField>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="Labels">
              <UInputMenu
                v-model="labels"
                multiple
                create-item
                class="w-full"
                :items="labels"
                data-testid="create-issue-labels"
                @create="addLabel"
              />
            </UFormField>
            <UFormField label="Language">
              <USelect v-model="locale" :items="LOCALE_ITEMS" value-key="value" class="w-full" />
            </UFormField>
          </div>

          <UFormField v-if="!perSubmission" label="Include">
            <div class="flex flex-wrap gap-4">
              <USwitch v-model="include.includeDiagnosis" label="Diagnosis" @update:model-value="refreshPreview" />
              <USwitch v-model="include.includePatch" label="Patch" @update:model-value="refreshPreview" />
              <USwitch
                v-if="offersShareLinks"
                v-model="include.includeShareLink"
                label="Share link"
                :disabled="!draft.linksBack || !canShareLink"
                :title="canShareLink ? undefined : 'A share link needs the Maintainer role or above on this project'"
                @update:model-value="refreshPreview"
              />
            </div>
            <p v-if="!draft.linksBack" class="mt-1 text-xs text-muted" data-testid="create-issue-no-links-back">
              <template v-if="isDesktop"
                >The issue cannot link back to the desktop app, which has no public address.</template
              >
              <template v-else>
                The issue cannot link back to Piwi: this instance has no public address (<code>PIWI_SITE_URL</code>).
              </template>
            </p>
          </UFormField>

          <div>
            <p class="text-xs font-medium text-gray-500 mb-1.5">Preview</p>
            <MarkdownPreview :text="previewMarkdown" max-height="16rem" />
          </div>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="flex flex-wrap items-center justify-end gap-2 w-full">
        <span
          v-if="draft && (!existing.length || showAllCreate || perSubmission) && (blockedReason || missingNames)"
          class="mr-auto text-xs text-muted"
          data-testid="create-issue-missing"
        >
          <template v-if="blockedReason">{{ blockedReason }}</template>
          <template v-else>Jira still needs {{ missingNames }}.</template>
        </span>
        <UButton color="neutral" variant="ghost" @click="open = false">Cancel</UButton>
        <UButton
          v-if="draft && (!existing.length || showAllCreate || perSubmission)"
          icon="i-simple-icons-jira"
          :loading="creating"
          :disabled="!canCreate"
          @click="create"
        >
          Create
        </UButton>
      </div>
    </template>
  </UModal>
</template>
