import { describe, expect, test } from 'vitest';
import { slackDigestMessage, slackEventMessage } from '../../server/utils/notifications/slack-message';
import { teamsEventMessage, teamsLink } from '../../server/utils/notifications/teams';
import {
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationPayload,
  type RunFinishedPayload,
} from '#shared/notification-events';
import { outcomeSquares, runSegments } from '#shared/notifications/message-parts';

const BASE = 'https://piwi.example.test';

const snippet = ["    41 |   await page.goto('/pay');", ">   42 |   await page.getByRole('button').click();"].join(
  '\n',
);

const failedRun: RunFinishedPayload = {
  runId: 12,
  projectId: 1,
  projectName: 'checkout',
  status: 'failed',
  totalTests: 20,
  failedTests: 3,
  passedTests: 16,
  flakyTests: 1,
  skippedTests: 1,
  branch: 'main',
  environment: 'staging',
  durationMs: 65_000,
  commit: {
    sha: 'abcdef1234567',
    message: 'Check the card',
    author: 'Alex',
    url: 'https://github.com/acme/shop/commit/abcdef1234567',
  },
  ciUrl: 'https://ci.example.com/build/9',
  owners: ['@team/pay'],
  history: [
    { runId: 10, status: 'passed', failedTests: 0 },
    { runId: 11, status: 'passed', failedTests: 0 },
    { runId: 12, status: 'failed', failedTests: 3 },
  ],
  topFailures: [
    {
      title: 'pays',
      suitePath: ['Checkout'],
      filePath: 'tests/pay.spec.ts',
      line: 40,
      browserName: 'chromium',
      headline: 'The Pay button never became enabled',
      errorExcerpt: 'Error: expect(locator).toHaveText(expected) failed\nExpected: "Paid"\nReceived: "Pending"',
      source: { file: 'tests/pay.spec.ts', line: 42, snippet },
      history: ['passed', 'passed', 'failed'],
      executionId: 70,
    },
  ],
};

const HOSTILE = '<!channel> <https://evil.example|Piwi login> [a](https://evil.example) *x* & more';

/** A payload of every event with every free-text field hostile. */
function hostilePayloads(): Record<NotificationEvent, NotificationPayload> {
  const run: RunFinishedPayload = {
    ...failedRun,
    projectName: HOSTILE,
    branch: HOSTILE,
    environment: HOSTILE,
    owners: [HOSTILE],
    commit: { sha: 'abcdef1', message: HOSTILE, author: HOSTILE },
    topFailures: [
      {
        ...failedRun.topFailures![0]!,
        title: HOSTILE,
        suitePath: [HOSTILE],
        filePath: HOSTILE,
        owner: HOSTILE,
        browserName: HOSTILE,
        headline: HOSTILE,
        errorExcerpt: HOSTILE,
        source: { file: HOSTILE, line: 1, snippet: `>  1 | const a = '${HOSTILE}';` },
      },
    ],
  };
  const cluster = { clusterId: 5, projectId: 1, projectName: HOSTILE, signature: HOSTILE, title: HOSTILE, runId: 12 };
  return {
    'run.finished': run,
    'run.failed': run,
    'run.failed.default_branch': run,
    'run.interrupted': { ...run, status: 'interrupted' },
    'flakiness.spike': run,
    'perf.regression': { ...run, baselineDurationMs: 30_000, regressionPct: 100 },
    'cluster.new': {
      ...cluster,
      sampleErrorExcerpt: HOSTILE,
      knownIssue: { key: HOSTILE, url: 'javascript:alert(1)' },
    },
    'cluster.fixed': { ...cluster, verification: 'stopped-failing', fixAuthor: { name: HOSTILE, email: 'a@b.c' } },
    'cluster.regressed': { ...cluster, fixLandedRunId: 11 },
    'diagnosis.completed': { clusterId: 5, projectId: 1, summary: HOSTILE, rootCause: HOSTILE, category: HOSTILE },
    'auto_heal.pr_opened': {
      projectId: 1,
      projectName: HOSTILE,
      runId: 12,
      prNumber: 7,
      prUrl: 'https://github.com/acme/shop/pull/7',
      branch: HOSTILE,
      editCount: 2,
    },
    'bug.looks_fixed': {
      projectId: 1,
      projectName: HOSTILE,
      runId: 12,
      tests: [{ title: HOSTILE, filePath: HOSTILE, executionId: 9, testCaseId: 4, link: 'javascript:alert(1)' }],
    },
    'environment.incident': {
      ...run,
      rule: 'host-unreachable',
      reason: HOSTILE,
      host: HOSTILE,
      otherProjects: 1,
      incidentKey: 'k',
    },
  };
}

