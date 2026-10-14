/**
 * The Test Map of the demo's web-dashboard project: the admin console of a SaaS
 * product, ten tests against a surface many times their size.
 *
 * One model drives every row the seed writes for it: each test's requests and
 * the pages it runs locators on, the inventory of the pages its passing runs visit, the
 * handler and dependencies behind each route, the declared OpenAPI surface and
 * the probe outcomes. The gaps listed at the end are what the live detectors
 * find in that graph; `demo-test-map.test.ts` recomputes them from the seed and
 * fails when the two disagree. Pure plain-JS module, read by the seed generator
 * and by that test.
 */

import DETECTED_GAPS from './demo-test-map-gaps.json' with { type: 'json' };
import { FAILURE_STORIES, SOURCE_FILES, lineOf } from './failure-stories.mjs';

export const WEB_DASHBOARD_PROJECT_ID = 5;
const WEB_DASHBOARD_ORIGIN = 'https://admin.example.com';

/**
 * The handler file and the dependencies its child spans name, per route. The
 * dashboard's origin serves its routes from the Nuxt app's Nitro server,
 * except `/api/users`, which it routes, with `/__piwi/`, to the dashboard's
 * ASP.NET Core API in `api/` (`backend: 'aspnetcore'`): that backend records
 * no server spans, so its route names its handler through its route manifest,
 * and no dependency.
 */
const ROUTES = {
  'POST /api/auth/sso/start': { handler: 'server/api/auth/sso/start.post.ts', calls: ['okta', 'redis'] },
  'GET /api/auth/sso/callback': {
    handler: 'server/api/auth/sso/callback.get.ts',
    calls: ['okta', 'postgres', 'redis'],
  },
  'GET /api/session': { handler: 'server/api/session.get.ts', calls: ['redis'], responses: [200, 401] },
  'GET /api/dashboard/summary': { handler: 'server/api/dashboard/summary.get.ts', calls: ['clickhouse'] },
  'GET /api/orgs/current': { handler: 'server/api/orgs/current.get.ts', calls: ['postgres'] },
  'PATCH /api/orgs/current': {
    handler: 'server/api/orgs/current.patch.ts',
    calls: ['postgres'],
    responses: [200, 403, 422],
  },
  'GET /api/users': { handler: 'api/Users/UsersEndpoints.cs', calls: [], backend: 'aspnetcore' },
  'GET /api/roles': { handler: 'server/api/roles/index.get.ts', calls: ['postgres'] },
  'POST /api/invitations': {
    handler: 'server/api/invitations/index.post.ts',
    calls: ['postgres', 'sendgrid'],
    responses: [201, 409, 422],
  },
  'GET /api/reports/revenue': { handler: 'server/api/reports/revenue.get.ts', calls: ['clickhouse'] },
  'POST /api/reports/exports': {
    handler: 'server/api/reports/exports/index.post.ts',
    calls: ['clickhouse', 's3'],
    responses: [202, 429],
  },
  'GET /api/reports/exports/:id': { handler: 'server/api/reports/exports/[id].get.ts', calls: ['s3'] },
  'GET /api/tokens': { handler: 'server/api/tokens/index.get.ts', calls: ['postgres'] },
  'POST /api/tokens/:id/rotate': {
    handler: 'server/api/tokens/[id]/rotate.post.ts',
    calls: ['postgres', 'vault'],
    responses: [200, 403, 404],
  },
  'GET /api/me/preferences': { handler: 'server/api/me/preferences.get.ts', calls: ['postgres'] },
  'PUT /api/me/preferences': { handler: 'server/api/me/preferences.put.ts', calls: ['postgres'] },
};

/**
 * The commits the default branch recorded on the handler files, which rank the
 * route and dependency gaps behind them by churn. `demo010` is the commit that
 * fixed failure cluster 10, so the users handler has let a defect escape.
 */
const RECORDED_CHANGES = [
  { commit: '3f9a1c4e7b2d8f60a5c1e9b3d7f2a4c8e6b0d1f3', files: ['server/api/invitations/index.post.ts'] },
  {
    commit: '8c2e5a7f1d4b9e30c6a2f8d1b5e7c3a9f0d4b6e2',
    files: ['server/api/invitations/index.post.ts', 'server/api/roles/index.get.ts'],
  },
  { commit: 'b71d4e9a3c6f2b85e0d7a1c4f9b3e6d2a8c5f1e7', files: ['server/api/invitations/index.post.ts'] },
  {
    commit: 'e4a8c2f6b0d3e7a1c5f9b2d6e0a4c8f3b7d1e5a9',
    files: ['server/api/reports/exports/index.post.ts', 'server/api/reports/exports/[id].get.ts'],
  },
  { commit: '5d0b7f3a9e2c6d14b8f0a3e7c1d5b9f2e6a0c4d8', files: ['server/api/reports/exports/index.post.ts'] },
  {
    commit: 'a2f6d0b4e8c1f5a93d7b0e4c8f2a6d1b5e9c3f7a',
    files: ['server/api/auth/sso/start.post.ts', 'server/api/auth/sso/callback.get.ts'],
  },
  { commit: 'demo010', files: ['api/Users/UsersEndpoints.cs'] },
];

/** Routes the project's OpenAPI document declares that no test requests, with their documented codes. */
const DECLARED_ROUTES = {
  'PATCH /api/users/:id': [200, 403, 404, 422],
  'DELETE /api/users/:id': [204, 403, 404],
  'DELETE /api/invitations/:id': [204, 404],
  'GET /api/audit-log': [200, 403],
  'GET /api/billing/invoices': [200, 402],
  'POST /api/billing/subscription': [200, 402, 409],
  'POST /api/integrations/slack': [201, 400, 409],
  'DELETE /api/tokens/:id': [204, 404],
  'POST /api/auth/password/reset': [202, 429],
  'DELETE /api/orgs/current': [202, 403, 409],
};

const SETTINGS_NAV = [
  ['Organization', '/settings/organization'],
  ['Security', '/settings/security'],
  ['API tokens', '/settings/api'],
  ['Appearance', '/settings/appearance'],
  ['Billing', '/billing'],
];

/**
 * The page inventory of every page a passing test visits: its controls (role and
 * accessible name), its links and the routes it loads while it settles.
 */
