import type { CodexCliStatus } from '~~/types/api';
import type { LocalCliProvider } from '~/utils/ai-provider-catalog';

/** One local AI CLI as Settings → AI shows it. */
export interface LocalCliView {
  /** False until the first check answers. */
  checked: boolean;
  installed: boolean;
  /** Ready to run here: signed in in a way this server may use (DeepSeek Harness: credentials set, checked on first use). */
  ready: boolean;
  /** Signed in, whatever the method, even one this server refuses. */
  signedIn: boolean;
  /** Claude Code on a server: only an API key or a cloud provider can run, never a Claude subscription. */
  serverSignIn: boolean;
  /** Signed in with a subscription plan, which bills the plan rather than each call. */
  subscription: boolean;
  version: string | null;
  path: string | null;
  /** How it is signed in. */
  account: string | null;
  /** The API the CLI calls its model through, when it says. */
  modelApi: string | null;
  error: string | null;
  /** Calls since the server started; the cost only where the CLI reports one. */
  usage: { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null } | null;
}

type OtherCli = Exclude<LocalCliProvider, 'claude-cli'>;

const CLAUDE_AUTH: Record<string, string> = {
  oauth_token: 'Claude subscription',
  api_key: 'API key',
  api_key_helper: 'API key (apiKeyHelper)',
  third_party: 'Cloud provider',
};
const CLAUDE_API: Record<string, string> = {
  firstParty: 'Anthropic',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
};
const OTHER_ACCOUNT: Record<OtherCli, string> = { 'codex-cli': 'ChatGPT', 'deepseek-cli': 'DeepSeek credentials' };

/**
 * Health, sign-in and usage of the local AI CLIs (Claude Code, Codex,
 * DeepSeek Harness), shared across the components of a page. Claude Code's
 * state comes from `useClaudeCli`.
 */
export function useLocalCliStatus() {
  const claude = useClaudeCli();
  const others = useState<Record<OtherCli, CodexCliStatus | null>>('local-cli-status', () => ({
    'codex-cli': null,
    'deepseek-cli': null,
  }));
  const checking = useState<Record<OtherCli, boolean>>('local-cli-checking', () => ({
    'codex-cli': false,
    'deepseek-cli': false,
  }));

  async function refresh(provider: LocalCliProvider): Promise<void> {
    if (provider === 'claude-cli') return claude.refresh(true);
    checking.value[provider] = true;
    try {
      others.value[provider] = await $fetch<CodexCliStatus>(`/api/ai/${provider}/status`, { query: { refresh: true } });
    } catch {
      // Keep the previous snapshot on a transient failure.
    } finally {
      checking.value[provider] = false;
    }
  }

  function isChecking(provider: LocalCliProvider): boolean {
    return provider === 'claude-cli' ? claude.loading.value : checking.value[provider];
  }

  function view(provider: LocalCliProvider): LocalCliView {
    if (provider === 'claude-cli') {
      const s = claude.status.value;
      return {
        checked: Boolean(s),
        installed: Boolean(s?.available),
        ready: Boolean(s?.loggedIn) && !s?.error,
        signedIn: Boolean(s?.loggedIn),
        serverSignIn: Boolean(s && !s.desktop),
        subscription: s?.authMethod === 'oauth_token',
        version: s?.version ?? null,
        path: s?.binaryPath ?? null,
        account: s?.authMethod ? (CLAUDE_AUTH[s.authMethod] ?? s.authMethod) : null,
        modelApi: s?.apiProvider ? (CLAUDE_API[s.apiProvider] ?? s.apiProvider) : null,
        error: s?.error ?? null,
        usage: s?.usage ? { ...s.usage, costUsd: s.usage.costUsd } : null,
      };
    }
    const s = others.value[provider];
    return {
      checked: Boolean(s),
      installed: Boolean(s?.available),
      ready: Boolean(s?.loggedIn),
      signedIn: Boolean(s?.loggedIn),
      serverSignIn: false,
      subscription: provider === 'codex-cli',
      version: s?.version ?? null,
      path: s?.binaryPath ?? null,
      account: s?.loggedIn ? OTHER_ACCOUNT[provider] : null,
      modelApi: null,
      error: s?.error ?? null,
      usage: s?.usage ? { ...s.usage, costUsd: null } : null,
    };
  }

  return { view, refresh, isChecking, claude };
}
