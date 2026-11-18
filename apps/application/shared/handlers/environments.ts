import { and, asc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import {
  ENVIRONMENT_LIMITS,
  environmentKeyProblem,
  environmentListProblems,
  environmentMatchesPattern,
  normalizeEnvironmentLabel,
  parseEnvironmentForRun,
  resolveEnvironment,
  type EnvironmentForRun,
  type EnvironmentMatchSource,
} from '@piwitests/core/environments';
import { RUN_VARIABLE_LIMITS, mergeRunVariables, parseRunVariables } from '@piwitests/core/run-variables';
import { environments, projectUrlPatterns, projects, runRequests, testRuns } from '../../server/database/schema';
import { urlMatches } from '@piwitests/core/function-match';
import { runBaseUrls } from '#shared/graph';
import {
  checkEnvironmentFields,
  type EnvironmentFields,
  type EnvironmentPatch,
  type EnvironmentRecord,
} from '#shared/environments';
import { storedRunVariables, type RunVariable } from '#shared/run-variables';
import type { DrizzleDB } from './db';

/**
 * A project's environments (`environments`): the list the pickers read, the resolution of a run's label as it is
 * stored, and what a run Piwi starts for one gets. The rules of each field live in `@piwitests/core/environments`.
 */

type EnvironmentRow = typeof environments.$inferSelect;

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

/** A stored row as the API returns it. `showVariables` false hides a protected environment's run variables. */
export function environmentRecordOf(row: EnvironmentRow, showVariables = true): EnvironmentRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    aliases: stringList(row.aliases),
    runVariables: row.protected && !showVariables ? [] : storedRunVariables(row.runVariables),
    appFromCheckout: row.appFromCheckout,
    protected: row.protected,
    requiredTags: stringList(row.requiredTags),
    envFile: row.envFile ?? null,
    position: row.position,
    discovered: row.discovered,
    archived: row.archivedAt != null,
  };
}

function matchSourceOf(row: EnvironmentRow): EnvironmentMatchSource {
  return { id: row.id, key: row.key, aliases: stringList(row.aliases), position: row.position };
}

async function projectEnvironmentRows(db: DrizzleDB, projectId: number): Promise<EnvironmentRow[]> {
  return db
    .select()
    .from(environments)
    .where(eq(environments.projectId, projectId))
    .orderBy(asc(environments.position), asc(environments.id));
}

/**
 * A project's environments in position order, archived ones included when asked. A protected environment's run
 * variables are listed only when `canManage`.
 */
export async function listProjectEnvironments(
  db: DrizzleDB,
  projectId: number,
  { canManage = false, includeArchived = true }: { canManage?: boolean; includeArchived?: boolean } = {},
): Promise<EnvironmentRecord[]> {
  const rows = await projectEnvironmentRows(db, projectId);
  return rows
    .filter((row) => includeArchived || row.archivedAt == null)
    .map((row) => environmentRecordOf(row, canManage));
}

/**
 * A run's label and environment as a run is stored: the label trimmed and cut (`normalizeEnvironmentLabel`), and the
 * environment of the project it resolves to. A label no environment takes creates a `discovered` one with it as key,
 * while the project has room for one ({@link ENVIRONMENT_LIMITS}): past it, the run keeps its label and no environment.
 */
export async function resolveRunEnvironment(
  db: DrizzleDB,
  projectId: number,
  raw: unknown,
): Promise<{ environment: string | null; environmentId: number | null }> {
  const label = normalizeEnvironmentLabel(raw);
  if (label === null) return { environment: null, environmentId: null };
  const rows = await projectEnvironmentRows(db, projectId);
  const found = resolveEnvironment(label, rows.map(matchSourceOf));
  if (found !== null) return { environment: label, environmentId: found };
  return { environment: label, environmentId: await discoverEnvironment(db, projectId, label, rows) };
}

