/**
 * The registry of optional capabilities a team can switch on, and the one
 * resolver every surface reads to decide whether to show one.
 *
 * The three things every instance uses — run history with traces, failure
 * clustering and flaky scoring — are the core and never appear here: they
 * cannot be declined. Everything listed is optional, belongs to exactly one
 * module, and can be declined at instance level, at project level, or both.
 *
 * Kept free of server-only imports so the browser and the demo can import it.
 * The `SetupCapabilityId` and `FeatureNeed` references are type-only, so no
 * server code (Drizzle, the schema) rides along into those bundles. Detection
 * queries live in `shared/handlers/`; the copy for the Setup ladder lives in
 * `app/utils/setup-capabilities.ts`.
 */
import type { SetupCapabilityId } from '#shared/handlers/setup-status';
import type { FeatureNeed } from '#shared/piwi-features';

export type CapabilityId =
  | 'fixtures'
  | 'green-samples'
  | 'locator-healing'
  | 'backend-logs'
  | 'coverage'
  | 'scm'
  | 'ai'
  | 'mcp'
  | 'notifications'
  | 'quality-reports'
  | 'pr-feedback'
  | 'auto-heal'
  | 'integrations'
  | 'quarantine'
  | 'tags'
  | 'markers'
  | 'test-map'
  | 'server-probes'
  | 'bug-reports'
  | 'flake-lab'
  | 'resources'
  | 'agent-diagnoses'
  | 'agent-write-log'
  | 'assistant';

export type CapabilityModule = 'core' | 'workflow' | 'healing' | 'agents';
export type CapabilityLevel = 'instance' | 'project';

/** The resolved answer for one capability in one context. */
export type CapabilityState = 'active' | 'available' | 'declined' | 'not-applicable' | 'undecided';

/** A stored answer. Instance decisions are `declined` only; projects add `enabled`. */
export type InstanceDecision = 'declined';
export type ProjectDecision = 'declined' | 'enabled';

export interface CapabilityDef {
  id: CapabilityId;
  module: CapabilityModule;
  /** Where a decision may be stored. Project-level capabilities accept both. */
  levels: CapabilityLevel[];
  /** Prerequisites, reusing the feature catalog's vocabulary. */
  needs: FeatureNeed[];
  /** Detection id in `setup-status.ts`, when evidence exists for it. */
  detection: SetupCapabilityId | null;
  /**
   * The capability's evidence does not mean a team chose it: it arrives
   * passively from ingest (the Test Map's graph nodes are written on every run)
   * or from use (a question someone asked the assistant). For such a capability
   * a decline holds over that data, so declining it actually turns the surface
   * off; every other capability keeps the "data always wins" rule.
   */
  passiveData?: boolean;
  /** A capability that is declined whenever this one is (rides on it). */
  follows?: CapabilityId;
  /** Release that introduced it; the Setup ladder marks entries newer than the instance's first run. */
  since: string;
  doc: string;
}

