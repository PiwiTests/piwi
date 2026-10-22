import { initI18n, t, tn, uiLanguage } from '../shared/i18n.js';
import { startTool, endTool, installEscapeToCancel } from '../shared/tool-session.js';
import { attachPanelShadow } from './panel-root.js';
import { LOCATOR_ATTRIBUTES } from './observed-attributes.js';
import { placeLabels } from './label-layout.js';
import { scanPlaywrightView, type ViewLabel } from './playwright-view-scan.js';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';

const HOST_ID = 'piwi-playwright-view-host';

/** How many labels are drawn at once: the ones in view, in page order. */
const MAX_DRAWN = 400;
/** How long the page stays still before a change to it is scanned again. */
const RESCAN_MS = 600;
/** What can change a label besides the attributes every overlay follows: what makes an element look operable. */
const OBSERVED_ATTRIBUTES = [...LOCATOR_ATTRIBUTES, 'tabindex', 'onclick'];
const NAME_CHARS = 40;

interface ViewSummary {
  tag: string;
  role: string | null;
  name: string;
  testId: string | null;
  mark: ViewLabel['mark'];
  count: number;
}

function shorten(text: string): string {
  return text.length > NAME_CHARS ? `${text.slice(0, NAME_CHARS - 1)}…` : text;
}

/** `button · Apply coupon`, `button · (no name)`, `div · (no role)`. */
function labelText(label: ViewLabel): string {
  if (!label.role) return `${label.tag} · ${t('view_noRole')}`;
  return `${label.role} · ${label.name ? shorten(label.name) : t('view_noName')}`;
}

/** A label, hidden at the top left corner until it is placed. */
function labelNode(label: ViewLabel): HTMLDivElement {
  const tag = document.createElement('div');
  tag.className = `tag ${label.mark ?? ''}`;
  tag.style.left = '0px';
  tag.style.top = '0px';
  tag.style.visibility = 'hidden';
  const roleChip = document.createElement('span');
  roleChip.className = 'role';
  roleChip.textContent = labelText(label);
  tag.appendChild(roleChip);
  if (label.testId) {
    const chip = document.createElement('span');
    chip.className = 'testid';
    chip.textContent = label.testId;
    tag.appendChild(chip);
  }
  return tag;
}

/**
 * The Playwright view: every element a test could reach, labelled with the
 * role and name `getByRole` sees and its test id, and marked when no stable
 * locator reaches it (red) or its role and name are shared (amber). Follows
 * scrolling, and scans again once the page has changed and settled. A second
 * trigger turns it off, as the lint overlay does.
 */
