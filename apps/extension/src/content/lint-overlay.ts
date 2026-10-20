import { formatNumber, initI18n, t, tn, tNodes, uiLanguage } from '../shared/i18n.js';
import { startTool, endTool, installEscapeToCancel, toolIsCurrent } from '../shared/tool-session.js';
import { scanForLintIssues, type LintFinding, type LintScan } from './lint-scan.js';
import { attachPanelShadow } from './panel-root.js';
import { copyWithFeedback } from '../shared/clipboard.js';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { withIcon } from '../shared/icons.js';

const HOST_ID = 'piwi-lint-overlay-host';
/** The attribute each finding suggests adding. */
const TEST_ID_ATTRIBUTE = 'data-testid';

function markdownChecklist(findings: LintFinding[]): string {
  const lines = findings.map((f) => {
    const name = f.accessibleName ? ` "${f.accessibleName}"` : '';
    return `- [ ] \`${f.element.tagName.toLowerCase()}\` (role: ${f.role}${name}) — add \`${TEST_ID_ATTRIBUTE}="${f.suggestedTestId}"\``;
  });
  return lines.join('\n');
}

/**
 * One-keystroke (from the popup) audit overlay: outlines every
 * interactive element that would score badly as a locator target right now,
 * with a suggested `data-testid` per element and a Markdown checklist export.
 * The panel opens at once and fills in when the scan, which works in slices,
 * is done. A second trigger toggles it back off, same pattern as the
 * Playwright view.
 */