export const CAPABILITIES: CapabilityDef[] = [
  {
    id: 'fixtures',
    module: 'core',
    levels: ['instance', 'project'],
    needs: ['fixtures'],
    detection: 'fixtures',
    since: '0.3.0',
    doc: 'guide/capture-fixtures',
  },
  {
    id: 'green-samples',
    module: 'core',
    levels: ['project'],
    needs: ['fixtures'],
    detection: 'green-samples',
    follows: 'fixtures',
    since: '0.5.0',
    doc: 'features/evidence',
  },
  {
    id: 'locator-healing',
    module: 'healing',
    levels: ['instance', 'project'],
    needs: ['fixtures'],
    detection: 'locator-healing',
    follows: 'fixtures',
    since: '0.5.0',
    doc: 'features/locator-healing',
  },
  {
    id: 'backend-logs',
    module: 'core',
    levels: ['instance', 'project'],
    needs: ['fixtures', 'backend'],
    detection: 'backend-logs',
    since: '0.3.0',
    doc: 'guide/backend-logs',
  },
  {
    id: 'coverage',
    module: 'core',
    levels: ['instance', 'project'],
    needs: ['fixtures'],
    detection: 'coverage',
    since: '0.54.0',
    doc: 'features/code-reach',
  },
  {
    id: 'scm',
    module: 'core',
    levels: ['instance', 'project'],
    needs: ['scm'],
    detection: 'scm',
    since: '0.7.0',
    doc: 'guide/source-control',
  },
  {
    id: 'ai',
    module: 'agents',
    levels: ['instance'],
    needs: ['llm'],
    detection: 'ai',
    since: '0.3.0',
    doc: 'guide/ai-provider',
  },
  {
    id: 'mcp',
    module: 'core',
    levels: ['instance'],
    needs: [],
    detection: null,
    since: '0.3.0',
    doc: 'features/mcp',
  },
  {
    id: 'notifications',
    module: 'workflow',
    levels: ['instance'],
    needs: [],
    detection: 'notifications',
    since: '0.3.0',
    doc: 'features/notifications',
  },
  {
    id: 'quality-reports',
    module: 'workflow',
    levels: ['instance'],
    needs: [],
    detection: 'quality-reports',
    since: '0.39.0',
    doc: 'features/quality-reports',
  },
  {
    id: 'pr-feedback',
    module: 'workflow',
    levels: ['instance'],
    needs: ['scm'],
    detection: null,
    since: '0.19.0',
    doc: 'features/pr-feedback',
  },
  {
    id: 'auto-heal',
    module: 'healing',
    levels: ['instance'],
    needs: ['fixtures', 'scm'],
    detection: null,
    since: '0.26.0',
    doc: 'features/auto-heal',
  },
  {
    id: 'integrations',
    module: 'workflow',
    levels: ['instance'],
    needs: [],
    detection: null,
    since: '0.29.0',
    doc: 'features/issue-tracking',
  },
  {
    id: 'quarantine',
    module: 'workflow',
    levels: ['instance', 'project'],
    needs: [],
    detection: 'quarantine',
    since: '0.19.0',
    doc: 'features/flaky-tests',
  },
  {
    id: 'tags',
    module: 'core',
    levels: ['instance'],
    needs: [],
    detection: 'tags',
    since: '0.1.0',
    doc: 'guide/reporter',
  },
  {
    id: 'markers',
    module: 'core',
    levels: ['project'],
    needs: [],
    detection: 'markers',
    since: '0.15.0',
    doc: 'features/timeline-markers',
  },
  {
    id: 'test-map',
    module: 'workflow',
    levels: ['instance', 'project'],
    needs: ['fixtures'],
    detection: 'test-map',
    passiveData: true,
    since: '0.36.0',
    doc: 'features/scenario-gaps',
  },
  {
    id: 'server-probes',
    module: 'workflow',
    levels: ['project'],
    needs: ['fixtures', 'backend'],
    detection: 'server-probes',
    follows: 'test-map',
    since: '0.36.0',
    doc: 'features/probes#server-probes',
  },
  {
    id: 'bug-reports',
    module: 'workflow',
    levels: ['instance', 'project'],
    needs: ['extension'],
    detection: 'bug-reports',
    since: '0.41.0',
    doc: 'features/bug-reports',
  },
  {
    id: 'flake-lab',
    module: 'workflow',
    levels: ['instance', 'project'],
    needs: [],
    detection: 'flake-lab',
    passiveData: true,
    since: '0.41.0',
    doc: 'features/flaky-tests',
  },
  {
    id: 'resources',
    module: 'workflow',
    levels: ['instance', 'project'],
    needs: [],
    detection: 'resources',
    passiveData: true,
    since: '0.45.0',
    doc: 'features/resource-leaks',
  },
  {
    id: 'agent-diagnoses',
    module: 'agents',
    levels: ['instance', 'project'],
    needs: [],
    detection: 'agent-diagnoses',
    passiveData: true,
    since: '0.46.0',
    doc: 'features/ai-diagnosis',
  },
  {
    id: 'agent-write-log',
    module: 'agents',
    levels: ['instance'],
    needs: [],
    detection: 'agent-write-log',
    passiveData: true,
    since: '0.46.0',
    doc: 'features/mcp',
  },
  {
    id: 'assistant',
    module: 'agents',
    levels: ['instance'],
    needs: ['llm'],
    detection: 'assistant',
    passiveData: true,
    follows: 'ai',
    since: '0.59.0',
    doc: 'features/assistant',
  },
];

/** The registry keyed by id, for a direct lookup. */
export const CAPABILITY_BY_ID: Record<CapabilityId, CapabilityDef> = Object.fromEntries(
  CAPABILITIES.map((c) => [c.id, c]),
) as Record<CapabilityId, CapabilityDef>;

/** Every module, in the order the presets ask about them. */
export const CAPABILITY_MODULES: CapabilityModule[] = ['core', 'workflow', 'healing', 'agents'];

/** The capabilities belonging to one module. */
export function capabilitiesForModule(module: CapabilityModule): CapabilityId[] {
  return CAPABILITIES.filter((c) => c.module === module).map((c) => c.id);
}

/**
 * One preset the Home wizard and the Setup page offer under
 * "What do you want Piwi for?". `core` is always on and shown without a toggle;
 * the rest are the optional modules a team can decline in one click.
 */
export interface CapabilityPreset {
  module: CapabilityModule;
  label: string;
  description: string;
}

export const CAPABILITY_PRESETS: CapabilityPreset[] = [
  {
    module: 'core',
    label: 'See why tests fail',
    description: 'Run history, traces, failure clusters and flaky scoring.',
  },
  {
    module: 'workflow',
    label: 'Triage as a team',
    description: 'Notifications, quarantine, pull-request feedback, issue tracking and the Test Map.',
  },
  { module: 'healing', label: 'Fix faster', description: 'Locator healing and auto-heal pull requests.' },
  { module: 'agents', label: 'Let agents in', description: 'AI diagnosis over your real diff, and the assistant.' },
];

