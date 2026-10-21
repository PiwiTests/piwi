import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { renderNotificationEmail } from '../../server/utils/email';
import type {
  ClusterFixedPayload,
  ClusterNewPayload,
  ClusterRegressedPayload,
  RunFinishedPayload,
} from '#shared/notification-events';

const SITE = 'https://piwi.example.com';

const fixed: ClusterFixedPayload = {
  clusterId: 42,
  projectId: 2,
  projectName: 'checkout',
  signature: 'TimeoutError: locator.click',
  title: 'Pay button never enables',
  runId: 9,
  verification: 'stopped-failing',
};

const regressed: ClusterRegressedPayload = {
  clusterId: 42,
  projectId: 2,
  projectName: 'checkout',
  signature: 'TimeoutError: locator.click',
  title: 'Pay button never enables',
  runId: 10,
  fixLandedRunId: 9,
};

const knownIssue = { key: 'PAY-17', url: 'https://tracker.example.com/browse/PAY-17' };

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

let previousSiteUrl: string | undefined;

beforeEach(() => {
  previousSiteUrl = process.env.PIWI_SITE_URL;
  process.env.PIWI_SITE_URL = SITE;
});

afterEach(() => {
  if (previousSiteUrl === undefined) delete process.env.PIWI_SITE_URL;
  else process.env.PIWI_SITE_URL = previousSiteUrl;
});

describe('cluster.fixed email', () => {
  test('carries the verdict, project, cluster title, signature and a link to the cluster', () => {
    const { html, text } = renderNotificationEmail('cluster.fixed', fixed);
    expect(html).toContain('Cluster stopped failing');
    expect(html).toContain('checkout');
    expect(html).toContain('Pay button never enables');
    expect(html).toContain('TimeoutError: locator.click');
    expect(html).toContain(`href="${SITE}/failure-clusters/42"`);
    expect(text).toContain('Cluster stopped failing in checkout');
    expect(text).toContain('Pay button never enables\nTimeoutError: locator.click');
    expect(text).toContain(`View: ${SITE}/failure-clusters/42`);
  });

  test('names the known issue with a link when the payload has one', () => {
    const { html, text } = renderNotificationEmail('cluster.fixed', { ...fixed, knownIssue });
    expect(html).toContain(`Tracked in <a href="${knownIssue.url}"`);
    expect(html).toContain('>PAY-17</a>');
    expect(text).toContain(`Tracked in PAY-17: ${knownIssue.url}`);
  });

  test('omits the known-issue line when the payload has none', () => {
    const { html, text } = renderNotificationEmail('cluster.fixed', fixed);
    expect(html).not.toContain('Tracked in');
    expect(text).not.toContain('Tracked in');
  });

  test('says when the verdict resolved the cluster, and a verified fix names itself', () => {
    const { html, text } = renderNotificationEmail('cluster.fixed', {
      ...fixed,
      verification: 'diagnosis-verified',
      resolved: true,
    });
    expect(html).toContain('Diagnosis verified');
    expect(html).toContain('Triage status set to resolved.');
    expect(text).toContain('Triage status set to resolved.');
    expect(renderNotificationEmail('cluster.fixed', fixed).html).not.toContain('Triage status');
  });

  test('shows the signature once when there is no title, or the title is the signature', () => {
    const noTitle = renderNotificationEmail('cluster.fixed', { ...fixed, title: null });
    expect(occurrences(noTitle.html, fixed.signature)).toBe(1);
    expect(noTitle.text).toContain('checkout\n\nTimeoutError: locator.click\n\nView:');
    const same = renderNotificationEmail('cluster.fixed', { ...fixed, title: fixed.signature });
    expect(occurrences(same.html, fixed.signature)).toBe(1);
    expect(same.text).not.toContain(`${fixed.signature}\n${fixed.signature}`);
  });
});

describe('cluster.regressed email', () => {
  test('carries the regression, cluster, known issue and link', () => {
    const { html, text } = renderNotificationEmail('cluster.regressed', { ...regressed, knownIssue });
    expect(html).toContain('Fix regressed');
    expect(html).toContain('Pay button never enables');
    expect(html).toContain('TimeoutError: locator.click');
    expect(html).toContain('>PAY-17</a>');
    expect(html).toContain(`href="${SITE}/failure-clusters/42"`);
    expect(html).not.toContain('Triage status');
    expect(text).toContain('Fix regressed in checkout');
    expect(text).toContain(`Tracked in PAY-17: ${knownIssue.url}`);
  });

  test('says when the regression reopened the cluster', () => {
    const { html, text } = renderNotificationEmail('cluster.regressed', { ...regressed, reopened: true });
    expect(html).toContain('Triage status set back to open.');
    expect(text).toContain('Triage status set back to open.');
  });
});

describe('notification email escaping', () => {
  const hostile = '<img src=x onerror=alert(1)> & "quoted"';
  const escaped = '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;';

  test('cluster.fixed escapes the project, title, signature and known issue', () => {
    const { html } = renderNotificationEmail('cluster.fixed', {
      ...fixed,
      projectName: hostile,
      title: hostile,
      signature: `${hostile} sig`,
      knownIssue: { key: hostile, url: 'https://tracker.example.com/?a=1&b="2"' },
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(escaped);
    expect(html).toContain('href="https://tracker.example.com/?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain(`<title>Cluster stopped failing — ${escaped}</title>`);
  });

  test('cluster.regressed escapes the project and title', () => {
    const { html } = renderNotificationEmail('cluster.regressed', {
      ...regressed,
      projectName: hostile,
      title: hostile,
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(escaped);
  });

  test('cluster.new escapes the title, project and known-issue link', () => {
    const payload: ClusterNewPayload = {
      clusterId: 5,
      projectId: 2,
      projectName: hostile,
      signature: 'sig',
      title: hostile,
      runId: 1,
      knownIssue: { key: 'K-1', url: 'https://tracker.example.com/?a=1&b="2"' },
    };
    const { html } = renderNotificationEmail('cluster.new', payload);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('href="https://tracker.example.com/?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain(`<title>New failure cluster — ${escaped}</title>`);
  });

  test('an event without a template escapes its subject line', () => {
    const payload = { projectName: hostile, runId: 3 } as RunFinishedPayload;
    const { html, text } = renderNotificationEmail('flakiness.spike', payload);
    expect(html).toBe(`<p>Flakiness spike — ${escaped}</p>`);
    expect(text).toBe(`Flakiness spike — ${hostile}`);
  });
});
