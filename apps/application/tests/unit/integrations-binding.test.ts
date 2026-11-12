import { describe, test, expect } from 'vitest';
import {
  DEFAULT_PROJECT_INTEGRATION,
  resolveProjectIntegration,
  resolveTagSource,
  pickOwnerRoute,
  normalizeOwner,
  type OwnerRoute,
} from '../../shared/integrations/binding';

describe('resolveProjectIntegration', () => {
  test('empty input yields the documented defaults', () => {
    expect(resolveProjectIntegration()).toEqual(DEFAULT_PROJECT_INTEGRATION);
    expect(resolveProjectIntegration(null)).toEqual(DEFAULT_PROJECT_INTEGRATION);
    expect(resolveProjectIntegration({})).toEqual(DEFAULT_PROJECT_INTEGRATION);
  });

  test('every policy is off and auto-create disabled by default', () => {
    const { policies, autoCreate } = resolveProjectIntegration({});
    expect(policies.commentOnFix).toBe(false);
    expect(policies.transitionOnFix).toBe(false);
    expect(policies.commentOnRegression).toBe(false);
    expect(policies.resolveOnClose).toBe(false);
    expect(policies.reopenOnTicketReopen).toBe(false);
    expect(policies.commentOnMerge).toBe(false);
    expect(policies.commentOnNewOccurrences).toBe(false);
    expect(policies.commentOnDiagnosis).toBe(false);
    expect(policies.updateDescription).toBe(false);
    expect(policies.newOccurrencesEvery).toBe('day');
    expect(policies.newOccurrencesMin).toBe(1);
    expect(policies.needsTicketAfterDays).toBe(2);
    // The write-backs follow every run until a scope names branches or environments.
    expect(policies.scope).toEqual({ branches: [], defaultBranch: false, environments: [] });
    expect(autoCreate.enabled).toBe(false);
    expect(autoCreate.skipFlaky).toBe(true);
    expect(autoCreate.dailyCap).toBe(5);
    expect(autoCreate.rules).toEqual([
      {
        branches: [],
        defaultBranch: true,
        environments: [],
        tags: [],
        minOccurrences: 2,
        minRuns: 2,
        minDays: 0,
        labels: [],
      },
    ]);
  });

  test('a stored auto-create policy without rules becomes one rule on the default branch', () => {
    const { autoCreate } = resolveProjectIntegration({
      autoCreate: {
        enabled: false,
        minOccurrences: 4,
        minRuns: 3,
        dailyCap: 2,
        routeUnmatchedToDefault: true,
      } as never,
    });
    expect(autoCreate.rules).toHaveLength(1);
    expect(autoCreate.rules[0]).toMatchObject({ defaultBranch: true, minOccurrences: 4, minRuns: 3, minDays: 0 });
    expect(autoCreate.dailyCap).toBe(2);
    expect(autoCreate.routeUnmatchedToDefault).toBe(true);
  });

  test('auto-create rules normalize their patterns, tags and thresholds', () => {
    const { autoCreate } = resolveProjectIntegration({
      autoCreate: {
        enabled: true,
        rules: [
          { branches: [' release/* ', 'release/*', ''], environments: ['staging'], tags: ['@smoke', 'smoke'] },
          { defaultBranch: true, minOccurrences: 0, minRuns: 500, minDays: -2 },
        ],
      } as never,
    });
    expect(autoCreate.enabled).toBe(true);
    // A rule that names branches does not follow the default branch unless it says so.
    expect(autoCreate.rules[0]).toMatchObject({
      branches: ['release/*'],
      defaultBranch: false,
      environments: ['staging'],
      tags: ['smoke'],
    });
    expect(autoCreate.rules[1]).toMatchObject({ defaultBranch: true, minOccurrences: 1, minRuns: 100, minDays: 0 });
  });

  test('an explicit empty rule list stays empty', () => {
    expect(resolveProjectIntegration({ autoCreate: { rules: [] } as never }).autoCreate.rules).toEqual([]);
  });

  test('the write-back scope and the note cadence normalize', () => {
    const { policies } = resolveProjectIntegration({
      policies: {
        scope: { branches: ['main', ' main '], defaultBranch: 'yes', environments: ['prod*'] },
        newOccurrencesEvery: 'month',
        newOccurrencesMin: 0,
      } as never,
    });
    expect(policies.scope).toEqual({ branches: ['main'], defaultBranch: false, environments: ['prod*'] });
    expect(policies.newOccurrencesEvery).toBe('day');
    expect(policies.newOccurrencesMin).toBe(1);
    expect(
      resolveProjectIntegration({ policies: { newOccurrencesEvery: 'week' } as never }).policies.newOccurrencesEvery,
    ).toBe('week');
  });

  test('include defaults to diagnosis + patch on, screenshot + share link off', () => {
    expect(resolveProjectIntegration({}).include).toEqual({
      includeDiagnosis: true,
      includePatch: true,
      includeScreenshot: false,
      includeShareLink: false,
    });
  });

  test('scalars are trimmed and connectionId must be a positive integer', () => {
    const r = resolveProjectIntegration({
      connectionId: 7,
      projectKey: '  PROJ  ',
      issueType: ' 10001 ',
      defaultAssignee: '  acct-1  ',
    });
    expect(r.connectionId).toBe(7);
    expect(r.projectKey).toBe('PROJ');
    expect(r.issueType).toBe('10001');
    expect(r.defaultAssignee).toBe('acct-1');
    expect(resolveProjectIntegration({ connectionId: 0 }).connectionId).toBeNull();
    expect(resolveProjectIntegration({ connectionId: -3 }).connectionId).toBeNull();
    expect(resolveProjectIntegration({ connectionId: 1.5 }).connectionId).toBeNull();
  });

  test('the issue types of the tag source stay null until a list names one, and normalize', () => {
    expect(resolveProjectIntegration({}).declaredIssueTypes).toBeNull();
    expect(resolveProjectIntegration({ declaredIssueTypes: 'Bug' as never }).declaredIssueTypes).toBeNull();
    expect(resolveProjectIntegration({ declaredIssueTypes: [] }).declaredIssueTypes).toBeNull();
    expect(resolveProjectIntegration({ declaredIssueTypes: [' ', '', 7 as never] }).declaredIssueTypes).toBeNull();
    expect(
      resolveProjectIntegration({ declaredIssueTypes: [' Bug ', '10004', 'Bug', '', 7 as never] }).declaredIssueTypes,
    ).toEqual(['Bug', '10004']);
  });

  test('labels are trimmed, de-duped and empties dropped', () => {
    expect(resolveProjectIntegration({ labels: [' a ', 'a', '', 'b'] as string[] }).labels).toEqual(['a', 'b']);
  });

  test('field defaults keep valid entries and drop Piwi-managed or empty ones', () => {
    const resolved = resolveProjectIntegration({
      fieldDefaults: {
        customfield_10050: { value: { id: '10100' }, label: 'Critical' },
        summary: { value: 'not settable here', label: 'x' },
        customfield_10060: { value: '', label: '' },
      },
    });
    expect(resolved.fieldDefaults).toEqual({ customfield_10050: { value: { id: '10100' }, label: 'Critical' } });
  });

  test("a transition's field values keep the assignee but never the comment", () => {
    const { policies } = resolveProjectIntegration({
      policies: {
        fixTransitionFields: {
          resolution: { value: { id: '1' }, label: 'Fixed' },
          assignee: { value: { accountId: 'acc-7' }, label: 'Ada' },
          comment: { value: 'no', label: 'no' },
        },
        reopenTransitionFields: 'not an object',
      } as never,
    });
    expect(Object.keys(policies.fixTransitionFields)).toEqual(['resolution', 'assignee']);
    expect(policies.reopenTransitionFields).toEqual({});
    expect(resolveProjectIntegration({}).policies.fixTransitionFields).toEqual({});
  });

  test('locale is narrowed to a supported language, else null (inherit)', () => {
    expect(resolveProjectIntegration({ locale: 'fr' }).locale).toBe('fr');
    expect(resolveProjectIntegration({ locale: 'de' as never }).locale).toBeNull();
    expect(resolveProjectIntegration({ locale: null }).locale).toBeNull();
  });

  test('numeric guards clamp to their ranges', () => {
    const r = resolveProjectIntegration({
      policies: { needsTicketAfterDays: 9999 } as never,
      autoCreate: { rules: [{ minOccurrences: 0 }], dailyCap: -5 } as never,
    });
    expect(r.policies.needsTicketAfterDays).toBe(365);
    expect(r.autoCreate.rules[0]!.minOccurrences).toBe(1);
    expect(r.autoCreate.dailyCap).toBe(0);
  });

  test('owner routes require an owner and normalize their fields', () => {
    const routes = resolveProjectIntegration({
      ownerRoutes: [
        { owner: '  @acme/checkout  ', projectKey: ' CHK ', labels: [' x ', 'x'] },
        { owner: '', projectKey: 'NOPE' },
        { projectKey: 'ALSO-NOPE' } as never,
      ],
    }).ownerRoutes;
    expect(routes).toHaveLength(1);
    expect(routes[0]).toEqual({
      owner: '@acme/checkout',
      projectKey: 'CHK',
      componentId: null,
      assigneeAccountId: null,
      labels: ['x'],
    });
  });

  test('transition ids round-trip when their policy is on', () => {
    const r = resolveProjectIntegration({
      policies: { transitionOnFix: true, fixTransitionId: '31', reopenTransitionId: '41' } as never,
    });
    expect(r.policies.transitionOnFix).toBe(true);
    expect(r.policies.fixTransitionId).toBe('31');
    expect(r.policies.reopenTransitionId).toBe('41');
  });
});

