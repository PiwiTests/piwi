<script setup lang="ts">
/**
 * What the model receives, in Settings → AI: where the evidence of a diagnosis
 * goes, the repository token that lets it read commits, and the context
 * limits, one folded group per kind of evidence.
 */
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';
import { CONTEXT_LIMIT_FIELDS } from '#shared/ai-context-limits';
import { CONTEXT_LIMIT_GROUPS, IMAGE_LIMIT_FIELDS, type ContextLimitGroup } from '~/utils/ai-context-groups';
import { isLocalCliProvider, isPrivateUrl, providerLabel, providerTile } from '~/utils/ai-provider-catalog';
import { FEATURE_LABEL, OPTIONAL_ROLES } from '~/composables/useAiSettingsForm';
import type { ContextLimits } from '#shared/ai-context-limits';
import type { RoleDraft } from '~/utils/ai-settings-form';

const form = useAiSettingsForm();
const roles = form.roles;
const FIELD = Object.fromEntries(CONTEXT_LIMIT_FIELDS.map((f) => [f.key, f])) as Record<
  keyof ContextLimits,
  (typeof CONTEXT_LIMIT_FIELDS)[number]
>;

const CLOUD_NAMES: Record<string, string> = {
  anthropic: "Anthropic's API",
  openai: "OpenAI's API",
  mistral: "Mistral AI's API",
  openrouter: 'OpenRouter, then the provider of the model you pick',
  groq: "Groq's API",
  'claude-cli': 'Anthropic, through Claude Code',
  'codex-cli': 'OpenAI, through Codex',
  'deepseek-cli': 'DeepSeek, through DeepSeek Harness',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Where a role's evidence goes, as a phrase, and whether it stays on this
 * network: the API of a cloud tile, else the host of the address.
 */
function destination(r: RoleDraft): { text: string; private: boolean } {
  const tile = providerTile(r.tile);
  const ownAddress = r.provider === 'openai' && (tile?.group !== 'cloud' || r.baseUrl !== tile.baseUrl);
  if (ownAddress) return { text: hostOf(r.baseUrl) || 'your server', private: isPrivateUrl(r.baseUrl) };
  return { text: CLOUD_NAMES[r.tile ?? r.provider] ?? providerLabel(r.provider, r.baseUrl), private: false };
}

const main = computed(() => (roles.diagnosis.provider ? destination(roles.diagnosis) : null));

const others = computed(() =>
  OPTIONAL_ROLES.filter((role) => roles[role].enabled && !roles[role].reuse && roles[role].provider).map((role) => {
    const to = destination(roles[role]);
    return `${FEATURE_LABEL[role]} also sends ${role === 'embedding' ? 'error text' : 'this evidence'} to ${to.text}.`;
  }),
);

/** The provider reads text only: no screenshot is sent. */
const textOnly = computed(() => isLocalCliProvider(roles.diagnosis.provider));
const mainLabel = computed(() => providerLabel(roles.diagnosis.provider, roles.diagnosis.baseUrl));

const open = ref<string | null>(null);
const defaults = computed(() => form.limitsData.value?.defaults);

function changedCount(group: ContextLimitGroup): number {
  const d = defaults.value;
  if (!d) return 0;
  return group.fields.filter((k) => form.limits[k] !== '' && form.limits[k] != null && form.limits[k] !== d[k]).length;
}

function resetGroup(group: ContextLimitGroup) {
  const d = defaults.value;
  if (!d) return;
  for (const k of group.fields) if (!form.envManagedLimits.value.has(k)) form.limits[k] = d[k];
}

function unused(key: keyof ContextLimits): boolean {
  return textOnly.value && IMAGE_LIMIT_FIELDS.includes(key);
}

const replacingToken = ref(false);
const hasToken = computed(() => Boolean(form.settings.value?.hasScmToken) && !form.removeScmToken.value);
function removeToken() {
  form.removeScmToken.value = true;
  form.scmToken.value = '';
  replacingToken.value = false;
}
watch(
  () => form.settings.value,
  () => {
    replacingToken.value = false;
  },
);
</script>

<template>
  <SectionCard
    icon="i-lucide-shield-check"
    title="What the model receives"
    help="settings.privacy"
    subtitle="The evidence each diagnosis sends, and how much of it. The defaults suit most suites."
    data-tour="ai-privacy-notice"
  >
    <div class="space-y-6">
      <div class="rounded-md px-3 py-2 text-sm" :class="main?.private ? 'bg-success/10' : 'bg-elevated/50'">
        <p v-if="!main" class="text-highlighted">Nothing leaves this server until you choose a provider.</p>
        <p v-else-if="main.private" class="text-highlighted">
          <span class="font-semibold">Stays on your network.</span> {{ mainLabel }} runs at
          <code class="font-mono text-xs">{{ main.text }}</code
          >.
        </p>
        <p v-else class="text-highlighted">
          <span class="font-semibold">Sent to {{ main.text }}.</span> Check its data retention terms before you turn on
          auto-diagnose.
        </p>
        <p v-for="line in others" :key="line" class="mt-1 text-xs text-muted">{{ line }}</p>
      </div>

      <SettingsField
        label="Repository access token"
        help="project.scm-token"
        description="Lets diagnosis read commits and diffs from private GitHub, GitLab or Bitbucket repositories. Public repositories need none, and a project's own token takes precedence."
        data-tour="ai-repository-access"
      >
        <p v-if="!form.canStoreSecrets.value" class="text-sm text-muted">
          Needs <code class="font-mono text-xs">PIWI_SECRET_KEY</code> on the server to be stored.
        </p>
        <div v-else-if="hasToken && !replacingToken" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="flex items-center gap-1.5 text-sm text-highlighted">
            <UIcon name="i-lucide-lock" class="size-3.5 text-muted" />A token is stored, encrypted.
          </span>
          <UButton color="neutral" variant="link" size="sm" class="px-0" @click="replacingToken = true"
            >Replace</UButton
          >
          <UButton color="neutral" variant="link" size="sm" class="px-0" @click="removeToken">Remove</UButton>
        </div>
        <div v-else class="space-y-1">
          <UInput
            v-model="form.scmToken.value"
            type="password"
            placeholder="ghp_…, glpat-… or a Bitbucket token"
            autocomplete="off"
            class="w-full font-mono sm:max-w-md"
          />
          <p v-if="form.removeScmToken.value" class="text-xs text-muted">
            The stored token is removed when you save.
            <button
              type="button"
              class="underline decoration-dotted underline-offset-2 hover:decoration-solid"
              @click="form.removeScmToken.value = false"
            >
              Keep it
            </button>
          </p>
        </div>
      </SettingsField>

      <div class="space-y-2">
        <p class="inline-flex items-center gap-1 text-sm font-semibold text-highlighted">
          Diagnosis context limits <HelpHint topic="settings.ai-limits" />
        </p>
        <ul class="divide-y divide-default rounded-md border border-default" data-tour="ai-context-limits">
          <li v-for="group in CONTEXT_LIMIT_GROUPS" :key="group.id">
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-elevated/50 focus-visible:outline-2 focus-visible:outline-primary"
              :aria-expanded="open === group.id ? 'true' : 'false'"
              :aria-controls="`ai-limits-${group.id}`"
              @click="open = open === group.id ? null : group.id"
            >
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-semibold text-highlighted">{{ group.title }}</span>
                <span class="block text-xs text-muted">
                  {{
                    group.id === 'page' && textOnly
                      ? `The ARIA snapshot and the DOM at the failure. No screenshots: ${mainLabel} reads text only.`
                      : group.sends
                  }}
                </span>
              </span>
              <span v-if="changedCount(group)" class="shrink-0 text-xs text-muted">
                {{ changedCount(group) }} changed
              </span>
              <UIcon
                name="i-lucide-chevron-down"
                class="size-4 shrink-0 text-muted transition-transform"
                :class="open === group.id ? 'rotate-180' : ''"
              />
            </button>
            <div v-if="open === group.id" :id="`ai-limits-${group.id}`" class="space-y-3 px-3 pt-1 pb-4">
              <div class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                <UFormField
                  v-for="key in group.fields"
                  :key="key"
                  :label="FIELD[key].label"
                  :hint="defaults ? `default ${defaults[key]}` : undefined"
                  :description="unused(key) ? `Not used: ${mainLabel} reads text only.` : FIELD[key].description"
                >
                  <UInput
                    v-model.number="form.limits[key]"
                    type="number"
                    :min="FIELD[key].min"
                    :max="FIELD[key].max"
                    :disabled="form.envManagedLimits.value.has(key) || unused(key)"
                    :placeholder="defaults ? `default ${defaults[key]}` : ''"
                    class="w-full"
                  >
                    <template v-if="form.envManagedLimits.value.has(key)" #trailing>
                      <EnvManagedBadge :env-vars="[FIELD[key].envVar as PiwiEnvVarName]" />
                    </template>
                  </UInput>
                </UFormField>
              </div>
              <div class="flex justify-end">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-rotate-ccw"
                  :disabled="!changedCount(group)"
                  @click="resetGroup(group)"
                >
                  Reset to defaults
                </UButton>
              </div>
            </div>
          </li>
        </ul>
      </div>

      <p class="text-xs text-muted">
        API keys and tokens are stored encrypted in the database, readable by administrators only. For stricter setups,
        set the <code class="font-mono">PIWI_AI_*</code> environment variables instead.
      </p>
    </div>
  </SectionCard>
</template>
