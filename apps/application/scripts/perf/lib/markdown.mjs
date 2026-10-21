/**
 * Renders a comparison as the Markdown of the pull-request comment: a one-line
 * verdict, the regressions spelled out, one table for the pages and one for
 * the API calls, the SQL each request ran where it changed, and how it was
 * measured. GitHub refuses a comment over 65,536 characters, so the SQL
 * section stops before that and says so.
 */
import { METRICS, single, sqlDiff } from './compare.mjs';

/** The hidden marker the workflow finds its own comment by. */
export const COMMENT_MARKER = '<!-- piwi-perf-report -->';
const MAX_LENGTH = 60_000;
const SQL_ROWS_PER_REQUEST = 12;

const ICON = { regression: '🔴', improvement: '🟢', unchanged: '', missing: '' };

export function formatValue(key, value) {
  if (value === null || value === undefined) return '—';
  const unit = METRICS[key].unit;
  if (unit === 'ms') return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
  if (unit === 'bytes') {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MB`;
    if (value >= 1000) return `${Math.round(value / 1000)} kB`;
    return `${value} B`;
  }
  return Math.round(value).toLocaleString('en-US');
}

function percent(ratio) {
  if (!Number.isFinite(ratio)) return 'new';
  const p = Math.round(ratio * 100);
  return `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p)} %`;
}

/** One table cell: `base → head (change) icon`, or the head alone when nothing changed. */
function cell(m) {
  if (m.verdict === 'missing') return m.head === null ? formatValue(m.key, m.base) : formatValue(m.key, m.head);
  const same = formatValue(m.key, m.base) === formatValue(m.key, m.head);
  if (same) return formatValue(m.key, m.head);
  const change = m.verdict === 'unchanged' && METRICS[m.key].kind === 'timing' ? '' : ` (${percent(m.ratio)})`;
  return `${formatValue(m.key, m.base)} → ${formatValue(m.key, m.head)}${change} ${ICON[m.verdict]}`.trim();
}

const escapeCell = (text) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

function sqlText(query, max = 160) {
  const flat = query.replace(/\s+/g, ' ').trim();
  return escapeCell(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat).replaceAll('`', "'");
}

function regressionLines(comparison) {
  const lines = [];
  const describe = (m) => {
    const p = m.p === null ? '' : `, p ${m.p < 0.001 ? '< 0.001' : `= ${m.p.toFixed(3)}`}`;
    return `${METRICS[m.key].label.toLowerCase()} ${formatValue(m.key, m.base)} → ${formatValue(m.key, m.head)} (${percent(m.ratio)}${p})`;
  };
  for (const page of comparison.pages) {
    const regressed = Object.values(page.metrics).filter((m) => m.verdict === 'regression');
    if (regressed.length) lines.push(`- **${page.label}** — ${regressed.map(describe).join('; ')}`);
  }
  for (const api of comparison.apis) {
    const regressed = Object.values(api.metrics).filter((m) => m.verdict === 'regression');
    if (regressed.length) lines.push(`- \`GET ${api.path}\` — ${regressed.map(describe).join('; ')}`);
  }
  return lines;
}

const machineText = (m) => `${m?.cpus ?? '?'} × ${m?.cpuModel ?? 'CPU'}, Node ${m?.node ?? ''}`;

/** The machine that measured, or for a split run each one and the page rows it measured. */
function machineNote(meta) {
  if (!meta.shards?.length) return `Machine: ${machineText(meta.machine)}.`;
  let from = 1;
  const parts = meta.shards.map((s) => {
    const rows = s.pages.length === 1 ? `page ${from}` : `pages ${from}–${from + s.pages.length - 1}`;
    from += s.pages.length;
    return `${rows} on ${machineText(s.machine)}`;
  });
  return `Machines: ${parts.join('; ')}.`;
}

function sqlSourceNote(meta) {
  return meta.database === 'postgres'
    ? 'SQL counts come from `pg_stat_statements`, which sees every build; statement lists are normalized by PostgreSQL.'
    : 'SQL counts come from OpenTelemetry spans (`@kubiks/otel-drizzle`); a build without tracing shows —.';
}

