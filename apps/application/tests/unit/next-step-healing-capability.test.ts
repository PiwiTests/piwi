import { describe, test, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

/**
 * The next step replaces a locator only where the project shows locator
 * healing, the rule its Locator fix section follows: against an in-memory
 * SQLite database, a locator failure whose healing reads the failure-time ARIA
 * snapshot, on both the execution and the cluster page.
 */

// The schema barrel picks PostgreSQL at import time when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { getTestRunCase } = await import('#shared/handlers/test-cases');
const { getFailureCluster } = await import('#shared/handlers/failure-clusters');
const { setInstanceDecisions, setProjectDecisions } = await import('#shared/handlers/capabilities');

type Step = { kind: string; primary: { label: string; action: string } } | null | undefined;

const ERROR =
  "TimeoutError: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Show modal' })\n\n    at tests/ui/modal.spec.ts:15:16";
const ARIA = '- document:\n  - main:\n    - heading "Modal"\n    - button "Open modal"';

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await db.insert(schema.projects).values({ id: 1, name: 'ui-components' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, title: 'Modal with large content scrolls', filePath: 'tests/ui/modal.spec.ts' },
    { id: 2, projectId: 1, title: 'Button renders', filePath: 'tests/ui/button.spec.ts' },
  ]);
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp-modal',
    signature: "waiting for getByRole('button', { name: 'Show modal' })",
    errorType: 'timeout',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
  });
  await db.insert(schema.testRunsCases).values({
    id: 10,
    testRunId: 1,
    testCaseId: 1,
    status: 'failed',
    error: ERROR,
    ariaSnapshot: ARIA,
    failureClusterId: 1,
  });
});

async function steps(): Promise<{ execution: Step; cluster: Step }> {
  const execution = ((await getTestRunCase(db as never, 10)) as { nextStep?: Step } | null)?.nextStep;
  const cluster = ((await getFailureCluster(db as never, 1)) as { nextStep?: Step } | null)?.nextStep;
  return { execution, cluster };
}

describe('the replace-locator step and the locator-healing capability', () => {
  test('a recommendation without an edit makes the locator the change to copy', async () => {
    const { execution, cluster } = await steps();
    for (const step of [execution, cluster]) {
      expect(step?.kind).toBe('replace-locator');
      expect(step?.primary).toMatchObject({ label: 'Copy locator', action: 'copy-locator' });
    }
  });

  test('declining the fixtures for the project hides healing, and the step with it', async () => {
    await setProjectDecisions(db as never, 1, { fixtures: 'declined' });
    const { execution, cluster } = await steps();
    expect(execution?.kind).not.toBe('replace-locator');
    expect(cluster?.kind).not.toBe('replace-locator');
  });

  test('an instance decline of locator healing holds unless the project enables it', async () => {
    await setInstanceDecisions(db as never, { 'locator-healing': 'declined' });
    expect((await steps()).execution?.kind).not.toBe('replace-locator');

    await setProjectDecisions(db as never, 1, { 'locator-healing': 'enabled' });
    expect((await steps()).execution?.kind).toBe('replace-locator');
  });

  test('captured locator snapshots keep healing active, so the step stays', async () => {
    await db.insert(schema.locatorSnapshots).values({
      testCaseId: 2,
      location: 'tests/ui/button.spec.ts:10:37',
      usedMethod: 'getByRole',
      usedArgs: JSON.stringify({ role: 'button', name: 'Primary' }),
      usedArgsFp: 'button-primary',
      elementAttrs: '{}',
      alternatives: '[]',
      lastSeenRunId: 1,
      lastSeenAt: new Date(),
    });
    await setProjectDecisions(db as never, 1, { fixtures: 'declined' });
    const { execution, cluster } = await steps();
    expect(execution?.kind).toBe('replace-locator');
    expect(cluster?.kind).toBe('replace-locator');
  });
});
