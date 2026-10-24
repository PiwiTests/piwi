import { quoteJsString } from '#shared/locator-chain';

/**
 * The snippets of the connect wizard, built from the choices it offers. Pure,
 * so `tests/unit/setup-snippets.test.ts` holds the config and the fixtures file
 * to what `npx @piwitests/reporter init` writes.
 */

export const DEFAULT_PROJECT_NAME = 'my-project';

export interface SetupChoices {
  /** The project the runs report under. */
  projectName: string;
  /** The dashboard results go to; `null` when the reporter finds the desktop app on its own. */
  serverUrl: string | null;
  /** Write `desktopApp: 'prefer'`: local runs go to the desktop app while it runs. */
  preferDesktopApp: boolean;
  /** The dashboard asks the reporter for an API key. */
  needsApiKey: boolean;
}

export interface SetupSnippets {
  initCommand: string;
  agentPrompt: string;
  installCommand: string;
  config: string;
  fixtures: string;
  specImport: string;
  runCommand: string;
  /** The reporter entry alone, for a config `wrapConfig` cannot wrap. */
  reporterEntryConfig: string;
}

/** The fixtures file `init` creates, and the path it creates it at. */
export const FIXTURES_FILE = 'tests/fixtures.ts';

/**
 * A project name as the wizard writes it into a shell command and a config:
 * trimmed, without the characters a shell would expand inside double quotes
 * (bash, PowerShell, cmd) or a quote would end, and the default name when
 * nothing is left.
 */
export function normalizeProjectName(raw: string): string {
  const name = raw.replace(/["'`$\\!%]/g, '').trim();
  return name || DEFAULT_PROJECT_NAME;
}

/**
 * A dashboard URL the wizard can write into a command and a config: an http(s)
 * address with none of the characters a shell or a quote would act on, without
 * its trailing slashes; `null` for anything else.
 */
export function normalizeServerUrl(raw: string): string | null {
  const url = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'`$\\!%<>|&;^]+$/.test(url) ? url : null;
}

/** A command-line argument, double-quoted when it holds anything but a plain word. */
function shellArg(value: string): string {
  return /^[\w.@/:-]+$/.test(value) ? value : `"${value}"`;
}

export function initCommand(choices: SetupChoices): string {
  const flags = choices.serverUrl ? [`--server-url ${shellArg(choices.serverUrl)}`] : ['--no-server-url'];
  flags.push(`--project ${shellArg(normalizeProjectName(choices.projectName))}`);
  if (choices.serverUrl && choices.preferDesktopApp) flags.push('--desktop-app prefer');
  return `npx @piwitests/reporter init ${flags.join(' ')}`;
}

/** The Piwi options `init` writes as `wrapConfig`'s second argument, one per line. */
function optionLines(choices: SetupChoices, indent: string): string {
  const lines: string[] = [];
  if (choices.serverUrl) lines.push(`serverUrl: ${quoteJsString(choices.serverUrl)},`);
  lines.push(`projectName: ${quoteJsString(normalizeProjectName(choices.projectName))},`);
  if (choices.serverUrl && choices.preferDesktopApp) lines.push(`desktopApp: 'prefer',`);
  return lines.map((line) => `${indent}${line}`).join('\n');
}

function wrappedConfig(choices: SetupChoices): string {
  return `import { defineConfig } from '@playwright/test'
import { wrapConfig } from '@piwitests/reporter'

export default wrapConfig(
  defineConfig({
    // your Playwright config, unchanged
  }),
  {
${optionLines(choices, '    ')}
  },
)`;
}

function reporterEntryConfig(choices: SetupChoices): string {
  return `import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [
    ['list'],
    ['@piwitests/reporter', {
${optionLines(choices, '      ')}
    }],
  ],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})`;
}

const FIXTURES = `import { test as base, expect } from '@playwright/test'
import { piwiFixtures } from '@piwitests/reporter'

export const test = base.extend(piwiFixtures)
export { expect }`;

const SPEC_IMPORT = `import { test, expect } from './fixtures'`;

/**
 * The prompt for a coding agent: run `init`, finish what it leaves manual, and
 * switch the specs to the fixtures, which no command can do safely. It never
 * carries an API key.
 */
function agentPrompt(choices: SetupChoices): string {
  const target = choices.serverUrl
    ? `the Piwi dashboard at ${choices.serverUrl}`
    : 'the Piwi desktop app running on this machine';
  const lines = [
    `Connect this repository's Playwright tests to ${target}.`,
    '',
    `1. From the Playwright project's root, run \`${initCommand(choices)} --json\` and read the JSON it prints.`,
    '2. Finish every step it reports as "manual": each one carries the exact change to make.',
    `3. Make every spec import \`test\` and \`expect\` from the fixtures file it created (${FIXTURES_FILE}, or tests/fixtures.js in a JavaScript project) instead of \`@playwright/test\`. If the suite already builds its own \`test\` with \`test.extend\`, add \`piwiFixtures\` to that one instead of creating a second.`,
    choices.needsApiKey
      ? '4. Once I confirm PIWI_API_KEY is set, run `npx playwright test` and give me the `View run:` link it prints at the end.'
      : '4. Run `npx playwright test` and give me the `View run:` link it prints at the end.',
  ];
  if (choices.needsApiKey) {
    lines.push(
      '',
      'The dashboard needs an API key: never create one or write one into a file. I set PIWI_API_KEY myself, in the .env beside the Playwright config and in the CI secrets.',
    );
  }
  return lines.join('\n');
}

export function setupSnippets(choices: SetupChoices): SetupSnippets {
  return {
    initCommand: initCommand(choices),
    agentPrompt: agentPrompt(choices),
    installCommand: 'npm install --save-dev @piwitests/reporter',
    config: wrappedConfig(choices),
    fixtures: FIXTURES,
    specImport: SPEC_IMPORT,
    runCommand: 'npx playwright test',
    reporterEntryConfig: reporterEntryConfig(choices),
  };
}
