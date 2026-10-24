import { describe, it, expect } from 'vitest';
import { ensureGitignoreEntry, fixturesContents, upsertEnvKeys, wrapPlaywrightConfig } from '../src/cli/configure.js';

const CLEAN_CONFIG = `import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  use: {
    trace: 'retain-on-failure',
  },
})
`;

describe('wrapPlaywrightConfig', () => {
  it('wraps a plain defineConfig export and adds the import', () => {
    const edit = wrapPlaywrightConfig(CLEAN_CONFIG, { serverUrl: 'http://localhost:3000', projectName: 'checkout' });
    expect(edit.status).toBe('updated');
    expect(edit.text).toContain("import { wrapConfig } from '@piwitests/reporter'");
    expect(edit.text).toContain('export default wrapConfig(');
    expect(edit.text).toContain('defineConfig({');
    expect(edit.text).toContain("serverUrl: 'http://localhost:3000',");
    expect(edit.text).toContain("projectName: 'checkout',");
    // The original Playwright import survives.
    expect(edit.text).toContain("import { defineConfig } from '@playwright/test'");
    // The reporter import lands next to the existing imports, above the export.
    expect(edit.text).toMatch(
      /import \{ defineConfig \} from '@playwright\/test'\nimport \{ wrapConfig \} from '@piwitests\/reporter'/,
    );
    expect(edit.text.indexOf('wrapConfig }')).toBeLessThan(edit.text.indexOf('export default'));
  });

  it('produces valid, balanced output for a config that itself contains parens and strings', () => {
    const tricky = `import { defineConfig } from '@playwright/test'

export default defineConfig({
  webServer: { command: 'node server.js', url: 'http://localhost:3000/(health)' },
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000' },
})
`;
    const edit = wrapPlaywrightConfig(tricky, { serverUrl: 'http://localhost:3000', projectName: 'app' });
    expect(edit.status).toBe('updated');
    // Every open paren still has a close paren.
    const opens = (edit.text.match(/\(/g) ?? []).length;
    const closes = (edit.text.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(edit.text).toContain('wrapConfig(');
  });

  it('writes desktopApp when it is given', () => {
    const edit = wrapPlaywrightConfig(CLEAN_CONFIG, {
      serverUrl: 'https://piwi.example.com',
      projectName: 'checkout',
      desktopApp: 'prefer',
    });
    expect(edit.text).toContain(
      "serverUrl: 'https://piwi.example.com',\n    projectName: 'checkout',\n    desktopApp: 'prefer',",
    );
    expect(wrapPlaywrightConfig(CLEAN_CONFIG, { projectName: 'checkout' }).text).not.toContain('desktopApp');
  });

  it('omits serverUrl from the literal when it is not provided', () => {
    const edit = wrapPlaywrightConfig(CLEAN_CONFIG, { projectName: 'checkout' });
    expect(edit.status).toBe('updated');
    expect(edit.text).not.toContain('serverUrl:');
    expect(edit.text).toContain("projectName: 'checkout',");
  });

  it('is idempotent — a config that already names the reporter is left alone', () => {
    const already = wrapPlaywrightConfig(CLEAN_CONFIG, { projectName: 'checkout' }).text;
    const second = wrapPlaywrightConfig(already, { projectName: 'checkout' });
    expect(second.status).toBe('already');
    expect(second.text).toBe(already);
  });

  it('reports manual (never mangles) when there is no defineConfig default export', () => {
    const odd = `import { chromium } from '@playwright/test'\nexport default { use: {} }\n`;
    const edit = wrapPlaywrightConfig(odd, { projectName: 'x' });
    expect(edit.status).toBe('manual');
    expect(edit.text).toBe(odd);
    expect(edit.detail).toMatch(/wrapConfig/);
  });

  it('escapes a quote in the project name so the literal stays valid', () => {
    const edit = wrapPlaywrightConfig(CLEAN_CONFIG, { projectName: "o'brien" });
    expect(edit.text).toContain("projectName: 'o\\'brien',");
  });
});

describe('fixturesContents', () => {
  it('extends the base test with the Piwi fixtures', () => {
    const contents = fixturesContents();
    expect(contents).toContain("import { piwiFixtures } from '@piwitests/reporter'");
    expect(contents).toContain('export const test = base.extend(piwiFixtures)');
    expect(contents).toContain('export { expect }');
  });
});

describe('upsertEnvKeys', () => {
  it('adds keys that are absent and preserves a trailing newline', () => {
    const { text, added } = upsertEnvKeys('', [
      ['PIWI_DASHBOARD_URL', 'http://localhost:3000'],
      ['PIWI_API_KEY', ''],
    ]);
    expect(added).toEqual(['PIWI_DASHBOARD_URL', 'PIWI_API_KEY']);
    expect(text).toBe('PIWI_DASHBOARD_URL=http://localhost:3000\nPIWI_API_KEY=\n');
  });

  it('never overwrites a key the user already set', () => {
    const existing = 'PIWI_API_KEY=pd_existing\n';
    const { text, added } = upsertEnvKeys(existing, [['PIWI_API_KEY', 'pd_new']]);
    expect(added).toEqual([]);
    expect(text).toBe(existing);
  });

  it('appends a newline before adding when the file lacks one', () => {
    const { text } = upsertEnvKeys('EXISTING=1', [['PIWI_DASHBOARD_URL', 'http://x']]);
    expect(text).toBe('EXISTING=1\nPIWI_DASHBOARD_URL=http://x\n');
  });
});

describe('ensureGitignoreEntry', () => {
  it('adds .env when missing', () => {
    const { text, added } = ensureGitignoreEntry('node_modules\n');
    expect(added).toBe(true);
    expect(text).toBe('node_modules\n.env\n');
  });

  it('does nothing when .env is already ignored', () => {
    const { text, added } = ensureGitignoreEntry('node_modules\n.env\n');
    expect(added).toBe(false);
    expect(text).toBe('node_modules\n.env\n');
  });
});
