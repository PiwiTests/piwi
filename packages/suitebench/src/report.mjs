// Turns recorded runs into a comparison: every variant against the first one, per metric, with the
// interval and verdict from paired rounds, plus where the test time went.
import { compareRounds, median, relativeSpread, verdict } from './stats.mjs';

const METRICS = [
  { key: 'wallMs', label: 'Wall time', unit: 's', scale: 1 / 1000 },
  { key: 'cpuMs', label: 'CPU time', unit: 's', scale: 1 / 1000 },
  { key: 'peakMemoryMb', label: 'Peak memory', unit: 'MiB', scale: 1 },
  { key: 'artifactBytes', label: 'Artifacts', unit: 'MB', scale: 1 / 1e6 },
];

function value(metric, raw) {
  if (raw === undefined || Number.isNaN(raw)) return '–';
  const scaled = raw * metric.scale;
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(scaled >= 10 ? 1 : 2)} ${metric.unit}`;
}

function percent(ratio) {
  const change = (ratio - 1) * 100;
  return `${change > 0 ? '+' : change < 0 ? '−' : '±'}${Math.abs(change).toFixed(change !== 0 && Math.abs(change) < 10 ? 1 : 0)}%`;
}

/** The comparison as data: one entry per variant, metric by metric. */
export function summarize(results, { minimumEffect = 0.02 } = {}) {
  const measured = results.runs.filter((run) => !run.warmup);
  const baseline = results.variants[0].name;
  const byRound = (name) => new Map(measured.filter((run) => run.variant === name).map((run) => [run.round, run]));
  const baseRuns = byRound(baseline);
  return results.variants.map((variant) => {
    const runs = [...byRound(variant.name).values()];
    const metrics = {};
    for (const metric of METRICS) {
      const values = runs.map((run) => run[metric.key]).filter((raw) => raw !== undefined);
      if (!values.length) continue;
      const entry = { median: median(values), spread: relativeSpread(values), samples: values.length };
      if (variant.name !== baseline) {
        const pairs = runs
          .filter((run) => baseRuns.has(run.round) && run[metric.key] !== undefined)
          .map((run) => [baseRuns.get(run.round)[metric.key], run[metric.key]]);
        entry.comparison = compareRounds(pairs);
        entry.verdict = verdict(entry.comparison, minimumEffect);
      }
      metrics[metric.key] = entry;
    }
    const categories = {};
    for (const run of runs) {
      for (const [name, ms] of Object.entries(run.categories ?? {})) (categories[name] ??= []).push(ms);
    }
    return {
      name: variant.name,
      description: variant.description,
      runs: runs.length,
      failedRuns: runs.filter((run) => run.exitCode !== 0).length,
      failedTests: runs.reduce((sum, run) => sum + (run.counts?.unexpected ?? 0), 0),
      flakyTests: runs.reduce((sum, run) => sum + (run.counts?.flaky ?? 0), 0),
      retries: runs.reduce((sum, run) => sum + (run.retries ?? 0), 0),
      testTimeMs: median(runs.map((run) => run.testTimeMs ?? NaN).filter((ms) => !Number.isNaN(ms))),
      categories: Object.fromEntries(Object.entries(categories).map(([name, values]) => [name, median(values)])),
      metrics,
    };
  });
}

/** The comparison as Markdown. */
export function formatMarkdown(results, summary = summarize(results)) {
  const baseline = summary[0];
  const lines = [
    `# Benchmark: ${summary.map((variant) => variant.name).join(', ')}`,
    '',
    `${results.machine.platform}/${results.machine.arch}, ${results.machine.cpus ?? '?'} CPUs, Node ${results.machine.node}. ` +
      `${baseline.runs} measured rounds after ${results.config.warmup} warm-up round(s); variants interleaved. ` +
      `Every variant is compared with **${baseline.name}** round by round: the change is the median of the per-round ratios, ` +
      'the interval its 95% bootstrap interval, and "n/N lower" counts the rounds it came out lower.',
    '',
  ];
  for (const metric of METRICS) {
    if (!baseline.metrics[metric.key]) continue;
    const spread = baseline.metrics[metric.key].spread;
    lines.push(`## ${metric.label}${metric.key === 'peakMemoryMb' && results.memoryMetric ? ` (${results.memoryMetric}, sampled)` : ''}`, '');
    lines.push('| Variant | Median | Noise | Change | 95% interval | Rounds lower | Verdict |', '| --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const variant of summary) {
      const entry = variant.metrics[metric.key];
      if (!entry) continue;
      const noise = Number.isNaN(entry.spread) ? '–' : `±${(entry.spread * 100).toFixed(1)}%`;
      if (!entry.comparison) {
        lines.push(`| **${variant.name}** (baseline) | ${value(metric, entry.median)} | ${noise} | | | | |`);
        continue;
      }
      const { ratio, low, high, better, rounds } = entry.comparison;
      lines.push(
        `| ${variant.name} | ${value(metric, entry.median)} | ${noise} | ${percent(ratio)} | ${percent(low)} … ${percent(high)} | ${better}/${rounds} | ${entry.verdict} |`,
      );
    }
    if (!Number.isNaN(spread)) lines.push('');
  }
  lines.push('## Correctness', '', '| Variant | Failed runs | Failed tests | Flaky tests | Retries |', '| --- | ---: | ---: | ---: | ---: |');
  for (const variant of summary) {
    lines.push(`| ${variant.name} | ${variant.failedRuns}/${variant.runs} | ${variant.failedTests} | ${variant.flakyTests} | ${variant.retries} |`);
  }
  const names = [...new Set(summary.flatMap((variant) => Object.keys(variant.categories)))].toSorted(
    (a, b) => (baseline.categories[b] ?? 0) - (baseline.categories[a] ?? 0),
  );
  if (names.length) {
    lines.push('', '## Where the test time went (median seconds, summed across workers)', '');
    lines.push(`| Category | ${summary.map((variant) => variant.name).join(' | ')} |`, `| --- | ${summary.map(() => '---:').join(' | ')} |`);
    for (const name of names) {
      lines.push(`| ${name} | ${summary.map((variant) => (variant.categories[name] === undefined ? '–' : (variant.categories[name] / 1000).toFixed(1))).join(' | ')} |`);
    }
    lines.push(`| **total test time** | ${summary.map((variant) => (variant.testTimeMs / 1000).toFixed(1)).join(' | ')} |`);
  }
  const described = summary.filter((variant) => variant.description);
  if (described.length) {
    lines.push('', '## Variants', '', ...described.map((variant) => `- **${variant.name}**: ${variant.description}`));
  }
  return `${lines.join('\n')}\n`;
}
