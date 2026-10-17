import { getMetric, type MetricId } from '#shared/analytics/metrics';
import type { ProjectTargetVerdict } from '#shared/analytics/targets';
import type {
  AnalyticsHandbacks,
  AnalyticsListItem,
  AnalyticsProgress,
  AnalyticsRisks,
  VerdictFacts,
} from '#shared/analytics/types';
import {
  targetGapValue,
  writeInsight,
  type InsightComparison,
  type InsightPhrasebook,
} from '#shared/analytics/insight-rules';
import type { GapClass } from '#shared/handlers/scenario-gaps';
import { passRateDirection } from './verdict';
import type { ValueFormatter } from './format';
import type { HandbackLine, ReportSentences, ReportTypography } from './sentences';

/** Before a colon. */
const NBSP = '\u00a0';
/** Before a semicolon and between a number and its unit. */
const NNBSP = '\u202f';

const TYPOGRAPHY: ReportTypography = {
  locale: 'fr-FR',
  units: { min: 'min', h: 'h', day: 'jour', days: 'jours', pts: 'pts' },
  // The singular under two (0,5 jour, 1 test), the plural from two.
  singular: (count) => Math.abs(count) < 2,
  unitSpace: NNBSP,
  spacedPercent: true,
  // The first of a month is an ordinal: 1er sept.
  date: (text) => text.replace(/^1(?=\s)/, '1er'),
};

const plural = (n: number, one: string, many: string) => (TYPOGRAPHY.singular(n) ? one : many);

const METRIC_LABELS: Record<MetricId, [label: string, definition: string]> = {
  'test-pass-rate': [
    'Taux de réussite des tests',
    'Tests réussis divisés par tests exécutés, sommés sur les exécutions de la période.',
  ],
  'run-success-rate': ['Taux de succès des exécutions', 'Part des exécutions terminées dont le statut est réussi.'],
  runs: ['Exécutions', 'Exécutions terminées dans la période.'],
  'suite-size': ['Taille de la suite', 'Le plus grand nombre de tests rapporté par une exécution de la période.'],
  'flaky-occurrences': [
    'Occurrences instables',
    'Tests réussis seulement après une nouvelle tentative, sommés sur les exécutions de la période.',
  ],
  'flaky-tests': [
    'Tests instables',
    'Tests distincts réussis seulement après une nouvelle tentative au moins une fois dans la période.',
  ],
  'wasted-ci-minutes': [
    'Minutes de CI perdues',
    'Minutes passées dans des étapes d’attente plus minutes d’exécution de tentatives terminées en échec ou en dépassement de délai.',
  ],
  'wasted-ci-cost': [
    'Coût de la CI perdue',
    'Minutes de CI perdues multipliées par le coût configuré d’une minute de CI.',
  ],
  'ci-time': ['Temps de CI', 'Somme des durées des exécutions de la période.'],
  'new-regressions': [
    'Nouvelles régressions',
    'Exécutions d’un test en échec après avoir réussi lors de l’exécution précédente.',
  ],
  'newly-flaky': ['Nouvellement instables', 'Exécutions d’un test devenu instable lors de cette exécution.'],
  'average-run-duration': ['Durée moyenne d’une exécution', 'Somme des durées des exécutions divisée par leur nombre.'],
  'average-p90-test-duration': [
    'Durée p90 moyenne des tests',
    'Somme du 90e centile des durées de test de chaque exécution, divisée par le nombre d’exécutions.',
  ],
  'open-failure-causes': [
    'Causes d’échec ouvertes',
    'Groupes d’échecs ouverts et non mis en veille à la fin de la période.',
  ],
  'failure-causes-opened': ['Causes d’échec apparues', 'Groupes d’échecs créés dans la période.'],
  'failure-causes-fixed': [
    'Causes d’échec corrigées',
    'Groupes d’échecs dont le correctif est arrivé dans la période.',
  ],
  'median-time-to-fix': [
    'Délai médian de correction',
    'Délai médian entre le premier échec et le correctif, sur les groupes d’échecs corrigés dans la période.',
  ],
  'oldest-open-failure-cause': ['Plus ancienne cause ouverte', 'Âge du plus ancien groupe d’échecs ouvert.'],
  'fixes-that-held': [
    'Correctifs tenus',
    'Groupes d’échecs corrigés dans la période et sans régression depuis, sur les groupes corrigés.',
  ],
  'quarantine-debt': ['Dette de quarantaine', 'Tests en quarantaine.'],
  'open-scenario-gaps': [
    'Lacunes de scénario ouvertes',
    'Lacunes de scénario ouvertes, par classe : angle mort, fausse assurance, fragile.',
  ],
  'gaps-closed': ['Lacunes fermées', 'Lacunes de scénario fermées dans la période.'],
  'accepted-but-unwritten': [
    'Acceptées mais non écrites',
    'Lacunes acceptées il y a plus d’une semaine dont la fonctionnalité n’a toujours pas de test fiable.',
  ],
  'open-resilience-findings': [
    'Constats de résilience ouverts',
    'Constats ouverts des sondes serveur, dans les classes non géré et dégradé.',
  ],
  'heal-adoption': [
    'Réparations adoptées',
    'Appels de localisateur en échec dont le code a ensuite utilisé le localisateur recommandé par Piwi, vus dans la période, quel que soit l’auteur du changement.',
  ],
  'heal-pr-merge-rate': [
    'Taux de fusion des réparations',
    'Pull requests de réparation automatique fusionnées dans la période, sur celles fusionnées ou fermées sans fusion.',
  ],
  'diagnosis-helpful-rate': [
    'Diagnostics jugés utiles',
    'Diagnostics écrits dans la période et jugés utiles, sur ceux jugés utiles ou inutiles.',
  ],
  'diagnosis-verified-rate': [
    'Diagnostics confirmés par le correctif',
    'Causes d’échec diagnostiquées corrigées dans la période dont le correctif a modifié les fichiers nommés par le diagnostic, sur les causes diagnostiquées corrigées dans la période.',
  ],
  'gate-blocked-merges': [
    'Fusions bloquées par la barrière',
    'Évaluations de la barrière en échec dans la période, chacune retenant une fusion.',
  ],
  'gate-overrides': [
    'Barrière contournée',
    'Pull requests fusionnées dans la période alors que leur dernière évaluation de la barrière avait échoué.',
  ],
  'flakes-verified-fixed': [
    'Instabilités corrigées vérifiées',
    'Tests instables qu’une vérification Flake Lab a prouvés corrigés dans la période.',
  ],
};

