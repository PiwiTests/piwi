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
 * Color is carried by text and borders, never by a fill behind text, so a
 * printer with background graphics turned off loses decoration but no meaning.
 */
import { markdownToHtml } from '#shared/markdown-to-html';
import { html, joinHtml, raw, toHtmlString, type RawHtml } from './html';
import { stripAnsi } from '#shared/error-fingerprint';
import { highlightCode, highlightLines, languageForPath } from '#shared/highlight';
import { parseSourceSnippet } from '#shared/source-snippet';
import {
  caseFacts,
  clusterFacts,
  diagnosisFacts,
  fmtBytes,
  fmtDuration,
  hasDiagnosis,
  OMISSION_REASONS,
  projectLabel,
  type Fact,
} from './fields';
import { piwiCreditHtml } from '#shared/brand';
import { STATUS_COLORS as C } from '#shared/status-colors';
import type { ExportAsset, ExportBundle, ExportCase } from './types';

interface RenderOptions {
  /** Resolves an asset to a URL usable from the rendered document, or null to omit it. */
  assetUrl: (asset: ExportAsset) => string | null;
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg:#fff; --fg:#1c1c20; --muted:#6b6b76; --faint:#8b8b96;
  --line:#e2e2e7; --line-strong:#c9c9d2; --card:#fafafa; --sunken:#f5f5f8;
  --accent:#4338ca; --fail:${C.failed.text}; --pass:${C.passed.text}; --warn:${C.didnotrun.text}; --info:#1d4ed8; --skip:${C.skipped.text};
  --tok-key:#7c3aed; --tok-str:#0f766e; --tok-num:#b45309; --tok-fn:#1d4ed8; --tok-attr:#a21caf; --tok-builtin:#0369a1;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#161619; --fg:#ececf1; --muted:#a0a0ad; --faint:#7e7e8c;
    --line:#2f2f36; --line-strong:#43434d; --card:#1d1d21; --sunken:#131316;
    --accent:#a5b4fc; --fail:${C.failed.textDark}; --pass:${C.passed.textDark}; --warn:${C.didnotrun.textDark}; --info:#93c5fd; --skip:${C.skipped.textDark};
    --tok-key:#c4b5fd; --tok-str:#5eead4; --tok-num:#fcd34d; --tok-fn:#93c5fd; --tok-attr:#f0abfc; --tok-builtin:#7dd3fc;
  }
}
* { box-sizing:border-box; }
body {
  margin:0; padding:0 1rem 3rem; background:var(--bg); color:var(--fg);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
}
.wrap { max-width:62rem; margin:0 auto; }

header.doc { padding:1.5rem 0 .75rem; border-bottom:2px solid var(--line-strong); }
.eyebrow { font-size:.7rem; letter-spacing:.09em; text-transform:uppercase; color:var(--accent); font-weight:650; margin:0; }
h1 { font-size:1.45rem; line-height:1.25; margin:.2rem 0 .3rem; overflow-wrap:anywhere; }
h2 { font-size:1.05rem; line-height:1.3; margin:0 0 .15rem; overflow-wrap:anywhere; }
.meta { color:var(--muted); font-size:.78rem; margin:.15rem 0; }
.meta code { font-family:var(--mono); overflow-wrap:anywhere; }
.toolbar { display:flex; gap:.4rem; margin-top:.7rem; }
button {
  font:inherit; font-size:.78rem; padding:.3rem .7rem; border:1px solid var(--line-strong);
  border-radius:5px; background:var(--card); color:var(--fg); cursor:pointer;
}
button:hover { border-color:var(--accent); color:var(--accent); }

section.case { padding-top:1rem; }
section.case + section.case { border-top:1px solid var(--line); margin-top:1.2rem; }

dl.facts {
  display:grid; grid-template-columns:repeat(auto-fill,minmax(10.5rem,1fr));
  gap:.4rem .9rem; margin:.7rem 0;
}
dl.facts > div { min-width:0; border-left:2px solid var(--line); padding-left:.5rem; }
dl.facts dt { font-size:.66rem; letter-spacing:.05em; text-transform:uppercase; color:var(--faint); }
dl.facts dd { margin:0; font-size:.82rem; overflow-wrap:anywhere; }

