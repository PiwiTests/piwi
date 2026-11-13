import { describe, expect, test } from 'vitest';
import { EN_INSIGHTS, writeInsight, type InsightFacts, type InsightRuleId } from '#shared/analytics/insight-rules';
import type { ProjectTargetVerdict } from '#shared/analytics/targets';
import type {
  AnalyticsBreakdownGroup,
  AnalyticsListItem,
  AnalyticsMarker,
  AnalyticsMetricValue,
  AnalyticsMetricWidget,
} from '#shared/analytics/types';
import { winAnsiSafe } from '#shared/export/render-pdf';
import { chartTickLabel } from '#shared/reports/chart';
import { makeFormatter } from '#shared/reports/format';
import { renderReportEmail } from '#shared/reports/render-email';
import { renderReportMarkdown } from '#shared/reports/render-markdown';
import { renderReportPdf } from '#shared/reports/render-pdf';
import { sentencesFor } from '#shared/reports/sentences';
import { WIDGET_DOCUMENTS, type DocumentContext } from '#shared/reports/widget-documents';
import { GAP_TITLE_SAMPLES } from './gap-title-samples';
import { fixtureBundle } from './report-fixture';

/** Before a colon. */
const NBSP = ' ';
/** Between a number and its unit, before `;` and inside « ». */
const NNBSP = ' ';

const fr = sentencesFor('fr');
const en = sentencesFor('en');
const f = makeFormatter('fr');
const ctx: DocumentContext = { f, s: fr, baseUrl: null, markers: [], drawMarkers: false };

/** One set of facts per insight rule. */
const FACTS: { [K in InsightRuleId]: Extract<InsightFacts, { rule: K }> } = {
  'pass-rate-drop': {
    rule: 'pass-rate-drop',
    project: 'checkout',
    points: 12.5,
    passRate: 80,
    runs: 12,
    vs: { kind: 'previous-unit', unit: 'month' },
  },
  'pass-rate-recovery': {
    rule: 'pass-rate-recovery',
    project: 'checkout',
    points: 1,
    passRate: 95,
    runs: 1,
    vs: { kind: 'previous-days', days: 30 },
  },
  'failing-streak': { rule: 'failing-streak', project: 'checkout', streak: 4, latestRun: { id: 62, status: 'failed' } },
  'stale-cluster': {
    rule: 'stale-cluster',
    title: 'Timeout on pay',
    ageDays: 21,
    occurrences: 1,
    project: 'checkout',
    errorType: null,
  },
  'ci-time-growth': { rule: 'ci-time-growth', deltaPct: 25, minutes: 120, runs: 40, vs: { kind: 'year' } },
  'wasted-ci-time': { rule: 'wasted-ci-time', hours: 2.5, worst: { project: 'checkout', minutes: 90 } },
  'top-flaky-impact': {
    rule: 'top-flaky-impact',
    title: 'pays by card',
    minutes: 12,
    project: 'checkout',
    retryPassRuns: 3,
    totalRuns: 20,
  },
  'regression-surge': {
    rule: 'regression-surge',
    deltaPct: 100,
    total: 10,
    previous: 5,
    vs: { kind: 'previous-sprint' },
  },
  'slow-shared-endpoint': {
    rule: 'slow-shared-endpoint',
    method: 'GET',
    route: '/api/cart',
    p90Ms: 1200,
    projects: 2,
    requests: 300,
    errorRate: 1.5,
  },
  'timeout-hygiene': {
    rule: 'timeout-hygiene',
    title: 'pays by card',
    project: 'checkout',
    staleSlow: false,
    timeoutMs: 120_000,
    p95Ms: 5000,
    recommendedMs: 9000,
    savingMs: 111_000,
  },
  'target-missed': {
    rule: 'target-missed',
    project: 'checkout',
    metric: 'test-pass-rate',
    direction: 'min',
    actual: 87.5,
    target: 99,
  },
  'time-to-fix-growth': {
    rule: 'time-to-fix-growth',
    days: 4,
    previousDays: 0.5,
    fixed: 3,
    vs: { kind: 'range', from: '2026-08-01', to: '2026-08-31' },
  },
  'suite-shrank': { rule: 'suite-shrank', lost: 12, previous: 140, now: 128, vs: { kind: 'previous-release' } },
  'quarantine-debt-growth': {
    rule: 'quarantine-debt-growth',
    added: 4,
    now: 4,
    previous: 0,
    vs: { kind: 'previous-period' },
  },
  'owner-load': { rule: 'owner-load', owner: '@checkout-team', open: 6, total: 9, share: 66.7 },
};

