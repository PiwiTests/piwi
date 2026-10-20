/**
 * The extension's icons: outline glyphs on a 24 × 24 grid, drawn with the
 * text's color (`currentColor`), built as DOM so no page's policy can block
 * them. Every surface takes its icons from here: the in-page panels, the
 * settings, the DevTools pages and the popup's script.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A path drawn with the stroke, or `{ fill }` for a shape filled with the text's color. */
type IconPart = string | { fill: string };

const CIRCLE = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

export const ICONS = {
  // Edit and move things around.
  copy: [
    'M9 8.25h10a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5V9.75A1.5 1.5 0 0 1 9 8.25z',
    'M16.5 8.25V4.75A1.5 1.5 0 0 0 15 3.25H5A1.5 1.5 0 0 0 3.5 4.75v9.5A1.5 1.5 0 0 0 5 15.75h2.5',
  ],
  check: ['M5 12.25l4.5 4.5L19 7.25'],
  close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: [
    'M4 7h16',
    'M10 11v6',
    'M14 11v6',
    'M6 7l1 12.5A1.5 1.5 0 008.5 21h7a1.5 1.5 0 001.5-1.5L18 7',
    'M9 7V4.5A1.5 1.5 0 0110.5 3h3A1.5 1.5 0 0115 4.5V7',
  ],
  download: ['M12 4.25v11', 'M7.5 10.75L12 15.25l4.5-4.5', 'M5 19.75h14'],
  upload: ['M12 15.25V4.25', 'M7.5 8.75L12 4.25l4.5 4.5', 'M5 19.75h14'],
  file: ['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M14 3v5h5'],
  folder: [
    'M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2h8A1.5 1.5 0 0 1 20.5 8.5v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17.5z',
  ],
  paste: [
    'M9 4.5H6.5A1.5 1.5 0 005 6v13.5A1.5 1.5 0 006.5 21h11a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H15',
    'M9 3h6v3H9z',
    'M9 11h6',
    'M9 15h4',
  ],
  save: [
    'M5.5 3.5h10.5l3.5 3.5v12a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4.5 19V5a1.5 1.5 0 0 1 1-1.5z',
    'M8.5 3.5V8h7V3.5',
    'M8 20.5V14h9v6.5',
  ],
  edit: ['M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16z', 'M13.5 6.5l4 4'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 010 11H11'],
  refresh: ['M19.5 10A8 8 0 005.6 6.6L4 8.5', 'M4 4v4.5h4.5', 'M4.5 14a8 8 0 0013.9 3.4L20 15.5', 'M20 20v-4.5h-4.5'],
  wand: ['M3.5 20.5L14.5 9.5', 'M13 8l3 3', 'M17.5 3.5v3', 'M16 5h3', 'M19.5 10v2', 'M18.5 11h2', 'M9 4v2', 'M8 5h2'],
  // Play a recording or a replay.
  record: [{ fill: CIRCLE(12, 12, 6) }],
  play: ['M7.5 5.5v13l10-6.5z'],
  pause: ['M8.5 5.5v13', 'M15.5 5.5v13'],
  stop: ['M7 7h10v10H7z'],
  next: ['M5.75 5.5v13l9-6.5z', 'M18.25 5.5v13'],
  skip: ['M4 14a7.5 7.5 0 0 1 13.3-4.8L19.5 11.5', 'M20 6.5v5.5h-5.5', 'M12 17.5h0.01'],
  replay: ['M4.5 12a7.5 7.5 0 107.5-7.5 7.7 7.7 0 00-5.3 2.2L4.5 9', 'M4.5 4.5V9H9'],
  hand: [
    'M8.25 13.25V5.75a1.5 1.5 0 0 1 3 0V11.25',
    'M11.25 10.75V4.25a1.5 1.5 0 0 1 3 0v6.5',
    'M14.25 10.75V5.75a1.5 1.5 0 0 1 3 0V13.25',
    'M17.25 9.75a1.5 1.5 0 0 1 3 0V14.25a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L4.25 14.85a1.6 1.6 0 0 1 2.5-2L8.25 14.75',
  ],
  flag: ['M6 20.5V3.5', 'M6 4h12l-2.5 4 2.5 4H6'],
  // Pick, look and check.
  pick: [CIRCLE(12, 12, 6.5), 'M12 2v3.5', 'M12 18.5V22', 'M2 12h3.5', 'M18.5 12H22'],
  pointer: ['M5 4.25l13.5 6.5-5.8 1.9-1.9 5.8z', 'M13 13.75l6 6'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', CIRCLE(12, 12, 3)],
  'eye-off': [
    'M10.6 5.6A9.6 9.6 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 01-2.6 3.4',
    'M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 005-1.5',
    'M9.9 9.9a3 3 0 004.2 4.2',
    'M3.5 3.5l17 17',
  ],
  search: [CIRCLE(10.75, 10.75, 6.5), 'M19.75 19.75l-4.3-4.3'],
  missing: [CIRCLE(10.75, 10.75, 6.5), 'M19.75 19.75l-4.3-4.3', 'M8.35 8.35l4.8 4.8', 'M13.15 8.35l-4.8 4.8'],
  'check-circle': [CIRCLE(12, 12, 8.5), 'M8 12.2l2.8 2.8L16 9'],
  'x-circle': [CIRCLE(12, 12, 8.5), 'M9 9l6 6', 'M15 9l-6 6'],
  alert: ['M12 3.75l9 16.5H3z', 'M12 10.25v4', 'M12 17.25h0.01'],
  info: [CIRCLE(12, 12, 8.5), 'M12 11v5', 'M12 8h.01'],
  camera: [
    'M4 8.75A1.5 1.5 0 0 1 5.5 7.25h2.3l1.7-2.5h5L16.2 7.25h2.3A1.5 1.5 0 0 1 20 8.75v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.75z',
    CIRCLE(12, 12.75, 3.3),
  ],
  globe: [
    CIRCLE(12, 12, 8.5),
    'M3.5 12h17',
    'M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z',
  ],
  list: ['M8.75 6.5h11', 'M8.75 12h11', 'M8.75 17.5h11', 'M4.25 6.5h0.01', 'M4.25 12h0.01', 'M4.25 17.5h0.01'],
  layers: ['M3 3.5h18v5H3z', 'M3 12h18v5H3z', 'M7 20.5h10'],
  sparkles: [
    'M10.5 3l1.9 5.1L17.5 10l-5.1 1.9L10.5 17l-1.9-5.1L3.5 10l5.1-1.9z',
    'M17.5 15l0.8 2.2L20.5 18l-2.2 0.8L17.5 21l-0.8-2.2L14.5 18l2.2-0.8z',
  ],
  tested: ['M3 3h8v8H3z', 'M5.3 7.2l1.5 1.5 2.7-3', 'M15 3h6v6', 'M9 21H3v-6', 'M13 13h8v8h-8z'],
  bug: [
    'M7.5 11.25a4.5 4.5 0 0 1 9 0V14.75a4.5 4.5 0 0 1-9 0z',
    'M9.5 7.25a2.5 2.5 0 0 1 5 0',
    'M12 10.75v8.5',
    'M7.5 11.75H4',
    'M20 11.75h-3.5',
    'M7.8 16.25l-3 2',
    'M16.2 16.25l3 2',
    'M7.8 8.75l-2.5-2',
    'M16.2 8.75l2.5-2',
  ],
  // Code, editors and other programs.
  code: ['M8.5 7l-5 5 5 5', 'M15.5 7l5 5-5 5'],
  terminal: ['M3.5 5h17v14h-17z', 'M7.5 10l2.5 2-2.5 2', 'M12 14.5h4.5'],
  send: ['M20.75 3.25L10.25 13.75', 'M20.75 3.25L14.25 20.75l-4-7-7-4z'],
  share: [
    'M12 3.75V15.25',
    'M7.5 8.25L12 3.75 16.5 8.25',
    'M5 12.75v6A1.5 1.5 0 0 0 6.5 20.25h11a1.5 1.5 0 0 0 1.5-1.5v-6',
  ],
  external: [
    'M14 4h6v6',
    'M20 4l-9 9',
    'M18 14v4.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10',
  ],
  link: ['M10 14a4 4 0 005.7 0l3-3A4 4 0 0013 5.3l-1 1', 'M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1'],
  unlink: ['M15.5 13l3-3A4 4 0 0012.8 4.3L11.5 5.6', 'M8.5 11l-3 3a4 4 0 005.7 5.7l1.3-1.3', 'M4 4l16 16'],
  plug: ['M9 3v4.5', 'M15 3v4.5', 'M6.5 7.5h11V11a5.5 5.5 0 01-11 0z', 'M12 16.5V21'],
  login: [
    'M10.25 16.5l4.5-4.5L10.25 7.5',
    'M14.75 12H3.75',
    'M14.75 3.5h4a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-4',
  ],
  settings: [
    CIRCLE(12, 12, 3),
    'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 005 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
  ],
  monitor: ['M3.5 4.25h17v11.5h-17z', 'M8 19.75h8', 'M12 15.75v4'],
  viewport: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  lock: ['M6 10.75h12v9H6z', 'M8.5 10.75V7.75a3.5 3.5 0 0 1 7 0v3'],
  // The network.
  network: ['M7 4v16', 'M4 7l3-3 3 3', 'M17 20V4', 'M14 17l3 3 3-3'],
  gauge: ['M12 13.25l4-4.5', 'M3.5 16.25a8.5 8.5 0 1 1 17 0'],
  blocked: [CIRCLE(12, 12, 8), 'M6.5 6.5l11 11'],
  'server-error': ['M4 4.5h16v6H4z', 'M4 13.5h16v6H4z', 'M7.5 7.5h.01', 'M7.5 16.5h.01', 'M12 16.5h4.5'],
  dot: [{ fill: CIRCLE(12, 12, 3) }],
  // Directions.
  'arrow-right': ['M5 12h14', 'M13 6l6 6-6 6'],
  'arrow-left': ['M19 12H5', 'M11 6l-6 6 6 6'],
  // What a step does.
  keyboard: ['M3 6.5h18v11H3z', 'M7 10.5h.01', 'M11 10.5h.01', 'M15 10.5h.01', 'M7.5 14h9'],
  move: [
    'M12 3v18',
    'M3 12h18',
    'M9.5 5.5L12 3l2.5 2.5',
    'M9.5 18.5L12 21l2.5-2.5',
    'M5.5 9.5L3 12l2.5 2.5',
    'M18.5 9.5L21 12l-2.5 2.5',
  ],
  'check-square': ['M4 4h16v16H4z', 'M8 12.2l2.8 2.8L16 9'],
  square: ['M4 4h16v16H4z'],
  select: ['M4 5h16v14H4z', 'M9.5 10.5l2.5 2.5 2.5-2.5'],
} satisfies Record<string, readonly IconPart[]>;

export type IconName = keyof typeof ICONS;

/** How an icon is drawn: its stroke, and its filled shapes, in the text's color. */
export const ICON_CSS = `
  .piwi-icon {
    width: 16px; height: 16px; flex-shrink: 0; fill: none; stroke: currentColor;
    stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  }
  .piwi-icon .piwi-icon-fill { fill: currentColor; stroke: none; }
`;

/** The icon `name`, `aria-hidden`: the button or text beside it says what it means. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'piwi-icon');
  svg.dataset.icon = name;
  for (const part of ICONS[name] as readonly IconPart[]) {
    const path = document.createElementNS(SVG_NS, 'path');
    if (typeof part === 'string') {
      path.setAttribute('d', part);
    } else {
      path.setAttribute('d', part.fill);
      path.setAttribute('class', 'piwi-icon-fill');
    }
    svg.appendChild(path);
  }
  return svg;
}

const LABEL_CLASS = 'piwi-label';

/**
 * Puts `name`'s icon in front of what `el` says, its text moved into a label
 * span that `setLabel` and the copy feedback change without losing the icon.
 * An element that has an icon already gets this one in its place.
 */
export function withIcon<T extends HTMLElement>(el: T, name: IconName): T {
  el.querySelector(':scope > .piwi-icon')?.remove();
  const label = labelOf(el);
  if (!label) {
    const span = document.createElement('span');
    span.className = LABEL_CLASS;
    span.append(...Array.from(el.childNodes));
    if (span.textContent) el.append(span);
  }
  el.prepend(icon(name));
  return el;
}

function labelOf(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>(`:scope > .${LABEL_CLASS}`);
}

/** What `el` says, without its icon. */
export function labelText(el: HTMLElement): string {
  return (labelOf(el) ?? el).textContent ?? '';
}

/** Changes what `el` says, keeping its icon. */
export function setLabel(el: HTMLElement, text: string): void {
  const label = labelOf(el);
  if (label) {
    label.textContent = text;
    return;
  }
  const glyph = el.querySelector(':scope > .piwi-icon');
  el.textContent = text;
  if (glyph) withIcon(el, glyph.getAttribute('data-icon') as IconName);
}

/**
 * Gives each element of `root` that names an icon in `data-icon` that icon,
 * for the extension's HTML pages. Run it after `localizeDocument`, which
 * writes the elements' texts.
 */
export function decorateIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = el.dataset.icon as IconName;
    if (name in ICONS) withIcon(el, name);
  }
}