/** Facts about one capability in one context, gathered by the shared handler. */
export interface CapabilityInput {
  /** Data exists (project-scoped where the level allows). */
  evidence: boolean;
  /** Set up but no evidence yet: an AI key, an SCM token, a channel. */
  configured?: boolean;
  /** Default true; false → not-applicable. */
  applicable?: boolean;
  instanceDecision?: InstanceDecision;
  projectDecision?: ProjectDecision;
  /** Resolved state of `def.follows`. */
  followedState?: CapabilityState;
}

/**
 * Resolve one capability's state from its facts. The single answer every
 * surface reads, so "declined hides it everywhere" is a property, not a
 * checklist.
 *
 * Precedence, in order: data always wins (a declined capability that starts
 * receiving data reads active) — except a `passiveData` capability, whose data
 * arrives from ingest rather than from being turned on, where a decline holds
 * over the data; a project decline; a project enable, which overrides the
 * instance decline and the followed capability; an instance decline or a
 * declined capability this one follows; not-applicable; and finally
 * configured-but-empty (available) versus nothing at all (undecided).
 */
export function resolveCapability(def: CapabilityDef, input: CapabilityInput): CapabilityState {
  // A decline reached through the decision hierarchy, evidence aside: a project
  // decline, or — absent a project enable — an instance decline or a declined
  // followed capability. A project enable always overrides an instance decline.
  const declinedByDecision =
    input.projectDecision === 'declined' ||
    (input.projectDecision !== 'enabled' &&
      (input.instanceDecision === 'declined' || input.followedState === 'declined'));

  if (input.evidence && !(def.passiveData && declinedByDecision)) return 'active';
  if (input.projectDecision === 'declined') return 'declined';
  if (input.projectDecision === 'enabled') {
    return input.configured ? 'available' : 'undecided';
  }
  if (input.instanceDecision === 'declined' || input.followedState === 'declined') return 'declined';
  if (input.applicable === false) return 'not-applicable';
  return input.configured ? 'available' : 'undecided';
}

/** The facts one capability is resolved from, before `followedState` is filled in. */
export type CapabilityFacts = Omit<CapabilityInput, 'followedState'>;

/**
 * Resolve every capability at once, filling each follower's `followedState`
 * from its target's already-resolved state. A `follows` target must not itself
 * follow another capability (the registry's targets, `fixtures` and `test-map`,
 * are both non-followers), which lets a single pass over the non-followers
 * precede the followers.
 */
export function resolveCapabilities(
  facts: Partial<Record<CapabilityId, CapabilityFacts>>,
): Record<CapabilityId, CapabilityState> {
  const out = {} as Record<CapabilityId, CapabilityState>;
  const resolveOne = (def: CapabilityDef) => {
    const f = facts[def.id] ?? { evidence: false };
    return resolveCapability(def, { ...f, followedState: def.follows ? out[def.follows] : undefined });
  };
  for (const def of CAPABILITIES) if (!def.follows) out[def.id] = resolveOne(def);
  for (const def of CAPABILITIES) if (def.follows) out[def.id] = resolveOne(def);
  return out;
}

/** `app_settings` key holding the instance decisions, shaped `{ decisions }`. */
export const CAPABILITIES_SETTING_KEY = 'capabilities';

const CAPABILITY_IDS = new Set<string>(CAPABILITIES.map((c) => c.id));

function isCapabilityId(value: string): value is CapabilityId {
  return CAPABILITY_IDS.has(value);
}

/** Keep only known ids mapped to `declined`; drop anything else. */
export function parseInstanceDecisions(raw: unknown): Partial<Record<CapabilityId, InstanceDecision>> {
  const decisions = (raw as { decisions?: unknown } | null)?.decisions;
  const out: Partial<Record<CapabilityId, InstanceDecision>> = {};
  if (decisions && typeof decisions === 'object') {
    for (const [id, value] of Object.entries(decisions as Record<string, unknown>)) {
      if (isCapabilityId(id) && value === 'declined') out[id] = 'declined';
    }
  }
  return out;
}

/** Keep only known ids mapped to `declined`/`enabled`; drop anything else. */
export function parseProjectDecisions(raw: unknown): Partial<Record<CapabilityId, ProjectDecision>> {
  const out: Partial<Record<CapabilityId, ProjectDecision>> = {};
  if (raw && typeof raw === 'object') {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (isCapabilityId(id) && (value === 'declined' || value === 'enabled')) out[id] = value;
    }
  }
  return out;
}

/**
 * Fold a patch of decisions onto the current set. A `null` value clears the
 * decision for that id; a known value replaces it. Instance decisions accept
 * only `declined`; project decisions also accept `enabled`.
 */
export function applyDecisionPatch<V extends InstanceDecision | ProjectDecision>(
  current: Partial<Record<CapabilityId, V>>,
  patch: Record<string, unknown>,
  allowEnabled: boolean,
): Partial<Record<CapabilityId, V>> {
  const next = { ...current };
  for (const [id, value] of Object.entries(patch)) {
    if (!isCapabilityId(id)) continue;
    if (value === null) {
      delete next[id];
    } else if (value === 'declined' || (allowEnabled && value === 'enabled')) {
      next[id] = value as V;
    }
  }
  return next;
}
