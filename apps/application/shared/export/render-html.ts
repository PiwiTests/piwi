/**
 * Renders an `ExportBundle` as one self-contained HTML document.
 *
 * The only difference between the standalone `.html` download and the copy
 * inside a ZIP is `assetUrl`: the former returns `data:` URIs, the latter
 * returns relative paths next to the file. Everything else is identical.
 *
 * Every value interpolated here comes from a test run — error text, console
 * output, page source. The `html` tagged template escapes interpolations by
 * default, so markup has to be opted into explicitly with `raw()`.
 *
 * Meaning is carried by text and borders. Fills (the tinted header, the outcome
 * bar, the step timeline) are decoration a printer with background graphics
 * turned off may drop: each one has its words beside it.
 */
import { markdownToHtml } from '#shared/markdown-to-html';
import { html, joinHtml, raw, toHtmlString, type RawHtml } from './html';
import { stripAnsi } from '#shared/error-fingerprint';
import { highlightCode, highlightLines, languageForPath } from '#shared/highlight';
import { parseSourceSnippet } from '#shared/source-snippet';
import { stepLabelParts } from '@piwitests/core/step-analysis';
import { outcomeText, percent } from '#shared/notifications/message-parts';
import {
  caseFacts,
  caseHeadline,
  caseLabels,
  casePath,
  clusterFacts,
  clusterHeadline,
  clusterOccurrences,
  clusterOccurrencesText,
  clusterOwner,
  clusterState,
  diagnosisFacts,
  errorRows,
  fmtBytes,
  fmtDate,
  fmtDuration,
  fmtStepDuration,
  hasDiagnosis,
  OMISSION_REASONS,
  projectLabel,
  runFacts,
  runFailureGroups,
  runHeadline,
  runSummaryFacts,
  runTestsByOutcome,
  runTestDuration,
  runTestStatus,
  runTestWhere,
  slowestTests,
  statusTone,
  statusLabel,
  stepBars,
  type Fact,
} from './fields';
import { piwiCreditHtml, piwiMarkSvg } from '#shared/brand';
import { STATUS_COLORS as C, type StatusColorKey } from '#shared/status-colors';
import type { ExportAsset, ExportBundle, ExportCase, ExportRun, ExportRunTest } from './types';

interface RenderOptions {
  /** Resolves an asset to a URL usable from the rendered document, or null to omit it. */
  assetUrl: (asset: ExportAsset) => string | null;
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg:#f6f6f8; --paper:#fff; --fg:#1c1c20; --muted:#5f5f6b; --faint:#8b8b96;
  --line:#e4e4e9; --line-strong:#c9c9d2; --card:#fafafb; --sunken:#f4f4f7;
  --accent:#4f46e5; --accent-bg:rgba(79,70,229,.07);
  --fail:${C.failed.text}; --pass:${C.passed.text}; --warn:${C.didnotrun.text}; --info:#1d4ed8; --skip:${C.skipped.text}; --flaky:${C.flaky.text};
  --fail-bg:rgba(244,63,94,.07); --pass-bg:rgba(16,185,129,.07); --warn-bg:rgba(245,158,11,.08); --flaky-bg:rgba(217,70,239,.07); --skip-bg:rgba(161,161,170,.1);
  --tok-key:#7c3aed; --tok-str:#0f766e; --tok-num:#b45309; --tok-fn:#1d4ed8; --tok-attr:#a21caf; --tok-builtin:#0369a1;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#111114; --paper:#18181c; --fg:#ececf1; --muted:#a8a8b5; --faint:#7e7e8c;
    --line:#2c2c33; --line-strong:#43434d; --card:#1d1d22; --sunken:#131316;
    --accent:#a5b4fc; --accent-bg:rgba(165,180,252,.08);
    --fail:${C.failed.textDark}; --pass:${C.passed.textDark}; --warn:${C.didnotrun.textDark}; --info:#93c5fd; --skip:${C.skipped.textDark}; --flaky:${C.flaky.textDark};
    --fail-bg:rgba(251,113,133,.1); --pass-bg:rgba(52,211,153,.09); --warn-bg:rgba(251,191,36,.09); --flaky-bg:rgba(232,121,249,.09); --skip-bg:rgba(161,161,170,.1);
    --tok-key:#c4b5fd; --tok-str:#5eead4; --tok-num:#fcd34d; --tok-fn:#93c5fd; --tok-attr:#f0abfc; --tok-builtin:#7dd3fc;
  }
}
* { box-sizing:border-box; }
body {
  margin:0; padding:0 1rem 3rem; background:var(--bg); color:var(--fg);
  font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
}
.wrap { max-width:64rem; margin:0 auto; }

header.doc { display:flex; flex-wrap:wrap; align-items:center; gap:.4rem 1rem; padding:1.1rem 0 .4rem; }
.brand { display:flex; align-items:center; gap:.45rem; font-size:.78rem; font-weight:650; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); min-width:0; }
.brand .project { color:var(--muted); font-weight:600; overflow-wrap:anywhere; }
.stamp { margin-left:auto; color:var(--faint); font-size:.75rem; text-align:right; }
.stamp code { font-family:var(--mono); overflow-wrap:anywhere; }
.toolbar { display:flex; gap:.4rem; width:100%; justify-content:flex-end; }
button {
  font:inherit; font-size:.76rem; padding:.28rem .7rem; border:1px solid var(--line-strong);
  border-radius:6px; background:var(--paper); color:var(--fg); cursor:pointer;
}
button:hover { border-color:var(--accent); color:var(--accent); }

