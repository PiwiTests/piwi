import { describe, test, expect } from 'vitest';
import {
  channelConfigProblem,
  channelDeliveryHint,
  channelTypeForUrl,
  generateWebhookSecret,
  inspectChannelUrl,
  slackAppManifest,
  slackCreateAppUrl,
  slackDelivery,
  suggestChannelName,
} from '#shared/notifications/channel-setup';
import { looksPrivateHost } from '#shared/utils/private-host';

const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const SLACK_WORKFLOW = 'https://hooks.slack.com/triggers/T000/123/abc';
const TEAMS_LOGIC = 'https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x';
const TEAMS_POWER_PLATFORM =
  'https://default123.45.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke';
const TEAMS_CONNECTOR = 'https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def';

describe('inspectChannelUrl', () => {
  test('an empty field has no verdict; a non-URL is an error', () => {
    expect(inspectChannelUrl('slack', '  ')).toBeNull();
    expect(inspectChannelUrl('slack', 'hooks.slack.com/services/x')?.level).toBe('error');
    expect(inspectChannelUrl('webhook', 'ftp://example.com')?.level).toBe('error');
  });

  test('Slack accepts an incoming webhook and warns on a Workflow Builder link', () => {
    expect(inspectChannelUrl('slack', SLACK)?.level).toBe('ok');
    expect(inspectChannelUrl('slack', SLACK_WORKFLOW)).toMatchObject({ level: 'warning' });
  });

  test('a Slack-compatible server is a warning, not an error', () => {
    expect(inspectChannelUrl('slack', 'https://chat.example.com/hooks/abc')?.level).toBe('warning');
  });

  test('Teams accepts both Workflows hosts and flags a retiring connector', () => {
    expect(inspectChannelUrl('teams', TEAMS_LOGIC)?.level).toBe('ok');
    expect(inspectChannelUrl('teams', TEAMS_POWER_PLATFORM)?.level).toBe('ok');
    expect(inspectChannelUrl('teams', TEAMS_CONNECTOR)).toMatchObject({ level: 'warning' });
  });

  test('a URL pasted under the wrong type suggests the right one', () => {
    expect(inspectChannelUrl('teams', SLACK)?.suggestType).toBe('slack');
    expect(inspectChannelUrl('slack', TEAMS_LOGIC)?.suggestType).toBe('teams');
    expect(inspectChannelUrl('webhook', SLACK)?.suggestType).toBe('slack');
    expect(inspectChannelUrl('webhook', TEAMS_CONNECTOR)?.suggestType).toBe('teams');
  });

  test('a plain webhook warns on http and on a private host', () => {
    expect(inspectChannelUrl('webhook', 'https://ci.example.com/piwi')?.level).toBe('ok');
    expect(inspectChannelUrl('webhook', 'http://ci.example.com/piwi')?.message).toMatch(/clear text/);
    expect(inspectChannelUrl('webhook', 'https://192.168.1.10/hook')?.message).toMatch(/private/);
    expect(inspectChannelUrl('webhook', 'http://localhost:8080/hook')?.message).toMatch(/private/);
  });
});

describe('channelTypeForUrl', () => {
  test('recognizes Slack and Teams webhooks, and nothing else', () => {
    expect(channelTypeForUrl(SLACK)).toBe('slack');
    expect(channelTypeForUrl(TEAMS_POWER_PLATFORM)).toBe('teams');
    expect(channelTypeForUrl(TEAMS_CONNECTOR)).toBe('teams');
    expect(channelTypeForUrl(SLACK_WORKFLOW)).toBeNull();
    expect(channelTypeForUrl('https://example.com/hook')).toBeNull();
  });
});

describe('Slack app link', () => {
  test('the manifest asks only for the incoming-webhook scope', () => {
    const manifest = slackAppManifest() as { oauth_config: { scopes: { bot: string[] } } };
    expect(manifest.oauth_config.scopes.bot).toEqual(['incoming-webhook']);
  });

  test('the create-app link carries the manifest, URL-encoded', () => {
    const url = new URL(slackCreateAppUrl('Piwi CI'));
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
    expect(url.searchParams.get('new_app')).toBe('1');
    const manifest = JSON.parse(url.searchParams.get('manifest_json')!);
    expect(manifest.display_information.name).toBe('Piwi CI');
    expect(manifest.display_information.description.length).toBeLessThanOrEqual(140);
  });
});

