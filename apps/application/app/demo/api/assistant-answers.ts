/**
 * The demo assistant's prepared answers. The demo has no AI model, so each
 * prepared question (`shared/demo/assistant-questions.mjs`) gets an answer
 * computed from the in-browser database through the handlers the server's
 * read tools call: what it read (the read tool the server's assistant would
 * call, with the entities its result named), its text and its blocks, each
 * block made through the checks a model's block tool passes
 * (`checkAssistantBlock`), its guides from the anchor registry, its proposals
 * held to the action's permission on the target's project. A reply to a
 * block of an earlier answer (a pick among flaky tests, a CI provider, a way
 * to fix) gets the answer that follows from it. A question no prepared
 * answer matches gets one saying what the demo answers on that page, with the
 * authored guides.
 */
import { eq } from 'drizzle-orm';
import {
  assistantEntityRoute,
  type AssistantBlock,
  type AssistantEntityRef,
  type AssistantEntityType,
  type AssistantGuidePlan,
  type AssistantGuideStop,
  type AssistantMessageView,
  type AssistantPageContext,
  type AssistantToolCall,
} from '#shared/assistant';
import { checkAssistantBlock, type AssistantBlockTool, type AssistantToolBlock } from '#shared/assistant-blocks';
import { ASSISTANT_ACTIONS, type AssistantActionId } from '#shared/assistant-actions';
import type { AssistantRecordedReply } from '#shared/handlers/assistant';
import type { DrizzleDB } from '#shared/handlers/db';
import { can, holdsAnywhere, type AccessSummary } from '#shared/permissions';
import type { CapabilityId, CapabilityState } from '#shared/capabilities';
import { resolveProjectStates } from '#shared/handlers/capabilities';
import { resolveInstanceStates } from '#shared/handlers/setup-status';
import { getFailureClues, getTestRunCase } from '#shared/handlers/test-cases';
import { getClusterDiagnosis, getFailureCluster, getOpenFailureClusters } from '#shared/handlers/failure-clusters';
import { getProject, getProjectFlakyTests, listProjects } from '#shared/handlers/projects';
import { RELEASE_AFTER_CONSECUTIVE_PASSES, getQuarantinedCaseIds } from '#shared/handlers/quarantine';
import { buildExecutionReproduce } from '#shared/handlers/reproduce';
import { computeRunInsights } from '#shared/handlers/run-insights';
import { describeCluster } from '#shared/describe-cluster';
import { patchValidationLabel, storedPatchValidation } from '#shared/patch';
import { POSITIONING } from '#shared/piwi-ecosystem';
import { HELP_TOPICS, type HelpTopic, type HelpTopicKey } from '#shared/help-content';
import { GUIDE_ANCHORS, GUIDE_ANCHOR_BY_ID, type GuideAnchor } from '#shared/guide-anchors/index.mjs';
import {
  anchorUnavailable,
  guideMarkupProblem,
  needsRoute,
  rankAnchors,
  type AnchorFacts,
} from '#shared/guide-anchor-search';
import { routeOnPage } from '#shared/guide-stops';
import {
  DEMO_ASSISTANT_QUESTIONS,
  demoQuestionsFor,
  type DemoAssistantAnswer,
} from '#shared/demo/assistant-questions.mjs';
import { failureClusters, testCases, testRuns, testRunsCases } from '~~/server/database/schema';
import { AssistantEntitySet, extractEntities } from '~~/server/utils/assistant/entities';
import { getLocatorHealing } from '~~/server/utils/locator-healing';
import { AUTHORED_GUIDES } from '../../utils/guides/guides';
import { authoredGuideRun, guideAvailable, guideResolvers } from '../../utils/guides/run';
import { resolveGuideIds, type GuideApiGet } from '../../utils/guides/resolvers';
import type { AuthoredGuide } from '../../utils/guides/types';
import { matchDemoQuestion } from './assistant-match';

type ProjectScope = 'all' | Set<number>;

/** What an answer reads with, and who asks. */
export interface DemoAnswerEnv {
  db: DrizzleDB;
  access: AccessSummary;
  /** The projects the user reads. */
  scope: ProjectScope;
  /** Reads a route of the demo's API as the user: the authored guides' resolvers read through it. */
  get: GuideApiGet;
}

/** A reply to a block of an earlier answer, as recorded on the block. */
export interface DemoReply {
  blockId: string;
  picked: AssistantRecordedReply['picked'];
  /** The answer holding the block. */
  answer: AssistantMessageView;
}

export interface DemoQuestion {
  text: string;
  context: AssistantPageContext | null;
  reply: DemoReply | null;
  /** The conversation's messages before this question, whose reads name the entities it may link. */
  earlier: readonly AssistantMessageView[];
}

export type DemoAnswerPart =
  | { kind: 'tool'; call: AssistantToolCall }
  | { kind: 'text'; text: string }
  | { kind: 'block'; block: AssistantToolBlock };

export interface DemoAnswer {
  /** Which answer it is: a prepared one, or `prepared-questions` when none matched. */
  answer: DemoAssistantAnswer | 'prepared-questions';
  /** In order: what it read, its text and its blocks. */
  parts: DemoAnswerPart[];
  /** Blocks a check refused, which the answer left out; a prepared answer makes none. */
  refused: string[];
}

/** The block ids a reply is read by: the block of an earlier answer it answers. */
const BLOCK = {
  fixWays: 'ways-to-fix',
  flakyPicks: 'flaky-tests-to-quarantine',
  ciProvider: 'ci-provider',
  prepared: 'prepared-questions',
} as const;

/** The CI systems the CI answer writes a pipeline for, and what the seed's runs call them. */
const CI_PROVIDERS = [
  { id: 'github-actions', label: 'GitHub Actions' },
  { id: 'gitlab-ci', label: 'GitLab CI' },
  { id: 'azure-pipelines', label: 'Azure Pipelines' },
  { id: 'jenkins', label: 'Jenkins' },
  { id: 'other', label: 'Another CI' },
] as const;

type CiProviderId = (typeof CI_PROVIDERS)[number]['id'];

/** The address the commands name for the instance: the demo has none of its own to report to. */
const INSTANCE_URL = 'https://piwi.example.com';

/** The most flaky tests the question lists, and how many are ticked when it appears. */
const FLAKY_CHOICES = 8;
const FLAKY_PRECHECKED = 3;

/** The most clues the failure answer lists. */
const CLUES_LISTED = 3;

/** An entity's label as link text: the brackets that would end it escaped. */
function linkText(label: string): string {
  return label.replace(/([[\]\\])/g, '\\$1');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** The project of an entity a proposal targets, or null when it is missing. */
async function projectOf(db: DrizzleDB, type: AssistantEntityType, id: number): Promise<number | null> {
  if (type === 'project') return id;
  if (type === 'test-case') {
    const [row] = await db.select({ projectId: testCases.projectId }).from(testCases).where(eq(testCases.id, id));
    return row?.projectId ?? null;
  }
  if (type === 'cluster') {
    const [row] = await db
      .select({ projectId: failureClusters.projectId })
      .from(failureClusters)
      .where(eq(failureClusters.id, id));
    return row?.projectId ?? null;
  }
  if (type === 'run') {
    const [row] = await db.select({ projectId: testRuns.projectId }).from(testRuns).where(eq(testRuns.id, id));
    return row?.projectId ?? null;
  }
  const [row] = await db
    .select({ projectId: testRuns.projectId })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(testRunsCases.id, id));
  return row?.projectId ?? null;
}

