import { LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import { BUTTON_CSS } from '../shared/buttons.js';
import { STEP_CSS } from '../shared/step-view.js';

/**
 * Styles of the coverage overlay, scoped to its shadow root. Boxes, badges and
 * cards float over arbitrary pages, so they keep one dark look with a white
 * halo in both color schemes; the side panel is dark-first with a light-scheme
 * override, like the extension's other panels.
 */
export const COVERAGE_CSS = `
  ${LOCATOR_SYNTAX_CSS}
  ${BUTTON_CSS}
  ${STEP_CSS}
  :host { all: initial; }
  * { box-sizing: border-box; }
  .layer, .panel, .pill, .card {
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; font-size: 13px; line-height: 1.45;
  }
  .panel, .pill, .card { overflow-wrap: anywhere; hyphens: auto; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; hyphens: manual; }

  /* ── Boxes on the page ─────────────────────────────────────────────── */
  .box {
    position: fixed; pointer-events: none; border-radius: 4px; border: 2px solid transparent;
    transition: opacity 120ms ease-out;
  }
  .box.operated {
    border-color: #10b981; background: rgb(16 185 129 / calc(0.08 + var(--heat, 0) * 0.5));
    box-shadow: 0 0 0 1px rgb(255 255 255 / 0.85);
  }
  .box.checked {
    border-color: #0ea5e9; background: rgb(14 165 233 / calc(0.08 + var(--heat, 0) * 0.5));
    box-shadow: 0 0 0 1px rgb(255 255 255 / 0.85);
  }
  .box.uncovered {
    border: 2px dashed #f59e0b;
    background: repeating-linear-gradient(45deg, rgb(245 158 11 / 0.14) 0 6px, transparent 6px 12px);
    box-shadow: 0 0 0 1px rgb(255 255 255 / 0.7);
  }
  .box.ambiguous { border-style: dotted; }
  /* A brittle locator finds it: an orange corner mark, over any kind of box. */
  .box.brittle::after {
    content: '!'; position: absolute; left: -2px; top: -2px; width: 13px; height: 13px; border-radius: 3px 0 6px 0;
    background: #ea580c; color: #fff; font: 800 10px/13px ui-sans-serif, system-ui, sans-serif; text-align: center;
    box-shadow: 0 0 0 1px #fff;
  }
  .box.dim, .badge.dim { opacity: 0.15; }
  .box.strong { box-shadow: 0 0 0 2px #fff, 0 0 0 6px rgb(124 58 237 / 0.6); z-index: 2; }
  .box.hover { box-shadow: 0 0 0 2px #fff, 0 0 0 5px rgb(124 58 237 / 0.45); }
  .box.flash { animation: piwi-flash 800ms ease-out 2; z-index: 3; }
  @keyframes piwi-flash {
    0% { box-shadow: 0 0 0 2px #fff, 0 0 0 0 rgb(124 58 237 / 0.9); }
    100% { box-shadow: 0 0 0 2px #fff, 0 0 0 16px rgb(124 58 237 / 0); }
  }
  @media (prefers-reduced-motion: reduce) { .box.flash { animation: none; box-shadow: 0 0 0 3px #7c3aed; } }

  /* The element the view is limited to, and the one being chosen. */
  .frame {
    position: fixed; pointer-events: none; border-radius: 6px;
    box-shadow: 0 0 0 9999px rgb(17 24 39 / 0.28);
  }
  .frame.scope { border: 2px dashed #7c3aed; }
  .frame.choosing { border: 2px solid #7c3aed; background: rgb(124 58 237 / 0.1); box-shadow: 0 0 0 9999px rgb(17 24 39 / 0.18); }
  .frame.around { border: 2px solid #a78bfa; box-shadow: none; background: rgb(167 139 250 / 0.12); }
  .frame-tag {
    position: fixed; pointer-events: none; z-index: 4; max-width: 420px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; padding: 2px 8px; border-radius: 5px; background: #7c3aed; color: #fff;
    font: 600 11.5px/1.5 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.85);
  }

  .badge {
    position: fixed; pointer-events: auto; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;
    min-width: 20px; height: 18px; padding: 0 6px; border: 0; border-radius: 9px;
    font: 700 11px/18px ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums;
    color: #022c22; background: #34d399; box-shadow: 0 1px 4px rgb(0 0 0 / 0.45), 0 0 0 1.5px #fff;
  }
  .badge.checked { color: #082f49; background: #7dd3fc; }
  .badge:hover, .badge:focus-visible { transform: scale(1.12); outline: none; }
  .badge .dot { width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 0 1px #fff; }
  .dot.failed { background: #e11d48; }
  .dot.flaky { background: #9333ea; }
  .dot.passed { background: #10b981; }
  .dot.skipped { background: #a1a1aa; }
  .dot.unknown { background: #64748b; }

  /* ── Cards over the page (dark in both schemes) ─────────────────────── */
  .card {
    position: fixed; width: min(400px, calc(100vw - 24px)); padding: 10px 12px; border-radius: 10px;
    background: #0b1220; color: #f1f5f9; border: 1px solid rgb(148 163 184 / 0.28);
    box-shadow: 0 12px 40px rgb(0 0 0 / 0.5); font-size: 12.5px; z-index: 5;
  }
  .card.preview { pointer-events: none; }
  .card.pinned { pointer-events: auto; max-height: min(72vh, 600px); overflow: auto; }
  .card .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .card .what { font-weight: 600; font-size: 13px; word-break: break-word; }
  .card .kind { color: #94a3b8; font-size: 12px; margin-top: 1px; }
  .card .kind .operated { color: #34d399; }
  .card .kind .checked { color: #7dd3fc; }
  .card .kind .uncovered { color: #fbbf24; }
  .card .chain { margin-top: 9px; padding-top: 8px; border-top: 1px solid rgb(148 163 184 / 0.2); }
  .card .chain code { display: block; font-size: 12px; word-break: break-all; }
  .card .chain .note { color: #fbbf24; font-size: 11.5px; margin-top: 2px; }
  .card .note.stability.brittle, .card .note.brittle { color: #fb923c; font-size: 11.5px; margin-top: 2px; }
  .card .note.stability.watch { color: #cbd5e1; }
  .card .replacement { margin-top: 6px; padding: 6px 8px; border-radius: 7px; background: rgb(234 88 12 / 0.12); }
  .card .replacement .hint { margin-top: 0; }
  .card .replacement code + .hint { margin-top: 6px; }
  .card ul { list-style: none; margin: 5px 0 0; padding: 0; }
  .card li { display: grid; grid-template-columns: 10px 1fr; gap: 2px 7px; align-items: baseline; padding: 3px 0; }
  .card li .dot { width: 8px; height: 8px; border-radius: 50%; align-self: center; }
  .card li a { color: #e2e8f0; text-decoration: underline dotted; text-underline-offset: 2px; word-break: break-word; }
  .card li a:hover { text-decoration-style: solid; }
  .card li .meta { grid-column: 2; color: #94a3b8; font-size: 11.5px; overflow-wrap: anywhere; }
  .card li .meta .act { color: #cbd5e1; font-weight: 500; }
  .card li .meta .site { color: #cbd5e1; font-size: 11px; }
  .card .more { color: #94a3b8; font-size: 11.5px; margin-top: 4px; }
  .card .card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .card .hint { color: #94a3b8; font-size: 11.5px; margin-top: 6px; }
  .card .close { margin: -2px -4px 0 0; }

  /* ── Side panel ─────────────────────────────────────────────────────── */
  .panel {
    position: fixed; top: 12px; right: 12px; width: min(380px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
    display: flex; flex-direction: column; pointer-events: auto; overflow: hidden; z-index: 6;
    background: #111827; color: #f9fafb; border-radius: 12px; box-shadow: 0 8px 40px rgb(0 0 0 / 0.5);
  }
  .panel.left { right: auto; left: 12px; }
  @media (prefers-reduced-motion: no-preference) { .panel { animation: piwi-in 140ms ease-out; } }
  @keyframes piwi-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  .panel .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 12px 14px 8px; }
  .panel .title { font-weight: 650; font-size: 14px; }
  .panel .sub { color: #9ca3af; font-size: 12px; }
  .panel .sub a { color: inherit; }
  .panel .sub .project { font-weight: 600; color: #d1d5db; }
  .panel .icons { display: flex; gap: 2px; flex-shrink: 0; margin: -2px -4px 0 0; }
  .panel .body { overflow: auto; padding: 0 14px 12px; flex: 1; min-height: 0; }
  .panel .message { color: #d1d5db; font-size: 12.5px; margin: 6px 0 10px; }
  .panel .message.error { color: #fda4af; }
  .panel .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 2px 0 8px; }
  .panel .tile { border: 1px solid rgb(128 128 128 / 0.28); border-radius: 8px; padding: 6px 8px; }
  .panel .tile .n { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .panel .tile .l { color: #9ca3af; font-size: 11.5px; }
  .panel .tile.operated .n { color: #34d399; }
  .panel .tile.uncovered .n { color: #fbbf24; }
  .panel .meter { height: 6px; border-radius: 3px; background: rgb(245 158 11 / 0.35); overflow: hidden; }
  .panel .meter > span { display: block; height: 100%; background: #10b981; }
  .panel .meter-label { color: #9ca3af; font-size: 11.5px; margin: 4px 0 10px; }
  .panel .status-line { color: #9ca3af; font-size: 11.5px; margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
  .panel .branch-select {
    max-width: 100%; font: inherit; font-size: 11.5px; color: inherit; padding: 1px 4px; border-radius: 6px;
    background: rgb(128 128 128 / 0.14); border: 1px solid rgb(128 128 128 / 0.35);
  }
  .panel .branch-select option { color: #111827; }
  .panel .status-line .refresh { margin-inline-start: auto; }
  .panel .status-line .index-size { flex-basis: 100%; }
  .panel .progress { height: 3px; background: rgb(124 58 237 / 0.25); border-radius: 2px; overflow: hidden; margin: 2px 0 8px; }
  /* A transform moves the fill without laying out or painting the overlay again. */
  .panel .progress > span {
    display: block; height: 100%; background: #a78bfa; transform-origin: left; transition: transform 120ms;
    will-change: transform;
  }
  .panel .scope-bar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0 0 8px; padding: 6px 8px;
    border-radius: 8px; background: rgb(124 58 237 / 0.16); font-size: 12px;
  }
  .panel .scope-bar .what {
    flex: 1 1 160px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600;
  }
  .panel .scope-bar .scope-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
  .panel .scope-bar .keys { flex-basis: 100%; color: #c4b5fd; font-size: 11.5px; }
  .panel .scope-bar kbd { font: inherit; font-size: 11px; padding: 0 4px; border-radius: 4px; border: 1px solid rgb(128 128 128 / 0.4); }
  .panel .around { margin: -2px 0 10px; }
  .panel .around .hint { color: #9ca3af; font-size: 11.5px; margin-bottom: 2px; }
  .panel .tabs { display: flex; flex-wrap: wrap; gap: 3px; padding: 3px; border-radius: 8px; background: rgb(128 128 128 / 0.14); margin-bottom: 8px; }
  .panel .tab {
    flex: 1 1 auto; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    border: 0; background: none; color: inherit; font: inherit; font-size: 12px; line-height: 16px; padding: 4px 6px;
    white-space: nowrap;
    border-radius: 6px; cursor: pointer; opacity: 0.75;
  }
  .panel .tab:hover { opacity: 1; background: rgb(128 128 128 / 0.12); }
  .panel .tab:focus-visible { outline: 2px solid #a78bfa; outline-offset: 1px; }
  .panel .tab .piwi-icon { width: 14px; height: 14px; }
  .panel .tab[aria-pressed='true'] { background: #374151; opacity: 1; font-weight: 600; }
  .count-badge {
    display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 999px; text-align: center;
    font-size: 10.5px; font-weight: 700; line-height: 16px; font-variant-numeric: tabular-nums;
    background: rgb(148 163 184 / 0.22); color: inherit;
  }
  .count-badge.operated { background: rgb(16 185 129 / 0.22); color: #6ee7b7; }
  .count-badge.uncovered { background: rgb(245 158 11 / 0.22); color: #fcd34d; }
  .count-badge.risk { background: rgb(234 88 12 / 0.24); color: #fdba74; }
  .count-badge.missing { background: rgb(225 29 72 / 0.22); color: #fda4af; }
  .panel .search {
    width: 100%; margin-bottom: 8px; padding: 5px 8px; border-radius: 7px; font: inherit; font-size: 12.5px;
    color: inherit; background: rgb(128 128 128 / 0.12); border: 1px solid rgb(128 128 128 / 0.3);
  }
  .panel ul.rows { list-style: none; margin: 0; padding: 0; }
  .panel li.row {
    display: grid; grid-template-columns: 10px 1fr auto; gap: 1px 8px; align-items: center; padding: 6px 8px;
    border-radius: 7px; cursor: pointer;
  }
  .panel li.row:hover, .panel li.row:has(> .label:focus-visible), .panel li.row.active { background: rgb(128 128 128 / 0.16); }
  .panel li.row > .label:focus-visible { outline: none; }
  .panel li.row.focused { background: rgb(124 58 237 / 0.22); }
  .panel li.row .swatch { width: 10px; height: 10px; border-radius: 3px; }
  .swatch.operated { background: #10b981; }
  .swatch.checked { background: #0ea5e9; }
  .swatch.uncovered { background: repeating-linear-gradient(45deg, #f59e0b 0 3px, transparent 3px 6px); border: 1px solid #f59e0b; }
  .swatch.brittle { background: #ea580c; }
  .swatch.missing { background: #e11d48; }
  .panel .page-switch { display: flex; flex-wrap: wrap; gap: 3px; padding: 3px; border-radius: 8px; background: rgb(128 128 128 / 0.14); margin: 0 0 8px; }
  .panel li.row.static { cursor: default; }
  .panel .risk-section + .risk-section { margin-top: 12px; }
  .panel .section-head {
    display: flex; align-items: center; gap: 6px; margin: 0 0 2px; font-size: 12.5px; font-weight: 650; line-height: 18px;
  }
  .panel .section-head .piwi-icon { width: 14px; height: 14px; color: #fb923c; }
  .panel .section-hint { margin: 0 0 6px; color: #9ca3af; font-size: 11.5px; }
  .panel li.row code.piwi-loc.suggestion { margin-top: 2px; }
  .panel li.row .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .panel li.row .count { color: #9ca3af; font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .panel li.row .detail { grid-column: 2 / 4; color: #9ca3af; font-size: 11.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .panel li.row code.piwi-loc { grid-column: 2 / 4; font-size: 11.5px; white-space: normal; word-break: break-all; }
  .panel li.row .detail.wrap { white-space: normal; overflow: visible; }
  .panel li.row .row-actions { grid-column: 2 / 4; display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .panel li.row .row-copy { justify-self: end; }
  .panel li.row .site, .panel .detail .site { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
  .panel .empty { color: #9ca3af; font-size: 12.5px; padding: 6px 2px; }
  .panel .foot { border-top: 1px solid rgb(128 128 128 / 0.25); padding: 8px 14px 10px; display: grid; gap: 6px; }
  .panel .toggles { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; }
  .panel .toggles label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  .panel .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; color: #9ca3af; font-size: 11.5px; align-items: center; }
  .panel .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .panel .legend .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
  .panel .legend .dotted { width: 12px; height: 10px; border: 2px dotted #10b981; border-radius: 3px; display: inline-block; }
  .panel details.notes { color: #9ca3af; font-size: 11.5px; margin-top: 8px; }
  .panel details.notes summary { cursor: pointer; }
  .panel details.notes ul { margin: 4px 0 0; padding-left: 16px; }
  .panel details.notes code { font-size: 11px; word-break: break-all; color: #d1d5db; }

  .pill {
    position: fixed; bottom: 16px; right: 16px; pointer-events: auto; cursor: pointer; z-index: 6;
    display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px; border: 0;
    background: #111827; color: #f9fafb; font: 600 12.5px/1 ui-sans-serif, system-ui, sans-serif;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.45); max-width: calc(100vw - 32px); text-align: start; line-height: 1.3;
  }
  .pill.left { right: auto; left: 16px; }
  .pill .swatch { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }

  @media (prefers-color-scheme: light) {
    .panel { background: #ffffff; color: #111827; box-shadow: 0 8px 40px rgb(0 0 0 / 0.2); }
    .panel .sub, .panel .tile .l, .panel .meter-label, .panel .status-line, .panel li.row .count,
    .panel li.row .detail, .panel .empty, .panel .legend, .panel details.notes, .panel .section-hint { color: #6b7280; }
    .panel .message { color: #374151; }
    .panel .message.error { color: #be123c; }
    .panel .tile.operated .n { color: #059669; }
    .panel .tile.uncovered .n { color: #b45309; }
    .panel .tab[aria-pressed='true'] { background: #ffffff; box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
    .panel .tab:focus-visible { outline-color: #7c3aed; }
    .panel .sub .project { color: #374151; }
    .panel .section-head .piwi-icon { color: #c2410c; }
    .count-badge { background: rgb(100 116 139 / 0.16); }
    .count-badge.operated { background: rgb(16 185 129 / 0.16); color: #047857; }
    .count-badge.uncovered { background: rgb(245 158 11 / 0.18); color: #92400e; }
    .count-badge.risk { background: rgb(234 88 12 / 0.14); color: #c2410c; }
    .count-badge.missing { background: rgb(225 29 72 / 0.12); color: #be123c; }
    .panel details.notes code { color: #374151; }
    .panel li.row.focused { background: rgb(124 58 237 / 0.12); }
    .panel .scope-bar { background: rgb(124 58 237 / 0.1); }
    .panel .scope-bar .keys { color: #6d28d9; }
    .panel .around .hint { color: #6b7280; }
  }
`;