async function discoverEnvironment(
  db: DrizzleDB,
  projectId: number,
  label: string,
  rows: EnvironmentRow[],
): Promise<number | null> {
  if (environmentKeyProblem(label) !== null) return null;
  if (rows.length >= ENVIRONMENT_LIMITS.perProject) return null;
  if (rows.filter((row) => row.discovered).length >= ENVIRONMENT_LIMITS.discovered) return null;
  const keyFold = label.toLowerCase();
  const position = rows.reduce((max, row) => Math.max(max, row.position + 1), 0);
  await db
    .insert(environments)
    .values({ projectId, key: label, keyFold, name: label, position, discovered: true })
    .onConflictDoNothing({ target: [environments.projectId, environments.keyFold] });
  const [row] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.keyFold, keyFold)));
  return row?.id ?? null;
}

/**
 * Resolve the stored runs of a project again, after its environments changed: each label its runs carry goes to the
 * environment it resolves to now, discovering one as a new run's label would. Returns how many runs changed.
 */
export async function reresolveProjectRuns(db: DrizzleDB, projectId: number): Promise<number> {
  const labels = await db
    .selectDistinct({ label: testRuns.environment })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), isNotNull(testRuns.environment)));
  let changed = 0;
  for (const { label } of labels) {
    if (label === null) continue;
    const { environmentId } = await resolveRunEnvironment(db, projectId, label);
    const moved = await db
      .update(testRuns)
      .set({ environmentId })
      .where(
        and(
          eq(testRuns.projectId, projectId),
          eq(testRuns.environment, label),
          environmentId === null
            ? isNotNull(testRuns.environmentId)
            : or(isNull(testRuns.environmentId), ne(testRuns.environmentId, environmentId)),
        ),
      )
      .returning({ id: testRuns.id });
    changed += moved.length;
  }
  return changed;
}

/**
 * Give the runs stored before environments existed theirs (`environment_id`), project by project, discovering an
 * environment for each label nothing takes. Idempotent: only runs with a label and no environment are read, so an
 * interrupted pass resumes at the next start. Returns how many runs it gave one.
 */
export async function backfillRunEnvironments(db: DrizzleDB): Promise<number> {
  const pending = await db
    .selectDistinct({ projectId: testRuns.projectId, label: testRuns.environment })
    .from(testRuns)
    .where(and(isNotNull(testRuns.environment), isNull(testRuns.environmentId)));
  let given = 0;
  for (const { projectId, label } of pending) {
    if (label === null) continue;
    const { environmentId } = await resolveRunEnvironment(db, projectId, label);
    if (environmentId === null) continue;
    const moved = await db
      .update(testRuns)
      .set({ environmentId })
      .where(and(eq(testRuns.projectId, projectId), eq(testRuns.environment, label), isNull(testRuns.environmentId)))
      .returning({ id: testRuns.id });
    given += moved.length;
  }
  return given;
}

export type EnvironmentWrite =
  | { ok: true; environment: EnvironmentRecord }
  | { ok: false; statusCode: 400 | 404 | 409; problems: string[] };

/**
 * The discovered environments a saved one takes over: those whose key resolves to it alone. They are deleted and
 * their runs resolved again, so adding `stg` as an alias of Staging moves the runs a discovered `stg` held.
 */
function absorbedBy(saved: EnvironmentMatchSource, rows: EnvironmentRow[]): EnvironmentRow[] {
  return rows.filter(
    (row) => row.discovered && row.id !== saved.id && resolveEnvironment(row.key, [saved]) === saved.id,
  );
}

async function deleteEnvironmentRows(db: DrizzleDB, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.update(testRuns).set({ environmentId: null }).where(inArray(testRuns.environmentId, ids));
  await db.update(runRequests).set({ environmentId: null }).where(inArray(runRequests.environmentId, ids));
  await db.delete(environments).where(inArray(environments.id, ids));
}