const TITLES: Record<string, string> = {
  // The built-in dashboards
  Overview: 'Vue d’ensemble',
  Executive: 'Direction',
  Engineering: 'Ingénierie',
  Team: 'Équipe',
  'Gaps digest': 'Synthèse des lacunes',
  'Where things stand': 'Où en sont les choses',
  'Where the pain is': 'Où ça fait mal',
  'Which way it is going': 'Dans quelle direction',
  'What is being done': 'Ce qui est fait',
  Detail: 'Détail',
  Trends: 'Tendances',
  'The state of the projects in scope, against the comparison period.':
    'L’état des projets couverts, par rapport à la période de comparaison.',
  'Movement over the period.': 'L’évolution sur la période.',
  'Fixes, triage and the risks still open.': 'Correctifs, tri et risques encore ouverts.',
  'What is costing the most time and attention.': 'Ce qui coûte le plus de temps et d’attention.',
  'Regressions, CI time, combined coverage and the tests that moved over the period.':
    'Régressions, temps de CI, couverture combinée et tests qui ont évolué sur la période.',
  'Environments, browsers and shared endpoints.': 'Environnements, navigateurs et endpoints partagés.',
  'The state of every project right now.': 'L’état de chaque projet en ce moment.',
  'What is costing you the most time and attention.': 'Ce qui vous coûte le plus de temps et d’attention.',
  'Movement over the selected period.': 'L’évolution sur la période choisie.',
  'Breakdowns to reach for once you know what you are chasing.': 'Les détails, une fois la piste trouvée.',
  Verdict: 'Verdict',
  'Headline numbers': 'Chiffres clés',
  'Pass rate over time': 'Taux de réussite dans le temps',
  'What changed': 'Ce qui a changé',
  'Fixes and triage': 'Correctifs et tri',
  'Hand-back outcomes': 'Devenir des propositions',
  Insights: 'Constats',
  Risks: 'Risques',
  'Portfolio health': 'Santé du portefeuille',
  'Pass rate heatmap': 'Carte de chaleur du taux de réussite',
  'Failure clusters': 'Groupes d’échecs',
  'Flakiest tests': 'Tests les plus instables',
  'Wasted CI time': 'Temps de CI perdu',
  'Regression velocity': 'Rythme des régressions',
  'CI time': 'Temps de CI',
  'Browser matrix': 'Matrice des navigateurs',
  'Slow endpoints': 'Endpoints lents',
  'Wait steps': 'Étapes d’attente',
  'Failed attempts': 'Tentatives en échec',
  Endpoint: 'Endpoint',
  Errors: 'Erreurs',
  'Status flips': 'Changements de statut',
  Age: 'Âge',
  'Failure cause': 'Cause d’échec',
  'Scenario gaps': 'Lacunes de scénario',
  'New scenario gaps': 'Nouvelles lacunes de scénario',
  'What the tests do not reach yet, from the Test Map.':
    'Ce que les tests n’atteignent pas encore, d’après la Test Map.',
  'The top new gaps of each project in the period.':
    'Les principales nouvelles lacunes de chaque projet sur la période.',
  'Where the gaps stand': 'Où en sont les lacunes',
  'Top new gaps by project': 'Principales nouvelles lacunes par projet',
  'Suite growth': 'Croissance de la suite',
  'Coverage trend': 'Évolution de la couverture',
  'Line coverage': 'Couverture des lignes',
  Skipped: 'Ignorés',
  'Did not run': 'Non exécutés',
  'Flaky debt': 'Dette d’instabilité',
  'Time to fix': 'Délai de correction',
  Ownership: 'Responsables',
  'Environment comparison': 'Comparaison des environnements',
  Environment: 'Environnement',
  Movers: 'Évolutions',
  'Timeline markers': 'Repères de chronologie',
  Now: 'Maintenant',
  'Became flaky': 'Devenus instables',
  'Stopped being flaky': 'Redevenus stables',
  'Got slower': 'Plus lents',
  'Got faster': 'Plus rapides',
  Owner: 'Responsable',
  Unowned: 'Sans responsable',
  'p90 time to fix': 'Délai de correction p90',
  'Under a day': 'Moins d’un jour',
  '1 to 7 days': '1 à 7 jours',
  '7 to 30 days': '7 à 30 jours',
  '30 to 90 days': '30 à 90 jours',
  'Over 90 days': 'Plus de 90 jours',
  'Flaky occurrences per run': 'Occurrences instables par exécution',
  'Open gaps by class and by feature, and the gaps closed.':
    'Les lacunes ouvertes par classe et par fonctionnalité, et les lacunes fermées.',
  // Widget titles of the registry, for the dashboards people build
  List: 'Liste',
  Metric: 'Indicateur',
  Narrative: 'Récit',
  Note: 'Note',
  'Performance trend': 'Tendance des performances',
  'Selection health': 'Santé des sélections',
  'Slowest tests': 'Tests les plus lents',
  'Spec health': 'Santé des fichiers de test',
  'Timeout opportunities': 'Délais d’expiration à réduire',
  // Table columns
  Name: 'Nom',
  Date: 'Date',
  Test: 'Test',
  Change: 'Évolution',
  Average: 'Moyenne',
  Timeout: 'Délai d’expiration',
  Suggested: 'Suggéré',
  Selection: 'Sélection',
  Warnings: 'Avertissements',
  Flaky: 'Instables',
  // The dimensions a metric is broken down by
  Project: 'Projet',
  'Project tag': 'Étiquette de projet',
  Branch: 'Branche',
  'Run kind': 'Type d’exécution',
  Browser: 'Navigateur',
  'Test tag': 'Étiquette de test',
  Priority: 'Priorité',
  Feature: 'Fonctionnalité',
  'Spec directory': 'Dossier de tests',
  'Error type': 'Type d’erreur',
  'Failure cause status': 'Statut de la cause d’échec',
  Assignee: 'Attribuée à',
  'Gap class': 'Classe de lacune',
  // The groups of a breakdown that Piwi names (the others are names from the data)
  Other: 'Autres',
  None: 'Aucun',
  'No project tag': 'Sans étiquette de projet',
  'No environment': 'Sans environnement',
  'Unknown branch': 'Branche inconnue',
  'Unknown browser': 'Navigateur inconnu',
  'No tag': 'Sans étiquette',
  'No owner': 'Sans responsable',
  'No priority': 'Sans priorité',
  'No feature': 'Sans fonctionnalité',
  'Unknown error type': 'Type d’erreur inconnu',
  Unassigned: 'Non attribuée',
  'Full runs': 'Exécutions complètes',
  'Partial runs': 'Exécutions partielles',
  Open: 'Ouvertes',
  Resolved: 'Résolues',
  Ignored: 'Ignorées',
};