describe('French insights', () => {
  test('every rule is written in French, and the English sentences stay those of the dashboard', () => {
    for (const facts of Object.values(FACTS)) {
      const english = writeInsight(EN_INSIGHTS, facts);
      expect(en.insight(facts, makeFormatter('en')), facts.rule).toEqual(english);
      const french = fr.insight(facts, f);
      expect(french.message, facts.rule).not.toBe(english.message);
      expect(`${french.message} ${french.detail ?? ''}`, facts.rule).not.toMatch(/\b(vs|the|runs?|up from)\b/);
    }
  });

  test('a change is measured « par rapport au mois précédent », a count agrees with its number', () => {
    expect(fr.insight(FACTS['pass-rate-drop'], f)).toEqual({
      message: 'Le taux de réussite de checkout a perdu 12,5 points par rapport au mois précédent',
      detail: `Il est maintenant de 80${NNBSP}% sur 12 exécutions.`,
    });
    expect(fr.insight(FACTS['pass-rate-recovery'], f)).toEqual({
      message: 'Le taux de réussite de checkout a gagné 1 point par rapport aux 30 jours précédents',
      detail: `Il est maintenant de 95${NNBSP}% sur 1 exécution.`,
    });
    expect(fr.insight(FACTS['time-to-fix-growth'], f)).toEqual({
      message: `Le délai médian de correction s’allonge par rapport à la période du 1er août 2026 au 31 août 2026${NBSP}: 4${NNBSP}jours`,
      detail: `Il était de 0,5${NNBSP}jour, sur 3 causes d’échec corrigées pendant la période.`,
    });
    expect(fr.insight(FACTS['target-missed'], f)).toEqual({
      message: `checkout · Taux de réussite des tests${NBSP}: 11,5 points sous l’objectif`,
      detail: `87,5${NNBSP}% pour un objectif d’au moins 99${NNBSP}%.`,
    });
    expect(fr.insight(FACTS['failing-streak'], f).detail).toBe(`Dernière exécution${NBSP}: n°${NNBSP}62, en échec.`);
  });
});