h1 { font-size:1.6rem; line-height:1.2; margin:.35rem 0 .3rem; overflow-wrap:anywhere; letter-spacing:-.01em; }
h2 { font-size:1.25rem; line-height:1.25; margin:.35rem 0 .3rem; overflow-wrap:anywhere; }
h3 { font-size:.7rem; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:.9rem 0 .35rem; }
h3.file { font:600 12px/1.4 var(--mono); letter-spacing:0; text-transform:none; overflow-wrap:anywhere; }
.panel-title { font-size:.7rem; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:0 0 .35rem; }
h2.section-title { font-size:1.15rem; margin:2rem 0 .2rem; }
p { margin:.4rem 0; }
.meta { color:var(--muted); font-size:.8rem; margin:.15rem 0; }
.meta code { font-family:var(--mono); overflow-wrap:anywhere; }

/* The header of an execution or a cluster: its outcome as a colored edge and tint. */
.hero {
  --tone:var(--fail); --tone-bg:var(--fail-bg);
  background:var(--paper); background-image:linear-gradient(var(--tone-bg),var(--tone-bg));
  border:1px solid var(--line); border-left:6px solid var(--tone); border-radius:12px;
  padding:1.1rem 1.3rem 1.15rem; margin:.6rem 0 1rem;
}
.hero.t-pass { --tone:var(--pass); --tone-bg:var(--pass-bg); }
.hero.t-warn { --tone:var(--warn); --tone-bg:var(--warn-bg); }
.hero.t-flaky { --tone:var(--flaky); --tone-bg:var(--flaky-bg); }
.hero.t-skip { --tone:var(--skip); --tone-bg:var(--skip-bg); }
.hero.t-info { --tone:var(--info); --tone-bg:var(--accent-bg); }
.hero .labels { display:flex; flex-wrap:wrap; gap:.35rem; align-items:center; }
.hero .path { color:var(--muted); font-size:.92rem; margin:.1rem 0; overflow-wrap:anywhere; }
.hero .loc { font:12.5px/1.4 var(--mono); color:var(--muted); margin:.15rem 0 0; overflow-wrap:anywhere; }
.hero .headline { margin:.75rem 0 0; font-size:1rem; font-weight:600; overflow-wrap:anywhere; }
.hero .headline .detail { display:block; font-weight:400; color:var(--muted); font-size:.88rem; }
.hero .state { margin:.6rem 0 0; font-size:.88rem; }

.badge {
  display:inline-block; padding:.05rem .55rem; border-radius:999px; font-size:.7rem; line-height:1.5;
  font-weight:700; letter-spacing:.05em; text-transform:uppercase; border:1.5px solid currentColor; background:var(--paper);
}
.chip {
  display:inline-block; padding:.05rem .5rem; border-radius:999px; font-size:.72rem; line-height:1.5;
  border:1px solid var(--line-strong); color:var(--muted); background:var(--paper); overflow-wrap:anywhere;
}
.chip.new { color:var(--fail); border-color:currentColor; font-weight:650; }

/* Matches getStatusColor in app/utils: timed-out and interrupted read as failed, didn't run as a warning. */
.s-failed, .s-timedout, .s-interrupted, .s-error, .s-open { color:var(--fail); }
.s-passed, .s-resolved { color:var(--pass); }
.s-flaky { color:var(--flaky); }
.s-skipped, .s-log, .s-debug, .s-ignored { color:var(--skip); }
.s-didnotrun, .s-warning, .s-warn { color:var(--warn); }
.s-info { color:var(--info); }
.tag { font-weight:650; }

dl.facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr)); gap:.5rem; margin:.8rem 0; }
dl.facts > div { min-width:0; background:var(--paper); border:1px solid var(--line); border-radius:9px; padding:.5rem .7rem; }
dl.facts > div.wide { grid-column:1 / -1; }
dl.facts dt { font-size:.64rem; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); font-weight:650; }
dl.facts dd { margin:.1rem 0 0; font-size:.95rem; font-weight:600; overflow-wrap:anywhere; }

.panel { background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:.75rem .9rem; margin:.6rem 0; }
.panel > h3:first-child { margin-top:0; }
dl.inline { display:flex; flex-wrap:wrap; gap:.25rem 1.2rem; margin:0; font-size:.84rem; }
dl.inline > div { display:flex; gap:.35rem; min-width:0; }
dl.inline dt { color:var(--faint); }
dl.inline dd { margin:0; font-weight:600; overflow-wrap:anywhere; }

.bar { display:flex; height:10px; border-radius:999px; overflow:hidden; background:var(--sunken); margin:.7rem 0 .45rem; }
.bar > span { display:block; height:100%; min-width:3px; }
.bar > span + span { border-left:2px solid var(--paper); }
.legend { display:flex; flex-wrap:wrap; gap:.2rem 1rem; font-size:.8rem; color:var(--muted); margin:0; }
.legend b { color:var(--fg); }
.dot { display:inline-block; width:.6rem; height:.6rem; border-radius:3px; margin-right:.35rem; vertical-align:-.02em; }

.occ { display:flex; align-items:flex-end; gap:3px; height:42px; margin:.5rem 0 .3rem; }
.occ > span { flex:1; max-width:22px; border-radius:3px 3px 0 0; background:var(--line-strong); min-height:3px; }
.occ > span.hit { background:${C.failed.fill}; }

details.card {
  background:var(--paper); border:1px solid var(--line); border-left:4px solid var(--line-strong);
  border-radius:10px; margin:.6rem 0; overflow:hidden;
}
details.card.k-error { border-left-color:var(--fail); }
details.card.k-diagnosis { border-left-color:var(--accent); }
details.card.k-evidence { border-left-color:var(--info); }
details.card.k-source { border-left-color:var(--flaky); }
details > summary {
  cursor:pointer; padding:.55rem .85rem; font-weight:650; font-size:.9rem;
  list-style:none; display:flex; gap:.6rem; align-items:center;
}
details > summary:hover { color:var(--accent); }
details > summary::-webkit-details-marker { display:none; }
details > summary .aside { color:var(--faint); font-weight:500; font-size:.8rem; font-family:var(--mono); overflow-wrap:anywhere; }
details > summary .count { color:var(--faint); font-weight:500; font-size:.8rem; }
details > summary::after { content:'+'; margin-left:auto; color:var(--faint); font-weight:400; font-size:1rem; }
details[open] > summary::after { content:'\\2013'; }
details[open] > summary { border-bottom:1px solid var(--line); }
.body { padding:.7rem .85rem .8rem; }
.body > :first-child { margin-top:0; }
.body > :last-child { margin-bottom:0; }