/** Check a project's list as it would be once `fields` are saved as environment `id` (0 for a new one). */
function listProblems(rows: EnvironmentRow[], id: number, fields: EnvironmentFields): string[] {
  const saved = { id: id || -1, key: fields.key, aliases: fields.aliases, position: 0 };
  const absorbed = new Set(absorbedBy(saved, rows).map((row) => row.id));
  const others = rows.filter((row) => row.id !== id && !absorbed.has(row.id)).map(matchSourceOf);
  return environmentListProblems([...others, saved]);
}

function storedFields(fields: EnvironmentFields) {
  return {
    key: fields.key,
    keyFold: fields.key.toLowerCase(),
    name: fields.name,
    description: fields.description,
    aliases: fields.aliases.length > 0 ? fields.aliases : null,
    runVariables: fields.runVariables.length > 0 ? fields.runVariables : null,
    appFromCheckout: fields.appFromCheckout,
    protected: fields.protected,
    requiredTags: fields.requiredTags.length > 0 ? fields.requiredTags : null,
    envFile: fields.envFile,
  };
}

/** After a save: take over the discovered environments it now names, and resolve the project's runs again. */
async function settleSaved(db: DrizzleDB, projectId: number, saved: EnvironmentRow): Promise<void> {
  const rows = await projectEnvironmentRows(db, projectId);
  await deleteEnvironmentRows(
    db,
    absorbedBy(matchSourceOf(saved), rows).map((row) => row.id),
  );
  await reresolveProjectRuns(db, projectId);
}

/** Create an environment, declared (never `discovered`), at the end of the list unless a position is given. */
export async function createEnvironment(
  db: DrizzleDB,
  projectId: number,
  input: Parameters<typeof checkEnvironmentFields>[0] & { position?: number },
): Promise<EnvironmentWrite> {
  const checked = checkEnvironmentFields(input);
  if (!checked.ok) return { ok: false, statusCode: 400, problems: checked.problems };
  const rows = await projectEnvironmentRows(db, projectId);
  if (rows.length >= ENVIRONMENT_LIMITS.perProject) {
    return {
      ok: false,
      statusCode: 409,
      problems: [`A project has at most ${ENVIRONMENT_LIMITS.perProject} environments.`],
    };
  }
  const problems = listProblems(rows, 0, checked.value);
  if (problems.length > 0) return { ok: false, statusCode: 409, problems };
  const position = input.position ?? rows.reduce((max, row) => Math.max(max, row.position + 1), 0);
  const [row] = await db
    .insert(environments)
    .values({ projectId, ...storedFields(checked.value), position, discovered: false })
    .returning();
  await settleSaved(db, projectId, row!);
  return { ok: true, environment: environmentRecordOf(row!) };
}

/**
 * Change an environment: the fields given replace its own, it stops being `discovered`, and a changed key keeps the
 * old one as an alias, so the runs that reported it stay with it.
 */
export async function updateEnvironment(
  db: DrizzleDB,
  projectId: number,
  environmentId: number,
  patch: EnvironmentPatch,
): Promise<EnvironmentWrite> {
  const rows = await projectEnvironmentRows(db, projectId);
  const current = rows.find((row) => row.id === environmentId);
  if (!current) return { ok: false, statusCode: 404, problems: ['No environment of this project has this id.'] };
  const record = environmentRecordOf(current);
  const key = patch.key ?? record.key;
  const aliases = patch.aliases ?? record.aliases;
  const keptAliases =
    key.toLowerCase() !== record.key.toLowerCase() && !aliases.some((a) => a.toLowerCase() === record.key.toLowerCase())
      ? [...aliases, record.key]
      : aliases;
  const checked = checkEnvironmentFields({
    key,
    name: patch.name ?? record.name,
    description: patch.description === undefined ? record.description : patch.description,
    aliases: keptAliases,
    runVariables: patch.runVariables === undefined ? record.runVariables : patch.runVariables,
    appFromCheckout: patch.appFromCheckout ?? record.appFromCheckout,
    protected: patch.protected ?? record.protected,
    requiredTags: patch.requiredTags ?? record.requiredTags,
    envFile: patch.envFile === undefined ? record.envFile : patch.envFile,
  });
  if (!checked.ok) return { ok: false, statusCode: 400, problems: checked.problems };
  const problems = listProblems(rows, environmentId, checked.value);
  if (problems.length > 0) return { ok: false, statusCode: 409, problems };
  const archivedAt =
    patch.archived === undefined ? current.archivedAt : patch.archived ? (current.archivedAt ?? new Date()) : null;
  const [row] = await db
    .update(environments)
    .set({
      ...storedFields(checked.value),
      position: patch.position ?? current.position,
      discovered: false,
      archivedAt,
      updatedAt: new Date(),
    })
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)))
    .returning();
  await settleSaved(db, projectId, row!);
  return { ok: true, environment: environmentRecordOf(row!) };
}