function toggleLintOverlay(): void {
  const g = globalThis as any;
  if (g.__piwiLintOverlayOff) {
    g.__piwiLintOverlayOff();
    return;
  }
  // The page is claimed before it is scanned and drawn on: the tool this
  // replaces takes its surfaces with it here. `off` is set below, before
  // anything can call this teardown.
  const toolEpoch = startTool('lint-overlay', () => off());
  installEscapeToCancel();
  let closed = false;
  delete g.__piwiLintFindings;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .box {
      position: fixed; pointer-events: none; box-sizing: border-box; border: 2px dashed #ef4444;
      background: rgba(239,68,68,.14); border-radius: 4px;
      box-shadow: 0 0 0 1px rgba(255,255,255,.9), 0 0 0 3px rgba(69,10,10,.5);
    }
    ${BUTTON_CSS}
    .panel {
      position: fixed; top: 12px; right: 12px; pointer-events: auto; width: min(380px, 88vw);
      max-height: 82vh; overflow: auto; background: #111827; color: #f9fafb; border-radius: 12px;
      padding: 14px; box-shadow: 0 8px 40px rgba(0,0,0,.5); font: 13px ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    @media (prefers-color-scheme: light) {
      .panel { background: #ffffff; color: #111827; box-shadow: 0 8px 40px rgba(0,0,0,.2); }
    }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .title {
      display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 13.5px; line-height: 18px; min-width: 0;
      overflow-wrap: anywhere; hyphens: auto;
    }
    .title[data-state="found"] > .piwi-icon { color: #f87171; }
    .title[data-state="none"] > .piwi-icon { color: #34d399; }
    .title[data-state="checking"] > .piwi-icon { color: #a78bfa; }
    .empty, .notice { color: #9ca3af; font-size: 12.5px; overflow-wrap: anywhere; hyphens: auto; }
    .notice { margin-bottom: 8px; }
    .export { width: 100%; margin-bottom: 10px; }
    .row {
      display: flex; flex-direction: column; gap: 6px;
      border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 8px 10px; margin-bottom: 7px; font-size: 12px;
    }
    .row .head { overflow-wrap: anywhere; }
    .row .tag { color: #f87171; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
    .row .name { color: #9ca3af; overflow-wrap: anywhere; }
    .row .name .role { color: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .row .name .named { color: #f9fafb; font-weight: 600; }
    .row .fix { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .row code {
      flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all;
      cursor: pointer; border: 1px dashed rgba(128,128,128,.45); border-radius: 6px; padding: 3px 7px;
      background: rgba(148,163,184,.08);
    }
    .row code:hover { border-style: solid; }
    .row code .attr { color: #93c5fd; }
    .row code .value { color: #86efac; }
    @media (prefers-color-scheme: light) {
      .empty, .notice, .row .name { color: #6b7280; }
      .row .tag { color: #b91c1c; }
      .row .name .named { color: #111827; }
      .row code .attr { color: #1d4ed8; }
      .row code .value { color: #15803d; }
      .title[data-state="found"] > .piwi-icon { color: #dc2626; }
      .title[data-state="none"] > .piwi-icon { color: #059669; }
      .title[data-state="checking"] > .piwi-icon { color: #6d28d9; }
    }
  `;
  root.appendChild(style);

  // The boxes sit under the panel.
  const layer = document.createElement('div');
  root.appendChild(layer);

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.lang = uiLanguage();
  panel.setAttribute('aria-label', t('lint_dialog'));

  const header = document.createElement('div');
  header.className = 'header';
  const title = document.createElement('div');
  title.className = 'title';
  title.dataset.state = 'checking';
  title.textContent = t('lint_checking');
  withIcon(title, 'search');
  const closeBtn = makeButton(t('lint_close'), () => off(), {
    icon: 'close',
    iconOnly: true,
    tone: 'ghost',
    className: 'close',
  });
  header.append(title, closeBtn);
  panel.appendChild(header);
  root.appendChild(panel);

  let findings: LintFinding[] = [];

  const showFindings = (scan: LintScan) => {
    title.textContent = findings.length === 0 ? t('lint_none') : tn('lint_found', findings.length);
    title.dataset.state = findings.length === 0 ? 'none' : 'found';
    withIcon(title, findings.length === 0 ? 'check-circle' : 'alert');
    if (scan.checked < scan.interactive) {
      const notice = document.createElement('div');
      notice.className = 'notice';
      notice.textContent = t('lint_truncated', {
        checked: formatNumber(scan.checked),
        total: formatNumber(scan.interactive),
      });
      panel.appendChild(notice);
    }

    if (findings.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = t('lint_allGood');
      panel.appendChild(empty);
      return;
    }
    const exportBtn = makeButton(
      t('lint_copyChecklist'),
      () => void copyWithFeedback(markdownChecklist(findings), exportBtn),
      { icon: 'list', tone: 'primary', className: 'export' },
    );
    panel.appendChild(exportBtn);

    for (const f of findings) {
      const row = document.createElement('div');
      row.className = 'row';
      const head = document.createElement('div');
      head.className = 'head';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `<${f.element.tagName.toLowerCase()}>`;
      const name = document.createElement('span');
      name.className = 'name';
      const role = document.createElement('span');
      role.className = 'role';
      role.textContent = f.role;
      if (f.accessibleName) {
        const named = document.createElement('span');
        named.className = 'named';
        named.textContent = f.accessibleName;
        name.append(...tNodes('lint_roleNamed', { role, name: named }));
      } else {
        name.append(...tNodes('lint_role', { role }));
      }
      head.append(tag, ' ', name);
      const attribute = `${TEST_ID_ATTRIBUTE}="${f.suggestedTestId}"`;
      const fix = document.createElement('div');
      fix.className = 'fix';
      const code = document.createElement('code');
      const attr = document.createElement('span');
      attr.className = 'attr';
      attr.textContent = TEST_ID_ATTRIBUTE;
      const value = document.createElement('span');
      value.className = 'value';
      value.textContent = `"${f.suggestedTestId}"`;
      code.append(attr, '=', value);
      code.title = t('common_clickToCopy');
      const copy = makeButton(t('common_copy'), () => void copyWithFeedback(attribute, copy), {
        icon: 'copy',
        small: true,
      });
      code.addEventListener('click', () => void copyWithFeedback(attribute, copy));
      fix.append(code, copy);
      row.append(head, fix);
      panel.appendChild(row);
    }
  };

  const boxes: HTMLDivElement[] = [];
  /** Every element's box is read before any outline moves, so the page lays out once per draw. */
  const drawBoxes = () => {
    const rects = findings.map((f) => f.element.getBoundingClientRect());
    while (boxes.length < rects.length) {
      const box = document.createElement('div');
      box.className = 'box';
      layer.appendChild(box);
      boxes.push(box);
    }
    rects.forEach((r, i) => {
      boxes[i]!.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    });
  };
  let frame = 0;
  const reposition = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawBoxes();
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      off();
    }
  };

  const off = () => {
    closed = true;
    cancelAnimationFrame(frame);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition, true);
    host.remove();
    delete g.__piwiLintOverlayOff;
    endTool(toolEpoch);
  };
  g.__piwiLintOverlayOff = off;
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition, true);

  void scanForLintIssues({ keepGoing: () => !closed && toolIsCurrent(toolEpoch) }).then((scan) => {
    if (!scan || closed || !toolIsCurrent(toolEpoch)) return;
    findings = scan.findings;
    // Exposed for lint-scan.spec.ts: scanForLintIssues calls @piwitests/core's
    // generateAlternatives, which has its own private module-level helpers
    // that Function.prototype.toString() reconstruction (the trick
    // derivePattern's own tests use) can't carry along —
    // real bundling is the only way to exercise it correctly, so results are
    // bridged out here the same way picker state is bridged through other
    // well-known globals elsewhere in this extension.
    g.__piwiLintFindings = findings.map((f) => ({
      tag: f.element.tagName.toLowerCase(),
      role: f.role,
      accessibleName: f.accessibleName,
      suggestedTestId: f.suggestedTestId,
      bestScore: f.bestScore,
    }));
    showFindings(scan);
    drawBoxes();
  });
}

void initI18n().then(toggleLintOverlay);
