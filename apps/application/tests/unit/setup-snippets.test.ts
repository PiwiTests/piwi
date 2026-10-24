import { describe, test, expect } from 'vitest';
import { initCommand, normalizeProjectName, setupSnippets, type SetupChoices } from '../../app/utils/setup-snippets';
// The reporter's own `init` writers, from source.
import { fixturesContents, wrapPlaywrightConfig } from '../../../../packages/reporter/src/cli/configure';
import { parseInitArgs } from '../../../../packages/reporter/src/cli/init';

const WEB: SetupChoices = {
  projectName: 'checkout',
  serverUrl: 'https://piwi.example.com',
  preferDesktopApp: false,
  needsApiKey: true,
};
const DESKTOP_ONLY: SetupChoices = {
  projectName: 'checkout',
  serverUrl: null,
  preferDesktopApp: false,
  needsApiKey: false,
};

/** The config `init` writes into a fresh `defineConfig` export, for the same choices. */
function initWrites(choices: SetupChoices): string {
  const clean = `import { defineConfig } from '@playwright/test'\n\nexport default defineConfig({\n  // your Playwright config, unchanged\n})`;
  const args = parseInitArgs(initCommand(choices).split(' ').slice(3), {}, '/tmp/piwi-setup-snippets');
  return wrapPlaywrightConfig(clean, {
    serverUrl: args.serverUrl,
    projectName: args.projectName,
    desktopApp: (args.desktopApp as 'prefer' | null) ?? undefined,
  }).text;
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('setup snippets', () => {
  test.each([
    ['a web dashboard', WEB],
    ['a web dashboard, local runs to the desktop app', { ...WEB, preferDesktopApp: true }],
    ['the desktop app alone', DESKTOP_ONLY],
    [
      'a team server, local runs to the desktop app',
      { ...DESKTOP_ONLY, serverUrl: 'https://piwi.acme.dev', preferDesktopApp: true },
    ],
  ])('the wrapConfig config is what init writes, for %s', (_label, choices) => {
    expect(squash(setupSnippets(choices).config)).toBe(squash(initWrites(choices)));
  });

  test('the fixtures file is the one init creates', () => {
    expect(setupSnippets(WEB).fixtures).toBe(fixturesContents().trimEnd());
  });

  test('desktopApp is written only beside a server URL', () => {
    expect(setupSnippets({ ...WEB, preferDesktopApp: true }).config).toContain("desktopApp: 'prefer',");
    expect(initCommand({ ...WEB, preferDesktopApp: true })).toContain('--desktop-app prefer');
    expect(setupSnippets({ ...DESKTOP_ONLY, preferDesktopApp: true }).config).not.toContain('desktopApp');
    expect(initCommand(DESKTOP_ONLY)).toBe('npx @piwitests/reporter init --no-server-url --project checkout');
  });

  test('a project name with spaces stays one argument, and shell characters are dropped', () => {
    expect(normalizeProjectName('  ')).toBe('my-project');
    expect(normalizeProjectName('my "app" $HOME')).toBe('my app HOME');
    expect(initCommand({ ...WEB, projectName: 'Web shop' })).toContain('--project "Web shop"');
    expect(setupSnippets({ ...WEB, projectName: 'Web shop' }).config).toContain("projectName: 'Web shop',");
  });

  test('the agent prompt runs init with --json and never carries a key', () => {
    const prompt = setupSnippets(WEB).agentPrompt;
    expect(prompt).toContain(`${initCommand(WEB)} --json`);
    expect(prompt).toContain('tests/fixtures.ts');
    expect(prompt).toContain('PIWI_API_KEY');
    expect(prompt).not.toMatch(/pk_|pd_/);
    expect(setupSnippets(DESKTOP_ONLY).agentPrompt).toContain('the Piwi desktop app running on this machine');
    expect(setupSnippets(DESKTOP_ONLY).agentPrompt).not.toContain('PIWI_API_KEY');
  });

  test('every command is one line', () => {
    const snippets = setupSnippets(WEB);
    for (const command of [snippets.initCommand, snippets.installCommand, snippets.runCommand]) {
      expect(command).not.toContain('\n');
    }
  });
});
