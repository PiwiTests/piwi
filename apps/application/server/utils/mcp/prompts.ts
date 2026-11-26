/**
 * MCP prompt handlers — the behavior behind the catalog in `shared/mcp-prompts.ts`.
 *
 * A prompt returns messages the client drops into the conversation. The value
 * of serving these from the server (rather than a static template the user
 * pastes) is that they are filled in with facts only the dashboard knows: its
 * own public URL, whether authentication is required, and the projects that
 * already exist. The message-building is a pure function so it is unit-tested
 * without a database; the async wrapper only fetches the project list.
 */
import { getProjectMenu } from '#shared/handlers/projects';
import { MCP_PROMPT_DEFS, SKILL_PROMPTS } from '#shared/mcp-prompts';
import type { McpPromptName } from '#shared/mcp-prompts';
import type { McpContext } from './tools';
import type { DbClient } from '../../database';

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

const PROMPT_NAMES = new Set<string>(MCP_PROMPT_DEFS.map((p) => p.name));

export function isKnownPrompt(name: string): name is McpPromptName {
  return PROMPT_NAMES.has(name);
}

export interface SetupPiwiInput {
  /** Public base URL of this dashboard, e.g. `https://piwi.example.com`. */
  baseUrl: string;
  /** Whether the dashboard requires an API key for reporting. */
  authEnabled: boolean;
  /** Project name the caller asked for, if any. */
  projectName?: string | null;
  /** Names of projects that already exist on this dashboard (scoped to the caller). */
  existingProjects: string[];
}

/** Guidance for choosing the project name, given what the caller supplied and what exists. */
function projectNameGuidance(projectName: string | null | undefined, existing: string[]): string {
  if (projectName) return `Report under the project "${projectName}".`;
  if (existing.length) {
    const sample = existing.slice(0, 20).join(', ');
    return (
      `Choose the project name: if this repository already reports to one of the existing projects ` +
      `(${sample}), reuse that exact name; otherwise derive one from the repository's package.json ` +
      `"name" or its folder. Replace <project-name> in the command with your choice.`
    );
  }
  return (
    `Derive the project name from the repository's package.json "name" or its folder — this will be ` +
    `the first project on the dashboard. Replace <project-name> in the command with it.`
  );
}

function authGuidance(authEnabled: boolean): string {
  if (authEnabled) {
    return (
      'This dashboard **requires authentication**, so reporting needs an API key. Create one in the ' +
      'dashboard UI (Settings → Account → API keys; keys start with `pd_`), add it to `.env` as ' +
      '`PIWI_API_KEY=pd_...`, and keep `.env` out of git. In CI, pass it as the `PIWI_API_KEY` secret. ' +
      'Never hardcode the key in `playwright.config`. The key acts with the roles of its owner: uploading runs needs ' +
      'the Uploader, Maintainer or Project admin role on the project, held on all projects when the first run ' +
      'creates it.'
    );
  }
  return 'This dashboard does **not** require authentication, so runs need no API key.';
}

