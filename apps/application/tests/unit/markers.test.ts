import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { getMarkerCategory, MARKER_CATEGORY_IDS } from '../../shared/marker-categories';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set;
// clear it before importing the handler (which imports the barrel).
delete process.env.PIWI_DATABASE_URL;
const { createMarker, updateMarker, deleteMarker, listProjectMarkers, syncAutoMarkersForRun } =
  await import('../../shared/handlers/markers');

let db: ReturnType<typeof drizzle<typeof schema>>;

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60 * 1000);

async function seedRun(
  id: number,
  opts: { environment?: string | null; playwrightVersion?: string; reporterVersion?: string; startTime: Date },
) {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: opts.startTime,
    environment: opts.environment ?? null,
    playwrightVersion: opts.playwrightVersion,
    reporterVersion: opts.reporterVersion,
  });
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'marker-project' });
  delete process.env.PIWI_AUTO_MARKERS;
});

describe('marker categories', () => {
  test('resolves known categories and falls back to the generic event', () => {
    expect(getMarkerCategory('deploy').label).toBe('Deploy');
    expect(getMarkerCategory('incident').color).toBe('error');
    // Unknown / empty → default "event".
    expect(getMarkerCategory('nope').id).toBe('event');
    expect(getMarkerCategory(null).id).toBe('event');
  });

  test('every category exposes a hex color for the chart lines', () => {
    for (const id of MARKER_CATEGORY_IDS) {
      expect(getMarkerCategory(id).hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('marker CRUD', () => {
  test('create normalizes an unknown category to "event" and lists ordered by time', async () => {
    await createMarker(db, 1, { label: 'Later', occurredAt: at(1), category: 'deploy' });
    const { marker } = await createMarker(db, 1, { label: 'Earlier', occurredAt: at(10), category: 'bogus' });
    expect(marker.category).toBe('event');
    expect(marker.source).toBe('manual');

    const { markers } = await listProjectMarkers(db, 1);
    expect(markers.map((m) => m.label)).toEqual(['Earlier', 'Later']);
  });

  test('update changes fields; delete removes the row', async () => {
    const { marker } = await createMarker(db, 1, { label: 'Original', occurredAt: at(5) });
    const { marker: updated } = await updateMarker(db, marker.id, { label: 'Renamed', environment: 'staging' });
    expect(updated.label).toBe('Renamed');
    expect(updated.environment).toBe('staging');

    await deleteMarker(db, marker.id);
    const { markers } = await listProjectMarkers(db, 1);
    expect(markers).toHaveLength(0);
  });

  test('update/delete on a missing marker throws not-found', async () => {
    await expect(updateMarker(db, 999, { label: 'x' })).rejects.toThrow('Marker not found');
    await expect(deleteMarker(db, 999)).rejects.toThrow('Marker not found');
  });
});

describe('syncAutoMarkersForRun', () => {
  test('creates one marker when the Playwright version changes from the previous run', async () => {
    await seedRun(1, { startTime: at(60), playwrightVersion: '1.49.0', reporterVersion: '1.0.0' });
    await seedRun(2, { startTime: at(30), playwrightVersion: '1.50.0', reporterVersion: '1.0.0' });

    await syncAutoMarkersForRun(db, 2);
    const { markers } = await listProjectMarkers(db, 1);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.source).toBe('auto');
    expect(markers[0]!.category).toBe('config');
    expect(markers[0]!.label).toContain('Playwright 1.49.0 → 1.50.0');
    expect(markers[0]!.runId).toBe(2);
  });

  test('is idempotent — re-running does not create a duplicate', async () => {
    await seedRun(1, { startTime: at(60), reporterVersion: '1.0.0' });
    await seedRun(2, { startTime: at(30), reporterVersion: '2.0.0' });

    await syncAutoMarkersForRun(db, 2);
    await syncAutoMarkersForRun(db, 2);
    const { markers } = await listProjectMarkers(db, 1);
    expect(markers).toHaveLength(1);
  });

  test('creates nothing when versions are unchanged', async () => {
    await seedRun(1, { startTime: at(60), playwrightVersion: '1.50.0', reporterVersion: '1.0.0' });
    await seedRun(2, { startTime: at(30), playwrightVersion: '1.50.0', reporterVersion: '1.0.0' });

    await syncAutoMarkersForRun(db, 2);
    const { markers } = await listProjectMarkers(db, 1);
    expect(markers).toHaveLength(0);
  });

  test('compares within the same environment lineage', async () => {
    // prod runs keep 1.50; staging bumps to 1.51 — only the staging run marks.
    await seedRun(1, { startTime: at(90), environment: 'production', playwrightVersion: '1.50.0' });
    await seedRun(2, { startTime: at(60), environment: 'staging', playwrightVersion: '1.50.0' });
    await seedRun(3, { startTime: at(30), environment: 'staging', playwrightVersion: '1.51.0' });

    await syncAutoMarkersForRun(db, 3);
    const { markers } = await listProjectMarkers(db, 1);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.environment).toBe('staging');
  });

  test('respects PIWI_AUTO_MARKERS=false', async () => {
    process.env.PIWI_AUTO_MARKERS = 'false';
    await seedRun(1, { startTime: at(60), reporterVersion: '1.0.0' });
    await seedRun(2, { startTime: at(30), reporterVersion: '2.0.0' });

    await syncAutoMarkersForRun(db, 2);
    const { markers } = await listProjectMarkers(db, 1);
    expect(markers).toHaveLength(0);
  });
});