describe('channelConfigProblem', () => {
  test('each type needs its destination', () => {
    expect(channelConfigProblem('email', { address: 'team@example.com' })).toBeNull();
    expect(channelConfigProblem('email', { address: 'team' })).toMatch(/email/);
    expect(channelConfigProblem('slack', { webhookUrl: SLACK })).toBeNull();
    expect(channelConfigProblem('slack', {})).toMatch(/URL/);
    expect(channelConfigProblem('teams', { webhookUrl: 'not a url' })).toMatch(/URL/);
    expect(channelConfigProblem('webhook', { url: 'https://example.com/hook' })).toBeNull();
    expect(channelConfigProblem('webhook', { webhookUrl: 'https://example.com/hook' })).toMatch(/URL/);
    expect(channelConfigProblem('browser', {})).toBeNull();
  });
});

describe('a Slack channel posting through the Web API', () => {
  test('a channel ID makes the delivery the Web API', () => {
    expect(slackDelivery({ webhookUrl: SLACK })).toBe('webhook');
    expect(slackDelivery({ token: 'xoxb-1', channelId: 'C0123456789' })).toBe('api');
    expect(slackDelivery({ channelId: '  ' })).toBe('webhook');
  });

  test('needs a bot token and a channel ID', () => {
    expect(channelConfigProblem('slack', { token: 'xoxb-1-2', channelId: 'C0123456789' })).toBeNull();
    expect(channelConfigProblem('slack', { token: '', channelId: 'C0123456789' })).toMatch(/bot token/);
    expect(channelConfigProblem('slack', { token: 'not-a-token', channelId: 'C0123456789' })).toMatch(/xoxb-/);
    expect(channelConfigProblem('slack', { token: 'xoxb-1-2', channelId: '#general' })).toMatch(/channel ID/);
  });

  test('the app link asks for chat:write instead of an incoming webhook', () => {
    expect(slackAppManifest('Piwi', 'api')).toMatchObject({
      oauth_config: { scopes: { bot: ['chat:write', 'chat:write.public'] } },
    });
    const url = new URL(slackCreateAppUrl(undefined, 'api'));
    const manifest = JSON.parse(url.searchParams.get('manifest_json')!) as ReturnType<typeof slackAppManifest>;
    expect(manifest).toMatchObject({ oauth_config: { scopes: { bot: ['chat:write', 'chat:write.public'] } } });
  });

  test('explains Slack’s Web API refusals', () => {
    const hint = (code: string) => channelDeliveryHint('slack', `Slack API refused the message: ${code}`);
    expect(hint('invalid_auth')).toMatch(/token/);
    expect(hint('token_revoked')).toMatch(/token/);
    expect(hint('missing_scope')).toMatch(/chat:write/);
    expect(hint('not_in_channel')).toMatch(/\/invite/);
    expect(hint('channel_not_found')).toMatch(/ID/);
    expect(hint('is_archived')).toMatch(/archived/);
    expect(hint('msg_too_long')).toBeNull();
    expect(channelDeliveryHint('slack', 'Slack API rate limit reached: retry in 30 s')).toMatch(/retries/);
  });
});

describe('suggestChannelName', () => {
  test('falls back to the destination or the type', () => {
    expect(suggestChannelName('email', 'qa@example.com')).toBe('qa@example.com');
    expect(suggestChannelName('slack', SLACK)).toBe('Slack');
    expect(suggestChannelName('teams', '')).toBe('Microsoft Teams');
    expect(suggestChannelName('webhook', 'https://ci.example.com/piwi')).toBe('Webhook (ci.example.com)');
    expect(suggestChannelName('webhook', '')).toBe('Webhook');
  });
});

describe('channelDeliveryHint', () => {
  test('explains a revoked Slack webhook and an archived channel', () => {
    expect(channelDeliveryHint('slack', 'Slack returned 404: no_service')).toMatch(/revoked/);
    expect(channelDeliveryHint('slack', 'Slack returned 410: channel_is_archived')).toMatch(/archived/);
  });

  test('explains the SSRF guard and a missing SMTP setup', () => {
    expect(channelDeliveryHint('webhook', 'URL host is not allowed')).toMatch(/private/);
    expect(channelDeliveryHint('email', 'SMTP not configured')).toMatch(/SMTP/);
  });

  test('points a refused signed webhook at the secret', () => {
    expect(channelDeliveryHint('webhook', 'Webhook returned 401')).toMatch(/X-Piwi-Signature/);
    expect(channelDeliveryHint('webhook', 'Webhook returned 500')).toBeNull();
  });
});

test('generateWebhookSecret returns 64 random hex characters', () => {
  const a = generateWebhookSecret();
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(generateWebhookSecret()).not.toBe(a);
});

describe('looksPrivateHost', () => {
  test.each([
    'localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    'piwi',
    'nas.local',
    'ci.internal',
    '[::1]',
  ])('%s is local-only', (host) => {
    expect(looksPrivateHost(host)).toBe(true);
  });
  test.each(['piwi.example.com', '8.8.8.8', '172.32.0.1', 'hooks.slack.com'])('%s is public', (host) => {
    expect(looksPrivateHost(host)).toBe(false);
  });
});
