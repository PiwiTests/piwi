/**
 * Every API route declares who may call it in its `x-required-permission`
 * route meta, and a route that needs a permission on one project checks it on
 * that project (proposals/roles-and-groups.md, section 5.2). The early check in
 * `requireAuth` only proves the caller holds the permission on some project;
 * without the per-project check, a Maintainer of project B could triage
 * project A.
 */
import { describe, test, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProjectPermission, isRoutePermission } from '#shared/permissions';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROUTE_DIRS = ['server/api', 'server/routes'];

/**
 * Routes that declare a project permission but cannot check it on one project,
 * because the request names no project. `requireAuth` still applies the early
 * check (the permission held on at least one project, or an administrator).
 * Keys are paths relative to the app directory.
 */
const NO_PROJECT_IN_REQUEST: Record<string, string> = {
  'server/api/groups/index.get.ts':
    'Administrators manage groups; a Project admin lists them to add one to their project, which the members route checks per project.',
  'server/api/ai/step-resolution.post.ts':
    'The reporter resolves an AI step from a template and an ARIA snapshot; no project is involved.',
  'server/api/dashboards/[id]/share-links.post.ts':
    'A dashboard spans projects; its live link renders only the projects its minter may share (`share:create`), checked at every view.',
  'server/api/integrations/connections/[id]/assignable.get.ts':
    'Reads tracker metadata through a connection for the create-issue dialog; no Piwi project in the request.',
  'server/api/integrations/connections/[id]/icon.get.ts':
    'Serves a tracker icon through a connection for the create-issue dialog; no Piwi project in the request.',
  'server/api/integrations/connections/[id]/issue-picker.get.ts':
    'Searches tracker issues through a connection for a create-issue field; no Piwi project in the request.',
  'server/api/integrations/connections/[id]/projects.get.ts':
    'Reads tracker metadata through a connection for the create-issue dialog; no Piwi project in the request.',
  'server/api/integrations/connections/[id]/projects/[key]/issue-types.get.ts':
    'Reads tracker metadata through a connection for the create-issue dialog; no Piwi project in the request.',
  'server/api/integrations/connections/[id]/projects/[key]/issue-types/[type]/fields.get.ts':
    'Reads tracker metadata through a connection for the create-issue dialog and the binding form; no Piwi project in the request.',
  'server/api/integrations/connections/[id]/projects/[key]/transitions.get.ts':
    'A Project admin binds their project to the tracker and picks the transitions; the answer holds no secret (an issue key, its status and the transitions).',
  'server/api/reports/schedules/[id].get.ts':
    'A schedule spans projects; the handler shows it to its owner, or to everyone when global.',
  'server/api/reports/schedules/[id].delete.ts':
    'A schedule spans projects; the handler lets only its owner (or an administrator) delete it.',
  'server/api/reports/schedules/[id]/run.post.ts':
    'A schedule spans projects; the handler lets only its owner (or an administrator) run it, collected with the owner’s project access.',
};

/** The calls that check a permission on one project, or narrow to the projects where it is held. */
const PROJECT_CHECK =
  /\b(requireProjectAccess|requireResolvedProjectAccess|getProjectScope|canAccessProject|scopeAllows|can)\(/;

/** Scope helpers and the position of their permission argument (1-based). */
const SCOPE_HELPERS = { getProjectScope: 3, canAccessProject: 4 } as const;

function routeFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    }
  };
  for (const dir of ROUTE_DIRS) walk(join(appDir, dir));
  return files.sort();
}

const rel = (file: string) => relative(appDir, file);

/** The source of the meta block: the text of the `defineRouteMeta(...)` call. */
function metaBlock(src: string): string | null {
  const start = src.indexOf('defineRouteMeta(');
  if (start === -1) return null;
  return src.slice(start, callEnd(src, start + 'defineRouteMeta('.length - 1));
}

/** The index just past the parenthesis closing the one at `open`. */
function callEnd(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** How many top-level arguments each call of `name` passes. */
function callArgCounts(src: string, name: string): number[] {
  const counts: number[] = [];
  const pattern = new RegExp(`(?<![.\\w])${name}\\(`, 'g');
  for (const match of src.matchAll(pattern)) {
    const before = src.slice(Math.max(0, match.index - 20), match.index);
    if (/function\s+$/.test(before)) continue;
    const open = match.index + name.length;
    const inner = src.slice(open + 1, callEnd(src, open) - 1);
    if (inner.trim() === '') {
      counts.push(0);
      continue;
    }
    let depth = 0;
    let quote: string | null = null;
    let args = 1;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]!;
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0 && inner.slice(i + 1).trim() !== '') args++;
    }
    counts.push(args);
  }
  return counts;
}

type ParsedPermission = { ok: true; values: string[] } | { ok: false; raw: string } | null;

