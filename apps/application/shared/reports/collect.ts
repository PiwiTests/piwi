/**
 * A dashboard and a scope make a report bundle: every widget of the dashboard
 * is run for the reader's project access and mapped to document blocks, the
 * verdict is built by rules, and the footer gathers the definitions and limits.
 * Shared by the server preview route, the MCP tool and the demo.
 */
import { inArray } from 'drizzle-orm';
import { projects } from '../../server/database/schema';
import type { DrizzleDB } from '../handlers/db';
import { analyticsScopeToQuery, hasTestFilter, type AnalyticsScope } from '../analytics/scope';
import { NO_ENVIRONMENT_FILTER } from '../environments';
import { getMetric, type MetricId } from '../analytics/metrics';
import {
  applyWidgetScope,
  getBuiltinDashboard,
  isBuiltinDashboardKey,
  resolveDashboard,
  type BuiltinDashboardKey,
  type DashboardDefinition,
} from '../analytics/dashboards';
import { getAnalyticsWidget } from '../analytics/registry';
import type { AnalyticsVerdict } from '../analytics/types';
import { runAnalyticsWidget } from '../handlers/analytics';
import { getAnalyticsContext, type AnalyticsContext, type ProjectAccess } from '../handlers/analytics/common';
import { getAnalyticsScopeSummary } from '../handlers/analytics/scope-summary';
import { getAnalyticsVerdict } from '../handlers/analytics/verdict';
import { evaluateTargets } from '../handlers/analytics/targets';
import { resolveCiCost } from '../handlers/ci-cost';
import { makeFormatter, type ValueFormatter } from './format';
import { resolveReportLanguage } from './language';
import type { ReportLanguage } from './languages';
import { sentencesFor, type ReportSentences } from './sentences';
import type { ReportBand, ReportBundle } from './types';
import { IDENTITY_WIDGETS, WIDGET_DOCUMENTS, widgetMetrics } from './widget-documents';

/** A saved dashboard as a report renders it: its reference, its name and its definition. */
export interface ReportDashboard {
  ref: string;
  name: string;
  definition: DashboardDefinition;
}

export interface CollectReportOptions {
  /** A built-in dashboard, or a saved one the caller loaded with its access check. */
  dashboard: BuiltinDashboardKey | ReportDashboard;
  /** The scope the reader asked for; the dashboard's default scope when omitted. */
  scope?: AnalyticsScope;
  access?: ProjectAccess;
  /** The report language; the project's ticket language or the instance locale when omitted. */
  language?: ReportLanguage;
  /** BCP-47 locale for numbers and dates; the language's default when omitted. */
  locale?: string;
  /** IANA zone the dates are labeled in; UTC when omitted. */
  timeZone?: string;
  /** Absolute base URL of the dashboard, for links back; null leaves the report unlinked. */
  baseUrl?: string | null;
  piwiVersion?: string | null;
  now?: number;
}

const MAX_NAMED_PROJECTS = 5;

/** A period's first and last days, as the report's language writes them. */
function periodRange(
  period: { from: Date; to: Date },
  f: ValueFormatter,
  s: ReportSentences,
  timeZone: string,
): string {
  const last = new Date(Math.max(period.from.getTime(), period.to.getTime() - 1));
  return s.dateRange(f.date(period.from, timeZone), f.date(last, timeZone));
}

async function scopeText(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  scope: AnalyticsScope,
  s: ReportSentences,
): Promise<ReportBundle['scopeText']> {
  let projectsText = s.labels.allProjects;
  if (ctx.allowed !== 'all') {
    const rows: { name: string; label: string | null }[] =
      ctx.allowed.length > 0
        ? await db
            .select({ name: projects.name, label: projects.label })
            .from(projects)
            .where(inArray(projects.id, ctx.allowed))
        : [];
    const names = rows.map((r) => r.label || r.name).sort((a, b) => a.localeCompare(b));
    projectsText =
      names.length === 0
        ? s.projectCount(0)
        : names.length <= MAX_NAMED_PROJECTS
          ? names.join(', ')
          : s.projectCount(names.length);
  }
  const policy = ctx.branchPolicy;
  const branches =
    policy.kind === 'list'
      ? policy.branches.join(', ')
      : policy.kind === 'any'
        ? s.labels.allBranches
        : s.labels.defaultBranch;
  const environmentPolicy = ctx.environmentPolicy;
  const environments =
    environmentPolicy.kind === 'list'
      ? environmentPolicy.environments
          .map((name) => (name === NO_ENVIRONMENT_FILTER ? s.labels.noEnvironment : name))
          .join(', ')
      : environmentPolicy.kind === 'any'
        ? s.labels.allEnvironments
        : s.labels.defaultEnvironment;
  const tests: string[] = [];
  if (scope.selection) tests.push(scope.selection);
  if (scope.tests?.tags?.length) tests.push(scope.tests.tags.map((t) => `@${t}`).join(' '));
  if (scope.tests?.owner?.length) tests.push(scope.tests.owner.join(', '));
  if (scope.browsers?.length) tests.push(scope.browsers.join(', '));
  return {
    projects: projectsText,
    branches,
    environments,
    runs: scope.fullRunsOnly ? s.labels.fullRunsOnly : s.labels.allRuns,
    tests: hasTestFilter(scope) ? tests.join(' · ') || s.labels.testFilter : null,
  };
}