details.card {
  border:1px solid var(--line); border-left:3px solid var(--line-strong);
  border-radius:5px; margin:.5rem 0; background:var(--card); overflow:hidden;
}
details.card.k-error { border-left-color:var(--fail); }
details.card.k-diagnosis { border-left-color:var(--accent); }
details.card.k-evidence { border-left-color:var(--info); }
details > summary {
  cursor:pointer; padding:.4rem .65rem; font-weight:600; font-size:.85rem;
  list-style:none; display:flex; justify-content:space-between; gap:1rem; align-items:center;
}
details > summary:hover { color:var(--accent); }
details > summary::-webkit-details-marker { display:none; }
details > summary::after { content:'+'; color:var(--faint); font-weight:400; font-size:.95rem; }
details[open] > summary::after { content:'\\2013'; }
details[open] > summary { border-bottom:1px solid var(--line); }
.body { padding:.55rem .65rem .65rem; }
.body > :first-child { margin-top:0; }
.body > :last-child { margin-bottom:0; }
h3 { font-size:.7rem; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); margin:.8rem 0 .25rem; }

pre {
  background:var(--sunken); border:1px solid var(--line); border-radius:4px;
  padding:.5rem .6rem; margin:.35rem 0; overflow-x:auto;
  font:12px/1.5 var(--mono); white-space:pre-wrap; overflow-wrap:anywhere;
}
code { font-family:var(--mono); font-size:.92em; }
pre.hljs { position:relative; }
pre.hljs[data-lang]:not([data-lang=""])::before {
  content:attr(data-lang); position:absolute; top:0; right:.4rem;
  font-size:.6rem; letter-spacing:.06em; text-transform:uppercase; color:var(--faint);
}

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
p { margin:.4rem 0; }
ul { margin:.35rem 0; padding-left:1.1rem; }
li { margin:.1rem 0; }
blockquote { margin:.4rem 0; padding-left:.6rem; border-left:2px solid var(--line-strong); color:var(--muted); }

.shots { display:flex; flex-wrap:wrap; gap:.5rem; }
figure { margin:.35rem 0; flex:1 1 18rem; min-width:0; }
img.shot, video { max-width:100%; height:auto; border:1px solid var(--line); border-radius:4px; display:block; }
figcaption { font-size:.7rem; color:var(--faint); margin-top:.2rem; overflow-wrap:anywhere; }

.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.78rem; }
th, td { text-align:left; padding:.25rem .45rem; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; }
th { font-size:.66rem; letter-spacing:.05em; text-transform:uppercase; color:var(--faint); font-weight:650; white-space:nowrap; }
tbody tr:last-child td { border-bottom:0; }
td.num { font-family:var(--mono); white-space:nowrap; }

.badge {
  display:inline-block; padding:0 .4rem; border-radius:3px; font-size:.7rem;
  font-weight:650; border:1px solid currentColor; vertical-align:.15em;
}
/* Matches getStatusColor in app/utils: timed-out and interrupted read as failed, didn't run as a warning. */
.s-failed, .s-timedout, .s-interrupted, .s-error, .s-open { color:var(--fail); }
.s-passed, .s-resolved { color:var(--pass); }
.s-skipped, .s-log, .s-debug, .s-ignored { color:var(--skip); }
.s-didnotrun, .s-warning, .s-warn { color:var(--warn); }
.s-info { color:var(--info); }
.tag { font-weight:650; }

.note { border-left:3px solid var(--accent); padding:.35rem .6rem; margin:.7rem 0; font-size:.82rem; background:var(--card); }

@media (max-width:30rem) {
  body { padding:0 .6rem 2.5rem; }
  dl.facts { grid-template-columns:repeat(auto-fill,minmax(8rem,1fr)); }
}