/** The SQL section: per request, the statements whose counts changed. */
function sqlSection(comparison, budget) {
  const blocks = [];
  let used = 0;
  let omitted = 0;
  const entries = [
    ...comparison.pages.flatMap((page) => [
      { title: `${page.label} — server render`, pair: page.sql.render },
      { title: `${page.label} — full load in the browser`, pair: page.sql.load },
    ]),
    ...comparison.apis.map((api) => ({ title: `GET ${api.path}`, pair: api.sql })),
  ];
  for (const { title, pair } of entries) {
    const [a, b] = pair;
    if (!a && !b) continue;
    const diff = sqlDiff(a, b);
    if (diff.length === 0) continue;
    const lines = [
      `**${escapeCell(title)}** — ${a?.statements ?? '—'} → ${b?.statements ?? '—'} statements`,
      '',
      '| Statement | base | head |',
      '| --- | ---: | ---: |',
      ...diff.slice(0, SQL_ROWS_PER_REQUEST).map((d) => `| \`${sqlText(d.query)}\` | ${d.base} | ${d.head} |`),
    ];
    if (diff.length > SQL_ROWS_PER_REQUEST) lines.push(`| _${diff.length - SQL_ROWS_PER_REQUEST} more_ | | |`);
    if (b?.nested?.length) {
      lines.push(
        '',
        `Requests the server made to itself while rendering (head): ${b.nested.map((n) => `\`${n.request}\` ${n.statements}`).join(' · ')}`,
      );
    }
    const block = lines.join('\n');
    if (used + block.length > budget) {
      omitted++;
      continue;
    }
    used += block.length;
    blocks.push(block);
  }
  return { blocks, omitted };
}

/**
 * The comment body. `meta` is the results' metadata, `comparison` the output
 * of `compareResults`, `links.run` the URL of the run that measured it.
 */
export function renderComparison(meta, comparison, { links = {} } = {}) {
  const { tally } = comparison;
  const head = [
    COMMENT_MARKER,
    '## Performance',
    '',
    `${meta.targetLabels?.base ?? 'base'} → ${meta.targetLabels?.head ?? 'head'} · ${meta.database === 'postgres' ? `PostgreSQL ${meta.databaseVersion ?? ''}`.trim() : 'SQLite'} · ${meta.scale} dataset (${(meta.dataset?.test_runs ?? 0).toLocaleString('en-US')} runs, ${(meta.dataset?.test_runs_cases ?? 0).toLocaleString('en-US')} executions) · authentication on`,
    '',
    tally.regression
      ? `**${tally.regression} regression${tally.regression === 1 ? '' : 's'}** · ${tally.improvement} improvement${tally.improvement === 1 ? '' : 's'} · ${tally.unchanged} unchanged`
      : `No regression · ${tally.improvement} improvement${tally.improvement === 1 ? '' : 's'} · ${tally.unchanged} unchanged`,
  ];
  const regressions = regressionLines(comparison);
  if (regressions.length) head.push('', '### Regressions', '', ...regressions);

  const pageRows = comparison.pages.map((p) => {
    const m = p.metrics;
    const failed = p.status.some((s) => s !== null && s >= 400) ? ` ⚠️ HTTP ${p.status.join(' / ')}` : '';
    return `| ${escapeCell(p.label)}${failed} | ${cell(m.ssrMs)} | ${cell(m.ssrStatements)} | ${cell(m.htmlBytes)} | ${cell(m.lcpMs)} | ${cell(m.loadMs)} | ${cell(m.loadStatements)} | ${cell(m.apiRequests)} | ${cell(m.blockingMs)} |`;
  });
  const pages = [
    '',
    '### Pages',
    '',
    '| Page | Server render | SQL / render | HTML | Largest paint | Full load | SQL / full load | API calls | Blocking |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...pageRows,
  ];

  const apiRows = comparison.apis.map((api) => {
    const m = api.metrics;
    const failed = api.status.some((s) => s !== null && s >= 400) ? ` ⚠️ HTTP ${api.status.join(' / ')}` : '';
    return `| \`${escapeCell(api.path)}\`${failed} | ${cell(m.apiMs)} | ${cell(m.apiStatements)} | ${cell(m.apiBytes)} |`;
  });
  const apis = [
    '',
    `<details><summary>API calls (${comparison.apis.length})</summary>`,
    '',
    '| Request | Response time | SQL | Response size |',
    '| --- | --- | --- | --- |',
    ...apiRows,
    '',
    '</details>',
  ];

  const method = [
    '',
    '<details><summary>How this is measured</summary>',
    '',
    `Each build ran as its own production server (\`node .output/server/index.mjs\`) on its own copy of the same dataset, signed in as an administrator. Servers were measured in turn, alternating order, after ${meta.samples.warmup} warm-up rounds: ${meta.samples.ssr} server renders and ${meta.samples.load} browser loads (Chromium, warm cache, until the page's own requests stop) per page, and ${meta.samples.api} calls per API request. Times are medians. *Largest paint* is when the page's main content first shows (LCP); *full load* is when its last request ends; *blocking* is main-thread time past 50 ms per task.${meta.shards?.length > 1 ? ` The pages were split across ${meta.shards.length} machines, each measuring both builds on its own pages and the API calls they make, so every row compares two builds measured on the same machine.` : ''}`,
    '',
    `A time is a regression when the median grows past both floors and the Mann–Whitney test gives p < 0.01 (which takes at least six samples a side); a count (SQL statements, bytes, requests) when it grows past both floors. Floors: ${Object.values(
      METRICS,
    )
      .map(
        (d) =>
          `${d.label.toLowerCase()} ${Math.round(d.rel * 100)} % and ${d.unit === 'bytes' ? formatValue('htmlBytes', d.abs) : `${d.abs}${d.unit === 'ms' ? ' ms' : ''}`}`,
      )
      .join(', ')}.`,
    '',
    sqlSourceNote(meta),
    '',
    `${machineNote(meta)} Suite: \`apps/application/scripts/perf\`.${links.run ? ` [Run and full results](${links.run}).` : ''}`,
    '',
    '</details>',
  ];

  const fixed = [...head, ...pages, ...apis, ...method].join('\n');
  const { blocks, omitted } = sqlSection(comparison, MAX_LENGTH - fixed.length - 500);
  const sql = blocks.length
    ? [
        '',
        `<details><summary>SQL per request, where it changed (${blocks.length})</summary>`,
        '',
        blocks.join('\n\n'),
        omitted ? `\n_${omitted} more requests changed; see the full results._` : '',
        '',
        '</details>',
      ]
    : [];
  return [...head, ...pages, ...apis, ...sql, ...method].join('\n');
}

