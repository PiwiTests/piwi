import { describe, expect, it } from 'vitest';
import {
  teamsDigestMessage,
  teamsEscape,
  teamsEventMessage,
  teamsReportMessage,
} from '../../server/utils/notifications/teams';
import { fixtureBundle, HOSTILE } from './report-fixture';

function card(message: any) {
  expect(message.type).toBe('message');
  const attachment = message.attachments[0];
  expect(attachment.contentType).toBe('application/vnd.microsoft.card.adaptive');
  expect(attachment.content.type).toBe('AdaptiveCard');
  return attachment.content;
}

describe('Microsoft Teams cards', () => {
  it('escapes markdown in run-derived text', () => {
    expect(teamsEscape('[click](https://evil) *bold* # h')).toBe('\\[click\\]\\(https://evil\\) \\*bold\\* \\# h');
  });

  it('an event: the subject, the failures, a button to the run', () => {
    const content = card(
      teamsEventMessage(
        'run.failed',
        {
          projectId: 1,
          projectName: 'checkout',
          runId: 42,
          status: 'failed',
          totalTests: 3,
          failedTests: 1,
          topFailures: [{ title: 'pays [with](x) a card', headline: 'Timeout', testCaseId: 7, executionId: 9 }],
        } as any,
        'https://piwi.example',
      ),
    );
    const text = JSON.stringify(content.body);
    expect(text).toContain('checkout');
    expect(text).toContain('pays \\\\[with\\\\]\\\\(x\\\\) a card');
    expect(content.actions[0].url).toMatch(/^https:\/\/piwi\.example\//);
  });

  it('a digest: one line per notification', () => {
    const content = card(
      teamsDigestMessage(
        [
          { event: 'cluster.new', payload: { projectId: 1, projectName: 'a', clusterId: 3, signature: 's' } as any },
          { event: 'cluster.fixed', payload: { projectId: 1, projectName: 'a', clusterId: 4, signature: 't' } as any },
        ],
        'https://piwi.example',
      ),
    );
    expect(content.body[0].items[0].text).toBe('Piwi digest: 2 notifications');
    expect(content.body.slice(1).map((b: any) => b.text)).toEqual([
      '🔴 [New failure cluster — a](https://piwi.example/failure-clusters/3)',
      '🟢 [Cluster stopped failing — a](https://piwi.example/failure-clusters/4)',
    ]);
  });

  it('a quality report: the verdict, the tiles as facts, the trend image through the share link', () => {
    const share = 'https://piwi.example/share/psl_' + 'b'.repeat(64);
    const content = card(teamsReportMessage(fixtureBundle(), 'https://piwi.example/reports/7', share));
    expect(content.body.some((b: any) => b.type === 'FactSet' && b.facts.length > 0)).toBe(true);
    expect(content.body.find((b: any) => b.type === 'Image').url).toBe(`${share}/chart.png`);
    expect(content.actions.map((a: any) => a.url)).toEqual(['https://piwi.example/reports/7', share]);
    expect(JSON.stringify(content)).not.toContain(HOSTILE);
  });

  it('a quality report without a share link draws the trend as a text sparkline', () => {
    const content = card(teamsReportMessage(fixtureBundle(), 'https://piwi.example/reports/7'));
    expect(content.body.some((b: any) => b.type === 'Image')).toBe(false);
    expect(JSON.stringify(content.body)).toMatch(/[▁▂▃▄▅▆▇█]/);
  });
});