/** Collect the report bundle of a dashboard over a scope. */
export async function collectReportBundle(db: DrizzleDB, opts: CollectReportOptions): Promise<ReportBundle> {
  const dashboard: ReportDashboard =
    typeof opts.dashboard === 'string'
      ? (({ key, name, definition }) => ({ ref: key, name, definition }))(getBuiltinDashboard(opts.dashboard))
      : opts.dashboard;
  const scope = opts.scope ?? dashboard.definition.scope;
  const access = opts.access ?? 'all';
  const ctx = await getAnalyticsContext(db, scope, access, opts.now);
  const language = opts.language ?? (await resolveReportLanguage(db, ctx.allowed));
  const timeZone = opts.timeZone || 'UTC';
  // The viewer's locale formats the numbers only when it speaks the report language (`fr-CA` for French).
  const locale = opts.locale?.toLowerCase().startsWith(language) ? opts.locale : undefined;
  const f = makeFormatter(language, locale);
  const s = sentencesFor(language);
  const baseUrl = opts.baseUrl ? opts.baseUrl.replace(/\/$/, '') : null;

  const summary = await getAnalyticsScopeSummary(db, scope, access);
  const bandsDef = resolveDashboard(dashboard.definition);
  const definitions = new Set<MetricId>();
  const docCtx = { f, s, baseUrl, markers: summary.markers, drawMarkers: true };
  let verdict: AnalyticsVerdict | null = null;
  let identity = false;

  const bands: ReportBand[] = [];
  for (const band of bandsDef) {
    const widgets: ReportBand['widgets'] = [];
    for (const widget of band.widgets) {
      const title = s.title(widget.title);
      if (!widget.available) {
        widgets.push({
          key: widget.key,
          type: null,
          title,
          blocks: [{ kind: 'text' as const, text: s.labels.unavailable }],
          notes: [],
        });
        continue;
      }
      const widgetScope = applyWidgetScope(scope, widget.scope);
      const data = await runAnalyticsWidget(db, widget.type, widgetScope, access, widget.options);
      if (widget.type === 'verdict') verdict = data as AnalyticsVerdict;
      for (const id of widgetMetrics(widget.type, widget.options)) definitions.add(id);
      if (IDENTITY_WIDGETS.has(widget.type)) identity = true;
      const notes: string[] = [];
      if (hasTestFilter(widgetScope) && !getAnalyticsWidget(widget.type).testFilters) {
        notes.push(s.testFilterNote(title));
      }
      const blocks = WIDGET_DOCUMENTS[widget.type](data, docCtx, widget.options);
      // A widget with nothing to show for the scope (the Test Map declined everywhere) is left out.
      if (blocks.length === 0) continue;
      widgets.push({ key: widget.key, type: widget.type, title, blocks, notes });
    }
    if (widgets.length === 0) continue;
    bands.push({
      title: s.title(band.title),
      description: band.description ? s.title(band.description) : null,
      widgets,
    });
  }

  verdict ??= await getAnalyticsVerdict(db, scope, access);
  // A date range needs no name beside its dates.
  const periodName = scope.period.kind === 'range' ? null : ctx.period.label;
  const range = periodRange(ctx.period, f, s, timeZone);
  const text = await scopeText(db, ctx, scope, s);

  const { cost } = await resolveCiCost(db);
  const verdicts = await evaluateTargets(db, ctx, cost);
  for (const v of verdicts) definitions.add(v.metric);
  const targets = verdicts.map((v) => ({
    projectId: v.projectId,
    project: v.projectName,
    metric: v.metric,
    target: v.target,
    actual: v.actual,
    met: v.met,
    text: s.target(v, f),
  }));

  const limits = [...ctx.notes];
  if (hasTestFilter(scope)) limits.push(s.testFilterLimit(summary.dataStartsAt ? f.date(summary.dataStartsAt) : null));
  if (identity) limits.push(s.identityLimit);
  limits.push(s.labels.daysAreUtc);

  const query = new URLSearchParams(analyticsScopeToQuery(scope)).toString();
  return {
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    piwiVersion: opts.piwiVersion ?? null,
    sourceUrl: baseUrl
      ? `${baseUrl}/analytics${/^\d+$/.test(dashboard.ref) ? `/d/${dashboard.ref}` : ''}${query ? `?${query}` : ''}`
      : null,
    title: s.reportTitle(text.projects, periodName, range),
    language,
    locale: f.locale,
    timeZone,
    scope,
    scopeText: text,
    period: {
      from: ctx.period.from.toISOString(),
      to: ctx.period.to.toISOString(),
      label: s.period(periodName, range),
    },
    comparison: ctx.comparison
      ? {
          from: ctx.comparison.from.toISOString(),
          to: ctx.comparison.to.toISOString(),
          label: s.comparison(ctx.comparison.label, periodRange(ctx.comparison, f, s, timeZone)),
        }
      : null,
    // A built-in dashboard is named in the language; a saved one keeps the name its owner gave it.
    dashboard: {
      ref: dashboard.ref,
      name: isBuiltinDashboardKey(dashboard.ref) ? s.title(dashboard.name) : dashboard.name,
    },
    verdict: { tone: verdict.tone, sentence: s.verdict(verdict.facts, f) },
    bands,
    targets,
    definitions: [...definitions].map((id) => {
      const def = getMetric(id);
      return { id, label: s.metricLabel(id, def.label), definition: s.metricDefinition(id, def.definition) };
    }),
    limits,
  };
}
