<script setup lang="ts">
/**
 * The connect and edit form of a provider reached on one of its regional hosts (Zephyr Scale Cloud): a name, the
 * region, and the credential fields the registry lists, then a check that signs in before anything is saved. The
 * server derives the address from the region, so no host is typed. A blank secret on edit keeps the stored one, but
 * only while the region is unchanged: a stored token never goes to another host, so moving the region needs it again.
 */
import {
  INTEGRATION_PROVIDERS,
  providerEndpoint,
  type CredentialField,
  type IntegrationProviderName,
} from '#shared/integrations/registry';
import type { ConnectionCheckResult, ConnectionSummary } from '#shared/integrations/types';
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';

const props = defineProps<{
  provider: IntegrationProviderName;
  /** The connection being edited; absent when connecting a new one. */
  connection?: ConnectionSummary | null;
  /** False when the server has no `PIWI_SECRET_KEY`, so a new token cannot be stored. */
  canStoreSecrets: boolean;
  /** The variables that configure this provider from the environment, shown when no token can be stored. */
  envVars: PiwiEnvVarName[];
}>();
const emit = defineEmits<{ saved: []; cancel: [] }>();

const toast = useToast();

const meta = INTEGRATION_PROVIDERS[props.provider];
const endpoint = providerEndpoint(props.provider);
const regions = endpoint?.kind === 'region' ? endpoint.regions : [];
const regionItems = regions.map((r) => ({ label: r.label, value: r.id }));
const fields = meta.credentialFields as readonly CredentialField[];

const editing = computed(() => !!props.connection);
const storedRegion = typeof props.connection?.config?.region === 'string' ? props.connection.config.region : null;

const form = reactive({
  name: props.connection?.name ?? '',
  region: storedRegion ?? regions[0]?.id ?? '',
  credentials: Object.fromEntries(
    fields.map((f) => [f.key, props.connection?.credentialValues[f.key] ?? '']),
  ) as Record<string, string>,
});

const regionLabel = computed(() => regions.find((r) => r.id === form.region)?.label ?? form.region);
const suggestedName = computed(() => `${meta.label} (${regionLabel.value})`);

/** A stored secret is kept only while the region it was saved for is the one in the form. */
const keepsStoredSecrets = computed(() => editing.value && form.region === storedRegion);
const secretFields = fields.filter((f) => f.secret);
const missingRequired = computed(() =>
  fields.some((f) => f.required && !form.credentials[f.key]?.trim() && !(f.secret && keepsStoredSecrets.value)),
);

function fieldDescription(field: CredentialField): string | undefined {
  if (!field.secret) return field.help;
  const note = keepsStoredSecrets.value
    ? 'Leave blank to keep the stored token.'
    : 'Stored encrypted, never shown again.';
  return field.help ? `${field.help} ${note}` : note;
}

// ── The check ────────────────────────────────────────────────────────────────
const check = ref<ConnectionCheckResult | null>(null);
/** The inputs `check` ran with, so a result never shows against fields edited since. */
const checkedFor = ref<string | null>(null);
const checking = ref(false);
const inputsKey = computed(() => `${form.region}\n${JSON.stringify(form.credentials)}`);

async function runCheck() {
  checking.value = true;
  const key = inputsKey.value;
  try {
    const result = await $fetch<ConnectionCheckResult>('/api/integrations/connections/check', {
      method: 'POST',
      body: {
        provider: props.provider,
        region: form.region,
        credentials: filledCredentials(),
        connectionId: props.connection?.id ?? null,
      },
    });
    check.value = result;
    checkedFor.value = key;
  } catch (err) {
    toast.add({ title: 'Check failed', description: errorMessage(err), color: 'error' });
  } finally {
    checking.value = false;
  }
}

const result = computed(() => (check.value && checkedFor.value === inputsKey.value ? check.value : null));
const canCheck = computed(() => !!form.region && !missingRequired.value);

function filledCredentials(): Record<string, string> {
  return Object.fromEntries(Object.entries(form.credentials).filter(([, value]) => value.trim() !== ''));
}

function projectsLine(projects: NonNullable<ConnectionCheckResult['projects']>): string {
  if (!projects.ok) return projects.error ?? 'Could not list projects.';
  if (projects.count === 0) return 'The token sees no project.';
  const more = projects.count > projects.keys.length ? ', …' : '';
  return `Sees ${projects.count} project${projects.count === 1 ? '' : 's'}: ${projects.keys.join(', ')}${more}`;
}

