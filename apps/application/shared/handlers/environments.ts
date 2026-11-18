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
import {
  environments,
  markers,
  projectUrlPatterns,
  projects,
  runRequests,
  testRuns,
} from '../../server/database/schema';
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

/** An environment key as the projects a person can read use it, for the pickers that span projects. */
export interface InstanceEnvironment {
  key: string;
  /** The names the projects give it, each once. */
  names: string[];
  /** How many of the projects have it. */
  projects: number;
}

/**
 * The environments of the projects `scope` allows, one entry per key ignoring case, in position order, archived ones
 * left out: what a cross-project filter (Analytics, a dashboard, a report, a notification filter on every project)
 * offers, since it names an environment by key.
 */
export async function listInstanceEnvironments(
  db: DrizzleDB,
  scope: 'all' | Set<number>,
): Promise<InstanceEnvironment[]> {
  if (scope !== 'all' && scope.size === 0) return [];
  const rows = await db
    .select({
      projectId: environments.projectId,
      key: environments.key,
      keyFold: environments.keyFold,
      name: environments.name,
    })
    .from(environments)
    .where(
      and(isNull(environments.archivedAt), scope === 'all' ? undefined : inArray(environments.projectId, [...scope])),
    )
    .orderBy(asc(environments.position), asc(environments.id));
  const byKey = new Map<string, { key: string; names: Set<string>; projects: Set<number> }>();
  for (const row of rows) {
    const entry = byKey.get(row.keyFold) ?? { key: row.key, names: new Set<string>(), projects: new Set<number>() };
    entry.names.add(row.name);
    entry.projects.add(row.projectId);
    byKey.set(row.keyFold, entry);
  }
  return [...byKey.values()].map((entry) => ({
    key: entry.key,
    names: [...entry.names],
    projects: entry.projects.size,
  }));
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
 * environment it resolves to now, or to none. It discovers nothing, so a label whose environment was deleted, or lost
 * the alias that took it, stays without one until a new run reports it. One read groups the project's runs by label
 * and environment; only the labels whose environment changes are written. Returns how many runs changed.
 */
export async function reresolveProjectRuns(db: DrizzleDB, projectId: number): Promise<number> {
  const groups = await db
    .select({ label: testRuns.environment, environmentId: testRuns.environmentId })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), isNotNull(testRuns.environment)))
    .groupBy(testRuns.environment, testRuns.environmentId);
  const sources = (await projectEnvironmentRows(db, projectId)).map(matchSourceOf);
  const targets = new Map<string, number | null>();
  for (const { label } of groups) {
    if (label !== null && !targets.has(label)) targets.set(label, resolveEnvironment(label, sources));
  }
  let changed = 0;
  for (const [label, environmentId] of targets) {
    if (groups.every((group) => group.label !== label || (group.environmentId ?? null) === environmentId)) continue;
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

/** The app setting that records the instance gave its stored runs their environment (`backfillRunEnvironments`). */
export const RUN_ENVIRONMENTS_BACKFILLED_SETTING = 'run_environments_backfilled_at';

/**
 * Give the runs stored before environments existed theirs (`environment_id`), project by project, discovering an
 * environment for each label nothing takes. Only runs with a label and no environment are read. Returns how many runs
 * it gave one.
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

/** The app setting that records the instance gave its markers, URL patterns and CI actions their environment. */
export const ENVIRONMENT_REFERENCES_BACKFILLED_SETTING = 'environment_references_backfilled_at';

/**
 * Give the markers and URL patterns stored before they named environments by id theirs (`environment_id`), each label
 * resolving as a run's does, discovering an environment nothing takes. Returns how many rows it gave one.
 */
async function backfillLabelledRows(db: DrizzleDB, table: typeof markers | typeof projectUrlPatterns): Promise<number> {
  const t = table as typeof markers;
  const pending = await db
    .selectDistinct({ projectId: t.projectId, label: t.environment })
    .from(t)
    .where(and(isNotNull(t.environment), isNull(t.environmentId)));
  let given = 0;
  for (const { projectId, label } of pending) {
    if (label === null) continue;
    const { environmentId } = await resolveRunEnvironment(db, projectId, label);
    if (environmentId === null) continue;
    const moved = await db
      .update(t)
      .set({ environmentId })
      .where(and(eq(t.projectId, projectId), eq(t.environment, label), isNull(t.environmentId)))
      .returning({ id: t.id });
    given += moved.length;
  }
  return given;
}

/**
 * Give what named an environment by its label before environments were records theirs: markers, URL patterns, and
 * the CI actions of each project (`environmentId` beside the `environment` label), discovering an environment for a
 * label nothing takes. Returns how many it gave one.
 */
export async function backfillEnvironmentReferences(db: DrizzleDB): Promise<number> {
  let given = (await backfillLabelledRows(db, markers)) + (await backfillLabelledRows(db, projectUrlPatterns));
  const rows = await db
    .select({ id: projects.id, ciRerun: projects.ciRerun })
    .from(projects)
    .where(isNotNull(projects.ciRerun));
  for (const project of rows) {
    const actions = storedCiActions(project.ciRerun);
    const pending = (action: StoredCiActionEnvironment) =>
      typeof action.environment === 'string' && action.environment.trim() !== '' && action.environmentId === undefined;
    if (!actions.some(pending)) continue;
    const next: StoredCiActionEnvironment[] = [];
    for (const action of actions) {
      if (!pending(action)) {
        next.push(action);
        continue;
      }
      const { environmentId } = await resolveRunEnvironment(db, project.id, action.environment);
      if (environmentId === null) {
        next.push(action);
        continue;
      }
      given += 1;
      next.push({ ...action, environmentId });
    }
    await db
      .update(projects)
      .set({ ciRerun: { ...(project.ciRerun as object), actions: next } as never })
      .where(eq(projects.id, project.id));
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

/** A CI action's environment as `projects.ci_rerun` stores it: the label as written and the environment's id. */
interface StoredCiActionEnvironment {
  name?: unknown;
  environment?: unknown;
  environmentId?: unknown;
}

function storedCiActions(raw: unknown): StoredCiActionEnvironment[] {
  const actions = raw && typeof raw === 'object' ? (raw as { actions?: unknown }).actions : null;
  return Array.isArray(actions)
    ? actions.filter((a): a is StoredCiActionEnvironment => !!a && typeof a === 'object' && !Array.isArray(a))
    : [];
}

/**
 * Move what names environments `ids` by id to environment `into`, or to none: the project's default environment, its
 * markers, URL patterns and CI actions, and the run requests. Each keeps its label as written.
 */
async function moveReferences(db: DrizzleDB, projectId: number, ids: number[], into: number | null): Promise<void> {
  await db.update(runRequests).set({ environmentId: into }).where(inArray(runRequests.environmentId, ids));
  await db.update(markers).set({ environmentId: into }).where(inArray(markers.environmentId, ids));
  await db
    .update(projectUrlPatterns)
    .set({ environmentId: into })
    .where(inArray(projectUrlPatterns.environmentId, ids));
  await db
    .update(projects)
    .set({ defaultEnvironmentId: into })
    .where(and(eq(projects.id, projectId), inArray(projects.defaultEnvironmentId, ids)));
  const [project] = await db.select({ ciRerun: projects.ciRerun }).from(projects).where(eq(projects.id, projectId));
  const actions = storedCiActions(project?.ciRerun);
  if (!actions.some((action) => typeof action.environmentId === 'number' && ids.includes(action.environmentId))) return;
  const moved = actions.map((action) => {
    if (typeof action.environmentId !== 'number' || !ids.includes(action.environmentId)) return action;
    const rest = Object.fromEntries(Object.entries(action).filter(([field]) => field !== 'environmentId'));
    return into === null ? rest : { ...rest, environmentId: into };
  });
  await db
    .update(projects)
    .set({ ciRerun: { ...(project!.ciRerun as object), actions: moved } as never })
    .where(eq(projects.id, projectId));
}

/**
 * Delete environments, in one transaction so a run stored meanwhile never points at a deleted one. Their runs keep
 * their label and lose their environment, to be resolved again; what else names them by id moves to `into`, the
 * environment that takes them over, else to none.
 */
async function deleteEnvironmentRows(
  db: DrizzleDB,
  projectId: number,
  ids: number[],
  into: number | null = null,
): Promise<void> {
  if (ids.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.update(testRuns).set({ environmentId: null }).where(inArray(testRuns.environmentId, ids));
    await moveReferences(tx as unknown as DrizzleDB, projectId, ids, into);
    await tx.delete(environments).where(inArray(environments.id, ids));
  });
}

/**
 * The settings that name an environment by id, which deleting it would leave without one: its URL patterns, and its
 * CI actions by name. Its runs, requests and markers keep their label, and the default environment falls back to
 * every environment, so none of them holds a delete back.
 */
export interface EnvironmentReferences {
  urlPatterns: number;
  ciActions: string[];
}

export async function environmentReferences(
  db: DrizzleDB,
  projectId: number,
  environmentId: number,
): Promise<EnvironmentReferences> {
  const patterns = await db
    .select({ id: projectUrlPatterns.id })
    .from(projectUrlPatterns)
    .where(and(eq(projectUrlPatterns.projectId, projectId), eq(projectUrlPatterns.environmentId, environmentId)));
  const [project] = await db.select({ ciRerun: projects.ciRerun }).from(projects).where(eq(projects.id, projectId));
  const ciActions = storedCiActions(project?.ciRerun)
    .filter((action) => action.environmentId === environmentId)
    .map((action) => (typeof action.name === 'string' ? action.name : ''));
  return { urlPatterns: patterns.length, ciActions };
}

/** Why an environment cannot be deleted, in words, or null when nothing holds it back. */
export function environmentReferencesProblem(name: string, refs: EnvironmentReferences): string | null {
  const parts: string[] = [];
  if (refs.urlPatterns > 0) parts.push(refs.urlPatterns === 1 ? '1 URL pattern' : `${refs.urlPatterns} URL patterns`);
  if (refs.ciActions.length > 0) {
    const names = refs.ciActions.map((action) => `“${action}”`).join(', ');
    parts.push(refs.ciActions.length === 1 ? `the CI action ${names}` : `the CI actions ${names}`);
  }
  if (parts.length === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${name} is used by ${list}. Archive it instead, or move them to another environment first.`;
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

/** The discovered environments `fields`, saved as environment `id` (0 for a new one), takes over. */
function absorbedRows(rows: EnvironmentRow[], id: number, fields: EnvironmentFields): EnvironmentRow[] {
  return absorbedBy({ id: id || -1, key: fields.key, aliases: fields.aliases, position: 0 }, rows);
}

/**
 * Create an environment, declared (never `discovered`), at the end of the list unless a position is given. A
 * discovered environment with the same key becomes it, keeping its runs; the other discovered ones it names are
 * deleted once it is saved, handing it what named them, and their runs resolved again. `settle: false` leaves the
 * runs to a caller that saves several.
 */
export async function createEnvironment(
  db: DrizzleDB,
  projectId: number,
  input: Parameters<typeof checkEnvironmentFields>[0] & { position?: number },
  { settle = true }: { settle?: boolean } = {},
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
  const fold = checked.value.key.toLowerCase();
  const absorbed = absorbedRows(rows, 0, checked.value);
  const sameKey = absorbed.find((row) => row.keyFold === fold);
  const position = input.position ?? sameKey?.position ?? rows.reduce((max, row) => Math.max(max, row.position + 1), 0);
  const values = { ...storedFields(checked.value), position, discovered: false, updatedAt: new Date() };
  const [row] = sameKey
    ? await db.update(environments).set(values).where(eq(environments.id, sameKey.id)).returning()
    : await db
        .insert(environments)
        .values({ projectId, ...values })
        .returning();
  await deleteEnvironmentRows(
    db,
    projectId,
    absorbed.filter((other) => other !== sameKey).map((other) => other.id),
    row!.id,
  );
  if (settle) await reresolveProjectRuns(db, projectId);
  return { ok: true, environment: environmentRecordOf(row!) };
}

/**
 * Change an environment: the fields given replace its own, it stops being `discovered` unless only its position or
 * archive changed, and a changed key keeps the old one as an alias, so the runs that reported it stay with it. The
 * discovered environments it now names are deleted first, handing it what named them, and the project's runs resolved
 * again.
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
  // Moving or archiving an environment is not saving it: a discovered one stays discovered.
  const saves = Object.keys(patch).some((field) => field !== 'position' && field !== 'archived');
  await deleteEnvironmentRows(
    db,
    projectId,
    absorbedRows(rows, environmentId, checked.value).map((other) => other.id),
    environmentId,
  );
  const [row] = await db
    .update(environments)
    .set({
      ...storedFields(checked.value),
      position: patch.position ?? current.position,
      discovered: saves ? false : current.discovered,
      archivedAt,
      updatedAt: new Date(),
    })
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)))
    .returning();
  await reresolveProjectRuns(db, projectId);
  return { ok: true, environment: environmentRecordOf(row!) };
}

export type EnvironmentDelete = { ok: true } | { ok: false; statusCode: 404 | 409; problems: string[] };

/**
 * Delete an environment: its runs, requests and markers keep their label and lose their environment, until a label
 * creates one again, and a project whose default it was reads every environment. Refused while a URL pattern or a CI
 * action names it (`environmentReferences`), which would otherwise apply to every environment: archiving keeps them.
 */
export async function deleteEnvironment(
  db: DrizzleDB,
  projectId: number,
  environmentId: number,
): Promise<EnvironmentDelete> {
  const [row] = await db
    .select({ id: environments.id, name: environments.name })
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)));
  if (!row) return { ok: false, statusCode: 404, problems: ['No environment of this project has this id.'] };
  const problem = environmentReferencesProblem(row.name, await environmentReferences(db, projectId, row.id));
  if (problem) return { ok: false, statusCode: 409, problems: [problem] };
  await deleteEnvironmentRows(db, projectId, [row.id]);
  return { ok: true };
}

/**
 * Copy the environments of one project into another: every field but the URL patterns, each copy declared and
 * independent of its source. A protected environment is copied only for someone who manages the source project, since
 * its run variables are theirs to read; the others it holds are listed in `skipped`, as is an environment whose key or
 * one of its exact aliases the target already names.
 */
export async function copyEnvironments(
  db: DrizzleDB,
  fromProjectId: number,
  toProjectId: number,
  { canManageSource }: { canManageSource: boolean },
): Promise<{ copied: EnvironmentRecord[]; skipped: string[] }> {
  const source = (await projectEnvironmentRows(db, fromProjectId)).filter((row) => !row.discovered);
  const copied: EnvironmentRecord[] = [];
  const skipped: string[] = [];
  for (const row of source) {
    if (row.protected && !canManageSource) {
      skipped.push(row.key);
      continue;
    }
    const record = environmentRecordOf(row);
    const result = await createEnvironment(
      db,
      toProjectId,
      {
        key: record.key,
        name: record.name,
        description: record.description,
        aliases: record.aliases,
        runVariables: record.runVariables,
        appFromCheckout: record.appFromCheckout,
        protected: record.protected,
        requiredTags: record.requiredTags,
        envFile: record.envFile,
      },
      { settle: false },
    );
    if (result.ok) copied.push(result.environment);
    else skipped.push(record.key);
  }
  if (copied.length > 0) await reresolveProjectRuns(db, toProjectId);
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

/**
 * What the run page shows of a run's environment: its name, whether it is protected or archived (a copied command
 * starts on it only when it is neither), and why the run may not have tested it.
 */
export interface RunEnvironmentFacts {
  environmentName: string | null;
  environmentProtected: boolean;
  environmentArchived: boolean;
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
 * A run's environment facts, from its environment's row (`own`, which the caller read with the run): its name, whether
 * it is protected or archived, and two warnings. A requested run
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
  own: EnvironmentRow | null,
): Promise<RunEnvironmentFacts> {
  const warnings: string[] = [];
  if (run.origin === 'request') {
    const [startedFor] = await db
      .select({ id: environments.id, name: environments.name })
      .from(runRequests)
      .innerJoin(environments, eq(environments.id, runRequests.environmentId))
      .where(eq(runRequests.runId, run.id));
    if (startedFor && startedFor.id !== run.environmentId) {
      warnings.push(
        `Started for ${startedFor.name}; the config reported ${run.environment ? run.environment : 'no environment'}.`,
      );
    }
  }
  const baseUrls = runBaseUrls(run.metadata);
  if (own && baseUrls.length > 0) {
    const patterns = (
      await db
        .select({ pattern: projectUrlPatterns.pattern, environment: projectUrlPatterns.environment })
        .from(projectUrlPatterns)
        .where(eq(projectUrlPatterns.projectId, run.projectId))
    ).filter((row) => row.environment && environmentMatchesPattern(matchSourceOf(own), row.environment));
    if (patterns.length > 0) {
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
  return {
    environmentName: own?.name ?? null,
    environmentProtected: own?.protected ?? false,
    environmentArchived: own?.archivedAt != null,
    environmentWarnings: warnings,
  };
}
