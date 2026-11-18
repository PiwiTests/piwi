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
  opts: {
    environment?: string | null;
    environmentId?: number | null;
    playwrightVersion?: string;
    reporterVersion?: string;
    startTime: Date;
  },
) {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    startTime: opts.startTime,
    environment: opts.environment ?? null,
    environmentId: opts.environmentId ?? null,
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

  test('a marker names its environment by id, listed with its name, and a deploy keeps its commit', async () => {
    const [staging] = await db
      .insert(schema.environments)
      .values({ projectId: 1, key: 'staging', keyFold: 'staging', name: 'Staging', aliases: ['stg'] })
      .returning();
    await createMarker(db, 1, {
      label: 'Deploy 4.2',
      occurredAt: at(5),
      category: 'deploy',
      environment: 'STG',
      commit: ' 3F9C2A1 ',
    });
    await createMarker(db, 1, { label: 'Everywhere', occurredAt: at(4) });
    const { markers } = await listProjectMarkers(db, 1);
    expect(markers.map((m) => [m.environment, m.environmentId, m.environmentName, m.commit])).toEqual([
      ['STG', staging!.id, 'Staging', '3f9c2a1'],
      [null, null, null, null],
    ]);
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

  test('follows the environment the runs resolved to, whatever label they reported, and writes it', async () => {
    const [staging] = await db
      .insert(schema.environments)
      .values({ projectId: 1, key: 'staging', keyFold: 'staging', name: 'Staging', aliases: ['stg'] })
      .returning();
    await seedRun(1, {
      startTime: at(90),
      environment: 'staging',
      environmentId: staging!.id,
      playwrightVersion: '1.50.0',
    });
    // Another environment in between, with the same version as the new run: not this lineage.
    await seedRun(2, { startTime: at(60), environment: 'production', playwrightVersion: '1.51.0' });
    await seedRun(3, {
      startTime: at(30),
      environment: 'stg',
      environmentId: staging!.id,
      playwrightVersion: '1.51.0',
    });

    await syncAutoMarkersForRun(db, 3);
    const { markers } = await listProjectMarkers(db, 1);
    expect(markers.map((m) => [m.label, m.environment, m.environmentId])).toEqual([
      ['Playwright 1.50.0 → 1.51.0', 'stg', staging!.id],
    ]);
  });

  test('reads labels ignoring case for runs with no environment', async () => {
    await seedRun(1, { startTime: at(60), environment: 'QA', reporterVersion: '1.0.0' });
    await seedRun(2, { startTime: at(30), environment: 'qa', reporterVersion: '2.0.0' });
    await syncAutoMarkersForRun(db, 2);
    expect((await listProjectMarkers(db, 1)).markers).toHaveLength(1);
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

describe('which runs and filters a marker applies to', () => {
  const marker = (environment: string | null, environmentId: number | null) => ({ environment, environmentId });

  test('a marker applies to the runs of its environment, by id, else by label ignoring case', async () => {
    const { markerAppliesToRun } = await import('../../shared/marker-environments');
    expect(markerAppliesToRun(marker(null, null), { environment: 'prod', environmentId: 2 })).toBe(true);
    expect(markerAppliesToRun(marker('stg', 1), { environment: 'staging', environmentId: 1 })).toBe(true);
    expect(markerAppliesToRun(marker('staging', 1), { environment: 'staging', environmentId: 2 })).toBe(false);
    expect(markerAppliesToRun(marker('QA', null), { environment: 'qa', environmentId: null })).toBe(true);
    expect(markerAppliesToRun(marker('qa', 3), { environment: 'Qa', environmentId: null })).toBe(true);
    expect(markerAppliesToRun(marker('qa', null), { environment: null, environmentId: null })).toBe(false);
  });

  test('a filter shows a marker through its environment’s key or its label, and one of every environment always', async () => {
    const { markerInEnvironmentFilter } = await import('../../shared/marker-environments');
    const keyOf = (id: number) => (id === 1 ? 'staging' : null);
    expect(markerInEnvironmentFilter(marker('stg', 1), ['Staging'], keyOf)).toBe(true);
    expect(markerInEnvironmentFilter(marker('stg', 1), ['production'], keyOf)).toBe(false);
    expect(markerInEnvironmentFilter(marker('Nightly', null), ['nightly'], keyOf)).toBe(true);
    expect(markerInEnvironmentFilter(marker(null, null), ['production'], keyOf)).toBe(true);
    expect(markerInEnvironmentFilter(marker('stg', 1), [], keyOf)).toBe(true);
  });

  test('Analytics counts the period markers of a filter’s environments the same way', async () => {
    const { markerEnvironmentScopeSql } = await import('../../shared/handlers/environment-scope');
    const [staging] = await db
      .insert(schema.environments)
      .values({ projectId: 1, key: 'staging', keyFold: 'staging', name: 'Staging', aliases: ['stg'] })
      .returning();
    await createMarker(db, 1, { label: 'Staging deploy', occurredAt: at(5), environment: 'stg' });
    await db.insert(schema.markers).values([
      { projectId: 1, label: 'Nightly', occurredAt: at(4), environment: 'Nightly' },
      { projectId: 1, label: 'Everywhere', occurredAt: at(3) },
      { projectId: 1, label: 'Production', occurredAt: at(2), environment: 'production' },
    ]);
    const labels = async (names: string[]) =>
      (await db.select({ label: schema.markers.label }).from(schema.markers).where(markerEnvironmentScopeSql(names)!))
        .map((m) => m.label)
        .sort();
    expect(staging).toBeDefined();
    expect(await labels(['STAGING'])).toEqual(['Everywhere', 'Staging deploy']);
    expect(await labels(['nightly'])).toEqual(['Everywhere', 'Nightly']);
    expect(markerEnvironmentScopeSql([])).toBeNull();
  });
});
