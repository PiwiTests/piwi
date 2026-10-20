/** Small pieces the DevTools pages share: buttons, empty states and their icons. */

import { makeButton, type ButtonOptions } from '../shared/buttons.js';
import { tNodes } from '../shared/i18n.js';
import { icon, iconText, type IconName } from '../shared/icons.js';
import { patternView } from '../shared/pattern-view.js';

export type { IconName };

/**
 * A button of the DevTools pages: the shared button, with its icon and its
 * tone (`ButtonTone`), drawn in DevTools' compact look by `devtools.css`.
 */
export function button(label: string, onClick: () => void, options: ButtonOptions = {}): HTMLButtonElement {
  return makeButton(label, onClick, options);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** A centered message for an area with nothing to show yet, with an icon and, when given, what to do. */
export function emptyState(
  name: IconName,
  text: string | Array<Node | string>,
  ...actions: HTMLElement[]
): HTMLElement {
  const box = el('div', 'empty');
  const message = el('p');
  message.append(...(typeof text === 'string' ? [text] : text));
  box.append(icon(name), message, ...actions);
  return box;
}

/** Piwi Picker needs access to this site, the site on its chip: the text of an empty state with Allow on this site. */
export function noAccessText(origin: string): Array<Node | string> {
  return tNodes('devtools_noAccess', { site: patternView(origin) });
}

/** A request's method, muted for a read and in the accent color for one that changes something. */
export function methodView(method: string): HTMLElement {
  const view = el('span', 'method', method);
  view.dataset.method = method.toUpperCase();
  return view;
}

/** A line of text after an icon: a note, a warning, what a view says it waits for. */
export function iconLine(name: IconName, className: string, ...text: Array<Node | string>): HTMLElement {
  return iconText(el('p', `icon-line ${className}`.trim()), name, ...text);
}
