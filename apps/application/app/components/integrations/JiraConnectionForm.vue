<script setup lang="ts">
/**
 * The Jira connect and edit form, laid out as the steps an administrator takes:
 * the site (checked as soon as it is typed, from any Jira page's address), the
 * API token (classic or scoped, with the Atlassian page to open and the scopes to
 * pick), the account, then a check that signs in and counts the projects before
 * anything is saved. Saves the site URL it read, and the scoped token's cloud id
 * when the check found one.
 */
import { INTEGRATION_PROVIDERS, type CredentialField } from '#shared/integrations/registry';
import {
  ATLASSIAN_API_TOKENS_URL,
  ATLASSIAN_TOKEN_MAX_DAYS,
  JIRA_SCOPED_TOKEN_SCOPES,
  jiraGatewayUrl,
  jiraSiteLabel,
  maxTokenExpiryDate,
  normalizeJiraSiteUrl,
  type JiraTokenKind,
} from '#shared/integrations/jira-setup';
import type { ConnectionCheckResult, ConnectionSummary } from '#shared/integrations/types';

const props = defineProps<{
  /** The connection being edited; absent when connecting a new one. */
  connection?: ConnectionSummary | null;
  /** False when the server has no `PIWI_SECRET_KEY`, so a new token cannot be stored. */
  canStoreSecrets: boolean;
}>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const toast = useToast();
const { copy, copied } = useCopy();

const editing = computed(() => !!props.connection);
const storedConfig: Record<string, unknown> = {
  ...((props.connection?.config as Record<string, unknown> | null) ?? {}),
};

const fields = INTEGRATION_PROVIDERS.jira.credentialFields as readonly CredentialField[];
const emailField = fields.find((f) => f.key === 'email')!;
const tokenField = fields.find((f) => f.key === 'apiToken')!;

const form = reactive({
  site: props.connection?.baseUrl ?? '',
  email: props.connection?.credentialValues.email ?? '',
  apiToken: '',
  tokenKind: (storedConfig.tokenKind === 'scoped' || typeof storedConfig.cloudId === 'string'
    ? 'scoped'
    : 'classic') as JiraTokenKind,
  tokenExpiresOn: typeof storedConfig.tokenExpiresOn === 'string' ? storedConfig.tokenExpiresOn : '',
  name: props.connection?.name ?? '',
  locale: storedConfig.locale === 'fr' ? 'fr' : 'en',
});

const TOKEN_KIND_ITEMS = [
  { label: 'Classic token', value: 'classic', description: 'Acts with everything the account can do.' },
  { label: 'Scoped token', value: 'scoped', description: 'Limited to the scopes you pick.' },
];
const LOCALE_ITEMS = [
  { label: 'English', value: 'en' },
  { label: 'Français', value: 'fr' },
];
const SCOPES_TEXT = JIRA_SCOPED_TOKEN_SCOPES.map((s) => s.scope).join(' ');

// ── The site ─────────────────────────────────────────────────────────────────
const siteAddress = computed(() => normalizeJiraSiteUrl(form.site));
/** The address Piwi will save, shown when it differs from what was typed. */
const siteRewritten = computed(() => {
  const address = siteAddress.value;
  return address && address.url !== form.site.trim().replace(/\/+$/, '') ? address.url : null;
});
const suggestedName = computed(() => (siteAddress.value ? `Jira (${jiraSiteLabel(siteAddress.value.url)})` : 'Jira'));

// ── The check ────────────────────────────────────────────────────────────────
const check = ref<ConnectionCheckResult | null>(null);
/** The inputs `check` ran with, so a result never shows against fields edited since. */
const checkedFor = ref<{ site: string; credentials: string | null } | null>(null);
const checking = ref<'site' | 'credentials' | null>(null);

const credentialsKey = computed(() => `${form.email}\n${form.apiToken}`);

