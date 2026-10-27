// Config fields that are themselves credentials and must never be returned to
// clients: the webhook signing `secret`, the Slack incoming-webhook URL
// (`webhookUrl`) — anyone holding that URL can post to the channel — the Slack
// bot `token` of a Web API channel, and any stored `apiKey`/`password`. The
// list and create endpoints only ever echo an email `address`, a webhook `url`
// or a Slack `channelId`, so dropping the secrets doesn't affect the dashboard. Global channels are visible to every user, so this
// stops a low-privilege user from reading another team's Slack URL.
export const SECRET_CONFIG_FIELDS = new Set(['webhookUrl', 'secret', 'token', 'apiKey', 'password']);

export function sanitizeChannelConfig(config: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!SECRET_CONFIG_FIELDS.has(key)) safe[key] = value;
  }
  return safe;
}

/** A URL cut to its origin, with `/…` standing for the path and query it hides; null when it does not parse. */
function urlOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin === 'null') return null;
    const hidden = parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '';
    return hidden ? `${parsed.origin}/…` : parsed.origin;
  } catch {
    return null;
  }
}

/**
 * A channel's config as a reader may see it: never a secret field, and a
 * webhook's `url`, which can carry a token in its path or query, only to the
 * channel's owner and administrators. Anyone else reads its origin.
 */
export function channelConfigFor(
  config: Record<string, unknown>,
  reader: { ownsChannel: boolean; isAdmin: boolean },
): Record<string, unknown> {
  const safe = sanitizeChannelConfig(config);
  if (reader.ownsChannel || reader.isAdmin || typeof safe.url !== 'string') return safe;
  return { ...safe, url: urlOrigin(safe.url) };
}