const PAGES = {
  '/login': {
    controls: [
      ['textbox', 'Work email'],
      ['button', 'Continue with SSO'],
      ['button', 'Sign in with a password'],
      ['checkbox', 'Keep me signed in'],
    ],
    links: [
      ['Forgot your password?', '/forgot-password'],
      ['Request access', '/request-access'],
    ],
    loads: [],
  },
  '/dashboard': {
    controls: [
      ['combobox', 'Date range'],
      ['button', 'Refresh'],
      ['button', 'Invite teammates'],
      ['searchbox', 'Search'],
    ],
    links: [
      ['Users', '/users'],
      ['Reports', '/reports/monthly'],
      ['Billing', '/billing'],
      ['Audit log', '/audit-log'],
      ['Integrations', '/integrations'],
      ['Settings', '/settings/organization'],
    ],
    loads: ['GET /api/session', 'GET /api/dashboard/summary', 'GET /api/orgs/current'],
  },
  '/users': {
    controls: [
      ['searchbox', 'Search users'],
      ['combobox', 'Role'],
      ['button', 'Invite user'],
      ['button', 'Next page'],
      ['button', 'Export users'],
      ['button', 'Deactivate'],
      // The invite dialog, open while the invite test runs.
      ['textbox', 'Email address'],
      ['button', 'Send invite'],
      ['button', 'Cancel'],
    ],
    links: [['Roles and permissions', '/roles']],
    loads: ['GET /api/session', 'GET /api/users', 'GET /api/roles'],
  },
  '/reports/monthly': {
    controls: [
      ['combobox', 'Range'],
      ['tab', 'Revenue'],
      ['tab', 'Churn'],
      ['tab', 'Cohorts'],
      ['button', 'Export CSV'],
      ['button', 'Schedule report'],
    ],
    links: [['Scheduled reports', '/reports/schedules']],
    loads: ['GET /api/session', 'GET /api/reports/revenue'],
  },
  '/settings/organization': {
    controls: [
      ['textbox', 'Organization name'],
      ['button', 'Save'],
      ['button', 'Transfer ownership'],
      ['button', 'Delete organization'],
    ],
    links: [...SETTINGS_NAV, ['Single sign-on', '/settings/sso']],
    loads: ['GET /api/session', 'GET /api/orgs/current'],
  },
  '/settings/api': {
    controls: [
      ['button', 'Create token'],
      ['combobox', 'Scope'],
      ['button', 'Rotate token'],
      // The rotation dialog's confirm button.
      ['button', 'Confirm'],
      ['button', 'Revoke'],
    ],
    links: [...SETTINGS_NAV, ['Single sign-on', '/settings/sso']],
    loads: ['GET /api/session', 'GET /api/tokens'],
  },
  '/settings/appearance': {
    controls: [
      ['switch', 'Dark mode'],
      ['radio', 'Compact'],
      ['radio', 'Comfortable'],
    ],
    links: SETTINGS_NAV,
    loads: ['GET /api/session', 'GET /api/me/preferences'],
  },
};

/**
 * Each test's journey: the pages it runs locators on in order, ending on the last,
 * and the requests it makes, as `[method, path, status, extra]`, where `extra.logs`
 * lists the backend log lines a response carries as `[level, category, message]`.
 * The seed writes the requests on every execution and the last page as where the
 * execution ended; the test reaches every page of its journey.
 */
const WEB_DASHBOARD_JOURNEYS = {
  'signs in with SSO redirect': {
    pages: ['/login', '/dashboard'],
    requests: [
      ['POST', '/api/auth/sso/start', 303],
      ['GET', '/api/auth/sso/callback', 302],
      ['GET', '/api/session', 200],
      ['GET', '/api/dashboard/summary', 200],
      ['GET', '/api/orgs/current', 200],
    ],
  },
  'shows an error for a revoked account': {
    pages: ['/login'],
    requests: [
      ['POST', '/api/auth/sso/start', 303],
      ['GET', '/api/auth/sso/callback', 403],
    ],
  },
  'Users table paginates 25 rows per page': {
    pages: ['/users'],
    requests: [
      ['GET', '/api/session', 200],
      // A query names no route of its own: both calls reach GET /api/users.
      ['GET', '/api/users?page=2', 200],
      ['GET', '/api/roles', 200],
    ],
  },
  'invites a user by email': {
    pages: ['/users'],
    requests: [
      ['GET', '/api/session', 200],
      ['GET', '/api/users', 200],
      ['GET', '/api/roles', 200],
      ['POST', '/api/invitations', 201],
    ],
  },
  'filters users by role': {
    pages: ['/users'],
    requests: [
      ['GET', '/api/session', 200],
      ['GET', '/api/users?role=admin', 200],
      ['GET', '/api/roles', 200],
    ],
  },
  'renders the revenue chart': {
    pages: ['/reports/monthly'],
    requests: [
      ['GET', '/api/session', 200],
      ['GET', '/api/reports/revenue', 200],
    ],
  },
  'exports the monthly report as CSV': {
    pages: ['/reports/monthly'],
    requests: [
      ['GET', '/api/session', 200],
      ['GET', '/api/reports/revenue', 200],
      ['POST', '/api/reports/exports', 202],
      ['GET', '/api/reports/exports/918', 200],
    ],
  },
  'updates the organization name': {
    pages: ['/settings/organization'],
    requests: [
      ['GET', '/api/session', 200],
      ['GET', '/api/orgs/current', 200],
      // The save succeeds, but the audit write behind it fails and the backend logs it.
      [
        'PATCH',
        '/api/orgs/current',
        200,
        { logs: [['error', 'audit', 'audit event write failed: connection reset by peer']] },
      ],
    ],
  },
  'rotates the API token': {
    pages: ['/settings/api'],
    requests: [
      ['GET', '/api/session', 200],
      ['GET', '/api/tokens', 200],
      ['POST', '/api/tokens/42/rotate', 200],
    ],
  },
  'toggles dark mode': {
    pages: ['/settings/organization', '/settings/appearance'],
    requests: [
      ['GET', '/api/session', 200],
      ['GET', '/api/orgs/current', 200],
      ['GET', '/api/me/preferences', 200],
      ['PUT', '/api/me/preferences', 200],
    ],
  },
};

/**
 * Each test's steps, as its spec file runs them: a navigation, then each locator
 * call with the page it runs on, as `[kind, locator or path, extra, truth]`. The
 * call site is the spec line that holds the locator, so the steps, the locator
 * index and the Test Map read the same calls. `truth` labels the control or link
 * (`kind:key`) a call truly targets, for the benchmark; a call on no control or
 * link has none. An `arrive` entry is a page a click navigated to: it moves the
 * steps after it there and reports no step of its own. A `check` entry is an
 * `expect` on a value no locator holds, found in the spec by its text.
 */
