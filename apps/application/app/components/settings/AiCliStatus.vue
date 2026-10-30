<script setup lang="ts">
/**
 * A local AI CLI chosen as a provider in Settings → AI: whether this server may
 * run it, whether it is installed and signed in, how to sign in (a button for
 * Claude Code, `codex login` in a terminal for Codex, the credentials of
 * DeepSeek Harness), and its usage since the server started.
 */
import type { LocalCliProvider } from '~/utils/ai-provider-catalog';

const props = defineProps<{ provider: LocalCliProvider }>();

const form = useAiSettingsForm();
const cli = useLocalCliStatus();
const toast = useToast();

const META: Record<
  LocalCliProvider,
  { label: string; command: string; signIn: string; envPath: string; install: string }
> = {
  'claude-cli': {
    label: 'Claude Code',
    command: 'claude',
    signIn: 'Claude Code sign-in',
    envPath: 'PIWI_CLAUDE_CLI_PATH',
    install: 'Install Claude Code on this machine, then recheck.',
  },
  'codex-cli': {
    label: 'Codex',
    command: 'codex',
    signIn: 'ChatGPT sign-in',
    envPath: 'PIWI_CODEX_CLI_PATH',
    install: 'Install the Codex CLI on this machine, then recheck.',
  },
  'deepseek-cli': {
    label: 'DeepSeek Harness',
    command: 'dsh',
    signIn: 'DeepSeek account or API key',
    envPath: 'PIWI_DEEPSEEK_CLI_PATH',
    install: 'Install DeepSeek Harness on this machine, then recheck.',
  },
};

const meta = computed(() => META[props.provider]);
const allowed = computed(() => form.cliAllowed(props.provider));
const v = computed(() => cli.view(props.provider));
const signingIn = computed(() => props.provider === 'claude-cli' && cli.claude.signingIn.value);

const state = computed<{ text: string; dot: string }>(() => {
  if (!v.value.checked) return { text: 'Checking…', dot: 'bg-inverted/30' };
  if (!v.value.installed) return { text: 'Not installed', dot: 'bg-inverted/30' };
  if (props.provider === 'deepseek-cli') {
    return v.value.ready
      ? { text: 'Credentials set, checked on first use', dot: 'bg-success' }
      : { text: 'No credentials', dot: 'bg-warning' };
  }
  return v.value.ready ? { text: 'Signed in', dot: 'bg-success' } : { text: 'Not signed in', dot: 'bg-warning' };
});

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

async function signIn() {
  const res = await cli.claude.signIn();
  if (res.success) toast.add({ title: 'Signed in to Claude Code', color: 'success' });
  else toast.add({ title: 'Sign-in failed', description: res.error || 'Unknown error', color: 'error' });
}

async function signOut() {
  const res = await cli.claude.signOut();
  if (res.success) toast.add({ title: 'Signed out of Claude Code', color: 'neutral' });
  else toast.add({ title: 'Sign-out failed', description: res.error || 'Unknown error', color: 'error' });
}

watch(
  () => props.provider,
  (provider) => {
    if (allowed.value && !cli.view(provider).checked) cli.refresh(provider);
  },
  { immediate: true },
);
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
      reads the evidence and answers, and cannot run commands or open files. No API key: usage counts against your
      {{ meta.signIn }}. It reads text only, so screenshots are not sent.
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
        <template v-if="v.ready && v.account">
          <dt class="text-xs text-muted">Signed in with</dt>
          <dd class="text-sm text-highlighted">{{ v.account }}</dd>
        </template>
        <template v-if="v.ready && v.modelApi">
          <dt class="text-xs text-muted">Model API</dt>
          <dd class="text-sm text-highlighted">{{ v.modelApi }}</dd>
        </template>
        <template v-if="v.path">
          <dt class="text-xs text-muted">Path</dt>
          <dd class="truncate font-mono text-xs text-highlighted" :title="v.path">{{ v.path }}</dd>
        </template>
      </dl>

      <template v-if="provider === 'claude-cli'">
        <div v-if="!v.ready" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-log-in"
            :loading="signingIn"
            @click="signIn"
          >
            {{ signingIn ? 'Finish in your browser…' : 'Sign in' }}
          </UButton>
          <span class="text-xs text-muted">Opens your browser to sign in with your Claude subscription.</span>
        </div>
        <p v-if="signingIn && cli.claude.loginUrl.value" class="text-xs text-muted break-all">
          If your browser did not open, visit
          <a
            :href="cli.claude.loginUrl.value"
            target="_blank"
            rel="noopener"
            class="font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid"
            >{{ cli.claude.loginUrl.value }}</a
          >
        </p>
        <UButton
          v-if="v.ready"
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-log-out"
          :disabled="signingIn"
          @click="signOut"
        >
          Sign out
        </UButton>
      </template>
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
          Since Piwi started. Input tokens count the tool's cached context, large but cheap. A subscription bills the
          cost to your plan, not per call.
        </p>
      </div>
    </template>
  </div>
</template>