describe('French typography', () => {
  test('a colon takes a no-break space before it, a unit a narrow one, and the singular runs under two', () => {
    expect(fr.colon).toBe(`${NBSP}: `);
    expect(en.colon).toBe(': ');
    expect(f.value(0.5, 'days', 1)).toBe(`0,5${NNBSP}jour`);
    expect(f.value(1.5, 'days', 1)).toBe(`1,5${NNBSP}jour`);
    expect(f.value(2, 'days', 0)).toBe(`2${NNBSP}jours`);
    expect(f.minutes(7.2)).toBe(`7,2${NNBSP}min`);
    expect(f.value(100, 'percent', 0)).toBe(`100${NNBSP}%`);
    expect(makeFormatter('en').value(1, 'days', 0)).toBe('1 day');
    // The first of a month is an ordinal; the other days and English are not.
    expect(f.date('2026-09-01')).toBe('1er sept. 2026');
    expect(f.day('2026-09-01')).toBe('1er sept.');
    expect(f.day('2026-09-11')).toBe('11 sept.');
    expect(makeFormatter('en').day('2026-09-01')).toBe('Sep 1');
    expect(makeFormatter('en').value(0.5, 'days', 1)).toBe('0.5 days');
  });

  test('a target is « d’au moins » or « d’au plus » its value', () => {
    const verdict: ProjectTargetVerdict = {
      projectId: 1,
      projectName: 'checkout',
      key: 'testPassRate',
      metric: 'test-pass-rate',
      direction: 'min',
      stored: 99,
      target: 99,
      actual: 87.5,
      met: false,
    };
    expect(fr.target(verdict, f)).toBe(
      `checkout · Taux de réussite des tests${NBSP}: 87,5${NNBSP}% pour un objectif d’au moins 99${NNBSP}%, manqué.`,
    );
    expect(fr.target({ ...verdict, direction: 'max', met: true }, f)).toContain('d’au plus 99');
  });

  test('a percent axis reads 100 % and a count groups its thousands', () => {
    expect(chartTickLabel({ unit: 'percent' }, 100, f)).toBe(`100${NNBSP}%`);
    expect(chartTickLabel({ unit: 'count' }, 1500, f)).toBe(`1${NNBSP}500`);
  });

  test('the PDF fonts keep the French spaces unbreakable and the minus sign legible', () => {
    expect(winAnsiSafe(`100${NNBSP}%`)).toBe(`100${NBSP}%`);
    expect(winAnsiSafe(`«${NNBSP}Risques${NNBSP}»`)).toBe(`«${NBSP}Risques${NBSP}»`);
    expect(winAnsiSafe(`−2,1${NNBSP}pts`)).toBe(`-2,1${NBSP}pts`);
  });

  test('a French email is framed in French', () => {
    const email = (language: 'en' | 'fr') =>
      renderReportEmail(
        { ...fixtureBundle(), language, locale: language === 'fr' ? 'fr-FR' : 'en-US' },
        { url: 'https://piwi.example/reports/1', chartSrc: null, siteUrl: 'https://piwi.example' },
      ).html;
    expect(email('fr')).toContain('<html lang="fr">');
    expect(email('fr')).toContain('Message automatique envoyé par');
    expect(email('en')).toContain('This is an automated message from');
  });
});

describe('French gap titles', () => {
  test.each(GAP_TITLE_SAMPLES)('%s: %s', (detector, english, french) => {
    expect(fr.gapTitle(detector, english)).toBe(french);
    expect(en.gapTitle(detector, english)).toBe(english);
  });

  test('a title its detector does not match keeps its English text', () => {
    expect(fr.gapTitle('matrix', 'Something else')).toBe('Something else');
    expect(fr.gapTitle(undefined, 'Checkout: thin test matrix')).toBe('Checkout: thin test matrix');
  });
});

