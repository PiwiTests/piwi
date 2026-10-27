/**
 * Capability detection for the Setup page.
 *
 * Piwi's optional capabilities (capture fixtures, locator healing, AI diagnosis,
 * notifications, …) are each enabled somewhere else — a reporter option, a
 * settings page, an env var. Nothing told a user which ones were actually live
 * on their instance, so a feature they never switched on was indistinguishable
 * from one that was broken.
 *
 * This reports, per capability, whether the instance has ever seen evidence of
 * it working. It is deliberately evidence-based rather than config-based: a
 * configured-but-never-used capability reads as inactive, which is the honest
 * answer to "is this working for me?".
 *
 * Cheap by construction — every check is a `limit(1)` existence probe, never a
 * full count, so the page stays fast on instances with millions of rows.
 */
import {
  testRuns,
  testCases,
  networkRequests,
  locatorSnapshots,
  notificationChannels,
  reportSchedules,
  reportSnapshots,
  tags,
  markers,
  projects,
  appSettings,
  quarantinedTests,
  failureClusters,
  testRunsCases,
  integrationConnections,
  graphNodes,
  probes,
  bugReports,
  coverageFragments,
  testRunResourceReports,
  failureDiagnoses,
  mcpToolCalls,
  prFeedbackPosts,
  assistantMessages,
} from '../../server/database/schema';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { getAppSetting, setAppSetting } from '../../server/utils/app-settings';
import { PR_FEEDBACK_KEY } from '#shared/pr-feedback';
import { AUTO_HEAL_KEY } from '#shared/auto-heal';
import { compareVersions } from '#shared/piwi-env-vars';
import {
  CAPABILITIES,
  CAPABILITY_BY_ID,
  CAPABILITIES_SETTING_KEY,
  parseInstanceDecisions,
  resolveCapabilities,
  type CapabilityFacts,
  type CapabilityId,
  type CapabilityState,
  type InstanceDecision,
} from '#shared/capabilities';

import type { DrizzleDB } from './db';

/** Stable ids — the UI keys its copy off these. */
export type SetupCapabilityId =
  | 'reporter'
  | 'fixtures'
  | 'locator-healing'
  | 'backend-logs'
  | 'coverage'
  | 'clustering'
  | 'ai'
  | 'mcp'
  | 'notifications'
  | 'quality-reports'
  | 'pr-feedback'
  | 'auto-heal'
  | 'integrations'
  | 'scm'
  | 'tags'
  | 'markers'
  | 'quarantine'
  | 'green-samples'
  | 'test-map'
  | 'server-probes'
  | 'bug-reports'
  | 'flake-lab'
  | 'resources'
  | 'agent-diagnoses'
  | 'agent-write-log'
  | 'assistant';

export interface SetupCapability {
  id: SetupCapabilityId;
  /** True when the instance has evidence this capability is doing something. */
  active: boolean;
  /** Resolved instance-level state (evidence, then the stored decision). */
  state: CapabilityState;
  /** The stored instance decision, or `null` when nothing is stored. */
  decision: InstanceDecision | null;
  /** True when the capability's release is newer than the instance's first run. */
  isNew: boolean;
}

export interface SetupStatus {
  capabilities: SetupCapability[];
}

/** `app_settings` key holding the app version recorded at the instance's first Setup read. */
export const FIRST_RUN_VERSION_KEY = 'first-run-version';

/** Evidence for every detection id, `true` when at least one row exists. */
export type CapabilityEvidence = Record<SetupCapabilityId, boolean>;

/** `true` when the table has at least one row matching the (optional) filter. */
async function exists(db: DrizzleDB, query: Promise<unknown[]>): Promise<boolean> {
  const rows = await query;
  return rows.length > 0;
}

