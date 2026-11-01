import { describe, test, expect } from 'vitest';
import {
  gotoStep,
  renderScenarioDraft,
  detectControlNobodyExercises,
  detectReachableUnvisited,
  detectNotNoticed,
  detectOrphanTest,
  detectFixDidNotHold,
  detectPhantomCoverage,
  detectPassedWithErrors,
  detectCatalogMethodNoTestCalls,
  detectIncidentalCatch,
  detectAssertionLight,
  detectIntentWithoutTest,
  detectNewErrorPath,
  detectNewControl,
  detectLocatorBreakAhead,
} from '../../shared/handlers/scenario-gaps';
import * as gaps from '../../shared/handlers/scenario-gaps';

describe('detectControlNobodyExercises', () => {
  test('flags a control on pages that no test targets', () => {
    const gaps = detectControlNobodyExercises([
      { key: 'button:Export', pageCount: 12, reachCount: 0 },
      { key: 'button:Save', pageCount: 3, reachCount: 2 },
      { key: 'button:Orphan', pageCount: 0, reachCount: 0 },
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.key).toBe('control:button:Export');
    expect(gaps[0]!.class).toBe('blind-spot');
    expect(gaps[0]!.evidence[0]).toContain('12 pages');
  });

  test('a control covered by hand only does not switch the detector on for the project', () => {
    // One covered-by on a surface-drift gap wrote a manual reaches edge to button:Save; nothing else is observed.
    const controls = [
      { key: 'button:Export', pageCount: 12, reachCount: 0 },
      { key: 'button:Save', pageCount: 3, reachCount: 1, manualReachCount: 1 },
    ];
    expect(detectControlNobodyExercises(controls)).toEqual([]);
    controls.push({ key: 'button:Pay', pageCount: 2, reachCount: 1, manualReachCount: 0 });
    expect(detectControlNobodyExercises(controls).map((g) => g.key)).toEqual(['control:button:Export']);
  });
});

describe('detectReachableUnvisited', () => {
  test('flags a linked but unreached page', () => {
    const gaps = detectReachableUnvisited([
      { key: '/billing', reached: false, linkedFrom: 7 },
      { key: '/cart', reached: true, linkedFrom: 4 },
      { key: '/hidden', reached: false, linkedFrom: 0 },
    ]);
    expect(gaps.map((g) => g.key)).toEqual(['page:/billing']);
    expect(gaps[0]!.evidence[0]).toContain('7 pages');
  });
});

describe('detectNotNoticed', () => {
  test('flags a not-noticed probe on an exposed route', () => {
    const gaps = detectNotNoticed([
      {
        routeKey: 'POST /api/orders',
        noticed: false,
        notNoticed: [{ testCaseId: 1, title: 'checkout', fault: 'status-500' }],
        exposure: 3,
      },
      {
        routeKey: 'GET /api/a',
        noticed: true,
        notNoticed: [],
        exposure: 3,
      },
      {
        routeKey: 'GET /api/b',
        noticed: false,
        notNoticed: [{ testCaseId: 2, title: 'b', fault: 'empty-body' }],
        exposure: 0,
      },
    ]);
    expect(gaps.map((g) => g.key)).toEqual(['route:POST /api/orders']);
    expect(gaps[0]!.class).toBe('false-comfort');
    expect(gaps[0]!.evidence[0]).toContain('status-500');
  });

  test('two tests with opposite outcomes on one route: the route is checked, so no gap', () => {
    // A noticed and a not-noticed edge on the same route must not overwrite each
    // other nondeterministically — any noticed test means the route is checked.
    const gaps = detectNotNoticed([
      {
        routeKey: 'POST /api/orders',
        noticed: true,
        notNoticed: [{ testCaseId: 9, title: 'blind test', fault: 'status-500' }],
        exposure: 4,
      },
    ]);
    expect(gaps).toEqual([]);
  });

  test('a route no test noticed names the tests that did not', () => {
    const gaps = detectNotNoticed([
      {
        routeKey: 'POST /api/orders',
        noticed: false,
        notNoticed: [
          { testCaseId: 2, title: 'edits quantity', fault: 'status-500' },
          { testCaseId: 1, title: 'places order', fault: 'status-500' },
        ],
        exposure: 4,
      },
    ]);
    expect(gaps).toHaveLength(1);
    // Named deterministically by ascending test id, independent of input order.
    expect(gaps[0]!.evidence[0]).toContain('places order, edits quantity');
  });
});

describe('detectOrphanTest', () => {
  test('flags a test whose every node vanished', () => {
    const gaps = detectOrphanTest([
      { testCaseId: 1, title: 'old flow', reachedNodes: [{ seenRecently: false }, { seenRecently: false }] },
      { testCaseId: 2, title: 'live flow', reachedNodes: [{ seenRecently: true }, { seenRecently: false }] },
      { testCaseId: 3, title: 'no reach', reachedNodes: [] },
    ]);
    expect(gaps.map((g) => g.testCaseId)).toEqual([1]);
    expect(gaps[0]!.class).toBe('fragile');
  });
});

describe('detectFixDidNotHold', () => {
  test('reports a regressed cluster with its fix commit', () => {
    const gaps = detectFixDidNotHold([{ clusterId: 5, title: 'flaky pay', fixCommit: 'a1b2c3d4', daysSinceFix: 6 }]);
    expect(gaps[0]!.failureClusterId).toBe(5);
    expect(gaps[0]!.evidence[0]).toContain('a1b2c3d');
    expect(gaps[0]!.evidence[0]).toContain('6 days');
  });
});

describe('detectPhantomCoverage', () => {
  test('flags a long-skipped test only past the threshold', () => {
    const gaps = detectPhantomCoverage([
      { testCaseId: 1, title: 'skipped', reason: 'skipped', daysStale: 47 },
      { testCaseId: 2, title: 'recent', reason: 'skipped', daysStale: 5 },
    ]);
    expect(gaps.map((g) => g.testCaseId)).toEqual([1]);
    expect(gaps[0]!.evidence[0]).toContain('47 days');
  });
});

describe('detectPassedWithErrors', () => {
  test('reports each passing execution with an error', () => {
    const gaps = detectPassedWithErrors([
      { testCaseId: 1, title: 'checkout', detail: 'POST /api/audit returned 500 in background' },
    ]);
    expect(gaps[0]!.class).toBe('false-comfort');
    expect(gaps[0]!.evidence[0]).toContain('background');
  });
});

describe('detectCatalogMethodNoTestCalls', () => {
  test('flags an uncalled method on a reached page', () => {
    const gaps = detectCatalogMethodNoTestCalls([
      { module: './pages/CartPage', name: 'applyCoupon', callCount: 0, pageReachedBy: 4 },
      { module: './pages/CartPage', name: 'checkout', callCount: 2, pageReachedBy: 4 },
      { module: './pages/Dead', name: 'gone', callCount: 0, pageReachedBy: 0 },
    ]);
    expect(gaps.map((g) => g.key)).toEqual(['catalog:./pages/CartPage#applyCoupon']);
  });
});

describe('detectIncidentalCatch', () => {
  test('flags a cause not owned by any affected test', () => {
    const gaps = detectIncidentalCatch([
      {
        clusterId: 1,
        causeFile: 'pricing/rounding.ts',
        catcherTitle: 'checkout › happy path',
        causeInAffectedIdentity: false,
      },
      { clusterId: 2, causeFile: 'cart/coupon.ts', catcherTitle: 'cart › coupon', causeInAffectedIdentity: true },
    ]);
    expect(gaps.map((g) => g.failureClusterId)).toEqual([1]);
    expect(gaps[0]!.files).toEqual(['pricing/rounding.ts']);
  });
});

describe('detectAssertionLight', () => {
  test('flags a page reached but never data-asserted', () => {
    const gaps = detectAssertionLight([
      { pageKey: '/orders', testCount: 3, dataAssertions: 0 },
      { pageKey: '/cart', testCount: 3, dataAssertions: 2 },
      { pageKey: '/empty', testCount: 0, dataAssertions: 0 },
    ]);
    expect(gaps.map((g) => g.key)).toEqual(['page:/orders']);
  });
});

describe('detectIntentWithoutTest', () => {
  test('flags an intent no test matches', () => {
    const gaps = detectIntentWithoutTest([
      { title: 'fix: negative quantity', ticket: 'PROJ-9', matchedByTest: false },
      { title: 'add coupon field', ticket: null, matchedByTest: true },
    ]);
    expect(gaps.map((g) => g.ticket)).toEqual(['PROJ-9']);
    expect(gaps[0]!.class).toBe('blind-spot');
  });
});

describe('detectNewErrorPath', () => {
  test('reports an added status on a routed handler', () => {
    const gaps = detectNewErrorPath([
      { routeKey: 'POST /api/orders', addedStatus: 409, filePath: 'server/api/orders.post.ts' },
    ]);
    expect(gaps[0]!.key).toBe('route:POST /api/orders:409');
    expect(gaps[0]!.evidence[0]).toContain('409');
  });
});

describe('detectNewControl', () => {
  test('flags a new control only on a reached page', () => {
    const gaps = detectNewControl([
      { pageKey: '/checkout', control: 'input[name=promo]', filePath: 'Checkout.vue', pageReached: true },
      { pageKey: '/unseen', control: 'button', filePath: 'Unseen.vue', pageReached: false },
    ]);
    expect(gaps.map((g) => g.key)).toEqual(['control:/checkout:input[name=promo]']);
  });
});

describe('detectLocatorBreakAhead', () => {
  test('returns one prediction per broken anchor, not a gap, with the call sites of its chains', () => {
    const use = (test: number, site: string) => ({
      test,
      actions: ['click'],
      callSites: [site],
      projects: [],
      branches: ['main'],
    });
    const index = {
      projectId: 1,
      projectName: 'p',
      branch: 'main',
      defaultBranch: 'main',
      branches: [],
      builtAt: null,
      generatedAt: '2026-01-01T00:00:00Z',
      testIdAttributes: null,
      tests: [
        { id: 1, title: 'a', file: 'a.spec.ts', suite: [], status: 'passed' as const },
        { id: 2, title: 'b', file: 'b.spec.ts', suite: [], status: 'passed' as const },
      ],
      locators: [
        {
          locator: "getByTestId('submit-order')",
          lastSeenAt: '',
          uses: [use(0, 'a.spec.ts:1:1'), use(1, 'b.spec.ts:2:1')],
        },
        { locator: "getByTestId('other')", lastSeenAt: '', uses: [use(0, 'a.spec.ts:3:1')] },
      ],
      truncated: false,
    };
    const preds = detectLocatorBreakAhead(
      [
        {
          file: 'Checkout.vue',
          line: 3,
          oldLine: 3,
          kind: 'attribute',
          attribute: 'data-testid',
          before: 'submit-order',
        },
        { file: 'X.vue', line: 1, oldLine: 1, kind: 'attribute', attribute: 'data-testid', before: 'unused' },
      ],
      index,
    );
    expect(preds).toHaveLength(1);
    expect(preds[0]!.detector).toBe('locator-break-ahead');
    expect(preds[0]!.removedAttr).toBe('data-testid=submit-order');
    expect(preds[0]!.evidence).toContain('2 call sites');
  });
});

describe('renderScenarioDraft', () => {
  test('renders a skeleton with annotations, path, catalog and a TODO', () => {
    const draft = renderScenarioDraft({
      gapTitle: 'Tests pass when POST /api/orders breaks',
      gapClass: 'false-comfort',
      subject: { kind: 'route', key: 'POST /api/orders' },
      nearestTest: {
        title: 'checkout › happy path',
        feature: 'Checkout',
        priority: 'high',
        location: 'checkout.spec.ts',
      },
      path: ["await page.goto('/checkout');"],
      catalogMethods: [{ module: './pages/CartPage', name: 'placeOrder', receiver: 'cartPage' }],
      evidence: ['A probe (status-500) on POST /api/orders did not make any test fail.'],
    });
    expect(draft.text).toContain("import { test, expect } from '@playwright/test';");
    expect(draft.text).toContain('piwi:feature');
    expect(draft.text).toContain("await page.goto('/checkout');");
    expect(draft.text).toContain('cartPage.placeOrder()');
    expect(draft.text).toContain('TODO: assert the effect');
    expect(draft.annotations).toContainEqual({ type: 'piwi:feature', description: 'Checkout' });
  });

  test('opens a page by its key, and leaves a key with placeholders for a real address', () => {
    expect(gotoStep('/checkout')).toBe("await page.goto('/checkout');");
    expect(gotoStep('/shop/orders/:id')).toBe(
      "// TODO: a real :id in place of the key's: await page.goto('/shop/orders/:id');",
    );
    expect(gotoStep('/users/:uuid/orders/:id/items/:id')).toBe(
      "// TODO: a real :uuid and :id in place of the key's: await page.goto('/users/:uuid/orders/:id/items/:id');",
    );
    // A colon inside a word is the page's own.
    expect(gotoStep('/docs/a:b')).toBe("await page.goto('/docs/a:b');");
  });

  test('notes when there is no reachable path', () => {
    const draft = renderScenarioDraft({
      gapTitle: 'x',
      gapClass: 'blind-spot',
      subject: { kind: 'route', key: 'POST /api/x' },
      nearestTest: null,
      path: [],
      catalogMethods: [],
      evidence: [],
    });
    expect(draft.text).toContain('No reached path to this gap');
  });
});

describe('control reach from the locator index', () => {
  const nodes = {
    controls: new Set(['button:Save', 'textbox:Email', 'combobox:Role', 'textbox:Name', 'checkbox:Name']),
    links: new Set(['link:Users']),
  };

  test('a role and name maps to its control or link', () => {
    expect(gaps.locatorNodeTarget("getByRole('button', { name: 'Save' })")).toEqual({
      by: 'role',
      kind: 'control',
      key: 'button:Save',
      role: 'button',
      name: 'Save',
      exact: false,
    });
    expect(gaps.locatorNodeTarget("getByRole('navigation').getByRole('link', { name: 'Users' })")).toEqual({
      by: 'role',
      kind: 'link',
      key: 'link:Users',
      role: 'link',
      name: 'Users',
      exact: false,
    });
    expect(gaps.locatorNodeTarget("getByRole('button', { name: 'Save', exact: true })")).toMatchObject({
      exact: true,
    });
    expect(gaps.locatorNodeTarget("getByLabel('Email')")).toEqual({ by: 'name', name: 'Email', exact: false });
    expect(gaps.locatorNodeTarget("getByRole('button', { name: /Cart, \\d+ items?/ })")).toBeNull();
    expect(gaps.locatorNodeTarget("getByTestId('submit')")).toBeNull();
  });

  test('a use reaches a known node through its own chain, its snapshot, or a unique label', () => {
    const { reach, unresolved } = gaps.resolveControlReach(
      [
        { testCaseId: 1, target: "getByRole('button', { name: 'Save' })", action: 'click' },
        { testCaseId: 1, target: "getByRole('button', { name: 'Save' })", action: 'expect.toBeEnabled' },
        { testCaseId: 2, target: "getByRole('link', { name: 'Users' })", action: 'expect.toBeVisible' },
        {
          testCaseId: 3,
          target: "getByTestId('save')",
          action: 'click',
          alternatives: ["getByTestId('save')", "getByRole('button', { name: 'Save' })"],
        },
        { testCaseId: 4, target: "getByLabel('Email')", action: 'fill' },
        // Two labeled controls share the name, so the label names neither.
        { testCaseId: 5, target: "getByLabel('Name')", action: 'fill' },
        // A control the inventory never recorded reaches nothing.
        { testCaseId: 6, target: "getByRole('button', { name: 'Delete' })", action: 'click' },
        // An assertion on an unnamed element is not an interaction.
        { testCaseId: 7, target: "getByText('Saved')", action: 'expect.toBeVisible' },
      ],
      nodes,
    );
    expect(reach.sort((a, b) => a.testCaseId - b.testCaseId)).toEqual([
      { testCaseId: 1, kind: 'control', key: 'button:Save', action: 'operated', confidence: 1 },
      { testCaseId: 2, kind: 'link', key: 'link:Users', action: 'checked', confidence: 1 },
      { testCaseId: 3, kind: 'control', key: 'button:Save', action: 'operated', confidence: 0.9 },
      { testCaseId: 4, kind: 'control', key: 'textbox:Email', action: 'operated', confidence: 0.8 },
    ]);
    expect(unresolved.map((u) => u.testCaseId)).toEqual([5, 6]);
  });

  test('a name without exact matches as Playwright does: the one node of the role whose name holds it', () => {
    const named = {
      controls: new Set(['button:Save changes', 'button:Cancel', 'textbox:Work email', 'textbox:Email address']),
      links: new Set(['link:All users']),
    };
    const { reach, unresolved } = gaps.resolveControlReach(
      [
        { testCaseId: 1, target: "getByRole('button', { name: 'save' })", action: 'click' },
        { testCaseId: 2, target: "getByRole('button', { name: 'Save', exact: true })", action: 'click' },
        { testCaseId: 3, target: "getByRole('link', { name: 'users' })", action: 'click' },
        { testCaseId: 4, target: "getByLabel('Work')", action: 'fill' },
        // Both textboxes hold "email", so the label names neither.
        { testCaseId: 5, target: "getByLabel('email')", action: 'fill' },
      ],
      named,
    );
    expect(reach.sort((a, b) => a.testCaseId - b.testCaseId)).toEqual([
      { testCaseId: 1, kind: 'control', key: 'button:Save changes', action: 'operated', confidence: 0.8 },
      { testCaseId: 3, kind: 'link', key: 'link:All users', action: 'operated', confidence: 0.8 },
      { testCaseId: 4, kind: 'control', key: 'textbox:Work email', action: 'operated', confidence: 0.7 },
    ]);
    expect(unresolved.map((u) => u.testCaseId)).toEqual([2, 5]);
  });

  test('a control on a page where a test operated an unnamed element is not raised', () => {
    const raised = gaps.detectControlNobodyExercises([
      { key: 'button:Save', pageCount: 1, reachCount: 1 },
      { key: 'button:Delete', pageCount: 1, reachCount: 0, unresolvedTests: 1 },
      { key: 'button:Archive', pageCount: 1, reachCount: 0 },
    ]);
    expect(raised.map((g) => g.key)).toEqual(['control:button:Archive']);
  });
});

describe('feature grouping beyond reach', () => {
  const reach = (entries: Array<[string, number[]]>) => new Map(entries.map(([k, ids]) => [k, new Set(ids)]));
  const groups = gaps.groupFeatures({
    featureByTest: new Map([
      [1, 'Settings'],
      [2, 'Settings'],
      [3, 'Users'],
      [4, 'Reports'],
    ]),
    reachByNode: reach([
      ['route\x00GET /api/session', [1, 2, 3, 4]],
      ['route\x00GET /api/tokens', [1]],
      ['page\x00/settings/api', [1]],
      ['page\x00/settings/organization', [2]],
      ['page\x00/users', [3]],
      ['page\x00/reports', [4]],
      ['control\x00button:Rotate token', [1]],
    ]),
    controlsByPage: new Map([
      ['/settings/api', new Set(['button:Rotate token', 'button:Revoke', 'searchbox:Search'])],
      ['/users', new Set(['button:Invite', 'searchbox:Search'])],
      ['/reports', new Set(['searchbox:Search'])],
      ['/settings/security', new Set(['button:Enable 2FA'])],
    ]),
    linksByPage: new Map([['/settings/api', new Set(['/settings/security', '/billing'])]]),
    declaredRoutes: ['DELETE /api/tokens/:id', 'GET /api/audit-log'],
  });
  const of = (feature: string) =>
    groups
      .filter((g) => g.feature === feature)
      .map((g) => `${g.kind}:${g.key} ${g.via}${g.confidence == null ? '' : ` ${g.confidence}`}${g.hub ? ' hub' : ''}`);

  test('a feature groups what its pages contain and link to under its prefix, and the declared routes beside its own', () => {
    expect(of('Settings')).toEqual([
      'control:button:Enable 2FA contains 0.5',
      'control:button:Revoke contains 0.8',
      'control:button:Rotate token reach',
      'control:searchbox:Search contains 0.8 hub',
      'page:/settings/api reach',
      'page:/settings/organization reach',
      'page:/settings/security links 0.6',
      'route:DELETE /api/tokens/:id path 0.6',
      'route:GET /api/session reach hub',
      'route:GET /api/tokens reach',
    ]);
    expect(of('Users')).toEqual([
      'control:button:Invite contains 0.8',
      'control:searchbox:Search contains 0.8 hub',
      'page:/users reach',
      'route:GET /api/session reach hub',
    ]);
  });

  test('a page under another prefix and a declared route beside no feature stay ungrouped', () => {
    const keys = new Set(groups.map((g) => g.key));
    expect(keys.has('/billing')).toBe(false);
    expect(keys.has('GET /api/audit-log')).toBe(false);
  });

  test('two of three features sharing a node stay linked through it', () => {
    const three = gaps.groupFeatures({
      featureByTest: new Map([
        [1, 'Checkout'],
        [2, 'Cart'],
        [3, 'Catalog'],
        [4, 'Catalog'],
      ]),
      reachByNode: reach([
        ['route\x00POST /api/cart', [1, 2]],
        ['route\x00GET /api/products', [3, 4]],
      ]),
      controlsByPage: new Map(),
      linksByPage: new Map(),
      declaredRoutes: [],
    });
    expect(three.filter((g) => g.key === 'POST /api/cart').map((g) => g.hub)).toEqual([false, false]);
  });

  test('a route prefix skips api and version segments and drops the query', () => {
    expect(gaps.routePrefix('GET /api/users/:id')).toBe('/api/users');
    expect(gaps.routePrefix('GET /api/v1/orders/:id')).toBe('/api/v1/orders');
    expect(gaps.routePrefix('GET /api/orders?page=<redacted>')).toBe('/api/orders');
    expect(gaps.routePrefix('GET /health')).toBe('/health');
    expect(gaps.routePrefix('GET /api')).toBe('/api');
  });

  test('with fewer than three features no node is a hub', () => {
    const two = gaps.groupFeatures({
      featureByTest: new Map([
        [1, 'A'],
        [2, 'B'],
      ]),
      reachByNode: reach([['route\x00GET /api/session', [1, 2]]]),
      controlsByPage: new Map(),
      linksByPage: new Map(),
      declaredRoutes: [],
    });
    expect(two.every((g) => !g.hub)).toBe(true);
  });
});
