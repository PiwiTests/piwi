/**
 * The providers Settings → AI offers, as tiles. A tile is what the user picks;
 * what the server stores is its `provider` plus, for an OpenAI-compatible tile,
 * its base URL. `tileFor` reads a stored config back into its tile.
 */
import type { AiProvider } from '~~/types/api';

export type ProviderTileId =
  | 'anthropic'
  | 'openai'
  | 'mistral'
  | 'openrouter'
  | 'groq'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'
  | 'claude-cli'
  | 'codex-cli'
  | 'deepseek-cli';

export type ProviderTileGroup = 'cloud' | 'self-hosted' | 'cli';

/** What a model is picked for: the main diagnosis, a faster secondary model, or embeddings. */
export type ModelPurpose = 'main' | 'fast' | 'embed';

export type LocalCliProvider = 'claude-cli' | 'codex-cli' | 'deepseek-cli';

export interface ProviderTile {
  id: ProviderTileId;
  label: string;
  group: ProviderTileGroup;
  provider: AiProvider;
  icon: string;
  /** The base URL the tile fills in. A cloud tile matches only this URL; a self-hosted one is a default. */
  baseUrl?: string;
  /** `none`: the field is hidden until asked for; a CLI signs in on its own. */
  key: 'required' | 'optional' | 'none';
  /** Whether the provider answers the OpenAI embeddings API. */
  embeddings: boolean;
  suggest: Partial<Record<ModelPurpose, string>>;
  /** Where to get a key, or what the address is. */
  hint?: string;
  /** A local CLI's command. */
  command?: string;
}

export const PROVIDER_TILES: ProviderTile[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    group: 'cloud',
    provider: 'anthropic',
    icon: 'i-simple-icons-anthropic',
    key: 'required',
    embeddings: false,
    suggest: { main: 'claude-opus-4-8', fast: 'claude-haiku-4-5' },
    hint: 'Create a key in the Anthropic Console, under API keys.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    group: 'cloud',
    provider: 'openai',
    icon: 'i-simple-icons-openai',
    baseUrl: 'https://api.openai.com/v1',
    key: 'required',
    embeddings: true,
    suggest: { main: 'gpt-4o', fast: 'gpt-4o-mini', embed: 'text-embedding-3-small' },
    hint: 'Create a key in your OpenAI platform account.',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    group: 'cloud',
    provider: 'openai',
    icon: 'i-simple-icons-mistralai',
    baseUrl: 'https://api.mistral.ai/v1',
    key: 'required',
    embeddings: true,
    suggest: { main: 'mistral-small-latest', embed: 'mistral-embed' },
    hint: 'Create a key in La Plateforme, under API keys.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'cloud',
    provider: 'openai',
    icon: 'i-simple-icons-openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    key: 'required',
    embeddings: false,
    suggest: { main: 'meta-llama/llama-3.1-8b-instruct' },
    hint: 'Create a key in your OpenRouter account.',
  },
  {
    id: 'groq',
    label: 'Groq',
    group: 'cloud',
    provider: 'openai',
    icon: 'i-lucide-cloud',
    baseUrl: 'https://api.groq.com/openai/v1',
    key: 'required',
    embeddings: false,
    suggest: { main: 'llama-3.1-8b-instant' },
    hint: 'Create a key in the GroqCloud console.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    group: 'self-hosted',
    provider: 'openai',
    icon: 'i-simple-icons-ollama',
    baseUrl: 'http://localhost:11434/v1',
    key: 'none',
    embeddings: true,
    suggest: { main: 'llama3.1', embed: 'nomic-embed-text' },
    hint: 'The address of your Ollama server, ending in /v1. Start it with ollama serve.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    group: 'self-hosted',
    provider: 'openai',
    icon: 'i-simple-icons-lmstudio',
    baseUrl: 'http://localhost:1234/v1',
    key: 'none',
    embeddings: true,
    suggest: {},
    hint: 'The address of the LM Studio server, ending in /v1. Turn it on in its Developer tab.',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    group: 'self-hosted',
    provider: 'openai',
    icon: 'i-lucide-server',
    key: 'optional',
    embeddings: true,
    suggest: {},
    hint: 'Any server that answers the OpenAI chat completions API, such as vLLM or LiteLLM. Usually ends in /v1.',
  },
  {
    id: 'claude-cli',
    label: 'Claude Code',
    group: 'cli',
    provider: 'claude-cli',
    icon: 'i-simple-icons-claude',
    key: 'none',
    embeddings: false,
    suggest: { fast: 'haiku' },
    command: 'claude',
  },
  {
    id: 'codex-cli',
    label: 'Codex',
    group: 'cli',
    provider: 'codex-cli',
    icon: 'i-simple-icons-openai',
    key: 'none',
    embeddings: false,
    suggest: {},
    command: 'codex',
  },
  {
    id: 'deepseek-cli',
    label: 'DeepSeek Harness',
    group: 'cli',
    provider: 'deepseek-cli',
    icon: 'i-simple-icons-deepseek',
    key: 'none',
    embeddings: false,
    suggest: {},
    command: 'dsh',
  },
];

export const LOCAL_CLI_PROVIDERS: LocalCliProvider[] = ['claude-cli', 'codex-cli', 'deepseek-cli'];

export function isLocalCliProvider(provider: string | null | undefined): provider is LocalCliProvider {
  return LOCAL_CLI_PROVIDERS.includes(provider as LocalCliProvider);
}

export function providerTile(id: ProviderTileId | null | undefined): ProviderTile | null {
  return PROVIDER_TILES.find((t) => t.id === id) ?? null;
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * The tile a stored provider and base URL stand for: an OpenAI-compatible
 * config whose URL is a known tile's is that tile, any other is the
 * OpenAI-compatible tile. Null for a provider no tile offers (the demo's).
 */
export function tileFor(provider: string | null | undefined, baseUrl?: string | null): ProviderTileId | null {
  if (!provider) return null;
  if (provider !== 'openai') return PROVIDER_TILES.find((t) => t.provider === provider)?.id ?? null;
  const url = trimSlash(baseUrl ?? '');
  const known = PROVIDER_TILES.find((t) => t.provider === 'openai' && t.baseUrl && trimSlash(t.baseUrl) === url);
  return known?.id ?? 'openai-compatible';
}

/** The model a tile suggests for a purpose, or '' when it has none. */
export function suggestedModel(id: ProviderTileId | null | undefined, purpose: ModelPurpose): string {
  return providerTile(id)?.suggest[purpose] ?? '';
}

/** A tile's name, or the raw provider id for one no tile offers. */
export function providerLabel(provider: string | null | undefined, baseUrl?: string | null): string {
  return providerTile(tileFor(provider, baseUrl))?.label ?? provider ?? '';
}

/** Whether a base URL points at this machine or a private network, so the evidence stays there. */
export function isPrivateUrl(url: string | null | undefined): boolean {
  let host: string;
  try {
    host = new URL(url ?? '').hostname;
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '[::1]' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$)/.test(host);
}
