import { eq, and, desc, inArray, isNotNull } from 'drizzle-orm';
import { isUniqueViolation } from './db-errors';
import {
  failureDiagnoses,
  failureDiagnosisVersions,
  failureClusters,
  projects,
  testRunsCases,
} from '../database/schema';
import type { FailureDiagnosis, FailureCluster } from '../database/schema';
import { DIAGNOSIS_JSON_SCHEMA, parseDiagnosisJson } from '#shared/ai-diagnosis';
import type { DiagnosisStage } from '#shared/ai-diagnosis';
import { validatePatch } from '#shared/patch';
import type { BuiltDiagnosisContext } from './ai-context.types';
import type { AiConfig } from '~~/types/api';
import { callAiProvider, resolveAiConfig, streamAiProvider, DEFAULT_ANTHROPIC_MODEL } from './ai-provider';
import type { AiAttachedImage, StreamChunk, StreamResult } from './ai-provider';
import { buildDiagnosisContext } from './ai-context';
import { getFailureClues } from '#shared/handlers/test-cases';
import { resolveContextLimits } from './ai-context-limits';
import { downscaleImages } from './ai-images';
import { buildDiagnosisSystemPrompt, languageInstruction } from './ai-system-prompt';
import { readAiLanguage, resolveProjectAiLanguage } from './ai-settings';
import { reconcileNewClusters } from './cluster-reconcile';
import { nameNewClusters } from './cluster-naming';
import { RESEARCH_SYSTEM_PROMPT, RESEARCH_JSON_SCHEMA, parseResearchJson, formatResearchBlock } from './ai-research';
import { buildDiagnosisVersionValues } from '#shared/handlers/diagnosis-versions';
import { contextStalenessHash, diagnosisPromptHash } from '#shared/diagnosis-staleness';
import { emitNotification } from './notifications/emit';
import { enqueueDiagnosisPolicies } from './integrations/policies';
import type { DiagnosisCompletedPayload } from '#shared/notification-events';
import type { DbClient } from '../database';

const STALE_RUNNING_MS = 5 * 60 * 1000;

/** Max clusters auto-diagnosed per finished run (env-overridable budget cap). */
const DEFAULT_AUTO_DIAGNOSE_MAX = 3;
function autoDiagnoseBudget(): number {
  const raw = Number(process.env.PIWI_AI_AUTO_DIAGNOSE_MAX);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_AUTO_DIAGNOSE_MAX;
}

// Concurrency guard: prevent double-running for the same cluster/execution.
// Keys are scoped: 'cluster:<id>' for cluster-scope, 'exec:<testRunsCaseId>' for execution-scope.
const running = new Set<string>();

function runningKey(subject: DiagnosisSubject): string {
  return subject.scope === 'execution' ? `exec:${subject.executionId}` : `cluster:${subject.cluster.id}`;
}

export function isDiagnosisRunning(clusterId: number): boolean {
  return running.has(`cluster:${clusterId}`);
}

export function isDiagnosisRunningForExecution(testRunsCaseId: number): boolean {
  return running.has(`exec:${testRunsCaseId}`);
}

export function isDiagnosisStale(row: FailureDiagnosis): boolean {
  if (row.status !== 'running') return false;
  return Date.now() - row.updatedAt.getTime() > STALE_RUNNING_MS;
}

/**
 * Model label for the in-progress diagnosis record; the completed record stores
 * the model the provider actually reports back. Anthropic falls back to its
 * default model, the CLI to a generic label (it resolves its own default), and
 * OpenAI requires an explicit model so there is nothing to fall back to.
 */
function resolveModel(config: AiConfig): string {
  if (config.model) return config.model;
  if (config.provider === 'anthropic') return DEFAULT_ANTHROPIC_MODEL;
  if (config.provider === 'claude-cli') return 'claude';
  return config.model;
}

/**
 * High-signal sections included in the lean projection sent to the research
 * model. The heavy sections (full test source, console, network, ARIA, SCM
 * patches) are deliberately excluded — the research stage only narrows the
 * search, so it gets a cheap summary view while the final stage sees everything.
 */