/** A report of one build alone: its numbers, no verdicts. */
export function renderSingle(meta, results, target) {
  const lines = [
    '## Performance',
    '',
    `${target} · ${meta.database} · ${meta.scale} dataset`,
    '',
    '| Page | Server render | SQL / render | HTML | Largest paint | Full load | SQL / full load | API calls | Blocking |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const page of results.pages) {
    const t = page.targets[target] ?? {};
    lines.push(
      `| ${escapeCell(page.label)} | ${formatValue('ssrMs', single('ssrMs', t.ssr?.ms))} | ${formatValue('ssrStatements', single('ssrStatements', t.ssr?.statements))} | ${formatValue('htmlBytes', single('htmlBytes', t.ssr?.bytes))} | ${formatValue('lcpMs', single('lcpMs', t.load?.lcpMs))} | ${formatValue('loadMs', single('loadMs', t.load?.ms))} | ${formatValue('loadStatements', single('loadStatements', t.load?.statements))} | ${formatValue('apiRequests', single('apiRequests', t.load?.apiRequests))} | ${formatValue('blockingMs', single('blockingMs', t.load?.blockingMs))} |`,
    );
  }
  lines.push('', '| Request | Response time | SQL | Response size |', '| --- | --- | --- | --- |');
  for (const api of results.apis) {
    const t = api.targets[target] ?? {};
    lines.push(
      `| \`${escapeCell(api.path)}\` | ${formatValue('apiMs', single('apiMs', t.ms))} | ${formatValue('apiStatements', single('apiStatements', t.statements))} | ${formatValue('apiBytes', single('apiBytes', t.bytes))} |`,
    );
  }
  return lines.join('\n');
}
