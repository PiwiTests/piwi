import type { InjectionKey, Ref } from 'vue';
import type { AiModelRole, AiSettings, ModelInfo, SaveAiSettingsBody } from '~~/types/api';
import { CONTEXT_LIMIT_FIELDS } from '#shared/ai-context-limits';
import type { ContextLimitField, ContextLimits } from '#shared/ai-context-limits';
import {
  type ModelPurpose,
  type ProviderTileId,
  isLocalCliProvider,
  providerTile,
  suggestedModel,
} from '~/utils/ai-provider-catalog';
import {
  type RoleDraft,
  type RoleDrafts,
  applyTile,
  blankRoleDraft,
  buildAiSaveBody,
  connectionProblem,
  parseRoleTemperature,
  roleDraftFromSettings,
  storedKeyApplies,
} from '~/utils/ai-settings-form';

export interface ContextLimitsResponse {
  limits: ContextLimits;
  defaults: ContextLimits;
  envManaged: (keyof ContextLimits)[];
  fields: ContextLimitField[];
}

export interface AiTestState {
  status: 'idle' | 'testing' | 'ok' | 'error';
  message: string;
}

export type OptionalAiRole = Exclude<AiModelRole, 'diagnosis'>;

/** Where an optional role's provider comes from: another role's, or its own. */
export type RoleSource = 'diagnosis' | 'research' | 'own';

const ROLES: AiModelRole[] = ['diagnosis', 'research', 'embedding', 'assistant'];
export const OPTIONAL_ROLES: OptionalAiRole[] = ['research', 'embedding', 'assistant'];

export const ROLE_PURPOSE: Record<AiModelRole, ModelPurpose> = {
  diagnosis: 'main',
  research: 'fast',
  embedding: 'embed',
  assistant: 'fast',
};

export const FEATURE_LABEL: Record<AiModelRole, string> = {
  diagnosis: 'Provider',
  research: 'Two-stage diagnosis',
  embedding: 'Semantic clustering',
  assistant: 'Assistant',
};

const idleTest = (): AiTestState => ({ status: 'idle', message: '' });
const perRole = <T>(make: () => T) =>
  ({ diagnosis: make(), research: make(), embedding: make(), assistant: make() }) as Record<AiModelRole, T>;

/** The saved state of one section of the page, compared to tell what changed. */
function connectionPart(r: RoleDraft) {
  return r.reuse
    ? { reuse: r.reuse, model: r.model, temperature: r.temperature }
    : { provider: r.provider, model: r.model, baseUrl: r.baseUrl, apiKey: r.apiKey, temperature: r.temperature };
}

/**
 * The state of Settings → AI: every field of the page, what changed since the
 * last save, and the actions (test, list models, save, discard). The page
 * creates it and provides it; its parts read it with `useAiSettingsForm`.
 */