@media print {
  :root {
    --bg:#fff; --fg:#000; --muted:#3f3f46; --faint:#52525b;
    --line:#b8b8bf; --line-strong:#71717a; --card:transparent; --sunken:transparent;
    --accent:#3730a3; --fail:${C.failed.print}; --pass:${C.passed.print}; --warn:${C.didnotrun.print}; --info:#1e40af;
    --tok-key:#5b21b6; --tok-str:#115e59; --tok-num:#92400e; --tok-fn:#1e3a8a; --tok-attr:#86198f; --tok-builtin:#075985;
  }
  body { padding:0; font-size:10.5pt; }
  .no-print { display:none !important; }
  details.card, pre, .note, button { background:transparent !important; }
  /* Fold markers mean nothing on paper; the [open] selector outranks a bare one. */
  details > summary::after, details[open] > summary::after { content:''; }
  details { break-inside:avoid; }
  section.case { break-before:page; border-top:0; }
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
        html`<div>
          <dt>${k}</dt>
          <dd>${String(v)}</dd>
        </div>`,
    )}
  </dl>`;
}

function details(title: string, inner: RawHtml | string, kind = 'data', open = false): RawHtml {
  const body = toHtmlString(inner);
  if (!body.trim()) return raw('');
  return html`<details class="card k-${kind}" ${open ? raw('open') : ''}>
    <summary>${title}</summary>
    <div class="body">${raw(body)}</div>
  </details>`;
}

/** Plain block — stack traces and logs are not source code. */
function pre(text: string): RawHtml {
  return html`<pre>${stripAnsi(text)}</pre>`;
}

/**
 * A source block, syntax-highlighted. highlight.js escapes the code itself, so
 * its output is markup we can pass through.
 */
function code(text: string, lang: string): RawHtml {
  const { html: highlighted, language } = highlightCode(stripAnsi(text), lang);
  return html`<pre class="hljs" data-lang="${language || lang}"><code>${raw(highlighted)}</code></pre>`;
}

/** A captured source snippet: the line-number gutter kept plain, the code syntax-highlighted. */
function snippet(text: string, file: string): RawHtml {
  const rows = parseSourceSnippet(stripAnsi(text));
  const lang = languageForPath(file);
  const code = highlightLines(
    rows.map((row) => row.code),
    lang,
  );
  const lines = rows.map((row, i) => toHtmlString(html`<span class="ln">${row.gutter}</span>${raw(code[i] ?? '')}`));
  return html`<pre class="hljs" data-lang="${lang ?? ''}"><code>${raw(lines.join('\n'))}</code></pre>`;
}

/** AI prose is Markdown; links are flattened so the document stays self-contained. */
function prose(markdown: string): RawHtml {
  return raw(markdownToHtml(markdown, { linkMode: 'text' }));
}

function renderDiagnosis(diagnosis: Record<string, any> | null): RawHtml {
  if (!hasDiagnosis(diagnosis)) return raw('');
  const d = diagnosis as Record<string, any>;
  const det = (d.details ?? {}) as Record<string, any>;
  const parts: (RawHtml | string)[] = [facts(diagnosisFacts(d))];

  if (d.summary) parts.push(html`<p><strong>${String(d.summary)}</strong></p>`);
  if (d.rootCause) parts.push(html`<p><span class="tag">Root cause:</span> ${String(d.rootCause)}</p>`);

  const evidence = (det.evidence ?? []) as unknown[];
  if (evidence.length) {
    parts.push(html`<h3>Evidence</h3>
      <ul>
        ${evidence.map((e) => html`<li>${String(e)}</li>`)}
      </ul>`);
  }

  const fix = (det.suggestedFix ?? null) as Record<string, any> | null;
  if (fix) {
    parts.push(html`<h3>Suggested fix</h3>`);
    if (fix.description) parts.push(prose(String(fix.description)));
    if (fix.patch) parts.push(code(String(fix.patch), 'diff'));
    else if (fix.code) parts.push(code(String(fix.code), 'typescript'));
  }

  return details('AI diagnosis', joinHtml(parts, '\n'), 'diagnosis', true);
}

function renderAssets(exportCase: ExportCase, assetUrl: RenderOptions['assetUrl']): RawHtml {
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
    (a, url) => html`<figure>
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
    (a, url) => html`<figure>
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

  return joinHtml(out, '\n');
}

function renderSteps(steps: unknown): RawHtml {
  if (!Array.isArray(steps) || !steps.length) return raw('');
  const rows = (steps as Record<string, any>[]).map(
    (step) => html`<tr>
      <td>${String(step.title ?? '')}</td>
      <td>${String(step.category ?? '')}</td>
      <td class="num">${fmtDuration(step.duration)}</td>
    </tr>`,
  );
  return html`<div class="scroll">
    <table>
      <thead>
        <tr>
          <th>Step</th>
          <th>Category</th>
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
    (l) => html`<tr>
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
    (r) => html`<tr>
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

