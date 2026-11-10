<script setup lang="ts">
/**
 * A local AI CLI chosen as a provider in Settings → AI: whether this server may
 * run it, whether it is installed and signed in, how to sign in (`claude auth
 * login` or `codex login` in a terminal, the credentials of DeepSeek Harness),
 * and its usage since the server started.
 */
import type { LocalCliProvider } from '~/utils/ai-provider-catalog';

const props = defineProps<{ provider: LocalCliProvider }>();

const form = useAiSettingsForm();
const cli = useLocalCliStatus();

const META: Record<
  LocalCliProvider,
  { label: string; command: string; signIn: string; envPath: string; install: string }
> = {
  'claude-cli': {
    label: 'Claude Code',
    command: 'claude',
    signIn: 'account Claude Code is signed in with',
    envPath: 'PIWI_CLAUDE_CLI_PATH',
    install: 'Install Claude Code on this machine, then recheck.',
  },
  'codex-cli': {
    label: 'Codex',
    command: 'codex',
    signIn: 'ChatGPT account Codex is signed in with',
    envPath: 'PIWI_CODEX_CLI_PATH',
    install: 'Install the Codex CLI on this machine, then recheck.',
  },
  'deepseek-cli': {
    label: 'DeepSeek Harness',
    command: 'dsh',
    signIn: 'DeepSeek account or API key DeepSeek Harness uses',
    envPath: 'PIWI_DEEPSEEK_CLI_PATH',
    install: 'Install DeepSeek Harness on this machine, then recheck.',
  },
};

const meta = computed(() => META[props.provider]);
const allowed = computed(() => form.cliAllowed(props.provider));
const v = computed(() => cli.view(props.provider));

const state = computed<{ text: string; dot: string }>(() => {
  if (!v.value.checked) return { text: 'Checking…', dot: 'bg-inverted/30' };
  if (!v.value.installed) return { text: 'Not installed', dot: 'bg-inverted/30' };
  if (props.provider === 'deepseek-cli') {
    return v.value.ready
      ? { text: 'Credentials set, checked on first use', dot: 'bg-success' }
      : { text: 'No credentials', dot: 'bg-warning' };
  }
  if (!v.value.ready && v.value.serverSignIn) return { text: 'Needs an API key', dot: 'bg-warning' };
  return v.value.ready ? { text: 'Signed in', dot: 'bg-success' } : { text: 'Not signed in', dot: 'bg-warning' };
});

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function check(provider: LocalCliProvider) {
  if (form.cliAllowed(provider) && !cli.view(provider).checked) cli.refresh(provider);
}
onMounted(() => check(props.provider));
watch(() => props.provider, check);
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-3">
      <p class="flex items-center gap-2 text-sm text-highlighted">
        <span class="size-2 shrink-0 rounded-full" :class="state.dot" />
        {{ allowed ? state.text : 'Not enabled on this server' }}
      </p>
      <UButton
        v-if="allowed"
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-refresh-cw"
        :loading="cli.isChecking(provider)"
        @click="cli.refresh(provider)"
      >
        Recheck
      </UButton>
    </div>

    <p class="text-sm text-highlighted leading-relaxed">
      Runs <code class="font-mono text-xs">{{ meta.command }}</code> on this machine with its own tools turned off: it
      reads the evidence and answers, and cannot run commands or open files. Piwi stores no key: usage counts against
      the {{ meta.signIn }}. It reads text only, so screenshots are not sent.
    </p>

    <UAlert
      v-if="!allowed"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="`This server is not allowed to run ${meta.label}`"
    >
      <template #description>
        Set <code class="font-mono text-xs">{{ meta.envPath }}</code> on the server, or use the desktop app. Diagnoses
        fail until then.
      </template>
    </UAlert>

    <UAlert
      v-else-if="v.checked && !v.installed"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="v.error || `${meta.command} was not found on this machine`"
    >
      <template v-if="!v.error" #description>
        {{ meta.install }} Installed outside the PATH? Set <code class="font-mono text-xs">{{ meta.envPath }}</code> to
        its full path.
      </template>
    </UAlert>

    <template v-else-if="v.installed">
      <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt class="text-xs text-muted">Version</dt>
        <dd class="font-mono text-xs text-highlighted">{{ v.version || 'unknown' }}</dd>
        <template v-if="v.signedIn && v.account">
          <dt class="text-xs text-muted">Signed in with</dt>
          <dd class="text-sm text-highlighted">{{ v.account }}</dd>
        </template>
        <template v-if="v.signedIn && v.modelApi">
          <dt class="text-xs text-muted">Model API</dt>
          <dd class="text-sm text-highlighted">{{ v.modelApi }}</dd>
        </template>
        <template v-if="v.path">
          <dt class="text-xs text-muted">Path</dt>
          <dd class="truncate font-mono text-xs text-highlighted" :title="v.path">{{ v.path }}</dd>
        </template>
      </dl>

      <UAlert
        v-if="!v.ready && v.serverSignIn"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="On a server, Claude Code needs an API key or a cloud provider"
        :description="v.error || undefined"
      />
      <div v-else-if="provider === 'claude-cli' && !v.ready" class="space-y-2">
        <p class="text-sm text-highlighted">Sign in on this machine, in a terminal, then recheck:</p>
        <CodeBlock code="claude auth login" lang="bash" />
      </div>
      <div v-else-if="provider === 'codex-cli' && !v.ready" class="space-y-2">
        <p class="text-sm text-highlighted">Sign in on this machine, in a terminal, then recheck:</p>
        <CodeBlock code="codex login" lang="bash" />
      </div>
      <p v-else-if="provider === 'deepseek-cli' && !v.ready" class="text-sm text-highlighted">
        Add your DeepSeek account or API key in DeepSeek Harness on this machine, then recheck.
      </p>

      <div v-if="v.ready && v.usage && v.usage.calls > 0" class="space-y-2 border-t border-default pt-3">
        <StatTileGrid>
          <StatTile label="Calls" :value="v.usage.calls" size="sm" />
          <StatTile label="Input tokens" :value="tokens(v.usage.inputTokens)" size="sm" />
          <StatTile label="Output tokens" :value="tokens(v.usage.outputTokens)" size="sm" />
          <StatTile
            v-if="v.usage.costUsd != null"
            label="At list rates"
            :value="`$${v.usage.costUsd.toFixed(2)}`"
            size="sm"
          />
        </StatTileGrid>
        <p class="text-xs text-muted">
          Since Piwi started. Input tokens count the tool's cached context, large but cheap.
          <template v-if="v.subscription">A subscription bills the cost to your plan, not per call.</template>
        </p>
      </div>
    </template>
  </div>
</template>