/**
 * One answer as it is written: its reads, which name the entities it may
 * link, show as a card or offer as a choice; its text; and its blocks, each
 * checked as a model's block tool is.
 */
class AnswerWriter {
  readonly parts: DemoAnswerPart[] = [];
  readonly refused: string[] = [];
  private readonly entities: AssistantEntitySet;
  private readonly usedIds = new Set<string>();
  private states: Promise<Record<CapabilityId, CapabilityState>> | null = null;
  private readonly projectStates = new Map<number, Record<CapabilityId, CapabilityState>>();

  constructor(
    readonly env: DemoAnswerEnv,
    readonly question: DemoQuestion,
  ) {
    this.entities = new AssistantEntitySet(
      question.earlier.flatMap((message) => message.toolCalls.flatMap((call) => call.entities ?? [])),
    );
  }

  /** The instance's capability states, read once per answer. */
  capabilityStates(): Promise<Record<CapabilityId, CapabilityState>> {
    this.states ??= resolveInstanceStates(this.env.db);
    return this.states;
  }

  /** The capability states of `projectId` (its decisions over the instance's), read once per answer. */
  async projectCapabilityStates(projectId: number): Promise<Record<CapabilityId, CapabilityState>> {
    let states = this.projectStates.get(projectId);
    if (!states) {
      states = await resolveProjectStates(this.env.db, projectId);
      this.projectStates.set(projectId, states);
    }
    return states;
  }

  /**
   * What an anchor's `requires` is checked against, with the capability
   * states of the project the question's page shows read into it: an anchor
   * on that project's pages follows them.
   */
  async anchorFacts(): Promise<AnchorFacts> {
    const projectId = this.question.context?.projectId;
    if (projectId != null) await this.projectCapabilityStates(projectId);
    return {
      states: await this.capabilityStates(),
      projectStates: this.projectStates,
      access: this.env.access,
      desktop: false,
    };
  }

  /** Whether the user reads the project. */
  reads(projectId: number | null | undefined): boolean {
    if (projectId == null) return false;
    return this.env.scope === 'all' || this.env.scope.has(projectId);
  }

  /** Records a read: the read tool the server's assistant calls for it, a line for a person, and what it returned. */
  read<T>(name: string, args: Record<string, unknown>, summary: string, result: T): T {
    const found = extractEntities(name, result);
    this.entities.add(found);
    const entities = found.map(({ type, id, label }) => ({ type, id, label }));
    this.parts.push({
      kind: 'tool',
      call: { name, arguments: args, summary, ...(entities.length ? { entities } : {}) },
    });
    return result;
  }

  /** Writes paragraphs of Markdown; empty ones are left out. */
  text(...paragraphs: Array<string | null | false | undefined>): void {
    const text = paragraphs.filter(Boolean).join('\n\n');
    if (!text) return;
    const last = this.parts.at(-1);
    if (last?.kind === 'text') last.text = `${last.text}\n\n${text}`;
    else this.parts.push({ kind: 'text', text });
  }

  entity(type: AssistantEntityType, id: number): AssistantEntityRef | undefined {
    const found = this.entities.get(type, id);
    return found ? { type: found.type, id: found.id, label: found.label } : undefined;
  }

  /** A Markdown link to an entity a read named, or its label when none did. */
  link(type: AssistantEntityType, id: number, label?: string): string {
    const entity = this.entity(type, id);
    const text = linkText(label ?? entity?.label ?? `${type} ${id}`);
    return entity ? `[${text}](piwi:${type}/${id})` : text;
  }

  /** Makes a block through its block tool's checks; null, and the refusal kept, when one fails. */
  block(tool: AssistantBlockTool, args: Record<string, unknown>): AssistantToolBlock | null {
    const checked = checkAssistantBlock(tool, args, {
      entity: (type, id) => this.entity(type, id),
      usedIds: this.usedIds,
    });
    if (!checked.ok) {
      this.refused.push(`${tool}: ${checked.error}`);
      return null;
    }
    let block = checked.block;
    if (block.kind === 'entity') {
      const status = this.entities.get(block.entity.type, block.entity.id)?.status;
      if (status) block = { ...block, status };
    }
    this.usedIds.add(block.id);
    this.parts.push({ kind: 'block', block });
    return block;
  }

  /** A patch block, with the check against the source its maker made. */
  patch(args: Record<string, unknown>, validation: Extract<AssistantBlock, { kind: 'patch' }>['validation']): void {
    const block = this.block('show_patch', args);
    if (block?.kind === 'patch') block.validation = validation;
  }

  /**
   * A proposal card, shown only when its capability is on for the target's
   * project and the user holds its action's permission there; otherwise the
   * reason, and no card.
   */
  async proposal(args: {
    id: string;
    action: AssistantActionId;
    title: string;
    change: string;
    target: { type: AssistantEntityType; id: number };
    params?: Record<string, unknown>;
  }): Promise<string | null> {
    const action = ASSISTANT_ACTIONS[args.action];
    const projectId = await projectOf(this.env.db, args.target.type, args.target.id);
    if (projectId === null || !this.reads(projectId)) return `you cannot read that ${args.target.type}`;
    if (action.capability) {
      const hidden = (state: CapabilityState) => state === 'declined' || state === 'not-applicable';
      const state = (await this.projectCapabilityStates(projectId))[action.capability];
      if (hidden(state)) {
        const where = hidden((await this.capabilityStates())[action.capability]) ? '' : ' for this project';
        return `the ${action.capability} capability is ${state}${where}`;
      }
    }
    if (!can(this.env.access, action.permission, projectId)) {
      return `it needs the ${action.permission} permission on the project, which you do not hold`;
    }
    const block = this.block('propose_change', { params: {}, ...args });
    if (block?.kind !== 'proposal') return 'the card could not be made';
    block.projectId = projectId;
    return null;
  }

  done(answer: DemoAnswer['answer']): DemoAnswer {
    return { answer, parts: this.parts, refused: this.refused };
  }
}

// ── Guides ────────────────────────────────────────────────────────────────────

const MAX_GUIDE_TITLE = 60;
const MAX_STOP_BODY = 360;

/**
 * A stop's title for an anchor: its help topic's title, else the phrase its
 * description opens with ("The Network tab"), else its id in words.
 */