pre {
  background:var(--sunken); border:1px solid var(--line); border-radius:7px;
  padding:.6rem .75rem; margin:.35rem 0; overflow-x:auto;
  font:12.5px/1.55 var(--mono); white-space:pre-wrap; overflow-wrap:anywhere;
}
code { font-family:var(--mono); font-size:.92em; }
pre.hljs { position:relative; }
pre.hljs[data-lang]:not([data-lang=""])::before {
  content:attr(data-lang); position:absolute; top:.15rem; right:.5rem;
  font-size:.6rem; letter-spacing:.06em; text-transform:uppercase; color:var(--faint);
}
pre.error .e-head { color:var(--fail); font-weight:700; }
pre.error .e-expected { color:var(--pass); font-weight:600; }
pre.error .e-received { color:var(--fail); font-weight:600; }
pre.error .e-log { color:var(--muted); }
pre.error .e-stack { color:var(--faint); }
.fail-line { display:inline-block; min-width:100%; background:var(--fail-bg); }
.fail-line .ln { color:var(--fail); font-weight:700; }

/* Token colors only — no fills, so a background-free print keeps every hue. */
.hljs-comment, .hljs-quote { color:var(--faint); font-style:italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type, .hljs-meta { color:var(--tok-key); }
.hljs-string, .hljs-regexp, .hljs-symbol, .hljs-char { color:var(--tok-str); }
.hljs-number, .hljs-bullet { color:var(--tok-num); }
.hljs-title, .hljs-title.function_, .hljs-section, .hljs-name { color:var(--tok-fn); }
.hljs-attr, .hljs-attribute, .hljs-property, .hljs-variable, .hljs-template-variable { color:var(--tok-attr); }
.hljs-built_in, .hljs-class .hljs-title { color:var(--tok-builtin); }
.hljs-addition { color:var(--pass); }
.hljs-deletion { color:var(--fail); }
.hljs-emphasis { font-style:italic; }
.hljs-strong { font-weight:650; }
.ln { color:var(--faint); user-select:none; }
ul { margin:.35rem 0; padding-left:1.1rem; }
li { margin:.15rem 0; }
blockquote { margin:.4rem 0; padding-left:.6rem; border-left:2px solid var(--line-strong); color:var(--muted); }

.diagnosis-summary { font-size:1rem; font-weight:600; margin:.2rem 0 .5rem; }
.note { border-left:3px solid var(--accent); padding:.45rem .7rem; margin:.7rem 0; font-size:.86rem; background:var(--accent-bg); border-radius:0 7px 7px 0; }

.shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(16rem,1fr)); gap:.7rem; }
figure { margin:0; min-width:0; }
img.shot, video { max-width:100%; height:auto; border:1px solid var(--line-strong); border-radius:8px; display:block; background:var(--sunken); }
figcaption { font-size:.72rem; color:var(--faint); margin-top:.3rem; overflow-wrap:anywhere; }

.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.82rem; }
th, td { text-align:left; padding:.35rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; }
th { font-size:.64rem; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); font-weight:650; white-space:nowrap; }
tbody tr:last-child td { border-bottom:0; }
td.num { font-family:var(--mono); white-space:nowrap; }
td a, ul.tests a { color:inherit; }
td.nowrap { white-space:nowrap; overflow-wrap:normal; }
.sub { color:var(--muted); font-family:var(--mono); font-size:.92em; }
.cat { color:var(--muted); font-size:.78rem; }

.steps td { vertical-align:middle; }
.steps td.tl { width:32%; min-width:8rem; }
.track { position:relative; display:block; height:8px; border-radius:999px; background:var(--sunken); }
.track > span { position:absolute; top:0; bottom:0; min-width:3px; border-radius:999px; background:var(--accent); }
tr.failed .track > span { background:${C.failed.fill}; }
tr.recovered .track > span { background:${C.didnotrun.fill}; }
tr.failed td:first-child { color:var(--fail); font-weight:600; }
tr.slowest td.num { font-weight:700; }

section.case { padding-top:.2rem; }
section.case + section.case { margin-top:2rem; }
.case-head { color:var(--muted); font-size:.75rem; letter-spacing:.06em; text-transform:uppercase; font-weight:650; margin:0; }
.group + .group { border-top:1px solid var(--line); margin-top:.7rem; padding-top:.7rem; }
.group-head { margin:0 0 .25rem; font-size:.92rem; overflow-wrap:anywhere; }
.group-head b { font-weight:650; }
ul.tests { list-style:none; margin:.3rem 0 0; padding:0; }
ul.tests li { margin:.25rem 0; overflow-wrap:anywhere; }
ul.tests .err { display:block; font:12px/1.45 var(--mono); color:var(--fail); margin:.1rem 0 0 0; overflow-wrap:anywhere; }
.bar-cell { width:35%; min-width:8rem; }
.foot { color:var(--faint); font-size:.78rem; margin:1.2rem 0 0; }

@media (max-width:30rem) {
  body { padding:0 .6rem 2.5rem; }
  .hero { padding:.9rem .9rem 1rem; }
  h1 { font-size:1.3rem; }
  dl.facts { grid-template-columns:repeat(auto-fill,minmax(8rem,1fr)); }
  .steps .tl, .bar-cell { display:none; }
}

