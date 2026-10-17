import type { DrizzleDB } from '../db';
import type { AnalyticsScope } from '../../analytics/scope';
import { isAnalyticsWidgetId, parseWidgetOptions, type AnalyticsWidgetId } from '../../analytics/registry';
import type { ProjectAccess } from './common';
import { getAnalyticsPortfolio } from './portfolio';
import { getAnalyticsPassRateHeatmap } from './pass-rate-heatmap';
import { getAnalyticsCiTimeTrend } from './ci-time-trend';
import { getAnalyticsWastedTime } from './wasted-time';
import { getAnalyticsFlakyLeaderboard } from './flaky-leaderboard';
import { getAnalyticsClusterLandscape } from './cluster-landscape';
import { getAnalyticsRegressionVelocity } from './regression-velocity';
import { getAnalyticsBrowserMatrix } from './browser-matrix';
import { getAnalyticsSlowEndpoints } from './slow-endpoints';
import { getAnalyticsInsights } from './insights';
import { getAnalyticsStats } from './stats';
import { getAnalyticsMetric } from './metric';
import { getAnalyticsVerdict } from './verdict';
import { getAnalyticsProgress } from './progress';
import { getAnalyticsHandbacks } from './handbacks';
import { getAnalyticsRisks } from './risks';
import { getAnalyticsNewGaps, getAnalyticsScenarioGaps } from './scenario-gaps';
import { getAnalyticsList } from './list';
import { getAnalyticsEvents } from './events';
import { getAnalyticsNote } from './note';
import { getAnalyticsSuiteGrowth } from './suite-growth';
import { getAnalyticsCoverageTrend } from './coverage-trend';
import { getAnalyticsMovers } from './movers';
import { getAnalyticsEnvironmentComparison } from './environment-comparison';
import { getAnalyticsOwnership } from './ownership';
import { getAnalyticsTimeToFix } from './time-to-fix';
import { getAnalyticsFlakyDebt } from './flaky-debt';
import {
  getAnalyticsPerformanceTrend,
  getAnalyticsSelectionHealth,
  getAnalyticsSlowTests,
  getAnalyticsSpecHealth,
  getAnalyticsTimeoutOpportunities,
} from './project-analyses';

export { isAnalyticsWidgetId };
export type { AnalyticsWidgetId, ProjectAccess };

type AnalyticsWidgetHandler = (
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess,
  options: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Widget id → handler. Keyed by the registry union, so forgetting a handler
 * for a registered widget (or vice versa) is a compile error.
 */
const ANALYTICS_WIDGET_HANDLERS: Record<AnalyticsWidgetId, AnalyticsWidgetHandler> = {
  stats: getAnalyticsStats,
  metric: getAnalyticsMetric,
  verdict: getAnalyticsVerdict,
  narrative: getAnalyticsVerdict,
  progress: getAnalyticsProgress,
  handbacks: getAnalyticsHandbacks,
  risks: getAnalyticsRisks,
  insights: getAnalyticsInsights,
  portfolio: getAnalyticsPortfolio,
  'pass-rate-heatmap': getAnalyticsPassRateHeatmap,
  'ci-time-trend': getAnalyticsCiTimeTrend,
  'wasted-time': getAnalyticsWastedTime,
  'flaky-leaderboard': getAnalyticsFlakyLeaderboard,
  'cluster-landscape': getAnalyticsClusterLandscape,
  'regression-velocity': getAnalyticsRegressionVelocity,
  'browser-matrix': getAnalyticsBrowserMatrix,
  'slow-endpoints': getAnalyticsSlowEndpoints,
  'suite-growth': getAnalyticsSuiteGrowth,
  'coverage-trend': getAnalyticsCoverageTrend,
  'flaky-debt': getAnalyticsFlakyDebt,
  'time-to-fix': getAnalyticsTimeToFix,
  ownership: getAnalyticsOwnership,
  'environment-comparison': getAnalyticsEnvironmentComparison,
  movers: getAnalyticsMovers,
  'scenario-gaps': getAnalyticsScenarioGaps,
  'new-gaps': getAnalyticsNewGaps,
  list: getAnalyticsList,
  markers: getAnalyticsEvents,
  text: getAnalyticsNote,
  'spec-health': getAnalyticsSpecHealth,
  'slow-tests': getAnalyticsSlowTests,
  'performance-trend': getAnalyticsPerformanceTrend,
  'timeout-opportunities': getAnalyticsTimeoutOpportunities,
  'selection-health': getAnalyticsSelectionHealth,
};

/**
 * Run one widget. `options` are checked against the widget's schema with the
 * defaults filled in (`WidgetOptionsError` when refused).
 */
export async function runAnalyticsWidget(
  db: DrizzleDB,
  widget: AnalyticsWidgetId,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
  options: unknown = {},
): Promise<unknown> {
  return ANALYTICS_WIDGET_HANDLERS[widget](db, scope, access, parseWidgetOptions(widget, options));
}
