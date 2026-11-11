import { and, eq } from 'drizzle-orm';
import { integrationActions, testManagementCases, testManagementCatalogReads } from '~~/server/database/schema';
import {
  readTestManagementBinding,
  writeTestManagementBinding,
} from '~~/server/utils/integrations/test-management/binding';
import { writeCreatedIssueLink } from '~~/server/utils/integrations/entity-links';
import { findFailedSync } from '~~/server/utils/integrations/test-management/sync-again';
import type { SyncActionPayload } from '#shared/integrations/test-management-sync';
import { lookupCatalogCases } from '#shared/handlers/test-management-cases';
import { testManagementKeyConfig, testManagementMappingSummary } from '#shared/handlers/test-management-summary';
import {
  TEST_MANAGEMENT_PROJECT_KEY,
  testManagementBindingProblem,
} from '#shared/integrations/test-management-binding';
import { CATALOG_LOOKUP_KEYS_MESSAGE, parseCatalogLookupKeys } from '#shared/integrations/test-management-mapping';
import type { TestManagementPickerOptions } from '#shared/integrations/test-management-picker';
import type { DrizzleDB } from '#shared/handlers/db';
import {
  DEMO_TEST_MANAGEMENT_CASES,
  DEMO_TEST_MANAGEMENT_CONNECTION_ID,
  DEMO_TEST_MANAGEMENT_FOLDERS,
  DEMO_TEST_MANAGEMENT_PROJECT_KEY,
  DEMO_TEST_MANAGEMENT_PROJECTS,
  DEMO_TEST_MANAGEMENT_STATUSES,
} from '#shared/demo/demo-test-management.mjs';
import { demoHttpError } from './http-error';
import { listDemoTestManagementConnections } from './integrations';

/**
 * The demo's test management binding: the stored binding and catalog are the seed's, in the browser's database, and the
 * tool behind them is the canned Zephyr Scale project of `shared/demo/demo-test-management.mjs`. Nothing calls out. The
 * reads are the server's own handlers; only what reaches the tool (the pickers, Refresh catalog) is answered here.
 */

export async function demoTestManagementSettings(db: DrizzleDB, projectId: number) {
  return {
    binding: await readTestManagementBinding(db as never, projectId),
    connections: listDemoTestManagementConnections(),
  };
}

export async function saveDemoTestManagement(db: DrizzleDB, projectId: number, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw demoHttpError(400, 'Invalid request body');
  const input = body as Record<string, unknown>;
  const connectionId = input.connectionId;
  if (connectionId !== null && connectionId !== undefined) {
    if (typeof connectionId !== 'number' || !Number.isInteger(connectionId) || connectionId <= 0) {
      throw demoHttpError(400, 'Invalid connection');
    }
    if (connectionId !== DEMO_TEST_MANAGEMENT_CONNECTION_ID) throw demoHttpError(400, 'Connection not found');
    const problem = testManagementBindingProblem(input);
    if (problem) throw demoHttpError(400, problem);
  }
  await writeTestManagementBinding(db as never, projectId, input);
  return demoTestManagementSettings(db, projectId);
}

/** What the pickers read from the canned tool: its projects, and with a project key its statuses and folders. */
export function demoTestManagementOptions(
  connectionId: number,
  projectKey: string | null,
): TestManagementPickerOptions {
  if (!Number.isInteger(connectionId) || connectionId <= 0) throw demoHttpError(400, 'Invalid connection');
  if (projectKey !== null && !TEST_MANAGEMENT_PROJECT_KEY.test(projectKey))
    throw demoHttpError(400, 'Invalid project key');
  if (connectionId !== DEMO_TEST_MANAGEMENT_CONNECTION_ID) throw demoHttpError(404, 'Connection not found');
  return {
    projects: DEMO_TEST_MANAGEMENT_PROJECTS.map((project) => ({ ...project })),
    statuses: projectKey ? DEMO_TEST_MANAGEMENT_STATUSES.map((status) => ({ ...status })) : [],
    folders: projectKey ? DEMO_TEST_MANAGEMENT_FOLDERS.map((folder) => ({ ...folder })) : [],
  };
}

/**
 * Reads the canned tool's catalog into the stored one: the cases of `SHOP`, and nothing for any other project, which the
 * canned tool has no cases for. Replaces the stored rows and records the read, as the server does.
 */
export async function refreshDemoTestManagementCatalog(db: DrizzleDB, projectId: number) {
  const binding = await readTestManagementBinding(db as never, projectId);
  if (binding.connectionId === null || binding.providerProjectKey === null) {
    throw demoHttpError(409, 'Bind this project to a test management project first');
  }
  const { connectionId, providerProjectKey } = binding;
  const fetchedAt = new Date();
  const cases = providerProjectKey === DEMO_TEST_MANAGEMENT_PROJECT_KEY ? DEMO_TEST_MANAGEMENT_CASES : [];
  await db.transaction(async (tx) => {
    await tx
      .delete(testManagementCases)
      .where(
        and(eq(testManagementCases.connectionId, connectionId), eq(testManagementCases.projectKey, providerProjectKey)),
      );
    if (cases.length > 0) {
      await tx.insert(testManagementCases).values(
        cases.map((c) => ({
          connectionId,
          projectKey: providerProjectKey,
          key: c.key,
          providerId: c.providerId,
          name: c.name,
          statusName: c.status,
          folder: c.folder,
          fetchedAt,
        })),
      );
    }
    await tx
      .insert(testManagementCatalogReads)
      .values({ connectionId, projectKey: providerProjectKey, fetchedAt })
      .onConflictDoUpdate({
        target: [testManagementCatalogReads.connectionId, testManagementCatalogReads.projectKey],
        set: { fetchedAt },
      });
  });
  return { size: cases.length, fetchedAt: fetchedAt.toISOString() };
}

export const demoTestManagementSummary = testManagementMappingSummary;
export const demoTestManagementKeyConfig = testManagementKeyConfig;

/** The stored catalog's cases among the `keys` query; the canned tool shows no address for a case. */
export async function demoTestManagementCases(db: DrizzleDB, projectId: number, rawKeys: unknown) {
  const keys = parseCatalogLookupKeys(rawKeys);
  if (!keys) throw demoHttpError(400, CATALOG_LOOKUP_KEYS_MESSAGE);
  return await lookupCatalogCases(db, projectId, keys, () => null);
}

/**
 * Send a run's failed results sync again, as the canned tool takes it: the sync is done, and the test run the canned tool
 * made is linked to the run. Nothing is looked up or called.
 */
export async function sendDemoRunSync(db: DrizzleDB, runId: number) {
  const action = await findFailedSync(db as never, runId);
  if (!action) throw demoHttpError(409, 'This run has no failed results sync');
  const payload = action.payload as SyncActionPayload;
  const runKey = `${payload.providerProjectKey}-R${runId}`;
  const result = { runKey, runUrl: '', sent: payload.results.length };
  await db.transaction(async (tx) => {
    await writeCreatedIssueLink(tx as never, {
      entityType: 'test_run',
      entityId: runId,
      connectionId: action.connectionId,
      createdBy: action.requestedBy ?? null,
      issue: {
        provider: 'zephyr-scale',
        url: '',
        key: runKey,
        externalId: null,
        title: payload.run.name,
        statusText: null,
        statusColor: null,
      },
    });
    await tx
      .update(integrationActions)
      .set({ status: 'done', result: result as never, error: null, finishedAt: new Date() })
      .where(eq(integrationActions.id, action.id));
  });
  return { status: 'done' as const, result };
}
