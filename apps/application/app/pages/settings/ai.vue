<script setup lang="ts">
import type { AiSettings, AiModelRole, ModelInfo } from '~~/types/api';
import { type RoleForm, buildAiSaveBody, parseRoleTemperature } from '~/utils/ai-settings-form';
import { CONTEXT_LIMIT_FIELDS } from '#shared/ai-context-limits';
import type { ContextLimits, ContextLimitField } from '#shared/ai-context-limits';
import { pageEnvVars, getSettingsPage } from '~/utils/settings-metadata';
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';

const toast = useToast();

const { data: settings, refresh } = await useFetch<AiSettings>('/api/settings/ai');

// ── Per-role provider configuration ─────────────────────────────────────────
type RoleKey = AiModelRole;

function blankRole(): RoleForm {
  return { enabled: false, reuse: null, provider: '', model: '', baseUrl: '', apiKey: '', temperature: '' };
}

const roles = reactive<Record<RoleKey, RoleForm>>({
  diagnosis: blankRole(),
  research: blankRole(),
  embedding: blankRole(),
  assistant: blankRole(),
});

const autoDiagnose = ref(false);

// Browser notifications when a diagnosis finishes — a per-browser client
// preference (not stored server-side), so it lives outside the settings save.
const {
  permission: notifPermission,
  supported: notifSupported,
  active: notifActive,
  requestPermission: requestNotifPermission,
  toggleEnabled: toggleNotifEnabled,
} = useDiagnosisNotification();

const customInstructions = ref<string>('');
const aiLanguage = ref<string>('');
const scmToken = ref<string>('');
const saving = ref(false);
const savingInstructions = ref(false);
const savingLanguage = ref(false);
const savingScmToken = ref(false);

const testingRoles = reactive<Record<RoleKey, boolean>>({
  diagnosis: false,
  research: false,
  embedding: false,
  assistant: false,
});

const modelsRecord = reactive<Record<RoleKey, ModelInfo[]>>({
  diagnosis: [],
  research: [],
  embedding: [],
  assistant: [],
});
const loadingModels = reactive<Record<RoleKey, boolean>>({
  diagnosis: false,
  research: false,
  embedding: false,
  assistant: false,
});

function resolvedProvider(role: RoleKey): string {
  const r = roles[role];
  if (r.reuse) return roles[r.reuse]?.provider || '';
  return r.provider;
}

async function loadModels(role: RoleKey) {
  const r = roles[role];
  const provider = resolvedProvider(role);
  const source = r.reuse ? roles[r.reuse] : r;
  const apiKey = source.apiKey || undefined;
  loadingModels[role] = true;
  try {
    const res = await $fetch<{ models: ModelInfo[] }>('/api/settings/ai/models', {
      method: 'POST',
      // role lets the server fall back to the stored key when the form key is blank
      body: { role, provider, baseUrl: source.baseUrl || undefined, apiKey },
    });
    modelsRecord[role] = res.models;
  } catch {
    modelsRecord[role] = [];
  } finally {
    loadingModels[role] = false;
  }
}