const STEPS = {
  'signs in with SSO redirect': [
    ['goto', '/login'],
    ['click', "getByRole('button', { name: 'Continue with SSO' })", null, 'control:button:Continue with SSO'],
  ],
  'shows an error for a revoked account': [
    ['goto', '/login', '/login?sso=revoked'],
    ['expect', "getByText('Your account has been deactivated')", 'toBeVisible'],
  ],
  'Users table paginates 25 rows per page': [
    ['goto', '/users'],
    ['expect', "getByRole('row')", 'toHaveCount'],
  ],
  'invites a user by email': [
    ['goto', '/users'],
    ['click', "getByRole('button', { name: 'Invite user' })", null, 'control:button:Invite user'],
    ['fill', "getByLabel('Email address')", 'new.admin@example.com', 'control:textbox:Email address'],
    ['click', "getByRole('button', { name: 'Send invite' })", null, 'control:button:Send invite'],
    ['expect', "getByText('Invite sent')", 'toBeVisible'],
  ],
  'filters users by role': [
    ['goto', '/users'],
    ['select', "getByRole('combobox', { name: 'Role' })", 'admin', 'control:combobox:Role'],
    ['expect', "getByRole('row', { name: /admin/i }).first()", 'toBeVisible'],
  ],
  'renders the revenue chart': [
    ['goto', '/reports/monthly'],
    ['expect', "getByRole('img', { name: 'Revenue chart' })", 'toBeVisible'],
  ],
  'exports the monthly report as CSV': [
    ['goto', '/reports/monthly'],
    ['expect', "getByRole('button', { name: 'Export CSV' })", 'toBeVisible', 'control:button:Export CSV'],
    ['click', "getByRole('button', { name: 'Export CSV' })", null, 'control:button:Export CSV'],
    // A value check on no locator: the index never sees it, so the page reads as visibility-only.
    ['check', 'suggestedFilename()', 'toBe'],
  ],
  'updates the organization name': [
    ['goto', '/settings/organization'],
    ['fill', "getByLabel('Organization name')", 'Acme Corp', 'control:textbox:Organization name'],
    ['click', "getByRole('button', { name: 'Save' })", null, 'control:button:Save'],
    ['expect', "getByText('Settings saved')", 'toBeVisible'],
  ],
  'rotates the API token': [
    ['goto', '/settings/api'],
    ['click', "getByRole('button', { name: 'Rotate token' })", null, 'control:button:Rotate token'],
    // A test id the locator index cannot name: it confirms the rotation dialog.
    ['click', "getByTestId('confirm-rotate')", null, 'control:button:Confirm'],
    ['expect', "getByText('New token generated')", 'toBeVisible'],
  ],
  'toggles dark mode': [
    ['goto', '/settings/organization'],
    ['click', "getByRole('link', { name: 'Appearance' })", null, 'link:link:Appearance'],
    ['arrive', '/settings/appearance'],
    ['click', "getByRole('switch', { name: 'Dark mode' })", null, 'control:switch:Dark mode'],
    ['expect', "locator('html')", 'toHaveAttribute'],
  ],
};

/**
 * The project's function catalog: page-object methods and a helper, with the
 * steps each drives and the tests that truly call it, for the benchmark. A step
 * whose target comes from a parameter (`paramSources` with `text`) names no
 * element. `Users table paginates` checks the row count and never pages, and
 * the settings helper is never called but names its link by parameter, so the
 * map cannot tell.
 */
const CATALOG = [
  {
    receiver: 'usersPage',
    name: 'filterByRole',
    module: './pages/UsersPage',
    urlPattern: '**/users',
    params: [{ name: 'role', type: 'string' }],
    steps: [{ action: 'selectOption', target: { role: 'combobox', name: 'Role' } }],
    paramSources: [{ param: 'role', stepIndex: 0, from: 'value' }],
    calledBy: ['filters users by role'],
  },
  {
    receiver: 'usersPage',
    name: 'inviteUser',
    module: './pages/UsersPage',
    urlPattern: '**/users',
    params: [{ name: 'email', type: 'string' }],
    steps: [
      { action: 'click', target: { role: 'button', name: 'Invite user' } },
      { action: 'fill', target: { role: 'textbox', name: 'Email address' } },
      { action: 'click', target: { role: 'button', name: 'Send invite' } },
    ],
    paramSources: [{ param: 'email', stepIndex: 1, from: 'value' }],
    calledBy: ['invites a user by email'],
  },
  {
    receiver: 'usersPage',
    name: 'goToNextPage',
    module: './pages/UsersPage',
    urlPattern: '**/users',
    params: [],
    steps: [{ action: 'click', target: { role: 'button', name: 'Next page' } }],
    paramSources: [],
    calledBy: [],
  },
  {
    receiver: 'usersPage',
    name: 'deactivateUser',
    module: './pages/UsersPage',
    urlPattern: '**/users',
    params: [{ name: 'email', type: 'string' }],
    steps: [
      { action: 'fill', target: { role: 'searchbox', name: 'Search users' } },
      { action: 'click', target: { role: 'button', name: 'Deactivate' } },
    ],
    paramSources: [{ param: 'email', stepIndex: 0, from: 'value' }],
    calledBy: [],
  },
  {
    receiver: 'reportsPage',
    name: 'exportCsv',
    module: './pages/ReportsPage',
    urlPattern: '**/reports/*',
    params: [],
    steps: [{ action: 'click', target: { role: 'button', name: 'Export CSV' } }],
    paramSources: [],
    calledBy: ['exports the monthly report as CSV'],
  },
  {
    receiver: 'apiTokensPage',
    name: 'rotateToken',
    module: './pages/ApiTokensPage',
    urlPattern: '**/settings/api',
    params: [],
    steps: [
      { action: 'click', target: { role: 'button', name: 'Rotate token' } },
      { action: 'click', target: { testId: 'confirm-rotate' } },
    ],
    paramSources: [],
    calledBy: ['rotates the API token'],
  },
  {
    receiver: 'apiTokensPage',
    name: 'revokeToken',
    module: './pages/ApiTokensPage',
    urlPattern: '**/settings/api',
    params: [],
    steps: [
      { action: 'click', target: { role: 'button', name: 'Revoke' } },
      { action: 'click', target: { role: 'button', name: 'Confirm' } },
    ],
    paramSources: [],
    calledBy: [],
  },
  {
    receiver: null,
    name: 'openSettingsSection',
    module: './helpers/navigation',
    kind: 'helper',
    urlPattern: '**/settings/**',
    params: [{ name: 'section', type: 'string' }],
    steps: [{ action: 'click', target: { role: 'link', name: 'Appearance' } }],
    paramSources: [{ param: 'section', stepIndex: 0, from: 'text' }],
    calledBy: [],
  },
];

/** The spec file each test lives in. */
const SPEC_FILE = {
  'signs in with SSO redirect': 'tests/admin/login.spec.ts',
  'shows an error for a revoked account': 'tests/admin/login.spec.ts',
  'Users table paginates 25 rows per page': 'tests/admin/users.spec.ts',
  'invites a user by email': 'tests/admin/users.spec.ts',
  'filters users by role': 'tests/admin/users.spec.ts',
  'renders the revenue chart': 'tests/admin/reports.spec.ts',
  'exports the monthly report as CSV': 'tests/admin/reports.spec.ts',
  'updates the organization name': 'tests/admin/settings.spec.ts',
  'rotates the API token': 'tests/admin/settings.spec.ts',
  'toggles dark mode': 'tests/admin/settings.spec.ts',
};