/** The meta's `x-required-permission` value, when it is an inline string literal or array of them. */
function requiredPermission(meta: string): ParsedPermission {
  const key = /['"]?x-required-permission['"]?\s*:/.exec(meta);
  if (!key) return null;
  const rest = meta.slice(key.index + key[0].length);
  const single = rest.match(/^\s*(['"])([^'"]*)\1\s*[,}\n]/);
  if (single) return { ok: true, values: [single[2]!] };
  const list = rest.match(/^\s*\[((?:\s*(['"])[^'"]*\2\s*,?)*)\s*\]\s*[,}\n]/);
  if (list) return { ok: true, values: [...list[1]!.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]!) };
  return { ok: false, raw: rest.trim().split('\n')[0]! };
}

/** The route file a handler re-exports (`import handler from './x'; export default handler;`), if any. */
function reexportedRoute(file: string, src: string): string | null {
  const match = src.match(/^import (\w+) from '(\.[^']+)';[\s\S]*^export default \1;/m);
  if (!match) return null;
  const target = resolve(dirname(file), `${match[2]}.ts`);
  return existsSync(target) ? target : null;
}

const routes = routeFiles().map((file) => {
  const src = readFileSync(file, 'utf8');
  const meta = metaBlock(src);
  return { file, path: rel(file), src, meta, permission: meta ? requiredPermission(meta) : null };
});

describe('route permissions', () => {
  test('no route declares the old x-required-roles meta', () => {
    const offenders = routes.filter((r) => r.src.includes('x-required-roles')).map((r) => r.path);
    expect(
      offenders,
      'Replace `x-required-roles` with `x-required-permission` (a permission of `shared/permissions.ts`, a list of them, or `signed-in`)',
    ).toEqual([]);
  });

  test('every x-required-permission is an inline string literal, or an inline array of them', () => {
    const problems = routes
      .filter((r) => r.permission && !r.permission.ok)
      .map(
        (r) =>
          `${r.path}: \`${(r.permission as { raw: string }).raw}\` — write the permission as a string literal or an inline array of string literals; Nitro's meta extractor silently drops variables, calls and enum members`,
      );
    expect(problems).toEqual([]);
  });

  test('every declared permission is a known permission or signed-in', () => {
    const problems: string[] = [];
    for (const r of routes) {
      if (!r.permission?.ok) continue;
      if (r.permission.values.length === 0) {
        problems.push(`${r.path}: an empty list — remove the field for a public route, or name a permission`);
      }
      for (const value of r.permission.values) {
        if (!isRoutePermission(value)) {
          problems.push(`${r.path}: '${value}' is not a permission of shared/permissions.ts, nor 'signed-in'`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('a route that authenticates its caller declares its permission', () => {
    const problems = routes
      .filter(
        (r) =>
          r.meta && !r.permission && /\b(requireAuth|requireProjectAccess|requireResolvedProjectAccess)\(/.test(r.src),
      )
      .map(
        (r) =>
          `${r.path}: calls requireAuth or a project access helper but declares no \`x-required-permission\` — declare 'signed-in', 'project:read' or the permission it needs`,
      );
    expect(problems).toEqual([]);
  });

  test('a route needing a project permission checks it on the project', () => {
    const problems: string[] = [];
    for (const r of routes) {
      if (!r.permission?.ok || !r.permission.values.some(isProjectPermission)) continue;
      if (r.path in NO_PROJECT_IN_REQUEST) continue;
      const target = reexportedRoute(r.file, r.src);
      const src = target ? readFileSync(target, 'utf8') : r.src;
      if (!PROJECT_CHECK.test(src)) {
        problems.push(
          `${r.path} declares ${r.permission.values.join(', ')} but never checks it on a project — call requireProjectAccess / requireResolvedProjectAccess (they read the route meta), pass the permission to getProjectScope / canAccessProject, or call can(access, permission, projectId); a route whose request names no project goes in NO_PROJECT_IN_REQUEST with the reason`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  test('a write route narrows its project scope to the permission it needs', () => {
    const problems: string[] = [];
    for (const r of routes) {
      if (!r.permission?.ok) continue;
      const writes = r.permission.values.filter((p) => isProjectPermission(p) && p !== 'project:read');
      if (writes.length === 0) continue;
      for (const [helper, position] of Object.entries(SCOPE_HELPERS)) {
        for (const count of callArgCounts(r.src, helper)) {
          if (count < position) {
            problems.push(
              `${r.path} declares ${writes.join(', ')} but calls ${helper}() without a permission — pass it (\`${helper}(…, '${writes[0]}')\`), or 'project:read' when the call only reads, so a caller who reads project A but writes project B cannot write A`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('every NO_PROJECT_IN_REQUEST entry names an existing route that declares a project permission', () => {
    const byPath = new Map(routes.map((r) => [r.path, r]));
    const stale = Object.keys(NO_PROJECT_IN_REQUEST).filter((path) => {
      const r = byPath.get(path);
      return !r?.permission?.ok || !r.permission.values.some(isProjectPermission);
    });
    expect(stale, 'Remove these entries from NO_PROJECT_IN_REQUEST').toEqual([]);
  });
});

describe('the parsing helpers of this test', () => {
  test('reads a single permission and a list', () => {
    expect(requiredPermission(`openAPI: { 'x-required-permission': 'triage:write',\n }`)).toEqual({
      ok: true,
      values: ['triage:write'],
    });
    expect(requiredPermission(`{ 'x-required-permission': ['run:submit', 'run:control'] }`)).toEqual({
      ok: true,
      values: ['run:submit', 'run:control'],
    });
    expect(requiredPermission(`{ 'x-required-permission': PERMISSION,\n }`)).toMatchObject({ ok: false });
    expect(requiredPermission(`{ "x-required-permission": "signed-in" }`)).toEqual({ ok: true, values: ['signed-in'] });
    expect(requiredPermission(`{ summary: 'x' }`)).toBeNull();
  });

  test('counts the arguments of each call', () => {
    expect(callArgCounts(`await getProjectScope(db, user as any);`, 'getProjectScope')).toEqual([2]);
    expect(callArgCounts(`getProjectScope(db, f(a, b), 'triage:write')`, 'getProjectScope')).toEqual([3]);
    expect(callArgCounts(`canAccessProject(db, user, projectId)`, 'canAccessProject')).toEqual([3]);
    expect(callArgCounts(`import { getProjectScope } from 'x'; foo.getProjectScope(a)`, 'getProjectScope')).toEqual([]);
  });
});