const ROLE_META = [
  {
    key: 'diagnosis',
    title: 'Diagnosis model',
    icon: 'i-lucide-stethoscope',
    help: 'settings.ai-provider',
    optional: false,
    enableLabel: '',
    blurb: 'The main model that writes the final diagnosis. Required to enable AI features.',
    reuseTargets: [],
    modelPlaceholderAnthropic: 'claude-opus-4-8',
    modelPlaceholderOpenai: 'e.g. gpt-4o, llama3.1',
  },
  {
    key: 'research',
    title: 'Research model',
    icon: 'i-lucide-search',
    help: 'settings.ai-research',
    optional: true,
    enableLabel: 'Two-stage diagnosis',
    blurb:
      'A cheaper/faster model that pre-analyzes the failure before the diagnosis model writes the final answer. Also used for cluster naming and merge adjudication.',
    reuseTargets: ['diagnosis'],
    modelPlaceholderAnthropic: 'e.g. claude-haiku-4-5',
    modelPlaceholderOpenai: 'e.g. llama-3.1-8b-instant',
  },
  {
    key: 'embedding',
    title: 'Embedding model',
    icon: 'i-lucide-vector-square',
    help: 'settings.embedding-model',
    optional: true,
    enableLabel: 'Semantic clustering',
    blurb: 'Embeds failures so semantically-similar errors group together (used by failure clustering).',
    note: 'Embeddings need an OpenAI-compatible endpoint — neither the Anthropic API nor Claude Code (local) has an embeddings API, so those cannot be used here. A local server such as ollama or LM Studio works well for this.',
    reuseTargets: ['diagnosis', 'research'],
    modelPlaceholderAnthropic: '— Anthropic has no embeddings API —',
    modelPlaceholderOpenai: 'e.g. text-embedding-3-small',
  },
  {
    key: 'assistant',
    title: 'Assistant model',
    icon: 'i-lucide-message-circle-question-mark',
    help: 'settings.ai-assistant',
    optional: true,
    enableLabel: 'Separate assistant model',
    blurb:
      'The model the in-app assistant answers questions with. Off, the assistant uses the diagnosis model; a faster, cheaper model suits conversation.',
    reuseTargets: ['diagnosis', 'research'],
    modelPlaceholderAnthropic: 'e.g. claude-haiku-4-5',
    modelPlaceholderOpenai: 'e.g. gpt-4o-mini, qwen2.5',
  },
] as const;

// The local Claude CLI provider is only offered in the desktop app (or when a
// stored/env config already selected it, so it stays visible and editable).
const isDesktop = useIsDesktop();
const usesClaudeCli = computed(() =>
  Object.values(settings.value?.roles ?? {}).some((r) => r?.provider === 'claude-cli'),
);
const showClaudeCli = computed(() => isDesktop || usesClaudeCli.value);

const providerOptions = computed(() => {
  const opts = [
    { label: 'Anthropic API', value: 'anthropic' },
    { label: 'OpenAI-compatible', value: 'openai' },
  ];
  if (showClaudeCli.value) opts.unshift({ label: 'Claude Code (local)', value: 'claude-cli' });
  return opts;
});
// Anthropic and the CLI have no embeddings API — the embedding role must be OpenAI-compatible.
const embeddingProviderOptions = computed(() => providerOptions.value.filter((p) => p.value === 'openai'));

// Stable per-role reuse options (recomputed only when role-enable state changes),
// so the child <USelect>'s `items` keep a stable reference and the listbox doesn't
// reset on every parent render. 'own' is the sentinel for "configure own provider".
const reuseOptionsByRole = computed<Record<RoleKey, Array<{ label: string; value: string }>>>(() => {
  const out = {} as Record<RoleKey, Array<{ label: string; value: string }>>;
  for (const meta of ROLE_META) {
    out[meta.key] = [
      { label: 'Configure its own provider', value: 'own' },
      ...meta.reuseTargets
        .filter((t) => roles[t].enabled || t === 'diagnosis')
        // Embeddings can only reuse OpenAI-compatible roles.
        .filter((t) => meta.key !== 'embedding' || roles[t].provider === 'openai')
        .map((t) => ({ label: `Reuse ${ROLE_META.find((m) => m.key === t)!.title.toLowerCase()}`, value: t })),
    ];
  }
  return out;
});

const envManaged = computed(() => Boolean(settings.value?.envManaged));
// API keys and the SCM token are encrypted with `PIWI_SECRET_KEY`; without it the server cannot store them.
const canStoreSecrets = computed(() => settings.value?.canStoreSecrets ?? true);
const secretKeyCommand = `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`;
const aiEnvVars = pageEnvVars(getSettingsPage('ai'));

