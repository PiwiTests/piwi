import { describe, test, expect } from 'vitest';
import {
  ATLASSIAN_API_GATEWAY,
  JIRA_SCOPED_TOKEN_SCOPES,
  assigneeSearchHint,
  jiraFailureHint,
  jiraGatewayUrl,
  jiraProjectUrl,
  jiraSiteLabel,
  jiraWebhooksAdminUrl,
  maxTokenExpiryDate,
  normalizeJiraSiteUrl,
  tokenExpiry,
} from '#shared/integrations/jira-setup';

describe('normalizeJiraSiteUrl', () => {
  test.each([
    ['acme', 'https://acme.atlassian.net'],
    ['acme.atlassian.net', 'https://acme.atlassian.net'],
    ['  https://ACME.atlassian.net/  ', 'https://acme.atlassian.net'],
    ['http://acme.atlassian.net', 'https://acme.atlassian.net'],
    ['https://acme.atlassian.net/jira/software/projects/ABC/boards/1', 'https://acme.atlassian.net'],
    ['https://acme.atlassian.net/browse/ABC-12?focusedCommentId=1', 'https://acme.atlassian.net'],
    ['https://legacy.jira.com/secure/Dashboard.jspa', 'https://legacy.jira.com'],
  ])('reads %s as the Cloud site %s', (input, expected) => {
    expect(normalizeJiraSiteUrl(input)).toEqual({ url: expected, kind: 'cloud' });
  });

  test.each([
    ['https://jira.example.com/browse/ABC-1', 'https://jira.example.com'],
    ['https://example.com/jira/browse/ABC-1', 'https://example.com/jira'],
    ['http://10.0.0.5:8080/secure/Dashboard.jspa', 'http://10.0.0.5:8080'],
    ['jira.internal.example.com/', 'https://jira.internal.example.com'],
  ])('keeps a self-hosted site and its context path: %s', (input, expected) => {
    expect(normalizeJiraSiteUrl(input)).toEqual({ url: expected, kind: 'self-hosted' });
  });

  test.each(['', '   ', 'ftp://acme.atlassian.net', 'not a url', 'https://'])('rejects %j', (input) => {
    expect(normalizeJiraSiteUrl(input)).toBeNull();
  });

  test('a host that only ends in the Cloud suffix text is not Cloud', () => {
    expect(normalizeJiraSiteUrl('https://atlassian.net')?.kind).toBe('self-hosted');
  });
});

describe('Jira setup links', () => {
  test('site pages hang off the site URL', () => {
    expect(jiraWebhooksAdminUrl('https://acme.atlassian.net/')).toBe(
      'https://acme.atlassian.net/plugins/servlet/webhooks',
    );
    expect(jiraProjectUrl('https://acme.atlassian.net', 'ABC')).toBe('https://acme.atlassian.net/browse/ABC');
    expect(jiraGatewayUrl('1234')).toBe(`${ATLASSIAN_API_GATEWAY}/1234`);
  });

  test('the site label is the Cloud site name, else the host', () => {
    expect(jiraSiteLabel('https://acme.atlassian.net')).toBe('acme');
    expect(jiraSiteLabel('https://jira.example.com/jira')).toBe('jira.example.com');
  });

  test('the scopes a scoped token needs match what the client calls', () => {
    expect(JIRA_SCOPED_TOKEN_SCOPES.map((s) => s.scope)).toEqual([
      'read:jira-work',
      'write:jira-work',
      'read:jira-user',
    ]);
  });
});

describe('jiraFailureHint', () => {
  test('an unreachable address points at the network', () => {
    expect(jiraFailureHint('site', { status: null })).toMatch(/proxy, firewall or VPN/);
  });

  test('a 404 on the site explains the Cloud address', () => {
    expect(jiraFailureHint('site', { status: 404 })).toMatch(/atlassian\.net/);
  });

  test('a 401 naming a scope lists the scopes', () => {
    const hint = jiraFailureHint('auth', { status: 401, message: 'Unauthorized; scope does not match' });
    expect(hint).toContain('read:jira-work');
    expect(hint).toContain('read:jira-user');
  });

  test('a plain 401 is about the email and token', () => {
    expect(jiraFailureHint('auth', { status: 401, message: 'Client must be authenticated' })).toMatch(
      /email and token/,
    );
  });

  test('a 403 while listing projects is about Browse Projects', () => {
    expect(jiraFailureHint('projects', { status: 403 })).toMatch(/Browse Projects/);
  });

  test('an error with nothing to add yields null', () => {
    expect(jiraFailureHint('projects', { status: 500 })).toBeNull();
  });
});

describe('assigneeSearchHint', () => {
  test.each([401, 403])('a %i names the permission and the scope', (status) => {
    const hint = assigneeSearchHint(status);
    expect(hint).toContain('Assign Issues');
    expect(hint).toContain('Browse users and groups');
    expect(hint).toContain('read:jira-user');
  });

  test('a 404 is about the project key', () => {
    expect(assigneeSearchHint(404)).toMatch(/project key/);
  });

  test('a 429 asks to try again', () => {
    expect(assigneeSearchHint(429)).toMatch(/Try again/);
  });

  test('any other status, or none, yields null', () => {
    expect(assigneeSearchHint(500)).toBeNull();
    expect(assigneeSearchHint(null)).toBeNull();
    expect(assigneeSearchHint(undefined)).toBeNull();
  });
});

describe('tokenExpiry', () => {
  const now = new Date('2026-09-27T12:00:00Z');

  test('no date or a malformed one yields null', () => {
    expect(tokenExpiry(undefined, now)).toBeNull();
    expect(tokenExpiry('27/09/2026', now)).toBeNull();
  });

  test('a far date is ok, a near one is soon, a past one expired', () => {
    expect(tokenExpiry('2027-01-01', now)?.state).toBe('ok');
    expect(tokenExpiry('2026-10-05', now)).toEqual({ state: 'soon', daysLeft: 8 });
    expect(tokenExpiry('2026-09-27', now)?.state).toBe('expired');
    expect(tokenExpiry('2026-09-01', now)?.state).toBe('expired');
  });

  test('the longest allowed lifetime is one year out', () => {
    expect(maxTokenExpiryDate(now)).toBe('2027-09-27');
  });
});
