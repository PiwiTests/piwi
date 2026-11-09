import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadNuxtConfig } from '@nuxt/kit';
import { afterAll, describe, expect, test } from 'vitest';

const layer = resolve(import.meta.dirname, '..');
const host = mkdtempSync(join(tmpdir(), 'run-ui-host-'));
writeFileSync(join(host, 'nuxt.config.ts'), 'export default defineNuxtConfig({});\n');

afterAll(() => rmSync(host, { recursive: true, force: true }));

describe('the layer as a host extends it', () => {
  // The dashboard renders on the server; Piwi Runner's window is a single-page app.
  test.each([
    ['with a server render', undefined],
    ['as a single-page app', false],
  ])('loads %s', async (_name, ssr) => {
    const config = await loadNuxtConfig({
      cwd: host,
      overrides: { extends: [layer], ...(ssr === undefined ? {} : { ssr }) },
    });
    expect(config._layers.map((l) => l.cwd)).toContain(layer);
    expect(config.ssr).toBe(ssr ?? true);
    expect(config.build.transpile).toEqual(expect.arrayContaining(['@piwitests/editor', '@piwitests/run-ui']));
  });
});