@media print {
  :root {
    --bg:#fff; --paper:#fff; --fg:#000; --muted:#3f3f46; --faint:#52525b;
    --line:#b8b8bf; --line-strong:#71717a; --card:transparent; --sunken:transparent;
    --accent:#3730a3; --fail:${C.failed.print}; --pass:${C.passed.print}; --warn:${C.didnotrun.print}; --info:#1e40af; --flaky:${C.flaky.print};
    --tok-key:#5b21b6; --tok-str:#115e59; --tok-num:#92400e; --tok-fn:#1e3a8a; --tok-attr:#86198f; --tok-builtin:#075985;
  }
  body { padding:0; font-size:10.5pt; }
  .no-print { display:none !important; }
  details.card, pre, .note, button, .panel, dl.facts > div { background:transparent !important; }
  /* Fold markers mean nothing on paper; the [open] selector outranks a bare one. */
  details > summary::after, details[open] > summary::after { content:''; }
  details, .hero, .panel { break-inside:avoid; }
  section.case { break-before:page; }
  section.case:first-of-type { break-before:auto; }
  pre { white-space:pre-wrap; word-break:break-word; }
  a { color:inherit; text-decoration:underline; }
}
`;

const SCRIPT = `
document.addEventListener('click', function (e) {
  var t = e.target;
  if (t && t.dataset && t.dataset.action === 'expand') {
    document.querySelectorAll('details').forEach(function (d) { d.open = true; });
  }
  if (t && t.dataset && t.dataset.action === 'print') { window.print(); }
});
window.addEventListener('beforeprint', function () {
  document.querySelectorAll('details').forEach(function (d) { d.open = true; });
});
`;

/** Status-ish value → the color class that carries its meaning once fills are gone. */
function statusClass(value: unknown): string {
  return `s-${String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')}`;
}

const TONE_CLASSES: Record<StatusColorKey, string> = {
  passed: 't-pass',
  failed: 't-fail',
  flaky: 't-flaky',
  skipped: 't-skip',
  fixme: 't-skip',
  didnotrun: 't-warn',
  running: 't-info',
};

/** A status → the tone of a header's edge and tint. */
function toneClass(value: unknown, retries?: number | null): string {
  return TONE_CLASSES[statusTone(value, retries)];
}

function httpClass(status: unknown): string {
  const n = Number(status);
  if (!Number.isFinite(n)) return '';
  if (n >= 500) return 's-failed';
  if (n >= 400) return 's-warning';
  if (n >= 300) return 's-info';
  if (n >= 200) return 's-passed';
  return '';
}

function facts(rows: Fact[]): RawHtml {
  const present = rows.filter(([, v]) => v != null && v !== '');
  if (!present.length) return raw('');
  return html`<dl class="facts">
    ${present.map(
      ([k, v]) =>
        html`<div class="${String(v).length > 48 ? 'wide' : ''}">
          <dt>${k}</dt>
          <dd>${String(v)}</dd>
        </div>`,
    )}
  </dl>`;
}

/** Facts on one wrapping line: `Branch main · Environment staging`. */
function inlineFacts(rows: Fact[]): RawHtml {
  const present = rows.filter(([, v]) => v != null && v !== '');
  if (!present.length) return raw('');
  return html`<dl class="inline">
    ${present.map(
      ([k, v]) =>
        html`<div>
          <dt>${k}</dt>
          <dd>${String(v)}</dd>
        </div>`,
    )}
  </dl>`;
}

function details(
  title: string,
  inner: RawHtml | string,
  opts: { kind?: string; open?: boolean; aside?: string | null; count?: number } = {},
): RawHtml {
  const body = toHtmlString(inner);
  if (!body.trim()) return raw('');
  return html`<details class="card k-${opts.kind ?? 'data'}" ${opts.open ? raw('open') : ''}>
    <summary>
      ${title}${opts.count != null ? html`<span class="count">${opts.count}</span>` : ''}
      ${opts.aside ? html`<span class="aside">${opts.aside}</span>` : ''}
    </summary>
    <div class="body">${raw(body)}</div>
  </details>`;
}

/** An error with its parts told apart: the first line, the expected and received values, the call log and the stack. */
function errorBlock(text: string): RawHtml {
  const rows = errorRows(text).map((row) => toHtmlString(html`<span class="e-${row.kind}">${row.text}</span>`));
  return html`<pre class="error">${raw(rows.join('\n'))}</pre>`;
}

/**
 * A source block, syntax-highlighted. highlight.js escapes the code itself, so
 * its output is markup we can pass through.
 */
function code(text: string, lang: string): RawHtml {
  const { html: highlighted, language } = highlightCode(stripAnsi(text), lang);
  return html`<pre class="hljs" data-lang="${language || lang}"><code>${raw(highlighted)}</code></pre>`;
}

/** A captured source snippet: the line-number gutter kept plain, the code syntax-highlighted, the failing line marked. */
function snippet(text: string, file: string): RawHtml {
  const rows = parseSourceSnippet(stripAnsi(text));
  const lang = languageForPath(file);
  const code = highlightLines(
    rows.map((row) => row.code),
    lang,
  );
  const lines = rows.map((row, i) => {
    const line = html`<span class="ln">${row.gutter}</span>${raw(code[i] ?? '')}`;
    return toHtmlString(row.failing ? html`<span class="fail-line">${line}</span>` : line);
  });
  return html`<pre class="hljs" data-lang="${lang ?? ''}"><code>${raw(lines.join('\n'))}</code></pre>`;
}

/** AI prose is Markdown; links are flattened so the document stays self-contained. */
function prose(markdown: string): RawHtml {
  return raw(markdownToHtml(markdown, { linkMode: 'text' }));
}

/** A run's tests as one bar split by outcome, then the same counts in words. */
function outcomeBar(outcome: NonNullable<ReturnType<typeof runTestsByOutcome>>): RawHtml {
  const { segments, total } = outcome;
  return html`<div class="bar" role="img" aria-label="${outcomeText(segments, total)}">
      ${segments.map(
        (s) => html`<span style="width:${((s.count / total) * 100).toFixed(2)}%;background:${C[s.key].fill}"></span>`,
      )}
    </div>
    <p class="legend">
      ${segments.map(
        (s) =>
          html`<span
            ><i class="dot" style="background:${C[s.key].fill}"></i><b>${s.count}</b> ${s.label}
            (${percent(s.count, total)})</span
          >`,
      )}
    </p>`;
}

