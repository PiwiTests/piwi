/**
 * Renders a report bundle as one self-contained HTML file: inline styles,
 * inline SVG charts, no script and no remote resource, under the export CSP.
 * Every interpolation goes through the escaping `html` template, so a test
 * title or a branch name is always text.
 */
import { html, joinHtml, raw, toHtmlString, type RawHtml } from '#shared/export/html';
import { piwiCreditHtml, piwiMarkSvg } from '#shared/brand';
import { STATUS_COLORS as C, PASS_RATE_COLORS } from '#shared/status-colors';
import { chartLabelAnchor, chartTickLabel, REPORT_ACCENT, REPORT_GRID, REPORT_MARKER, seriesGeometry } from './chart';
import { makeFormatter, type ValueFormatter } from './format';
import { sentencesFor } from './sentences';
import { hasVerdictWidget, type ReportBlock, type ReportBundle, type ReportTone } from './types';

const TONE_COLOR: Record<ReportTone, string> = { good: C.passed.text, bad: C.failed.text, neutral: '#71717a' };
/** The top edge of a tile: the outcome color of its change, or a grey hairline without a change or for one that is neither good nor bad news. */
const TILE_EDGE: Record<ReportTone, string> = { good: C.passed.fill, bad: C.failed.fill, neutral: '#e4e4e9' };
const VERDICT_COLOR = {
  good: PASS_RATE_COLORS.good.fill,
  mixed: PASS_RATE_COLORS.fair.fill,
  bad: PASS_RATE_COLORS.poor.fill,
};

