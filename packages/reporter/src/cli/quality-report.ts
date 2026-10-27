/**
 * `piwi report` — print a quality report from the dashboard.
 *
 * Calls `GET /api/reports/preview` with the API key and writes the result to
 * stdout or a file, so a team that already has a CI scheduler can post the
 * Markdown to a channel every week, or attach the PDF to a release.
 *
 * Exit codes follow `piwi gate`:
 *   0  the report was written
 *   1  the report was written and its verdict is at or below `--fail-on`
 *   2  no report (bad arguments, unreachable dashboard)
 */
import * as fs from 'node:fs';
import { resolveCliConnection } from '../internal/support/connection.js';
import { resolveProjectId } from '../internal/support/selection-client.js';

const EXIT_OK = 0;
const EXIT_VERDICT = 1;
const EXIT_ERROR = 2;

const FORMATS = ['md', 'json', 'html', 'pdf', 'csv'] as const;
const DASHBOARDS = ['executive', 'engineering', 'overview'] as const;
type Tone = 'good' | 'mixed' | 'bad';

const USAGE = `
piwi report — print a quality report from the dashboard

Usage:
  npx @piwitests/reporter report [options]

Connection:
  --server-url <url>     Dashboard URL                 (env PIWI_DASHBOARD_URL, .env, the desktop app)
  --api-key <key>        API key                       (env PIWI_API_KEY, .env)

What to report:
  --project <names|ids>  Comma-separated projects (default: every project you can see)
  --period <period>      7d, 30d (default), last-month, this-quarter, 2026-08-01..2026-08-31, …
  --compare <mode>       previous (default), year, none
  --dashboard <name>     executive (default), engineering, overview
  --branch <names>       Comma-separated branches (default: each project's default branch)
  --environment <names>  Comma-separated environments
  --selection <key>      Only the tests of this selection
  --lang <code>          Report language, such as en or fr (default: the dashboard's default)

Output:
  --format <fmt>         md (default), json, html, pdf, csv
  --output <file>        Write to a file instead of stdout (required for pdf)
  --fail-on <tone>       Exit 1 when the verdict is bad, or mixed or bad (--fail-on mixed)
  -h, --help             Show this help

Exit codes: 0 written, 1 written and the verdict is at or below --fail-on, 2 no report.
`.trim();

export interface ReportArgs {
  serverUrl: string;
  apiKey: string | null;
  projects: string[];
  period: string;
  compare: string | null;
  dashboard: (typeof DASHBOARDS)[number];
  branches: string | null;
  environments: string | null;
  selection: string | null;
  /** A language code; the dashboard says which languages it writes. */
  lang: string | null;
  format: (typeof FORMATS)[number];
  output: string | null;
  failOn: Tone | null;
}