async function runCheck(withCredentials: boolean) {
  const address = siteAddress.value;
  if (!address) return;
  checking.value = withCredentials ? 'credentials' : 'site';
  try {
    const result = await $fetch<ConnectionCheckResult>('/api/integrations/connections/check', {
      method: 'POST',
      body: {
        provider: 'jira',
        baseUrl: address.url,
        credentials: withCredentials ? { email: form.email, apiToken: form.apiToken } : null,
        connectionId: withCredentials ? (props.connection?.id ?? null) : null,
      },
    });
    // The address may have changed while the check ran; its own check follows.
    if (siteAddress.value?.url !== address.url) return;
    check.value = result;
    checkedFor.value = { site: address.url, credentials: withCredentials ? credentialsKey.value : null };
    if (result.auth?.ok && result.auth.tokenKind) form.tokenKind = result.auth.tokenKind;
  } catch (err) {
    toast.add({ title: 'Check failed', description: errorMessage(err), color: 'error' });
  } finally {
    checking.value = null;
  }
}

watchDebounced(
  () => siteAddress.value?.url,
  (url) => {
    if (url && checkedFor.value?.site !== url) void runCheck(false);
  },
  { debounce: 600, immediate: true },
);

const siteResult = computed(() =>
  check.value && checkedFor.value?.site === siteAddress.value?.url ? check.value.site : null,
);
const credentialResult = computed(() =>
  check.value?.auth &&
  checkedFor.value?.site === siteAddress.value?.url &&
  checkedFor.value?.credentials === credentialsKey.value
    ? check.value
    : null,
);
const cloudId = computed(() => siteResult.value?.cloudId ?? (storedConfig.cloudId as string | undefined) ?? null);

const canCheckCredentials = computed(
  () => !!siteAddress.value && !!form.email.trim() && (!!form.apiToken || editing.value),
);

function siteLine(site: ConnectionCheckResult['site']): string {
  if (!site.ok) return site.error ?? 'Not a Jira Cloud site.';
  return site.title && site.title !== 'Jira' ? `Jira Cloud site “${site.title}”.` : 'Jira Cloud site.';
}

function projectsLine(projects: NonNullable<ConnectionCheckResult['projects']>): string {
  if (!projects.ok) return projects.error ?? 'Could not list projects.';
  if (projects.count === 0) return 'The account sees no project.';
  const more = projects.count > projects.keys.length ? ', …' : '';
  const count =
    projects.count >= 100 ? '100 or more projects' : `${projects.count} project${projects.count === 1 ? '' : 's'}`;
  return `Sees ${count}: ${projects.keys.join(', ')}${more}`;
}

// ── Save ─────────────────────────────────────────────────────────────────────
const saving = ref(false);
const canSave = computed(
  () => !!siteAddress.value && (editing.value || (!!form.email.trim() && !!form.apiToken && props.canStoreSecrets)),
);

async function submit() {
  const address = siteAddress.value;
  if (!address || !canSave.value) return;
  saving.value = true;
  try {
    const config: Record<string, unknown> = { ...storedConfig, locale: form.locale };
    if (form.tokenExpiresOn) config.tokenExpiresOn = form.tokenExpiresOn;
    else delete config.tokenExpiresOn;
    // A check that signed in knows the token kind: route a scoped token through the
    // gateway from the first call, and stop routing a classic one there.
    const auth = credentialResult.value?.auth;
    if (auth?.ok && auth.tokenKind) config.tokenKind = auth.tokenKind;
    if (auth?.ok && auth.tokenKind === 'scoped' && cloudId.value) config.cloudId = cloudId.value;
    else if (auth?.ok && auth.tokenKind === 'classic') delete config.cloudId;

    const body = {
      provider: 'jira',
      name: form.name.trim() || suggestedName.value,
      baseUrl: address.url,
      credentials: { email: form.email.trim(), apiToken: form.apiToken },
      config,
    };
    if (props.connection) {
      await $fetch(`/api/integrations/connections/${props.connection.id}`, { method: 'PATCH', body });
      toast.add({ title: 'Connection updated', color: 'success' });
    } else {
      await $fetch('/api/integrations/connections', { method: 'POST', body });
      toast.add({ title: 'Connection added', color: 'success' });
    }
    emit('saved');
  } catch (err) {
    toast.add({ title: 'Save failed', description: errorMessage(err), color: 'error' });
  } finally {
    saving.value = false;
  }
}