/** Delete an environment: its runs keep their label and lose their environment, until a label creates one again. */
export async function deleteEnvironment(db: DrizzleDB, projectId: number, environmentId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)));
  if (!row) return false;
  await deleteEnvironmentRows(db, [row.id]);
  return true;
}

/**
 * Copy the environments of one project into another: every field but the URL patterns, each copy declared and
 * independent of its source. An environment whose key, or one of its exact aliases, the target already names is left
 * as it is and listed in `skipped`.
 */
export async function copyEnvironments(
  db: DrizzleDB,
  fromProjectId: number,
  toProjectId: number,
): Promise<{ copied: EnvironmentRecord[]; skipped: string[] }> {
  const source = (await projectEnvironmentRows(db, fromProjectId)).filter((row) => !row.discovered);
  const copied: EnvironmentRecord[] = [];
  const skipped: string[] = [];
  for (const row of source) {
    const record = environmentRecordOf(row);
    const result = await createEnvironment(db, toProjectId, {
      key: record.key,
      name: record.name,
      description: record.description,
      aliases: record.aliases,
      runVariables: record.runVariables,
      appFromCheckout: record.appFromCheckout,
      protected: record.protected,
      requiredTags: record.requiredTags,
      envFile: record.envFile,
    });
    if (result.ok) copied.push(result.environment);
    else skipped.push(record.key);
  }
  return { copied, skipped };
}

export type EnvironmentRunSettings =
  | { ok: true; runVariables: RunVariable[]; environment: EnvironmentForRun | null }
  | { ok: false; statusCode: 403 | 404 | 409; message: string };

/**
 * What a run Piwi starts for a project gets: with no environment, the project's run variables; with one, the project's
 * and the environment's merged (`mergeRunVariables`) and the environment a target reads (`EnvironmentForRun`). An
 * archived environment, or one of another project, answers 404; a protected one 403 unless `canManage`; a merged list
 * or an environment the rules refuse 409, with their words, so a target never runs with part of it.
 */
export async function environmentRunSettings(
  db: DrizzleDB,
  projectId: number,
  environmentId: number | null,
  { canManage }: { canManage: boolean },
): Promise<EnvironmentRunSettings> {
  const [project] = await db
    .select({ runVariables: projects.runVariables })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return { ok: false, statusCode: 404, message: 'Project not found' };
  const own = storedRunVariables(project.runVariables);
  if (environmentId === null) return { ok: true, runVariables: own, environment: null };
  const [row] = await db
    .select()
    .from(environments)
    .where(
      and(eq(environments.id, environmentId), eq(environments.projectId, projectId), isNull(environments.archivedAt)),
    );
  if (!row) return { ok: false, statusCode: 404, message: 'No environment of this project has this id' };
  if (row.protected && !canManage) {
    return {
      ok: false,
      statusCode: 403,
      message: `${row.name} is protected: only the project's managers start runs against it from Piwi.`,
    };
  }
  const merged = parseRunVariables(
    mergeRunVariables(own, storedRunVariables(row.runVariables)),
    RUN_VARIABLE_LIMITS.merged,
  );
  if (!merged.ok) return { ok: false, statusCode: 409, message: merged.problems.join(' ') };
  const record = environmentRecordOf(row);
  const environment = parseEnvironmentForRun({
    id: record.id,
    key: record.key,
    name: record.name,
    protected: record.protected,
    requiredTags: record.requiredTags,
    envFile: record.envFile,
  });
  if (!environment.ok) return { ok: false, statusCode: 409, message: environment.problems.join(' ') };
  return { ok: true, runVariables: merged.value, environment: environment.value };
}