/** `file:line` → column of the calls the failure stories' errors name, which keep their column. */
const STORY_COLUMNS = new Map(
  FAILURE_STORIES.flatMap((story) =>
    story.failingCases.map((c) => [`${c.frames.at(-1).file}:${c.failingLine}`, c.column]),
  ),
);

/**
 * `file:line:col` of the `nth` occurrence of `needle` at or after the test's own
 * declaration: the column a failure story's error gives that line, else the
 * needle's.
 */
function callSite(file, title, needle, nth) {
  const lines = SOURCE_FILES[file];
  const decl = lineOf(lines, `test('${title}'`);
  let seen = 0;
  for (let i = decl - 1; i < lines.length; i++) {
    const col = lines[i].indexOf(needle);
    if (col < 0) continue;
    if (seen === nth) return `${file}:${i + 1}:${STORY_COLUMNS.get(`${file}:${i + 1}`) ?? col + 1}`;
    seen++;
  }
  throw new Error(`web-dashboard Test Map: ${needle} is not in ${title}`);
}

/**
 * A test's steps in the seed's step-template form: the navigation, then each
 * locator call with its call site, the page it runs on and whether it ran on
 * arrival there. Null for a test outside the model.
 */
export function webDashboardStepTitles(title) {
  const steps = STEPS[title];
  if (!steps) return null;
  const file = SPEC_FILE[title];
  let page = null;
  let arrival = true;
  const seen = new Map();
  return steps.flatMap(([kind, target, extra]) => {
    if (kind === 'arrive') {
      page = target;
      arrival = true;
      return [];
    }
    if (kind === 'goto') {
      page = target;
      arrival = true;
      return {
        title: 'Navigate',
        subtitle: extra ?? target,
        category: 'navigation',
        weight: 900,
        params: { url: `${WEB_DASHBOARD_ORIGIN}${extra ?? target}` },
      };
    }
    const nth = seen.get(target) ?? 0;
    seen.set(target, nth + 1);
    if (kind === 'check') {
      return {
        title: `Expect "${extra}"`,
        category: 'assertion',
        weight: 500,
        location: callSite(file, title, target, nth),
        page,
        arrival,
      };
    }
    const step = {
      title:
        kind === 'click'
          ? 'Click'
          : kind === 'fill'
            ? `Fill "${extra}"`
            : kind === 'select'
              ? `Select option "${extra}"`
              : `Expect "${extra}"`,
      subtitle: target,
      category: kind === 'expect' ? 'assertion' : kind === 'fill' ? 'input' : 'action',
      weight: kind === 'expect' ? 500 : 700,
      params: kind === 'fill' ? { locator: target, value: extra } : { locator: target },
      location: callSite(file, title, target, nth),
      page,
      arrival,
    };
    if (kind !== 'expect') arrival = false;
    return step;
  });
}

/**
 * Probe outcomes. Client probes rewrite a route's response in the browser; server
 * probes fail one dependency call inside the server. A server probe the
 * application degraded under, or did not handle, also leaves a resilience finding.
 */
const CLIENT_PROBES = [
  { test: 'signs in with SSO redirect', route: 'GET /api/session', fault: 'status-500', outcome: 'noticed' },
  { test: 'filters users by role', route: 'GET /api/users', fault: 'empty-body', outcome: 'noticed' },
  { test: 'invites a user by email', route: 'POST /api/invitations', fault: 'status-500', outcome: 'not-noticed' },
  { test: 'renders the revenue chart', route: 'GET /api/reports/revenue', fault: 'empty-body', outcome: 'not-noticed' },
  {
    test: 'exports the monthly report as CSV',
    route: 'POST /api/reports/exports',
    fault: 'status-500',
    outcome: 'noticed',
  },
  {
    test: 'updates the organization name',
    route: 'PATCH /api/orgs/current',
    fault: 'stale-value',
    outcome: 'not-noticed',
  },
  { test: 'rotates the API token', route: 'POST /api/tokens/:id/rotate', fault: 'drop-field', outcome: 'noticed' },
  { test: 'toggles dark mode', route: 'PUT /api/me/preferences', fault: 'slow', outcome: 'inconclusive' },
];
const SERVER_PROBES = [
  {
    test: 'exports the monthly report as CSV',
    route: 'POST /api/reports/exports',
    dependency: 's3',
    outcome: 'noticed',
    handled: 'graceful',
  },
  {
    test: 'invites a user by email',
    route: 'POST /api/invitations',
    dependency: 'sendgrid',
    outcome: 'not-noticed',
    handled: 'degraded',
  },
  {
    test: 'renders the revenue chart',
    route: 'GET /api/reports/revenue',
    dependency: 'clickhouse',
    outcome: 'noticed',
    handled: 'unhandled',
  },
  {
    test: 'updates the organization name',
    route: 'PATCH /api/orgs/current',
    dependency: 'postgres',
    outcome: 'noticed',
    handled: 'graceful',
  },
];

const DAY_MS = 86_400_000;

/**
 * The team's verdicts on the detected gaps, by detector and key: the gap accepted
 * more than a week ago whose test was never written, a snoozed dependency and a
 * page dismissed as not worth testing.
 */
const TRIAGE = {
  'success-only POST /api/invitations': { status: 'accepted', acceptedDaysAgo: 9 },
  'unprobed-dependency dependency:vault': { status: 'snoozed', snoozedForDays: 5 },
  'reachable-unvisited page:/request-access': { status: 'dismissed', reason: 'not-worth-testing' },
};

const FLOOR_FACTORS = { churn: 0.1, age: 0.1, escapeHistory: 0.1, priority: 0.1 };

/**
 * Gaps the ledger has closed, which the detectors do not raise: the callback
 * route a revoked-account test made answer 403.
 */
const CLOSED = [
  {
    detector: 'success-only',
    class: 'blind-spot',
    key: 'GET /api/auth/sso/callback',
    title: 'GET /api/auth/sso/callback: no error path under test',
    evidence: ['Observed 12 times over the last 30 runs, always 302 — observed reach, no error path exercised.'],
    factors: { ...FLOOR_FACTORS, priority: 0.4 },
    score: 0.0849,
    test: null,
    closedDaysAgo: 20,
  },
];

/**
 * The resilience findings the server probes left: the invite form degraded
 * without sendgrid and no test noticed; the revenue page threw without
 * clickhouse.
 */
