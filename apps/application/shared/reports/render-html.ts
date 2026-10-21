/**
 * Renders a report bundle as one self-contained HTML file: inline styles,
 * inline SVG charts, no script and no remote resource, under the export CSP.
 * Every interpolation goes through the escaping `html` template, so a test
 * title or a branch name is always text.
 */
import { html, joinHtml, raw, toHtmlString, type RawHtml } from '#shared/export/html';
import { piwiCreditHtml } from '#shared/brand';
import { STATUS_COLORS as C, PASS_RATE_COLORS } from '#shared/status-colors';
import { chartLabelAnchor, chartTickLabel, REPORT_ACCENT, REPORT_GRID, REPORT_MARKER, seriesGeometry } from './chart';
import { makeFormatter, type ValueFormatter } from './format';
import { sentencesFor } from './sentences';
import { hasVerdictWidget, type ReportBlock, type ReportBundle, type ReportTone } from './types';

const TONE_COLOR: Record<ReportTone, string> = { good: C.passed.text, bad: C.failed.text, neutral: '#71717a' };
const VERDICT_COLOR = {
  good: PASS_RATE_COLORS.good.fill,
  mixed: PASS_RATE_COLORS.fair.fill,
  bad: PASS_RATE_COLORS.poor.fill,
};

const STYLES = `
:root { color-scheme: light; --fg:#1c1c20; --muted:#6b6b76; --line:#e2e2e7; --card:#fafafa; --accent:${REPORT_ACCENT}; }
* { box-sizing:border-box; }
body { margin:0; padding:0 1rem 3rem; background:#fff; color:var(--fg); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { max-width:60rem; margin:0 auto; }
header { padding:2rem 0 1rem; border-bottom:1px solid var(--line); }
h1 { font-size:1.5rem; margin:0 0 .25rem; }
h2 { font-size:1.1rem; margin:2rem 0 .25rem; }
h3 { font-size:.95rem; margin:1.25rem 0 .5rem; }
.meta, .desc, .note { color:var(--muted); font-size:.85rem; margin:0; }
.verdict { display:flex; gap:.75rem; align-items:flex-start; margin:1.25rem 0; padding:1rem; background:var(--card); border:1px solid var(--line); border-radius:.5rem; }
.dot { width:.7rem; height:.7rem; border-radius:50%; flex:none; margin-top:.4rem; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:.6rem; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:.5rem; padding:.6rem .75rem; }
.tile .label { font-size:.75rem; color:var(--muted); }
.tile .value { font-size:1.25rem; font-weight:600; }
.tile .change, .tile .extra { font-size:.75rem; }
table { width:100%; border-collapse:collapse; font-size:.85rem; }
th, td { text-align:left; padding:.35rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; color:var(--muted); font-size:.75rem; }
td.r, th.r { text-align:right; font-variant-numeric:tabular-nums; }
.scroll { overflow-x:auto; }
ul.items { margin:0; padding-left:1.1rem; }
ul.items li { margin:.25rem 0; }
a { color:inherit; text-decoration:underline dotted; text-underline-offset:2px; }
svg { display:block; width:100%; height:auto; }
.legend { display:flex; flex-wrap:wrap; gap:.25rem 1rem; font-size:.75rem; color:var(--muted); margin:.25rem 0; }
.legend i { display:inline-block; width:.6rem; height:.6rem; border-radius:50%; margin-right:.3rem; vertical-align:middle; }
footer { margin-top:2.5rem; padding-top:1rem; border-top:1px solid var(--line); font-size:.8rem; color:var(--muted); }
footer dl { display:grid; grid-template-columns:max-content 1fr; gap:.2rem 1rem; margin:0 0 1rem; }
footer dt { font-weight:600; }
footer dd { margin:0; }
@media (max-width:30rem) { body { padding:0 .6rem 2rem; } footer dl { grid-template-columns:1fr; } }
@media print { body { padding:0; } section.band { break-inside:avoid-page; } }
`;

const CHART_W = 640;
const CHART_H = 180;
const PAD = { left: 44, right: 8, top: 8, bottom: 22 };

