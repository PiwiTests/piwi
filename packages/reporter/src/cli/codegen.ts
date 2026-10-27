/**
 * `piwi codegen` — turn a steps file into a Playwright spec.
 *
 * A steps file is the portable form of a recording (Piwi Picker's Download
 * steps). This renders it with the shared converter in
 * `@piwitests/core`, with the defaults a test project wants: paths so the
 * config's `baseURL` applies, stable locators, and a URL check after each
 * navigation. Given a project, it also uses the project's function catalog and
 * prefers the locators the project's tests already use; the dashboard is never
 * required, and an unreachable one only costs those two.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderSpec, type CodegenOptions, type CodegenResult } from '@piwitests/core/codegen';
import type { TestFunctionEntry } from '@piwitests/core/function-match';
import { canonicalLocator } from '@piwitests/core/locator-chain';
import { parseSteps, sessionFromSteps, type PiwiSteps } from '@piwitests/core/steps';
import { connectionFolders, resolveCliConnection } from '../internal/support/connection.js';
import { resolveProjectId } from '../internal/support/selection-client.js';

const EXIT_OK = 0;
const EXIT_ERROR = 2;

/** A steps file is small; anything larger is not one. */
const MAX_STEPS_FILE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const USAGE = `
piwi codegen — turn a steps file into a Playwright spec

Usage:
  npx @piwitests/reporter codegen <steps.json> [options]
  npx @piwitests/reporter codegen bug:<id> [options]   the steps of a bug report on the dashboard

Output:
  --out <file>          Write the spec to this file (an existing file needs --force)
  --body                Print only the test's lines, to paste into an existing test
  --title <text>        Test title (default: the steps' own title)

Code:
  --test-import <mod>   Module test and expect come from (default @playwright/test)
  --absolute-urls       Keep recorded URLs instead of paths for your baseURL
  --no-url-checks       Do not wait for each new page's URL
  --env-values          Read typed values from variables named after their fields (E2E_EMAIL)
  --fail                Mark the test as expected to fail (test.fail())
  --fail-reason <text>  The reason written beside test.fail()
  --tag <tag>           Add a tag; repeat for more

Project (optional: your function catalog, and the locators your tests already use):
  --project <name|id>   Project               (env PIWI_PROJECT_NAME, .env)
  --server-url <url>    Dashboard URL         (env PIWI_DASHBOARD_URL, .env, the desktop app)
  --api-key <key>       API key               (env PIWI_API_KEY, .env)
  --offline             Do not contact the dashboard

Exit codes: 0 ok, 2 the steps could not be read or the spec could not be written.
`.trim();

export interface CodegenArgs {
  file: string;
  out: string | null;
  force: boolean;
  body: boolean;
  title: string | null;
  testImport: string | null;
  absoluteUrls: boolean;
  urlChecks: boolean;
  envValues: boolean;
  fail: boolean;
  failReason: string | null;
  tags: string[];
  project: string;
  serverUrl: string;
  apiKey: string | null;
  offline: boolean;
}

const VALUE_FLAGS = new Set([
  '--out',
  '--title',
  '--test-import',
  '--fail-reason',
  '--tag',
  '--project',
  '--server-url',
  '--api-key',
]);

function readOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

function readAll(argv: string[], name: string): string[] {
  const values: string[] = [];
  argv.forEach((token, i) => {
    const value = argv[i + 1];
    if (token === name && value !== undefined && !value.startsWith('--')) values.push(value);
  });
  return values;
}

function findFile(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      if (VALUE_FLAGS.has(token)) i++;
      continue;
    }
    return token;
  }
  return undefined;
}

/** Parse the arguments; the connection falls back to the `.env` of `dirs`, then the desktop app. */
export function parseCodegenArgs(argv: string[], env: NodeJS.ProcessEnv, dirs: string[] = []): CodegenArgs {
  const file = findFile(argv);
  if (!file) throw new Error('No steps file — usage: piwi codegen <steps.json>');
  for (const flag of VALUE_FLAGS) {
    if (argv.includes(flag) && readOption(argv, flag) === undefined) throw new Error(`${flag} expects a value`);
  }
  const connection = resolveCliConnection(
    {
      serverUrl: readOption(argv, '--server-url'),
      apiKey: readOption(argv, '--api-key'),
      project: readOption(argv, '--project'),
    },
    env,
    dirs,
    'piwi codegen',
  );
  return {
    file,
    out: readOption(argv, '--out') ?? null,
    force: argv.includes('--force'),
    body: argv.includes('--body'),
    title: readOption(argv, '--title') ?? null,
    testImport: readOption(argv, '--test-import') ?? null,
    absoluteUrls: argv.includes('--absolute-urls'),
    urlChecks: !argv.includes('--no-url-checks'),
    envValues: argv.includes('--env-values'),
    fail: argv.includes('--fail') || argv.includes('--fail-reason'),
    failReason: readOption(argv, '--fail-reason') ?? null,
    tags: readAll(argv, '--tag'),
    project: connection?.project ?? readOption(argv, '--project') ?? env.PIWI_PROJECT_NAME ?? '',
    serverUrl: connection?.serverUrl ?? '',
    apiKey: connection?.apiKey ?? null,
    offline: argv.includes('--offline'),
  };
}

/** What the dashboard adds to a spec: the project's functions and the chains its tests use. */
export interface ProjectContext {
  catalog: TestFunctionEntry[];
  suiteLocators: Set<string>;
}

