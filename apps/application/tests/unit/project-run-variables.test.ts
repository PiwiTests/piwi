import { beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { commandWithRunVariables } from '../../shared/run-variables';
import { buildBisectScript, buildReproRecipe } from '../../shared/reproduce';

delete process.env.PIWI_DATABASE_URL;
const { getProject, updateProject, InvalidRunVariablesError } = await import('../../shared/handlers/projects');
const { readProjectRunVariables } = await import('../../shared/handlers/run-variables');

const TENANT = { name: 'TENANT', value: 'acme' };

describe('a project stores its run variables', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values({ id: 1, name: 'shop-acme' });
  });

  test('a new project has none', async () => {
    expect((await getProject(db as never, 1))?.runVariables).toEqual([]);
    expect(await readProjectRunVariables(db as never, 1)).toEqual([]);
  });

  test('they read back as saved, in their order', async () => {
    const saved = await updateProject(db as never, 1, { runVariables: [TENANT, { name: 'REGION', value: 'eu' }] });
    expect(saved.project.runVariables).toEqual([TENANT, { name: 'REGION', value: 'eu' }]);
    expect((await getProject(db as never, 1))?.runVariables).toEqual([TENANT, { name: 'REGION', value: 'eu' }]);
    expect(await readProjectRunVariables(db as never, 1)).toEqual([TENANT, { name: 'REGION', value: 'eu' }]);
  });

  test('a refused list is refused whole, naming each problem, and the stored ones stay', async () => {
    const refused = updateProject(db as never, 1, {
      runVariables: [
        { name: 'NODE_OPTIONS', value: '--require ./x.js' },
        { name: 'tenant', value: 'acme' },
      ],
    });
    await expect(refused).rejects.toBeInstanceOf(InvalidRunVariablesError);
    await expect(
      updateProject(db as never, 1, { runVariables: [{ name: 'PIWI_PROJECT_NAME', value: 'other' }] }),
    ).rejects.toThrow(/PIWI_PROJECT_NAME is not a variable a project can set/);
    await expect(updateProject(db as never, 1, { runVariables: [TENANT, TENANT] })).rejects.toThrow(/set twice/);
    await expect(updateProject(db as never, 1, { runVariables: 'TENANT=acme' })).rejects.toThrow(/must be a list/);
    expect(await readProjectRunVariables(db as never, 1)).toEqual([TENANT, { name: 'REGION', value: 'eu' }]);
  });

  test('leaving them out changes nothing, and null or [] removes them', async () => {
    await updateProject(db as never, 1, { label: 'Shop (acme)' });
    expect(await readProjectRunVariables(db as never, 1)).toHaveLength(2);
    await updateProject(db as never, 1, { runVariables: [] });
    expect(await readProjectRunVariables(db as never, 1)).toEqual([]);
    await updateProject(db as never, 1, { runVariables: [TENANT] });
    await updateProject(db as never, 1, { runVariables: null });
    expect(await readProjectRunVariables(db as never, 1)).toEqual([]);
  });

  test('a missing project reads as not found', async () => {
    expect(await readProjectRunVariables(db as never, 99)).toBeNull();
  });
});

describe('commandWithRunVariables', () => {
  test('starts a command with the variables, in bash and in PowerShell', () => {
    expect(commandWithRunVariables('npx playwright test a.spec.ts:3', [TENANT], 'bash')).toBe(
      'TENANT=acme npx playwright test a.spec.ts:3',
    );
    expect(commandWithRunVariables('npx playwright test a.spec.ts:3', [TENANT], 'powershell')).toBe(
      "$env:TENANT='acme'; npx playwright test a.spec.ts:3",
    );
  });

  test('sets them for each command of a chain in bash, and once in PowerShell', () => {
    const chain = 'npx playwright test a.spec.ts --project="chromium" && npx playwright test b.spec.ts -g "a && b"';
    expect(commandWithRunVariables(chain, [TENANT], 'bash')).toBe(
      'TENANT=acme npx playwright test a.spec.ts --project="chromium" && TENANT=acme npx playwright test b.spec.ts -g "a && b"',
    );
    expect(commandWithRunVariables(chain, [TENANT], 'powershell')).toBe(`$env:TENANT='acme'; ${chain}`);
  });

  test('leaves a command as it is without variables, and an empty one empty', () => {
    expect(commandWithRunVariables('npx playwright test', [], 'bash')).toBe('npx playwright test');
    expect(commandWithRunVariables('', [TENANT], 'bash')).toBe('');
  });
});

describe('the reproduce recipe and the bisect with run variables', () => {
  const cases = [{ filePath: 'tests/checkout.spec.ts', title: 'pays', line: 12, projectName: 'chromium' }];

  test('the test step starts with them in each shell', () => {
    const recipe = buildReproRecipe({
      commit: 'a'.repeat(40),
      playwrightVersion: '1.58.0',
      browserName: 'chromium',
      projectName: 'chromium',
      environment: null,
      baseUrl: null,
      cases,
      runVariables: [{ name: 'TENANT', value: 'acme corp' }],
    });
    const run = recipe.steps.find((step) => step.step === 'Run the failing test')!;
    expect(run.bash).toMatch(/^TENANT='acme corp' npx playwright test /);
    expect(run.powershell).toMatch(/^\$env:TENANT='acme corp'; npx playwright test /);
  });

  test('each bisect step runs with them, in each shell', () => {
    const bisect = buildBisectScript({
      good: 'a'.repeat(40),
      bad: 'b'.repeat(40),
      verifyCommand: 'npx playwright test tests/checkout.spec.ts:12',
      runVariables: [{ name: 'TENANT', value: 'acme corp' }],
    });
    expect(bisect.available).toBe(true);
    if (!bisect.available) return;
    expect(bisect.bash).toContain(
      `git bisect run env TENANT='acme corp' npx playwright test tests/checkout.spec.ts:12`,
    );
    // PowerShell sets them for the session first: git, and the sh it runs the command in, get them.
    expect(bisect.powershell.split('\n')[0]).toBe(`$env:TENANT='acme corp';`);
    expect(bisect.powershell).toContain('git bisect run npx playwright test tests/checkout.spec.ts:12');
  });

  test('without variables, the recipe and the bisect stay as they were', () => {
    const bisect = buildBisectScript({
      good: 'a'.repeat(40),
      bad: 'b'.repeat(40),
      verifyCommand: 'npx playwright test',
    });
    expect(bisect.available && bisect.bash).toContain('git bisect run npx playwright test');
  });
});