function chartSvg(block: Extract<ReportBlock, { kind: 'series' }>, f: ValueFormatter): RawHtml {
  const g = seriesGeometry(block, CHART_W - PAD.left - PAD.right, CHART_H - PAD.top - PAD.bottom);
  const grid = g.ticks.map(
    (t) =>
      html`<line
          x1="0"
          x2="${g.width}"
          y1="${t.y}"
          y2="${t.y}"
          stroke="${REPORT_GRID}"
          stroke-dasharray="${t.value === 0 ? '' : '3 3'}"
        /><text x="-6" y="${t.y + 3}" text-anchor="end" font-size="10" fill="#71717a"
          >${chartTickLabel(block, t.value, f)}</text
        >`,
  );
  const lines = g.lines.flatMap((line) =>
    line.runs.map((run) =>
      run.length === 1
        ? html`<circle cx="${run[0]![0]}" cy="${run[0]![1]}" r="2.5" fill="${line.color}" />`
        : html`<polyline
            points="${run.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"
            fill="none"
            stroke="${line.color}"
            stroke-width="${line.faint ? 1.5 : 2}"
            stroke-dasharray="${line.faint ? '4 3' : ''}"
          />`,
    ),
  );
  const markers = g.markers.map(
    (m) =>
      html`<line x1="${m.x}" x2="${m.x}" y1="0" y2="${g.height}" stroke="${REPORT_MARKER}" stroke-dasharray="2 2"
        ><title>${m.label}</title></line
      >`,
  );
  const labels = g.labels.map(
    (l) =>
      html`<text
        x="${l.x}"
        y="${g.height + 15}"
        text-anchor="${chartLabelAnchor(l.x, g.width)}"
        font-size="10"
        fill="#71717a"
        >${f.day(l.date)}</text
      >`,
  );
  return html`<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="${block.summary ?? 'Chart'}">
    <g transform="translate(${PAD.left},${PAD.top})">${grid}${markers}${lines}${labels}</g>
  </svg>`;
}

function linkOrText(text: string, href: string | null | undefined): RawHtml {
  return href ? html`<a href="${href}">${text}</a>` : html`${text}`;
}