function togglePlaywrightView(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.__piwiPlaywrightViewOff === 'function') {
    (g.__piwiPlaywrightViewOff as () => void)();
    return;
  }
  // The page is claimed before the host is mounted: the tool this replaces
  // takes its surfaces with it here. `off` is set below, before anything can
  // call this teardown.
  const toolEpoch = startTool('playwright-view', () => off());
  installEscapeToCancel();
  let closed = false;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(host);
  const openShadow = (globalThis as { __piwiTestOpenShadow?: boolean }).__piwiTestOpenShadow === true;
  const root = attachPanelShadow(host, { mode: openShadow ? 'open' : 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .box { position: fixed; pointer-events: none; border: 1px solid rgba(124,58,237,.7); border-radius: 3px; }
    .box.unreachable { border: 2px solid #dc2626; background: rgba(220,38,38,.10); }
    .box.ambiguous { border: 2px solid #d97706; background: rgba(217,119,6,.10); }
    .tag {
      position: fixed; pointer-events: none; display: flex; gap: 3px; align-items: center; max-width: 320px;
      font-size: 10.5px; line-height: 15px; white-space: nowrap;
    }
    .tag span { padding: 0 4px; border-radius: 3px; overflow: hidden; text-overflow: ellipsis; }
    .tag .role { background: #4c1d95; color: #f5f3ff; }
    .tag.unreachable .role { background: #b91c1c; color: #fff; }
    .tag.ambiguous .role { background: #b45309; color: #fff; }
    .tag .testid { background: #0f766e; color: #f0fdfa; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    ${BUTTON_CSS}
    .panel {
      position: fixed; bottom: 12px; right: 12px; pointer-events: auto; width: min(320px, 88vw);
      background: #111827; color: #f9fafb; border-radius: 12px; padding: 10px 12px; font-size: 12.5px;
      box-shadow: 0 8px 30px rgba(0,0,0,.45);
    }
    @media (prefers-color-scheme: light) {
      .panel { background: #ffffff; color: #111827; box-shadow: 0 8px 30px rgba(0,0,0,.2); }
    }
    .header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .title { font-weight: 600; }
    .counts { margin: 8px 0 10px; display: grid; gap: 4px; }
    .counts > div { display: flex; align-items: flex-start; gap: 8px; line-height: 18px; }
    .swatch { width: 12px; height: 10px; border-radius: 3px; flex-shrink: 0; margin-top: 4px; border: 1px solid rgba(124,58,237,.9); }
    .swatch.red { border: 2px solid #dc2626; background: rgba(220,38,38,.18); }
    .swatch.amber { border: 2px solid #d97706; background: rgba(217,119,6,.18); }
    .counts .red { color: #f87171; }
    .counts .amber { color: #fbbf24; }
    @media (prefers-color-scheme: light) {
      .counts .red { color: #b91c1c; }
      .counts .amber { color: #b45309; }
    }
    .crowded { margin: -4px 0 10px; color: #9ca3af; line-height: 17px; }
    @media (prefers-color-scheme: light) {
      .crowded { color: #6b7280; }
    }
    label { display: flex; gap: 6px; align-items: center; }
    select {
      flex: 1; font: inherit; color: inherit; background: rgba(128,128,128,.12); border-radius: 6px;
      border: 1px solid rgba(128,128,128,.35); padding: 3px 6px;
    }
  `;
  root.appendChild(style);

  const layer = document.createElement('div');
  root.appendChild(layer);

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('view_title'));
  panel.lang = uiLanguage();
  const header = document.createElement('div');
  header.className = 'header';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = t('view_title');
  const closeBtn = makeButton(t('common_close'), () => off(), {
    icon: 'close',
    iconOnly: true,
    tone: 'ghost',
    small: true,
    className: 'close',
  });
  header.append(title, closeBtn);
  const counts = document.createElement('div');
  counts.className = 'counts';
  const crowdedLine = document.createElement('div');
  crowdedLine.className = 'crowded';
  crowdedLine.hidden = true;
  const filterLabel = document.createElement('label');
  const filterText = document.createElement('span');
  filterText.textContent = t('view_filterRole');
  const filter = document.createElement('select');
  filterLabel.append(filterText, filter);
  panel.append(header, counts, crowdedLine, filterLabel);
  root.appendChild(panel);

  let labels: ViewLabel[] = [];
  let role = '';

  const summarize = (): void => {
    const unreachable = labels.filter((l) => l.mark === 'unreachable').length;
    const ambiguous = labels.filter((l) => l.mark === 'ambiguous').length;
    const line = (text: string, className = '') => {
      const el = document.createElement('div');
      el.className = className;
      const swatch = document.createElement('span');
      swatch.className = `swatch ${className}`;
      const words = document.createElement('span');
      words.textContent = text;
      el.append(swatch, words);
      return el;
    };
    counts.replaceChildren(
      line(tn('view_labelled', labels.length)),
      line(tn('view_unreachable', unreachable), 'red'),
      line(tn('view_ambiguous', ambiguous), 'amber'),
    );
    const roles = [...new Set(labels.map((l) => l.role).filter((r): r is string => !!r))].sort();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = t('view_allRoles');
    const options = roles.map((r) => {
      const option = document.createElement('option');
      option.value = r;
      option.textContent = r;
      return option;
    });
    filter.replaceChildren(all, ...options);
    filter.value = roles.includes(role) ? role : '';
    const summary: ViewSummary[] = labels.map(({ tag, role: r, name, testId, mark, count }) => ({
      tag,
      role: r,
      name,
      testId,
      mark,
      count,
    }));
    // Read by the end-to-end specs.
    g.__piwiPlaywrightView = summary;
  };

  /**
   * Draws the labels of the elements in view, in page order: the boxes and the labels are added, every label's size
   * is read in one layout, then `placeLabels` moves each one clear of those before it. A label with no free place
   * near its element is left out, and the panel counts those.
   */
  const draw = (): void => {
    const shown: Array<{ label: ViewLabel; rect: DOMRect }> = [];
    const width = window.innerWidth;
    const height = window.innerHeight;
    for (const label of labels) {
      if (shown.length >= MAX_DRAWN) break;
      if (role && label.role !== role) continue;
      if (!label.element.isConnected) continue;
      const r = label.element.getBoundingClientRect();
      if (r.bottom < 0 || r.right < 0 || r.top > height || r.left > width || (r.width === 0 && r.height === 0))
        continue;
      shown.push({ label, rect: r });
    }
    const boxes = shown.map(({ label, rect: r }) => {
      const box = document.createElement('div');
      box.className = `box ${label.mark ?? ''}`;
      box.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
      return box;
    });
    const tags = shown.map(({ label }) => labelNode(label));
    layer.replaceChildren(...boxes, ...tags);
    const sizes = tags.map((tag) => tag.getBoundingClientRect());
    const places = placeLabels(
      shown.map(({ rect }, i) => ({ anchor: rect, width: sizes[i]!.width, height: sizes[i]!.height })),
      { width, height },
    );
    let crowded = 0;
    places.forEach((place, i) => {
      const tag = tags[i]!;
      if (!place) {
        tag.remove();
        crowded++;
        return;
      }
      tag.style.left = `${place.left}px`;
      tag.style.top = `${place.top}px`;
      tag.style.visibility = '';
    });
    crowdedLine.hidden = crowded === 0;
    if (crowded) crowdedLine.textContent = tn('view_crowded', crowded);
  };

  let rescanTimer: ReturnType<typeof setTimeout> | undefined;
  const rescanSoon = () => {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => void scan(), RESCAN_MS);
  };
  let scanning = false;
  /** The page changed while a scan ran: another follows it. */
  let changed = false;
  const scan = async (): Promise<void> => {
    if (scanning) {
      changed = true;
      return;
    }
    scanning = true;
    changed = false;
    const next = await scanPlaywrightView(document, { keepGoing: () => !closed });
    scanning = false;
    if (!next || closed) return;
    labels = next;
    summarize();
    draw();
    if (changed) rescanSoon();
  };

  let frame = 0;
  const redraw = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  };
  const observer = new MutationObserver((mutations) => {
    if (mutations.every((m) => m.target === host || host.contains(m.target as Node))) return;
    rescanSoon();
  });

  filter.addEventListener('change', () => {
    role = filter.value;
    draw();
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      off();
    }
  };

  const off = () => {
    closed = true;
    observer.disconnect();
    clearTimeout(rescanTimer);
    cancelAnimationFrame(frame);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', redraw, true);
    window.removeEventListener('resize', redraw, true);
    host.remove();
    delete g.__piwiPlaywrightViewOff;
    delete g.__piwiPlaywrightView;
    endTool(toolEpoch);
  };
  g.__piwiPlaywrightViewOff = off;
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', redraw, true);
  window.addEventListener('resize', redraw, true);
  void scan();
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: OBSERVED_ATTRIBUTES,
  });
}

void initI18n().then(togglePlaywrightView);