describe('resolveTagSource', () => {
  const pattern = { issue: '^[A-Z]+-[0-9]+$', testCase: null };

  test('links the binding’s issue type unless the list names others', () => {
    expect(resolveTagSource(pattern, { issueType: '10004', declaredIssueTypes: null })).toEqual({
      pattern: pattern.issue,
      issueTypes: ['10004'],
    });
    expect(resolveTagSource(pattern, { issueType: '10004', declaredIssueTypes: ['Story'] }).issueTypes).toEqual([
      'Story',
    ]);
    expect(resolveTagSource(pattern, { issueType: 'Bug', declaredIssueTypes: [] }).issueTypes).toEqual(['Bug']);
  });

  test('has no pattern for a missing or refused one and no issue type without a type to link', () => {
    expect(resolveTagSource(null, { issueType: '10004', declaredIssueTypes: null }).pattern).toBeNull();
    expect(
      resolveTagSource({ issue: 'no anchors', testCase: null }, { issueType: 'Bug', declaredIssueTypes: null }).pattern,
    ).toBeNull();
    expect(resolveTagSource(pattern, { issueType: null, declaredIssueTypes: null }).issueTypes).toEqual([]);
    expect(resolveTagSource(pattern, { issueType: null, declaredIssueTypes: [] }).issueTypes).toEqual([]);
  });
});