const GAP_CLASS_LABELS: Record<GapClass, string> = {
  'blind-spot': 'Angle mort',
  'false-comfort': 'Fausse assurance',
  fragile: 'Fragile',
  unhandled: 'Non géré',
  degraded: 'Dégradé',
};

const gapClassLabel = (cls: string) => GAP_CLASS_LABELS[cls as GapClass] ?? cls;

function branchText(facts: VerdictFacts): string {
  const { kind, branches } = facts.branch;
  if (kind === 'any') return 'sur toutes les branches';
  if (branches.length === 1) return `sur ${branches[0]}`;
  if (kind === 'default') return 'sur les branches par défaut';
  return `sur ${branches.join(', ')}`;
}

function comparisonText(facts: VerdictFacts): string {
  if (facts.comparison === 'year') return 'un an plus tôt';
  if (facts.comparison === 'custom') return 'la période de comparaison';
  return 'la période précédente';
}

function verdict(facts: VerdictFacts, f: ValueFormatter): string {
  if (facts.runs === 0 || facts.passRate === null) {
    return 'Aucune exécution n’a été enregistrée pour ce périmètre sur la période.';
  }
  const rate = f.value(facts.passRate, 'percent', 1);
  const where = branchText(facts);
  const direction = passRateDirection(facts);
  const points = facts.passRateDelta === null ? '' : f.number(Math.abs(facts.passRateDelta), 1);
  const fixed =
    facts.fixed > 0
      ? `, et ${facts.fixed} ${plural(facts.fixed, 'cause d’échec a été corrigée', 'causes d’échec ont été corrigées')}`
      : '';
  let first: string;
  if (direction === 'up') {
    first = `La suite se porte mieux que ${comparisonText(facts)} : le taux de réussite ${where} a gagné ${points} points pour atteindre ${rate}${fixed}.`;
  } else if (direction === 'down') {
    first = `La suite se porte moins bien que ${comparisonText(facts)} : le taux de réussite ${where} a perdu ${points} points pour tomber à ${rate}${fixed}.`;
  } else if (facts.previousPassRate !== null) {
    first = `La suite est stable : le taux de réussite ${where} est de ${rate}, comme ${comparisonText(facts)}${fixed}.`;
  } else {
    first = `Le taux de réussite ${where} est de ${rate}${fixed}.`;
  }
  const rest: string[] = [];
  if (facts.open > 0) {
    rest.push(`${facts.open} ${plural(facts.open, 'cause d’échec reste ouverte', 'causes d’échec restent ouvertes')}.`);
  }
  if (facts.wastedMinutes >= 1) {
    const cost = facts.wastedCost
      ? ` (${f.value(facts.wastedCost.amount, 'money', 2, facts.wastedCost.currency)})`
      : '';
    rest.push(`Les tentatives en échec et les attentes ont coûté ${f.minutes(facts.wastedMinutes)} de CI${cost}.`);
  }
  return [first, ...rest].join(' ');
}