/** The converter's options for these arguments. */
function codegenOptions(args: CodegenArgs, steps: PiwiSteps, project: ProjectContext | null): CodegenOptions {
  return {
    title: args.title ?? steps.title ?? undefined,
    testImport: args.testImport ?? undefined,
    urls: args.absoluteUrls ? 'absolute' : 'relative',
    locators: 'stable',
    urlChecks: args.urlChecks,
    values: args.envValues ? 'env' : 'literal',
    expectFail: args.fail ? (args.failReason ? { reason: args.failReason } : true) : false,
    tags: args.tags,
    format: args.body ? 'body' : 'file',
    catalog: project?.catalog,
    preferLocators: project?.suiteLocators,
  };
}

/** Parse a steps file's text and render it; throws with every problem the file has. */
export function renderStepsFile(text: string, args: CodegenArgs, project: ProjectContext | null): CodegenResult {
  const parsed = parseSteps(text);
  if (!parsed.ok) throw new Error(`${args.file} is not a steps file:\n  ${parsed.errors.join('\n  ')}`);
  return renderSpec(sessionFromSteps(parsed.steps), codegenOptions(args, parsed.steps, project));
}

function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { 'X-API-Key': apiKey } : {};
}

async function fetchJson(url: string, apiKey: string | null): Promise<unknown> {
  const res = await fetch(url, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
  return res.json();
}

function listOf(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body;
  const value = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value : [];
}

async function loadProjectContext(args: CodegenArgs): Promise<ProjectContext> {
  const projectId = await resolveProjectId({
    serverUrl: args.serverUrl,
    apiKey: args.apiKey,
    project: args.project,
    key: '',
  });
  const base = `${args.serverUrl}/api/projects/${projectId}`;
  const [functions, index] = await Promise.all([
    fetchJson(`${base}/test-functions`, args.apiKey),
    fetchJson(`${base}/locator-index`, args.apiKey),
  ]);
  const catalog = listOf(functions, 'testFunctions')
    .map((row) => (row as { entry?: TestFunctionEntry }).entry)
    .filter((entry): entry is TestFunctionEntry => !!entry);
  const suiteLocators = new Set(
    listOf(index, 'locators').flatMap((entry) => {
      const canonical = canonicalLocator(String((entry as { locator?: unknown }).locator ?? ''));
      return canonical ? [canonical] : [];
    }),
  );
  return { catalog, suiteLocators };
}

export async function runCodegen(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return EXIT_OK;
  }
  let args: CodegenArgs;
  try {
    // With --server-url and a project the connection takes nothing from a .env, so the folders are not looked up.
    const given = readOption(argv, '--server-url') && (readOption(argv, '--project') || env.PIWI_PROJECT_NAME);
    args = parseCodegenArgs(argv, env, given ? [] : connectionFolders(cwd));
  } catch (e) {
    console.error(`piwi codegen: ${(e as Error).message}\n\n${USAGE}`);
    return EXIT_ERROR;
  }

  let text: string;
  const bugId = /^bug:#?(\d+)$/.exec(args.file)?.[1];
  if (bugId) {
    if (!args.serverUrl) {
      console.error(
        'piwi codegen: bug:<id> reads the report from the dashboard — pass --server-url or set PIWI_DASHBOARD_URL (environment or .env)',
      );
      return EXIT_ERROR;
    }
    try {
      const report = (await fetchJson(`${args.serverUrl}/api/bug-reports/${bugId}`, args.apiKey)) as {
        title?: string;
        steps?: unknown;
      };
      text = JSON.stringify({ ...(report.steps as object), title: report.title ?? null });
    } catch (e) {
      console.error(`piwi codegen: bug report #${bugId}: ${(e as Error).message}`);
      return EXIT_ERROR;
    }
  } else {
    try {
      if (fs.statSync(args.file).size > MAX_STEPS_FILE_BYTES) throw new Error('is too large to be a steps file');
      text = fs.readFileSync(args.file, 'utf-8');
    } catch (e) {
      const reason = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'does not exist' : (e as Error).message;
      console.error(`piwi codegen: ${args.file} ${reason}`);
      return EXIT_ERROR;
    }
  }

  let project: ProjectContext | null = null;
  if (!args.offline && args.serverUrl && args.project) {
    try {
      project = await loadProjectContext(args);
    } catch (e) {
      console.error(
        `piwi codegen: warning: no catalog or suite locators (${(e as Error).message}); rendering without them`,
      );
    }
  }

  let result: CodegenResult;
  try {
    result = renderStepsFile(text, args, project);
  } catch (e) {
    console.error(`piwi codegen: ${(e as Error).message}`);
    return EXIT_ERROR;
  }
  for (const warning of result.warnings) {
    console.error(`piwi codegen: warning: step ${warning.step + 1}: ${warning.message}`);
  }

  if (!args.out) {
    process.stdout.write(result.code);
    return EXIT_OK;
  }
  try {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, result.code, { flag: args.force ? 'w' : 'wx' });
  } catch (e) {
    const exists = (e as NodeJS.ErrnoException).code === 'EEXIST';
    console.error(`piwi codegen: ${exists ? `${args.out} exists — pass --force to replace it` : (e as Error).message}`);
    return EXIT_ERROR;
  }
  const calls = result.matchedSpans.length;
  console.error(
    `piwi codegen: wrote ${args.out}${calls > 0 ? ` (${calls} call${calls === 1 ? '' : 's'} to your functions)` : ''}`,
  );
  return EXIT_OK;
}
