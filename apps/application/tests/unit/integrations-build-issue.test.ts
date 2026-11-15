import { describe, test, expect } from 'vitest';
import { buildIssue, issueLabels, type IssueFacts } from '../../shared/integrations/build-issue';
import { renderMarkdown } from '../../shared/integrations/render-markdown';

function facts(overrides: Partial<IssueFacts> = {}): IssueFacts {
  return {
    clusterId: 42,
    fingerprint: 'abcdef1234567890',
    title: 'Timeout on checkout',
    headline: 'page.click timed out',
    errorType: 'timeout',
    firstSeen: '1 Jan 2026, 00:00 UTC',
    lastSeen: '2 Jan 2026, 00:00 UTC',
    occurrences: 5,
    affectedTests: [{ title: 'checks out', filePath: 'checkout.spec.ts', owner: '@acme/checkout' }],
    branch: 'main',
    environment: 'staging',
    commit: 'abc123def456',
    diagnosisSummary: 'The button moved.',
    rootCause: 'A refactor renamed the selector.',
    clue: 'Timed out waiting for the app',
    errorExcerpt: 'TimeoutError: locator.click',
    failingLocator: "getByRole('button')",
    patch: '--- a\n+++ b',
    locatorEdits: [{ filePath: 'checkout.spec.ts', line: 12, failingLocator: 'a', suggestedLocator: 'b' }],
    verifyCommand: 'npx playwright test checkout.spec.ts',
    reproduceScript: 'git clone …',
    clusterUrl: 'https://piwi.test/failure-clusters/42',
    executionUrl: 'https://piwi.test/test-run-cases/9',
    runUrl: 'https://piwi.test/test-runs/3',
    shareUrl: null,
    ...overrides,
  };
}

describe('issueLabels', () => {
  test('always carries piwi, cluster and fingerprint labels', () => {
    expect(issueLabels(42, 'abcdef1234567890')).toEqual(['piwi', 'piwi-cluster-42', 'piwi-fp-abcdef12']);
  });
});

describe('buildIssue', () => {
  test('renders every section and ends with the trailer', () => {
    const md = renderMarkdown(buildIssue(facts()).document);
    expect(md).toContain('## What happened');
    expect(md).toContain('## Most likely');
    expect(md).toContain('## Evidence');
    expect(md).toContain('## What to do');
    expect(md).toContain('## Links');
    expect(md).toContain('Piwi-Cluster: 42');
    expect(md).toContain('The button moved.');
    expect(md).toContain('Root cause:');
    expect(md).toContain('A refactor renamed the selector.');
  });

  test('include toggles drop the diagnosis and patch', () => {
    const md = renderMarkdown(buildIssue(facts(), { includeDiagnosis: false, includePatch: false }).document);
    expect(md).not.toContain('The button moved.');
    expect(md).not.toContain('```diff');
    // With no diagnosis, the clue takes over "Most likely".
    expect(md).toContain('Timed out waiting for the app');
  });

  test('sections degrade independently when facts are missing', () => {
    const md = renderMarkdown(
      buildIssue(
        facts({
          diagnosisSummary: null,
          rootCause: null,
          clue: null,
          errorExcerpt: null,
          failingLocator: null,
          patch: null,
          locatorEdits: [],
          verifyCommand: null,
          reproduceScript: null,
        }),
      ).document,
    );
    expect(md).not.toContain('## Most likely');
    expect(md).not.toContain('## Evidence');
    expect(md).not.toContain('## What to do');
    // What happened and Links still render.
    expect(md).toContain('## What happened');
    expect(md).toContain('## Links');
  });

  test('the share link only appears when the toggle is on and a url exists', () => {
    const off = renderMarkdown(buildIssue(facts({ shareUrl: 'https://piwi.test/share/x' })).document);
    expect(off).not.toContain('/share/x');
    const on = renderMarkdown(
      buildIssue(facts({ shareUrl: 'https://piwi.test/share/x' }), { includeShareLink: true }).document,
    );
    expect(on).toContain('/share/x');
  });
});