// ── Save ─────────────────────────────────────────────────────────────────────
const saving = ref(false);
const needsStorage = computed(() => secretFields.some((f) => !!form.credentials[f.key]?.trim()));
const canSave = computed(
  () => !!form.region && !missingRequired.value && (props.canStoreSecrets || !needsStorage.value),
);

async function submit() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const body = {
      provider: props.provider,
      name: form.name.trim() || suggestedName.value,
      region: form.region,
      credentials: filledCredentials(),
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

/** The environment-variable form of what was chosen, for an instance that cannot store a token. */
const envSnippet = computed(() =>
  props.envVars
    .map((name) => (name.endsWith('_REGION') ? `${name}=${form.region}` : `${name}=<the API token>`))
    .join('\n'),
);

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'data' in err) {
    const data = (err as { data?: { message?: string } }).data;
    if (data?.message) return data.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
</script>

<template>
  <form
    class="rounded-lg border border-default p-3 sm:p-4 space-y-5"
    :data-shot="`${provider}-connection-form`"
    method="post"
    @submit.prevent="submit"
  >
    <p class="text-sm font-semibold text-highlighted">
      {{ editing ? 'Edit connection' : `Connect ${meta.label}` }}
    </p>

    <div v-if="!canStoreSecrets && !editing" class="space-y-2" data-testid="region-no-secret-key">
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-key-round"
        title="This server cannot store an API token yet"
      >
        <template #description>
          Tokens are encrypted with <code class="font-mono text-xs">PIWI_SECRET_KEY</code>, which is not set. Set it and
          restart, or connect {{ meta.label }} through the environment instead:
        </template>
      </UAlert>
      <CodeBlock :code="envSnippet" lang="bash" />
    </div>

    <section class="grid gap-3 sm:grid-cols-2 max-w-2xl">
      <UFormField label="Region" description="The region your site runs in.">
        <USelect v-model="form.region" :items="regionItems" value-key="value" class="w-full" data-testid="region" />
      </UFormField>
      <UFormField label="Name" description="How this connection is listed.">
        <UInput v-model="form.name" :placeholder="suggestedName" class="w-full" data-testid="connection-name" />
      </UFormField>
      <UFormField
        v-for="field in fields"
        :key="field.key"
        :label="field.label"
        :description="fieldDescription(field)"
        class="sm:col-span-2"
      >
        <UInput
          v-model="form.credentials[field.key]"
          :type="field.type === 'password' ? 'password' : 'text'"
          :autocomplete="field.type === 'password' ? 'new-password' : 'off'"
          :placeholder="field.secret && keepsStoredSecrets ? 'Unchanged' : (field.placeholder ?? 'Paste the token')"
          class="w-full"
          :data-testid="`credential-${field.key}`"
        />
      </UFormField>
    </section>

    <section class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          type="button"
          color="neutral"
          variant="outline"
          icon="i-lucide-plug"
          label="Check"
          :loading="checking"
          :disabled="!canCheck || checking"
          title="Sign in with these credentials and count the projects the token sees; nothing is saved"
          @click="runCheck"
        />
        <span v-if="!canCheck" class="text-xs text-muted">Choose the region and enter the token first.</span>
      </div>

      <div v-if="result" class="space-y-1.5" data-testid="region-check">
        <CheckResultLine
          v-if="!result.site.ok"
          state="error"
          :text="result.site.error ?? 'Could not reach the region.'"
          :hint="result.site.hint"
        />
        <template v-else-if="result.auth">
          <CheckResultLine
            v-if="result.auth.ok"
            state="ok"
            :text="`Connected to ${result.auth.account?.displayName || meta.label}.`"
          />
          <CheckResultLine
            v-else
            state="error"
            :text="result.auth.error ?? 'Sign-in failed.'"
            :hint="result.auth.hint"
          />
          <CheckResultLine
            v-if="result.projects"
            :state="!result.projects.ok ? 'error' : result.projects.count === 0 ? 'warning' : 'ok'"
            :text="projectsLine(result.projects)"
            :hint="result.projects.hint"
          />
        </template>
      </div>
    </section>

    <div class="flex flex-wrap items-center gap-2">
      <UButton type="submit" color="primary" :loading="saving" :disabled="!canSave" icon="i-lucide-save">
        {{ editing ? 'Save' : 'Connect' }}
      </UButton>
      <UButton type="button" color="neutral" variant="ghost" label="Cancel" @click="emit('cancel')" />
    </div>
  </form>
</template>