// The conditions of the partial indexes `idx_trc_passed_aria`, `idx_trc_passed_retry` and
// `idx_nr_server_traces` (server/database/schema.*.ts), spelled the same way.
const PASSED_WITH_ARIA = sql`${testRunsCases.status} = 'passed' and (${testRunsCases.ariaSnapshotPayloadId} is not null or ${testRunsCases.ariaSnapshot} is not null)`;
const PASSED_ON_RETRY = sql`${testRunsCases.status} = 'passed' and ${testRunsCases.retries} > 0`;
const SERVER_TRACE = sql`${networkRequests.serverTraces} is not null`;

/** How long found evidence stands before a read probes for it again. */
const EVIDENCE_TTL_MS = 60_000;

/** When each detection's evidence was last found, per database and per scope (a project id, or the instance). */
const evidenceFoundAt = new WeakMap<object, Map<number | 'instance', Map<SetupCapabilityId, number>>>();

/**
 * Evidence per detection id. With no `projectId` the probes are instance-wide;
 * with one, the project-level detections (fixtures, backend logs, locator
 * healing, green samples, quarantine, markers, the SCM token, and the reporter
 * and clustering rows) are scoped through the project's runs and cases. The
 * instance-shaped detections (AI, notifications, tags, quality reports) stay instance-wide
 * because they carry no project dimension.
 *
 * Every page reads capability states as it renders, so evidence once found is
 * kept for a minute per database and scope, and only the detections still
 * without evidence are probed again: a capability's first row shows at once,
 * its last row's removal within a minute. `fresh` probes them all (the Setup
 * page reports what is live).
 */
export async function getCapabilityEvidence(
  db: DrizzleDB,
  projectId?: number,
  options: { fresh?: boolean } = {},
): Promise<CapabilityEvidence> {
  const scope = typeof projectId === 'number' ? projectId : 'instance';
  const scopes = evidenceFoundAt.get(db) ?? new Map<number | 'instance', Map<SetupCapabilityId, number>>();
  evidenceFoundAt.set(db, scopes);
  const foundAt = scopes.get(scope) ?? new Map<SetupCapabilityId, number>();
  scopes.set(scope, foundAt);

  const probes = evidenceProbes(db, projectId);
  const ids = Object.keys(probes) as SetupCapabilityId[];
  const now = Date.now();
  const answers = await Promise.all(
    ids.map(async (id) => {
      const at = foundAt.get(id);
      if (!options.fresh && at !== undefined && now - at < EVIDENCE_TTL_MS) return true;
      const found = await probes[id]();
      if (found) foundAt.set(id, now);
      else foundAt.delete(id);
      return found;
    }),
  );
  return Object.fromEntries(ids.map((id, i) => [id, answers[i]])) as CapabilityEvidence;
}

/**
 * One probe per detection id, answering whether its evidence exists. The
 * probes that look for rare rows in the largest tables (green samples, retry
 * passes, server traces) match a partial index each; their conditions are
 * written as literals, which is what lets a cached PostgreSQL plan use the
 * index.
 */
