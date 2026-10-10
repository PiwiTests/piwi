<script setup lang="ts">
/**
 * The project's test function catalog — page-object methods/helpers that a
 * recorded browser-extension session is matched against so a raw locator
 * span can collapse into a call to the project's own code. See
 * `packages/core/src/function-match.ts` for the matching algorithm and
 * `extension/AGENTS.md` for how the extension consumes this list.
 */
import type { ProjectDetails, TestFunctionsResponse, TestFunctionInfo, TestFunctionStepAction } from '~~/types/api';
import { buildExtractionPrompt, LOW_CONFIDENCE_THRESHOLD } from '#shared/test-function-extract-prompt';
import { PICKER_CHROME_URL, PICKER_FIREFOX_URL } from '#shared/companion-links';

const route = useRoute();
const projectId = route.params.id as string;
const toast = useToast();
const { aiStatus } = useAiStatus();

const { data: project } = await useFetch<ProjectDetails>(`/api/projects/${projectId}`);
const {
  data: catalog,
  refresh,
  status,
} = await useFetch<TestFunctionsResponse>(`/api/projects/${projectId}/test-functions`);

useHead(
  computed(() => ({
    title: `Test functions — ${project.value?.label || project.value?.name || 'Project'} — Piwi Dashboard`,
  })),
);

const entries = computed(() => catalog.value?.items ?? []);

const KIND_ITEMS = [
  { label: 'Page-object method', value: 'page-object-method' },
  { label: 'Helper function', value: 'helper' },
  { label: 'Fixture', value: 'fixture' },
];
const PARAM_TYPE_ITEMS = [
  { label: 'string', value: 'string' },
  { label: 'number', value: 'number' },
  { label: 'boolean', value: 'boolean' },
  { label: 'object', value: 'object' },
];
const ACTION_ITEMS: Array<{ label: string; value: TestFunctionStepAction }> = [
  { label: 'goto', value: 'goto' },
  { label: 'click', value: 'click' },
  { label: 'fill', value: 'fill' },
  { label: 'check', value: 'check' },
  { label: 'uncheck', value: 'uncheck' },
  { label: 'selectOption', value: 'selectOption' },
  { label: 'press', value: 'press' },
  { label: 'assertVisible', value: 'assertVisible' },
];
const PARAM_SOURCE_ITEMS = [
  { label: 'element text', value: 'text' },
  { label: 'field value', value: 'value' },
  { label: 'test id', value: 'testId' },
];

const showModal = ref(false);
const saving = ref(false);
/** Null in add mode; the id being edited otherwise — decides POST-create vs PUT-update in `save()`. */
const editingId = ref<number | null>(null);

type ParamType = 'string' | 'number' | 'boolean' | 'object';
type ParamFrom = 'text' | 'value' | 'testId';

/** `fields` is edited as one comma-separated string and split on save — an options bag has a handful of keys, so a full sub-editor would cost more than it's worth. */
interface FormParam {
  name: string;
  type: ParamType;
  fields: string;
}
interface FormParamSource {
  param: string;
  path: string;
  stepIndex: number;
  from: ParamFrom;
}

function emptyForm() {
  return {
    name: '',
    kind: 'page-object-method' as 'page-object-method' | 'helper' | 'fixture',
    module: '',
    receiver: '',
    importName: '',
    urlPattern: '',
    params: [] as FormParam[],
    steps: [{ action: 'click' as TestFunctionStepAction, role: '', name: '', testId: '' }],
    paramSources: [] as FormParamSource[],
  };
}

const form = ref(emptyForm());

const showPasteCode = ref(false);
const pastedCode = ref('');
const extracting = ref(false);
const aiExtracted = ref(false);
const extractedConfidence = ref<number | null>(null);
const extractedNotes = ref<string | null>(null);
const aiResponseText = ref('');
const applyingResponse = ref(false);

/** True when the current proposal is one the user should look at hard before saving — mirrors `LOW_CONFIDENCE_THRESHOLD`. */
const lowConfidence = computed(
  () => aiExtracted.value && extractedConfidence.value != null && extractedConfidence.value < LOW_CONFIDENCE_THRESHOLD,
);

/** Object params are the ones a param source can target a field of. */
const objectParamNames = computed(
  () => new Set(form.value.params.filter((p) => p.type === 'object' && p.name.trim()).map((p) => p.name.trim())),
);