const CORE_RESEARCH_SECTIONS = new Set([
  'clusterSummary',
  'sampleError',
  'executionError',
  'clues',
  'runContext',
  'recurrenceFlakiness',
  'retryProgression',
  'baselineComparison',
  'browserDistribution',
  'failingSteps',
  'testAnnotations',
  'priorDiagnosis',
]);
const RESEARCH_PROJECTION_CAP = 8000;

const SCM_GAP_RE = /\b(scm|commit|diff|regression|changed files?|git|bisect|last green|since .*green)\b/i;

/** Whether the research stage's findings warrant fetching the SCM diff. */
function researchWantsScm(research: { dataGaps: string[]; notes: string }): boolean {
  return research.dataGaps.some((g) => SCM_GAP_RE.test(g)) || SCM_GAP_RE.test(research.notes);
}

/** Build the compact, token-cheap context the research stage analyzes. */
function buildResearchProjection(ctx: { sections: Array<{ id: string; markdown: string }> }): string {
  const presentIds = [...new Set(ctx.sections.map((s) => s.id))];
  const core = ctx.sections.filter((s) => CORE_RESEARCH_SECTIONS.has(s.id));
  const scmHint = presentIds.includes('scmInvestigation')
    ? ''
    : '\nThe SCM diff (changes since the last green run) has NOT been fetched yet — include "scmInvestigation" in dataGaps if you suspect a regression and it should be pulled in for the final diagnosis.';
  const head =
    `Sections available in the full context: ${presentIds.join(', ')}.\n` +
    '(This research view includes only the high-signal summary sections; the senior engineer sees the rest.)' +
    scmHint;
  let text = [head, ...core.map((s) => s.markdown)].filter(Boolean).join('\n\n');
  if (text.length > RESEARCH_PROJECTION_CAP) {
    text = text.slice(0, RESEARCH_PROJECTION_CAP) + '\n[... research view truncated ...]';
  }
  return text;
}

/**
 * Column values that reset a diagnosis row to the 'running' state (shared by
 * insert + update). A new version starts unrated, and its creation time is when
 * it started.
 */