function progress(p: AnalyticsProgress): string[] {
  const lines: string[] = [];
  if (p.fixed > 0) {
    const held =
      p.held === p.fixed
        ? p.fixed === 1
          ? 'le correctif a tenu'
          : 'tous ont tenu'
        : `${p.held} ${plural(p.held, 'a tenu', 'ont tenu')}`;
    lines.push(`${p.fixed} ${plural(p.fixed, 'cause d’échec corrigée', 'causes d’échec corrigées')} ; ${held}.`);
  } else {
    lines.push('Aucune cause d’échec n’a été corrigée sur la période.');
  }
  if (p.assigned > 0 || p.withTicket > 0) {
    lines.push(
      `${p.assigned} ${plural(p.assigned, 'cause ouverte est attribuée', 'causes ouvertes sont attribuées')}, ${p.withTicket} ${plural(p.withTicket, 'a un ticket', 'ont un ticket')}.`,
    );
  }
  if (p.releasedFromQuarantine > 0 || p.quarantined > 0) {
    lines.push(
      `${p.releasedFromQuarantine} ${plural(p.releasedFromQuarantine, 'test sorti', 'tests sortis')} de quarantaine, ${p.quarantined} ${plural(p.quarantined, 'mis', 'mis')} en quarantaine.`,
    );
  }
  if (p.healPullRequests > 0) {
    lines.push(
      `${p.healPullRequests} ${plural(p.healPullRequests, 'pull request de réparation automatique ouverte', 'pull requests de réparation automatique ouvertes')}.`,
    );
  }
  return lines;
}

/** `(75 %)`, or why there is no rate: none to judge, or fewer than the floor. */
function rateText(part: number, whole: number, min: number, f: ValueFormatter, items: string): string {
  if (whole === 0) return '';
  if (whole < min) return ` (trop peu de ${items} pour un taux, ${whole} sur les ${min} nécessaires)`;
  return ` (${f.value(Math.round((Math.min(part, whole) / whole) * 1000) / 10, 'percent', 0)})`;
}

function handbacks(d: AnalyticsHandbacks, f: ValueFormatter): HandbackLine[] {
  const lines: HandbackLine[] = [];
  const heals: string[] = [];
  if (d.heals && (d.heals.suggested > 0 || d.heals.adopted > 0)) {
    heals.push(
      `${d.heals.adopted} ${plural(d.heals.adopted, 'appel utilise', 'appels utilisent')} désormais le localisateur recommandé, sur ${d.heals.suggested} ${plural(d.heals.suggested, 'proposé', 'proposés')}`,
    );
  }
  const prs = d.healPullRequests;
  if (prs && (prs.opened > 0 || prs.merged > 0 || prs.closed > 0)) {
    const settled = prs.merged + prs.closed;
    heals.push(
      `${prs.merged} ${plural(prs.merged, 'pull request de réparation fusionnée', 'pull requests de réparation fusionnées')}, ${prs.closed} ${plural(prs.closed, 'fermée', 'fermées')}${rateText(prs.merged, settled, d.minSample, f, 'pull requests fermées')}`,
    );
  }
  if (heals.length > 0) lines.push({ label: 'Réparations de localisateurs', text: `${heals.join(' · ')}.` });

  const dx = d.diagnoses;
  if (dx && (dx.written > 0 || dx.diagnosedFixes > 0)) {
    const parts = [`${dx.written} ${plural(dx.written, 'écrit', 'écrits')}`];
    if (dx.rated > 0) {
      parts.push(
        `${dx.helpful} ${plural(dx.helpful, 'jugé utile', 'jugés utiles')} sur ${dx.rated}${rateText(dx.helpful, dx.rated, d.minSample, f, 'avis')}`,
      );
    }
    if (dx.diagnosedFixes > 0) {
      parts.push(
        `le correctif a touché les fichiers diagnostiqués pour ${Math.min(dx.verified, dx.diagnosedFixes)} ${plural(dx.diagnosedFixes, 'cause corrigée', 'causes corrigées')} sur ${dx.diagnosedFixes}${rateText(dx.verified, dx.diagnosedFixes, d.minSample, f, 'correctifs')}`,
      );
    }
    if (dx.regressed > 0) {
      parts.push(
        `${dx.regressed} ${plural(dx.regressed, 'a de nouveau échoué', 'ont de nouveau échoué')} après le correctif`,
      );
    }
    lines.push({ label: 'Diagnostics IA', text: `${parts.join(' · ')}.` });
  }

  const g = d.gate;
  if (g && (g.blocked > 0 || g.overrides > 0 || g.escapes > 0)) {
    const parts = [`${g.blocked} ${plural(g.blocked, 'fusion bloquée', 'fusions bloquées')}`];
    if (g.overrides > 0 || g.escapes > 0) {
      const escaped =
        g.escapes > 0
          ? `, ${g.escapes} ${plural(g.escapes, 'a ensuite échoué', 'ont ensuite échoué')} sur la branche par défaut`
          : '';
      parts.push(`${g.overrides} ${plural(g.overrides, 'fusionnée', 'fusionnées')} malgré tout${escaped}`);
    }
    lines.push({ label: 'Barrière de CI', text: `${parts.join(' · ')}.` });
  }

  const fl = d.flakes;
  if (fl && (fl.verified > 0 || fl.regressed > 0)) {
    const again =
      fl.regressed > 0
        ? ` · ${fl.regressed} ${plural(fl.regressed, 'est redevenu instable', 'sont redevenus instables')}`
        : '';
    lines.push({
      label: 'Tests instables',
      text: `${fl.verified} ${plural(fl.verified, 'correction vérifiée', 'corrections vérifiées')} avec Flake Lab${again}.`,
    });
  }

  const fx = d.fixAttempts;
  if (fx && (fx.reported > 0 || fx.verified > 0 || fx.regressed > 0)) {
    const again =
      fx.regressed > 0
        ? ` · ${fx.regressed} ${plural(fx.regressed, 'a de nouveau échoué', 'ont de nouveau échoué')}`
        : '';
    lines.push({
      label: 'Tentatives de correction',
      text: `${fx.reported} ${plural(fx.reported, 'signalée', 'signalées')} · ${fx.verified} ${plural(fx.verified, 'confirmée', 'confirmées')} par le correctif${again}.`,
    });
  }
  return lines;
}

