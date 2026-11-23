/**
 * Client-side implementation of the /api/admin endpoints for demo mode.
 *
 * Thin wrapper that delegates to the shared handler.
 */

import { getDemoDb } from '../db.client';
import { getAdminStats } from '#shared/handlers/admin';
import { getStorageAnalysis } from '#shared/handlers/admin-storage';
import { getRunsInProgress, type InstanceActivity } from '#shared/handlers/admin-activity';

/** GET /api/admin/stats */
export async function apiGetAdminStats() {
  const stats = await getAdminStats(await getDemoDb());
  return {
    ...stats,
    storageSizeOnDisk: null,
    databaseLocation: 'In-browser database (demo)',
    storageLocation: 'In-browser storage (demo)',
  };
}

/** GET /api/admin/storage */
export async function apiGetStorageAnalysis() {
  const analysis = await getStorageAnalysis(await getDemoDb());
  return {
    ...analysis,
    storageSizeOnDisk: null,
    databaseLocation: 'In-browser database (demo)',
    storageLocation: 'In-browser storage (demo)',
  };
}

/**
 * GET /api/admin/activity: the demo's runs in progress. The in-browser demo has no server to restart, so it counts no
 * request, diagnosis, answer or stream.
 */
export async function apiGetAdminActivity(): Promise<InstanceActivity> {
  return {
    runsInProgress: await getRunsInProgress(await getDemoDb()),
    requestsInProgress: 0,
    diagnosesInProgress: 0,
    assistantAnswersInProgress: 0,
    openEventStreams: 0,
  };
}