/** Read `--flag value` / `--flag=value`, or undefined when absent. */
function readOption(argv: string[], name: string): string | undefined {
  const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

/** `7d` and `30d` are shorthands for the rolling periods; anything else is passed through. */
export function normalizePeriod(raw: string): string {
  const days = raw.trim().match(/^(\d+)d$/);
  return days ? `last-${days[1]}d` : raw.trim();
}

/** Parse the arguments; the connection falls back to the `.env` of `dirs`, then the desktop app. */
export function parseReportArgs(argv: string[], env: NodeJS.ProcessEnv, dirs: string[] = []): ReportArgs {
  const connection = resolveCliConnection(
    { serverUrl: readOption(argv, '--server-url'), apiKey: readOption(argv, '--api-key') },
    env,
    dirs,
    'piwi report',
  );
  if (!connection)
    throw new Error('No dashboard URL — pass --server-url or set PIWI_DASHBOARD_URL (environment or .env)');

  const format = (readOption(argv, '--format') ?? 'md').toLowerCase();
  if (!(FORMATS as readonly string[]).includes(format)) {
    throw new Error(`--format must be one of ${FORMATS.join(', ')}, got "${format}"`);
  }
  const dashboard = readOption(argv, '--dashboard') ?? 'executive';
  if (!(DASHBOARDS as readonly string[]).includes(dashboard)) {
    throw new Error(`--dashboard must be one of ${DASHBOARDS.join(', ')}, got "${dashboard}"`);
  }
  const lang = readOption(argv, '--lang') ?? null;
  // The dashboard knows its languages and refuses the others; only the shape is checked here.
  if (lang !== null && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang)) {
    throw new Error(`--lang must be a language code such as en or fr, got "${lang}"`);
  }
  const failOn = readOption(argv, '--fail-on') ?? null;
  if (failOn !== null && failOn !== 'bad' && failOn !== 'mixed') {
    throw new Error(`--fail-on must be bad or mixed, got "${failOn}"`);
  }
  const output = readOption(argv, '--output') ?? null;
  if (format === 'pdf' && !output) throw new Error('A PDF needs --output <file>');

  return {
    serverUrl: connection.serverUrl,
    apiKey: connection.apiKey,
    projects: (readOption(argv, '--project') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    period: normalizePeriod(readOption(argv, '--period') ?? '30d'),
    compare: readOption(argv, '--compare') ?? null,
    dashboard: dashboard as ReportArgs['dashboard'],
    branches: readOption(argv, '--branch') ?? null,
    environments: readOption(argv, '--environment') ?? null,
    selection: readOption(argv, '--selection') ?? null,
    lang,
    format: format as ReportArgs['format'],
    output,
    failOn,
  };
}

/** The preview request's query for these arguments, with project names already resolved to ids. */
export function reportQuery(args: ReportArgs, projectIds: number[], format: string): URLSearchParams {
  const q = new URLSearchParams({ dashboard: args.dashboard, format, period: args.period });
  if (projectIds.length > 0) q.set('projects', projectIds.join(','));
  if (args.compare) q.set('compare', args.compare);
  if (args.branches) q.set('branches', args.branches);
  if (args.environments) q.set('environments', args.environments);
  if (args.selection) q.set('sel', args.selection);
  if (args.lang) q.set('lang', args.lang);
  return q;
}

/** Whether a verdict tone trips `--fail-on`. */
export function failsOn(tone: Tone, failOn: Tone | null): boolean {
  if (!failOn) return false;
  return failOn === 'mixed' ? tone !== 'good' : tone === 'bad';
}

async function fetchReport(args: ReportArgs, query: URLSearchParams): Promise<Response> {
  const res = await fetch(`${args.serverUrl}/api/reports/preview?${query}`, {
    headers: args.apiKey ? { 'X-API-Key': args.apiKey } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Dashboard returned ${res.status}`);
  }
  return res;
}

export async function runQualityReport(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return EXIT_OK;
  }
  try {
    const args = parseReportArgs(argv, process.env, [process.cwd()]);
    const projectIds: number[] = [];
    for (const project of args.projects) {
      projectIds.push(await resolveProjectId({ serverUrl: args.serverUrl, apiKey: args.apiKey, project, key: '' }));
    }

    const res = await fetchReport(args, reportQuery(args, projectIds, args.format));
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (args.output) fs.writeFileSync(args.output, bytes);
    else process.stdout.write(bytes);

    if (!args.failOn) return EXIT_OK;
    const bundle =
      args.format === 'json'
        ? (JSON.parse(new TextDecoder().decode(bytes)) as { verdict: { tone: Tone } })
        : ((await (await fetchReport(args, reportQuery(args, projectIds, 'json'))).json()) as {
            verdict: { tone: Tone };
          });
    if (failsOn(bundle.verdict.tone, args.failOn)) {
      console.error(`piwi report: the verdict is ${bundle.verdict.tone}`);
      return EXIT_VERDICT;
    }
    return EXIT_OK;
  } catch (e) {
    console.error(`piwi report: ${(e as Error).message}`);
    return EXIT_ERROR;
  }
}
