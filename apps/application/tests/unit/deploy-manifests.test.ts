import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error — plain .mjs script, no types to import
import { buildDeployManifests } from '../../scripts/generate-deploy-manifests.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const manifests: Record<string, string> = buildDeployManifests();

describe('deploy manifests', () => {
  test.each(Object.keys(manifests))('%s matches the generator', (relative) => {
    // Render and Fly read these from the repository, so they are committed
    // rather than gitignored — this is what keeps them from drifting.
    expect(readFileSync(join(repoRoot, relative), 'utf8'), `run: npm run app:generate:deploy`).toBe(
      manifests[relative],
    );
  });

  test('every manifest points at the same data mount and health endpoint', () => {
    for (const [relative, contents] of Object.entries(manifests)) {
      expect(contents, relative).toContain('/api/health');
      if (relative !== 'railway.json') expect(contents, relative).toContain('/app/.data');
    }
  });

  test('no generated secret is committed as a literal', () => {
    for (const [relative, contents] of Object.entries(manifests)) {
      expect(contents, relative).not.toMatch(/PIWI_(AUTH_SECRET|SECRET_KEY|SETUP_TOKEN)\s*[:=]\s*['"]?[0-9a-f]{16}/);
    }
  });

  test('every template has the platform generate a setup token or says to set one', () => {
    for (const [relative, contents] of Object.entries(manifests)) {
      if (relative !== 'railway.json') expect(contents, relative).toContain('PIWI_SETUP_TOKEN');
    }
  });
});