function runningDiagnosisFields(config: AiConfig) {
  return {
    status: 'running' as const,
    provider: config.provider,
    model: resolveModel(config),
    category: null,
    confidence: null,
    summary: null,
    rootCause: null,
    details: null,
    error: null,
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    feedback: null,
    feedbackNote: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Validate a suggested unified-diff patch against the exact source files the
 * model was shown (fetched into the `sourceFiles` context section), so the UI
 * can badge it as verified rather than taking it on faith. Returns null when
 * there is no patch.
 */
function validateSuggestedPatch(ctx: BuiltDiagnosisContext, patch: string | null) {
  if (!patch) return null;
  const files = new Map((ctx.sourceFiles ?? []).map((f) => [f.path, f.content] as const));
  return validatePatch(patch, files);
}

// ── Shared diagnosis pipeline ────────────────────────────────────────────────
// runClusterDiagnosis (synchronous) and streamClusterDiagnosis (SSE) differ only
// in whether the final diagnosis stage is a single call or a token stream; every
// other step — claiming the running row, the research stage + context assembly,
// and persisting the completed/failed result — is shared below.

/**
 * What a diagnosis run is about: a cluster, or one execution (execution scope),
 * with the cluster it belongs to when it has one.
 */
type DiagnosisSubject =
  | { scope: 'cluster'; projectId: number; cluster: FailureCluster }
  | { scope: 'execution'; projectId: number; cluster: FailureCluster | null; executionId: number };

/** The execution an execution-scope diagnosis is about, and its cluster when it has one. */
export interface DiagnosedExecution {
  id: number;
  projectId: number;
  cluster: FailureCluster | null;
}

interface DiagnosisRunOpts {
  additionalContext?: string;
  images?: AiAttachedImage[];
  baseCommit?: string;
  selectedCommitShas?: string[];
  /** When set, scope is 'execution' and the diagnosis is for a specific test-run-case of the cluster. */
  testRunsCaseId?: number;
  /** Streaming only: receives thinking chunks, then the final `done`/`error` chunk. */
  onChunk?: (chunk: StreamChunk) => void;
  /** Streaming only: receives each pipeline stage as it starts. */
  onStage?: (stage: DiagnosisStage) => void;
}

type PipelineStage = {
  role: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
};

/** 409 error thrown when a diagnosis is already running for this cluster/execution. */
function alreadyRunningError(subject: DiagnosisSubject) {
  const what = subject.scope === 'execution' ? 'failure' : 'cluster';
  return Object.assign(new Error(`Diagnosis already running for this ${what}`), { statusCode: 409 });
}

/** The subject of a run on a cluster, or on one of its executions when `testRunsCaseId` is set. */
function clusterSubject(cluster: FailureCluster, opts: DiagnosisRunOpts): DiagnosisSubject {
  return opts.testRunsCaseId != null
    ? { scope: 'execution', projectId: cluster.projectId, cluster, executionId: opts.testRunsCaseId }
    : { scope: 'cluster', projectId: cluster.projectId, cluster };
}

/** The WHERE clause identifying this diagnosis row (execution vs cluster scope). */
function diagnosisWhere(subject: DiagnosisSubject) {
  return subject.scope === 'execution'
    ? and(eq(failureDiagnoses.testRunsCaseId, subject.executionId), eq(failureDiagnoses.scope, 'execution'))
    : and(eq(failureDiagnoses.clusterId, subject.cluster.id), eq(failureDiagnoses.scope, 'cluster'));
}

/** Build the combined (global + project) diagnosis system prompt. */
export async function loadDiagnosisSystemPrompt(db: DbClient, owner: { projectId: number }): Promise<string> {
  const [globalInstructionsRow, projectRows, globalLanguage] = await Promise.all([
    getAppSetting<{ value?: string }>(db, 'ai_instructions'),
    db
      .select({ diagnosisInstructions: projects.diagnosisInstructions, aiLanguage: projects.aiLanguage })
      .from(projects)
      .where(eq(projects.id, owner.projectId))
      .limit(1),
    readAiLanguage(db),
  ]);
  return buildDiagnosisSystemPrompt({
    globalInstructions: globalInstructionsRow?.value?.trim() || null,
    projectInstructions: projectRows[0]?.diagnosisInstructions?.trim() || null,
    // A per-project language overrides the instance-wide setting.
    language: projectRows[0]?.aiLanguage?.trim() || globalLanguage,
  });
}

/**
 * Claim the diagnosis row in the 'running' state. Beyond the in-process `running`
 * set (fast path within one instance), this is the authoritative cross-instance
 * guard: it refuses to clobber a fresh in-progress row (throws 409), snapshots a
 * completed/failed/stale row before resetting it, and treats a unique-index
 * violation on the insert (a concurrent instance won the race) as a 409 too.
 */
async function claimRunningRow(db: DbClient, subject: DiagnosisSubject, config: AiConfig) {
  const runningFields = runningDiagnosisFields(config);

  const [existing] = await db
    .select({ id: failureDiagnoses.id, status: failureDiagnoses.status, updatedAt: failureDiagnoses.updatedAt })
    .from(failureDiagnoses)
    .where(diagnosisWhere(subject))
    .limit(1);

  if (existing) {
    // Don't overwrite a diagnosis another run/instance is actively producing.
    if (existing.status === 'running' && !isDiagnosisStale(existing as FailureDiagnosis)) {
      throw alreadyRunningError(subject);
    }
    await snapshotDiagnosis(db, existing.id);
    await db.update(failureDiagnoses).set(runningFields).where(eq(failureDiagnoses.id, existing.id));
    return;
  }

  try {
    await db.insert(failureDiagnoses).values({
      // Execution-scoped rows key on `testRunsCaseId`, never on a cluster — a failure may
      // have no cluster, and a null keeps the (cluster_id, scope) unique index from
      // colliding across executions that share one cluster.
      ...(subject.scope === 'execution'
        ? { clusterId: null, scope: 'execution', testRunsCaseId: subject.executionId }
        : { clusterId: subject.cluster.id, scope: 'cluster' }),
      ...runningFields,
    });
  } catch (err) {
    // The unique index on (cluster_id, scope) / (test_runs_case_id, scope) means a
    // concurrent instance inserted the running row between our SELECT and INSERT.
    if (isUniqueViolation(err)) throw alreadyRunningError(subject);
    throw err;
  }
}

/**
 * Assemble the diagnosis context: optional research pre-analysis stage (which may
 * trigger a targeted SCM re-fetch), the final user content, and the downscaled
 * images. Pushes the research stage onto `pipeline`. Shared by both entry points.
 */
async function prepareDiagnosisInputs(
  db: DbClient,
  subject: DiagnosisSubject,
  config: AiConfig,
  opts: DiagnosisRunOpts,
  pipeline: PipelineStage[],
): Promise<{ ctx: BuiltDiagnosisContext; userContent: string; images: AiAttachedImage[] | undefined }> {
  // Honour the cluster's manually-pinned baseline when the caller didn't supply one.
  const effectiveBaseCommit = opts.baseCommit || subject.cluster?.manualBaseCommit || undefined;
  // The local Claude CLI takes the prompt as text: it gets no image, and the context names none.
  const textOnly = config.provider === 'claude-cli' || config.provider === 'codex-cli';

  const buildCtx = (skipScm: boolean) =>
    subject.scope === 'execution'
      ? buildDiagnosisContext(db, {
          kind: 'execution',
          clusterId: subject.cluster?.id,
          executionId: subject.executionId,
          baseCommit: effectiveBaseCommit,
          selectedCommitShas: opts.selectedCommitShas,
          skipScm,
          textOnly,
        })
      : buildDiagnosisContext(db, {
          kind: 'cluster',
          clusterId: subject.cluster.id,
          baseCommit: effectiveBaseCommit,
          selectedCommitShas: opts.selectedCommitShas,
          skipScm,
          textOnly,
        });

  // Research runs only when a distinct research role (own provider/key/baseUrl/model) is configured.
  const researchConfig = config.roles.research;
  const useResearch =
    researchConfig != null &&
    !(
      researchConfig.provider === config.provider &&
      researchConfig.model === config.model &&
      (researchConfig.baseUrl ?? null) === (config.baseUrl ?? null)
    );

  // The user may have pinned a baseline/commits — always fetch SCM then.
  const manualScm = Boolean(effectiveBaseCommit || opts.selectedCommitShas?.length);

  // Two-stage pipeline: the research model pre-analyzes a lean, SCM-free projection.
  // Its hints fold into the final prompt, and the expensive SCM diff is fetched only
  // when research flags it (or the user pinned commits). A research failure is
  // non-fatal: fall back to single-stage with SCM included.
  let ctx = await buildCtx(useResearch);
  let researchBlock = '';
  if (useResearch) {
    opts.onStage?.('research');
    try {
      const researchLang = languageInstruction(await resolveProjectAiLanguage(db, subject.projectId));
      const research = await callAiProvider(researchConfig!, {
        system: researchLang ? `${RESEARCH_SYSTEM_PROMPT}\n${researchLang}` : RESEARCH_SYSTEM_PROMPT,
        user: buildResearchProjection(ctx),
        jsonSchema: RESEARCH_JSON_SCHEMA,
        maxTokens: 2048,
        effort: 'low',
      });
      pipeline.push({
        role: 'research',
        model: research.model,
        inputTokens: research.inputTokens,
        outputTokens: research.outputTokens,
        cacheCreationInputTokens: research.cacheCreationInputTokens,
        cacheReadInputTokens: research.cacheReadInputTokens,
      });
      const parsed = parseResearchJson(research.text);
      researchBlock = formatResearchBlock(parsed);
      if (researchWantsScm(parsed) || manualScm) {
        ctx = await buildCtx(false);
      }
    } catch (e) {
      console.error('[ai-diagnosis] research stage failed, falling back to single-stage:', e);
      ctx = await buildCtx(false);
    }
  }

  const extra = opts.additionalContext?.trim();
  const baseContent = extra ? `${ctx.text}\n\n## Additional Context Provided by User\n${extra}` : ctx.text;
  const userContent = researchBlock ? `${baseContent}\n\n${researchBlock}` : baseContent;

  // Downscale screenshots (auto-resolved + user-provided) — full-resolution images
  // cost ~3× more tokens on current models without helping diagnosis.
  const allImages = textOnly ? [] : [...(ctx.images ?? []), ...(opts.images ?? [])];
  const images =
    allImages.length > 0 ? await downscaleImages(allImages, (await resolveContextLimits(db)).imageMaxEdge) : undefined;

  return { ctx, userContent, images };
}

/** Persist the completed diagnosis row and return it. */
async function persistCompletedDiagnosis(
  db: DbClient,
  subject: DiagnosisSubject,
  opts: DiagnosisRunOpts,
  args: {
    diagnosis: ReturnType<typeof parseDiagnosisJson>;
    ctx: BuiltDiagnosisContext;
    pipeline: PipelineStage[];
    model: string;
    t0: number;
    systemPrompt: string;
  },
): Promise<FailureDiagnosis> {
  const { diagnosis, ctx, pipeline, model, t0, systemPrompt } = args;
  const sumTokens = (k: 'inputTokens' | 'outputTokens') => pipeline.reduce((acc, s) => acc + (s[k] ?? 0), 0) || null;

  // Hash the evidence the model was shown (its own prior-assessment section
  // excluded, so a diagnosis never marks itself stale), so staleness can later ask
  // "has the evidence changed since this diagnosis?" by re-hashing the current one.
  const contextSha = await contextStalenessHash(ctx.sections);
  const promptSha = await diagnosisPromptHash(systemPrompt, DIAGNOSIS_JSON_SCHEMA);

  const updated = await db
    .update(failureDiagnoses)
    .set({
      status: 'completed',
      model,
      contextSha,
      category: diagnosis.category,
      confidence: diagnosis.confidence,
      summary: diagnosis.summary,
      rootCause: diagnosis.rootCause,
      details: {
        evidence: diagnosis.evidence,
        suggestedFix: diagnosis.suggestedFix,
        preventionTips: diagnosis.preventionTips,
        confidenceScore: diagnosis.confidenceScore,
        severity: diagnosis.severity,
        affectedArea: diagnosis.affectedArea,
        hypotheses: diagnosis.hypotheses,
        investigationSteps: diagnosis.investigationSteps,
        // Always stored (even single-stage) so per-stage token + cache stats are inspectable.
        pipeline,
        selectedCommitShas: opts.selectedCommitShas ?? null,
        additionalContext: opts.additionalContext ?? null,
        autoSelectedCommits: ctx.scmChanges?.commits?.slice(0, 3).map((c) => c.sha) ?? null,
        patchValidation: validateSuggestedPatch(ctx, diagnosis.suggestedFix.patch),
        promptSha,
      },
      error: null,
      inputTokens: sumTokens('inputTokens'),
      outputTokens: sumTokens('outputTokens'),
      durationMs: Date.now() - t0,
      updatedAt: new Date(),
    })
    .where(diagnosisWhere(subject))
    .returning();

  const completed = updated[0]!;

  // The event is about a cluster: a failure in no cluster sends none.
  if (subject.cluster) {
    const event: DiagnosisCompletedPayload = {
      clusterId: subject.cluster.id,
      ...(subject.scope === 'execution' ? { executionId: subject.executionId } : {}),
      projectId: subject.projectId,
      completedAt: completed.updatedAt?.getTime() ?? Date.now(),
      summary: diagnosis.summary,
      rootCause: diagnosis.rootCause,
      category: diagnosis.category,
      confidence: diagnosis.confidence,
    };
    emitNotification(db, 'diagnosis.completed', event);
    enqueueDiagnosisPolicies(db, event).catch((e) => console.error('[integrations] diagnosis policies failed', e));
  }

  return completed;
}

/** Persist the failed diagnosis row and return it. */
async function persistFailedDiagnosis(
  db: DbClient,
  subject: DiagnosisSubject,
  message: string,
  t0: number,
): Promise<FailureDiagnosis> {
  const failed = await db
    .update(failureDiagnoses)
    .set({
      status: 'failed',
      error: message.slice(0, 500),
      durationMs: Date.now() - t0,
      updatedAt: new Date(),
    })
    .where(diagnosisWhere(subject))
    .returning();

  return failed[0]!;
}

/**
 * Snapshot the current state of a diagnosis row into `failure_diagnosis_versions`
 * before it gets overwritten by a re-diagnose.
 */
async function snapshotDiagnosis(db: DbClient, diagnosisId: number): Promise<void> {
  const [row] = await db.select().from(failureDiagnoses).where(eq(failureDiagnoses.id, diagnosisId)).limit(1);
  if (!row) return;
  // Shared with the demo force-refresh path (app/demo/api/ai.ts) so the version
  // row shape can never drift between server and demo.
  await db.insert(failureDiagnosisVersions).values(buildDiagnosisVersionValues(row));
}

export async function runClusterDiagnosis(
  db: DbClient,
  cluster: FailureCluster,
  config: AiConfig,
  opts: DiagnosisRunOpts = {},
): Promise<FailureDiagnosis> {
  return runDiagnosis(db, clusterSubject(cluster, opts), config, opts);
}

/** Diagnose one execution (execution scope), in a cluster or in none. */
export async function runExecutionDiagnosis(
  db: DbClient,
  execution: DiagnosedExecution,
  config: AiConfig,
  opts: Omit<DiagnosisRunOpts, 'testRunsCaseId' | 'onChunk' | 'onStage'> = {},
): Promise<FailureDiagnosis> {
  const subject: DiagnosisSubject = {
    scope: 'execution',
    projectId: execution.projectId,
    cluster: execution.cluster,
    executionId: execution.id,
  };
  return runDiagnosis(db, subject, config, opts);
}

async function runDiagnosis(
  db: DbClient,
  subject: DiagnosisSubject,
  config: AiConfig,
  opts: DiagnosisRunOpts,
): Promise<FailureDiagnosis> {
  const mutexKey = runningKey(subject);
  if (running.has(mutexKey)) throw alreadyRunningError(subject);
  running.add(mutexKey);

  try {
    const systemPrompt = await loadDiagnosisSystemPrompt(db, subject);
    await claimRunningRow(db, subject, config);

    const t0 = Date.now();
    const pipeline: PipelineStage[] = [];
    try {
      const { ctx, userContent, images } = await prepareDiagnosisInputs(db, subject, config, opts, pipeline);

      const result = await callAiProvider(config, {
        system: systemPrompt,
        user: userContent,
        jsonSchema: DIAGNOSIS_JSON_SCHEMA,
        images,
        adaptiveThinking: true,
        cacheControl: true,
        // The built context is the cache-stable prefix; additional context and the
        // research block vary between re-runs and sit after the breakpoint.
        stablePrefixChars: ctx.text.length,
      });
      pipeline.push({
        role: 'diagnosis',
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
      });

      const diagnosis = parseDiagnosisJson(result.text);
      return await persistCompletedDiagnosis(db, subject, opts, {
        diagnosis,
        ctx,
        pipeline,
        model: result.model,
        t0,
        systemPrompt,
      });
    } catch (err) {
      return await persistFailedDiagnosis(db, subject, err instanceof Error ? err.message : String(err), t0);
    }
  } finally {
    running.delete(mutexKey);
  }
}

/**
 * Streaming variant of runClusterDiagnosis. Streams the diagnosis stage's thinking
 * tokens via onChunk, then saves the final result to DB and returns it. The research
 * stage remains synchronous (too short to benefit from streaming).
 *
 * onChunk is called with text chunks as they arrive. When the full result is saved,
 * onChunk receives a `'done'` chunk with the final FailureDiagnosis. On error,
 * onChunk receives an `'error'` chunk.
 */
export async function streamClusterDiagnosis(
  db: DbClient,
  cluster: FailureCluster,
  config: AiConfig,
  opts: DiagnosisRunOpts = {},
): Promise<FailureDiagnosis> {
  const subject = clusterSubject(cluster, opts);
  const mutexKey = runningKey(subject);
  if (running.has(mutexKey)) throw alreadyRunningError(subject);
  running.add(mutexKey);

  try {
    const systemPrompt = await loadDiagnosisSystemPrompt(db, subject);
    await claimRunningRow(db, subject, config);

    const t0 = Date.now();
    const pipeline: PipelineStage[] = [];
    try {
      const { ctx, userContent, images } = await prepareDiagnosisInputs(db, subject, config, opts, pipeline);

      opts.onStage?.('diagnosis');

      let accumulatedText = '';
      let streamModel = config.model;
      let streamInputTokens: number | null = null;
      let streamOutputTokens: number | null = null;
      let streamCacheCreation: number | null = null;
      let streamCacheRead: number | null = null;

      for await (const chunk of streamAiProvider(config, {
        system: systemPrompt,
        user: userContent,
        jsonSchema: DIAGNOSIS_JSON_SCHEMA,
        images,
        adaptiveThinking: true,
        cacheControl: true,
        stablePrefixChars: ctx.text.length,
      })) {
        if (chunk.type === 'text') {
          accumulatedText += chunk.data as string;
          if (opts.onChunk) opts.onChunk(chunk);
        } else if (chunk.type === 'done') {
          const result = chunk.data as StreamResult;
          streamModel = result.model;
          streamInputTokens = result.inputTokens;
          streamOutputTokens = result.outputTokens;
          streamCacheCreation = result.cacheCreationInputTokens;
          streamCacheRead = result.cacheReadInputTokens;
        } else if (chunk.type === 'error') {
          throw new Error(chunk.data as string);
        }
      }

      pipeline.push({
        role: 'diagnosis',
        model: streamModel,
        inputTokens: streamInputTokens,
        outputTokens: streamOutputTokens,
        cacheCreationInputTokens: streamCacheCreation,
        cacheReadInputTokens: streamCacheRead,
      });

      const diagnosis = parseDiagnosisJson(accumulatedText);
      const finalDiagnosis = await persistCompletedDiagnosis(db, subject, opts, {
        diagnosis,
        ctx,
        pipeline,
        model: streamModel,
        t0,
        systemPrompt,
      });
      if (opts.onChunk) opts.onChunk({ type: 'done', data: finalDiagnosis });
      return finalDiagnosis;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result = await persistFailedDiagnosis(db, subject, message, t0);
      if (opts.onChunk) opts.onChunk({ type: 'error', data: message });
      return result;
    }
  } finally {
    running.delete(mutexKey);
  }
}

/** Priority by top-clue strength — lower is diagnosed first (no clue is weakest). */
const CLUE_STRENGTH_PRIORITY: Record<string, number> = { none: 0, weak: 1, medium: 2, strong: 3 };

/**
 * Whether the evidence of a cluster moved on since a diagnosis was written: the
 * hash of the context as it is now differs from the one stored with it. A
 * diagnosis stored without a hash never reads as changed.
 */
async function contextChangedSince(db: DbClient, clusterId: number, storedSha: string | null): Promise<boolean> {
  if (!storedSha) return false;
  const ctx = await buildDiagnosisContext(db, { kind: 'cluster', clusterId });
  return (await contextStalenessHash(ctx.sections)) !== storedSha;
}

/**
 * A cluster needs an auto-diagnosis unless a diagnosis is running in this
 * process or its stored one is completed or still in progress. A failed or a
 * stale running one is retried, and a completed one rated unhelpful is written
 * again once the evidence has changed since it (the new version starts unrated,
 * so that happens once per rating).
 */
async function needsAutoDiagnosis(db: DbClient, clusterId: number): Promise<boolean> {
  if (running.has(`cluster:${clusterId}`)) return false;
  const [existing] = await db
    .select()
    .from(failureDiagnoses)
    .where(and(eq(failureDiagnoses.clusterId, clusterId), eq(failureDiagnoses.scope, 'cluster')))
    .limit(1);
  if (!existing) return true;
  if (existing.status === 'completed') {
    return existing.feedback === 'down' && (await contextChangedSince(db, clusterId, existing.contextSha));
  }
  return !(existing.status === 'running' && !isDiagnosisStale(existing));
}

/**
 * Order the auto-diagnose candidates so the budget lands on the failures that
 * need the model most: weakest top clue first (a failure with no deterministic
 * clue is the one worth spending tokens on), then the newest cluster. Capped to
 * the budget. The chosen order is logged at debug level.
 */
async function orderClustersByWeakestClue(
  db: DbClient,
  candidates: FailureCluster[],
  runId: number,
): Promise<FailureCluster[]> {
  const limits = await resolveContextLimits(db);
  const ranked = await Promise.all(
    candidates.map(async (cluster) => {
      // The representative failing execution: the latest one in the cluster,
      // matching how the diagnosis context picks its representative.
      const [rep] = await db
        .select({ id: testRunsCases.id })
        .from(testRunsCases)
        .where(eq(testRunsCases.failureClusterId, cluster.id))
        .orderBy(desc(testRunsCases.id))
        .limit(1);
      let strength = 'none';
      if (rep) {
        const { clues } = await getFailureClues(db, rep.id, { slowRequestMs: limits.slowRequestMs }).catch(() => ({
          clues: [],
        }));
        strength = clues[0]?.strength ?? 'none';
      }
      return { cluster, strength, priority: CLUE_STRENGTH_PRIORITY[strength] ?? 0 };
    }),
  );

  ranked.sort((a, b) => a.priority - b.priority || b.cluster.firstSeenRunId - a.cluster.firstSeenRunId);
  const chosen = ranked.slice(0, autoDiagnoseBudget());
  console.debug(
    `[ai-diagnosis] auto-diagnose order for run ${runId}: ${
      chosen.map((c) => `#${c.cluster.id} (${c.strength} clue)`).join(', ') || 'none'
    }`,
  );
  return chosen.map((c) => c.cluster);
}

/**
 * The clusters a finished run auto-diagnoses: those without a completed or
 * running diagnosis, or whose diagnosis was rated unhelpful before the evidence
 * changed, ranked and capped to the budget. Ignored clusters and clusters that
 * need nothing are dropped first so they never take a slot.
 */
export async function selectAutoDiagnoseClusters(
  db: DbClient,
  candidates: FailureCluster[],
  runId: number,
): Promise<FailureCluster[]> {
  const live = candidates.filter((cluster) => cluster.status !== 'ignored');
  const needed = await Promise.all(live.map((cluster) => needsAutoDiagnosis(db, cluster.id)));
  return orderClustersByWeakestClue(
    db,
    live.filter((_, i) => needed[i]),
    runId,
  );
}

export async function autoDiagnoseRun(db: DbClient, projectId: number, runId: number): Promise<void> {
  const config = await resolveAiConfig(db);

  // Always-on (when an embedding role is configured): collapse semantic
  // near-duplicate clusters from this run before any diagnosis runs, so we don't
  // diagnose a cluster that's about to be merged away. Independent of autoDiagnose.
  if (config?.roles.embedding) {
    try {
      const reasoningRole = config.roles.research ?? config.roles.diagnosis;
      const { embedded, merged, suggested } = await reconcileNewClusters(db, projectId, runId, {
        embeddingRole: config.roles.embedding,
        reasoningRole,
      });
      if (merged > 0 || suggested > 0) {
        console.log(`[cluster-reconcile] run ${runId}: embedded ${embedded}, merged ${merged}, suggested ${suggested}`);
      }
    } catch (e) {
      console.error('[cluster-reconcile] failed for run', runId, e);
    }
  }

  if (!config?.autoDiagnose) return;

  // Name new, still-unnamed clusters in one cheap batched call (best-effort).
  try {
    await nameNewClusters(db, projectId, runId, config.roles.research ?? config.roles.diagnosis);
  } catch (e) {
    console.error('[cluster-naming] failed for run', runId, e);
  }

  // Diagnose every cluster that surfaced in THIS run (not only clusters first seen
  // in it) that doesn't already have a fresh diagnosis, so a known cluster that
  // regresses after going undiagnosed is still picked up. Clusters that already
  // have one, and ignored clusters, never take a budget slot; a diagnosis rated
  // unhelpful takes one again once the evidence has changed. The budget is spent where it buys the
  // most: candidates are ordered by their representative failing execution's top
  // clue — the failures with no deterministic clue (the ones the model has to
  // reason about from scratch) come first, then the weakest clues, and only then
  // failures a strong clue already explains — with the newest cluster breaking
  // ties. Capped by a configurable budget (default 3).
  const clusterIdRows = await db
    .selectDistinct({ id: testRunsCases.failureClusterId })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.testRunId, runId), isNotNull(testRunsCases.failureClusterId)));
  const clusterIds = clusterIdRows.map((r) => r.id).filter((id): id is number => id != null);
  if (clusterIds.length === 0) return;

  const candidates = await db
    .select()
    .from(failureClusters)
    .where(and(eq(failureClusters.projectId, projectId), inArray(failureClusters.id, clusterIds)))
    .orderBy(desc(failureClusters.firstSeenRunId));

  const clusters = await selectAutoDiagnoseClusters(db, candidates, runId);

  for (const cluster of clusters) {
    try {
      // Diagnoses run one after another, so one may have started meanwhile.
      if (!(await needsAutoDiagnosis(db, cluster.id))) continue;

      await runClusterDiagnosis(db, cluster, config);
    } catch (e) {
      console.error('[ai-diagnosis] autoDiagnose failed for cluster', cluster.id, e);
    }
  }
}