const FINDINGS = [
  {
    detector: 'not-handled',
    class: 'degraded',
    key: 'dependency:sendgrid @ POST /api/invitations',
    title: 'sendgrid (via POST /api/invitations): degraded failure',
    evidence: [
      'A server probe made sendgrid (via POST /api/invitations) fail; the application degraded under it (invites a user by email) — an error-state scenario is missing.',
    ],
    factors: FLOOR_FACTORS,
    score: 0.05,
    test: 'invites a user by email',
  },
  {
    detector: 'not-handled',
    class: 'unhandled',
    key: 'dependency:clickhouse @ GET /api/reports/revenue',
    title: 'clickhouse (via GET /api/reports/revenue): unhandled failure',
    evidence: [
      'A server probe made clickhouse (via GET /api/reports/revenue) fail; the application did not handle it (renders the revenue chart) — an error-state scenario is missing.',
    ],
    factors: { ...FLOOR_FACTORS, priority: 0.2 },
    score: 0.2,
    test: 'renders the revenue chart',
  },
];

/** `/settings` of `/settings/api`: the first path segment. */
const pagePrefix = (page) => `/${page.split('/').filter(Boolean)[0] ?? ''}`;

/** `/api/users` of `GET /api/users/:id`: the path to its first resource segment, past `api` and a version. */
function routePrefix(route) {
  const segments = route
    .slice(route.indexOf(' ') + 1)
    .split('?')[0]
    .split('/')
    .filter(Boolean);
  let i = 0;
  while (i < segments.length - 1 && /^(api|v\d+)$/i.test(segments[i])) i++;
  return `/${segments.slice(0, i + 1).join('/')}`;
}

/**
 * The feature groups of the web-dashboard graph, by the recompute's rules: what
 * each feature's tests reach; then, for what no feature reaches, the controls
 * its pages contain (0.8), the pages they link to under the same first segment
 * (0.6) and those pages' controls (0.5), and the declared routes under the same
 * resource path as a route it reaches (0.6). With three features or more, hubs
 * are marked: reached by more than half the tests, or grouped by more than half
 * the features and by three at least.
 */
function webDashboardFeatureGroups(reachedBy, features) {
  const groups = new Map();
  const add = (feature, kind, key, via, confidence) => {
    const id = `${feature}\x00${kind}\x00${key}`;
    const prev = groups.get(id);
    if (prev && (prev.confidence == null || (confidence != null && prev.confidence >= confidence))) return;
    groups.set(id, { feature, kind, key, via, confidence, hub: false });
  };
  const testsReaching = new Set();
  for (const [id, titles] of reachedBy) {
    const [kind, key] = id.split('\x00');
    if (kind !== 'route' && kind !== 'page' && kind !== 'control') continue;
    for (const title of titles) {
      testsReaching.add(title);
      const feature = features.get(title);
      if (feature) add(feature, kind, key, 'reach', null);
    }
  }
  const featureSet = new Set([...groups.values()].map((g) => g.feature));
  const hubsApply = featureSet.size >= 3;
  const sharedByMost = (count) => hubsApply && count >= 3 && count > featureSet.size / 2;
  const reachGrouped = new Set([...groups.values()].map((g) => `${g.kind}\x00${g.key}`));
  const featuresOf = (all) => {
    const out = new Map();
    for (const g of all) {
      const id = `${g.kind}\x00${g.key}`;
      out.set(id, new Set([...(out.get(id) ?? []), g.feature]));
    }
    return out;
  };
  const reachedHub = (kind, key) =>
    hubsApply && (reachedBy.get(`${kind}\x00${key}`)?.size ?? 0) > testsReaching.size / 2;
  const byReach = featuresOf(groups.values());
  const reachHub = (kind, key) => reachedHub(kind, key) || sharedByMost(byReach.get(`${kind}\x00${key}`)?.size ?? 0);
  const controlsOf = (page) => (PAGES[page]?.controls ?? []).map(([role, name]) => controlKey(role, name));
  const linksOf = (page) => (PAGES[page]?.links ?? []).map(([, target]) => target);

  for (const feature of featureSet) {
    const own = [...groups.values()].filter(
      (g) => g.feature === feature && g.via === 'reach' && !reachHub(g.kind, g.key),
    );
    const linked = [];
    for (const page of own.filter((g) => g.kind === 'page').map((g) => g.key)) {
      for (const control of controlsOf(page)) {
        if (!reachGrouped.has(`control\x00${control}`)) add(feature, 'control', control, 'contains', 0.8);
      }
      for (const target of linksOf(page)) {
        if (target === page || pagePrefix(target) !== pagePrefix(page) || reachGrouped.has(`page\x00${target}`))
          continue;
        add(feature, 'page', target, 'links', 0.6);
        linked.push(target);
      }
    }
    for (const page of linked) {
      for (const control of controlsOf(page)) {
        if (!reachGrouped.has(`control\x00${control}`)) add(feature, 'control', control, 'contains', 0.5);
      }
    }
    const prefixes = new Set(own.filter((g) => g.kind === 'route').map((g) => routePrefix(g.key)));
    for (const route of Object.keys(DECLARED_ROUTES)) {
      if (!reachGrouped.has(`route\x00${route}`) && prefixes.has(routePrefix(route)))
        add(feature, 'route', route, 'path', 0.6);
    }
  }
  const all = featuresOf(groups.values());
  for (const g of groups.values()) {
    g.hub = reachedHub(g.kind, g.key) || sharedByMost(all.get(`${g.kind}\x00${g.key}`)?.size ?? 0);
  }
  return [...groups.values()];
}

/** The nodes the latest run saw first. */
const NEW_IN_LATEST = new Set(['page\x00/settings/sso', 'link\x00link:Single sign-on']);

/**
 * Tests the seed makes flaky (`FLAKY_CASES` in the seed generator), so their
 * reach is not trusted; the demo test checks it against the seeded tests.
 */
export const WEB_DASHBOARD_UNTRUSTED_TESTS = ['toggles dark mode'];
const UNTRUSTED_TESTS = new Set(WEB_DASHBOARD_UNTRUSTED_TESTS);

/**
 * The benchmark's ground truth for the web-dashboard project: the gaps each
 * detector should raise, keyed as the detector keys them, from what each test
 * truly exercises (its requests, its pages and the control or link each step is
 * labeled with, never what the locator index resolves) and the surface the
 * application has. It parts from what the capture records where a capture cannot
 * see, so a detector reads below one where the capture misleads it. Each
 * definition is the detector's own, applied to the truth, without the thresholds
 * a detector adds to stay quiet on thin evidence.
 */