/** Every block of a Slack message, its attachments' included. */
function slackBlocks(message: any): any[] {
  return [...message.blocks, ...(message.attachments ?? []).flatMap((a: any) => a.blocks)];
}

describe('the Slack message of a failed run', () => {
  const message = slackEventMessage('run.failed', failedRun, BASE) as any;
  const json = JSON.stringify(message);

  test('heads with the failure count, then the run, in the tone of a failure', () => {
    expect(message.blocks[0]).toMatchObject({ type: 'header', text: { text: ':x: 3 tests failed' } });
    expect(message.blocks[1].elements[0].text).toBe(
      '*Run failed · checkout*  ·  out of 20  ·  Run #12  ·  main  ·  staging  ·  1m 5s',
    );
    expect(message.attachments[0].color).toBe('#f43f5e');
  });

  test('draws the outcomes and the history as squares', () => {
    expect(json).toContain(outcomeSquares(runSegments(failedRun), 20));
    expect(json).toContain('*15* passed 75%');
    expect(json).toContain('🟩🟩🟥   *First failure after 2 passing runs*');
  });

  test('lists the commit, the build and the owners as fields', () => {
    const fields = slackBlocks(message)
      .find((b) => b.fields)!
      .fields.map((f: any) => f.text);
    expect(fields).toEqual([
      '*Commit*\n<https://github.com/acme/shop/commit/abcdef1234567|abcdef1> Check the card by Alex',
      '*CI build*\n<https://ci.example.com/build/9|Open the build>',
      '*Owners*\n@team/pay',
    ]);
  });

  test('shows each failure with its path, location, code, error and history', () => {
    const text = slackBlocks(message)
      .map((b) => b.text?.text ?? b.elements?.[0]?.text ?? '')
      .join('\n');
    expect(text).toContain(`:new: *New failure*  ·  chromium\nCheckout › *<${BASE}/test-run-cases/70|pays>*`);
    expect(text).toContain('`tests/pay.spec.ts:40`');
    expect(text).toContain("```  41 │ await page.goto('/pay');\n› 42 │ await page.getByRole('button').click();```");
    expect(text).toContain('Expected: "Paid"');
    expect(text).toContain('🟩🟩🟥   Passed in each of the 2 runs before');
  });

  test('ends with buttons to the run and the build', () => {
    const actions = slackBlocks(message).find((b) => b.type === 'actions');
    expect(actions.elements.map((e: any) => e.url)).toEqual([`${BASE}/test-runs/12`, 'https://ci.example.com/build/9']);
  });

  test('stays within Slack limits', () => {
    for (const block of slackBlocks(message)) {
      if (block.text?.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
    expect(message.blocks[0].text.text.length).toBeLessThanOrEqual(150);
    expect(message.attachments[0].blocks.length).toBeLessThanOrEqual(50);
  });
});

describe('every Slack message', () => {
  test('shows hostile values as text, never as a mention or a link of their own', () => {
    for (const [event, payload] of Object.entries(hostilePayloads())) {
      const json = JSON.stringify(slackEventMessage(event as NotificationEvent, payload, BASE));
      expect(json, event).not.toContain('<!channel>');
      expect(json, event).not.toContain('<https://evil.example');
      expect(json, event).not.toContain('javascript:');
    }
    expect(NOTIFICATION_EVENTS.length).toBe(Object.keys(hostilePayloads()).length);
  });

  test('a digest lists each notification with its run squares, and counts what fails', () => {
    const message = slackDigestMessage(
      [
        { event: 'run.failed', payload: failedRun },
        { event: 'cluster.fixed', payload: hostilePayloads()['cluster.fixed'] },
      ],
      BASE,
    ) as any;
    expect(message.blocks[0].text.text).toBe(':bell: 2 notifications');
    expect(message.blocks[1].elements[0].text).toContain('*1 needs attention*');
    expect(message.attachments[0].blocks[0].text.text).toContain(
      `<${BASE}/test-runs/12|Test run failed — checkout (main)>`,
    );
    expect(message.attachments[0].blocks[0].text.text).toContain('🟩');
  });
});

function card(message: any) {
  return message.attachments[0].content;
}

describe('the Teams card of a failed run', () => {
  const content = card(teamsEventMessage('run.failed', failedRun, BASE));
  const json = JSON.stringify(content);

  test('opens with the headline on a band of the failure color', () => {
    const banner = content.body[0];
    expect(banner).toMatchObject({ type: 'Container', style: 'attention', bleed: true });
    expect(banner.items[1].inlines.map((i: any) => i.text).join('')).toBe('3 tests failed');
    expect(banner.items[1].inlines[0]).toMatchObject({ size: 'ExtraLarge', color: 'Attention' });
  });

  test('draws the outcomes as a chart, with squares where the client has no chart', () => {
    const chart = content.body.find((b: any) => b.type === 'Chart.HorizontalBar.Stacked');
    expect(chart.data[0].data.map((d: any) => [d.legend, d.value, d.color])).toEqual([
      ['passed', 15, 'good'],
      ['failed', 3, 'attention'],
      ['flaky', 1, 'categoricalPurple'],
      ['skipped', 1, 'neutral'],
    ]);
    expect(chart.fallback.text).toContain(outcomeSquares(runSegments(failedRun), 20));
  });

  test('shows the code in a colored code block, numbered lines where the client has none', () => {
    const failure = content.body.find((b: any) => b.selectAction);
    const code = failure.items.find((i: any) => i.type === 'CodeBlock');
    expect(code).toMatchObject({ language: 'TypeScript', startLineNumber: 41 });
    expect(code.codeSnippet).toBe("await page.goto('/pay');\nawait page.getByRole('button').click();");
    expect(code.fallback.items.map((i: any) => i.text)).toEqual([
      "\u00a0\u00a041 │ await page.goto\\('/pay'\\);",
      "› 42 │ await page.getByRole\\('button'\\).click\\(\\);",
    ]);
    // The code comes from the test's own file: its line is named, not the file again.
    expect(failure.items.map((i: any) => i.text)).toContain('Failed at line 42');
    expect(failure.selectAction.url).toBe(`${BASE}/test-run-cases/70`);
  });

  test('colors the expected value green and the received one red', () => {
    expect(json).toContain(
      '"text":"Expected: \\"Paid\\"","wrap":true,"fontType":"Monospace","size":"Small","spacing":"None","color":"Good"',
    );
    expect(json).toContain('"color":"Attention"');
  });

  test('lists the facts with their links, and buttons to the run and the build', () => {
    const facts = content.body.find((b: any) => b.type === 'FactSet').facts;
    expect(facts[0]).toEqual({
      title: 'Commit',
      value: '[abcdef1](https://github.com/acme/shop/commit/abcdef1234567) Check the card by Alex',
    });
    expect(content.actions.map((a: any) => a.url)).toEqual([`${BASE}/test-runs/12`, 'https://ci.example.com/build/9']);
  });
});

describe('every Teams card', () => {
  test('escapes hostile values so they render as text', () => {
    for (const [event, payload] of Object.entries(hostilePayloads())) {
      // A code block is shown as code, never read as markdown.
      const json = JSON.stringify(card(teamsEventMessage(event as NotificationEvent, payload, BASE)), (key, value) =>
        key === 'codeSnippet' ? undefined : value,
      );
      expect(json, event).not.toContain('[a](https://evil.example)');
      expect(json, event).not.toContain('javascript:');
    }
  });

  test('a link to an address that is not http(s) keeps its label alone', () => {
    expect(teamsLink('ticket', 'javascript:alert(1)')).toBe('ticket');
    expect(teamsLink('a [b]', 'https://x.example/a(b) c')).toBe('[a \\[b\\]](https://x.example/a%28b%29%20c)');
  });
});