function target(v: ProjectTargetVerdict, f: ValueFormatter): string {
  const def = getMetric(v.metric);
  const label = METRIC_LABELS[v.metric]?.[0] ?? def.label;
  const goal = `${v.direction === 'min' ? 'd’au moins' : 'd’au plus'} ${f.value(v.target, def.unit, def.precision)}`;
  const actual = f.value(v.actual, def.unit, def.precision);
  const outcome = v.met === null ? 'rien encore pour en juger' : v.met ? 'atteint' : 'manqué';
  return `${v.projectName} · ${label} : ${actual} pour un objectif ${goal}, ${outcome}.`;
}

function risks(r: AnalyticsRisks, f: ValueFormatter): string[] {
  const lines: string[] = [];
  for (const t of r.missedTargets) lines.push(target(t, f));
  for (const m of r.worsening) {
    const change = f.delta({ unit: m.unit, delta: m.delta, deltaPct: m.deltaPct, precision: 1 });
    const label = METRIC_LABELS[m.metric]?.[0] ?? m.label;
    lines.push(`${label} évolue dans le mauvais sens : ${f.value(m.value, m.unit, 1)} (${change}).`);
  }
  for (const p of r.failingProjects) {
    lines.push(`${p.name} a échoué à ses ${p.streak} dernières exécutions d’affilée.`);
  }
  for (const c of r.oldestOpen) {
    const owner = c.assignee ? `, attribuée à ${c.assignee}` : ', non attribuée';
    lines.push(`« ${c.title} » (${c.projectName}) est ouverte depuis ${f.value(c.ageDays, 'days', 0)}${owner}.`);
  }
  if (r.quarantine.count > 0) {
    const oldest =
      r.quarantine.oldestDays !== null ? `, le plus ancien depuis ${f.value(r.quarantine.oldestDays, 'days', 0)}` : '';
    lines.push(
      `${r.quarantine.count} ${plural(r.quarantine.count, 'test est', 'tests sont')} en quarantaine${oldest}.`,
    );
  }
  return lines;
}

/** "par rapport à" and the period an insight measures its change against, contracted as French needs. */
function comparedTo(vs: InsightComparison, f: ValueFormatter): string {
  switch (vs.kind) {
    case 'year':
      return 'par rapport à la même période un an plus tôt';
    case 'range':
      return `par rapport à la période du ${f.date(vs.from)} au ${f.date(vs.to)}`;
    case 'previous-unit':
      return {
        week: 'par rapport à la semaine précédente',
        month: 'par rapport au mois précédent',
        quarter: 'par rapport au trimestre précédent',
        year: 'par rapport à l’année précédente',
      }[vs.unit];
    case 'previous-release':
      return 'par rapport à la version précédente';
    case 'previous-sprint':
      return 'par rapport au sprint précédent';
    case 'previous-days':
      return `par rapport aux ${vs.days} jours précédents`;
    case 'previous-period':
      return 'par rapport à la période précédente';
  }
}