export function expectedWebDashboardGaps() {
  const controls = new Set();
  const links = new Set();
  const linkedPages = new Set();
  for (const [page, spec] of Object.entries(PAGES)) {
    for (const [role, name] of spec.controls) controls.add(controlKey(role, name));
    for (const [name, target] of spec.links) {
      links.add(`link:${name}`);
      if (target !== page) linkedPages.add(target);
    }
  }
  const exercisedBy = new Map(); // kind\0key → { trusted, untrusted } test titles
  const exercise = (title, kind, key) => {
    const id = `${kind}\x00${key}`;
    const entry = exercisedBy.get(id) ?? { trusted: new Set(), untrusted: new Set() };
    entry[UNTRUSTED_TESTS.has(title) ? 'untrusted' : 'trusted'].add(title);
    exercisedBy.set(id, entry);
  };
  const statuses = new Map(); // route → statuses under test
  for (const [title, journey] of Object.entries(WEB_DASHBOARD_JOURNEYS)) {
    for (const request of journey.requests) {
      const route = routeKeyOf(request);
      exercise(title, 'route', route);
      statuses.set(route, [...(statuses.get(route) ?? []), request[2]]);
    }
    for (const page of journey.pages) exercise(title, 'page', page);
    for (const [, , , truth] of STEPS[title] ?? []) {
      if (!truth) continue;
      const sep = truth.indexOf(':');
      exercise(title, truth.slice(0, sep), truth.slice(sep + 1));
    }
  }
  const exercised = (kind, key) => exercisedBy.has(`${kind}\x00${key}`);

  const probedDependencies = new Set(SERVER_PROBES.map((p) => p.dependency));
  const notNoticed = new Set();
  const noticed = new Set(); // routes a trusted test noticed a probe on
  for (const p of CLIENT_PROBES) {
    if (p.outcome === 'not-noticed') notNoticed.add(p.route);
    if (p.outcome === 'noticed' && !UNTRUSTED_TESTS.has(p.test)) noticed.add(p.route);
  }
  const dependencies = new Set(Object.values(ROUTES).flatMap((spec) => spec.calls));

  const single = [];
  for (const [id, { trusted, untrusted }] of exercisedBy) {
    if (trusted.size === 1 || (trusted.size === 0 && untrusted.size > 0)) single.push(id.replace('\x00', ':'));
  }
  return {
    'success-only': [...statuses].filter(([, codes]) => codes.every((c) => c < 400)).map(([route]) => route),
    'declared-never-hit': Object.keys(DECLARED_ROUTES)
      .filter((route) => !exercised('route', route))
      .map((route) => `route:${route}`),
    'surface-drift': [...NEW_IN_LATEST].filter((id) => !exercisedBy.has(id)).map((id) => id.replace('\x00', ':')),
    'control-nobody-exercises': [...controls]
      .filter((key) => !exercised('control', key))
      .map((key) => `control:${key}`),
    'reachable-unvisited': [...linkedPages].filter((page) => !exercised('page', page)).map((page) => `page:${page}`),
    'single-covering-test': single,
    'not-noticed': [...notNoticed].filter((route) => !noticed.has(route)).map((route) => `route:${route}`),
    'unprobed-dependency': [...dependencies]
      .filter((dep) => !probedDependencies.has(dep))
      .map((dep) => `dependency:${dep}`),
    'assertion-light': assertionLightTruth(),
    'catalog-method-no-test-calls': CATALOG.filter(
      (f) =>
        f.calledBy.length === 0 &&
        Object.values(WEB_DASHBOARD_JOURNEYS).some((j) => j.pages.some((page) => globMatches(f.urlPattern, page))),
    ).map((f) => `catalog:${f.module}#${f.name}`),
    'passed-with-errors': [...APP_ERRORS_WHILE_PASSING].map((title) => `test:${title}`),
  };
}

/** Matchers that check an element is there, not what it shows. */
const PRESENCE_MATCHERS = new Set(['toBeVisible', 'toBeHidden', 'toBeAttached', 'toBeInViewport']);

/** The pages some test asserts on, every one of its checks there only that an element is present. */
function assertionLightTruth() {
  const presence = new Set();
  const value = new Set();
  for (const steps of Object.values(STEPS)) {
    let page = null;
    for (const [kind, target, extra] of steps) {
      if (kind === 'goto' || kind === 'arrive') page = target;
      else if (kind === 'check' || (kind === 'expect' && !PRESENCE_MATCHERS.has(extra))) value.add(page);
      else if (kind === 'expect') presence.add(page);
    }
  }
  return [...presence].filter((page) => !value.has(page)).map((page) => `page:${page}`);
}

/** A catalog URL pattern against a page path, `**` across segments and `*` within one. */
function globMatches(pattern, path) {
  const escaped = pattern
    .split('**')
    .map((part) => part.replace(/[.?+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(`http://piwi.invalid${path}`);
}

/** A path without its query and with numeric ids collapsed, as a route node's key holds it. */
function routePattern(path) {
  return path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id');
}

/** The path as the network table stores it normalized: the pattern, then the query's names with their values redacted. */
function normalizedPath(path) {
  const query = path.split('?')[1];
  if (!query) return routePattern(path);
  const names = [...new Set(query.split('&').map((pair) => pair.split('=')[0]))];
  return `${routePattern(path)}?${names.map((name) => `${name}=%3Credacted%3E`).join('&')}`;
}

function routeKeyOf([method, path]) {
  return `${method} ${routePattern(path)}`;
}

/** A control node's key, `role:name`. The model's names hold no digits, dates or ids, so templating leaves them as they are. */
function controlKey(role, name) {
  return `${role}:${name}`;
}

/** Roles a label, a placeholder or a title names. */
const LABELED_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'spinbutton',
  'slider',
]);

/**
 * The control or link a step's locator names, as the recompute resolves it from
 * the locator index: a role and name directly, a label through the one labeled
 * control carrying that name. Null for a text, a regex name or a CSS selector.
 */
function locatorNode(target, controls, links) {
  const role = /^getByRole\('(\w+)', \{ name: '([^']+)' \}\)$/.exec(target);
  if (role) {
    const [kind, key] = role[1] === 'link' ? ['link', `link:${role[2]}`] : ['control', controlKey(role[1], role[2])];
    return (kind === 'link' ? links : controls).has(key) ? { kind, key, confidence: 1 } : null;
  }
  const label = /^getByLabel\('([^']+)'\)$/.exec(target);
  if (!label) return null;
  const named = [...controls].filter((key) => {
    const sep = key.indexOf(':');
    return LABELED_ROLES.has(key.slice(0, sep)) && key.slice(sep + 1) === label[1];
  });
  return named.length === 1 ? { kind: 'control', key: named[0], confidence: 0.8 } : null;
}

/**
 * Every Test Map row the seed writes for the project, given the ids it assigned:
 * `caseIds` maps a test title to its test case id, `runIds` lists the project's
 * runs oldest first, and `features` maps a test title to its `piwi:feature` tag.
 * The graph was built over the project's history, so nodes are first seen in its
 * first run; the single-sign-on settings link is new in the latest one.
 */
