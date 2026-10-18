import { and, eq } from 'drizzle-orm';
import { runDeliveries } from '../database/schema';
import type { DbClient } from '../database';
import { createKeyedLock } from './keyed-lock';

/** A delivery key as a client generates it: a UUID, or any similar opaque token. */
const DELIVERY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** The delivery key a batch submission carries, or null when it carries none or an unusable one. */
export function readDeliveryKey(value: unknown): string | null {
  return typeof value === 'string' && DELIVERY_KEY.test(value) ? value : null;
}

/** What a repeated delivery answers: the run its first delivery went to. */
export interface RepeatedDelivery {
  success: true;
  runId: number;
  projectId: number;
  duplicate: true;
}

const deliveryLock = createKeyedLock<string>();

/**
 * Store a batch delivery of a run's results once per delivery key. Deliveries
 * of one project under one key run one at a time: the first stores the results
 * through `ingest` and records the run they went to, and every later one
 * answers with that run without calling `ingest`. A delivery whose `ingest`
 * throws records nothing, so sending it again stores the results. A delivery
 * with no key always stores them.
 */
export async function deliverOnce<T extends { runId: number }>(
  db: DbClient,
  projectId: number,
  deliveryKey: string | null,
  ingest: () => Promise<T>,
): Promise<T | RepeatedDelivery> {
  if (!deliveryKey) return ingest();
  return deliveryLock(`${projectId}\u0000${deliveryKey}`, async () => {
    const [delivered] = await db
      .select({ runId: runDeliveries.runId })
      .from(runDeliveries)
      .where(and(eq(runDeliveries.projectId, projectId), eq(runDeliveries.deliveryKey, deliveryKey)))
      .limit(1);
    if (delivered) return { success: true, runId: delivered.runId, projectId, duplicate: true };

    const result = await ingest();
    await db.insert(runDeliveries).values({ projectId, deliveryKey, runId: result.runId }).onConflictDoNothing();
    return result;
  });
}
