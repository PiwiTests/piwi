/**
 * `piwi ai` — manage the committed natural-language artifacts.
 *
 *   piwi ai check   read-only hygiene scan, exit-code gated for CI
 *   piwi ai resolve author missing entries (requires a configured authoring model)
 *   piwi ai prune   delete orphaned/dormant entries (phase 2)
 *
 * Only `check` runs offline; `resolve`/`prune` are surfaced here so the command
 * shape is stable, and report clearly when their engine is not wired in a build.
 */
import * as path from 'node:path';
import { checkAiTree, hasBlockingFindings, type CheckFinding } from '../internal/ai/check.js';
import { DEFAULT_AI_DIR } from '../internal/ai/keys.js';
import { spawnPlaywright } from '../internal/support/playwright-spawn.js';

const EXIT_OK = 0; // scan clean / help
const EXIT_ISSUES = 1; // hygiene issues found (gates CI)
const EXIT_ERROR = 2; // bad args / command not available

const USAGE = `
Usage: piwi ai <command> [options]

Commands:
  check    Scan committed AI-step entries for orphans, non-canonical files and
           duplicate templates. Read-only; exits 1 when issues are found.
  resolve  Author missing entries by running the suite in resolve mode against
           the configured authoring server (forces --workers=1).
  prune    Delete orphaned/dormant entries.

Options (check):
  --dir <name>   Entry directory name per spec        (env PIWI_AI_DIR, default ${DEFAULT_AI_DIR})
  --cwd <path>   Root to scan                          (default: current directory)
  --json         Emit findings as JSON

Options (resolve):
  --grep <re>       Only author entries for matching tests
  --project <name>  Author under one Playwright project (a resolve profile)
  --env K=V         Extra env for the run (repeatable — flags/viewport profiles)
  --update-ai       Re-author entries that already exist
                    (needs PIWI_DASHBOARD_URL / PIWI_API_KEY for the server)

Exit codes:
  0  clean (or --help)
  1  hygiene issues found
  2  bad arguments / command unavailable
`.trim();

/** Read a `--flag value` / `--flag=value` option without swallowing the next flag. */
function readOption(argv: string[], name: string): string | undefined {
  const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

/** Collect every value of a repeatable `--flag value` / `--flag=value` option. */
function readAll(argv: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith(`${name}=`)) values.push(argv[i].slice(name.length + 1));
    else if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith('--')) values.push(argv[++i]);
  }
  return values;
}

function formatFinding(finding: CheckFinding): string {
  const mark = finding.severity === 'error' ? '✖' : '⚠';
  return `${mark} ${finding.file}\n    ${finding.kind}: ${finding.message}`;
}

/** `piwi ai check` — scan and gate. */
export function runCheck(argv: string[], env: NodeJS.ProcessEnv): number {
  const root = path.resolve(readOption(argv, '--cwd') ?? process.cwd());
  const dir = readOption(argv, '--dir') ?? env.PIWI_AI_DIR ?? DEFAULT_AI_DIR;

  let findings: CheckFinding[];
  try {
    findings = checkAiTree(root, { dir });
  } catch (error) {
    console.error(`piwi ai check: ${(error as Error).message}`);
    return EXIT_ERROR;
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ findings }, null, 2));
  } else if (findings.length === 0) {
    console.log('piwi ai check: no issues found.');
  } else {
    for (const finding of findings) console.log(formatFinding(finding));
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.length - errors;
    console.log(`\n${errors} error(s), ${warnings} warning(s).`);
  }

  return hasBlockingFindings(findings) ? EXIT_ISSUES : EXIT_OK;
}

/** The `playwright test` arguments and environment of a `resolve` run (pure, for testing). */
export interface ResolveInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Build the resolve-mode `playwright test` arguments and environment from CLI args. */
export function buildResolveInvocation(argv: string[], env: NodeJS.ProcessEnv): ResolveInvocation {
  const args: string[] = [];
  const grep = readOption(argv, '--grep');
  if (grep) args.push('--grep', grep);
  const project = readOption(argv, '--project');
  if (project) args.push('--project', project);
  // Authoring is race-free by construction: one worker, first-writer-wins.
  args.push('--workers=1');

  const childEnv: NodeJS.ProcessEnv = { ...env, PIWI_AI: 'resolve' };
  if (argv.includes('--update-ai')) childEnv.PIWI_AI_UPDATE = 'true';
  for (const pair of readAll(argv, '--env')) {
    const eq = pair.indexOf('=');
    if (eq > 0) childEnv[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { args, env: childEnv };
}

/** `piwi ai resolve` — run the suite in resolve mode so misses get authored + committed. */
function runResolve(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (!env.PIWI_DASHBOARD_URL) {
    console.error('piwi ai resolve: set PIWI_DASHBOARD_URL (the authoring server) before resolving.');
    return Promise.resolve(EXIT_ERROR);
  }
  const invocation = buildResolveInvocation(argv, env);
  return spawnPlaywright(invocation.args, invocation.env, { command: 'piwi ai resolve' });
}

/** Dispatch a `piwi ai` subcommand. */
export async function runAi(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [sub, ...rest] = argv;

  if (sub === undefined || sub === '-h' || sub === '--help') {
    console.log(USAGE);
    return EXIT_OK;
  }

  switch (sub) {
    case 'check':
      return runCheck(rest, env);
    case 'resolve':
      return runResolve(rest, env);
    case 'prune':
      console.error(
        'piwi ai prune: not available in this build yet. `piwi ai check` lists orphaned entries: delete their files by hand, and re-author a non-canonical one with `piwi ai resolve --update-ai`.',
      );
      return EXIT_ERROR;
    default:
      console.error(`piwi ai: unknown command "${sub}"\n`);
      console.error(USAGE);
      return EXIT_ERROR;
  }
}