describe('French widget documents', () => {
  const item = (facts: AnalyticsListItem['facts'], title = 'x', detail = 'y'): AnalyticsListItem => ({
    id: 1,
    title,
    detail,
    projectName: 'checkout',
    at: null,
    href: '/',
    facts,
  });

  test('a list item is written from its facts', () => {
    const run = item({
      source: 'runs',
      id: 62,
      status: 'failed',
      passed: 8,
      total: 10,
      branch: 'main',
      environment: 'staging',
    });
    expect(fr.listItem(run, f)).toEqual({
      title: `Exécution n°${NNBSP}62`,
      detail: 'en échec · 8/10 réussis · sur main · environnement staging',
    });
    const cause = item({
      source: 'failure-clusters',
      id: 5,
      title: null,
      occurrences: 1,
      errorType: 'TimeoutError',
      assignee: 'Avery',
    });
    expect(fr.listItem(cause, f)).toEqual({
      title: `Cause d’échec n°${NNBSP}5`,
      detail: '1 occurrence · TimeoutError · attribuée à Avery',
    });
    expect(
      fr.listItem(item({ source: 'flaky-tests', score: 42, alternations: 3, totalRuns: 20 }, 'pays by card'), f),
    ).toEqual({
      title: 'pays by card',
      detail: 'score d’instabilité 42 · 3 changements de statut sur 20 exécutions',
    });
    const gap = item(
      { source: 'scenario-gaps', detector: 'matrix', gapClass: 'blind-spot' },
      'Checkout: thin test matrix',
      'blind-spot',
    );
    expect(fr.listItem(gap, f)).toEqual({
      title: `Checkout${NBSP}: matrice de tests trop réduite`,
      detail: 'Angle mort',
    });
    expect(en.listItem(gap, f)).toEqual({ title: 'Checkout: thin test matrix', detail: 'Blind spot' });
    // Without facts the item keeps the sentences its handler wrote.
    expect(fr.listItem(item(undefined, 'Run #1', 'passed'), f)).toEqual({ title: 'Run #1', detail: 'passed' });
  });

  const metricValue = (value: number): AnalyticsMetricValue => ({
    metric: 'test-pass-rate',
    label: 'Test pass rate',
    unit: 'percent',
    betterWhen: 'higher',
    definition: '',
    precision: 1,
    source: 'rollup',
    value,
    previous: null,
    delta: null,
    deltaPct: null,
    trend: null,
    currency: null,
  });
  const group = (key: string, label: string, extra: Partial<AnalyticsBreakdownGroup> = {}) => ({
    key,
    label,
    value: metricValue(90),
    points: null,
    other: false,
    ...extra,
  });
  const breakdownRows = (dimension: string, label: string, groups: AnalyticsBreakdownGroup[]) => {
    const widget: AnalyticsMetricWidget = {
      display: 'table',
      value: metricValue(90),
      bucketDays: 1,
      points: [],
      previousPoints: null,
      comparisonLabel: null,
      breakdown: { dimension, label, groups },
      target: null,
    };
    const [table] = WIDGET_DOCUMENTS.metric(widget, ctx, {});
    if (table?.kind !== 'table') throw new Error('table expected');
    return { header: table.columns[0]!.label, groups: table.rows.map((r) => r.cells.group) };
  };

  test('a breakdown translates the groups Piwi names and keeps the names from the data', () => {
    expect(
      breakdownRows('owner', 'Owner', [
        group('payments', 'payments'),
        group('', 'No owner'),
        group('\u0000other', 'Other (3)', { other: true, rest: 3 }),
      ]),
    ).toEqual({ header: 'Responsable', groups: ['payments', 'Sans responsable', 'Autres (3)'] });
    expect(
      breakdownRows('run-kind', 'Run kind', [group('full', 'Full runs'), group('partial', 'Partial runs')]),
    ).toEqual({ header: 'Type d’exécution', groups: ['Exécutions complètes', 'Exécutions partielles'] });
    expect(breakdownRows('cluster-status', 'Failure cause status', [group('open', 'Open')])).toEqual({
      header: 'Statut de la cause d’échec',
      groups: ['Ouvertes'],
    });
    // A branch named like a label Piwi writes is still a name from the data.
    expect(breakdownRows('branch', 'Branch', [group('Other', 'Other')]).groups).toEqual(['Other']);
  });

  test('a marker across projects joins its project and its label the French way', () => {
    const marker: AnalyticsMarker = {
      id: 1,
      projectId: 1,
      projectName: 'E2E Checkout',
      occurredAt: '2026-09-20T10:00:00.000Z',
      label: 'E2E Checkout: v2.2.0',
      ownLabel: 'v2.2.0',
      description: null,
      category: 'release',
      environment: null,
      source: 'manual',
      runId: null,
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
    };
    const [list] = WIDGET_DOCUMENTS.markers({ markers: [marker] }, ctx, {});
    if (list?.kind !== 'list') throw new Error('list expected');
    expect(list.items[0]!.text).toBe(`20 sept. 2026 · E2E Checkout${NBSP}: v2.2.0`);
  });

  test('a French PDF renders, its axis values and units carrying narrow no-break spaces', async () => {
    const bytes = await renderReportPdf({ ...fixtureBundle(), language: 'fr', locale: 'fr-FR' });
    expect(new TextDecoder('latin1').decode(bytes).startsWith('%PDF-')).toBe(true);
  });

  test('the French Markdown names the markers and puts an item’s detail on its own line', () => {
    const md = renderReportMarkdown({ ...fixtureBundle(), language: 'fr', locale: 'fr-FR' });
    expect(md).toContain(`Repères${NBSP}: 24 sept.${NBSP}: `);
    expect(md).toContain('checkout failed its last 3 runs in a row.  \n  Latest run');
  });
});
