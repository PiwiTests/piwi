import type { AnalyticsHandbacks, AnalyticsProgress, AnalyticsRisks, VerdictFacts } from '#shared/analytics/types';
import { getMetric } from '#shared/analytics/metrics';
import type { ProjectTargetVerdict } from '#shared/analytics/targets';
import { EN_INSIGHTS, writeInsight } from '#shared/analytics/insight-rules';
import type { GapClass } from '#shared/handlers/scenario-gaps';
import { passRateDirection } from './verdict';
import type { ValueFormatter } from './format';
import type { HandbackLine, ReportSentences, ReportTypography } from './sentences';

const TYPOGRAPHY: ReportTypography = {
  locale: 'en-US',
  units: { min: 'min', h: 'h', day: 'day', days: 'days', pts: 'pts' },
  singular: (count) => Math.abs(count) === 1,
  unitSpace: ' ',
  spacedPercent: false,
  date: (text) => text,
};

const plural = (n: number, one: string, many: string) => (TYPOGRAPHY.singular(n) ? one : many);
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function branchText(facts: VerdictFacts): string {
  const { kind, branches } = facts.branch;
  if (kind === 'any') return 'across all branches';
  if (branches.length === 1) return `on ${branches[0]}`;
  if (kind === 'default') return 'on the default branches';
  return `on ${branches.join(', ')}`;
}

function comparisonText(facts: VerdictFacts): string {
  switch (facts.comparison) {
    case 'year':
      return 'a year earlier';
    case 'previous-unit':
      return 'the previous period';
    case 'custom':
      return 'the comparison period';
    default:
      return 'the previous period';
  }
}

function verdict(facts: VerdictFacts, f: ValueFormatter): string {
  if (facts.runs === 0 || facts.passRate === null) {
    return 'No runs were recorded for this scope in the period.';
  }
  const rate = f.value(facts.passRate, 'percent', 1);
  const where = branchText(facts);
  const direction = passRateDirection(facts);
  const points = facts.passRateDelta === null ? '' : f.number(Math.abs(facts.passRateDelta), 1);
  const fixed =
    facts.fixed > 0
      ? `, and ${facts.fixed} ${plural(facts.fixed, 'failure cause was', 'failure causes were')} fixed`
      : '';
  let first: string;
  if (direction === 'up') {
    first = `The suite is healthier than ${comparisonText(facts)}: the pass rate ${where} rose ${points} points to ${rate}${fixed}.`;
  } else if (direction === 'down') {
    first = `The suite is less healthy than ${comparisonText(facts)}: the pass rate ${where} fell ${points} points to ${rate}${fixed}.`;
  } else if (facts.previousPassRate !== null) {
    first = `The suite is holding steady: the pass rate ${where} is ${rate}, as in ${comparisonText(facts)}${fixed}.`;
  } else {
    first = `The pass rate ${where} is ${rate}${fixed}.`;
  }
  const rest: string[] = [];
  if (facts.open > 0) {
    rest.push(`${facts.open} ${plural(facts.open, 'failure cause is', 'failure causes are')} still open.`);
  }
  if (facts.wastedMinutes >= 1) {
    const cost = facts.wastedCost
      ? ` (${f.value(facts.wastedCost.amount, 'money', 2, facts.wastedCost.currency)})`
      : '';
    rest.push(`Failed attempts and waits cost ${f.minutes(facts.wastedMinutes)} of CI time${cost}.`);
  }
  return [first, ...rest].join(' ');
}

function progress(p: AnalyticsProgress): string[] {
  const lines: string[] = [];
  if (p.fixed > 0) {
    const held = p.held === p.fixed ? (p.fixed === 1 ? 'it held' : 'all held') : `${p.held} held`;
    lines.push(`${p.fixed} ${plural(p.fixed, 'failure cause', 'failure causes')} fixed; ${held}.`);
  } else {
    lines.push('No failure cause was fixed in the period.');
  }
  if (p.assigned > 0 || p.withTicket > 0) {
    lines.push(
      `${p.assigned} open ${plural(p.assigned, 'cause is', 'causes are')} assigned, ${p.withTicket} ${plural(p.withTicket, 'has', 'have')} a ticket.`,
    );
  }
  if (p.releasedFromQuarantine > 0 || p.quarantined > 0) {
    lines.push(
      `${p.releasedFromQuarantine} ${plural(p.releasedFromQuarantine, 'test', 'tests')} released from quarantine, ${p.quarantined} quarantined.`,
    );
  }
  if (p.healPullRequests > 0) {
    lines.push(`${p.healPullRequests} auto-heal pull ${plural(p.healPullRequests, 'request', 'requests')} opened.`);
  }
  return lines;
}