function evidenceProbes(db: DrizzleDB, projectId?: number): Record<SetupCapabilityId, () => Promise<boolean>> {
  const scoped = typeof projectId === 'number';
  const pid = projectId as number;

  return {
    reporter: () =>
      exists(
        db,
        scoped
          ? db.select({ id: testRuns.id }).from(testRuns).where(eq(testRuns.projectId, pid)).limit(1)
          : db.select({ id: testRuns.id }).from(testRuns).limit(1),
      ),
    fixtures: () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: networkRequests.id })
              .from(networkRequests)
              .innerJoin(testRuns, eq(networkRequests.testRunId, testRuns.id))
              .where(eq(testRuns.projectId, pid))
              .limit(1)
          : db.select({ id: networkRequests.id }).from(networkRequests).limit(1),
      ),
    'locator-healing': () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: locatorSnapshots.id })
              .from(locatorSnapshots)
              .innerJoin(testCases, eq(locatorSnapshots.testCaseId, testCases.id))
              .where(eq(testCases.projectId, pid))
              .limit(1)
          : db.select({ id: locatorSnapshots.id }).from(locatorSnapshots).limit(1),
      ),
    'backend-logs': () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: networkRequests.id })
              .from(networkRequests)
              .innerJoin(testRuns, eq(networkRequests.testRunId, testRuns.id))
              .where(and(eq(testRuns.projectId, pid), SERVER_TRACE))
              .limit(1)
          : db.select({ id: networkRequests.id }).from(networkRequests).where(SERVER_TRACE).limit(1),
      ),
    // Coverage: active once a test's coverage of a file is stored for the project; an uploaded report's
    // fragments (runtime `report`) are no test's.
    coverage: () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: coverageFragments.id })
              .from(coverageFragments)
              .where(and(eq(coverageFragments.projectId, pid), sql`${coverageFragments.runtime} <> 'report'`))
              .limit(1)
          : db
              .select({ id: coverageFragments.id })
              .from(coverageFragments)
              .where(sql`${coverageFragments.runtime} <> 'report'`)
              .limit(1),
      ),
    clustering: () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: failureClusters.id })
              .from(failureClusters)
              .where(eq(failureClusters.projectId, pid))
              .limit(1)
          : db.select({ id: failureClusters.id }).from(failureClusters).limit(1),
      ),
    // AI also counts as active when pinned by environment — an env-configured
    // instance has no `ai` row in app_settings but is very much switched on.
    ai: async () =>
      Boolean(typeof process !== 'undefined' && (process.env?.PIWI_AI_API_KEY || process.env?.PIWI_AI_MODEL)) ||
      exists(db, db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, 'ai')).limit(1)),
    // MCP has no evidence probe — it is always available, so the resolver marks
    // it configured rather than active.
    mcp: async () => false,
    notifications: () => exists(db, db.select({ id: notificationChannels.id }).from(notificationChannels).limit(1)),
    // Quality reports are active once a report schedule or snapshot exists; a
    // schedule spans projects, so this stays instance-wide.
    'quality-reports': async () =>
      (await exists(db, db.select({ id: reportSchedules.id }).from(reportSchedules).limit(1))) ||
      exists(db, db.select({ id: reportSnapshots.id }).from(reportSnapshots).limit(1)),
    // Pull-request feedback is active while its setting is enabled (the flag
    // the full getter resolves, read here directly so this handler stays free
    // of the SCM providers it pulls in) and once something was posted for a run
    // (of the project, when one is scoped). Auto-heal reads active from its
    // setting and issue integrations from a single connection row; neither has
    // a project dimension, so they stay instance-wide.
    'pr-feedback': async () =>
      (await getAppSetting<{ enabled?: boolean }>(db, PR_FEEDBACK_KEY))?.enabled === true &&
      exists(
        db,
        scoped
          ? db
              .select({ id: prFeedbackPosts.id })
              .from(prFeedbackPosts)
              .where(eq(prFeedbackPosts.projectId, pid))
              .limit(1)
          : db.select({ id: prFeedbackPosts.id }).from(prFeedbackPosts).limit(1),
      ),
    'auto-heal': async () => (await getAppSetting<{ enabled?: boolean }>(db, AUTO_HEAL_KEY))?.enabled === true,
    integrations: () => exists(db, db.select({ id: integrationConnections.id }).from(integrationConnections).limit(1)),
    scm: () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: projects.id })
              .from(projects)
              .where(and(eq(projects.id, pid), isNotNull(projects.scmToken)))
              .limit(1)
          : db.select({ id: projects.id }).from(projects).where(isNotNull(projects.scmToken)).limit(1),
      ),
    tags: () => exists(db, db.select({ id: tags.id }).from(tags).limit(1)),
    markers: () =>
      exists(
        db,
        scoped
          ? db.select({ id: markers.id }).from(markers).where(eq(markers.projectId, pid)).limit(1)
          : db.select({ id: markers.id }).from(markers).limit(1),
      ),
    quarantine: () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: quarantinedTests.id })
              .from(quarantinedTests)
              .where(eq(quarantinedTests.projectId, pid))
              .limit(1)
          : db.select({ id: quarantinedTests.id }).from(quarantinedTests).limit(1),
      ),
    'green-samples': () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: testRunsCases.id })
              .from(testRunsCases)
              .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
              .where(and(eq(testRuns.projectId, pid), PASSED_WITH_ARIA))
              .limit(1)
          : db.select({ id: testRunsCases.id }).from(testRunsCases).where(PASSED_WITH_ARIA).limit(1),
      ),
    // The Test Map is active once the graph has any node for the project (a
    // route or page discovered from a run), or, instance-wide, any node at all.
    'test-map': () =>
      exists(
        db,
        scoped
          ? db.select({ id: graphNodes.id }).from(graphNodes).where(eq(graphNodes.projectId, pid)).limit(1)
          : db.select({ id: graphNodes.id }).from(graphNodes).limit(1),
      ),
    // Server probes are active once a server-level probe has run for the project.
    'server-probes': () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: probes.id })
              .from(probes)
              .where(and(eq(probes.projectId, pid), eq(probes.level, 'server')))
              .limit(1)
          : db.select({ id: probes.id }).from(probes).where(eq(probes.level, 'server')).limit(1),
      ),
    // Bug reports are active once Piwi Picker has sent one.
    'bug-reports': () =>
      exists(
        db,
        scoped
          ? db.select({ id: bugReports.id }).from(bugReports).where(eq(bugReports.projectId, pid)).limit(1)
          : db.select({ id: bugReports.id }).from(bugReports).limit(1),
      ),
    // Flake suspects read from history: active once a test has passed on a retry.
    'flake-lab': () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: testRunsCases.id })
              .from(testRunsCases)
              .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
              .where(and(eq(testRuns.projectId, pid), PASSED_ON_RETRY))
              .limit(1)
          : db.select({ id: testRunsCases.id }).from(testRunsCases).where(PASSED_ON_RETRY).limit(1),
      ),
    // Resources: active once a reporter sent a run's resource report.
    resources: () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: testRunResourceReports.id })
              .from(testRunResourceReports)
              .innerJoin(testRuns, eq(testRunResourceReports.runId, testRuns.id))
              .where(eq(testRuns.projectId, pid))
              .limit(1)
          : db.select({ id: testRunResourceReports.id }).from(testRunResourceReports).limit(1),
      ),
    // Agent diagnoses: active once an agent recorded a diagnosis.
    'agent-diagnoses': () =>
      exists(
        db,
        scoped
          ? db
              .select({ id: failureDiagnoses.id })
              .from(failureDiagnoses)
              .innerJoin(failureClusters, eq(failureDiagnoses.clusterId, failureClusters.id))
              .where(and(eq(failureClusters.projectId, pid), eq(failureDiagnoses.provider, 'agent')))
              .limit(1)
          : db
              .select({ id: failureDiagnoses.id })
              .from(failureDiagnoses)
              .where(eq(failureDiagnoses.provider, 'agent'))
              .limit(1),
      ),
    // The agents' write log: active once a write tool was called over MCP. It spans projects.
    'agent-write-log': () => exists(db, db.select({ id: mcpToolCalls.id }).from(mcpToolCalls).limit(1)),
    // The assistant: active once a question was stored. Conversations are private and span projects.
    assistant: () => exists(db, db.select({ id: assistantMessages.id }).from(assistantMessages).limit(1)),
  };
}

