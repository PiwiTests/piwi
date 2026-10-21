import { copyWithFeedback } from '../shared/clipboard.js';
import { downloadBlob } from '../shared/download.js';
import { formatNumber, t, tn, tNodes } from '../shared/i18n.js';
import { urlView } from '../shared/step-view.js';
import {
  mockCode,
  type MockKind,
  type MockSource,
  mockUrlPattern,
  responseBody,
  type ResponseBody,
} from '../shared/mock-code.js';
import { webOrigin } from '../shared/web-origin.js';
import { inspectedOrigin } from './inspected.js';
import { conditionActions, pageConditions, renderConditions } from './panel-conditions.js';
import { button, el, emptyState, iconLine, methodView } from './ui.js';

/**
 * The Network tab: the page's `fetch` and XHR requests (and, with **Every
 * kind**, its documents, scripts, images and the rest, which a condition can
 * slow down or fail through the debugging protocol), read from
 * `chrome.devtools.network` while DevTools is open, and Mock this response,
 * which writes a request as `page.route(...)` code. Nothing read here leaves
 * the browser but what the user copies or downloads.
 */

export interface NetworkEntry {
  id: number;
  method: string;
  url: string;
  status: number;
  mimeType: string;
  /** Milliseconds from the request to the end of the response. */
  time: number;
  /** The response body, as DevTools kept it. */
  body(): Promise<ResponseBody>;
  /** A `fetch` or XHR call, rather than a document, a script, an image… */
  api: boolean;
}

/** How many requests the tab keeps, the oldest dropped first. */
const MAX_ENTRIES = 500;

/** Resource types that are the page's API calls; Firefox names none, and a type is read from the response instead. */
const API_TYPES = new Set(['fetch', 'xhr']);
const NOT_API_MIME =
  /^(text\/(html|css|javascript)|application\/(javascript|x-javascript)|image\/|font\/|video\/|audio\/)/i;

type HarEntry = Omit<chrome.devtools.network.Request, 'getContent'> & {
  _resourceType?: string;
  getContent?: unknown;
};

let nextId = 1;
const entries: NetworkEntry[] = [];
const listeners: Array<() => void> = [];

function isApiCall(har: HarEntry): boolean {
  if (har._resourceType) return API_TYPES.has(har._resourceType);
  return !NOT_API_MIME.test(har.response?.content?.mimeType ?? '');
}

function toEntry(har: HarEntry): NetworkEntry {
  return {
    id: nextId++,
    method: har.request.method,
    url: har.request.url,
    status: har.response.status,
    mimeType: har.response.content?.mimeType ?? '',
    time: Math.round(har.time ?? 0),
    api: isApiCall(har),
    body: () => responseBody(har),
  };
}

function add(har: HarEntry): void {
  entries.push(toEntry(har));
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  for (const listener of listeners) listener();
}

/** Starts reading the network log: what DevTools holds already, then each request as it finishes. */
export function startNetworkLog(onChange: () => void): void {
  listeners.push(onChange);
  chrome.devtools.network.getHAR((har) => {
    for (const entry of (har?.entries ?? []) as HarEntry[]) add(entry);
  });
  chrome.devtools.network.onRequestFinished.addListener((request) => add(request as HarEntry));
}

/** How a status code reads in the list: red for a failure or no answer, muted for a redirect. */
function statusTone(status: number): string {
  if (status >= 400 || status === 0) return 'bad';
  if (status >= 300) return 'muted';
  return '';
}

interface NetworkView {
  allOrigins: boolean;
  /** Every kind of request, not only `fetch` and XHR. */
  allTypes: boolean;
  selected: number | null;
  kind: MockKind;
  reveal: boolean;
  pattern: string | null;
}

const view: NetworkView = {
  allOrigins: false,
  allTypes: false,
  selected: null,
  kind: 'response',
  reveal: false,
  pattern: null,
};

function download(content: string, filename: string, base64: boolean): void {
  const bytes = base64 ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0)) : content;
  downloadBlob(new Blob([bytes]), filename);
}

const KINDS = [
  ['response', 'devtools_mockResponse'],
  ['error', 'devtools_mockError'],
  ['abort', 'devtools_mockAbort'],
] as const;