/** `(75%)`, or why there is no rate: none to judge, or fewer than the floor. */
function rateText(part: number, whole: number, min: number, f: ValueFormatter, items: string): string {
  if (whole === 0) return '';
  if (whole < min) return ` (too few ${items} for a rate, ${whole} of the ${min} needed)`;
  return ` (${f.value(Math.round((Math.min(part, whole) / whole) * 1000) / 10, 'percent', 0)})`;
}

function handbacks(d: AnalyticsHandbacks, f: ValueFormatter): HandbackLine[] {
  const lines: HandbackLine[] = [];
  const heals: string[] = [];
  if (d.heals && (d.heals.suggested > 0 || d.heals.adopted > 0)) {
    heals.push(
      `${d.heals.adopted} ${plural(d.heals.adopted, 'call site now uses', 'call sites now use')} the recommended locator, of ${d.heals.suggested} suggested`,
    );
  }
  const prs = d.healPullRequests;
  if (prs && (prs.opened > 0 || prs.merged > 0 || prs.closed > 0)) {
    const settled = prs.merged + prs.closed;
    heals.push(
      `${prs.merged} auto-heal pull ${plural(prs.merged, 'request', 'requests')} merged, ${prs.closed} closed${rateText(prs.merged, settled, d.minSample, f, 'closed pull requests')}`,
    );
  }
  if (heals.length > 0) lines.push({ label: 'Locator heals', text: `${heals.join(' · ')}.` });

  const dx = d.diagnoses;
  if (dx && (dx.written > 0 || dx.diagnosedFixes > 0)) {
    const parts = [`${dx.written} written`];
    if (dx.rated > 0) {
      parts.push(
        `rated helpful ${dx.helpful} of ${dx.rated}${rateText(dx.helpful, dx.rated, d.minSample, f, 'ratings')}`,
      );
    }
    if (dx.diagnosedFixes > 0) {
      parts.push(
        `the fix touched the diagnosed files in ${Math.min(dx.verified, dx.diagnosedFixes)} of ${dx.diagnosedFixes} fixed ${plural(dx.diagnosedFixes, 'cause', 'causes')}${rateText(dx.verified, dx.diagnosedFixes, d.minSample, f, 'fixes')}`,
      );
    }
    if (dx.regressed > 0) parts.push(`${dx.regressed} failed again after the fix`);
    lines.push({ label: 'AI diagnoses', text: `${parts.join(' · ')}.` });
  }

  const g = d.gate;
  if (g && (g.blocked > 0 || g.overrides > 0 || g.escapes > 0)) {
    const parts = [`blocked ${g.blocked} ${plural(g.blocked, 'merge', 'merges')}`];
    if (g.overrides > 0 || g.escapes > 0) {
      const escaped = g.escapes > 0 ? `, ${g.escapes} then failed again on the default branch` : '';
      parts.push(`${g.overrides} merged anyway${escaped}`);
    }
    lines.push({ label: 'CI gate', text: `${parts.join(' · ')}.` });
  }

  const fl = d.flakes;
  if (fl && (fl.verified > 0 || fl.regressed > 0)) {
    const again = fl.regressed > 0 ? ` · ${fl.regressed} flaked again` : '';
    lines.push({ label: 'Flaky tests', text: `${fl.verified} verified fixed with Flake Lab${again}.` });
  }

  const fx = d.fixAttempts;
  if (fx && (fx.reported > 0 || fx.verified > 0 || fx.regressed > 0)) {
    const again = fx.regressed > 0 ? ` · ${fx.regressed} failed again` : '';
    lines.push({
      label: 'Fix attempts',
      text: `${fx.reported} reported · ${fx.verified} confirmed by the fix${again}.`,
    });
  }
  return lines;
}

function target(v: ProjectTargetVerdict, f: ValueFormatter): string {
  const def = getMetric(v.metric);
  const goal = `${v.direction === 'min' ? 'at least' : 'at most'} ${f.value(v.target, def.unit, def.precision)}`;
  const actual = f.value(v.actual, def.unit, def.precision);
  const outcome = v.met === null ? 'nothing to judge it on yet' : v.met ? 'met' : 'missed';
  return `${v.projectName} · ${def.label}: ${actual} for a target of ${goal}, ${outcome}.`;
}

function risks(r: AnalyticsRisks, f: ValueFormatter): string[] {
  const lines: string[] = [];
  for (const t of r.missedTargets) lines.push(target(t, f));
  for (const m of r.worsening) {
    const change = f.delta({ unit: m.unit, delta: m.delta, deltaPct: m.deltaPct, precision: 1 });
    lines.push(`${m.label} moved the wrong way: ${f.value(m.value, m.unit, 1)} (${change}).`);
  }
  for (const p of r.failingProjects) {
    lines.push(`${p.name} failed its last ${p.streak} runs in a row.`);
  }
  for (const c of r.oldestOpen) {
    const owner = c.assignee ? `, assigned to ${c.assignee}` : ', unassigned';
    lines.push(`"${c.title}" (${c.projectName}) has been open ${f.value(c.ageDays, 'days', 0)}${owner}.`);
  }
  if (r.quarantine.count > 0) {
    const oldest =
      r.quarantine.oldestDays !== null ? `, the oldest for ${f.value(r.quarantine.oldestDays, 'days', 0)}` : '';
    lines.push(`${r.quarantine.count} ${plural(r.quarantine.count, 'test is', 'tests are')} in quarantine${oldest}.`);
  }
  return lines;
}