/** Read and validate the stored instance decisions. */
export async function getInstanceDecisions(db: DrizzleDB): Promise<Partial<Record<CapabilityId, InstanceDecision>>> {
  return parseInstanceDecisions(await getAppSetting(db, CAPABILITIES_SETTING_KEY));
}

/** The detection ids that are core capabilities with no decline control. */
const CORE_LADDER_IDS = new Set<SetupCapabilityId>(['reporter', 'clustering']);

const SETUP_LADDER_ORDER: SetupCapabilityId[] = [
  'reporter',
  'fixtures',
  'locator-healing',
  'backend-logs',
  'coverage',
  'clustering',
  'ai',
  'mcp',
  'notifications',
  'quality-reports',
  'pr-feedback',
  'auto-heal',
  'integrations',
  'scm',
  'tags',
  'markers',
  'quarantine',
  'green-samples',
  'test-map',
  'server-probes',
  'bug-reports',
  'flake-lab',
  'resources',
  'agent-diagnoses',
  'agent-write-log',
  'assistant',
];

/**
 * Build the instance-level facts for one detection id from its evidence and the
 * stored instance decisions. `backend-logs` and `server-probes` are applicable
 * only where a server trace has arrived; `mcp` is always available even with no
 * evidence.
 */
function instanceFacts(
  id: CapabilityId,
  evidence: CapabilityEvidence,
  decisions: Partial<Record<CapabilityId, InstanceDecision>>,
): CapabilityFacts {
  const has = (evidence as Record<string, boolean>)[id] ?? false;
  const hasServerTrace = evidence['backend-logs'];
  return {
    evidence: has,
    configured: id === 'mcp' ? true : undefined,
    applicable: id === 'backend-logs' ? has : id === 'server-probes' ? hasServerTrace : true,
    instanceDecision: decisions[id],
  };
}