function renderBlock(block: ReportBlock, f: ValueFormatter): RawHtml {
  switch (block.kind) {
    case 'text':
      return block.tone
        ? html`<div class="verdict" data-verdict="${block.tone}">
            <span class="dot" style="background:${VERDICT_COLOR[block.tone]}"></span>
            <p style="margin:0">${block.text}</p>
          </div>`
        : html`<p>${block.text}</p>`;
    case 'stats':
      return html`<div class="tiles">
        ${block.tiles.map(
          (t) => html`<div class="tile" title="${t.definition ?? ''}">
            <div class="label">${t.label}</div>
            <div class="value">${t.value}</div>
            ${t.change ? html`<div class="change" style="color:${TONE_COLOR[t.tone]}">${t.change}</div>` : ''}
            ${t.note ? html`<div class="extra">${t.note}</div>` : ''}
          </div>`,
        )}
      </div>`;
    case 'series':
      return html`${block.summary ? html`<p class="meta">${block.summary}</p>` : ''}
        <div class="legend">
          ${block.series.map((s) => {
            const color = seriesGeometry({ ...block, series: [s] }, 1, 1).lines[0]!.color;
            return html`<span><i style="background:${color}"></i>${s.label}</span>`;
          })}
        </div>
        ${chartSvg(block, f)}`;
    case 'table':
      return html`<div class="scroll">
        <table>
          <thead>
            <tr>
              ${block.columns.map((c) => html`<th class="${c.align === 'right' ? 'r' : ''}">${c.label}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${block.rows.map(
              (row) =>
                html`<tr>
                  ${block.columns.map((c, i) => {
                    const text = row.cells[c.key] ?? '';
                    return html`<td class="${c.align === 'right' ? 'r' : ''}">
                      ${i === 0 ? linkOrText(text, row.link) : text}
                    </td>`;
                  })}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>`;
    case 'list':
      return html`<ul class="items">
        ${block.items.map(
          (item) =>
            html`<li
              style="${item.tone && item.tone !== 'neutral'
                ? `border-left:2px solid ${TONE_COLOR[item.tone]};padding-left:.4rem;list-style:none;margin-left:-1.1rem`
                : ''}"
            >
              ${linkOrText(item.text, item.link)}${item.detail ? html`<div class="note">${item.detail}</div>` : ''}
            </li>`,
        )}
      </ul>`;
  }
}

export interface RenderReportHtmlOptions {
  /** Reload the page on this cadence (a live dashboard link on a wall screen). */
  refreshSeconds?: number;
  /** A line under the header (a live dashboard link says it is live). */
  banner?: string;
}

/** The report as a self-contained HTML document. */
export function renderReportHtml(bundle: ReportBundle, opts: RenderReportHtmlOptions = {}): string {
  const s = sentencesFor(bundle.language);
  const f = makeFormatter(bundle.language, bundle.locale);
  const L = s.labels;

  const bands = bundle.bands.map(
    (band) => html`<section class="band">
      <h2>${band.title}</h2>
      ${band.description ? html`<p class="desc">${band.description}</p>` : ''}
      ${band.widgets.map(
        (w) => html`<div class="widget" data-widget="${w.key}">
          <h3>${w.title}</h3>
          ${w.notes.map((n) => html`<p class="note">${n}</p>`)} ${joinHtml(w.blocks.map((b) => renderBlock(b, f)))}
        </div>`,
      )}
    </section>`,
  );

  const facts: Array<[string, string]> = [
    [L.dashboard, bundle.dashboard.name],
    [L.period, bundle.period.label],
    [L.comparedWith, bundle.comparison?.label ?? L.noComparison],
    [L.projects, bundle.scopeText.projects],
    [L.branchPolicy, bundle.scopeText.branches],
    [s.metricLabel('runs', 'Runs'), bundle.scopeText.runs],
    ...(bundle.scopeText.tests ? ([[L.testFilter, bundle.scopeText.tests]] as Array<[string, string]>) : []),
    [
      L.generated,
      `${f.date(bundle.generatedAt, bundle.timeZone)}${bundle.piwiVersion ? ` · Piwi ${bundle.piwiVersion}` : ''}`,
    ],
  ];

  const doc = html`<!doctype html>
    <html lang="${bundle.language}">
      <head>
        <meta charset="utf-8" />
        ${raw(
          `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
        )}
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="generator" content="Piwi" />
        ${opts.refreshSeconds
          ? raw(`<meta http-equiv="refresh" content="${Math.max(15, Math.floor(opts.refreshSeconds))}">`)
          : ''}
        <title>${L.qualityReport}${s.colon}${bundle.title}</title>
        ${raw(`<style>${STYLES}</style>`)}
      </head>
      <body>
        <div class="wrap">
          <header>
            <p class="meta">${L.qualityReport} · ${bundle.dashboard.name}</p>
            <h1>${bundle.title}</h1>
            <p class="meta">
              ${bundle.period.label}${bundle.comparison
                ? html` · ${L.comparedWith.toLowerCase()} ${bundle.comparison.label}`
                : ''}
            </p>
            ${opts.banner ? html`<p class="meta" data-banner>${opts.banner}</p>` : ''}
          </header>
          ${hasVerdictWidget(bundle)
            ? ''
            : html`<div class="verdict" data-verdict="${bundle.verdict.tone}">
                <span class="dot" style="background:${VERDICT_COLOR[bundle.verdict.tone]}"></span>
                <p style="margin:0">${bundle.verdict.sentence}</p>
              </div>`}
          ${bands}
          <footer>
            <dl>
              ${facts.map(
                ([k, v]) =>
                  html`<dt>${k}</dt>
                    <dd>${v}</dd>`,
              )}
            </dl>
            ${bundle.targets.length
              ? html`<h3>${L.targets}</h3>
                  <ul class="items">
                    ${bundle.targets.map((t) => html`<li data-target-met="${String(t.met)}">${t.text}</li>`)}
                  </ul>`
              : ''}
            ${bundle.definitions.length
              ? html`<h3>${L.definitions}</h3>
                  <dl>
                    ${bundle.definitions.map(
                      (d) =>
                        html`<dt>${d.label}</dt>
                          <dd>${d.definition}</dd>`,
                    )}
                  </dl>`
              : ''}
            ${bundle.limits.length
              ? html`<h3>${L.limits}</h3>
                  <ul class="items">
                    ${bundle.limits.map((l) => html`<li>${l}</li>`)}
                  </ul>`
              : ''}
            ${bundle.sourceUrl ? html`<p><a href="${bundle.sourceUrl}">${L.openInPiwi}</a></p>` : ''}
            ${raw(piwiCreditHtml(L.generatedBy))}
          </footer>
        </div>
      </body>
    </html>`;
  return toHtmlString(doc);
}