const STYLES = `
:root {
  color-scheme: light; --bg:#f6f6f8; --paper:#fff; --fg:#1c1c20; --muted:#5f5f6b; --faint:#8b8b96; --line:#e4e4e9;
  --card:#fafafb; --accent:${REPORT_ACCENT};
}
* { box-sizing:border-box; }
body { margin:0; padding:0 1rem 3rem; background:var(--bg); color:var(--fg); font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { max-width:62rem; margin:0 auto; }
header { margin:1.5rem 0 1rem; padding:1.4rem 1.5rem 1.3rem; background:var(--paper); border:1px solid var(--line); border-top:4px solid var(--accent); border-radius:12px; }
.kicker { display:flex; align-items:center; gap:.45rem; margin:0 0 .35rem; font-size:.75rem; font-weight:650; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); overflow-wrap:anywhere; min-width:0; }
h1 { font-size:1.75rem; line-height:1.2; letter-spacing:-.01em; margin:0 0 .35rem; overflow-wrap:anywhere; }
h2 { display:flex; align-items:center; gap:.6rem; font-size:1.2rem; margin:2.2rem 0 .2rem; overflow-wrap:anywhere; }
h2 .num { display:inline-flex; align-items:center; justify-content:center; width:1.6rem; height:1.6rem; border-radius:7px; background:var(--accent); color:#fff; font-size:.85rem; flex:none; }
h3 { font-size:.95rem; margin:0 0 .6rem; }
.meta, .desc, .note { color:var(--muted); font-size:.85rem; margin:0; }
.desc { margin-left:2.2rem; }
.verdict { display:flex; gap:.8rem; align-items:flex-start; margin:1rem 0; padding:1rem 1.15rem; background:var(--paper); border:1px solid var(--line); border-left:5px solid var(--tone); border-radius:10px; font-size:1.02rem; }
.verdict p { margin:0; }
.dot { width:.75rem; height:.75rem; border-radius:50%; flex:none; margin-top:.42rem; background:var(--tone); }
.widget { background:var(--paper); border:1px solid var(--line); border-radius:12px; padding:1rem 1.1rem 1.05rem; margin:.8rem 0; }
.widget > .verdict { margin:0; }
.widget > .note { margin:-.3rem 0 .6rem; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr)); gap:.6rem; }
.tile { background:var(--card); border:1px solid var(--line); border-top:3px solid var(--tone); border-radius:9px; padding:.65rem .8rem .7rem; }
.tile .label { font-size:.75rem; color:var(--muted); }
.tile .value { font-size:1.45rem; font-weight:650; line-height:1.2; margin:.15rem 0 .2rem; letter-spacing:-.01em; overflow-wrap:anywhere; }
.tile .change { display:inline-block; font-size:.75rem; font-weight:650; padding:0 .45rem; border-radius:999px; border:1px solid currentColor; }
.tile .extra { font-size:.75rem; color:var(--muted); margin-top:.25rem; }
table { width:100%; border-collapse:collapse; font-size:.85rem; }
th, td { text-align:left; padding:.45rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:650; color:var(--muted); font-size:.7rem; letter-spacing:.05em; text-transform:uppercase; background:var(--card); }
tbody tr:last-child td { border-bottom:0; }
td.r, th.r { text-align:right; font-variant-numeric:tabular-nums; }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:8px; margin-top:.6rem; }
ul.items { margin:0; padding-left:1.1rem; }
ul.items li { margin:.3rem 0; }
ul.items li.toned { list-style:none; margin-left:-1.1rem; padding:.45rem .7rem; background:var(--card); border:1px solid var(--line); border-left:3px solid var(--tone); border-radius:0 8px 8px 0; }
a { color:inherit; text-decoration:underline dotted; text-underline-offset:2px; }
svg { display:block; width:100%; height:auto; }
.legend { display:flex; flex-wrap:wrap; gap:.25rem 1rem; font-size:.75rem; color:var(--muted); margin:.25rem 0; }
.legend i { display:inline-block; width:.6rem; height:.6rem; border-radius:50%; margin-right:.3rem; vertical-align:middle; }
footer { margin-top:2.5rem; padding:1.1rem 1.3rem; background:var(--paper); border:1px solid var(--line); border-radius:12px; font-size:.82rem; color:var(--muted); }
footer h3 { margin-top:1.2rem; color:var(--fg); }
footer dl { display:grid; grid-template-columns:max-content 1fr; gap:.25rem 1.2rem; margin:0 0 .5rem; }
footer dt { font-weight:650; color:var(--fg); }
footer dd { margin:0; }
@media (max-width:30rem) {
  body { padding:0 .6rem 2rem; }
  header { padding:1.1rem 1rem; }
  h1 { font-size:1.4rem; }
  .desc { margin-left:0; }
  .widget { padding:.85rem .8rem; }
  footer dl { grid-template-columns:1fr; }
}
@media print {
  body { padding:0; background:#fff; }
  header, .widget, footer, .verdict, .tile, ul.items li.toned { background:transparent; }
  section.band { break-inside:avoid-page; }
  h2, .desc, h3 { break-after:avoid-page; }
  .widget:not(:has(table)) { break-inside:avoid; }
}
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
  // A light area lies under the line of the one series drawn in full, never with two or more; a faint comparison line gets none.
  const shaded = g.lines.filter((line) => !line.faint).length === 1;
  const areas = g.lines.flatMap((line) =>
    shaded && !line.faint
      ? line.runs
          .filter((run) => run.length > 1)
          .map(
            (run) =>
              html`<polygon
                points="${[
                  `${run[0]![0].toFixed(1)},${g.height}`,
                  ...run.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`),
                  `${run[run.length - 1]![0].toFixed(1)},${g.height}`,
                ].join(' ')}"
                fill="${line.color}"
                fill-opacity="0.09"
              />`,
          )
      : [],
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
    <g transform="translate(${PAD.left},${PAD.top})">${grid}${areas}${markers}${lines}${labels}</g>
  </svg>`;
}

/** The verdict sentence in a box edged and dotted in its tone. */
function verdictBox(text: string, tone: keyof typeof VERDICT_COLOR): RawHtml {
  return html`<div class="verdict" data-verdict="${tone}" style="--tone:${VERDICT_COLOR[tone]}">
    <span class="dot"></span>
    <p>${text}</p>
  </div>`;
}

function linkOrText(text: string, href: string | null | undefined): RawHtml {
  return href ? html`<a href="${href}">${text}</a>` : html`${text}`;
}

function renderBlock(block: ReportBlock, f: ValueFormatter): RawHtml {
  switch (block.kind) {
    case 'text':
      return block.tone ? verdictBox(block.text, block.tone) : html`<p>${block.text}</p>`;
    case 'stats':
      return html`<div class="tiles">
        ${block.tiles.map(
          (t) =>
            html`<div
              class="tile"
              title="${t.definition ?? ''}"
              style="--tone:${t.change ? TILE_EDGE[t.tone] : TILE_EDGE.neutral}"
            >
              <div class="label">${t.label}</div>
              <div class="value">${t.value}</div>
              ${t.change ? html`<span class="change" style="color:${TONE_COLOR[t.tone]}">${t.change}</span>` : ''}
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
              class="${item.tone && item.tone !== 'neutral' ? 'toned' : ''}"
              style="${item.tone && item.tone !== 'neutral' ? `--tone:${TONE_COLOR[item.tone]}` : ''}"
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
    (band, i) =>
      html`<section class="band">
        <h2><span class="num">${i + 1}</span>${band.title}</h2>
        ${band.description ? html`<p class="desc">${band.description}</p>` : ''}
        ${band.widgets.map(
          (w) =>
            html`<div class="widget" data-widget="${w.key}">
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
        ${
          opts.refreshSeconds
            ? raw(`<meta http-equiv="refresh" content="${Math.max(15, Math.floor(opts.refreshSeconds))}">`)
            : ''
        }
        <title>${L.qualityReport}${s.colon}${bundle.title}</title>
        ${raw(`<style>${STYLES}</style>`)}
      </head>
      <body>
        <div class="wrap">
          <header>
            <p class="kicker">${raw(piwiMarkSvg(16))}${L.qualityReport} · ${bundle.dashboard.name}</p>
            <h1>${bundle.title}</h1>
            <p class="meta">
              ${bundle.period.label}${
                bundle.comparison ? html` · ${L.comparedWith.toLowerCase()} ${bundle.comparison.label}` : ''
              }
            </p>
            ${opts.banner ? html`<p class="meta" data-banner>${opts.banner}</p>` : ''}
          </header>
          ${hasVerdictWidget(bundle) ? '' : verdictBox(bundle.verdict.sentence, bundle.verdict.tone)} ${bands}
          <footer>
            <dl>
              ${facts.map(
                ([k, v]) =>
                  html`<dt>${k}</dt>
                    <dd>${v}</dd>`,
              )}
            </dl>
            ${
              bundle.targets.length
                ? html`<h3>${L.targets}</h3>
                    <ul class="items">
                      ${bundle.targets.map((t) => html`<li data-target-met="${String(t.met)}">${t.text}</li>`)}
                    </ul>`
                : ''
            }
            ${
              bundle.definitions.length
                ? html`<h3>${L.definitions}</h3>
                    <dl>
                      ${bundle.definitions.map(
                        (d) =>
                          html`<dt>${d.label}</dt>
                            <dd>${d.definition}</dd>`,
                      )}
                    </dl>`
                : ''
            }
            ${
              bundle.limits.length
                ? html`<h3>${L.limits}</h3>
                    <ul class="items">
                      ${bundle.limits.map((l) => html`<li>${l}</li>`)}
                    </ul>`
                : ''
            }
            ${bundle.sourceUrl ? html`<p><a href="${bundle.sourceUrl}">${L.openInPiwi}</a></p>` : ''}
            ${raw(piwiCreditHtml(L.generatedBy))}
          </footer>
        </div>
      </body>
    </html>`;
  return toHtmlString(doc);
}