/** Whether an environment of the project is protected; false for none or an id it does not have. */
export async function isProtectedEnvironment(
  db: DrizzleDB,
  projectId: number,
  environmentId: number | null,
): Promise<boolean> {
  if (environmentId === null) return false;
  const [row] = await db
    .select({ protected: environments.protected })
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)));
  return row?.protected === true;
}

/** The environment ids of a project whose key, or exact alias, equals one of `keys` ignoring case. */
export async function environmentIdsForKeys(
  db: DrizzleDB,
  projectId: number,
  keys: readonly string[],
): Promise<number[]> {
  if (keys.length === 0) return [];
  const rows = await projectEnvironmentRows(db, projectId);
  return [
    ...new Set(
      keys.flatMap((key) => {
        const id = resolveEnvironment(key, rows.map(matchSourceOf));
        return id === null ? [] : [id];
      }),
    ),
  ];
}

/** What the run page shows of a run's environment: its name, and why the run may not have tested it. */
export interface RunEnvironmentFacts {
  environmentName: string | null;
  environmentWarnings: string[];
}

function urlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * A run's environment facts: the name of the environment its label resolved to, and two warnings. A requested run
 * started for an environment whose label resolved to another one says so ("Started for Staging; the config reported
 * production"). A run whose environment has URL patterns, none of which a Playwright project's `baseURL` matches, says
 * which addresses its tests opened instead, which catches a config that ignores the variable.
 */
export async function runEnvironmentFacts(
  db: DrizzleDB,
  run: {
    id: number;
    projectId: number;
    environment: string | null;
    environmentId: number | null;
    origin: string;
    metadata: unknown;
  },
): Promise<RunEnvironmentFacts> {
  const rows = await projectEnvironmentRows(db, run.projectId);
  const own = rows.find((row) => row.id === run.environmentId) ?? null;
  const warnings: string[] = [];
  if (run.origin === 'request') {
    const [request] = await db
      .select({ environmentId: runRequests.environmentId })
      .from(runRequests)
      .where(eq(runRequests.runId, run.id));
    const startedFor = request?.environmentId ? rows.find((row) => row.id === request.environmentId) : undefined;
    if (startedFor && startedFor.id !== run.environmentId) {
      warnings.push(
        `Started for ${startedFor.name}; the config reported ${run.environment ? run.environment : 'no environment'}.`,
      );
    }
  }
  if (own) {
    const patterns = (
      await db
        .select({ pattern: projectUrlPatterns.pattern, environment: projectUrlPatterns.environment })
        .from(projectUrlPatterns)
        .where(eq(projectUrlPatterns.projectId, run.projectId))
    ).filter((row) => row.environment && environmentMatchesPattern(matchSourceOf(own), row.environment));
    const baseUrls = runBaseUrls(run.metadata);
    if (patterns.length > 0 && baseUrls.length > 0) {
      const outside = baseUrls.filter((url) => {
        const candidates = [url, url.endsWith('/') ? url : `${url}/`];
        return !patterns.some((row) => candidates.some((candidate) => urlMatches(row.pattern, candidate)));
      });
      const origins = [...new Set(outside.map((url) => urlOrigin(url) ?? url))];
      if (origins.length > 0) {
        warnings.push(`The tests opened ${origins.join(', ')}, which no URL pattern of ${own.name} matches.`);
      }
    }
  }
  return { environmentName: own?.name ?? null, environmentWarnings: warnings };
}