const GAP_CLASS_LABELS: Record<GapClass, string> = {
  'blind-spot': 'Blind spot',
  'false-comfort': 'False comfort',
  fragile: 'Fragile',
  unhandled: 'Unhandled',
  degraded: 'Degraded',
};

const gapClassLabel = (cls: string) => GAP_CLASS_LABELS[cls as GapClass] ?? cls;

export const EN_SENTENCES: ReportSentences = {
  name: 'English',
  englishName: 'English',
  typography: TYPOGRAPHY,
  labels: {
    qualityReport: 'Quality report',
    period: 'Period',
    comparedWith: 'Compared with',
    noComparison: 'No comparison',
    projects: 'Projects',
    allProjects: 'All projects',
    branchPolicy: 'Branches',
    defaultBranch: 'Each project’s default branch, plus runs with no known branch',
    allBranches: 'All branches',
    branches: 'Branches',
    fullRunsOnly: 'Full runs only',
    allRuns: 'Full and partial runs',
    testFilter: 'Tests',
    definitions: 'Definitions',
    limits: 'Limits',
    generated: 'Generated',
    generatedBy: 'Generated by Piwi',
    openInPiwi: 'Open in Piwi',
    liveDashboard: 'Live dashboard: the numbers are computed at every view, and the page reloads every minute.',
    readWithoutAccount: 'Read without an account',
    dashboard: 'Dashboard',
    noData: 'Nothing to show for this period.',
    previous: 'Previous',
    metric: 'Metric',
    value: 'Value',
    change: 'Change',
    date: 'Date',
    unavailable: 'This widget is no longer available.',
    daysAreUtc: 'Days are UTC.',
    feature: 'Feature',
    gapClass: 'Class',
    score: 'Score',
    count: 'Count',
    targets: 'Targets',
    markers: 'Markers',
    narrative: 'Narrative',
    automatedMessage: 'This is an automated message from',
    sentBy: 'Sent by Piwi',
  },
  verdict,
  progress,
  handbacks,
  risks,
  target,
  tileTarget: (mark, value) => {
    const judged = mark.met + mark.missed;
    if (value !== null) {
      const outcome = mark.met > 0 ? 'met' : mark.missed > 0 ? 'missed' : 'nothing to judge yet';
      return `Target ${mark.direction === 'min' ? 'at least' : 'at most'} ${value}, ${outcome}`;
    }
    if (judged === 0) return 'Target set, nothing to judge yet';
    return `${mark.met} of ${judged} ${plural(judged, 'project meets', 'projects meet')} the target`;
  },
  colon: ': ',
  insight: (facts) => writeInsight(EN_INSIGHTS, facts),
  metricLabel: (_id, fallback) => fallback,
  metricDefinition: (_id, fallback) => fallback,
  titles: {},
  title: (text) => text,
  dateRange: (from, to) => `${from} to ${to}`,
  period: (name, range) => (name ? `${name} (${range})` : range),
  comparison: (name, range) => `${lowerFirst(name)} (${range})`,
  reportTitle: (scope, name, range) => `${scope}, ${name ?? range}`,
  projectCount: (n) => `${n} ${plural(n, 'project', 'projects')}`,
  testFilterNote: (title) => `${title} is not narrowed by the test filter.`,
  testFilterLimit: (start) =>
    start
      ? `The test filter counts stored executions, which start on ${start}.`
      : 'The test filter counts stored executions, which reach back only as far as retention keeps runs.',
  identityLimit: 'Lists of tests and flaky-test counts reach back only as far as retention keeps runs.',
  gapClass: gapClassLabel,
  gapTitle: (_detector, title) => title,
  listItem: (item) => ({
    title: item.title,
    detail: item.facts?.source === 'scenario-gaps' ? gapClassLabel(item.facts.gapClass) : item.detail,
  }),
  firstRunLimit: (since) =>
    `This first scheduled quality report covers only the days since the schedule was created, ${since}.`,
  narrativeGenerated: (model) =>
    `Generated by an AI model (${model}) from the numbers of this report only. The tiles and the verdict above are computed by rules; trust them over this text.`,
  narrativeFallback: 'No AI narrative could be generated for this report, so the rule-based verdict stands in.',
  badge: {
    label: (branches) => `tests on ${branches}`,
    allBranches: 'all branches',
    defaultBranch: 'default branch',
    days: (n) => `${n} d`,
    verdict: { good: 'healthy', mixed: 'mixed', bad: 'poor' },
  },
};