function anchorTitle(anchor: GuideAnchor): string {
  const topic: HelpTopic | undefined = anchor.help ? HELP_TOPICS[anchor.help as HelpTopicKey] : undefined;
  const helpTitle = topic?.title;
  const lead = /^[^:,.—]+/.exec(anchor.describes)?.[0].trim();
  const title = [helpTitle, lead].find((t) => t && t.length <= MAX_GUIDE_TITLE && !guideMarkupProblem(t));
  if (title) return title;
  const words = anchor.id.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A stop's body for an anchor: what it shows, and when it shows when it does not always. */
function anchorBody(anchor: GuideAnchor): string {
  const body = [anchor.describes, anchor.shownWhen].filter(Boolean).join(' ');
  return body.length > MAX_STOP_BODY ? anchor.describes : body;
}

/**
 * The route a stop at `anchor` opens from the page `context` was asked on:
 * none when the anchor renders there or on a fixed page; the project's page
 * when the anchor is on one and the question names the project; null when
 * the stop has no page to open.
 */
function anchorRoute(anchor: GuideAnchor, context: AssistantPageContext | null): string | undefined | null {
  if (!needsRoute(anchor, context?.route)) return undefined;
  const projectPage = anchor.pages.find((page) => page === '/projects/[id]' || page.startsWith('/projects/[id]/'));
  if (projectPage && context?.projectId) return projectPage.replace('[id]', String(context.projectId));
  return null;
}

/** A stop at a registry anchor, in the anchor's own words, opening the route it needs; null when it has none. */
function anchorStop(anchor: GuideAnchor, context: AssistantPageContext | null): AssistantGuideStop | null {
  const route = anchorRoute(anchor, context);
  if (route === null) return null;
  const stop = { anchor: anchor.id, title: anchorTitle(anchor), body: anchorBody(anchor) };
  if (guideMarkupProblem(stop.body)) return null;
  return route === undefined ? stop : { ...stop, route };
}

/** The anchors on the page the question was asked on, read from the page's route rather than what rendered. */
function onPage(anchor: GuideAnchor, context: AssistantPageContext | null): boolean {
  return Boolean(context?.route) && anchor.pages.some((page) => page !== '*' && routeOnPage(context!.route, page));
}

/**
 * A guide composed from the anchors a query names, as the model composes one
 * from `find_anchors`: the best match, then up to two more on the same page
 * that match at least two thirds as well. Null when no anchor that renders
 * for the user matches.
 */
async function composedGuide(
  w: AnswerWriter,
  query: string,
  context: AssistantPageContext | null,
): Promise<{ plan: AssistantGuidePlan; here: boolean } | null> {
  const facts = await w.anchorFacts();
  const pageContext = context ? { ...context, anchors: undefined } : null;
  const ranked = rankAnchors(query, facts, pageContext).sort(
    (a, b) => Number(onPage(b.anchor, context)) - Number(onPage(a.anchor, context)) || b.score - a.score,
  );
  w.read(
    'find_anchors',
    { query },
    `Searched the dashboard's guide anchors for “${query.length > 60 ? `${query.slice(0, 59)}…` : query}”`,
    { anchors: ranked.map((m) => m.anchor.id) },
  );
  const first = ranked.find((m) => anchorStop(m.anchor, context));
  if (!first) return null;
  const page = first.anchor.pages[0];
  const stops = [
    first,
    ...ranked.filter((m) => m !== first && m.anchor.pages[0] === page && m.score * 3 >= first.score * 2),
  ]
    .slice(0, 3)
    .map((m) => anchorStop(m.anchor, context))
    .filter((stop): stop is AssistantGuideStop => stop !== null);
  return { plan: { title: stops[0]!.title, stops }, here: onPage(first.anchor, context) };
}

/** Whether the user is offered an authored guide: its capability on, its permission held somewhere. */
async function authoredGuideOffered(w: AnswerWriter, guide: AuthoredGuide): Promise<boolean> {
  const states = await w.capabilityStates();
  return guideAvailable(guide, {
    isHidden: (capability) => states[capability] === 'declined' || states[capability] === 'not-applicable',
    holds: (permission) => holdsAnywhere(w.env.access, permission),
  });
}

/** An authored guide as a plan, its entity pages found by its resolvers; its stops with no entity left out. */
async function authoredPlan(w: AnswerWriter, guide: AuthoredGuide): Promise<AssistantGuidePlan | null> {
  const ids = await resolveGuideIds(guideResolvers(guide), w.env.get);
  const stops = authoredGuideRun(guide, ids)
    .stops.filter((stop) => !stop.absent && stop.anchor)
    .map((stop) => ({
      anchor: stop.anchor!,
      ...(stop.route ? { route: stop.route } : {}),
      title: stop.title,
      body: stop.body,
    }));
  return stops.length ? { title: guide.title, stops } : null;
}

/** The authored guide whose keyword or title the question says, when the user is offered it. */
async function authoredGuideFor(w: AnswerWriter, text: string): Promise<AuthoredGuide | null> {
  const words = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  for (const guide of AUTHORED_GUIDES) {
    const said = [guide.title, ...guide.keywords].some((phrase) => words.includes(` ${phrase.toLowerCase()} `));
    if (said && (await authoredGuideOffered(w, guide))) return guide;
  }
  return null;
}

/** The authored guides worth offering on a page: those with a stop on it first, then in their order. */
async function guidesForPage(w: AnswerWriter, context: AssistantPageContext | null, limit: number) {
  const offered: AuthoredGuide[] = [];
  for (const guide of AUTHORED_GUIDES) if (await authoredGuideOffered(w, guide)) offered.push(guide);
  const here = (guide: AuthoredGuide) =>
    guide.stops.some((stop) => {
      const anchor = GUIDE_ANCHOR_BY_ID.get(stop.anchor);
      return anchor ? onPage(anchor, context) : false;
    });
  return [...offered.filter(here), ...offered.filter((guide) => !here(guide))].slice(0, limit);
}

// ── The page's entity ─────────────────────────────────────────────────────────

/** The id the page's `[id]` holds when it is a page of `pattern`. */
function pageId(context: AssistantPageContext | null, pattern: string): number | null {
  if (context?.page !== pattern) return null;
  const id = Number(context.params?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The project the page shows, or the project of the entity it shows. */
async function pageProject(db: DrizzleDB, context: AssistantPageContext | null): Promise<number | null> {
  if (context?.projectId) return context.projectId;
  const pages: Array<[string, AssistantEntityType]> = [
    ['/test-runs/[id]', 'run'],
    ['/test-run-cases/[id]', 'execution'],
    ['/failure-clusters/[id]', 'cluster'],
    ['/test-cases/[id]', 'test-case'],
  ];
  for (const [pattern, type] of pages) {
    const id = pageId(context, pattern);
    if (id !== null) return projectOf(db, type, id);
  }
  return null;
}

// ── Why it failed ─────────────────────────────────────────────────────────────

type Execution = NonNullable<Awaited<ReturnType<typeof getTestRunCase>>>;
type Cluster = NonNullable<Awaited<ReturnType<typeof getFailureCluster>>>;

function readExecution(w: AnswerWriter, execution: Execution, clues: Awaited<ReturnType<typeof getFailureClues>>) {
  const project = execution.testRun?.project as { id: number; name: string } | undefined;
  w.read(
    'explain_failure',
    { executionId: execution.id },
    `Read why ${execution.title ?? `execution #${execution.id}`} failed`,
    {
      executionId: execution.id,
      testCaseId: execution.testCaseId,
      title: execution.title,
      status: execution.status,
      runId: execution.testRun?.id ?? null,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      headline: execution.verdict?.headline ?? null,
      situation: execution.situation?.text ?? null,
      nextStep: execution.nextStep ? { title: execution.nextStep.title, why: execution.nextStep.why } : null,
      story: clues.story?.sentence ?? null,
      clues: clues.clues
        .slice(0, CLUES_LISTED)
        .map((c) => ({ title: c.title, strength: c.strength, detail: c.detail })),
      clusterId: execution.failureCluster?.id ?? null,
    },
  );
}

function readCluster(w: AnswerWriter, cluster: Cluster): string {
  const title = describeCluster({
    title: cluster.title,
    signature: cluster.signature,
    errorType: cluster.errorType,
    selector: cluster.selector,
    sampleError: cluster.sampleError,
    filePath: cluster.affectedTestCases[0]?.filePath ?? null,
  });
  w.read('get_cluster', { clusterId: cluster.id }, `Read the failure cluster “${title}”`, {
    id: cluster.id,
    title,
    status: cluster.status,
    occurrences: cluster.occurrences,
    affectedTests: cluster.affectedTests,
    project: cluster.project ? { id: cluster.project.id, name: cluster.project.name } : null,
    latestTestRunsCaseId: cluster.latestTestRunsCaseId,
    diagnosis: cluster.diagnosis,
  });
  return title;
}

/** The fix on record: the cluster's diagnosed patch, else locator healing's replacement line. */
async function writeFix(
  w: AnswerWriter,
  cluster: Cluster | null,
  executionId: number,
): Promise<{ patch: boolean; healing: string | null }> {
  if (cluster) {
    const { diagnosis } = await getClusterDiagnosis(w.env.db, cluster.id);
    const details = (diagnosis?.details ?? null) as {
      suggestedFix?: { description?: string; file?: string | null; patch?: string | null };
    } | null;
    const fix = diagnosis?.status === 'completed' ? details?.suggestedFix : null;
    if (diagnosis && fix?.patch) {
      const validation = storedPatchValidation(details);
      w.read('get_cluster_diagnosis', { clusterId: cluster.id }, 'Read the failure’s AI diagnosis', {
        clusterId: cluster.id,
        category: diagnosis.category,
        confidence: diagnosis.confidence,
        summary: diagnosis.summary,
        suggestedFix: { description: fix.description ?? null, file: fix.file ?? null },
      });
      w.text(
        `**The fix.** The AI diagnosis (${diagnosis.category ?? 'uncategorized'}, ${diagnosis.confidence ?? 'unrated'} confidence) suggests: ${fix.description ?? 'the patch below'}${validation ? ` The patch was checked against the source: ${patchValidationLabel(validation.status).toLowerCase()}.` : ''}`,
      );
      w.patch(
        {
          id: 'diagnosed-patch',
          patch: fix.patch,
          target: { type: 'cluster', id: cluster.id },
          title: fix.file ? `Fix ${fix.file.split('/').pop()}`.slice(0, 60) : 'The diagnosed fix',
        },
        validation,
      );
      return { patch: true, healing: null };
    }
  }
  const healing = await getLocatorHealing(w.env.db, executionId).catch(() => null);
  const recommended = healing?.applicable !== false ? healing?.recommendation?.recommended : null;
  if (healing && recommended) {
    w.read('get_locator_healing', { executionId }, 'Read the replacement locators healing ranks', {
      executionId,
      source: healing.source,
      recommended: { locator: recommended.locator, method: recommended.method },
      edit: healing.edit ? { filePath: healing.edit.filePath, line: healing.edit.line } : null,
    });
    w.text(
      `**The fix.** The locator broke: locator healing recommends \`${recommended.locator}\` in its place, ranked from the last run where the test passed.`,
    );
    const edit = healing.edit;
    w.block('show_code', {
      id: 'replacement-locator',
      language: 'ts',
      code: edit ? edit.newLine.trim() : recommended.locator,
      title: edit?.filePath
        ? `Line ${edit.line} of ${edit.filePath.split('/').pop()}`.slice(0, 60)
        : 'The replacement locator',
    });
    return { patch: false, healing: recommended.locator };
  }
  w.text(
    '**The fix.** None is on record yet: no AI diagnosis has run on this failure, and locator healing has no replacement for it.',
  );
  return { patch: false, healing: null };
}

/** A one-stop guide to an anchor on the failure's page, when it renders for the user. */
async function oneStop(w: AnswerWriter, anchorId: string, context: AssistantPageContext | null, title: string) {
  const anchor = GUIDE_ANCHOR_BY_ID.get(anchorId);
  if (!anchor || anchorUnavailable(anchor, await w.anchorFacts(), context?.projectId ?? null)) return undefined;
  const stop = anchorStop(anchor, context);
  return stop ? { title, stops: [stop] } : undefined;
}

async function answerFailure(w: AnswerWriter): Promise<DemoAnswer> {
  const { db } = w.env;
  const context = w.question.context;
  const clusterPageId = pageId(context, '/failure-clusters/[id]');
  let cluster = clusterPageId ? await getFailureCluster(db, clusterPageId) : null;
  const executionId = pageId(context, '/test-run-cases/[id]') ?? cluster?.latestTestRunsCaseId ?? null;
  const execution = executionId ? await getTestRunCase(db, executionId) : null;
  const projectId = cluster?.projectId ?? (execution?.testRun?.projectId as number | undefined) ?? null;
  if (!execution || !w.reads(projectId)) return preparedQuestions(w);

  const clues = await getFailureClues(db, execution.id);
  if (cluster) readCluster(w, cluster);
  readExecution(w, execution, clues);
  if (!cluster && execution.failureCluster?.id) {
    cluster = await getFailureCluster(db, execution.failureCluster.id);
    if (cluster) readCluster(w, cluster);
  }

  const verdict = execution.verdict;
  const testLink = w.link('execution', execution.id);
  w.text(
    verdict
      ? `**${verdict.headline}**${verdict.detail ? ` — ${verdict.detail}` : ''}`
      : `${testLink} ${execution.status}.`,
    clues.story ? `**Most likely:** ${clues.story.sentence}` : null,
    execution.situation?.text ?? null,
  );
  const clueLines = clues.clues
    .slice(0, CLUES_LISTED)
    .map((clue) => `- **${clue.title}** (${clue.strength}): ${clue.detail}`);
  if (clueLines.length) w.text(`The clues, strongest first:\n\n${clueLines.join('\n')}`);
  if (execution.nextStep) w.text(`**Next:** ${execution.nextStep.title}. ${execution.nextStep.why}`);
  if (cluster) {
    w.text(
      `${testLink} is one failure of ${w.link('cluster', cluster.id)}: ${plural(cluster.occurrences ?? 0, 'occurrence')} across ${plural(cluster.affectedTests, 'test')}${cluster.project ? ` in ${w.link('project', cluster.project.id)}` : ''}.`,
    );
    w.block('show_entity', {
      id: 'failure-cluster',
      entity: { type: 'cluster', id: cluster.id },
      detail: `${plural(cluster.occurrences ?? 0, 'occurrence')}, ${plural(cluster.affectedTests, 'test')} affected`,
    });
  }

  const fix = await writeFix(w, cluster, execution.id);
  const repro = cluster ? await buildExecutionReproduce(db, execution.id) : null;
  if (cluster && repro?.reproduce.steps.length) {
    const { steps, commit } = repro.reproduce;
    w.read('get_fix_plan', { clusterId: cluster.id }, 'Read how to reproduce the failure', {
      clusterId: cluster.id,
      reproduce: { commit, browser: repro.reproduce.browser, steps: steps.map((step) => step.step) },
    });
    w.text(`**Reproduce it** on your machine${commit ? `, at the failing commit \`${commit.slice(0, 7)}\`` : ''}:`);
    w.block('show_command', {
      id: 'reproduce',
      bash: steps.map((step) => step.bash).join('\n'),
      powershell: steps.map((step) => step.powershell).join('\n'),
      title: 'Reproduce the failure',
    });
  }
  const options: Record<string, unknown>[] = [];
  if (fix.patch) {
    const guide = await oneStop(w, 'diagnosis-fix', context, 'The diagnosed patch');
    options.push({
      id: 'apply-patch',
      title: 'Apply the diagnosed patch',
      summary: 'Download it or copy its apply command from the failure’s fix toolbox, then push the change.',
      tradeoff: 'Read it first: a diagnosis can be wrong',
      effort: 'small',
      recommended: true,
      ...(guide ? { guide } : {}),
    });
  }
  if (fix.healing) {
    const guide = await oneStop(w, 'locator-fix', context, 'The replacement locator');
    options.push({
      id: 'replace-locator',
      title: 'Replace the locator',
      summary: `Use ${fix.healing} in the test, as locator healing recommends.`.slice(0, 120),
      tradeoff: 'Fixes the test, not the app: check the page changed on purpose',
      effort: 'small',
      recommended: !fix.patch || undefined,
      ...(guide ? { guide } : {}),
    });
  }
  if (!fix.patch && cluster) {
    options.push({
      id: 'diagnose',
      title: 'Run the AI diagnosis',
      summary: 'Diagnose the failure from its evidence and source changes, with a patch checked against the source.',
      tradeoff: 'Spends the diagnosis model’s tokens on your instance',
      effort: 'small',
      recommended: !fix.healing || undefined,
    });
  }
  if (!execution.quarantined) {
    options.push({
      id: 'quarantine',
      title: 'Quarantine the test while you fix it',
      summary: 'It keeps running and reporting, and stops failing the CI gate until it is released.',
      tradeoff: 'The gate stops seeing this test until it passes again',
      effort: 'small',
    });
  }
  if (cluster?.status === 'open') {
    options.push({
      id: 'resolve',
      title: 'Mark it resolved once the fix is in',
      summary: 'Resolve the failure cluster, so the inbox stops listing it.',
      tradeoff: 'A failure after the fix sets it back to open',
      effort: 'small',
    });
  }
  if (options.length >= 2) {
    w.block('offer_options', { id: BLOCK.fixWays, prompt: 'Ways to fix it:', options: options.slice(0, 4) });
  }
  return w.done('failure');
}

/** A pick among the ways to fix: the change it makes, as a card to apply. */
async function answerFixPick(w: AnswerWriter, reply: DemoReply): Promise<DemoAnswer> {
  const pick = reply.picked[0]?.id;
  const named = (type: AssistantEntityType) =>
    reply.answer.toolCalls.flatMap((call) => call.entities ?? []).find((entity) => entity.type === type);
  const cluster = named('cluster');
  const test = named('test-case');
  let refusal: string | null = 'that way to fix has no change to apply here';
  if (pick === 'diagnose' && cluster) {
    w.text(
      `**Apply** starts the AI diagnosis of ${w.link('cluster', cluster.id)}, as **Diagnose with AI** does on its page.`,
    );
    refusal = await w.proposal({
      id: 'diagnose-cluster',
      action: 'diagnose-cluster',
      title: 'Diagnose this failure with AI',
      change: 'Runs the AI diagnosis of the failure cluster; its patch shows on the cluster’s page once it is done.',
      target: { type: 'cluster', id: cluster.id },
    });
  } else if (pick === 'quarantine' && test) {
    w.text(
      `Quarantining ${w.link('test-case', test.id)} keeps it running and reporting, and stops it failing the CI gate until it is released.`,
    );
    refusal = await w.proposal({
      id: 'quarantine-test',
      action: 'quarantine-test',
      title: 'Quarantine this test',
      change: 'The test keeps running and reporting; its failures stop failing the CI gate until it is released.',
      target: { type: 'test-case', id: test.id },
      params: { reason: 'Failing while its fix is made' },
    });
  } else if (pick === 'resolve' && cluster) {
    w.text(
      `Once the fix is in, **Apply** marks ${w.link('cluster', cluster.id)} resolved, as **Resolve** does on its page. A failure after a recorded fix sets it back to open.`,
    );
    refusal = await w.proposal({
      id: 'resolve-cluster',
      action: 'resolve-cluster',
      title: 'Resolve this failure cluster',
      change: 'The failure cluster is marked resolved; it opens again if the failure comes back after a recorded fix.',
      target: { type: 'cluster', id: cluster.id },
    });
  }
  if (refusal) w.text(`No change to propose: ${refusal}.`);
  return w.done('failure');
}

// ── Flaky tests ───────────────────────────────────────────────────────────────

/** How a test flaked in the runs its score reads: its retry passes, its flips between passing and failing. */
function flakeFacts(test: { totalRuns: number; retryPassRuns: number; alternations: number; failureRate: number }) {
  const facts = [
    test.retryPassRuns ? `passed on a retry in ${test.retryPassRuns} of ${plural(test.totalRuns, 'run')}` : null,
    test.alternations
      ? `flipped between passing and failing ${plural(test.alternations, 'time')}${test.retryPassRuns ? '' : ` in ${plural(test.totalRuns, 'run')}`}`
      : null,
    test.failureRate > 0 ? `failed in ${percent(test.failureRate)} of them` : null,
  ].filter(Boolean);
  return facts.join(', ');
}

/** The project a flaky question is about: the page's, else the one with the flakiest test the user reads. */
async function flakyProject(w: AnswerWriter): Promise<{ id: number; name: string } | null> {
  const { db, scope } = w.env;
  const projects = await listProjects(db, scope);
  const named = await pageProject(db, w.question.context);
  if (named !== null) {
    const project = projects.find((p: { id: number }) => p.id === named);
    return project && w.reads(project.id) ? { id: project.id, name: project.name } : null;
  }
  let best: { id: number; name: string; impact: number } | null = null;
  for (const project of projects) {
    const top = (await getProjectFlakyTests(db, project.id, 50))[0];
    if (top && (!best || top.impact > best.impact)) best = { id: project.id, name: project.name, impact: top.impact };
  }
  return best;
}

async function answerFlaky(w: AnswerWriter): Promise<DemoAnswer> {
  const { db } = w.env;
  const project = await flakyProject(w);
  if (!project) return preparedQuestions(w);
  const [flaky, quarantined] = await Promise.all([
    getProjectFlakyTests(db, project.id, 50),
    getQuarantinedCaseIds(db, project.id),
  ]);
  w.read('list_flaky_tests', { projectId: project.id }, `Listed the flaky tests of ${project.name}`, {
    projectId: project.id,
    projectName: project.name,
    items: flaky.map((t) => ({
      testCaseId: t.testCaseId,
      title: t.title,
      flakyScore: t.score,
      failureRate: t.failureRate,
      runCount: t.totalRuns,
      retryPassCount: t.retryPassRuns,
      quarantined: quarantined.has(t.testCaseId) || undefined,
    })),
  });
  if (flaky.length === 0) {
    w.text(
      `${w.link('project', project.id)} has no flaky test in its recent runs: no test passed on a retry or flipped between passing and failing.`,
    );
    return w.done('flaky');
  }
  const candidates = flaky.filter((t) => !quarantined.has(t.testCaseId));
  const lines = flaky
    .slice(0, 5)
    .map(
      (t) =>
        `- ${w.link('test-case', t.testCaseId)}: flaky score ${t.score}; ${flakeFacts(t)}${quarantined.has(t.testCaseId) ? ' (quarantined)' : ''}`,
    );
  w.text(
    `${w.link('project', project.id)} has ${plural(flaky.length, 'flaky test')} in its recent runs, ranked by the CI time their retries cost:`,
    lines.join('\n'),
    quarantined.size
      ? `${plural(flaky.filter((t) => quarantined.has(t.testCaseId)).length, 'of them is', 'of them are')} quarantined already.`
      : null,
  );
  if (candidates.length === 0) return w.done('flaky');
  if (candidates.length === 1) {
    const only = candidates[0]!;
    w.block('show_entity', {
      id: 'flaky-test',
      entity: { type: 'test-case', id: only.testCaseId },
      detail: `Flaky score ${only.score}`,
    });
    return w.done('flaky');
  }
  w.block('ask', {
    id: BLOCK.flakyPicks,
    prompt: 'Which of them should I propose to quarantine? They keep running and stop failing the CI gate.',
    multiple: true,
    choices: candidates.slice(0, FLAKY_CHOICES).map((t, n) => ({
      id: `test-${t.testCaseId}`,
      entity: { type: 'test-case', id: t.testCaseId },
      detail: `Flaky score ${t.score}; ${flakeFacts(t)}`,
      checked: n < FLAKY_PRECHECKED || undefined,
    })),
    other: false,
  });
  return w.done('flaky');
}

/** The tests picked to quarantine: one card each, applied through the project's quarantine route. */
async function answerFlakyPicks(w: AnswerWriter, reply: DemoReply): Promise<DemoAnswer> {
  const tests = reply.picked.flatMap((pick) => (pick.entity?.type === 'test-case' ? [pick.entity] : []));
  w.text(
    `One card per test: **Apply** quarantines it as the test's **Quarantine this test** action does. A quarantined test keeps running and reporting, and Piwi proposes releasing it once it passes ${RELEASE_AFTER_CONSECUTIVE_PASSES} runs in a row.`,
  );
  const refusals: string[] = [];
  for (const test of tests) {
    const refusal = await w.proposal({
      id: `quarantine-${test.id}`,
      action: 'quarantine-test',
      title: `Quarantine ${test.label}`.slice(0, 60),
      change: 'The test keeps running and reporting; its failures stop failing the CI gate until it is released.',
      target: { type: 'test-case', id: test.id },
      params: { reason: 'Flaky in recent runs' },
    });
    if (refusal) refusals.push(`${test.label}: ${refusal}`);
  }
  if (refusals.length) w.text(`No card for ${refusals.join('; ')}.`);
  return w.done('flaky');
}

// ── What changed in a run ─────────────────────────────────────────────────────

async function answerRunChanges(w: AnswerWriter): Promise<DemoAnswer> {
  const { db } = w.env;
  const runId = pageId(w.question.context, '/test-runs/[id]');
  const projectId = runId ? await projectOf(db, 'run', runId) : null;
  if (!runId || !w.reads(projectId)) return preparedQuestions(w);
  const insights = await computeRunInsights(db, runId, { failedFallback: true });
  const cap = <T>(items: T[]) => items.slice(0, 5);
  w.read('get_run_insights', { runId }, `Compared run #${runId} with its baseline`, {
    runId,
    baseline: insights.baseline ? { runId: insights.baseline.id, note: insights.baselineNote } : null,
    passRate: insights.passRate,
    baselinePassRate: insights.hasBaseline ? insights.baselinePassRate : null,
    newRegressions: cap(insights.newRegressions),
    recurrences: cap(insights.recurrences),
    recovered: cap(insights.recovered),
    newFlaky: cap(insights.newFlaky),
    mostRegressed: cap(insights.mostRegressed),
    clusterNew: cap(insights.clusterNew).map((c) => ({ clusterId: c.clusterId, title: c.title })),
  });

  const run = w.link('run', runId);
  if (!insights.baseline) {
    w.text(
      `${run} has no earlier run to compare with: no run of its project before it qualifies as a baseline. It ran ${plural(insights.totalTests, 'test')}, ${insights.failedTests} of them failed.`,
    );
    return w.done('run-changes');
  }
  const baseline = w.link('run', insights.baseline.id);
  const points = Math.round(insights.passRateDelta * 10) / 10;
  const list = (items: Array<{ executionId: number; title: string }>, more: number) =>
    `${items.map((t) => w.link('execution', t.executionId, t.title)).join(', ')}${more > items.length ? `, and ${more - items.length} more` : ''}`;
  const lines = [
    insights.newRegressions.length
      ? `- **Started failing** (${insights.newRegressions.length}): ${list(cap(insights.newRegressions), insights.newRegressions.length)}`
      : '- **Started failing**: none',
    insights.recurrences.length
      ? `- **Still failing** (${insights.recurrences.length}): ${list(cap(insights.recurrences), insights.recurrences.length)}`
      : null,
    insights.recovered.length
      ? `- **Passing again** (${insights.recovered.length}): ${list(cap(insights.recovered), insights.recovered.length)}`
      : null,
    insights.newFlaky.length
      ? `- **Newly flaky** (${insights.newFlaky.length}): ${list(cap(insights.newFlaky), insights.newFlaky.length)}`
      : null,
    insights.clusterNew.length
      ? `- **New failure clusters** (${insights.clusterNew.length}): ${cap(insights.clusterNew)
          .map((c) => w.link('cluster', c.clusterId))
          .join(', ')}`
      : null,
    insights.mostRegressed.length
      ? `- **Slower**: ${cap(insights.mostRegressed)
          .slice(0, 3)
          .map((t) => `${w.link('execution', t.executionId, t.title)} (+${Math.round(t.pctChange)}%)`)
          .join(', ')}`
      : null,
  ].filter(Boolean);
  w.text(
    `${run} against its baseline, ${baseline}${insights.baselineNote ? ` (${insights.baselineNote.charAt(0).toLowerCase()}${insights.baselineNote.slice(1).replace(/\.$/, '')})` : ''}: the pass rate is ${Math.round(insights.passRate)}%, ${points === 0 ? 'the same as' : `${Math.abs(points)} points ${points > 0 ? 'above' : 'below'}`} the baseline’s ${Math.round(insights.baselinePassRate)}%.`,
    lines.join('\n'),
  );
  w.block('show_entity', {
    id: 'baseline-run',
    entity: { type: 'run', id: insights.baseline.id },
    detail: 'The baseline this run is compared with',
  });
  w.block('navigate', {
    id: 'open-changes',
    route: `/test-runs/${runId}?tab=changes`,
    label: 'Open the run’s Changes tab',
  });
  return w.done('run-changes');
}

// ── CI and sharding ───────────────────────────────────────────────────────────

/** A run of the project a CI question is about, as its read names it. */
interface CiRun {
  id: number;
  status: string;
  shardTotal: number | null;
}

/** The project a CI question is about: `named` (the page's), else the one whose latest run is newest. */
async function ciProject(w: AnswerWriter, named: number | null) {
  const { db, scope } = w.env;
  const projects = await listProjects(db, scope);
  const time = (p: { latestRun?: { startTime?: Date | string | null } | null }) =>
    p.latestRun?.startTime ? new Date(p.latestRun.startTime).getTime() : 0;
  const project =
    named !== null
      ? projects.find((p: { id: number }) => p.id === named)
      : [...projects].sort((a, b) => time(b) - time(a))[0];
  if (!project || !w.reads(project.id)) return null;
  const detail = await getProject(db, project.id, { runLimit: 50 });
  const latest = project.latestRun as { id: number; status: string; metadata?: unknown } | null;
  const ciProvider = (latest?.metadata as { ci?: { provider?: string } } | null)?.ci?.provider ?? null;
  const runs: CiRun[] = detail.testRuns.map((r: { id: number; status: string; shardTotal: number | null }) => ({
    id: r.id,
    status: r.status,
    shardTotal: r.shardTotal ?? null,
  }));
  w.read('get_project', { projectId: project.id }, `Read the recent runs of ${project.name}`, {
    id: project.id,
    name: project.name,
    latestRun: latest ? { id: latest.id, status: latest.status, ciProvider } : null,
    runs,
  });
  return { id: project.id as number, name: project.name as string, latestRunId: latest?.id ?? null, ciProvider, runs };
}

async function answerCi(w: AnswerWriter): Promise<DemoAnswer> {
  const project = await ciProject(w, await pageProject(w.env.db, w.question.context));
  if (!project) return preparedQuestions(w);
  const sharded = project.runs.find((run) => (run.shardTotal ?? 0) > 1);
  const projectLink = w.link('project', project.id);
  const facts = [
    project.latestRunId && project.ciProvider
      ? `${projectLink}’s newest run, ${w.link('run', project.latestRunId)}, came from ${project.ciProvider}`
      : `${projectLink} has no run from CI yet`,
    sharded ? `${w.link('run', sharded.id)} ran as ${sharded.shardTotal} shards merged into one run` : null,
  ].filter(Boolean);
  w.text(
    'There is no Piwi step to add to CI: the reporter runs inside `npx playwright test` and sends each result as it happens. CI sets two variables, the instance’s address and an API key, and Playwright’s own `--shard` splits the suite across jobs that Piwi merges back into one run, as long as every job reports with the same `projectName`.',
    `${facts.join(', and ')}.`,
  );
  const detected = CI_PROVIDERS.find((p) => p.label === project.ciProvider)?.id ?? null;
  w.block('ask', {
    id: BLOCK.ciProvider,
    prompt: 'Which CI runs your tests? The steps and the pipeline depend on it.',
    multiple: false,
    choices: CI_PROVIDERS.map((p) => ({ id: p.id, label: p.label, checked: p.id === detected || undefined })),
    other: false,
  });
  return w.done('ci');
}

/** The pipeline running the suite in `shards` jobs on a CI system, reporting to the instance. */
function pipeline(provider: CiProviderId, shards: number): { language: string; code: string } {
  const list = Array.from({ length: shards }, (_, i) => i + 1);
  switch (provider) {
    case 'github-actions':
      return {
        language: 'yaml',
        code: `jobs:
  e2e:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [${list.join(', ')}]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test --shard=\${{ matrix.shard }}/${shards}
        env:
          PIWI_DASHBOARD_URL: ${INSTANCE_URL}
          PIWI_API_KEY: \${{ secrets.PIWI_API_KEY }}
`,
      };
    case 'gitlab-ci':
      return {
        language: 'yaml',
        code: `e2e:
  parallel: ${shards}
  script:
    - npm ci
    - npx playwright install --with-deps
    - npx playwright test --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL
  variables:
    PIWI_DASHBOARD_URL: ${INSTANCE_URL}
    PIWI_API_KEY: $PIWI_API_KEY
`,
      };
    case 'azure-pipelines':
      return {
        language: 'yaml',
        code: `jobs:
  - job: e2e
    strategy:
      parallel: ${shards}
    steps:
      - script: npm ci
      - script: npx playwright install --with-deps
      - script: npx playwright test --shard=$(System.JobPositionInPhase)/$(System.TotalJobsInPhase)
        env:
          PIWI_DASHBOARD_URL: ${INSTANCE_URL}
          PIWI_API_KEY: $(PIWI_API_KEY)
`,
      };
    case 'jenkins':
      return {
        language: 'groovy',
        code: `pipeline {
  agent any
  environment {
    PIWI_DASHBOARD_URL = '${INSTANCE_URL}'
    PIWI_API_KEY = credentials('piwi-api-key')
  }
  stages {
    stage('e2e') {
      parallel {
${list.map((n) => `        stage('shard ${n}') { steps { sh 'npx playwright test --shard=${n}/${shards}' } }`).join('\n')}
      }
    }
  }
}
`,
      };
    default:
      return {
        language: 'bash',
        code: `# In each of the ${shards} jobs, with PIWI_DASHBOARD_URL and PIWI_API_KEY set:
${list.map((n) => `npx playwright test --shard=${n}/${shards}`).join('\n')}
`,
      };
  }
}

/** The steps to report the project from the CI picked, sharded as its sharded run was. */
async function answerCiPick(w: AnswerWriter, reply: DemoReply): Promise<DemoAnswer> {
  const provider = CI_PROVIDERS.find((p) => p.id === reply.picked[0]?.id) ?? CI_PROVIDERS.at(-1)!;
  const projectRef = reply.answer.toolCalls.flatMap((call) => call.entities ?? []).find((e) => e.type === 'project');
  const project = projectRef ? await ciProject(w, projectRef.id) : null;
  const name = project?.name ?? projectRef?.label ?? 'my-project';
  const shards = project?.runs.find((run) => (run.shardTotal ?? 0) > 1)?.shardTotal ?? 2;
  const apiKeyGuide = await oneStop(
    w,
    'create-api-key',
    { route: '/settings/account', page: '/settings/account' },
    'Create the key for CI',
  );
  const ciGuide = AUTHORED_GUIDES.find((guide) => guide.id === 'set-up-ci');
  const runsGuide = ciGuide && (await authoredGuideOffered(w, ciGuide)) ? await authoredPlan(w, ciGuide) : null;

  w.text(
    `The steps for ${provider.id === 'other' ? 'your CI' : provider.label}, reporting to ${projectRef ? w.link('project', projectRef.id) : `the project \`${name}\``} in ${shards} shards. Replace ${INSTANCE_URL} with your instance’s address.`,
  );
  w.block('checklist', {
    id: 'report-from-ci',
    title: `Report ${name} from ${provider.id === 'other' ? 'CI' : provider.label}`.slice(0, 60),
    steps: [
      {
        id: 'install',
        text: 'Install the reporter in your Playwright project: one command adds it and wires playwright.config to the project.',
        command: { bash: `npx @piwitests/reporter init --server-url ${INSTANCE_URL} --project ${name}` },
      },
      {
        id: 'api-key',
        text: 'Create an API key for CI under Settings → Account, and store it as a CI secret named PIWI_API_KEY.',
        ...(apiKeyGuide ? { guide: apiKeyGuide } : {}),
      },
      {
        id: 'try-locally',
        text: 'Check the connection once from your machine: the run shows in the project within seconds.',
        command: {
          bash: `PIWI_DASHBOARD_URL=${INSTANCE_URL} PIWI_API_KEY=<your-api-key> npx playwright test`,
          powershell: `$env:PIWI_DASHBOARD_URL='${INSTANCE_URL}'; $env:PIWI_API_KEY='<your-api-key>'; npx playwright test`,
        },
      },
      {
        id: 'pipeline',
        text: `Add the job below to your pipeline: ${shards} jobs, each running its shard with the two variables set.`,
      },
      {
        id: 'shard',
        text: 'Every job keeps the same projectName, so the shards merge into one run that stays running until the last one reports.',
        command: { bash: `npx playwright test --shard=1/${shards}` },
      },
      {
        id: 'watch',
        text: 'Push, and watch the run arrive: each shard adds its tests to the same run.',
        ...(runsGuide ? { guide: runsGuide } : {}),
      },
    ],
  });
  const job = pipeline(provider.id, shards);
  w.block('show_code', {
    id: 'pipeline',
    language: job.language,
    code: job.code,
    title: provider.id === 'other' ? 'The shards, one per job' : `${provider.label}, ${shards} shards`,
  });
  return w.done('ci');
}

// ── Where something is ────────────────────────────────────────────────────────

async function answerGuide(w: AnswerWriter): Promise<DemoAnswer> {
  const { text, context } = w.question;
  const query = text.replace(/^(where (is|are|do i|can i|does)|show me( where)?|take me to|point me to)\s+/i, '');
  const composed = await composedGuide(w, query, context);
  const authored = composed?.here ? null : await authoredGuideFor(w, text);
  const plan = authored ? await authoredPlan(w, authored) : (composed?.plan ?? null);
  if (!plan) return preparedQuestions(w, 'No part of the dashboard matches that question.');
  if (authored) {
    w.text(
      `The guide **${authored.title}** walks you through it: ${authored.summary.charAt(0).toLowerCase()}${authored.summary.slice(1)}. **Show me** closes this panel and plays it on your screens.`,
    );
  } else {
    const anchor = GUIDE_ANCHOR_BY_ID.get(plan.stops[0]!.anchor)!;
    const when = anchor.shownWhen
      ? ` It shows ${anchor.shownWhen.charAt(0).toLowerCase()}${anchor.shownWhen.slice(1)}`
      : '';
    w.text(
      `${anchor.describes}${when} **Show me** closes this panel and ${composed?.here ? 'points at it on this page' : 'opens its page and points at it'}.`,
    );
  }
  w.block('show_guide', { id: 'show-me', ...plan });
  return w.done('guide');
}

// ── What Piwi is ──────────────────────────────────────────────────────────────

async function answerAbout(w: AnswerWriter): Promise<DemoAnswer> {
  const { db, scope } = w.env;
  const projects = await listProjects(db, scope);
  w.read('list_projects', {}, 'Listed the projects you read', {
    items: projects.map((p: { id: number; name: string; totalRuns: number; latestRun?: { id: number } | null }) => ({
      id: p.id,
      name: p.name,
      totalRuns: p.totalRuns,
      latestRunId: p.latestRun?.id ?? null,
    })),
  });
  const open = await getOpenFailureClusters(db, scope, 50);
  w.read('list_open_clusters', {}, 'Listed the open failure clusters', {
    items: open.map((c) => ({
      id: c.id,
      title: describeCluster(c),
      projectId: c.projectId,
      projectName: c.projectName,
    })),
  });
  const runs = projects.reduce((n: number, p: { totalRuns: number }) => n + p.totalRuns, 0);
  w.text(
    `**${POSITIONING.tagline}** ${POSITIONING.summary}`,
    `This demo runs in your browser on sample data you can read: ${plural(projects.length, 'project')} with ${plural(runs, 'run')}, and ${plural(open.length, 'open failure cluster')}. It has no AI model, so I answer prepared questions, each computed from that data: on a failure, why it failed and the ways to fix it; on a project, which tests are flaky, with a card to quarantine each; on a run, what changed since its baseline; anywhere, how to run the suite in CI, and where something is, as a guide on the screens. The **Ask about this page** questions are those of the page you are on. On your own instance, the assistant answers any question with the AI model you configure, reading your data with your access.`,
  );
  const facts = await w.anchorFacts();
  const offered = (route: string) => {
    const page = GUIDE_ANCHORS.find((a) => a.kind === 'page' && routeOnPage(route, a.pages[0]!));
    return !page || !anchorUnavailable(page, facts, null);
  };
  const failure = open[0];
  if (failure)
    w.block('navigate', {
      id: 'open-failure',
      route: assistantEntityRoute({ type: 'cluster', id: failure.id }),
      label: 'Ask why the failure seen last happened',
    });
  const project = [...projects].sort((a, b) => b.totalRuns - a.totalRuns)[0];
  if (project)
    w.block('navigate', {
      id: 'open-project',
      route: `/projects/${project.id}?tab=flaky-tests`,
      label: `Ask which tests of ${project.name} are flaky`,
    });
  const latest = [...projects]
    .map((p: { latestRun?: { id: number; startTime?: Date | string | null } | null }) => p.latestRun)
    .filter((run): run is { id: number; startTime?: Date | string | null } => Boolean(run))
    .sort((a, b) => new Date(b.startTime ?? 0).getTime() - new Date(a.startTime ?? 0).getTime())[0];
  if (latest)
    w.block('navigate', {
      id: 'open-run',
      route: `/test-runs/${latest.id}`,
      label: 'Ask what changed in the newest run',
    });
  if (offered('/setup'))
    w.block('navigate', { id: 'open-setup', route: '/setup', label: 'See what this instance has switched on' });
  return w.done('about');
}

// ── Not a prepared question ───────────────────────────────────────────────────

/** The answer to a question no prepared answer matches: what the demo answers on the page, and the authored guides. */
async function preparedQuestions(w: AnswerWriter, lead?: string): Promise<DemoAnswer> {
  const context = w.question.context;
  const questions = demoQuestionsFor(context?.page ?? null);
  const guides = await guidesForPage(w, context, 2);
  w.text(
    lead,
    'The live demo has no AI model behind it, so it answers prepared questions about its sample data, each computed from that data, rather than any question. On this page you can ask the ones below. On your own instance the assistant answers with the AI model you configure.',
    guides.length
      ? `The authored guides walk through common tasks on the screens, with no model: ${guides.length === 1 ? 'this one fits' : 'these fit'} this page, and the command palette lists all ${AUTHORED_GUIDES.length} under **Guides**.`
      : null,
  );
  for (const guide of guides) {
    const plan = await authoredPlan(w, guide);
    if (plan) w.block('show_guide', { id: `guide-${guide.id}`, ...plan });
  }
  w.block('ask', {
    id: BLOCK.prepared,
    prompt: 'Ask one of these instead?',
    multiple: false,
    choices: questions.map((q) => ({ id: q.id, label: q.question })),
    other: false,
  });
  return w.done('prepared-questions');
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const ANSWERS: Record<DemoAssistantAnswer, (w: AnswerWriter) => Promise<DemoAnswer>> = {
  failure: answerFailure,
  flaky: answerFlaky,
  'run-changes': answerRunChanges,
  ci: answerCi,
  guide: answerGuide,
  about: answerAbout,
};

/** The reply-taking blocks, and the answer each pick gets. */
const REPLIES: Record<string, (w: AnswerWriter, reply: DemoReply) => Promise<DemoAnswer>> = {
  [BLOCK.fixWays]: answerFixPick,
  [BLOCK.flakyPicks]: answerFlakyPicks,
  [BLOCK.ciProvider]: answerCiPick,
  [BLOCK.prepared]: (w, reply) => {
    const prepared = DEMO_ASSISTANT_QUESTIONS.find((q) => q.id === reply.picked[0]?.id);
    if (!prepared) return preparedQuestions(w);
    return ANSWERS[prepared.answer](new AnswerWriter(w.env, { ...w.question, text: prepared.question, reply: null }));
  },
};

/** The demo's answer to a question: a reply's follow-up, a prepared answer, or what the demo answers here. */
export async function answerDemoQuestion(question: DemoQuestion, env: DemoAnswerEnv): Promise<DemoAnswer> {
  const w = new AnswerWriter(env, question);
  const follow = question.reply ? REPLIES[question.reply.blockId] : undefined;
  if (follow && question.reply) return follow(w, question.reply);
  const answer = matchDemoQuestion(question.text, question.context?.page);
  return answer ? ANSWERS[answer](w) : preparedQuestions(w);
}
