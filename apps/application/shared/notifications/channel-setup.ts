/**
 * Pure helpers behind the notification-channel form: the channel types a person
 * can create, a check of the destination they paste (is it the kind of URL this
 * type expects?), a name to fall back on, the Slack app link pre-filled for Piwi,
 * and plain-language hints for a failed test delivery. Loads unchanged in the
 * app, the server and the demo.
 */
import { looksPrivateHost } from '#shared/utils/private-host';

/** The channel types the form creates; `personal_email` is managed from the account. */
export const CHANNEL_TYPES = ['email', 'slack', 'teams', 'webhook', 'browser'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** The types that take a destination and can be sent a test before they are saved. */
export type DeliverableChannelType = Exclude<ChannelType, 'browser'>;

export function isDeliverableChannelType(type: string): type is DeliverableChannelType {
  return type === 'email' || type === 'slack' || type === 'teams' || type === 'webhook';
}

/** Microsoft's guide to creating a Teams webhook through the Workflows app. */
export const TEAMS_WORKFLOWS_GUIDE_URL =
  'https://support.microsoft.com/en-us/office/send-messages-in-teams-using-incoming-webhooks-323660ec-12ca-40b1-a1d3-a3df47e808c4';

/** Slack's guide to incoming webhooks. */
export const SLACK_INCOMING_WEBHOOKS_GUIDE_URL =
  'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks';

/** Slack's guide to `chat.postMessage`, the Web API method a bot-token channel posts with. */
export const SLACK_POST_MESSAGE_GUIDE_URL = 'https://docs.slack.dev/reference/methods/chat.postMessage';

/**
 * How a Slack channel posts: through an incoming webhook (`webhookUrl`), or
 * through the Web API with a bot token (`token`, encrypted at rest) and a
 * channel ID (`channelId`).
 */
export type SlackDelivery = 'webhook' | 'api';

/** The delivery a Slack channel's config describes: a `token` or a `channelId` field means the Web API. */
export function slackDelivery(config: Record<string, unknown>): SlackDelivery {
  return typeof config.channelId === 'string' || typeof config.token === 'string' ? 'api' : 'webhook';
}

/**
 * The scopes a Slack app needs for each delivery: `incoming-webhook` makes
 * installing the app ask for a channel and mint that channel's webhook URL;
 * `chat:write` lets the bot post where it is a member, and `chat:write.public`
 * in any public channel without being invited.
 */
const SLACK_APP_SCOPES: Record<SlackDelivery, string[]> = {
  webhook: ['incoming-webhook'],
  api: ['chat:write', 'chat:write.public'],
};

/** A Slack app manifest with the scopes Piwi needs for one delivery. */
export function slackAppManifest(appName = 'Piwi', delivery: SlackDelivery = 'webhook'): Record<string, unknown> {
  return {
    display_information: {
      name: appName,
      description: 'Playwright test results and alerts from Piwi.',
    },
    features: { bot_user: { display_name: appName, always_online: false } },
    oauth_config: { scopes: { bot: SLACK_APP_SCOPES[delivery] } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

/** Slack's "create an app" page, pre-filled with the Piwi manifest for one delivery. */
export function slackCreateAppUrl(appName?: string, delivery: SlackDelivery = 'webhook'): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackAppManifest(appName, delivery)))}`;
}

/** A Slack conversation ID: a public (`C…`) or private (`G…`) channel, or a direct message (`D…`). */
const SLACK_CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{6,}$/;

/** Which chat webhook, if any, a URL is. */
export type ChatWebhookKind = 'slack' | 'slack-workflow' | 'teams-workflow' | 'teams-connector';

const SLACK_HOOK_HOSTS = new Set(['hooks.slack.com', 'hooks.slack-gov.com']);

export function detectChatWebhook(url: URL): ChatWebhookKind | null {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (SLACK_HOOK_HOSTS.has(host)) {
    return path.startsWith('/services/') ? 'slack' : 'slack-workflow';
  }
  if (host.endsWith('.logic.azure.com') && path.includes('/workflows/')) return 'teams-workflow';
  if (host.endsWith('.api.powerplatform.com') && path.includes('/workflows/')) return 'teams-workflow';
  if (host.endsWith('.webhook.office.com')) return 'teams-connector';
  if ((host === 'outlook.office.com' || host === 'outlook.office365.com') && path.startsWith('/webhook')) {
    return 'teams-connector';
  }
  return null;
}

/** What the form says about a pasted destination URL. */
export interface ChannelUrlVerdict {
  level: 'ok' | 'warning' | 'error';
  message: string;
  /** A type that fits this URL better, offered as a one-click switch. */
  suggestType?: 'slack' | 'teams';
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const PRIVATE_HOST_MESSAGE =
  'Piwi refuses private and loopback addresses for notification channels. Use an address reachable from the internet.';

/**
 * Check a destination URL against the channel type it was pasted into. Null
 * while the field is empty. A warning never blocks saving: a Slack-compatible
 * server (Mattermost, Rocket.Chat) is a legitimate Slack destination.
 */
export function inspectChannelUrl(type: 'slack' | 'teams' | 'webhook', raw: string): ChannelUrlVerdict | null {
  if (!raw.trim()) return null;
  const url = parseHttpUrl(raw);
  if (!url) return { level: 'error', message: 'Enter the full address, starting with https://.' };
  if (looksPrivateHost(url.hostname)) return { level: 'warning', message: PRIVATE_HOST_MESSAGE };

  const kind = detectChatWebhook(url);
  if (type === 'slack') {
    if (kind === 'slack') return { level: 'ok', message: 'Slack incoming webhook.' };
    if (kind === 'slack-workflow') {
      return {
        level: 'warning',
        message:
          'This is a Slack Workflow Builder link, which expects its own variables. Use an incoming-webhook URL (hooks.slack.com/services/…).',
      };
    }
    if (kind === 'teams-workflow' || kind === 'teams-connector') {
      return { level: 'warning', message: 'This is a Microsoft Teams webhook.', suggestType: 'teams' };
    }
    return {
      level: 'warning',
      message:
        'Not a Slack address. A Slack-compatible server (Mattermost, Rocket.Chat) works if it accepts Slack messages.',
    };
  }

  if (type === 'teams') {
    if (kind === 'teams-workflow') return { level: 'ok', message: 'Teams Workflows webhook.' };
    if (kind === 'teams-connector') {
      return {
        level: 'warning',
        message: 'A Microsoft 365 connector webhook. Microsoft is retiring these: prefer a Workflows webhook.',
      };
    }
    if (kind === 'slack') return { level: 'warning', message: 'This is a Slack webhook.', suggestType: 'slack' };
    return {
      level: 'warning',
      message: 'Not a Teams Workflows or connector address. The endpoint must accept an Adaptive Card.',
    };
  }

  if (kind === 'slack') {
    return {
      level: 'warning',
      message: 'This is a Slack incoming webhook: the Slack type formats the message for Slack.',
      suggestType: 'slack',
    };
  }
  if (kind === 'teams-workflow' || kind === 'teams-connector') {
    return {
      level: 'warning',
      message: 'This is a Microsoft Teams webhook: the Teams type sends it an Adaptive Card.',
      suggestType: 'teams',
    };
  }
  if (url.protocol === 'http:') {
    return { level: 'warning', message: 'Sent in clear text. Use https so the payload cannot be read on the way.' };
  }
  return { level: 'ok', message: 'Piwi will POST a JSON body here, signed when a secret is set.' };
}

/** The type a pasted URL clearly belongs to, for pre-selecting the form's type. */
export function channelTypeForUrl(raw: string): 'slack' | 'teams' | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;
  const kind = detectChatWebhook(url);
  if (kind === 'slack') return 'slack';
  if (kind === 'teams-workflow' || kind === 'teams-connector') return 'teams';
  return null;
}

/** A channel name to fall back on when the person leaves the field empty. */
export function suggestChannelName(type: ChannelType, destination: string): string {
  const value = destination.trim();
  if (type === 'email') return value || 'Email';
  if (type === 'slack') return 'Slack';
  if (type === 'teams') return 'Microsoft Teams';
  if (type === 'browser') return 'Browser';
  const url = parseHttpUrl(value);
  return url ? `Webhook (${url.hostname})` : 'Webhook';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The problem with a channel's destination, or null when it can be saved: an
 * email channel needs an address, the webhook types an http(s) URL, a Slack
 * channel posting through the Web API a bot token and a channel ID. Shape only —
 * whether the destination accepts a delivery is what a test proves.
 */
export function channelConfigProblem(type: ChannelType, config: Record<string, unknown>): string | null {
  if (type === 'browser') return null;
  if (type === 'email') {
    const address = typeof config.address === 'string' ? config.address.trim() : '';
    return EMAIL_PATTERN.test(address) ? null : 'Enter a valid email address.';
  }
  if (type === 'slack' && slackDelivery(config) === 'api') {
    const token = typeof config.token === 'string' ? config.token.trim() : '';
    if (!token.startsWith('xox')) return 'Enter the app’s bot token, starting with xoxb-.';
    const channelId = typeof config.channelId === 'string' ? config.channelId.trim() : '';
    return SLACK_CHANNEL_ID_PATTERN.test(channelId)
      ? null
      : 'Enter the channel ID, such as C0123456789, from the channel’s details in Slack.';
  }
  const key = type === 'webhook' ? 'url' : 'webhookUrl';
  const url = typeof config[key] === 'string' ? (config[key] as string) : '';
  return parseHttpUrl(url) ? null : 'Enter the full webhook URL, starting with https://.';
}

/**
 * What to do about a failed test delivery, in one sentence. Reads the error text
 * the delivery produced (`Slack returned 404: no_service`, the SSRF guard's
 * refusal). Null when the error says it all.
 */
export function channelDeliveryHint(type: ChannelType, error: string): string | null {
  const text = error.toLowerCase();
  if (text.includes('url host is not allowed') || text.includes('did not resolve')) {
    return text.includes('did not resolve')
      ? 'The host name does not resolve from this server. Check the URL.'
      : PRIVATE_HOST_MESSAGE;
  }
  if (text.includes('smtp not configured')) {
    return 'Email delivery is not set up on this instance. An administrator configures SMTP through environment variables.';
  }
  if (type === 'slack' && text.includes('slack api')) return slackApiHint(text);
  if (type === 'slack') {
    const gone = ['no_service', 'no_team', 'invalid_token', ' 403', ' 404'];
    if (gone.some((marker) => text.includes(marker))) {
      return 'Slack no longer knows this webhook: it was revoked, or the app was removed. Create a new one.';
    }
    if (text.includes('channel_is_archived') || text.includes(' 410')) {
      return 'The webhook’s channel is archived. Unarchive it, or create a webhook for another channel.';
    }
  }
  if (type === 'teams' && (text.includes(' 401') || text.includes(' 403') || text.includes(' 404'))) {
    return 'Teams refused the request: the workflow may be off or deleted, or the URL is cut short. Copy it again from the workflow.';
  }
  if (type === 'webhook' && (text.includes(' 401') || text.includes(' 403'))) {
    return 'Your endpoint refused the request. If it checks X-Piwi-Signature, make sure it uses the same secret.';
  }
  return null;
}

/** What to do about an error Slack's Web API answered, keyed by its `error` code. */
function slackApiHint(text: string): string | null {
  if (text.includes('rate limit')) {
    return 'Slack is limiting how often this app posts: try again after the wait it names. A notification waits for it before its retry.';
  }
  if (
    ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'].some((c) => text.includes(c))
  ) {
    return 'Slack does not accept this token: it was revoked, or the app was uninstalled. Copy the Bot User OAuth Token again.';
  }
  if (text.includes('missing_scope')) {
    return 'The app lacks the chat:write scope. Add it under OAuth & Permissions, then reinstall the app.';
  }
  if (text.includes('not_in_channel')) {
    return 'The app is not a member of this channel. Invite it with /invite @Piwi, or add the chat:write.public scope.';
  }
  if (text.includes('channel_not_found')) {
    return 'Slack finds no channel with this ID for this app. Check the ID; invite the app to a private channel first.';
  }
  if (text.includes('is_archived')) return 'The channel is archived. Unarchive it, or pick another channel.';
  return null;
}

/** A random signing secret for a webhook channel (32 bytes, hex). */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