/** Instance-level facts for every capability, ready for {@link resolveCapabilities}. */
export function buildInstanceFacts(
  evidence: CapabilityEvidence,
  decisions: Partial<Record<CapabilityId, InstanceDecision>>,
): Partial<Record<CapabilityId, CapabilityFacts>> {
  const facts: Partial<Record<CapabilityId, CapabilityFacts>> = {};
  for (const def of CAPABILITIES) facts[def.id] = instanceFacts(def.id, evidence, decisions);
  return facts;
}

/** The resolved instance state for every capability. */
export async function resolveInstanceStates(db: DrizzleDB): Promise<Record<CapabilityId, CapabilityState>> {
  const [evidence, decisions] = await Promise.all([getCapabilityEvidence(db), getInstanceDecisions(db)]);
  return resolveCapabilities(buildInstanceFacts(evidence, decisions));
}

/**
 * The Setup ladder for every capability, plus the two core rows.
 *
 * `appVersion` is the running app version; the first time it is supplied on an
 * instance the version is recorded under {@link FIRST_RUN_VERSION_KEY}, and every
 * later read marks a row `isNew` when its release is newer than that recorded
 * version, so a capability added after the instance started is flagged once.
 */
export async function getSetupStatus(db: DrizzleDB, appVersion?: string): Promise<SetupStatus> {
  const evidence = await getCapabilityEvidence(db, undefined, { fresh: true });
  const decisions = await getInstanceDecisions(db);
  const states = resolveCapabilities(buildInstanceFacts(evidence, decisions));

  const firstRunVersion = await resolveFirstRunVersion(db, appVersion);
  const isNewSince = (since: string | null): boolean =>
    Boolean(since && firstRunVersion && compareVersions(since, firstRunVersion) > 0);

  const capabilities: SetupCapability[] = SETUP_LADDER_ORDER.map((id) => {
    const active = evidence[id];
    if (CORE_LADDER_IDS.has(id)) {
      return { id, active, state: active ? 'active' : 'undecided', decision: null, isNew: false };
    }
    const def = CAPABILITY_BY_ID[id as CapabilityId];
    return {
      id,
      active,
      state: states[id as CapabilityId],
      decision: decisions[id as CapabilityId] ?? null,
      isNew: isNewSince(def?.since ?? null),
    };
  });

  return { capabilities };
}

/**
 * Read the recorded first-run version, writing the current one the first time an
 * instance is asked. Returns the version to compare `since` against, or null
 * when none is known yet (a fresh instance with no version supplied).
 */
async function resolveFirstRunVersion(db: DrizzleDB, appVersion?: string): Promise<string | null> {
  const recorded = await getAppSetting<string>(db, FIRST_RUN_VERSION_KEY);
  if (recorded) return recorded;
  if (appVersion) {
    await setAppSetting(db, FIRST_RUN_VERSION_KEY, appVersion);
    return appVersion;
  }
  return null;
}