describe('ticket content', () => {
  test('bold labels keep the space outside the bold, so Markdown renders them', () => {
    const md = renderMarkdown(buildIssue(facts()).document);
    expect(md).toContain('**Root cause:** A refactor renamed the selector.');
    expect(md).toContain("**Failing locator:** `getByRole('button')`");
    expect(md).not.toMatch(/\*\*[^*\n]* \*\*/);
  });

  test('what happened counts the runs and lists every branch and environment', () => {
    const md = renderMarkdown(
      buildIssue(facts({ runs: 3, branches: ['main', 'release/2.0'], environments: ['staging', 'prod'] })).document,
    );
    expect(md).toContain('- **Occurrences:** 5 in 3 runs');
    expect(md).toContain('- **Branches:** `main`, `release/2.0`');
    expect(md).toContain('- **Environments:** staging, prod');
    expect(md).toContain('- **Latest commit:** `abc123def456`');
  });

  test('a single branch falls back to the latest occurrence and reads singular', () => {
    const md = renderMarkdown(buildIssue(facts({ runs: 1 })).document);
    expect(md).toContain('- **Occurrences:** 5 in 1 run');
    expect(md).toContain('- **Branch:** `main`');
    expect(md).toContain('- **Environment:** staging');
  });

  test('the affected tests carry their own owner and failures, and count the rest', () => {
    const md = renderMarkdown(
      buildIssue(
        facts({
          affectedTests: [
            { title: 'checks out', filePath: 'checkout.spec.ts', owner: '@acme/checkout', failures: 4 },
            { title: 'pays', filePath: 'pay.spec.ts', owner: null, failures: 1 },
          ],
          moreAffectedTests: 3,
        }),
      ).document,
    );
    expect(md).toContain('### 5 affected tests');
    expect(md).toContain('| Test | File | Owner | Failures |');
    expect(md).toContain('| checks out | checkout.spec.ts | @acme/checkout | 4 |');
    expect(md).toContain('| pays | pay.spec.ts |  | 1 |');
    expect(md).toContain('…and 3 more tests.');
  });

  test('the owner column is left out when no test has an owner', () => {
    const md = renderMarkdown(
      buildIssue(facts({ affectedTests: [{ title: 'checks out', filePath: 'checkout.spec.ts', owner: null }] }))
        .document,
    );
    expect(md).toContain('| Test | File |');
    expect(md).not.toContain('Owner');
  });

  test('the diagnosis says its category and confidence', () => {
    const md = renderMarkdown(
      buildIssue(facts({ diagnosisCategory: 'app-bug', diagnosisConfidence: 'medium' })).document,
    );
    expect(md).toContain('**Category:** Application bug (medium confidence)');
    const unknown = renderMarkdown(buildIssue(facts({ diagnosisCategory: 'unknown' })).document);
    expect(unknown).not.toContain('Category');
  });

  test('issues of the same kind of failure, fixed before, are listed', () => {
    const md = renderMarkdown(
      buildIssue(
        facts({
          relatedIssues: [
            { key: 'PROJ-12', url: 'https://jira.test/browse/PROJ-12', title: 'Pay times out', status: 'Done' },
          ],
        }),
      ).document,
    );
    expect(md).toContain('## Related issues');
    expect(md).toContain(
      '- [PROJ-12](https://jira.test/browse/PROJ-12) Pay times out (Done) — the same kind of failure, fixed before',
    );
  });

  test('an issue a rule filed opens with what the rule counted, in the ticket language', () => {
    const automatic = {
      ruleIndex: 0,
      occurrences: 4,
      runs: 2,
      days: 1,
      firstFailureAt: Date.UTC(2026, 9, 6),
      branches: ['main'],
      environments: ['staging'],
    };
    const md = renderMarkdown(buildIssue(facts({ automatic })).document);
    expect(
      md.startsWith(
        'Filed automatically by Piwi after 4 occurrences in 2 runs since Oct 6, 2026. Counted on main (staging).',
      ),
    ).toBe(true);
    const fr = renderMarkdown(buildIssue(facts({ automatic }), { locale: 'fr' }).document);
    expect(fr).toContain('Créé automatiquement par Piwi après 4 occurrences sur 2 séries depuis le 6 oct. 2026.');
    const envOnly = renderMarkdown(
      buildIssue(facts({ automatic: { ...automatic, branches: [], environments: ['prod'] } })).document,
    );
    expect(envOnly).toContain('Counted in the prod environment.');
  });
});

describe('the verify command', () => {
  test('lists the tests it leaves out under it, as code that holds a backtick', () => {
    const md = renderMarkdown(buildIssue(facts({ verifyLeftOut: ['refunds', 'shows `total`'] })).document);
    expect(md).toContain('The command leaves out these tests, run them yourself: `refunds`, `` shows `total` ``');
    const one = renderMarkdown(buildIssue(facts({ verifyLeftOut: ['refunds'] })).document);
    expect(one).toContain('The command leaves out this test, run it yourself: `refunds`');
  });
});