interface ExtractionProposal {
  name: string;
  kind: 'page-object-method' | 'helper' | 'fixture';
  receiver: string | null;
  importName: string | null;
  params: Array<{ name: string; type: ParamType; fields?: string[] }>;
  steps: Array<{
    action: TestFunctionStepAction;
    target: { role?: string | null; name?: string | null; testId?: string | null };
  }>;
  paramSources: Array<{ param: string; path?: string | null; stepIndex: number; from: ParamFrom }>;
  confidence: number;
  notes: string | null;
}

function resetExtractionState() {
  showPasteCode.value = false;
  pastedCode.value = '';
  aiResponseText.value = '';
  aiExtracted.value = false;
  extractedConfidence.value = null;
  extractedNotes.value = null;
}

function openAdd() {
  form.value = emptyForm();
  editingId.value = null;
  resetExtractionState();
  showModal.value = true;
}

/** Loads an existing entry back into the same modal — the PUT endpoint has existed since the catalog shipped, but nothing reached it, so a typo meant delete-and-re-add. */
function openEdit(entry: TestFunctionInfo) {
  const e = entry.entry;
  form.value = {
    name: e.name,
    kind: e.kind,
    module: e.module,
    receiver: e.receiver ?? '',
    importName: e.importName ?? '',
    urlPattern: e.urlPattern ?? '',
    params: e.params.map((p) => ({ name: p.name, type: p.type, fields: (p.fields ?? []).join(', ') })),
    steps: e.steps.map((s) => ({
      action: s.action,
      role: s.target.role ?? '',
      name: s.target.name ?? '',
      testId: s.target.testId ?? '',
    })),
    paramSources: e.paramSources.map((s) => ({
      param: s.param,
      path: s.path ?? '',
      stepIndex: s.stepIndex,
      from: s.from,
    })),
  };
  if (form.value.steps.length === 0) form.value.steps = emptyForm().steps;
  editingId.value = entry.id;
  resetExtractionState();
  showModal.value = true;
}

/** Fills the form from a proposal — shared by the AI-calling extract flow and the paste-response-back flow. Never saves anything itself; the user still reviews and hits Save. */
function applyProposal(proposal: ExtractionProposal) {
  form.value.name = proposal.name;
  form.value.kind = proposal.kind;
  form.value.receiver = proposal.receiver ?? '';
  form.value.importName = proposal.importName ?? '';
  form.value.params = proposal.params.map((p) => ({
    name: p.name,
    type: p.type,
    fields: (p.fields ?? []).join(', '),
  }));
  form.value.steps = proposal.steps.map((s) => ({
    action: s.action,
    role: s.target.role ?? '',
    name: s.target.name ?? '',
    testId: s.target.testId ?? '',
  }));
  if (form.value.steps.length === 0) form.value.steps = emptyForm().steps;
  form.value.paramSources = proposal.paramSources.map((s) => ({
    param: s.param,
    path: s.path ?? '',
    stepIndex: s.stepIndex,
    from: s.from,
  }));
  aiExtracted.value = true;
  extractedConfidence.value = proposal.confidence;
  extractedNotes.value = proposal.notes;
}

async function extractFromCode() {
  if (!pastedCode.value.trim()) {
    toast.add({ title: 'Paste some function code first', color: 'error' });
    return;
  }
  extracting.value = true;
  try {
    const { proposal } = await $fetch<{ proposal: ExtractionProposal }>(
      `/api/projects/${projectId}/test-functions/extract`,
      { method: 'POST', body: { code: pastedCode.value } },
    );
    applyProposal(proposal);
    toast.add({ title: 'Extracted — review the fields below before saving', color: 'success' });
  } catch (error: unknown) {
    toast.add({ title: 'Extraction failed', description: errorMessage(error), color: 'error' });
  } finally {
    extracting.value = false;
  }
}

/** Copies the full extraction prompt (rules + JSON schema + pasted code) for pasting into any external AI chat — no Piwi AI credits spent. */
async function copyPromptForOwnAi() {
  if (!pastedCode.value.trim()) {
    toast.add({ title: 'Paste some function code first', color: 'error' });
    return;
  }
  try {
    await navigator.clipboard.writeText(buildExtractionPrompt(pastedCode.value));
    toast.add({
      title: 'Prompt copied',
      description: 'Paste it into your AI chat, then paste the reply below.',
      color: 'success',
    });
  } catch (error: unknown) {
    toast.add({ title: 'Failed to copy the prompt', description: errorMessage(error), color: 'error' });
  }
}