/** Build the `setup_piwi` prompt messages. Pure — every input is already resolved. */
export function buildSetupPiwiMessages(input: SetupPiwiInput): PromptResult {
  const { baseUrl, authEnabled } = input;
  const projectArg = input.projectName ? input.projectName : '<project-name>';
  const existing = input.existingProjects.length
    ? input.existingProjects.slice(0, 20).join(', ') +
      (input.existingProjects.length > 20 ? `, … (${input.existingProjects.length} total)` : '')
    : 'none yet';

  const text = [
    `Set up this Playwright project to report its test results to the Piwi instance at ${baseUrl}.`,
    '',
    'Facts about this dashboard (already resolved — do not ask the user for them):',
    `- URL: ${baseUrl}`,
    `- Authentication: ${authEnabled ? 'required' : 'not required'}`,
    `- Projects that already exist: ${existing}`,
    '',
    'Steps:',
    '',
    '1. From the project root, run the setup command:',
    '',
    `   npx @piwitests/reporter init --server-url ${baseUrl} --project ${projectArg}`,
    '',
    '   It installs `@piwitests/reporter`, wraps `defineConfig(...)` with `wrapConfig(...)`, creates',
    '   `tests/fixtures.ts`, and records PIWI_* settings in `.env.example`. Every step is idempotent, so it is',
    '   safe to re-run. Add `--json` to get a machine-readable plan and finish any step it reports as `manual`',
    "   using the exact change in that step's `detail`.",
    `   ${projectNameGuidance(input.projectName, input.existingProjects)}`,
    '',
    `2. ${authGuidance(authEnabled)}`,
    '',
    '3. Rewire the specs: in each spec, import `test` (and `expect`) from your fixtures file instead of',
    '   `@playwright/test`, so the capture fixtures (locator healing, slow endpoints, Web Vitals, console,',
    '   failure-time ARIA) apply. A spec left on the direct import still runs and reports — it just is not captured.',
    '',
    '4. Verify a run lands: run `npx playwright test` (one spec is enough) and confirm the run appears at',
    `   ${baseUrl}. For a deterministic check, set PIWI_OUTPUT_FILE=piwi-run.json when running and read \`runUrl\``,
    '   from that file afterward — its presence proves the upload.',
    '',
    'Report what you changed, the run URL you verified, and anything still to do. Once results are flowing, the',
    'Piwi MCP tools (list_recent_activity, explain_failure, get_locator_healing, list_flaky_tests, …) let you',
    'investigate failures and propose fixes from the same evidence the dashboard shows.',
  ].join('\n');

  return {
    description: `Set up Piwi reporting for a Playwright project, targeting ${baseUrl}`,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

export interface ResolvePromptArgs {
  db: DbClient;
  ctx: McpContext;
  baseUrl: string;
  authEnabled: boolean;
  args: Record<string, string>;
  /** The version of this server, which the bundled skills ship with. */
  version: string;
}

/** Server-asset mount of the workflow skills (nuxt.config.ts). */
const SKILLS_STORAGE = 'assets:piwi-skills';

/** A skill's front matter and Markdown body. */
export function splitSkill(markdown: string): { description: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { description: null, body: markdown.trim() };
  const line = match[1]!.split(/\r?\n/).find((l) => l.startsWith('description:'));
  return {
    description: line ? line.slice('description:'.length).trim() : null,
    body: markdown.slice(match[0].length).trim(),
  };
}

/** Build a workflow prompt from its skill's `SKILL.md`. Pure. */
export function buildSkillPromptMessages(input: {
  skill: string;
  markdown: string;
  version: string;
  focus?: string | null;
}): PromptResult {
  const { description, body } = splitSkill(input.markdown);
  const focus = input.focus?.trim();
  const text = [
    `Follow the Piwi workflow below (the \`${input.skill}\` skill, as shipped with Piwi ${input.version}), using this server's Piwi MCP tools.`,
    ...(focus ? ['', `Work on: ${focus}`] : []),
    '',
    body,
  ].join('\n');
  return {
    description: description ?? `The ${input.skill} workflow`,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

/** A skill's bundled `SKILL.md`, or null when this build carries none. */
export async function bundledSkill(skill: string): Promise<string | null> {
  try {
    const raw = await useStorage(SKILLS_STORAGE).getItemRaw(`${skill}:SKILL.md`);
    if (typeof raw === 'string') return raw;
    return raw instanceof Uint8Array ? new TextDecoder().decode(raw) : null;
  } catch {
    return null;
  }
}

/** Resolve a prompt by name into its messages, or null when the name is unknown. */
export async function getPrompt(name: string, opts: ResolvePromptArgs): Promise<PromptResult | null> {
  if (name === 'setup_piwi') {
    const menu = await getProjectMenu(opts.db, opts.ctx.scope);
    return buildSetupPiwiMessages({
      baseUrl: opts.baseUrl,
      authEnabled: opts.authEnabled,
      projectName: opts.args.projectName ?? null,
      existingProjects: menu.map((m) => m.name),
    });
  }
  const skill = SKILL_PROMPTS.get(name);
  if (skill) {
    const markdown = await bundledSkill(skill);
    if (!markdown) {
      throw new Error(
        `This server was built without its workflow skills; install them with: npx @piwitests/reporter skills add ${skill}`,
      );
    }
    return buildSkillPromptMessages({ skill, markdown, version: opts.version, focus: opts.args.focus ?? null });
  }
  return null;
}
