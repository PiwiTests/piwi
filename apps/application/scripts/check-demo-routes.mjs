/**
 * check-demo-routes.mjs
 *
 * Compares the real Nuxt server API routes (derived from file names under
 * server/api/) against the patterns registered in app/demo/api/router.ts.
 *
 * Run from the `application/` directory:
 *   node scripts/check-demo-routes.mjs
 *
 * Exits with code 1 if any server route is missing from the demo router and
 * is not on the INTENTIONALLY_EXCLUDED list below, or if a demo route does not
 * declare the permission its server twin declares in `x-required-permission`
 * (any but `project:read` and `signed-in`, which every acting user passes).
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ── Routes that are intentionally absent from the demo router ─────────────
//
// These are server-only write endpoints that don't make sense in a static
// client-side demo (no persistent server, no file system, no SCM access).
const INTENTIONALLY_EXCLUDED = new Set([
  'GET /api/ai/deepseek-cli/status', // official local CLI credentials have no browser-demo equivalent
  'GET /api/ai/codex-cli/status', // local CLI authentication has no browser-demo equivalent
  'POST /api/auth/setup', // initial admin setup (server only)
  'POST /api/test-runs/submit', // bulk result submission (no server in demo)
  'POST /api/test-runs/upload', // multipart upload (no server in demo)
  'POST /api/test-runs/start', // alternate streaming start (server only)
  'POST /api/test-runs/:id/case-files', // file upload during live run (server only)
  'DELETE /api/tests/cleanup', // test-suite cleanup hook (server only)
  'POST /api/traces/check', // trace dedup check (server only)
  'GET /api/integrations/connections/:id/icon', // a tracker icon fetched with the connection's credentials; the demo's pickers carry no icons
  'POST /api/test-runs/:id/gate', // CI gate policy — there is no pipeline to gate in a browser demo
  'POST /api/projects/:id/selections/impact', // impact-from-diff — needs a local git diff the browser demo cannot produce
  'GET /api/desktop/reporter-config', // desktop build only; returns null everywhere else, including the demo
  'POST /api/desktop/import-local', // desktop build only; reads local files, 404 everywhere else
  'POST /api/desktop/import-bug-report', // desktop build only; reads a local .piwibug, 404 everywhere else
  'GET /api/desktop/live-runs', // desktop build only; reports the shell's watched runs, empty everywhere else
  'GET /api/desktop/events', // desktop build only; the desktop window's run progress and page requests, read only inside the shell
  'POST /api/desktop/repro-requests', // desktop build only; Piwi Picker asks the app to run a report, 404 everywhere else
  'GET /api/desktop/repro-requests/:id', // desktop build only; a repro request and its verdict, 404 everywhere else
  'PATCH /api/desktop/repro-requests/:id', // desktop build only; the window records what it did with a request
  'GET /api/desktop/repro-requests/:id/spec', // desktop build only; the shell reads the spec it writes and runs
  'POST /api/desktop/picker-pairings', // desktop build only; Piwi Picker asks to pair with the app, 404 everywhere else
  'GET /api/desktop/picker-pairings/:id', // desktop build only; Piwi Picker polls for the answer
  'PATCH /api/desktop/picker-pairings/:id', // desktop build only; the window allows or denies a pairing
  'POST /api/projects/:id/test-functions/extract', // AI code-to-pattern extraction — unlike diagnosis (a fixed, curated set of seeded clusters a scripted response can convincingly cover), this takes arbitrary pasted code with no server or real LLM to analyze it against in the demo; the "Paste from code (AI)" section is hidden client-side in demo mode instead of faking an understanding of whatever the visitor pastes
  'POST /api/ai/step-resolution', // AI-step authoring — resolves an arbitrary page snapshot against a natural-language prompt; no server or real LLM in the demo, and the reporter only calls it in resolve/heal mode (never a normal run), so there is nothing to script
  // Share links: capability tokens for anonymous viewers. The demo has no
  // accounts and its data is already public, so there is nothing to share —
  // and no server to resolve a token against.
  'POST /api/test-run-cases/:id/share-links',
  'GET /api/test-run-cases/:id/share-links',
  'POST /api/failure-clusters/:id/share-links',
  'GET /api/failure-clusters/:id/share-links',
  'DELETE /api/share-links/:id',
  'GET /api/share-links/settings',
  'GET /api/projects/:id/share-links',
  'POST /api/reports/snapshots/:id/share-links',
  'GET /api/reports/snapshots/:id/share-links',
  'POST /api/dashboards/:id/share-links',
  'GET /api/dashboards/:id/share-links',
  // Former paths kept for scripts: the app calls the new ones, since ad blockers
  // refuse requests whose address contains "analytics".
  'GET /api/analytics/:widget',
  'GET /api/projects/:id/selections/analytics',
  // OpenMetrics for an operator's Prometheus or Grafana to pull: there is no
  // server in the browser demo for a scraper to reach.
  'GET /api/metrics',
  // Inbound Jira webhook: a public receiver an external Jira posts to. There is
  // no server in the browser demo, and it only ever refreshes a link.
  'POST /api/integrations/jira/webhook/:token',
  // Local Claude CLI session: desktop-app only, drives a `claude` binary on the
  // host. 404 everywhere else, including the demo, with nothing to script.
  'GET /api/ai/claude-cli/status',
  'POST /api/ai/claude-cli/login',
  'POST /api/ai/claude-cli/logout',
  // Connecting Piwi Picker: a device authorization that ends in an API key for
  // an account. The demo has no server for an extension to reach and no keys.
  'POST /api/extension/connect',
  'POST /api/extension/connect/token',
  'GET /api/extension/connect/request',
  'POST /api/extension/connect/decision',
  // An MCP client's OAuth sign-in: the consent page answers a request the
  // authorize endpoint stored, and the client redeems a code for tokens. The
  // demo has no server for an MCP client to reach.
  'GET /api/oauth/authorizations/:id',
  'POST /api/oauth/authorizations/:id/decision',
  // DOM-snapshot picker frame: serves a sandboxed HTML document over its own
  // CSP, not JSON — the browser demo renders snapshots through its own handler.
  'GET /api/test-run-cases/:id/dom-snapshot-frame',
  // Bug reports arrive from Piwi Picker as a multipart upload with PNG
  // screenshots and JPEG step screenshots kept in server storage; the demo has neither.
  'POST /api/projects/:id/bug-reports',
  'GET /api/bug-reports/:id/screenshots/:index',
  'GET /api/bug-reports/:id/step-shots/:step',
]);

// ── Derive all server routes from the file system ────────────────────────

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...walk(full));
    } else {
      entries.push(full);
    }
  }
  return entries;
}

const serverApiDir = join(root, 'server', 'api');
const serverFiles = walk(serverApiDir);

const METHOD_RE = /\.(get|post|put|patch|delete)\.ts$/i;
const PARAM_RE = /\[([^\]]+)\]/g;

function fileToRoute(absPath) {
  const rel = absPath.slice(serverApiDir.length + 1).replace(/\\/g, '/');
  const methodMatch = rel.match(METHOD_RE);
  if (!methodMatch) return null;
  const method = methodMatch[1].toUpperCase();

  // Strip method suffix and .ts, then remove trailing /index
  let pathPart = rel.replace(METHOD_RE, '').replace(/\/index$/, '');

  // Convert [param] → :param
  pathPart = pathPart.replace(PARAM_RE, ':$1');

  // Convert [...rest] → :rest (catch-all)
  pathPart = pathPart.replace(/:\.\.\./g, ':');

  return `${method} /api/${pathPart}`;
}

const serverRoutes = serverFiles.map(fileToRoute).filter(Boolean).sort();

/** The permissions in a meta or route-entry literal: `'triage:write'` or `['a', 'b']`. */
function permissionsIn(literal) {
  return [...literal.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

// The permission each server route declares, by route key ([] for none).
const serverPermissions = new Map();
for (const file of serverFiles) {
  const route = fileToRoute(file);
  if (!route) continue;
  const meta = /['"]x-required-permission['"]\s*:\s*(\[[^\]]*\]|'[^']*')/.exec(readFileSync(file, 'utf-8'));
  serverPermissions.set(route, meta ? permissionsIn(meta[1]) : []);
}

// ── Extract demo router patterns ──────────────────────────────────────────

const routerSrc = readFileSync(join(root, 'app', 'demo', 'api', 'router.ts'), 'utf-8');

// Pull every pattern literal from the routes array.
// e.g. /^\/api\/failure-clusters\/(\d+)$/ → extract the string between /…/
const PATTERN_RE = /pattern:\s*\/([^/].*?)\/(?:,|\s)/g;
const demoPatterns = [];
let m;
while ((m = PATTERN_RE.exec(routerSrc)) !== null) {
  demoPatterns.push(new RegExp(m[1]));
}

// Also extract methods to pair with patterns.
// We build [{ method, pattern }] by scanning the routes array lines.
// Extract method+pattern pairs.  Use the `s` flag so that `.*?` spans
// newlines — many route entries in the demo router write `method` and
// `pattern` on separate lines.
const ROUTE_BLOCK_RE = /\{\s*method:\s*'(GET|POST|PUT|PATCH|DELETE)'.*?pattern:\s*(\/[^,]+\/)/gs;
const PERMISSION_RE = /^,\s*permission:\s*(\[[^\]]*\]|'[^']*')/;
const demoRoutes = [];
while ((m = ROUTE_BLOCK_RE.exec(routerSrc)) !== null) {
  const permission = PERMISSION_RE.exec(routerSrc.slice(m.index + m[0].length));
  demoRoutes.push({
    method: m[1],
    pattern: new RegExp(m[2].slice(1, -1)),
    permissions: permission ? permissionsIn(permission[1]) : [],
  });
}

// ── Match each server route against the demo router ───────────────────────

// Build a test URL for each server route by substituting :param with 123.
function routeToTestPath(route) {
  return route.replace(/:[\w.]+/g, '123');
}

const missing = [];
const excluded = [];
const permissionMismatches = [];
// Every acting user passes these, so a demo route may leave them out.
const PASSED_BY_EVERYONE = new Set(['project:read', 'signed-in']);

for (const route of serverRoutes) {
  const [method, path] = route.split(' ');
  const testPath = routeToTestPath(path);
  const key = `${method} ${path}`;

  if (INTENTIONALLY_EXCLUDED.has(key)) {
    excluded.push(key);
    continue;
  }

  const matched = demoRoutes.find((r) => r.method === method && r.pattern.test(testPath));

  if (!matched) {
    missing.push(key);
    continue;
  }

  const expected = (serverPermissions.get(route) ?? []).filter((p) => !PASSED_BY_EVERYONE.has(p));
  const declared = matched.permissions.filter((p) => !PASSED_BY_EVERYONE.has(p));
  if (expected.join(',') !== declared.join(',')) {
    permissionMismatches.push(
      `${key}: the server declares ${expected.length ? expected.join(', ') : 'no permission to check'}, the demo route ${declared.length ? declared.join(', ') : 'none'}`,
    );
  }
}

// ── Report ────────────────────────────────────────────────────────────────

console.log(`Server routes:  ${serverRoutes.length}`);
console.log(`Demo patterns:  ${demoRoutes.length}`);
console.log(`Excluded:       ${excluded.length}`);

if (permissionMismatches.length > 0) {
  console.log(`\n✗ ${permissionMismatches.length} demo route(s) do not declare their server route's permission:\n`);
  for (const r of permissionMismatches) {
    console.log(`  ${r}`);
  }
  console.log(`
Copy the server route's \`x-required-permission\` into the demo route entry's
\`permission\` field in app/demo/api/router.ts, and check it on the project the
handler acts on (assertDemoScope / assertDemoEntityScope / demoCan).\n`);
}

if (missing.length === 0) {
  if (permissionMismatches.length > 0) process.exit(1);
  console.log('\n✓ All server routes are covered by the demo router.\n');
  process.exit(0);
} else {
  console.log(`\n✗ ${missing.length} server route(s) are missing from the demo router:\n`);
  for (const r of missing) {
    console.log(`  ${r}`);
  }
  console.log(`
Add these routes to app/demo/api/router.ts (and implement the handlers in
the appropriate app/demo/api/*.ts file), or add them to the
INTENTIONALLY_EXCLUDED set at the top of this script if they don't apply
in demo mode.\n`);
  process.exit(1);
}