/** Validates a manually pasted AI reply against the same schema the AI-calling endpoint uses — no AI call here, just parsing. */
async function applyPastedResponse() {
  if (!aiResponseText.value.trim()) {
    toast.add({ title: 'Paste the AI response first', color: 'error' });
    return;
  }
  applyingResponse.value = true;
  try {
    const { proposal } = await $fetch<{ proposal: ExtractionProposal }>(
      `/api/projects/${projectId}/test-functions/validate-proposal`,
      { method: 'POST', body: { responseText: aiResponseText.value } },
    );
    applyProposal(proposal);
    toast.add({ title: 'Applied — review the fields below before saving', color: 'success' });
  } catch (error: unknown) {
    toast.add({ title: "Couldn't apply that response", description: errorMessage(error), color: 'error' });
  } finally {
    applyingResponse.value = false;
  }
}

function addParam() {
  form.value.params.push({ name: '', type: 'string', fields: '' });
}
function removeParam(index: number) {
  form.value.params.splice(index, 1);
}

function addStep() {
  form.value.steps.push({ action: 'click', role: '', name: '', testId: '' });
}
function removeStep(index: number) {
  if (form.value.steps.length <= 1) return;
  form.value.steps.splice(index, 1);
}

function addParamSource() {
  form.value.paramSources.push({ param: '', path: '', stepIndex: 0, from: 'value' });
}
function removeParamSource(index: number) {
  form.value.paramSources.splice(index, 1);
}

async function save() {
  if (!form.value.name.trim()) {
    toast.add({ title: 'Name is required', color: 'error' });
    return;
  }
  if (!form.value.module.trim()) {
    toast.add({ title: 'Module is required', color: 'error' });
    return;
  }

  saving.value = true;
  const body = {
    name: form.value.name.trim(),
    kind: form.value.kind,
    module: form.value.module.trim(),
    receiver: form.value.kind === 'page-object-method' ? form.value.receiver.trim() || null : null,
    importName: form.value.kind === 'page-object-method' ? form.value.importName.trim() || null : null,
    urlPattern: form.value.urlPattern.trim() || null,
    params: form.value.params
      .filter((p) => p.name.trim())
      .map((p) => ({
        name: p.name.trim(),
        type: p.type,
        ...(p.type === 'object'
          ? {
              fields: p.fields
                .split(',')
                .map((f) => f.trim())
                .filter(Boolean),
            }
          : {}),
      })),
    steps: form.value.steps.map((s) => ({
      action: s.action,
      target: {
        role: s.role.trim() || null,
        name: s.name.trim() || null,
        testId: s.testId.trim() || null,
      },
    })),
    paramSources: form.value.paramSources
      .filter((s) => s.param.trim())
      .map((s) => ({
        param: s.param.trim(),
        path: s.path.trim() || null,
        stepIndex: s.stepIndex,
        from: s.from,
      })),
    source: aiExtracted.value ? ('ai-extracted' as const) : undefined,
    confidence: aiExtracted.value ? (extractedConfidence.value ?? undefined) : undefined,
  };

  const isEdit = editingId.value != null;
  try {
    if (isEdit) {
      await $fetch(`/api/test-functions/${editingId.value}`, { method: 'PATCH', body });
    } else {
      await $fetch(`/api/projects/${projectId}/test-functions`, { method: 'POST', body });
    }
    toast.add({ title: isEdit ? 'Function updated' : 'Function added', color: 'success' });
    showModal.value = false;
    await refresh();
  } catch (error: unknown) {
    toast.add({
      title: isEdit ? 'Failed to update function' : 'Failed to add function',
      description: errorMessage(error),
      color: 'error',
    });
  } finally {
    saving.value = false;
  }
}

// Deleting asks for confirmation: a catalog entry is hand-authored work — a
// pattern, its params, their sources — and nothing here undoes it.
const functionToDelete = ref<TestFunctionInfo | null>(null);
const isDeleteConfirmOpen = ref(false);

function confirmRemove(entry: TestFunctionInfo) {
  functionToDelete.value = entry;
  isDeleteConfirmOpen.value = true;
}