export function buildWebDashboardTestMap({ caseIds, runIds, features, at }) {
  const projectId = WEB_DASHBOARD_PROJECT_ID;
  const firstRun = runIds[0];
  const latestRun = runIds[runIds.length - 1];

  const nodes = new Map();
  const edges = new Map();
  const addNode = (kind, key, origin = 'observed', attrs = null) => {
    const id = `${kind}\x00${key}`;
    if (nodes.has(id)) return;
    nodes.set(id, {
      project_id: projectId,
      kind,
      key,
      attrs,
      origin,
      first_seen_run_id: NEW_IN_LATEST.has(id) ? latestRun : firstRun,
      last_seen_run_id: latestRun,
      last_seen_at: at,
      created_at: at,
    });
  };
  const addEdge = (fromKind, fromKey, kind, toKind, toKey, extra = {}) => {
    const id = `${fromKind}\x00${fromKey}\x00${kind}\x00${toKind}\x00${toKey}`;
    if (edges.has(id)) return;
    edges.set(id, {
      project_id: projectId,
      from_kind: fromKind,
      from_key: String(fromKey),
      to_kind: toKind,
      to_key: toKey,
      kind,
      confidence: null,
      origin: 'observed',
      evidence: null,
      first_seen_run_id: NEW_IN_LATEST.has(`${toKind}\x00${toKey}`) ? latestRun : firstRun,
      last_seen_run_id: latestRun,
      last_seen_at: at,
      created_at: at,
      ...extra,
    });
  };
  const caseId = (title) => {
    const id = caseIds.get(title);
    if (id == null) throw new Error(`web-dashboard Test Map: no test case "${title}"`);
    return id;
  };

  // Routes, their handlers and the dependencies those call: a Nitro route's
  // handler from its server spans, an ASP.NET Core route's from the manifest.
  for (const [route, spec] of Object.entries(ROUTES)) {
    addNode('route', route, 'observed', spec.responses ? { responses: spec.responses } : null);
    if (spec.backend === 'aspnetcore') {
      addNode('handler', spec.handler, 'manifest', { declared: true });
      addEdge('route', route, 'handled-by', 'handler', spec.handler, { origin: 'manifest' });
    } else {
      addNode('handler', spec.handler);
      addEdge('route', route, 'handled-by', 'handler', spec.handler);
    }
    for (const dep of spec.calls) {
      addNode('dependency', dep);
      addEdge('handler', spec.handler, 'calls', 'dependency', dep);
    }
  }
  for (const { commit, files } of RECORDED_CHANGES) {
    for (const file of files) addEdge('commit', commit, 'changes', 'file', file);
  }
  for (const [route, responses] of Object.entries(DECLARED_ROUTES)) {
    addNode('route', route, 'openapi', { declared: true, responses });
  }

  // The page inventory: controls, links and the routes each page loads.
  for (const [page, spec] of Object.entries(PAGES)) {
    addNode('page', page);
    for (const [role, name] of spec.controls) {
      const key = controlKey(role, name);
      addNode('control', key, 'observed', { role });
      addEdge('page', page, 'contains', 'control', key);
    }
    for (const [name, target] of spec.links) {
      const key = `link:${name}`;
      addNode('link', key, 'observed', { href: target });
      addEdge('page', page, 'contains', 'link', key);
      if (target !== page) {
        addNode('page', target);
        addEdge('page', page, 'links', 'page', target);
      }
    }
    for (const route of spec.loads) addEdge('page', page, 'loads', 'route', route);
  }

  // Reach: every route a test requested, every page of its journey, and every
  // control or link its locators name, operated or only asserted on.
  const reachedBy = new Map(); // "kind\0key" → test titles
  const reach = (title, kind, key, evidence = null, confidence = 1) => {
    addEdge('test', caseId(title), 'reaches', kind, key, { confidence, evidence });
    const id = `${kind}\x00${key}`;
    reachedBy.set(id, new Set([...(reachedBy.get(id) ?? []), title]));
  };
  for (const [title, journey] of Object.entries(WEB_DASHBOARD_JOURNEYS)) {
    for (const request of journey.requests) {
      reach(title, 'route', routeKeyOf(request), { method: request[0], status: request[2] });
    }
    for (const page of journey.pages) reach(title, 'page', page);
  }
  const controls = new Set([...nodes.values()].filter((n) => n.kind === 'control').map((n) => n.key));
  const links = new Set([...nodes.values()].filter((n) => n.kind === 'link').map((n) => n.key));
  for (const [title, steps] of Object.entries(STEPS)) {
    const actions = new Map(); // "kind\0key" → { node, action }
    for (const [kind, target] of steps) {
      const node = kind === 'goto' || kind === 'arrive' ? null : locatorNode(target, controls, links);
      if (!node) continue;
      const id = `${node.kind}\x00${node.key}`;
      const action = kind === 'expect' ? 'checked' : 'operated';
      actions.set(id, { node, action: actions.get(id)?.action === 'operated' ? 'operated' : action });
    }
    for (const { node, action } of actions.values()) {
      reach(title, node.kind, node.key, { via: 'locator', action }, node.confidence);
    }
  }

  // Features from the `piwi:feature` tag, grouped as the recompute groups them
  // (`groupFeatures` in shared/handlers/scenario-gaps.ts).
  for (const g of webDashboardFeatureGroups(reachedBy, features)) {
    addNode('feature', g.feature, 'observed', { source: 'tag' });
    const evidence =
      g.via === 'reach' ? (g.hub ? { hub: true } : null) : { via: g.via, ...(g.hub ? { hub: true } : {}) };
    addEdge('feature', g.feature, 'groups', g.kind, g.key, {
      confidence: g.confidence,
      evidence,
      origin: g.via === 'reach' ? 'observed' : 'inferred',
    });
  }

  // Probe outcomes, each refreshing one `checks` edge.
  const probes = [];
  for (const p of CLIENT_PROBES) {
    probes.push({
      project_id: projectId,
      test_case_id: caseId(p.test),
      node_id: null,
      route_key: p.route,
      level: 'client',
      fault: p.fault,
      applied: 1,
      outcome: p.outcome,
      handled: 'n/a',
      run_id: latestRun,
      evidence: { mutation: p.fault },
      probed_at: at,
    });
    if (p.outcome === 'inconclusive') continue;
    addEdge('test', caseId(p.test), 'checks', 'route', p.route, {
      confidence: p.outcome === 'noticed' ? 1 : 0,
      evidence: { fault: p.fault, outcome: p.outcome, level: 'client' },
    });
  }
  for (const p of SERVER_PROBES) {
    probes.push({
      project_id: projectId,
      test_case_id: caseId(p.test),
      node_id: null,
      route_key: p.route,
      level: 'server',
      fault: 'dependency',
      applied: 1,
      outcome: p.outcome,
      handled: p.handled,
      run_id: latestRun,
      evidence: { dependency: p.dependency },
      probed_at: at,
    });
    addEdge('test', caseId(p.test), 'checks', 'dependency', p.dependency, {
      confidence: p.outcome === 'noticed' ? 1 : 0,
      evidence: { fault: 'dependency', outcome: p.outcome, level: 'server', route: p.route },
    });
  }

  // The gap ledger: what the detectors find in this graph, with the team's verdicts.
  const gapRow = (gap, kind, extra) => ({
    project_id: projectId,
    kind,
    detector: gap.detector,
    class: gap.class,
    key: gap.key,
    title: gap.title,
    evidence: gap.evidence,
    factors: gap.factors,
    score: gap.score,
    test_case_id: gap.test ? caseId(gap.test) : null,
    status: 'open',
    created_at: at - 30 * DAY_MS,
    updated_at: at,
    ...extra,
  });
  const gaps = [];
  for (const gap of DETECTED_GAPS) {
    const verdict = TRIAGE[`${gap.detector} ${gap.key}`];
    const extra = {};
    if (verdict?.status === 'accepted') {
      Object.assign(extra, { status: 'accepted', accepted_at: at - verdict.acceptedDaysAgo * DAY_MS });
    } else if (verdict?.status === 'snoozed') {
      Object.assign(extra, { status: 'snoozed', snoozed_until: at + verdict.snoozedForDays * DAY_MS });
    } else if (verdict?.status === 'dismissed') {
      Object.assign(extra, { status: 'dismissed', dismiss_reason: verdict.reason });
    }
    gaps.push(gapRow(gap, 'gap', extra));
  }
  for (const gap of CLOSED) {
    gaps.push(
      gapRow(gap, 'gap', {
        status: 'closed',
        closed_at: at - gap.closedDaysAgo * DAY_MS,
        updated_at: at - gap.closedDaysAgo * DAY_MS,
        closed_by_run_id: runIds[2],
      }),
    );
  }
  for (const finding of FINDINGS) gaps.push(gapRow(finding, 'finding', {}));

  const functions = CATALOG.map((f) => ({
    project_id: projectId,
    name: f.name,
    kind: f.kind ?? 'page-object-method',
    module: f.module,
    receiver: f.receiver,
    import_name: f.receiver ? f.module.split('/').pop() : null,
    params: f.params,
    returns_page: 0,
    url_pattern: f.urlPattern,
    steps: f.steps,
    param_sources: f.paramSources,
    source: 'scanned',
    confidence: 1,
    created_at: at,
    updated_at: at,
  }));
  return { nodes: [...nodes.values()], edges: [...edges.values()], probes, gaps, functions };
}

