import { resolve } from 'node:path';
import { loadNuxtConfig } from '@nuxt/kit';
import { describe, expect, test } from 'vitest';

const app = resolve(import.meta.dirname, '..');
const layer = resolve(app, '../../packages/run-ui');

describe('the window build', () => {
  test('is a single-page app on the shared run layer', async () => {
    const config = await loadNuxtConfig({ cwd: app });
    expect(config.ssr).toBe(false);
    expect(config._layers.map((l) => l.cwd)).toContain(layer);
    expect(config.modules).toEqual(expect.arrayContaining(['@nuxt/ui']));
  });
});