export function createAiSettingsForm(
  settings: Ref<AiSettings | null | undefined>,
  limitsData: Ref<ContextLimitsResponse | null | undefined>,
  refresh: () => Promise<void>,
) {
  const toast = useToast();

  const roles = reactive<RoleDrafts>(perRole(blankRoleDraft));
  const autoDiagnose = ref(false);
  const language = ref('');
  const instructions = ref('');
  const scmToken = ref('');
  const removeScmToken = ref(false);
  const limits = reactive<Partial<Record<keyof ContextLimits, number | ''>>>({});

  const tests = reactive<Record<AiModelRole, AiTestState>>(perRole(idleTest));
  const models = reactive<Record<AiModelRole, ModelInfo[]>>(perRole(() => [] as ModelInfo[]));
  const loadingModels = reactive<Record<AiModelRole, boolean>>(perRole(() => false));
  const saving = ref(false);
  const saveError = ref('');

  const envManaged = computed(() => Boolean(settings.value?.envManaged));
  const languageEnvManaged = computed(() => Boolean(settings.value?.languageEnvManaged));
  const canStoreSecrets = computed(() => settings.value?.canStoreSecrets ?? true);
  const envManagedLimits = computed(() => new Set<string>(limitsData.value?.envManaged ?? []));

  function stored(role: AiModelRole) {
    return settings.value?.roles[role] ?? null;
  }

  function load() {
    const s = settings.value;
    if (!s) return;
    for (const role of ROLES) Object.assign(roles[role], roleDraftFromSettings(s.roles[role]));
    autoDiagnose.value = s.autoDiagnose;
    language.value = s.language || '';
    instructions.value = s.customInstructions || '';
    scmToken.value = '';
    removeScmToken.value = false;
    loadLimits();
    saveError.value = '';
  }

  function loadLimits() {
    const l = limitsData.value;
    if (!l) return;
    for (const f of CONTEXT_LIMIT_FIELDS) limits[f.key] = l.limits[f.key];
  }

  watch(settings, load, { immediate: true });
  watch(limitsData, loadLimits, { immediate: true });

  // ── Derived state ──────────────────────────────────────────────────────────
  const mainTile = computed(() => providerTile(roles.diagnosis.tile));
  const mainConfigured = computed(() => Boolean(roles.diagnosis.provider));
  /** Whether the diagnosis provider answers the embeddings API, so clustering can reuse it. */
  const mainHasEmbeddings = computed(() =>
    mainTile.value ? mainTile.value.embeddings : roles.diagnosis.provider === 'openai',
  );

  /** The role whose provider a role runs on. */
  function sourceRole(role: AiModelRole): AiModelRole {
    const r = roles[role];
    return r.reuse && r.reuse !== role ? r.reuse : role;
  }

  function resolvedProvider(role: AiModelRole): string {
    return roles[sourceRole(role)].provider;
  }

  function keyStored(role: AiModelRole): boolean {
    return storedKeyApplies(roles[role], stored(role));
  }

  function cliAllowed(provider: string): boolean {
    const s = settings.value;
    if (provider === 'claude-cli') return Boolean(s?.claudeCliAvailable);
    if (provider === 'codex-cli') return Boolean(s?.codexCliAvailable);
    if (provider === 'deepseek-cli') return Boolean(s?.deepseekCliAvailable);
    return true;
  }

  const showCliTiles = computed(
    () =>
      ['claude-cli', 'codex-cli', 'deepseek-cli'].some(cliAllowed) ||
      ROLES.some((role) => isLocalCliProvider(roles[role].provider)),
  );

  // ── What changed ───────────────────────────────────────────────────────────
  function snapshot(state: {
    roles: RoleDrafts;
    autoDiagnose: boolean;
    language: string;
    instructions: string;
    limits: Partial<Record<keyof ContextLimits, number | ''>>;
    scmToken: string;
    removeScmToken: boolean;
  }) {
    return {
      provider: JSON.stringify(connectionPart(state.roles.diagnosis)),
      features: JSON.stringify([
        OPTIONAL_ROLES.map((r) => (state.roles[r].enabled ? connectionPart(state.roles[r]) : false)),
        state.autoDiagnose,
      ]),
      writing: JSON.stringify([languageEnvManaged.value ? '' : state.language.trim(), state.instructions.trim()]),
      limits: JSON.stringify(
        CONTEXT_LIMIT_FIELDS.map((f) => (state.limits[f.key] === '' ? null : (state.limits[f.key] ?? null))),
      ),
      scm: JSON.stringify([state.scmToken.trim(), state.removeScmToken]),
    };
  }

  const baseline = computed(() => {
    const s = settings.value;
    const savedRoles = perRole(blankRoleDraft);
    for (const role of ROLES) Object.assign(savedRoles[role], roleDraftFromSettings(s?.roles[role]));
    return snapshot({
      roles: savedRoles,
      autoDiagnose: s?.autoDiagnose ?? false,
      language: s?.language || '',
      instructions: s?.customInstructions || '',
      limits: { ...(limitsData.value?.limits ?? {}) },
      scmToken: '',
      removeScmToken: false,
    });
  });

  const current = computed(() =>
    snapshot({
      roles,
      autoDiagnose: autoDiagnose.value,
      language: language.value,
      instructions: instructions.value,
      limits,
      scmToken: scmToken.value,
      removeScmToken: removeScmToken.value,
    }),
  );

  type Part = keyof ReturnType<typeof snapshot>;
  const changed = (part: Part) => current.value[part] !== baseline.value[part];
  const SECTIONS: { label: string; parts: Part[] }[] = [
    { label: 'Provider', parts: ['provider'] },
    { label: 'Features', parts: ['features'] },
    { label: 'Writing', parts: ['writing'] },
    { label: 'What the model receives', parts: ['limits', 'scm'] },
  ];
  /** The sections of the page with unsaved changes, by label. */
  const changedSections = computed(() =>
    SECTIONS.filter((section) => section.parts.some(changed)).map((section) => section.label),
  );

  // A test result describes the connection it ran on: any change to it clears the result.
  for (const role of ROLES) {
    watch(
      () => {
        const r = roles[role];
        const src = roles[sourceRole(role)];
        return [r.reuse, r.model, r.temperature, src.provider, src.baseUrl, src.apiKey].join('\u0000');
      },
      () => {
        if (tests[role].status !== 'testing') tests[role] = idleTest();
      },
    );
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  function pickTile(role: AiModelRole, id: ProviderTileId) {
    const tile = providerTile(id);
    if (!tile || roles[role].tile === id) return;
    applyTile(roles[role], tile, ROLE_PURPOSE[role], stored(role));
    models[role] = [];
    if (role !== 'diagnosis') return;
    // Features that reuse the diagnosis provider follow it to the new one.
    for (const r of OPTIONAL_ROLES) {
      const f = roles[r];
      if (f.reuse !== 'diagnosis') continue;
      if (r === 'embedding' && !mainHasEmbeddings.value) {
        Object.assign(f, { ...blankRoleDraft(), enabled: f.enabled });
        continue;
      }
      f.model = suggestedModel(id, ROLE_PURPOSE[r]);
      models[r] = [];
    }
  }

  function roleSource(role: OptionalAiRole): RoleSource {
    const reuse = roles[role].reuse;
    if (reuse === 'diagnosis' || reuse === 'research') return reuse;
    return 'own';
  }

  function setSource(role: OptionalAiRole, source: RoleSource) {
    const f = roles[role];
    const s = stored(role);
    models[role] = [];
    if (source === 'own') {
      if (s && !s.reuse) Object.assign(f, roleDraftFromSettings(s), { enabled: f.enabled });
      else Object.assign(f, { ...blankRoleDraft(), enabled: f.enabled });
      return;
    }
    Object.assign(f, { ...blankRoleDraft(), enabled: f.enabled, reuse: source });
    f.model = s?.reuse === source ? (s.model ?? '') : suggestedModel(roles[source].tile, ROLE_PURPOSE[role]);
  }

  /** Turn a feature on or off. On, it starts on the diagnosis provider when it can. */
  function setFeature(role: OptionalAiRole, on: boolean) {
    const f = roles[role];
    f.enabled = on;
    if (!on || f.reuse || f.provider) return;
    if (role === 'embedding' && !mainHasEmbeddings.value && !envManaged.value) return;
    f.reuse = 'diagnosis';
    f.model = suggestedModel(roles.diagnosis.tile, ROLE_PURPOSE[role]);
  }

  async function loadModels(role: AiModelRole) {
    const src = roles[sourceRole(role)];
    loadingModels[role] = true;
    try {
      const res = await $fetch<{ models: ModelInfo[] }>('/api/settings/ai/models', {
        method: 'POST',
        // role lets the server fall back to the stored key when the form key is blank
        body: { role, provider: src.provider, baseUrl: src.baseUrl || undefined, apiKey: src.apiKey || undefined },
      });
      models[role] = res.models;
    } catch {
      models[role] = [];
    } finally {
      loadingModels[role] = false;
    }
  }

  async function testRole(role: AiModelRole) {
    const r = roles[role];
    const src = roles[sourceRole(role)];
    tests[role] = { status: 'testing', message: 'Testing the connection…' };
    try {
      const res = await $fetch<{ success: boolean; model?: string; error?: string }>('/api/settings/ai/test', {
        method: 'POST',
        body: {
          role,
          provider: src.provider || undefined,
          apiKey: src.apiKey || undefined,
          model: r.model || (r.reuse ? src.model : '') || undefined,
          baseUrl: src.baseUrl || undefined,
          // Temperature is per-role (not inherited through reuse), so read it off `r`.
          temperature: parseRoleTemperature(role, r.temperature),
        },
      });
      tests[role] = res.success
        ? { status: 'ok', message: `Connected. ${res.model || 'The model'} answered.` }
        : { status: 'error', message: res.error || 'The provider did not answer.' };
    } catch (err) {
      tests[role] = { status: 'error', message: errorMessage(err) };
    }
  }

  /** What blocks testing a role's connection, or null. */
  function testBlocker(role: AiModelRole): string | null {
    if (envManaged.value) return null;
    const src = sourceRole(role);
    const r = roles[src];
    if (isLocalCliProvider(r.provider) && !cliAllowed(r.provider)) return 'This server is not allowed to run it.';
    return connectionProblem(r, keyStored(src));
  }

  /** The first thing that keeps the page from saving, or null. */
  function saveProblem(): string | null {
    if (envManaged.value) return null;
    const d = roles.diagnosis;
    if (d.provider) {
      if (isLocalCliProvider(d.provider) && !cliAllowed(d.provider))
        return `Provider: this server is not allowed to run ${providerTile(d.tile)?.label ?? d.provider}.`;
      const problem = connectionProblem(d, keyStored('diagnosis'));
      if (problem) return `Provider: ${problem}`;
    }
    for (const role of OPTIONAL_ROLES) {
      const f = roles[role];
      if (!f.enabled || !d.provider || f.reuse) continue;
      if (isLocalCliProvider(f.provider) && !cliAllowed(f.provider))
        return `${FEATURE_LABEL[role]}: this server is not allowed to run ${providerTile(f.tile)?.label ?? f.provider}.`;
      const problem = connectionProblem(f, keyStored(role));
      if (problem) return `${FEATURE_LABEL[role]}: ${problem}`;
    }
    return null;
  }

  async function save() {
    const problem = saveProblem();
    if (problem) {
      saveError.value = problem;
      return;
    }
    saveError.value = '';
    saving.value = true;
    try {
      const body: SaveAiSettingsBody = {};
      if (changed('provider') || changed('features')) {
        Object.assign(body, buildAiSaveBody(roles, { envManaged: envManaged.value, autoDiagnose: autoDiagnose.value }));
      }
      if (changed('writing')) {
        body.customInstructions = instructions.value.trim() || null;
        if (!languageEnvManaged.value) body.language = language.value.trim() || null;
      }
      // An absent `scmToken` keeps the stored one; `null` removes it.
      if (scmToken.value.trim()) body.scmToken = scmToken.value.trim();
      else if (removeScmToken.value) body.scmToken = null;
      if (Object.keys(body).length) await $fetch('/api/settings/ai', { method: 'PUT', body });

      if (changed('limits')) {
        // An empty field resets to its default; the server ignores the env-managed ones.
        const values = Object.fromEntries(
          CONTEXT_LIMIT_FIELDS.map((f) => [f.key, limits[f.key] === '' ? null : (limits[f.key] ?? null)]),
        );
        limitsData.value = await $fetch<ContextLimitsResponse>('/api/settings/ai/limits', {
          method: 'PUT',
          body: { limits: values },
        });
      }
      await refresh();
      load();
      toast.add({ title: 'AI settings saved', color: 'success' });
    } catch (err) {
      saveError.value = errorMessage(err);
      toast.add({ title: 'Save failed', description: saveError.value, color: 'error' });
    } finally {
      saving.value = false;
    }
  }

  function discard() {
    load();
  }

  /** Clear the provider and the features: saved, it turns AI off. */
  function turnOff() {
    Object.assign(roles.diagnosis, blankRoleDraft());
    for (const role of OPTIONAL_ROLES) roles[role].enabled = false;
    autoDiagnose.value = false;
  }

  return {
    settings,
    limitsData,
    roles,
    autoDiagnose,
    language,
    instructions,
    scmToken,
    removeScmToken,
    limits,
    tests,
    models,
    loadingModels,
    saving,
    saveError,
    envManaged,
    languageEnvManaged,
    canStoreSecrets,
    envManagedLimits,
    mainTile,
    mainConfigured,
    mainHasEmbeddings,
    showCliTiles,
    changedSections,
    stored,
    sourceRole,
    resolvedProvider,
    keyStored,
    cliAllowed,
    pickTile,
    roleSource,
    setSource,
    setFeature,
    loadModels,
    testRole,
    testBlocker,
    save,
    discard,
    turnOff,
  };
}

export type AiSettingsForm = ReturnType<typeof createAiSettingsForm>;

export const AI_SETTINGS_FORM: InjectionKey<AiSettingsForm> = Symbol('ai-settings-form');

/** The Settings → AI form state the page provides. */
export function useAiSettingsForm(): AiSettingsForm {
  const form = inject(AI_SETTINGS_FORM);
  if (!form) throw new Error('useAiSettingsForm() is only available inside Settings → AI');
  return form;
}
