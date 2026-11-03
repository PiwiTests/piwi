import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('zod in the browser', () => {
  test('parses an object without compiling code', async () => {
    vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
    await import('../../app/plugins/00.zod-jitless.client');
    const compiled: string[][] = [];
    const RealFunction = Function;
    vi.stubGlobal(
      'Function',
      new Proxy(RealFunction, {
        construct(target, args: string[]) {
          compiled.push(args);
          return Reflect.construct(target, args);
        },
      }),
    );
    const { z } = await import('zod');

    const schema = z.object({ id: z.number(), name: z.string() });
    for (let i = 0; i < 5; i++) expect(schema.parse({ id: i, name: 'run' })).toEqual({ id: i, name: 'run' });
    expect(compiled).toEqual([]);
  });

  test('its setting is the first plugin to run', () => {
    const plugins = readdirSync(new URL('../../app/plugins', import.meta.url)).sort();
    expect(plugins[0]).toBe('00.zod-jitless.client.ts');
  });
});