/** A label and its field, for the `.fields` grid. */
function field(id: string, label: string, control: HTMLInputElement | HTMLSelectElement): HTMLElement[] {
  control.id = id;
  const labelEl = el('label', '', label);
  labelEl.htmlFor = id;
  return [labelEl, control];
}

async function renderMock(pane: HTMLElement, entry: NetworkEntry): Promise<void> {
  const { text, base64 } = await entry.body();
  // Another request was clicked while DevTools read this one's body.
  if (view.selected !== entry.id) return;
  const source: MockSource = {
    method: entry.method,
    url: entry.url,
    status: entry.status,
    mimeType: entry.mimeType,
    body: text,
    base64,
  };

  const mock = el('section', 'mock');
  mock.setAttribute('aria-label', t('devtools_mockTitle'));
  const title = el('h3', 'request-title');
  title.append(methodView(entry.method), ' ', urlView(entry.url));

  const patternInput = el('input');
  patternInput.type = 'text';
  patternInput.value = view.pattern ?? mockUrlPattern(entry.url);
  patternInput.spellcheck = false;
  const kind = el('select');
  for (const [value, key] of KINDS) {
    const option = el('option', '', t(key));
    option.value = value;
    kind.appendChild(option);
  }
  kind.value = view.kind;
  const fields = el('div', 'fields');
  fields.append(
    ...field('mock-pattern', t('devtools_mockPattern'), patternInput),
    ...field('mock-kind', t('devtools_mockKind'), kind),
  );

  const notes = el('div', 'notes');
  const code = el('pre', 'code');
  const copy = button(t('devtools_mockCopy'), () => void copyWithFeedback(code.textContent ?? '', copy), {
    icon: 'copy',
    tone: 'primary',
    className: 'copy-code',
  });
  const codeBox = el('div', 'code-box');
  codeBox.append(code, copy);
  const fileActions = el('div', 'controls');

  const update = () => {
    view.pattern = patternInput.value;
    const result = mockCode(source, { kind: view.kind, pattern: patternInput.value, reveal: view.reveal });
    code.textContent = result.code;
    notes.replaceChildren();
    fileActions.replaceChildren();
    if (view.kind === 'response' && text === null) {
      notes.appendChild(iconLine('alert', 'warn-text', t('devtools_mockNoBody')));
    }
    if (result.hidden > 0) notes.appendChild(iconLine('eye-off', '', tn('devtools_mockHidden', result.hidden)));
    if (result.hidden > 0 || view.reveal) {
      const reveal = el('label', 'check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = view.reveal;
      box.addEventListener('change', () => {
        view.reveal = box.checked;
        update();
      });
      reveal.append(box, t('devtools_mockReveal'));
      notes.appendChild(reveal);
    }
    if (result.file) {
      const file = result.file;
      const name = file.path.split('/').pop()!;
      const path = el('code', '', file.path);
      notes.appendChild(iconLine('file', '', ...tNodes('devtools_mockFileHint', { path })));
      fileActions.appendChild(
        button(t('devtools_mockDownload', { file: name }), () => download(file.content, name, file.base64), {
          icon: 'download',
        }),
      );
    }
  };
  patternInput.addEventListener('input', update);
  kind.addEventListener('change', () => {
    view.kind = kind.value as MockKind;
    update();
  });
  update();
  mock.append(title, fields, notes, codeBox, fileActions);
  pane.replaceChildren(mock, conditionActions(entry, dom?.origin ?? null));
}

interface NetworkDom {
  list: HTMLElement;
  detail: HTMLElement;
  origin: string | null;
}

let dom: NetworkDom | null = null;
/** Counts the tab's draws: a draw that a later one overtook leaves `dom` to it. */
let draws = 0;

/** Redraws the list of requests, leaving the mock being edited as it is. */
export function refreshNetworkList(): void {
  if (!dom) return;
  const { list, origin } = dom;
  const shown = entries.filter(
    (entry) => (entry.api || view.allTypes) && (view.allOrigins || !origin || webOrigin(entry.url) === origin),
  );
  if (shown.length === 0) {
    list.replaceChildren(el('li', 'note', t('devtools_networkEmpty')));
    return;
  }
  list.replaceChildren(
    ...shown.map((entry) => {
      const item = el('li');
      const row = el('button', 'request');
      row.type = 'button';
      row.title = `${entry.method} ${entry.url}`;
      row.setAttribute('aria-pressed', String(entry.id === view.selected));
      const path = el('span', 'path');
      path.appendChild(urlView(entry.url, { origin: view.allOrigins }));
      row.append(
        methodView(entry.method),
        path,
        el('span', `status-code ${statusTone(entry.status)}`.trim(), String(entry.status)),
        el('span', 'time', t('devtools_requestTime', { ms: formatNumber(entry.time) })),
      );
      row.addEventListener('click', () => {
        view.selected = entry.id;
        view.pattern = null;
        view.kind = 'response';
        view.reveal = false;
        refreshNetworkList();
        void showSelected();
      });
      item.appendChild(row);
      return item;
    }),
  );
}

async function showSelected(): Promise<void> {
  if (!dom) return;
  const selected = entries.find((entry) => entry.id === view.selected);
  if (!selected) {
    dom.detail.replaceChildren(emptyState('network', t('devtools_networkSelect')));
    return;
  }
  await renderMock(dom.detail, selected);
}

/** Whether the page at `url` is on another origin than the one the tab was drawn for. */
export function networkOriginChanged(url: string): boolean {
  return !!dom && webOrigin(url) !== dom.origin;
}

/**
 * Draws the tab: the conditions on, across the top; the requests on the left,
 * most recent last; the selected one on the right, to mock, slow down or fail.
 * The page's origin is read in the page, or from `pageUrl` after a navigation.
 */
export async function renderNetworkTab(container: HTMLElement, pageUrl?: string): Promise<void> {
  const mine = ++draws;
  const origin = pageUrl === undefined ? await inspectedOrigin() : webOrigin(pageUrl);
  const strip = el('section', 'conditions-strip');
  strip.setAttribute('aria-label', t('devtools_conditionsTitle'));

  const allLabel = el('label', 'check');
  const all = el('input');
  all.type = 'checkbox';
  all.checked = view.allOrigins;
  all.addEventListener('change', () => {
    view.allOrigins = all.checked;
    refreshNetworkList();
  });
  allLabel.append(all, t('devtools_networkAllOrigins'));
  const clear = button(
    t('devtools_networkClear'),
    () => {
      entries.length = 0;
      view.selected = null;
      refreshNetworkList();
      void showSelected();
    },
    { icon: 'trash', tone: 'remove' },
  );
  const toolbar = el('div', 'pane-toolbar');
  const pageStatus = el('span', 'warn-text');
  pageStatus.setAttribute('role', 'status');
  const conditionsMenu = await pageConditions(origin, (text) => {
    pageStatus.textContent = text;
  });
  if (mine !== draws) return;
  // Documents, scripts and images: only where the debugging protocol can slow them down or fail them.
  const typesLabel = el('label', 'check');
  if (typeof chrome.debugger?.attach === 'function') {
    const types = el('input');
    types.type = 'checkbox';
    types.checked = view.allTypes;
    types.addEventListener('change', () => {
      view.allTypes = types.checked;
      refreshNetworkList();
    });
    typesLabel.append(types, t('devtools_networkAllTypes'));
  }
  toolbar.append(allLabel, typesLabel, clear, conditionsMenu, pageStatus);
  const head = el('div', 'request-head');
  head.setAttribute('aria-hidden', 'true');
  head.append(
    el('span', '', t('devtools_colMethod')),
    el('span', '', t('devtools_colPath')),
    el('span', '', t('devtools_colStatus')),
    el('span', '', t('devtools_colTime')),
  );
  const list = el('ul', 'requests');
  list.setAttribute('aria-label', t('devtools_tabNetwork'));
  const requests = el('div', 'requests-pane');
  requests.append(toolbar, head, list, el('p', 'pane-foot', t('devtools_networkHint')));
  const detail = el('div', 'detail-pane');

  const grid = el('div', 'network');
  grid.append(strip, requests, detail);
  container.replaceChildren(grid);
  dom = { list, detail, origin };
  await renderConditions(strip, origin);
  if (mine !== draws) return;
  refreshNetworkList();
  await showSelected();
}