describe('pickOwnerRoute', () => {
  const routes: OwnerRoute[] = [
    { owner: '@acme/checkout', projectKey: 'CHK' },
    { owner: 'alice@example.com', projectKey: 'ALICE' },
  ];

  test('matches ignoring case and a leading @', () => {
    expect(pickOwnerRoute(routes, '@acme/checkout')?.projectKey).toBe('CHK');
    expect(pickOwnerRoute(routes, 'acme/checkout')?.projectKey).toBe('CHK');
    expect(pickOwnerRoute(routes, '@ACME/Checkout')?.projectKey).toBe('CHK');
    expect(pickOwnerRoute(routes, 'alice@example.com')?.projectKey).toBe('ALICE');
  });

  test('returns the first matching route in priority order', () => {
    const dup: OwnerRoute[] = [
      { owner: '@team', projectKey: 'FIRST' },
      { owner: '@team', projectKey: 'SECOND' },
    ];
    expect(pickOwnerRoute(dup, '@team')?.projectKey).toBe('FIRST');
  });

  test('null owner or no match yields null', () => {
    expect(pickOwnerRoute(routes, null)).toBeNull();
    expect(pickOwnerRoute(routes, '')).toBeNull();
    expect(pickOwnerRoute(routes, '@acme/payments')).toBeNull();
  });

  test('normalizeOwner strips @ and lower-cases', () => {
    expect(normalizeOwner('@Acme/Checkout')).toBe('acme/checkout');
  });
});