function renderDiagnosis(diagnosis: Record<string, any> | null): RawHtml {
  if (!hasDiagnosis(diagnosis)) return raw('');
  const d = diagnosis as Record<string, any>;
  const det = (d.details ?? {}) as Record<string, any>;
  const parts: (RawHtml | string)[] = [];

  if (d.summary) parts.push(html`<p class="diagnosis-summary">${String(d.summary)}</p>`);
  if (d.rootCause) parts.push(html`<p><span class="tag">Root cause:</span> ${String(d.rootCause)}</p>`);
  parts.push(facts(diagnosisFacts(d)));

  const evidence = (det.evidence ?? []) as unknown[];
  if (evidence.length) {
    parts.push(
      html`<h3>Evidence</h3>
        <ul>
          ${evidence.map((e) => html`<li>${String(e)}</li>`)}
        </ul>`,
    );
  }

  const fix = (det.suggestedFix ?? null) as Record<string, any> | null;
  if (fix) {
    parts.push(html`<h3>Suggested fix</h3>`);
    if (fix.description) parts.push(prose(String(fix.description)));
    if (fix.patch) parts.push(code(String(fix.patch), 'diff'));
    else if (fix.code) parts.push(code(String(fix.code), 'typescript'));
  }

  return details('AI diagnosis', joinHtml(parts, '\n'), { kind: 'diagnosis', open: true });
}

/** A case's evidence, and how many items it shows. */
function renderAssets(exportCase: ExportCase, assetUrl: RenderOptions['assetUrl']): { html: RawHtml; count: number } {
  const pick = (kind: string) => exportCase.assets.filter((a) => a.kind === kind);
  const out: (RawHtml | string)[] = [];

  const figures = (kind: string, node: (a: ExportAsset, url: string) => RawHtml) =>
    pick(kind)
      .map((a) => {
        const url = assetUrl(a);
        return url ? node(a, url) : null;
      })
      .filter((f): f is RawHtml => f !== null);

  const shots = figures(
    'screenshot',
    (a, url) =>
      html`<figure>
        <img class="shot" src="${url}" alt="${a.name}" />
        <figcaption>${a.name}</figcaption>
      </figure>`,
  );
  if (shots.length)
    out.push(
      html`<h3>Screenshots</h3>
        <div class="shots">${shots}</div>`,
    );

  const videos = figures(
    'video',
    (a, url) =>
      html`<figure>
        <video controls preload="metadata" src="${url}"></video>
        <figcaption>${a.name} — does not play in a printed PDF</figcaption>
      </figure>`,
  );
  if (videos.length)
    out.push(
      html`<h3>Video</h3>
        <div class="shots">${videos}</div>`,
    );

  const fileRows = [...pick('trace'), ...pick('attachment')].map((a) => {
    const url = assetUrl(a);
    const label = url ? html`<a href="${url}">${a.name}</a>` : html`${a.name} <span class="meta">(not included)</span>`;
    return html`<tr>
      <td>${label}</td>
      <td>${a.kind}</td>
      <td class="num">${fmtBytes(a.size)}</td>
    </tr>`;
  });
  if (fileRows.length) {
    out.push(
      html`<h3>Files</h3>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              ${fileRows}
            </tbody>
          </table>
        </div>
        <p class="meta">
          Trace archives open at <code>trace.playwright.dev</code> or in any Playwright trace viewer.
        </p>`,
    );
  }

  return { html: joinHtml(out, '\n'), count: shots.length + videos.length + fileRows.length };
}