// The required diagnosis role has no enable toggle — it is "configured" exactly
// when a provider is selected. Drives the dependent auto-diagnose control (and
// mirrors the save logic in ai-settings-form).
const diagnosisConfigured = computed(() => Boolean(roles.diagnosis.provider));

watch(
  settings,
  (val) => {
    if (!val) return;
    for (const meta of ROLE_META) {
      const r = val.roles[meta.key];
      const form = roles[meta.key];
      form.enabled = Boolean(r);
      form.reuse = r?.reuse ?? null;
      form.provider = r?.provider ?? '';
      form.model = r?.model ?? '';
      form.baseUrl = r?.baseUrl ?? '';
      form.apiKey = '';
      form.temperature = r?.temperature != null ? String(r.temperature) : '';
    }
    autoDiagnose.value = val.autoDiagnose;
    customInstructions.value = val.customInstructions || '';
    aiLanguage.value = val.language || '';
  },
  { immediate: true },
);

function hasStoredKey(role: RoleKey): boolean {
  return Boolean(settings.value?.roles[role]?.hasApiKey);
}

// ── OpenAI presets ──────────────────────────────────────────────────────────
interface OpenAiPreset {
  label: string;
  baseUrl: string;
  model: string;
}

const OPENAI_PRESETS: OpenAiPreset[] = [
  { label: 'ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: '' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-8b-instruct' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
  { label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  { label: 'Custom', baseUrl: '', model: '' },
];
const presetOptions = OPENAI_PRESETS.map((p) => ({ label: p.label, value: p.label }));

function applyPreset(role: RoleKey, label: string) {
  const preset = OPENAI_PRESETS.find((p) => p.label === label);
  if (!preset || preset.label === 'Custom') return;
  roles[role].baseUrl = preset.baseUrl;
  roles[role].model = preset.model;
}

// ── Save ─────────────────────────────────────────────────────────────────────
async function save() {
  saving.value = true;
  try {
    // buildAiSaveBody decides clear-vs-save: with no diagnosis provider (and not
    // env-managed) it clears the config; otherwise it sends every configured
    // role. The diagnosis role is required and has no enable toggle, so it counts
    // as configured the moment a provider is picked — see the util for details.
    const body = buildAiSaveBody(roles, { envManaged: envManaged.value, autoDiagnose: autoDiagnose.value });
    await $fetch('/api/settings/ai', { method: 'PUT', body });
    await refresh();
    for (const meta of ROLE_META) roles[meta.key].apiKey = '';
    toast.add({ title: 'Settings saved', color: 'success' });
  } catch (err) {
    toast.add({ title: 'Save failed', description: errorMessage(err), color: 'error' });
  } finally {
    saving.value = false;
  }
}

async function saveScmToken() {
  savingScmToken.value = true;
  try {
    await $fetch('/api/settings/ai', { method: 'PUT', body: { scmToken: scmToken.value || null } });
    await refresh();
    scmToken.value = '';
    toast.add({ title: 'SCM token saved', color: 'success' });
  } catch (err) {
    toast.add({ title: 'Save failed', description: errorMessage(err), color: 'error' });
  } finally {
    savingScmToken.value = false;
  }
}

async function saveInstructions() {
  savingInstructions.value = true;
  try {
    await $fetch('/api/settings/ai', { method: 'PUT', body: { customInstructions: customInstructions.value || null } });
    await refresh();
    toast.add({ title: 'Instructions saved', color: 'success' });
  } catch (err) {
    toast.add({ title: 'Save failed', description: errorMessage(err), color: 'error' });
  } finally {
    savingInstructions.value = false;
  }
}

async function saveLanguage() {
  savingLanguage.value = true;
  try {
    await $fetch('/api/settings/ai', { method: 'PUT', body: { language: aiLanguage.value || null } });
    await refresh();
    toast.add({ title: 'Response language saved', color: 'success' });
  } catch (err) {
    toast.add({ title: 'Save failed', description: errorMessage(err), color: 'error' });
  } finally {
    savingLanguage.value = false;
  }
}

async function testRole(role: RoleKey) {
  testingRoles[role] = true;
  try {
    const r = roles[role];
    // Reused roles source provider/key/baseUrl from the reused role's form
    // state; the server falls back to saved keys when the form key is blank.
    const src = r.reuse ? roles[r.reuse] : r;
    const res = await $fetch<{ success: boolean; model?: string; error?: string }>('/api/settings/ai/test', {
      method: 'POST',
      body: {
        role,
        provider: src.provider || undefined,
        apiKey: src.apiKey || undefined,
        model: r.model || (r.reuse ? src.model : '') || undefined,
        baseUrl: src.baseUrl || undefined,
        // Temperature is per-role (not inherited via reuse), so read it off `r`, not `src`.
        temperature: parseRoleTemperature(role, r.temperature),
      },
    });
    if (res.success)
      toast.add({ title: 'Connection successful', description: `Model: ${res.model}`, color: 'success' });
    else toast.add({ title: 'Connection failed', description: res.error || 'Unknown error', color: 'error' });
  } catch (err) {
    toast.add({ title: 'Connection failed', description: errorMessage(err), color: 'error' });
  } finally {
    testingRoles[role] = false;
  }
}

// ── Diagnosis context limits (unchanged) ─────────────────────────────────────
interface ContextLimitsResponse {
  limits: ContextLimits;
  defaults: ContextLimits;
  envManaged: (keyof ContextLimits)[];
  fields: ContextLimitField[];
}

const { data: limitsData } = await useFetch<ContextLimitsResponse>('/api/settings/ai/limits');
const limitFields = CONTEXT_LIMIT_FIELDS;
const limitValues = reactive<Record<string, number | undefined>>({});
const savingLimits = ref(false);
const envManagedLimits = computed(() => new Set<string>(limitsData.value?.envManaged ?? []));

watch(
  limitsData,
  (val) => {
    if (!val) return;
    for (const f of limitFields) limitValues[f.key] = val.limits[f.key];
  },
  { immediate: true },
);

async function saveLimits() {
  savingLimits.value = true;
  try {
    limitsData.value = await $fetch<ContextLimitsResponse>('/api/settings/ai/limits', {
      method: 'PUT',
      body: { limits: limitValues },
    });
    toast.add({ title: 'Context limits saved', color: 'success' });
  } catch (e) {
    toast.add({
      title: 'Failed to save context limits',
      description: errorMessage(e),
      color: 'error',
    });
  } finally {
    savingLimits.value = false;
  }
}

function resetLimits() {
  if (!limitsData.value) return;
  for (const f of limitFields) {
    if (envManagedLimits.value.has(f.key)) continue;
    limitValues[f.key] = limitsData.value.defaults[f.key];
  }
}
</script>

<template>
  <CapabilityDeclinedGuard capability="ai" label="AI diagnosis">
    <div class="space-y-6">
      <EnvManagedAlert v-if="envManaged" :env-vars="aiEnvVars" />

      <div v-if="!canStoreSecrets" class="space-y-2" data-testid="ai-no-secret-key">
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-key-round"
          title="This server cannot store API keys or tokens yet"
        >
          <template #description>
            Keys and tokens saved here are encrypted with <code class="font-mono text-xs">PIWI_SECRET_KEY</code>, which
            is not set.
            <template v-if="!envManaged">
              A local OpenAI-compatible server or the Claude CLI needs no key and saves as usual.
            </template>
            Generate a key, set it as <code class="font-mono text-xs">PIWI_SECRET_KEY</code> and restart the server:
          </template>
        </UAlert>
        <CodeBlock :code="secretKeyCommand" lang="bash" />
      </div>

      <SectionCard icon="i-lucide-sparkles" title="Model providers" help="settings.ai-provider">
        <template #subtitle>
          Configure a complete provider for each model role. Optional roles can reuse another role's provider so you
          don't re-enter credentials.
        </template>

        <div class="space-y-5" data-shot="ai-model-providers">
          <ClaudeCliStatusCard v-if="showClaudeCli" />

          <AiRoleConfigForm
            v-for="meta in ROLE_META"
            :key="meta.key"
            v-model="roles[meta.key]"
            :meta="meta"
            :has-api-key="hasStoredKey(meta.key)"
            :can-store-secrets="canStoreSecrets"
            :reuse-options="reuseOptionsByRole[meta.key]"
            :provider-options="meta.key === 'embedding' ? embeddingProviderOptions : providerOptions"
            :preset-options="presetOptions"
            :disabled="envManaged"
            :env-managed="envManaged"
            :provider-resolved="resolvedProvider(meta.key)"
            :models="modelsRecord[meta.key]"
            :loading-models="loadingModels[meta.key]"
            :testing="testingRoles[meta.key]"
            @apply-preset="(label: string) => applyPreset(meta.key, label)"
            @load-models="loadModels(meta.key)"
            @test="testRole(meta.key)"
          />

          <SettingsField label="Auto-diagnose" help="settings.auto-diagnose" :env-managed="envManaged">
            <div class="flex items-center gap-3">
              <USwitch v-model="autoDiagnose" :disabled="envManaged || !diagnosisConfigured" />
              <span class="text-sm text-gray-500">
                Automatically diagnose new failure clusters when a run finishes — up to 3 clusters per run (research +
                diagnosis call each), plus one batched call to title new clusters
              </span>
            </div>
          </SettingsField>

          <SettingsField label="Diagnosis notifications" help="settings.ai-notifications">
            <ClientOnly>
              <div class="flex items-center gap-3">
                <template v-if="!notifSupported">
                  <span class="text-sm text-gray-500">This browser does not support notifications.</span>
                </template>
                <template v-else-if="notifPermission === 'denied'">
                  <span class="text-sm text-gray-500">Notifications are blocked in your browser settings.</span>
                </template>
                <template v-else-if="notifPermission === 'default'">
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-bell"
                    @click="requestNotifPermission"
                  >
                    Enable notifications
                  </UButton>
                  <span class="text-sm text-gray-500">Get a browser notification when a diagnosis finishes.</span>
                </template>
                <template v-else>
                  <USwitch :model-value="notifActive" @update:model-value="toggleNotifEnabled" />
                  <span class="text-sm text-gray-500">
                    Show a browser notification when a diagnosis finishes — this browser only.
                  </span>
                </template>
              </div>
            </ClientOnly>
          </SettingsField>
        </div>

        <template #footer>
          <div class="flex items-center gap-2 justify-end">
            <UButton color="primary" :loading="saving" icon="i-lucide-save" @click="save"> Save </UButton>
          </div>
        </template>
      </SectionCard>

      <AiUsagePanel />

      <SectionCard title="Repository access" help="project.scm-token">
        <template #subtitle> Optional — required for private repositories. Per-project tokens override this. </template>

        <UFormField
          label="SCM token"
          :description="
            !canStoreSecrets
              ? 'Needs PIWI_SECRET_KEY set on the server to be stored'
              : settings?.hasScmToken
                ? 'Leave empty to keep the stored token, enter a new value to replace it, or save empty to remove it'
                : 'Personal access token with read access to repository contents. Supports GitHub (ghp_), GitLab (glpat-), and Bitbucket tokens.'
          "
        >
          <UInput
            v-model="scmToken"
            type="password"
            :placeholder="settings?.hasScmToken ? '•••••••• (unchanged)' : 'ghp_..., glpat-..., or Bitbucket token'"
            :disabled="!canStoreSecrets"
            class="w-full font-mono"
          />
        </UFormField>

        <template #footer>
          <div class="flex justify-end">
            <UButton color="primary" :loading="savingScmToken" icon="i-lucide-save" @click="saveScmToken">
              Save token
            </UButton>
          </div>
        </template>
      </SectionCard>

      <SectionCard title="Global analysis instructions" help="settings.ai-instructions">
        <UTextarea
          v-model="customInstructions"
          :rows="6"
          placeholder="e.g. Always suggest running failing tests with --repeat-each 5 to confirm flakiness. Prefer network-level evidence over ARIA snapshots. Recommend git bisect when a commit range is available."
          class="w-full font-mono text-sm"
        />

        <p class="text-xs text-gray-400 mt-2">
          These instructions are appended to the base system prompt. They shape how the AI analyzes failures but cannot
          override the response schema or confidence requirement.
        </p>

        <template #footer>
          <div class="flex justify-end">
            <UButton color="primary" :loading="savingInstructions" icon="i-lucide-save" @click="saveInstructions">
              Save instructions
            </UButton>
          </div>
        </template>
      </SectionCard>

      <SectionCard title="Response language">
        <template #subtitle>
          The language the AI writes its prose in — diagnosis, root cause, cluster titles. Code, locators, file paths
          and error text stay verbatim. Leave blank for English.
        </template>
        <EnvManagedAlert v-if="settings?.languageEnvManaged" :env-vars="['PIWI_AI_LANGUAGE']" class="mb-3" />
        <UInput
          v-model="aiLanguage"
          :disabled="settings?.languageEnvManaged"
          placeholder="e.g. French, Japanese, German"
          class="w-full max-w-sm"
        />
        <template #footer>
          <div class="flex justify-end">
            <UButton
              color="primary"
              :loading="savingLanguage"
              :disabled="settings?.languageEnvManaged"
              icon="i-lucide-save"
              @click="saveLanguage"
            >
              Save language
            </UButton>
          </div>
        </template>
      </SectionCard>

      <SectionCard title="Diagnosis context limits" help="settings.ai-limits">
        <template #subtitle> Leave a field empty to use its default; env-managed fields are read-only. </template>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <UFormField
            v-for="f in limitFields"
            :key="f.key"
            :label="f.label"
            :description="f.description"
            :hint="`default ${limitsData?.defaults[f.key] ?? ''}`"
          >
            <UInput
              v-model.number="limitValues[f.key]"
              type="number"
              :min="f.min"
              :max="f.max"
              :disabled="envManagedLimits.has(f.key)"
              :placeholder="`default ${limitsData?.defaults[f.key] ?? ''}`"
              class="w-full"
            >
              <template v-if="envManagedLimits.has(f.key)" #trailing>
                <EnvManagedBadge :env-vars="[f.envVar as PiwiEnvVarName]" />
              </template>
            </UInput>
          </UFormField>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" size="sm" @click="resetLimits">Reset to defaults</UButton>
            <UButton color="primary" :loading="savingLimits" icon="i-lucide-save" size="sm" @click="saveLimits">
              Save limits
            </UButton>
          </div>
        </template>
      </SectionCard>

      <SectionCard icon="i-lucide-shield-check" title="Privacy notice" help="settings.privacy">
        <div class="space-y-2 text-sm text-gray-600 dark:text-gray-400">
          <p>When diagnosing a failure cluster, the following data is sent to the configured LLM provider:</p>
          <ul class="list-disc list-inside space-y-1 ml-2">
            <li>Normalized error signature and sample raw error text</li>
            <li>Test titles and file paths for affected tests</li>
            <li>Browser info, test steps, console error/warning entries (excerpts)</li>
            <li>Failed network request URLs and status codes</li>
            <li>ARIA page snapshot (if collected)</li>
            <li>
              Commit SHA range since last passing run, plus changed file names and diff patches fetched from
              GitHub/GitLab/Bitbucket (if a repository token is configured or the repo is public)
            </li>
          </ul>
          <p class="mt-2">
            API keys are stored encrypted in the application database (admin-only access). For stricter setups, use the
            <code class="font-mono text-xs">PIWI_AI_*</code> environment variables instead of the UI.
          </p>
        </div>
      </SectionCard>
    </div>
  </CapabilityDeclinedGuard>
</template>