/** A duration in insight copy: `120 s`, `450 ms`. */
function ms(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}${NNBSP}s` : `${Math.round(value)}${NNBSP}ms`;
}

const RUN_STATUS: Record<string, string> = {
  passed: 'réussie',
  failed: 'en échec',
  timedout: 'hors délai',
  interrupted: 'interrompue',
  running: 'en cours',
  cancelled: 'annulée',
  initializing: 'en préparation',
  finalizing: 'en finalisation',
};

const count = (n: number, one: string, many: string, f: ValueFormatter) => `${f.number(n)} ${plural(n, one, many)}`;

/** The insights under *Ce qui a changé*, written from the facts of each rule. */
const FR_INSIGHTS: InsightPhrasebook<[f: ValueFormatter]> = {
  'pass-rate-drop': (x, f) => ({
    message: `Le taux de réussite de ${x.project} a perdu ${f.number(x.points, 1)} ${plural(x.points, 'point', 'points')} ${comparedTo(x.vs, f)}`,
    detail: `Il est maintenant de ${f.value(x.passRate, 'percent', 1)} sur ${count(x.runs, 'exécution', 'exécutions', f)}.`,
  }),
  'pass-rate-recovery': (x, f) => ({
    message: `Le taux de réussite de ${x.project} a gagné ${f.number(x.points, 1)} ${plural(x.points, 'point', 'points')} ${comparedTo(x.vs, f)}`,
    detail: `Il est maintenant de ${f.value(x.passRate, 'percent', 1)} sur ${count(x.runs, 'exécution', 'exécutions', f)}.`,
  }),
  'failing-streak': (x) => ({
    message: `${x.project} a échoué à ses ${x.streak} dernières exécutions d’affilée`,
    detail: x.latestRun
      ? `Dernière exécution${NBSP}: n°${NNBSP}${x.latestRun.id}, ${RUN_STATUS[x.latestRun.status] ?? x.latestRun.status}.`
      : undefined,
  }),
  'stale-cluster': (x, f) => ({
    message: `« ${x.title} » est ouverte depuis ${f.value(x.ageDays, 'days', 0)} (${count(x.occurrences, 'occurrence', 'occurrences', f)})`,
    detail: `${x.project} · erreur de type ${x.errorType ?? 'inconnu'}.`,
  }),
  'ci-time-growth': (x, f) => ({
    message: `Le temps de CI a augmenté de ${f.value(x.deltaPct, 'percent', 0)} ${comparedTo(x.vs, f)}`,
    detail: `${count(x.minutes, 'minute', 'minutes', f)} sur ${count(x.runs, 'exécution', 'exécutions', f)} pendant la période.`,
  }),
  'wasted-ci-time': (x, f) => ({
    message: `${f.number(x.hours, 1)}${NNBSP}h de CI perdues en attentes et en tentatives en échec sur la période`,
    detail: x.worst
      ? `${x.worst.project} en représente à lui seul ${count(x.worst.minutes, 'minute', 'minutes', f)}.`
      : undefined,
  }),
  'top-flaky-impact': (x, f) => ({
    message: `« ${x.title} » a fait perdre ${count(x.minutes, 'minute', 'minutes', f)} de CI en nouvelles tentatives`,
    detail: `${x.project} · instable dans ${x.retryPassRuns} des ${x.totalRuns} dernières exécutions.`,
  }),
  'regression-surge': (x, f) => ({
    message: `Les nouvelles régressions ont augmenté de ${f.value(x.deltaPct, 'percent', 0)} ${comparedTo(x.vs, f)}`,
    detail: `${f.number(x.total)} sur la période, contre ${f.number(x.previous)} auparavant.`,
  }),
  'slow-shared-endpoint': (x, f) => ({
    message: `${x.method} ${x.route} est lent (p90 de ${f.number(x.p90Ms)}${NNBSP}ms) dans ${x.projects} projets`,
    detail: `${count(x.requests, 'requête', 'requêtes', f)} sur la période${x.errorRate > 0 ? ` · ${f.value(x.errorRate, 'percent', 1)} en erreur` : ''}.`,
  }),
  'timeout-hygiene': (x) => ({
    message: x.staleSlow
      ? `« ${x.title} » est encore marqué test.slow() mais reste bien sous son budget`
      : `« ${x.title} » a un délai d’expiration surdimensionné (${ms(x.timeoutMs)} contre un p95 de ${ms(x.p95Ms)})`,
    detail:
      `${x.project} · ` +
      (x.staleSlow
        ? `retirer test.slow() ferait gagner environ ${ms(x.savingMs)} par exécution en échec.`
        : `le ramener vers ${ms(x.recommendedMs)} ferait gagner environ ${ms(x.savingMs)} par exécution en échec.`),
  }),
  'target-missed': (x, f) => {
    const def = getMetric(x.metric);
    const gap = targetGapValue(x);
    const gapText =
      def.unit === 'percent'
        ? `${f.number(gap, def.precision)} ${plural(gap, 'point', 'points')}`
        : f.value(gap, def.unit, def.precision);
    return {
      message: `${x.project} · ${METRIC_LABELS[x.metric]?.[0] ?? def.label}${NBSP}: ${gapText} ${x.direction === 'min' ? 'sous' : 'au-dessus de'} l’objectif`,
      detail: `${f.value(x.actual, def.unit, def.precision)} pour un objectif ${x.direction === 'min' ? 'd’au moins' : 'd’au plus'} ${f.value(x.target, def.unit, def.precision)}.`,
    };
  },
  'time-to-fix-growth': (x, f) => ({
    message: `Le délai médian de correction s’allonge ${comparedTo(x.vs, f)}${NBSP}: ${f.value(x.days, 'days', 1)}`,
    detail: `Il était de ${f.value(x.previousDays, 'days', 1)}, sur ${count(x.fixed, 'cause d’échec corrigée', 'causes d’échec corrigées', f)} pendant la période.`,
  }),
  'suite-shrank': (x, f) => ({
    message: `La suite a perdu ${count(x.lost, 'test', 'tests', f)} ${comparedTo(x.vs, f)}`,
    detail: `De ${f.number(x.previous)} à ${count(x.now, 'test', 'tests', f)}${NNBSP}; vérifier que rien n’a été ignoré ou supprimé par erreur.`,
  }),
  'quarantine-debt-growth': (x, f) => ({
    message: `${count(x.added, 'test de plus', 'tests de plus', f)} en quarantaine ${comparedTo(x.vs, f)}`,
    detail: `${count(x.now, 'test est', 'tests sont', f)} en quarantaine, contre ${f.number(x.previous)} auparavant.`,
  }),
  'owner-load': (x, f) => ({
    message: `${x.owner} détient ${x.open} des ${x.total} causes d’échec ouvertes`,
    detail: `${f.value(x.share, 'percent', 0)} des causes d’échec ouvertes attendent un seul responsable.`,
  }),
};

/** A Test Map node kind in French, and whether the noun is feminine, for the words that agree with it. */
const NODE_KINDS: Record<string, [noun: string, feminine: boolean]> = {
  feature: ['fonctionnalité', true],
  page: ['page', true],
  control: ['contrôle', false],
  link: ['lien', false],
  route: ['route', true],
  handler: ['gestionnaire', false],
  dependency: ['dépendance', true],
  file: ['fichier', false],
};
const KIND = `(${Object.keys(NODE_KINDS).join('|')})`;
const noun = (kind: string) => NODE_KINDS[kind]![0];
const feminine = (kind: string) => NODE_KINDS[kind]![1];
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const quoted = (text: string) => `«${NNBSP}${text}${NNBSP}»`;

/**
 * Each detector's English title template (`shared/handlers/scenario-gaps.ts`)
 * and its French wording. A title no pattern matches keeps its English text.
 */
const GAP_TITLES: Record<string, Array<[pattern: RegExp, write: (...parts: string[]) => string]>> = {
  'success-only': [
    [
      /^(.+): documented (\S+) never tested$/,
      (route, codes) =>
        codes.includes('/')
          ? `${route}${NBSP}: ${codes} documentés mais jamais testés`
          : `${route}${NBSP}: ${codes} documenté mais jamais testé`,
    ],
    [/^(.+): no error path under test$/, (route) => `${route}${NBSP}: aucun chemin d’erreur testé`],
  ],
  'declared-never-hit': [
    [
      new RegExp(`^Declared ${KIND} (.+) — never reached$`),
      (kind, key) => `${capitalized(noun(kind))} ${key} déclarée, jamais atteinte`,
    ],
  ],
  'single-covering-test': [
    [
      new RegExp(`^Only one test reaches ${KIND} (.+)$`),
      (kind, key) => `Un seul test atteint ${feminine(kind) ? 'la' : 'le'} ${noun(kind)} ${key}`,
    ],
    [
      new RegExp(`^No trusted test reaches ${KIND} (.+)$`),
      (kind, key) => `Aucun test fiable n’atteint ${feminine(kind) ? 'la' : 'le'} ${noun(kind)} ${key}`,
    ],
  ],
  'surface-drift': [
    [
      new RegExp(`^New ${KIND} (.+) — confirm it is tested$`),
      (kind, key) =>
        feminine(kind)
          ? `Nouvelle ${noun(kind)} ${key}${NBSP}: vérifier qu’elle est testée`
          : `Nouveau ${noun(kind)} ${key}${NBSP}: vérifier qu’il est testé`,
    ],
  ],
  'changed-unreached': [
    [/^(.+) changed but not reached$/, (file) => `Le fichier ${file} a changé, mais aucun test ne l’atteint`],
  ],
  'control-nobody-exercises': [
    [/^No test exercises control (.+)$/, (key) => `Aucun test n’utilise le contrôle ${key}`],
  ],
  'reachable-unvisited': [
    [
      /^(.+) is linked but never visited$/,
      (page) => `La page ${page} est accessible par des liens, mais aucun test ne la visite`,
    ],
  ],
  'api-only-route': [
    [
      /^(.+) is reached only by request fixtures$/,
      (route) => `La route ${route} n’est atteinte que par des requêtes d’API directes`,
    ],
  ],
  'not-noticed': [[/^Tests pass when (.+) breaks$/, (route) => `Les tests passent quand ${route} tombe en panne`]],
  'unprobed-dependency': [
    [/^(.+) is never probed$/, (dependency) => `La dépendance ${dependency} n’est jamais sondée`],
  ],
  'not-handled': [
    [
      /^(.+): (unhandled|degraded) failure$/,
      (target, handled) =>
        `${target}${NBSP}: ${handled === 'unhandled' ? 'défaillance non gérée' : 'fonctionnement dégradé en cas de défaillance'}`,
    ],
  ],
  matrix: [[/^(.+): thin test matrix$/, (feature) => `${feature}${NBSP}: matrice de tests trop réduite`]],
  'escaped-defect': [
    [/^(\S+) escaped the suite: (.+)$/, (bug, title) => `${bug} a échappé à la suite de tests${NBSP}: ${title}`],
  ],
  'orphan-test': [
    [/^(.+) reaches only vanished surface$/, (test) => `${test} n’atteint plus que des surfaces disparues`],
  ],
  'fix-did-not-hold': [[/^A fix for "(.*)" did not hold$/, (cause) => `Un correctif de ${quoted(cause)} n’a pas tenu`]],
  'phantom-coverage': [
    [
      /^(.+) has not really run in (\d+) days$/,
      (test, days) => `${test} n’a pas vraiment tourné depuis ${days} ${plural(Number(days), 'jour', 'jours')}`,
    ],
  ],
  'passed-with-errors': [[/^(.+) passed with errors$/, (test) => `${test} a réussi malgré des erreurs`]],
  'catalog-method-no-test-calls': [[/^(.+) is never called$/, (method) => `La méthode ${method} n’est jamais appelée`]],
  'incidental-catch': [
    [/^(.+) is caught only incidentally$/, (file) => `Les défauts de ${file} ne sont détectés que par hasard`],
  ],
  'assertion-light': [
    [
      /^(.+) is asserted only by visibility$/,
      (page) => `La page ${page} n’est vérifiée que par des assertions de visibilité`,
    ],
  ],
  'intent-without-test': [[/^No test mentions "(.*)"$/, (intent) => `Aucun test ne mentionne ${quoted(intent)}`]],
  'new-error-path': [
    [
      /^(.+) gains a (\d+) nobody tests$/,
      (route, status) => `La route ${route} renvoie désormais un ${status} qu’aucun test ne couvre`,
    ],
  ],
  'new-control': [[/^New control (.+) on (.+)$/, (control, page) => `Nouveau contrôle ${control} sur ${page}`]],
};

function gapTitle(detector: string | undefined, title: string): string {
  for (const [pattern, write] of (detector && GAP_TITLES[detector]) || []) {
    const match = pattern.exec(title);
    if (match) return write(...match.slice(1));
  }
  return title;
}

function listItem(item: AnalyticsListItem, f: ValueFormatter): { title: string; detail: string } {
  const x = item.facts;
  if (!x) return { title: item.title, detail: item.detail };
  switch (x.source) {
    case 'runs':
      return {
        title: `Exécution n°${NNBSP}${x.id}`,
        detail: [
          RUN_STATUS[x.status] ?? x.status,
          `${f.number(x.passed)}/${f.number(x.total)} ${plural(x.passed, 'réussi', 'réussis')}`,
          x.branch ? `sur ${x.branch}` : null,
          x.environment ? `environnement ${x.environment}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'failure-clusters':
      return {
        title: x.title ?? `Cause d’échec n°${NNBSP}${x.id}`,
        detail: [
          count(x.occurrences, 'occurrence', 'occurrences', f),
          x.errorType,
          x.assignee ? `attribuée à ${x.assignee}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'flaky-tests':
      return {
        title: item.title,
        detail: `score d’instabilité ${f.number(x.score)} · ${count(x.alternations, 'changement de statut', 'changements de statut', f)} sur ${count(x.totalRuns, 'exécution', 'exécutions', f)}`,
      };
    case 'scenario-gaps':
      return { title: gapTitle(x.detector, item.title), detail: gapClassLabel(x.gapClass) };
  }
}

export const FR_SENTENCES: ReportSentences = {
  name: 'Français',
  englishName: 'French',
  typography: TYPOGRAPHY,
  labels: {
    qualityReport: 'Rapport qualité',
    period: 'Période',
    comparedWith: 'Par rapport à',
    noComparison: 'Sans comparaison',
    projects: 'Projets',
    allProjects: 'Tous les projets',
    branchPolicy: 'Branches',
    defaultBranch: 'La branche par défaut de chaque projet, plus les exécutions sans branche connue',
    allBranches: 'Toutes les branches',
    branches: 'Branches',
    fullRunsOnly: 'Exécutions complètes seulement',
    allRuns: 'Exécutions complètes et partielles',
    testFilter: 'Tests',
    definitions: 'Définitions',
    limits: 'Limites',
    generated: 'Généré le',
    generatedBy: 'Généré par Piwi',
    openInPiwi: 'Ouvrir dans Piwi',
    liveDashboard:
      'Tableau de bord en direct : les chiffres sont calculés à chaque affichage, et la page se recharge chaque minute.',
    readWithoutAccount: 'Lire sans compte',
    dashboard: 'Tableau de bord',
    noData: 'Rien à montrer sur cette période.',
    previous: 'Précédent',
    metric: 'Indicateur',
    value: 'Valeur',
    change: 'Évolution',
    date: 'Date',
    unavailable: 'Ce widget n’est plus disponible.',
    daysAreUtc: 'Les jours sont en UTC.',
    feature: 'Fonctionnalité',
    gapClass: 'Classe',
    score: 'Score',
    count: 'Nombre',
    targets: 'Objectifs',
    markers: 'Repères',
    narrative: 'Récit',
    automatedMessage: 'Message automatique envoyé par',
  },
  verdict,
  progress,
  handbacks,
  risks,
  target,
  tileTarget: (mark, value) => {
    const judged = mark.met + mark.missed;
    if (value !== null) {
      const outcome = mark.met > 0 ? 'atteint' : mark.missed > 0 ? 'manqué' : 'rien encore pour en juger';
      return `Objectif ${mark.direction === 'min' ? 'd’au moins' : 'd’au plus'} ${value}, ${outcome}`;
    }
    if (judged === 0) return 'Objectif fixé, rien encore pour en juger';
    return `${mark.met} ${plural(mark.met, 'projet atteint', 'projets atteignent')} l’objectif sur ${judged}`;
  },
  colon: `${NBSP}: `,
  insight: (facts, f) => writeInsight(FR_INSIGHTS, facts, f),
  metricLabel: (id, fallback) => METRIC_LABELS[id]?.[0] ?? fallback,
  metricDefinition: (id, fallback) => METRIC_LABELS[id]?.[1] ?? fallback,
  titles: TITLES,
  title: (text) => TITLES[text] ?? text,
  // French names a period by its dates, on a line of its own or after « par rapport à ».
  dateRange: (from, to) => `du ${from} au ${to}`,
  period: (_name, range) => capitalized(range),
  comparison: (_name, range) => `la période ${range}`,
  reportTitle: (scope, _name, range) => `${scope}, ${range}`,
  projectCount: (n) => `${n} ${plural(n, 'projet', 'projets')}`,
  testFilterNote: (title) => `${quoted(title)} ne tient pas compte du filtre de tests.`,
  testFilterLimit: (start) =>
    start
      ? `Le filtre de tests compte les exécutions conservées, qui commencent le ${start}.`
      : 'Le filtre de tests compte les exécutions conservées, qui ne remontent pas plus loin que la rétention.',
  identityLimit:
    'Les listes de tests et le nombre de tests instables ne remontent pas plus loin que la rétention des exécutions.',
  gapClass: gapClassLabel,
  gapTitle,
  listItem,
  firstRunLimit: (since) =>
    `Ce premier rapport qualité planifié ne couvre que les jours écoulés depuis la création de la planification, le ${since}.`,
  narrativeGenerated: (model) =>
    `Généré par un modèle d’IA (${model}) à partir des seuls chiffres de ce rapport. Les tuiles et le verdict ci-dessus sont calculés par des règles ; fiez-vous à eux plutôt qu’à ce texte.`,
  narrativeFallback: 'Aucun récit IA n’a pu être généré pour ce rapport ; le verdict fondé sur des règles le remplace.',
  badge: {
    label: (branches) => `tests sur ${branches}`,
    allBranches: 'toutes les branches',
    defaultBranch: 'branche par défaut',
    days: (n) => `${n} j`,
    verdict: { good: 'bon', mixed: 'mitigé', bad: 'mauvais' },
  },
};