/** The steps on the test's timeline: each one's bar where it ran, the slowest in bold, a failed one in red. */
function renderSteps(steps: unknown, pauses: unknown): RawHtml {
  if (!Array.isArray(steps) || !steps.length) return raw('');
  const list = steps as Record<string, any>[];
  const bars = stepBars(list);
  let slowest = -1;
  list.forEach((s, i) => {
    if ((Number(s.duration) || 0) > (Number(list[slowest]?.duration) || 0)) slowest = i;
  });
  const rows = list.map((step, i) => {
    const { title, subtitle } = stepLabelParts(step);
    const bar = bars[i]!;
    const outcome = step.failed ? 'failed' : step.recovered ? 'recovered' : '';
    const state = [outcome, i === slowest ? 'slowest' : ''].filter(Boolean).join(' ');
    return html`<tr class="${state}">
      <td>${title}${subtitle ? html` <span class="sub">${subtitle}</span>` : ''}</td>
      <td class="cat">${[String(step.category ?? ''), outcome].filter(Boolean).join(' · ')}</td>
      <td class="tl">
        <span class="track"
          ><span style="left:${(bar.offset * 100).toFixed(2)}%;width:${(bar.width * 100).toFixed(2)}%"></span
        ></span>
      </td>
      <td class="num">${fmtStepDuration(step, pauses)}</td>
    </tr>`;
  });
  return html`<div class="scroll">
    <table class="steps">
      <thead>
        <tr>
          <th>Step</th>
          <th>Category</th>
          <th class="tl">Timeline</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function renderConsole(logs: unknown): RawHtml {
  if (!Array.isArray(logs) || !logs.length) return raw('');
  const rows = (logs as Record<string, any>[]).map(
    (l) =>
      html`<tr>
        <td class="num ${statusClass(l.type ?? 'log')}"><span class="tag">${String(l.type ?? 'log')}</span></td>
        <td>${String(l.text ?? '')}</td>
      </tr>`,
  );
  return html`<div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Level</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

function renderNetwork(requests: unknown): RawHtml {
  if (!Array.isArray(requests) || !requests.length) return raw('');
  const rows = (requests as Record<string, any>[]).map(
    (r) =>
      html`<tr>
        <td class="num">${String(r.method ?? '')}</td>
        <td class="num ${httpClass(r.status)}"><span class="tag">${String(r.status ?? '')}</span></td>
        <td class="num">${fmtDuration(r.duration)}</td>
        <td>${String(r.url ?? '')}</td>
      </tr>`,
  );
  return html`<div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Method</th>
          <th>Status</th>
          <th>Time</th>
          <th>URL</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}

/** The header of one execution: its status, name, location and what Piwi read in its failure. */
function caseHero(exportCase: ExportCase, heading: 'h1' | 'h2'): RawHtml {
  const path = casePath(exportCase);
  const headline = caseHeadline(exportCase);
  const labels = caseLabels(exportCase);
  const title = heading === 'h1' ? html`<h1>${exportCase.title}</h1>` : html`<h2>${exportCase.title}</h2>`;
  const retries = Number((exportCase.detail as Record<string, any>).retries ?? 0);
  return html`<div class="hero ${toneClass(exportCase.status, retries)}">
    <div class="labels">
      <span class="badge ${statusClass(exportCase.status)}">${exportCase.status}</span>
      ${labels.map((label) => html`<span class="chip ${label.news ? 'new' : ''}">${label.text}</span>`)}
    </div>
    ${title} ${path ? html`<p class="path">${path}</p>` : ''}
    ${exportCase.location || exportCase.filePath ? html`<p class="loc">${exportCase.location ?? exportCase.filePath}</p>` : ''}
    ${
      headline
        ? html`<p class="headline">
            ${headline.headline}${headline.detail ? html`<span class="detail">${headline.detail}</span>` : ''}
          </p>`
        : ''
    }
  </div>`;
}

/** A run: its context in one line, then its tests by outcome. */
function runPanel(run: Record<string, any> | null | undefined): RawHtml {
  const context = runFacts(run ?? {});
  const outcome = runTestsByOutcome(run);
  if (!context.some(([, v]) => v) && !outcome) return raw('');
  return html`<div class="panel">
    <h2 class="panel-title">The run</h2>
    ${inlineFacts(context)} ${outcome ? outcomeBar(outcome) : ''}
  </div>`;
}

interface CaseOptions {
  /** The case is the document's subject: its title is the page's `h1`. */
  standalone: boolean;
  /** The line above a case among several (`Test 2 of 5`). */
  label?: string;
  /** Leave out the run panel, which a run export shows once at its top. */
  withoutRun?: boolean;
}

function renderCase(exportCase: ExportCase, opts: RenderOptions, caseOpts: CaseOptions): RawHtml {
  const d = exportCase.detail as Record<string, any>;
  const parts: (RawHtml | string)[] = [];

  if (caseOpts.label) parts.push(html`<p class="case-head">${caseOpts.label}</p>`);
  parts.push(caseHero(exportCase, caseOpts.standalone ? 'h1' : 'h2'));
  parts.push(facts(caseFacts(exportCase)));
  if (!caseOpts.withoutRun) parts.push(runPanel(d.testRun));

  if (d.error) parts.push(details('Error', errorBlock(String(d.error)), { kind: 'error', open: true }));

  const frames = Array.isArray(d.testSourceFrames) ? (d.testSourceFrames as Record<string, any>[]) : [];
  if (frames.length) {
    parts.push(
      details(
        'Call stack',
        joinHtml(
          frames.map(
            (f) =>
              html`<h3 class="file">${`${f.file ?? ''}:${f.line ?? ''}`}</h3>
                ${snippet(String(f.snippet ?? ''), String(f.file ?? ''))}`,
          ),
        ),
        { kind: 'source', open: true, count: frames.length > 1 ? frames.length : undefined },
      ),
    );
  }

  parts.push(renderDiagnosis(exportCase.diagnosis));

  const evidence = renderAssets(exportCase, opts.assetUrl);
  if (toHtmlString(evidence.html).trim()) {
    parts.push(details('Evidence', evidence.html, { kind: 'evidence', open: true, count: evidence.count }));
  }

  const count = (v: unknown) => (Array.isArray(v) ? v.length : undefined);
  parts.push(details('Steps', renderSteps(d.steps, d.pauses), { open: true, count: count(d.steps) }));
  parts.push(details('Console', renderConsole(d.consoleLogs), { count: count(d.consoleLogs) }));
  parts.push(details('Network', renderNetwork(d.networkRequests), { count: count(d.networkRequests) }));
  if (d.testSource) {
    parts.push(
      details('Test source', snippet(String(d.testSource), exportCase.filePath ?? 'test.ts'), {
        aside: exportCase.filePath,
      }),
    );
  }
  if (d.ariaSnapshot) parts.push(details('ARIA snapshot', code(String(d.ariaSnapshot), 'yaml')));
  if (d.pageState) parts.push(details('Page state', code(JSON.stringify(d.pageState, null, 2), 'json')));
  if (d.webVitals) parts.push(details('Web vitals', code(JSON.stringify(d.webVitals, null, 2), 'json')));

  return html`<section class="case" id="case-${exportCase.executionId}">${joinHtml(parts, '\n')}</section>`;
}

/** A cluster's occurrences per recent run as small bars, then the total in words. */
function occurrenceStrip(cluster: Record<string, any>): RawHtml {
  const points = clusterOccurrences(cluster);
  if (points.length < 2) return raw('');
  const max = Math.max(1, ...points.map((p) => p.count));
  const sentence = clusterOccurrencesText(points)!;
  return html`<div class="panel">
    <h2 class="panel-title">Recent runs</h2>
    <div class="occ" role="img" aria-label="${sentence}">
      ${points.map(
        (p) =>
          html`<span
            class="${p.count > 0 ? 'hit' : ''}"
            style="height:${p.count > 0 ? Math.max(18, (p.count / max) * 100).toFixed(0) : 8}%"
            title="${`Run #${p.runId}: ${p.count}`}"
          ></span>`,
      )}
    </div>
    <p class="meta">${sentence}, oldest on the left.</p>
  </div>`;
}

/** The affected tests of a cluster export, each linked to its section below. */
function membersTable(bundle: ExportBundle): RawHtml {
  if (bundle.cases.length < 2) return raw('');
  return html`<div class="panel">
    <h2 class="panel-title">Affected tests in this export</h2>
    <div class="scroll">
      <table>
        <tbody>
          ${bundle.cases.map(
            (c) =>
              html`<tr>
                <td class="${statusClass(c.status)}"><span class="tag">${c.status}</span></td>
                <td><a href="#case-${c.executionId}">${c.title}</a></td>
                <td class="sub">${c.location ?? c.filePath ?? ''}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderClusterHeader(bundle: ExportBundle): RawHtml {
  const c = bundle.cluster as Record<string, any> | null;
  if (!c) return raw('');
  const headline = clusterHeadline(c);
  const state = clusterState(c);
  const owner = clusterOwner(c);
  const parts: (RawHtml | string)[] = [
    html`<div class="hero ${toneClass(c.status)}">
      <div class="labels">
        ${c.status ? html`<span class="badge ${statusClass(c.status)}">${String(c.status)}</span>` : ''}
        ${owner ? html`<span class="chip">Owner ${owner}</span>` : ''}
      </div>
      <h1>${bundle.title}</h1>
      ${
        headline
          ? html`<p class="headline">
              ${headline.headline}${headline.detail ? html`<span class="detail">${headline.detail}</span>` : ''}
            </p>`
          : ''
      }
      ${state ? html`<p class="state">${state}</p>` : ''}
    </div>`,
    facts(clusterFacts(c)),
    occurrenceStrip(c),
  ];

  if (c.sampleError) {
    parts.push(details('Representative error', errorBlock(String(c.sampleError)), { kind: 'error', open: true }));
  }
  parts.push(renderDiagnosis((c.diagnosis ?? null) as Record<string, any> | null));
  parts.push(membersTable(bundle));

  if (bundle.truncatedCases.length) {
    parts.push(
      details(
        `Other affected tests (${bundle.truncatedCases.length}, evidence not included)`,
        html`<ul>
          ${bundle.truncatedCases.map((t) => html`<li>${t.title} <span class="meta">${[t.filePath, t.browser].filter(Boolean).join(' · ')}</span></li>`)}
        </ul>`,
      ),
    );
  }
  return joinHtml(parts, '\n');
}

/** A test of a run in a list: its outcome, its name linked to its detail when the export holds it, and where it is. */
function runTestLine(test: ExportRunTest, detailed: Set<number>, withError: boolean): RawHtml {
  const status = runTestStatus(test);
  const name = detailed.has(test.executionId)
    ? html`<a href="#case-${test.executionId}">${test.title}</a>`
    : test.title;
  return html`<li>
    <span class="tag ${statusClass(status)}">${statusLabel(status)}</span> ${name}
    <span class="sub">${test.location ?? ''}</span>
    ${runTestWhere(test) ? html`<span class="meta">${runTestWhere(test)}</span>` : ''}
    ${withError && test.error ? html`<span class="err">${test.error}</span>` : ''}
  </li>`;
}

/** A run's failing and flaky tests by root cause, each failure cluster with its tests. */
function runFailures(bundle: ExportBundle, run: ExportRun): RawHtml {
  const groups = runFailureGroups(run);
  if (!groups.length) return raw('');
  const detailed = new Set(bundle.cases.map((c) => c.executionId));
  const count = groups.reduce((n, g) => n + g.tests.length, 0);
  return details(
    'Failures by root cause',
    joinHtml(
      groups.map(
        (g) =>
          html`<div class="group">
            <p class="group-head">
              <b>${g.title}</b>${g.isNew ? html` <span class="chip new">New</span>` : ''}
              <span class="meta"
                >${[g.status, `${g.tests.length} ${g.tests.length === 1 ? 'test' : 'tests'}`].filter(Boolean).join(' · ')}</span
              >
            </p>
            ${g.diagnosis ? html`<p class="meta">${g.diagnosis}</p>` : ''}
            <ul class="tests">
              ${g.tests.map((t) => runTestLine(t, detailed, true))}
            </ul>
          </div>`,
      ),
      '\n',
    ),
    { kind: 'error', open: true, count },
  );
}

/** The tests of a run that passed after an earlier attempt failed. */
function runFlaky(run: ExportRun): RawHtml {
  const flaky = run.tests.filter((t) => t.flaky);
  if (!flaky.length) return raw('');
  return details(
    'Flaky tests',
    html`<div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Test</th>
            <th>Location</th>
            <th>Browser</th>
            <th>Retries</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${flaky.map(
            (t) =>
              html`<tr>
                <td>${t.title}</td>
                <td class="sub">${t.location ?? ''}</td>
                <td class="nowrap">${runTestWhere(t)}</td>
                <td class="num">${t.retries}</td>
                <td class="num">${runTestDuration(t)}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`,
    { kind: 'source', open: true, count: flaky.length },
  );
}

/** The tests of a run that took longest, each with a bar against the longest. */
function runSlowest(run: ExportRun): RawHtml {
  const slowest = slowestTests(run.tests);
  if (!slowest.length) return raw('');
  const longest = slowest[0]!.duration ?? 1;
  return details(
    'Slowest tests',
    html`<div class="scroll">
      <table class="steps">
        <tbody>
          ${slowest.map(
            (t) =>
              html`<tr>
                <td>${t.title} <span class="sub">${t.location ?? ''}</span></td>
                <td class="nowrap">${runTestWhere(t)}</td>
                <td class="bar-cell">
                  <span class="track"
                    ><span style="left:0;width:${(((t.duration ?? 0) / longest) * 100).toFixed(2)}%"></span
                  ></span>
                </td>
                <td class="num">${runTestDuration(t)}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`,
    { open: true, count: slowest.length },
  );
}

/** Every test of a run once, by file: its outcome, name, browser, duration and retries. */
function runAllTests(run: ExportRun): RawHtml {
  if (!run.tests.length) return raw('');
  return details(
    'All tests',
    html`<div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Test</th>
            <th>Browser</th>
            <th>Duration</th>
            <th>Retries</th>
          </tr>
        </thead>
        <tbody>
          ${run.tests.map((t) => {
            const status = runTestStatus(t);
            return html`<tr>
              <td class="${statusClass(status)} nowrap"><span class="tag">${statusLabel(status)}</span></td>
              <td>${[...t.suitePath, t.title].join(' › ')}<br /><span class="sub">${t.location ?? ''}</span></td>
              <td class="nowrap">${runTestWhere(t)}</td>
              <td class="num">${runTestDuration(t)}</td>
              <td class="num">${t.retries}</td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>`,
    { open: run.tests.length <= 300, count: run.tests.length },
  );
}

/** The top of a run export: the run's header, figures, context and tests, then its failures, flaky and slowest tests. */
function renderRunHeader(bundle: ExportBundle): RawHtml {
  const run = bundle.run;
  if (!run) return raw('');
  const d = run.detail as Record<string, any>;
  const where = [d.branch, d.environment].filter(Boolean).join(' · ');
  const headline = runHeadline(d);
  const labels = [d.isFullRun === false ? 'Partial run' : null, d.origin ? String(d.origin) : null].filter(Boolean);
  return joinHtml(
    [
      html`<div class="hero ${toneClass(d.status)}">
        <div class="labels">
          ${d.status ? html`<span class="badge ${statusClass(d.status)}">${String(d.status)}</span>` : ''}
          ${labels.map((label) => html`<span class="chip">${label}</span>`)}
        </div>
        <h1>${bundle.title}</h1>
        ${where ? html`<p class="path">${where}</p>` : ''} ${headline ? html`<p class="headline">${headline}</p>` : ''}
      </div>`,
      facts(runSummaryFacts(run)),
      runPanel(d),
      runFailures(bundle, run),
      runFlaky(run),
      runSlowest(run),
      runAllTests(run),
    ],
    '\n',
  );
}

function renderOmissions(bundle: ExportBundle): RawHtml {
  if (!bundle.omitted.length) return raw('');
  const rows = bundle.omitted.map(
    (o) =>
      html`<tr>
        <td>${o.name}</td>
        <td>${o.kind}</td>
        <td class="num">${fmtBytes(o.bytes)}</td>
        <td>${OMISSION_REASONS[o.reason] ?? o.reason}</td>
      </tr>`,
  );
  return details(
    `Omitted from this export (${bundle.omitted.length})`,
    html`<div class="scroll">
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Kind</th>
            <th>Size</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>`,
    { open: true },
  );
}

export function renderExportHtml(bundle: ExportBundle, opts: RenderOptions): string {
  const isCluster = bundle.kind === 'cluster';
  const isRun = bundle.kind === 'run';
  const kindLabel = isRun ? 'Test run' : isCluster ? 'Failure cluster' : 'Test execution';
  const label = projectLabel(bundle);
  const standalone = bundle.kind === 'execution' && bundle.cases.length === 1;
  const caseWord = isRun ? 'Failure' : 'Test';

  const head = joinHtml([
    raw('<meta charset="utf-8">'),
    raw('<meta name="viewport" content="width=device-width, initial-scale=1">'),
    // Standalone files are opened from disk and carry untrusted test output —
    // deny everything except the data/blob URIs this document embeds itself.
    raw(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: 'self'; media-src data: blob: 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:">`,
    ),
    html`<title>${`Piwi — ${bundle.title}`}</title>`,
    raw(`<style>${STYLES}</style>`),
  ]);

  const exported = fmtDate(bundle.generatedAt) ?? bundle.generatedAt;
  const body = joinHtml(
    [
      raw('<div class="wrap">'),
      html`<header class="doc">
        <div class="brand">
          ${raw(piwiMarkSvg(18))}<span>${kindLabel}</span>${label ? html`<span class="project">· ${label}</span>` : ''}
        </div>
        <div class="stamp">
          Exported ${exported}${bundle.piwiVersion ? ` · Piwi ${bundle.piwiVersion}` : ''}
          ${bundle.sourceUrl ? html`<br /><code>${bundle.sourceUrl}</code>` : ''}
        </div>
        <div class="toolbar no-print">
          <button type="button" data-action="print">Print / Save as PDF</button>
          <button type="button" data-action="expand">Expand all</button>
        </div>
      </header>`,
      bundle.kind === 'execution' && !standalone ? html`<h1>${bundle.title}</h1>` : '',
      renderClusterHeader(bundle),
      renderRunHeader(bundle),
      isRun && bundle.cases.length ? html`<h2 class="section-title">Failures in detail</h2>` : '',
      ...bundle.cases.map((c, i) =>
        renderCase(c, opts, {
          standalone,
          label: bundle.cases.length > 1 ? `${caseWord} ${i + 1} of ${bundle.cases.length}` : undefined,
          withoutRun: isRun,
        }),
      ),
      isRun && bundle.truncatedCases.length
        ? details(
            `Other failing tests (${bundle.truncatedCases.length}, evidence not included)`,
            html`<ul>
              ${bundle.truncatedCases.map((t) => html`<li>${t.title} <span class="meta">${[t.filePath, t.browser].filter(Boolean).join(' · ')}</span></li>`)}
            </ul>`,
          )
        : '',
      bundle.cases.length === 0 && !isRun ? html`<p class="note">No executions were included in this export.</p>` : '',
      renderOmissions(bundle),
      html`<p class="foot">Self-contained, no network connection required.</p>`,
      raw(piwiCreditHtml('Generated by Piwi')),
      raw('</div>'),
      raw(`<script>${SCRIPT}</script>`),
    ],
    '\n',
  );

  return `<!DOCTYPE html><html lang="en"><head>${toHtmlString(head)}</head><body>${toHtmlString(body)}</body></html>`;
}