/** The environment-variable form of what was typed, for an instance that cannot store a token. */
const envSnippet = computed(() =>
  [
    `PIWI_JIRA_BASE_URL=${siteAddress.value?.url ?? 'https://your-team.atlassian.net'}`,
    `PIWI_JIRA_EMAIL=${form.email.trim() || 'you@example.com'}`,
    'PIWI_JIRA_API_TOKEN=<the API token>',
  ].join('\n'),
);
</script>

<template>
  <form
    class="rounded-lg border border-default p-3 sm:p-4 space-y-5"
    data-shot="jira-connection-form"
    data-tour="jira-connection-form"
    @submit.prevent="submit"
  >
    <p class="text-sm font-semibold text-highlighted">
      {{ editing ? 'Edit connection' : 'Connect Jira' }}
      <HelpHint topic="settings.integrations.connection" />
    </p>

    <div v-if="!canStoreSecrets && !editing" class="space-y-2" data-testid="jira-no-secret-key">
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-key-round"
        title="This server cannot store an API token yet"
      >
        <template #description>
          Tokens are encrypted with <code class="font-mono text-xs">PIWI_SECRET_KEY</code>, which is not set. Set it and
          restart, or connect Jira through the environment instead:
        </template>
      </UAlert>
      <CodeBlock :code="envSnippet" lang="bash" />
    </div>

    <!-- 1. The site -->
    <section class="space-y-2">
      <UFormField label="Jira site" description="Paste the address of any Jira page, or type the site name.">
        <UInput
          v-model="form.site"
          placeholder="https://your-team.atlassian.net"
          class="w-full max-w-md"
          autocomplete="url"
          data-testid="jira-site"
        />
      </UFormField>
      <p v-if="siteRewritten" class="text-xs text-muted">
        Piwi will use <span class="font-mono">{{ siteRewritten }}</span
        >.
      </p>
      <CheckResultLine v-if="checking === 'site'" state="pending" text="Checking the site…" />
      <template v-else-if="siteResult">
        <CheckResultLine :state="siteResult.ok ? 'ok' : 'error'" :hint="siteResult.hint" data-testid="jira-site-check">
          {{ siteLine(siteResult) }}
          <OutboundLink v-if="siteResult.ok && siteAddress" :href="siteAddress.url">Open it</OutboundLink>
        </CheckResultLine>
        <p v-if="siteResult.reportedUrl" class="text-xs text-muted">
          The site calls itself <span class="font-mono">{{ siteResult.reportedUrl }}</span
          >.
          <button type="button" :class="SENTENCE_LINK_CLASS" @click="form.site = siteResult.reportedUrl!">
            Use that address
          </button>
        </p>
      </template>
    </section>

    <!-- 2. The token -->
    <section class="space-y-3">
      <UFormField label="API token type">
        <URadioGroup
          v-model="form.tokenKind"
          :items="TOKEN_KIND_ITEMS"
          value-key="value"
          orientation="horizontal"
          variant="card"
          class="max-w-xl"
          :ui="{ fieldset: 'flex-col sm:flex-row', item: 'flex-1' }"
        />
      </UFormField>

      <ol
        class="list-decimal space-y-1.5 ps-5 text-sm text-highlighted leading-relaxed max-w-2xl"
        data-testid="jira-token-steps"
      >
        <li>
          Sign in to Atlassian as the account Piwi should act as, and open
          <OutboundLink :href="ATLASSIAN_API_TOKENS_URL">API tokens</OutboundLink>.
        </li>
        <li v-if="form.tokenKind === 'classic'">
          Choose <span class="font-semibold">Create API token</span>, name it “Piwi”, and pick an expiry date (at most
          {{ ATLASSIAN_TOKEN_MAX_DAYS }} days).
        </li>
        <template v-else>
          <li>
            Choose <span class="font-semibold">Create API token with scopes</span>, name it “Piwi”, pick an expiry date,
            then the <span class="font-semibold">Jira</span> app.
          </li>
          <li>
            Select these scopes:
            <span class="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 align-middle">
              <code
                v-for="s in JIRA_SCOPED_TOKEN_SCOPES"
                :key="s.scope"
                class="rounded bg-elevated px-1 font-mono text-xs"
                :title="`Lets Piwi ${s.enables}`"
                >{{ s.scope }}</code
              >
              <UButton
                type="button"
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                :label="copied ? 'Copied' : 'Copy'"
                title="Copy the scope names"
                @click="copy(SCOPES_TEXT)"
              />
            </span>
          </li>
        </template>
        <li>Copy the token: Atlassian shows it once.</li>
      </ol>
      <p v-if="form.tokenKind === 'scoped'" class="text-xs text-muted max-w-2xl">
        A scoped token only works through Atlassian’s API gateway. Piwi routes this site’s calls there
        <template v-if="cloudId">
          (<span class="font-mono break-all">{{ jiraGatewayUrl(cloudId) }}</span
          >)</template
        >
        on its own.
      </p>
    </section>

    <!-- 3. The account -->
    <section class="space-y-3">
      <div class="grid gap-3 sm:grid-cols-2 max-w-2xl">
        <UFormField :label="emailField.label" :description="emailField.help">
          <UInput
            v-model="form.email"
            type="email"
            autocomplete="username"
            :placeholder="emailField.placeholder"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="tokenField.label"
          :description="editing ? 'Leave blank to keep the stored token.' : 'Stored encrypted, never shown again.'"
        >
          <UInput
            v-model="form.apiToken"
            type="password"
            autocomplete="new-password"
            :placeholder="editing ? 'Unchanged' : 'Paste the token'"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Token expires on" description="Optional. The connection warns two weeks before.">
          <UInput v-model="form.tokenExpiresOn" type="date" :max="maxTokenExpiryDate()" class="w-full" />
        </UFormField>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <UButton
          type="button"
          color="neutral"
          variant="outline"
          icon="i-lucide-plug"
          label="Check sign-in"
          :loading="checking === 'credentials'"
          :disabled="!canCheckCredentials || checking !== null"
          title="Sign in with these credentials and count the projects the account sees; nothing is saved"
          @click="runCheck(true)"
        />
        <span v-if="!canCheckCredentials" class="text-xs text-muted">Enter the site, email and token first.</span>
      </div>

      <div v-if="credentialResult" class="space-y-1.5" data-testid="jira-credential-check">
        <CheckResultLine
          v-if="credentialResult.auth?.ok"
          state="ok"
          :text="`Signed in as ${credentialResult.auth.account?.displayName || 'the account'}, with a ${credentialResult.auth.tokenKind} token.`"
        />
        <CheckResultLine
          v-else
          state="error"
          :text="credentialResult.auth?.error ?? 'Sign-in failed.'"
          :hint="credentialResult.auth?.hint"
        />
        <CheckResultLine
          v-if="credentialResult.projects"
          :state="!credentialResult.projects.ok ? 'error' : credentialResult.projects.count === 0 ? 'warning' : 'ok'"
          :text="projectsLine(credentialResult.projects)"
          :hint="credentialResult.projects.hint"
        />
      </div>
    </section>

    <!-- 4. Details -->
    <section class="grid gap-3 sm:grid-cols-2 max-w-2xl">
      <UFormField label="Name" description="How this connection is listed.">
        <UInput v-model="form.name" :placeholder="suggestedName" class="w-full" />
      </UFormField>
      <UFormField label="Default language" description="Issues are written in it unless a project overrides it.">
        <USelect v-model="form.locale" :items="LOCALE_ITEMS" value-key="value" class="w-full" />
      </UFormField>
    </section>

    <div class="flex flex-wrap items-center gap-2">
      <UButton type="submit" color="primary" :loading="saving" :disabled="!canSave" icon="i-lucide-save">
        {{ editing ? 'Save' : 'Connect' }}
      </UButton>
      <UButton type="button" color="neutral" variant="ghost" label="Cancel" @click="emit('cancel')" />
    </div>
  </form>
</template>
