import { describe, test, expect } from 'vitest';
import {
  filedBySentence,
  filingFailureSentence,
  filingSkippedSentence,
  issueKeyTitle,
  issueLineForm,
  offersFoundIssueLink,
  type IssueLineFacts,
} from '../../app/utils/issue-line';

const facts = (over: Partial<IssueLineFacts> = {}): IssueLineFacts => ({
  hasKnownIssue: false,
  filingQueued: false,
  clusterStatus: 'open',
  snoozed: false,
  canFile: true,
  canLink: true,
  ...over,
});

describe('issueLineForm', () => {
  test('a tracked cluster always shows its issue, whatever its status or the viewer', () => {
    expect(issueLineForm(facts({ hasKnownIssue: true }))).toBe('tracked');
    expect(
      issueLineForm(facts({ hasKnownIssue: true, clusterStatus: 'ignored', canFile: false, canLink: false })),
    ).toBe('tracked');
  });

  test('a filing waiting on the tracker shows as queued', () => {
    expect(issueLineForm(facts({ filingQueued: true }))).toBe('queued');
  });

  test('an untracked open cluster offers to file or link to a viewer who can', () => {
    expect(issueLineForm(facts())).toBe('untracked');
    expect(issueLineForm(facts({ canFile: false }))).toBe('untracked');
    expect(issueLineForm(facts({ canFile: false, canLink: false }))).toBeNull();
  });

  test('an ignored, resolved or snoozed cluster asks for no ticket', () => {
    expect(issueLineForm(facts({ clusterStatus: 'ignored' }))).toBeNull();
    expect(issueLineForm(facts({ clusterStatus: 'resolved' }))).toBeNull();
    expect(issueLineForm(facts({ snoozed: true }))).toBeNull();
  });
});

describe('filingFailureSentence', () => {
  test("quotes Jira's own explanation", () => {
    expect(
      filingFailureSentence(
        'Jira request failed (400 Bad Request): The issue could not be created: the Checkout project is archived.',
      ),
    ).toBe('The last filing failed: Jira answered “The issue could not be created: the Checkout project is archived.”');
    expect(filingFailureSentence('Jira request failed (403 Forbidden): You cannot create issues here')).toBe(
      'The last filing failed: Jira answered “You cannot create issues here.”',
    );
  });

  test('gives the status Jira answered with when it explained nothing', () => {
    expect(filingFailureSentence('Jira request failed (404 Not Found)')).toBe(
      'The last filing failed: Jira answered 404 Not Found.',
    );
  });

  test('gives any other recorded reason as it is', () => {
    expect(filingFailureSentence('connection has no usable credentials')).toBe(
      'The last filing failed: connection has no usable credentials.',
    );
    expect(filingFailureSentence(null)).toBe('The last filing failed.');
  });

  test('says how long ago the filing failed when given', () => {
    expect(filingFailureSentence('Jira request failed (400 Bad Request): Severity is required', '3 days ago')).toBe(
      'The last filing failed 3 days ago: Jira answered “Severity is required.”',
    );
    expect(filingFailureSentence(null, '3 days ago')).toBe('The last filing failed 3 days ago.');
  });
});

describe('filingSkippedSentence', () => {
  test('names the open issue a rule found, with how long ago when given', () => {
    expect(filingSkippedSentence('PROJ-900')).toBe(
      "Automatic filing skipped: PROJ-900 is already open with this failure's labels.",
    );
    expect(filingSkippedSentence('PROJ-900', '2 hours ago')).toBe(
      "Automatic filing skipped 2 hours ago: PROJ-900 is already open with this failure's labels.",
    );
  });
});

describe('offersFoundIssueLink', () => {
  test('offers to link the open issue a rule found, beside a Done issue too, to a viewer who may link', () => {
    const skipped = { error: null, at: null, existingKey: 'PROJ-900' };
    expect(offersFoundIssueLink(skipped, true)).toBe(true);
    expect(offersFoundIssueLink(skipped, false)).toBe(false);
  });

  test('a failed filing names no issue to link', () => {
    expect(offersFoundIssueLink({ error: 'Severity is required', at: null }, true)).toBe(false);
    expect(offersFoundIssueLink(null, true)).toBe(false);
  });
});

describe('issueKeyTitle', () => {
  test("names the issue's summary and that the link opens the tracker", () => {
    expect(issueKeyTitle('CHK-7', 'Users table shows 50 rows instead of 25', 'Jira')).toBe(
      'CHK-7: Users table shows 50 rows instead of 25. Opens in Jira.',
    );
    expect(issueKeyTitle('OPS-3', null, null)).toBe('OPS-3. Opens in the tracker.');
  });
});

describe('filedBySentence', () => {
  test('names the person who filed the issue, with how long ago', () => {
    expect(filedBySentence({ filedBy: 'Priya Shah' }, '2 days ago')).toBe('Filed by Priya Shah, 2 days ago.');
    expect(filedBySentence({ filedBy: 'Priya Shah' })).toBe('Filed by Priya Shah.');
  });

  test('says automatically for a rule, and names nobody', () => {
    expect(filedBySentence({ filedBy: null, automatic: true }, 'today')).toBe('Filed automatically, today.');
  });

  test('says nothing for an issue that was linked rather than filed', () => {
    expect(filedBySentence({ filedBy: null, automatic: false }, 'today')).toBeNull();
    expect(filedBySentence({})).toBeNull();
  });
});