async function remove() {
  const entry = functionToDelete.value;
  if (!entry) return;
  isDeleteConfirmOpen.value = false;
  try {
    await $fetch(`/api/test-functions/${entry.id}`, { method: 'DELETE' });
    toast.add({ title: 'Function removed', color: 'success' });
    await refresh();
  } catch (error: unknown) {
    toast.add({ title: 'Failed to remove function', description: errorMessage(error), color: 'error' });
  } finally {
    functionToDelete.value = null;
  }
}

function describeSteps(entry: TestFunctionInfo): string {
  return entry.entry.steps
    .map((s) => `${s.action}(${s.target.role ?? s.target.testId ?? s.target.name ?? '?'})`)
    .join(' → ');
}
</script>

<template>
  <UDashboardPanel id="project-test-functions">
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
          <BreadcrumbNav
            :items="[
              { label: 'Home', icon: 'i-lucide-house', to: '/' },
              { label: 'Projects', to: '/projects' },
              { label: project?.label || project?.name || 'Project', to: `/projects/${projectId}` },
              { label: 'Test functions' },
            ]"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-4 space-y-4">
        <SectionCard title="Test function catalog" icon="i-lucide-function-square" :count="entries.length || null">
          <template #subtitle>
            Page-object methods and helpers a recording is matched against, in the
            <DocLink to="features/extension#connecting-to-a-piwi-instance" no-icon class="text-primary hover:underline"
              >Piwi Picker extension</DocLink
            >
            or
            <DocLink to="features/editor-recording" no-icon class="text-primary hover:underline">your editor</DocLink>,
            to generate calls to your own code instead of raw locator lines.
          </template>
          <template #actions>
            <UButton label="Add function" icon="i-lucide-plus" size="sm" @click="openAdd" />
          </template>

          <LoadingState v-if="status === 'pending'" />
          <EmptyState
            v-else-if="entries.length === 0"
            icon="i-lucide-function-square"
            text="No functions registered yet — add one by hand, or paste a function's source to extract it."
          >
            <p class="text-xs text-gray-400 max-w-sm">
              The extension is a separate install: Piwi Picker on the
              <a :href="PICKER_CHROME_URL" target="_blank" rel="noopener" class="text-primary hover:underline"
                >Chrome Web Store</a
              >
              (Chrome and Edge) or
              <a :href="PICKER_FIREFOX_URL" target="_blank" rel="noopener" class="text-primary hover:underline"
                >Firefox Add-ons</a
              >
              — setup in the
              <DocLink to="features/extension" no-icon class="text-primary hover:underline">extension docs</DocLink>.
            </p>
          </EmptyState>
          <div v-else class="divide-y divide-gray-200 dark:divide-gray-800">
            <div v-for="entry in entries" :key="entry.id" class="py-3 flex items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-mono text-sm font-medium">{{ entry.name }}</span>
                  <UBadge color="neutral" variant="subtle" size="sm">{{ entry.kind }}</UBadge>
                  <UBadge v-if="entry.source !== 'manual'" color="primary" variant="subtle" size="sm">
                    {{ entry.source }}
                  </UBadge>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
                  {{ entry.module }}<span v-if="entry.receiver">#{{ entry.receiver }}</span>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400 truncate">{{ describeSteps(entry) }}</div>
                <div v-if="entry.urlPattern" class="text-xs text-gray-500 dark:text-gray-400">
                  on <code>{{ entry.urlPattern }}</code>
                </div>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <UButton
                  icon="i-lucide-pencil"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :aria-label="`Edit ${entry.name}`"
                  @click="openEdit(entry)"
                />
                <UButton
                  icon="i-lucide-trash-2"
                  color="error"
                  variant="ghost"
                  size="sm"
                  :aria-label="`Remove ${entry.name}`"
                  @click="confirmRemove(entry)"
                />
              </div>
            </div>
          </div>
        </SectionCard>
      </div>
    </template>
  </UDashboardPanel>

  <ClientOnly>
    <UModal
      v-model:open="showModal"
      :title="editingId == null ? 'Add test function' : 'Edit test function'"
      :ui="{ content: 'max-w-2xl' }"
    >
      <template #body>
        <div class="space-y-4">
          <div class="border border-dashed border-gray-300 dark:border-gray-700 rounded-lg p-3 space-y-2">
            <button
              type="button"
              class="flex items-center gap-2 text-sm font-medium w-full text-left"
              @click="showPasteCode = !showPasteCode"
            >
              <UIcon name="i-lucide-sparkles" class="text-primary" />
              <span>Paste from code (AI)</span>
              <UIcon
                :name="showPasteCode ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                class="ml-auto text-gray-400"
              />
            </button>
            <div v-if="showPasteCode" class="space-y-2">
              <p class="text-xs text-gray-500 dark:text-gray-400">
                Paste a page-object method or helper function's source — the fields below are filled in from it, for you
                to review and edit before saving. Module and URL pattern aren't inferred; fill those in yourself.
              </p>
              <UTextarea
                v-model="pastedCode"
                :rows="8"
                placeholder="async login(username: string, password: string) {
  await this.page.getByRole('textbox', { name: 'Username' }).fill(username);
  await this.page.getByRole('textbox', { name: 'Password' }).fill(password);
  await this.page.getByRole('button', { name: 'Log in' }).click();
}"
                class="w-full font-mono text-xs"
              />
              <div class="flex items-center gap-2 flex-wrap">
                <UButton
                  v-if="aiStatus?.configured"
                  label="Extract"
                  icon="i-lucide-wand-2"
                  size="sm"
                  :loading="extracting"
                  @click="extractFromCode"
                />
                <UButton
                  label="Copy prompt for your own AI"
                  icon="i-lucide-clipboard-copy"
                  size="sm"
                  color="neutral"
                  variant="outline"
                  @click="copyPromptForOwnAi"
                />
                <span v-if="aiExtracted && !lowConfidence && extractedConfidence != null" class="text-xs text-gray-500">
                  Extracted at {{ Math.round(extractedConfidence * 100) }}% confidence — review below before saving.
                </span>
              </div>

              <UAlert
                v-if="lowConfidence"
                color="warning"
                variant="subtle"
                icon="i-lucide-triangle-alert"
                :title="`Low confidence (${Math.round((extractedConfidence ?? 0) * 100)}%) — check the pattern below carefully`"
                :description="
                  extractedNotes ??
                  'The extractor wasn\'t able to represent this function cleanly. Functions that branch on their arguments, loop, or call other helpers often can\'t be captured as a single fixed pattern — the fields below may be incomplete.'
                "
              />
              <p v-else-if="extractedNotes" class="text-xs text-gray-500 dark:text-gray-400">
                Note: {{ extractedNotes }}
              </p>

              <p class="text-xs text-gray-500 dark:text-gray-400 pt-1">
                No AI configured on this instance, or prefer to use your own? Copy the prompt above into any AI chat
                (ChatGPT, Claude.ai, an IDE assistant, …), then paste its reply here — this doesn't spend Piwi AI
                credits, it just parses and validates what you paste.
              </p>
              <UTextarea
                v-model="aiResponseText"
                :rows="6"
                placeholder="Paste the AI's JSON reply here…"
                class="w-full font-mono text-xs"
              />
              <UButton
                label="Apply pasted response"
                icon="i-lucide-check-check"
                size="sm"
                color="neutral"
                variant="outline"
                :loading="applyingResponse"
                @click="applyPastedResponse"
              />
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <UFormField label="Name" name="name" required help="Becomes the called method/function name.">
              <UInput v-model="form.name" placeholder="e.g. addToCart" class="w-full" />
            </UFormField>
            <UFormField label="Kind" name="kind">
              <USelect v-model="form.kind" :items="KIND_ITEMS" class="w-full" />
            </UFormField>
          </div>

          <UFormField label="Module" name="module" required help="Import specifier, e.g. ./pages/CartPage">
            <UInput v-model="form.module" placeholder="./pages/CartPage" class="w-full" />
          </UFormField>

          <div v-if="form.kind === 'page-object-method'" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <UFormField label="Receiver" name="receiver" help="Instance variable name, e.g. cartPage">
              <UInput v-model="form.receiver" placeholder="cartPage" class="w-full" />
            </UFormField>
            <UFormField label="Class to import" name="importName" help="e.g. CartPage">
              <UInput v-model="form.importName" placeholder="CartPage" class="w-full" />
            </UFormField>
          </div>

          <UFormField
            label="URL pattern"
            name="urlPattern"
            help="Optional glob, e.g. **/cart — leave empty to match any page."
          >
            <UInput v-model="form.urlPattern" placeholder="**/cart" class="w-full" />
          </UFormField>

          <UFormField
            label="Parameters"
            help="Use “object” for an options bag (e.g. { label }) and list its keys — generated calls then pass an object literal instead of a bare string."
          >
            <div class="space-y-2">
              <div v-for="(param, i) in form.params" :key="i" class="flex items-center gap-2 flex-wrap">
                <UInput v-model="param.name" placeholder="param name" class="flex-1 min-w-24" />
                <USelect v-model="param.type" :items="PARAM_TYPE_ITEMS" class="w-32" />
                <UInput
                  v-if="param.type === 'object'"
                  v-model="param.fields"
                  placeholder="fields, comma-separated (e.g. label, testId)"
                  class="flex-1 min-w-40"
                />
                <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" @click="removeParam(i)" />
              </div>
              <UButton
                label="Add parameter"
                icon="i-lucide-plus"
                color="neutral"
                variant="outline"
                size="sm"
                @click="addParam"
              />
            </div>
          </UFormField>

          <UFormField
            label="DOM pattern"
            required
            help="The ordered steps this function drives — matched against a recording."
          >
            <div class="space-y-2">
              <div v-for="(step, i) in form.steps" :key="i" class="flex items-center gap-2 flex-wrap">
                <span class="text-xs text-gray-500 w-4">{{ i + 1 }}.</span>
                <USelect v-model="step.action" :items="ACTION_ITEMS" class="w-36" />
                <UInput v-model="step.role" placeholder="role (e.g. button)" class="flex-1 min-w-24" />
                <UInput v-model="step.name" placeholder="accessible name" class="flex-1 min-w-24" />
                <UInput v-model="step.testId" placeholder="test id" class="flex-1 min-w-24" />
                <UButton
                  icon="i-lucide-x"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :disabled="form.steps.length <= 1"
                  @click="removeStep(i)"
                />
              </div>
              <UButton
                label="Add step"
                icon="i-lucide-plus"
                color="neutral"
                variant="outline"
                size="sm"
                @click="addStep"
              />
            </div>
          </UFormField>

          <UFormField
            v-if="form.params.length > 0"
            label="Parameter sources"
            help="Where each argument's value comes from, at match time."
          >
            <div class="space-y-2">
              <div v-for="(src, i) in form.paramSources" :key="i" class="flex items-center gap-2 flex-wrap">
                <USelect
                  v-model="src.param"
                  :items="form.params.filter((p) => p.name.trim()).map((p) => ({ label: p.name, value: p.name }))"
                  placeholder="parameter"
                  class="flex-1 min-w-24"
                />
                <UInput
                  v-if="objectParamNames.has(src.param)"
                  v-model="src.path"
                  placeholder="field (e.g. label)"
                  class="w-40"
                />
                <USelect
                  v-model="src.stepIndex"
                  :items="form.steps.map((_, idx) => ({ label: `step ${idx + 1}`, value: idx }))"
                  class="w-28"
                />
                <USelect v-model="src.from" :items="PARAM_SOURCE_ITEMS" class="w-36" />
                <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" @click="removeParamSource(i)" />
              </div>
              <UButton
                label="Add source"
                icon="i-lucide-plus"
                color="neutral"
                variant="outline"
                size="sm"
                @click="addParamSource"
              />
            </div>
          </UFormField>
        </div>
      </template>

      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="showModal = false" />
        <UButton
          :label="editingId == null ? 'Add function' : 'Save changes'"
          icon="i-lucide-check"
          :loading="saving"
          @click="save"
        />
      </template>
    </UModal>
    <UModal :open="isDeleteConfirmOpen" title="Remove test function" @update:open="isDeleteConfirmOpen = $event">
      <template #body>
        <p>
          Remove <code class="font-mono">{{ functionToDelete?.name }}</code> from this project’s catalog? Recordings
          will stop matching against it and export raw locators instead. The function’s own source code is not touched.
        </p>
      </template>

      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" @click="isDeleteConfirmOpen = false" />
        <UButton color="error" label="Remove" icon="i-lucide-trash-2" @click="remove" />
      </template>
    </UModal>
  </ClientOnly>
</template>