function renderCase(exportCase: ExportCase, opts: RenderOptions, index: number, total: number): RawHtml {
  const d = exportCase.detail as Record<string, any>;
  const parts: (RawHtml | string)[] = [];

  parts.push(html`<header>
    ${total > 1 ? html`<p class="eyebrow">Case ${index + 1} of ${total}</p>` : ''}
    <h2>
      ${exportCase.title}
      <span class="badge ${statusClass(exportCase.status)}">${exportCase.status}</span>
    </h2>
    <p class="meta"><code>${exportCase.location ?? exportCase.filePath ?? ''}</code></p>
  </header>`);

  parts.push(facts(caseFacts(exportCase)));

  if (d.error) parts.push(details('Error', pre(String(d.error)), 'error', true));
  parts.push(renderDiagnosis(exportCase.diagnosis));

  const assetsHtml = renderAssets(exportCase, opts.assetUrl);
  if (toHtmlString(assetsHtml).trim()) parts.push(details('Evidence', assetsHtml, 'evidence', true));

  parts.push(details('Steps', renderSteps(d.steps)));
  parts.push(details('Console', renderConsole(d.consoleLogs)));
  parts.push(details('Network', renderNetwork(d.networkRequests)));
  if (d.testSource) parts.push(details('Test source', code(String(d.testSource), 'typescript')));
  if (Array.isArray(d.testSourceFrames) && d.testSourceFrames.length) {
    parts.push(
      details(
        'Call stack',
        joinHtml(
          (d.testSourceFrames as Record<string, any>[]).map(
            (f) =>
              html`<h3>${`${f.file ?? ''}:${f.line ?? ''}`}</h3>
                ${snippet(String(f.snippet ?? ''), String(f.file ?? ''))}`,
          ),
        ),
      ),
    );
  }
  if (d.ariaSnapshot) parts.push(details('ARIA snapshot', code(String(d.ariaSnapshot), 'yaml')));
  if (d.pageState) parts.push(details('Page state', code(JSON.stringify(d.pageState, null, 2), 'json')));
  if (d.webVitals) parts.push(details('Web vitals', code(JSON.stringify(d.webVitals, null, 2), 'json')));

  return html`<section class="case">${joinHtml(parts, '\n')}</section>`;
}

function renderClusterHeader(bundle: ExportBundle): RawHtml {
  const c = bundle.cluster as Record<string, any> | null;
  if (!c) return raw('');
  const parts: (RawHtml | string)[] = [facts(clusterFacts(c))];

  if (c.sampleError) parts.push(details('Representative error', pre(String(c.sampleError)), 'error', true));
  parts.push(renderDiagnosis((c.diagnosis ?? null) as Record<string, any> | null));

  if (bundle.truncatedCases.length) {
    parts.push(
      details(
        `Other affected tests (${bundle.truncatedCases.length}, evidence not included)`,
        html`<ul>
          ${bundle.truncatedCases.map((t) => html`<li>${t.title} <span class="meta">${t.filePath ?? ''}</span></li>`)}
        </ul>`,
      ),
    );
  }
  return joinHtml(parts, '\n');
}

function renderOmissions(bundle: ExportBundle): RawHtml {
  if (!bundle.omitted.length) return raw('');
  const rows = bundle.omitted.map(
    (o) => html`<tr>
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
    'data',
    true,
  );
}

export function renderExportHtml(bundle: ExportBundle, opts: RenderOptions): string {
  const kindLabel = bundle.kind === 'cluster' ? 'Failure cluster' : 'Test execution';
  const label = projectLabel(bundle);
  const clusterStatus = (bundle.cluster as Record<string, any> | null)?.status;

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

  const body = joinHtml(
    [
      raw('<div class="wrap">'),
      html`<header class="doc">
        <p class="eyebrow">${kindLabel}${label ? ` · ${label}` : ''}</p>
        <h1>
          ${bundle.title}
          ${clusterStatus ? html`<span class="badge ${statusClass(clusterStatus)}">${clusterStatus}</span>` : ''}
        </h1>
        <p class="meta">Exported ${bundle.generatedAt}${bundle.piwiVersion ? ` · Piwi ${bundle.piwiVersion}` : ''}</p>
        ${bundle.sourceUrl ? html`<p class="meta"><code>${bundle.sourceUrl}</code></p>` : ''}
        <div class="toolbar no-print">
          <button type="button" data-action="print">Print / Save as PDF</button>
          <button type="button" data-action="expand">Expand all</button>
        </div>
      </header>`,
      renderClusterHeader(bundle),
      ...bundle.cases.map((c, i) => renderCase(c, opts, i, bundle.cases.length)),
      bundle.cases.length === 0 ? html`<p class="note">No executions were included in this export.</p>` : '',
      renderOmissions(bundle),
      html`<p class="meta">Self-contained, no network connection required.</p>`,
      raw(piwiCreditHtml('Generated by Piwi')),
      raw('</div>'),
      raw(`<script>${SCRIPT}</script>`),
    ],
    '\n',
  );

  return `<!DOCTYPE html><html lang="en"><head>${toHtmlString(head)}</head><body>${toHtmlString(body)}</body></html>`;
}
