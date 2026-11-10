/**
 * Pure metadata for every integration provider. The settings UI, the connect
 * form and the docs render from this registry; the server-side client code lives
 * in `server/utils/integrations/`. Keep this file free of runtime dependencies —
 * it loads unchanged in the app, the demo and plain Node.
 */

/**
 * What a provider is for: it files tickets (tracker), receives test results (test management) or publishes pages
 * (wiki). The outbox reads a project's binding and builds a client per kind: a kind with neither runs nothing.
 */
export type IntegrationKind = 'tracker' | 'test-management' | 'wiki';

/** One host a `region` provider can be reached on. */
export interface ProviderRegion {
  id: string;
  label: string;
  baseUrl: string;
}

/**
 * How a provider is reached: at an address the administrator types (`url`, a Jira site), or on one of the hosts the
 * provider runs (`region`), whose base URL the server derives so no typed host reaches the outbound client.
 */
export type ProviderEndpoint = { kind: 'url' } | { kind: 'region'; regions: readonly ProviderRegion[] };

/** A field the connect form collects into the connection's credential blob. */
export interface CredentialField {
  /** Key inside the encrypted credentials JSON. */
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  /** The choices of a `select` field. */
  options?: readonly { value: string; label: string }[];
  /** Redacted on read and never returned by any endpoint. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface IntegrationProviderMeta {
  kind: IntegrationKind;
  label: string;
  /** Icon name for the provider (Nuxt UI icon syntax). */
  icon: string;
  /** How the connection reaches the provider. */
  endpoint: ProviderEndpoint;
  /** What the provider's client can do. */
  capabilities: readonly string[];
  /** The credential inputs the connect form generates, beyond name and base URL. */
  credentialFields: readonly CredentialField[];
  /** Docs anchor (`page#hash`) describing how to connect this provider. */
  docsAnchor: string;
}

export const INTEGRATION_PROVIDERS = {
  jira: {
    kind: 'tracker',
    label: 'Jira',
    icon: 'i-simple-icons-jira',
    endpoint: { kind: 'url' },
    capabilities: ['create', 'update', 'comment', 'transition', 'search', 'attach', 'assignable-users', 'webhook'],
    credentialFields: [
      {
        key: 'email',
        label: 'Account email',
        type: 'text',
        required: true,
        placeholder: 'you@example.com',
        help: 'The Atlassian account the API token belongs to.',
      },
      {
        key: 'apiToken',
        label: 'API token',
        type: 'password',
        secret: true,
        required: true,
        help: 'Create one at id.atlassian.com under Security → API tokens.',
      },
    ],
    docsAnchor: 'operate/integrations#connecting-jira-cloud',
  },
} as const satisfies Record<string, IntegrationProviderMeta>;

export type IntegrationProviderName = keyof typeof INTEGRATION_PROVIDERS;

/** The providers as an ordered list for rendering one card each. */
export const INTEGRATION_PROVIDER_LIST = Object.entries(INTEGRATION_PROVIDERS).map(([name, meta]) => ({
  name: name as IntegrationProviderName,
  ...meta,
}));

export function isIntegrationProvider(value: string): value is IntegrationProviderName {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_PROVIDERS, value);
}

/**
 * The subset of a credential map that is safe to reveal: the provider's declared
 * non-secret fields with a non-empty value (e.g. the Jira account email). Secret
 * fields such as the API token are always dropped, and undeclared keys are ignored.
 * Both the server (after decrypting the stored blob) and the demo use this, so the
 * settings UI can show the account and pre-fill the edit form without leaking a secret.
 */
export function nonSecretCredentials(
  provider: IntegrationProviderName,
  credentials: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!credentials) return {};
  const out: Record<string, string> = {};
  const fields = INTEGRATION_PROVIDERS[provider].credentialFields as readonly CredentialField[];
  for (const field of fields) {
    if (field.secret) continue;
    const value = credentials[field.key];
    if (typeof value === 'string' && value !== '') out[field.key] = value;
  }
  return out;
}

/** How a provider is reached, or null for a provider this build does not know. */
export function providerEndpoint(provider: string): ProviderEndpoint | null {
  return isIntegrationProvider(provider) ? (INTEGRATION_PROVIDERS[provider].endpoint as ProviderEndpoint) : null;
}

/**
 * The base URL a connection reached through `endpoint` is stored with: the typed address for a `url` endpoint, the
 * chosen region's host for a `region` endpoint, which ignores any typed address and also returns the region. An error
 * message when the input does not name one.
 */
export function endpointBaseUrl(
  endpoint: ProviderEndpoint,
  input: { baseUrl?: string | null; region?: string | null },
): { baseUrl: string; region?: string } | { error: string } {
  if (endpoint.kind === 'region') {
    const region = endpoint.regions.find((r) => r.id === input.region);
    return region ? { baseUrl: region.baseUrl, region: region.id } : { error: 'Choose one of the provider’s regions' };
  }
  if (!input.baseUrl) return { error: 'Enter the address of the site' };
  try {
    new URL(input.baseUrl);
  } catch {
    return { error: 'Must be a valid URL' };
  }
  return { baseUrl: input.baseUrl };
}

/** {@link endpointBaseUrl} for a provider by name. */
export function connectionBaseUrl(
  provider: string,
  input: { baseUrl?: string | null; region?: string | null },
): { baseUrl: string; region?: string } | { error: string } {
  const endpoint = providerEndpoint(provider);
  return endpoint ? endpointBaseUrl(endpoint, input) : { error: 'Unknown provider' };
}

/** Why a credential map does not fit `fields`: a `select` field set to none of its options. Else null. */
export function selectFieldError(
  fields: readonly CredentialField[],
  credentials: Record<string, string> | null | undefined,
): string | null {
  for (const field of fields) {
    const value = credentials?.[field.key];
    if (field.type !== 'select' || value == null || value === '') continue;
    if (!field.options?.some((option) => option.value === value)) return `${field.label}: choose one of its options`;
  }
  return null;
}

/** {@link selectFieldError} for a provider's credential fields; null for a provider this build does not know. */
export function credentialFieldError(
  provider: string,
  credentials: Record<string, string> | null | undefined,
): string | null {
  if (!isIntegrationProvider(provider)) return null;
  return selectFieldError(INTEGRATION_PROVIDERS[provider].credentialFields as readonly CredentialField[], credentials);
}