/**
 * The console lines a passing execution logs, per test. The chart's own script
 * throws and the chart still renders; a chat widget's script errors on another
 * origin; the browser repeats a 403 the test meant to get. Only the first is the
 * application's error.
 */
const PASSING_CONSOLE = {
  'renders the revenue chart': [
    {
      type: 'error',
      text: "TypeError: Cannot read properties of undefined (reading 'forecast')",
      location: `${WEB_DASHBOARD_ORIGIN}/assets/reports-4f2a.js:1:20480`,
    },
  ],
  'Users table paginates 25 rows per page': [
    { type: 'error', text: 'widget: session expired', location: 'https://widget.chat-example.io/loader.js:2:311' },
  ],
  'shows an error for a revoked account': [
    {
      type: 'error',
      text: 'Failed to load resource: the server responded with a status of 403 ()',
      location: `${WEB_DASHBOARD_ORIGIN}/api/auth/sso/callback`,
    },
  ],
};

/**
 * The tests whose passing executions carry an error of the application itself,
 * for the benchmark: the backend's failed audit write and the chart's own script
 * error. The chat widget's error and the repeated 403 are not the application's.
 */
const APP_ERRORS_WHILE_PASSING = new Set(['updates the organization name', 'renders the revenue chart']);

/** The console lines a passing execution of a test logs, or null for a test that logs none. */
export function webDashboardPassingConsole(title) {
  return PASSING_CONSOLE[title] ?? null;
}

/**
 * Whether the backend serving a request records server spans: the Nitro
 * server does, the ASP.NET Core API does not.
 */
export function webDashboardRecordsSpans(method, url) {
  const path = url.startsWith('/') ? url : new URL(url).pathname;
  return ROUTES[`${method} ${routePattern(path)}`]?.backend !== 'aspnetcore';
}

/**
 * The requests one execution of a test makes, in order, for the network table:
 * the journey's requests with durations from their position, so the seed's
 * random stream is left untouched. A request the Nitro server answers carries
 * the server spans its instrumentation records: the handler on the root span,
 * one child per dependency.
 */
export function webDashboardRequests(title) {
  const journey = WEB_DASHBOARD_JOURNEYS[title];
  if (!journey) return [];
  return journey.requests.map(([method, path, status, extra], i) => {
    const route = `${method} ${routePattern(path)}`;
    const spec = ROUTES[route];
    const duration = 40 + ((i * 37 + path.length * 11) % 160);
    const spans = !webDashboardRecordsSpans(method, path)
      ? null
      : [
          {
            id: 'root',
            name: route,
            kind: 'server',
            startMs: 0,
            durMs: duration,
            status: status >= 500 ? 'error' : 'ok',
            attrs: {
              'http.method': method,
              'http.route': routePattern(path),
              'http.status_code': status,
              ...(spec ? { 'piwi.handler': spec.handler } : {}),
            },
          },
          ...(spec?.calls ?? []).map((dep, j) => ({
            id: `dep-${j}`,
            parentId: 'root',
            name: dep,
            kind: 'client',
            startMs: Math.round(duration * (0.15 + 0.25 * j)),
            durMs: Math.max(2, Math.round(duration * 0.2)),
            attrs: { 'peer.service': dep },
          })),
        ];
    return {
      method,
      url: `${WEB_DASHBOARD_ORIGIN}${path.split('?')[0]}`,
      normalizedUrl: normalizedPath(path),
      status,
      duration,
      resourceType: 'fetch',
      serverTraces: spans,
      ...(extra?.logs
        ? {
            serverLogs: extra.logs.map(([level, category, message], j) => ({
              timestamp: j,
              level,
              category,
              message,
            })),
          }
        : {}),
    };
  });
}

/** The page an execution of the test ended on, or null for a test outside the model. */
export function webDashboardFinalPage(title) {
  const pages = WEB_DASHBOARD_JOURNEYS[title]?.pages;
  return pages ? `${WEB_DASHBOARD_ORIGIN}${pages[pages.length - 1]}` : null;
}
