import { parsePairing } from '@piwitests/core/editor-send';
import { editorOriginPattern, getEditorPairing, setEditorPairing } from '../shared/editor-pairing.js';
import {
  CONNECTION_KEY,
  getConnectionSettings,
  setConnectionSettings,
  clearConnectionSettings,
  applyServerSync,
  mappedProjects,
  getInstanceApiKey,
  setInstanceApiKey,
  clearInstanceApiKey,
  markDesktopApiKey,
  type ConnectionSettings,
} from '../shared/connection-settings.js';
import {
  testConnection,
  fetchProjects,
  fetchCatalog,
  startConnect,
  pollConnect,
  fetchServerPatterns,
  addServerPattern,
  testDesktop,
  startDesktopPairing,
  pollDesktopPairing,
  type ProjectOption,
} from '../shared/piwi-client.js';
import {
  DESKTOP_DEFAULT_URL,
  clearDesktopSettings,
  desktopOrigin,
  getDesktopSettings,
  setDesktopSettings,
  type DesktopSettings,
} from '../shared/desktop-settings.js';
import { normalizePathPrefix, parsePathPrefix } from '@piwitests/core/page-key';
import { waitForApproval } from '../shared/connect-flow.js';
import {
  CONNECTION_HEALTH_KEY,
  clearConnectionHealth,
  getConnectionHealth,
  healthPill,
  withConnectionHealth,
} from '../shared/connection-health.js';
import { describeClient } from '../shared/client-info.js';
import { setCachedCatalog, pruneCachedCatalogs } from '../shared/catalog-cache.js';
import { clearActiveProjectOverrides } from '../shared/active-project.js';
import { clearCachedLocatorIndexes } from '../shared/locator-index-cache.js';
import { clearLocatorBranchOverrides } from '../shared/locator-branch.js';
import { moveLegacySecrets } from '../shared/legacy-secrets.js';
import { RECORDING_KEY, clearRecordIntent, getRecordingState } from '../shared/recording-storage.js';
import { REPLAY_KEY, getReplayState } from '../shared/replay-storage.js';
import { hostPattern, originPattern } from '../shared/web-origin.js';
import { canRevoke, siteGrants, type GrantHolders, type GrantUse } from './site-grants.js';
import { keepMappings, takeKeptMappings } from './kept-mappings.js';
import {
  LANGUAGES,
  browserCatalogLanguage,
  chosenLanguage,
  initI18n,
  languageName,
  languageTag,
  localizeDocument,
  t,
  tn,
  tNodes,
  type Language,
  type MessageKey,
} from '../shared/i18n.js';
import { isDraftLanguage, TRANSLATION_ISSUE_URL } from '../shared/languages.js';
import { decorateIcons, icon, iconText, withIcon } from '../shared/icons.js';
import { STEP_CSS } from '../shared/step-view.js';
import { PATTERN_CSS, patternView } from '../shared/pattern-view.js';

await initI18n();
localizeDocument();
// The icons and the addresses' look, before the first icon or address is drawn.
const sharedStyle = document.createElement('style');
sharedStyle.textContent = `${STEP_CSS}${PATTERN_CSS}`;
document.head.appendChild(sharedStyle);
decorateIcons();
await moveLegacySecrets();

const instanceUrlEl = document.getElementById('instance-url') as HTMLInputElement;
const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const connectPanel = document.getElementById('connect-panel') as HTMLElement;
const connectCodeLine = document.getElementById('connect-code-line')!;
const connectCancelBtn = document.getElementById('connect-cancel') as HTMLButtonElement;
const connectedAsEl = document.getElementById('connected-as') as HTMLElement;
const apiKeyFallback = document.getElementById('api-key-fallback') as HTMLDetailsElement;
const serverMappingsEl = document.getElementById('server-mappings')!;
const refreshServerBtn = document.getElementById('refresh-server') as HTMLButtonElement;
const addSiteEl = document.getElementById('add-site') as HTMLElement;
const addPatternEl = document.getElementById('add-pattern') as HTMLInputElement;
const addProjectEl = document.getElementById('add-project') as HTMLSelectElement;
const addEnvironmentEl = document.getElementById('add-environment') as HTMLInputElement;
const addBranchEl = document.getElementById('add-branch') as HTMLInputElement;
const addPrefixEl = document.getElementById('add-prefix') as HTMLInputElement;
const addTestPrefixEl = document.getElementById('add-test-prefix') as HTMLInputElement;
const addNoteEl = document.getElementById('add-note') as HTMLElement;
const addToServerBtn = document.getElementById('add-to-server') as HTMLButtonElement;
const addLocallyBtn = document.getElementById('add-locally') as HTMLButtonElement;
const apiKeyEl = document.getElementById('api-key') as HTMLInputElement;
const mappingsEl = document.getElementById('mappings')!;
const addMappingBtn = document.getElementById('add-mapping') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;
const mappingsStatusEl = document.getElementById('mappings-status')!;
const languageStatusEl = document.getElementById('language-status')!;
const instancePill = document.getElementById('instance-pill') as HTMLElement;
const instanceHealthPill = document.getElementById('instance-health') as HTMLElement;
const sitesConnectFirst = document.getElementById('sites-connect-first') as HTMLElement;
const sitesBody = document.getElementById('sites-body') as HTMLElement;
const mappingHead = document.getElementById('mapping-head') as HTMLElement;
const apiKeySaveBtn = document.getElementById('api-key-save') as HTMLButtonElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement;
const desktopOffer = document.getElementById('desktop-offer') as HTMLElement;
const useDesktopBtn = document.getElementById('use-desktop') as HTMLButtonElement;
const desktopPairHint = document.getElementById('desktop-pair-hint') as HTMLElement;
const languageSelect = document.getElementById('language') as HTMLSelectElement;
const draftNote = document.getElementById('language-draft') as HTMLElement;

interface EditableMapping {
  urlPattern: string;
  projectId: number | null;
  projectLabel: string;
  /** The branch deployed at those URLs; empty for the project's default branch. */
  branch: string;
  /** The part of the site's path the tests never saw (`/app`); empty for none. */
  pathPrefix: string;
  /** The part of the path the tests ran the pages under and the site does not; empty for none. */
  testPathPrefix: string;
}

/** The pool a mapping row's project `<select>` draws from: the instance's project list, else the last sync's projects. */
let projectOptions: ProjectOption[] = [];
let mappings: EditableMapping[] = [];
/** The stored settings as last read or written: the instance's patterns and account name live here. */
let stored: ConnectionSettings = await getConnectionSettings();
/** The API key kept for `stored`'s instance, as the page opened. */
const storedApiKey = await getInstanceApiKey(stored.instanceUrl).catch(() => '');
/** Set while a Connect is waiting for the user to answer on the instance; aborting it stops the wait. */
let pendingConnect: AbortController | null = null;
/** Why the last read of the instance's patterns failed, shown under them; empty after a good read. */
let serverSyncError = '';
/**
 * Bumped by Disconnect and by every connection kept. A write that an action
 * began under an earlier value is dropped, so a sync still waiting on the
 * instance never brings back what Disconnect removed, nor an earlier
 * instance's patterns.
 */
let connectionEpoch = 0;
/** Set while Add to Piwi sends a pattern, so its button stays disabled. */
let addingToServer = false;

type StatusKind = 'ok' | 'error' | '';

/** What a status line says: plain text, or text with an address or a pattern set apart. */
type StatusText = string | Array<Node | string>;

/** A status line: its text, after a check or a warning icon once it says how something went. */
function writeStatus(el: HTMLElement, text: StatusText, kind: StatusKind): void {
  const parts = typeof text === 'string' ? (text ? [text] : []) : text;
  el.className = kind;
  if (parts.length === 0) {
    el.replaceChildren();
    return;
  }
  if (kind) iconText(el, kind === 'ok' ? 'check-circle' : 'alert', ...parts);
  else el.replaceChildren(...parts);
}

/** The Connect to Piwi card's status line. */
function setStatus(text: StatusText, kind: StatusKind = ''): void {
  writeStatus(statusEl, text, kind);
}

/** The Project mappings card's status line. */
function setMappingsStatus(text: StatusText, kind: StatusKind = ''): void {
  writeStatus(mappingsStatusEl, text, kind);
}

/** `text` in bold, as a name stands out in a sentence. */
function strong(text: string): HTMLElement {
  const el = document.createElement('strong');
  el.textContent = text;
  return el;
}

/** `text` on a chip in the monospace type: a branch, a path prefix. */
function codeChip(text: string): HTMLElement {
  const el = document.createElement('code');
  el.textContent = text;
  return el;
}

/** Runs `work` with `button` disabled until it ends, so a second click starts no second one. */
function whileRunning(button: HTMLButtonElement, work: () => Promise<void>): void {
  button.disabled = true;
  void work().finally(() => {
    button.disabled = false;
  });
}

/** A card's badge: on (Connected, Paired) or off. */
function setPill(pill: HTMLElement, on: boolean, onKey: MessageKey, offKey: MessageKey): void {
  pill.classList.toggle('on', on);
  pill.textContent = t(on ? onKey : offKey);
}

/**
 * Asks for host access to the Piwi instance's own origin.
 *
 * Needed because the dashboard API doesn't send CORS headers, so a
 * cross-origin fetch from an extension context only succeeds with a host
 * permission. It matters most for the *background* refresh
 * (`piwi-refresh-catalog`): a service worker has no user gesture and so can
 * never request one itself, which would leave the catalog frozen at whatever
 * this page last fetched.
 *
 * `chrome.permissions.request` only counts while the user gesture is still
 * live (Firefox refuses it anywhere else), so callers invoke this first in the
 * click handler, before anything is awaited, and it calls the request itself
 * at once: an origin already granted resolves true without a prompt. Granted
 * narrowly — the one instance origin, never the broad http/https patterns the
 * manifest declares as merely requestable.
 */
function requestInstanceHostPermission(instanceUrl: string): Promise<boolean> {
  try {
    const origin = new URL(instanceUrl).origin;
    return requestOrigins([hostPattern(origin)]);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * `chrome.permissions.request` for `origins`, called at once. Its grant is not
 * a recording's: a "Record actions" intent still parked is cleared with the
 * request, or the grant would start that recording.
 */
function requestOrigins(origins: string[]): Promise<boolean> {
  const granted = chrome.permissions.request({ origins }).catch(() => false);
  void clearRecordIntent().catch(() => undefined);
  return granted;
}

/**
 * Writes `change(current)` over the stored settings and returns true, unless
 * the epoch has moved past `epoch` or the stored instance is no longer
 * `instanceUrl` (another settings page disconnected, or connected elsewhere).
 */
async function writeConnection(
  epoch: number,
  instanceUrl: string,
  change: (current: ConnectionSettings) => ConnectionSettings,
): Promise<boolean> {
  const current = await getConnectionSettings();
  if (epoch !== connectionEpoch || current.instanceUrl !== instanceUrl) return false;
  stored = change(current);
  await setConnectionSettings(stored);
  return true;
}

/**
 * What belongs to the instance kept until now: each site's Active project, each project's branch chosen in Tested
 * elements, and the cached catalogs and locator indexes.
 */
async function forgetInstanceData(): Promise<void> {
  await Promise.all([
    clearActiveProjectOverrides().catch(() => undefined),
    clearLocatorBranchOverrides().catch(() => undefined),
    clearCachedLocatorIndexes(),
    pruneCachedCatalogs([]),
  ]);
}

function renderMappings(): void {
  mappingsEl.innerHTML = '';
  mappingHead.hidden = mappings.length === 0;

  if (mappings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-mappings';
    empty.textContent = t('options_noMappings');
    mappingsEl.appendChild(empty);
    return;
  }

  const knownIds = new Set(projectOptions.map((p) => p.id));

  mappings.forEach((mapping, index) => {
    const row = document.createElement('div');
    row.className = 'mapping-row mapping-grid';

    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.className = 'mapping-pattern';
    patternInput.placeholder = t('options_patternPlaceholder');
    patternInput.setAttribute('aria-label', t('options_pattern'));
    patternInput.value = mapping.urlPattern;
    patternInput.addEventListener('input', () => {
      mappings[index]!.urlPattern = patternInput.value;
    });

    const projectSelect = document.createElement('select');
    projectSelect.className = 'mapping-project';
    projectSelect.setAttribute('aria-label', t('options_project'));
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = projectOptions.length === 0 ? t('options_projectTestFirst') : t('options_projectChoose');
    projectSelect.appendChild(placeholder);
    // A mapping saved before the project list was (re-)fetched still names a real project — keep showing it even if it's not in `projectOptions` yet.
    if (mapping.projectId != null && !knownIds.has(mapping.projectId)) {
      const preserved = document.createElement('option');
      preserved.value = String(mapping.projectId);
      preserved.textContent = mapping.projectLabel;
      projectSelect.appendChild(preserved);
    }
    for (const p of projectOptions) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.label || p.name;
      projectSelect.appendChild(opt);
    }
    projectSelect.value = mapping.projectId != null ? String(mapping.projectId) : '';
    projectSelect.addEventListener('change', () => {
      const id = projectSelect.value ? Number(projectSelect.value) : null;
      mappings[index]!.projectId = id;
      mappings[index]!.projectLabel = projectSelect.selectedOptions[0]?.textContent ?? '';
    });

    const branchInput = document.createElement('input');
    branchInput.type = 'text';
    branchInput.className = 'mapping-branch';
    branchInput.placeholder = t('options_branchPlaceholder');
    branchInput.title = t('options_branchTitle');
    branchInput.setAttribute('aria-label', t('options_branch'));
    branchInput.value = mapping.branch;
    branchInput.addEventListener('input', () => {
      mappings[index]!.branch = branchInput.value;
    });

    const prefixInput = pathPrefixInput(mapping.pathPrefix, 'site');
    prefixInput.addEventListener('input', () => {
      mappings[index]!.pathPrefix = prefixInput.value;
    });
    const testPrefixInput = pathPrefixInput(mapping.testPathPrefix, 'tests');
    testPrefixInput.addEventListener('input', () => {
      mappings[index]!.testPathPrefix = testPrefixInput.value;
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-mapping';
    removeBtn.setAttribute('aria-label', t('options_removeMapping'));
    removeBtn.title = t('options_removeMapping');
    removeBtn.append(icon('trash'));
    removeBtn.addEventListener('click', () => {
      mappings.splice(index, 1);
      renderMappings();
    });

    row.append(patternInput, projectSelect, branchInput, prefixInput, testPrefixInput, removeBtn);
    mappingsEl.appendChild(row);
  });
}

/** Why `value` is refused as a path prefix; empty when it is accepted (an empty value is no prefix). */
function pathPrefixError(value: string): string {
  return parsePathPrefix(value).ok ? '' : t('options_pathPrefixInvalid', { prefix: value.trim() });
}

/** The first refusal among a line's or the form's two prefixes; empty when both are accepted. */
function prefixesError(pathPrefix: string, testPathPrefix: string): string {
  return pathPrefixError(pathPrefix) || pathPrefixError(testPathPrefix);
}

/** `{ pathPrefix, testPathPrefix }` for a stored mapping, normalized, each only when set. */
function pathPrefixFields(
  pathPrefix: string,
  testPathPrefix: string,
): { pathPrefix?: string; testPathPrefix?: string } {
  const site = normalizePathPrefix(pathPrefix);
  const tests = normalizePathPrefix(testPathPrefix);
  return { ...(site ? { pathPrefix: site } : {}), ...(tests ? { testPathPrefix: tests } : {}) };
}

/** Which prefix a field holds: the site's (`pathPrefix`) or the tests' (`testPathPrefix`). */
type PrefixKind = 'site' | 'tests';

/** Marks a path prefix field invalid, with the reason as its tooltip, while its value is refused. */
function watchPathPrefix(input: HTMLInputElement, kind: PrefixKind): void {
  const check = () => {
    const error = pathPrefixError(input.value);
    input.title = error || (kind === 'site' ? t('options_pathPrefixTitle') : t('options_testPathPrefixTitle'));
    input.toggleAttribute('aria-invalid', error !== '');
  };
  check();
  input.addEventListener('input', check);
}

/** A path prefix field of a line. */
function pathPrefixInput(value: string, kind: PrefixKind): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'mapping-branch mapping-prefix';
  input.placeholder = kind === 'site' ? t('options_pathPrefixPlaceholder') : t('options_testPathPrefixPlaceholder');
  input.setAttribute('aria-label', kind === 'site' ? t('options_pathPrefix') : t('options_testPathPrefix'));
  input.value = value;
  watchPathPrefix(input, kind);
  return input;
}

watchPathPrefix(addPrefixEl, 'site');
watchPathPrefix(addTestPrefixEl, 'tests');

addMappingBtn.addEventListener('click', () => {
  mappings.push({ urlPattern: '', projectId: null, projectLabel: '', branch: '', pathPrefix: '', testPathPrefix: '' });
  renderMappings();
});

/**
 * What the Connect to Piwi card says of the connection: its badge, "Connected
 * as …" once a sync has worked, Disconnect while an instance is kept; and the
 * Project mappings card, whose patterns need that instance's projects.
 */
function renderInstanceState(): void {
  const kept = stored.instanceUrl.trim() !== '';
  const synced = kept && stored.serverSyncedAt > 0;
  setPill(instancePill, kept, 'options_stateConnected', 'options_stateNotConnected');
  // Once connected, Connect is no longer the next thing to do.
  connectBtn.classList.toggle('primary', !kept);
  disconnectBtn.hidden = !kept;
  connectedAsEl.hidden = !synced;
  connectedAsEl.replaceChildren();
  if (synced) {
    iconText(
      connectedAsEl,
      'check-circle',
      ...(stored.connectedAs
        ? tNodes('options_connectedAs', { name: strong(stored.connectedAs) })
        : [t('options_connectedNoAuth')]),
    );
  }
  sitesConnectFirst.hidden = kept;
  sitesBody.hidden = !kept;
  void renderInstanceHealth();
  renderDesktopAsInstance();
}

/** The desktop app paired, as the Desktop app card last read it; null when none is. */
let pairedDesktop: DesktopSettings | null = null;

/**
 * The desktop app runs a Piwi instance on this computer, so the two cards
 * offer each other: with the app paired and no instance kept, Use the desktop
 * app as your instance; with an instance kept and no app paired, a line
 * pointing to the pairing.
 */
function renderDesktopAsInstance(): void {
  const kept = stored.instanceUrl.trim() !== '';
  desktopOffer.hidden = kept || !pairedDesktop;
  desktopPairHint.hidden = !kept || !!pairedDesktop;
  if (desktopPairHint.hidden) {
    desktopPairHint.replaceChildren();
    return;
  }
  const link = document.createElement('a');
  link.href = '#desktop-card';
  link.textContent = t('options_desktopPairHintLink');
  link.addEventListener('click', (e) => {
    e.preventDefault();
    // An instance on this computer's loopback is likely the app itself: Pair asks it there.
    const local = desktopOrigin(stored.instanceUrl);
    if (local && desktopUrlEl.value === DESKTOP_DEFAULT_URL) desktopUrlEl.value = local;
    showField(desktopPairBtn);
  });
  desktopPairHint.replaceChildren(...tNodes('options_desktopPairHint', { link }));
}

/**
 * Use the desktop app as your instance: its address and the token the pairing
 * holds, which its server takes as an API key, kept and checked as Save and
 * test does. Should the app refuse the token, the address stays filled in and
 * the key field waits for one.
 */
useDesktopBtn.addEventListener('click', () => {
  const desktop = pairedDesktop;
  if (!desktop) return;
  // Before any await, so the click still counts as the user gesture.
  const permission = requestInstanceHostPermission(desktop.url);
  const epoch = connectionEpoch;
  instanceUrlEl.value = desktop.url;
  apiKeyEl.value = desktop.token;
  whileRunning(useDesktopBtn, async () => {
    if (await connectWithKey({ instanceUrl: desktop.url, apiKey: desktop.token }, permission, epoch, true)) return;
    apiKeyEl.value = '';
    apiKeyFallback.open = true;
    showField(apiKeyEl);
  });
});

/** The pill beside the instance's address: whether it answered the last request made to it, and when. */
async function renderInstanceHealth(): Promise<void> {
  const health = await getConnectionHealth(stored.instanceUrl).catch(() => null);
  instanceHealthPill.hidden = !health;
  if (!health) return;
  instanceHealthPill.classList.toggle('on', health.outcome === 'ok');
  instanceHealthPill.classList.toggle('failing', health.outcome !== 'ok');
  instanceHealthPill.textContent = healthPill(health);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && CONNECTION_HEALTH_KEY in changes) void renderInstanceHealth();
});
// "Answered 5 minutes ago" stays true while the page stays open.
setInterval(() => void renderInstanceHealth(), 30_000);

/** The instance's patterns, read-only, each marked as coming from the instance. */
function renderServerMappings(): void {
  serverMappingsEl.replaceChildren();
  if (serverSyncError) {
    const error = document.createElement('div');
    error.className = 'hint';
    error.textContent = t('options_serverSyncFailed', { error: serverSyncError });
    serverMappingsEl.appendChild(error);
  }
  if (stored.serverMappings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-mappings';
    empty.textContent = stored.serverSyncedAt > 0 ? t('options_serverEmpty') : t('options_serverNotRead');
    serverMappingsEl.appendChild(empty);
  }
  for (const mapping of stored.serverMappings) {
    const row = document.createElement('div');
    row.className = 'server-row';
    const pattern = document.createElement('span');
    pattern.className = 'pattern';
    pattern.appendChild(patternView(mapping.urlPattern));
    const meta = document.createElement('span');
    meta.className = 'meta';
    const facts: Array<Array<Node | string>> = [
      mapping.projectLabel ? [strong(mapping.projectLabel)] : [],
      mapping.environment ? [mapping.environment] : [],
      mapping.branch ? [codeChip(mapping.branch)] : [],
      mapping.pathPrefix ? tNodes('options_serverPathPrefix', { prefix: codeChip(mapping.pathPrefix) }) : [],
      mapping.testPathPrefix
        ? tNodes('options_serverTestPathPrefix', { prefix: codeChip(mapping.testPathPrefix) })
        : [],
    ].filter((fact) => fact.length > 0);
    facts.forEach((fact, i) => meta.append(...(i > 0 ? [' · '] : []), ...fact));
    const source = document.createElement('span');
    source.className = 'source';
    source.textContent = t('options_sourceServer');
    row.append(pattern, meta, source);
    serverMappingsEl.appendChild(row);
  }
  refreshServerBtn.hidden = !stored.instanceUrl.trim();
  renderAddSite();
}

/** The "Add a site" form: the projects the user may add patterns to, or why there are none. */
function renderAddSite(): void {
  addSiteEl.hidden = !stored.instanceUrl.trim() || stored.serverSyncedAt === 0;
  const editable = stored.serverProjects.filter((p) => p.canEdit);
  const previous = addProjectEl.value;
  addProjectEl.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = t('options_projectChoose');
  addProjectEl.appendChild(placeholder);
  for (const project of editable) {
    const option = document.createElement('option');
    option.value = String(project.id);
    option.textContent = project.label;
    addProjectEl.appendChild(option);
  }
  if (editable.some((p) => String(p.id) === previous)) addProjectEl.value = previous;
  else if (editable.length === 1) addProjectEl.value = String(editable[0]!.id);
  addToServerBtn.disabled = addingToServer || editable.length === 0;
  addNoteEl.hidden = editable.length > 0;
  addNoteEl.textContent = editable.length > 0 ? '' : t('options_addNoEditable');
}

/**
 * Reads the instance's URL patterns into the stored settings. Keeps the
 * previous copy when the instance cannot be read, so resolving a page's
 * project keeps working offline. Writes nothing, and answers false, once
 * Disconnect or another connection came after `epoch`.
 */
async function syncServerPatterns(settings: ConnectionSettings, epoch: number): Promise<boolean> {
  try {
    const answer = await withConnectionHealth(settings.instanceUrl, () => fetchServerPatterns(settings));
    const written = await writeConnection(epoch, settings.instanceUrl, (current) =>
      applyServerSync(current, answer, Date.now()),
    );
    if (written) serverSyncError = '';
    return written;
  } catch (err) {
    if (epoch === connectionEpoch) serverSyncError = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    renderServerMappings();
    renderInstanceState();
  }
}

/**
 * Fetches and caches the function catalog of every mapped project; returns the
 * counts the status line reports. Stops caching once Disconnect or another
 * connection came after `epoch`.
 */
async function refreshCatalogs(
  settings: ConnectionSettings,
  epoch: number,
): Promise<{ projects: number; functions: number; failed: number }> {
  const projectIds = mappedProjects(settings).map((p) => p.projectId);
  let functions = 0;
  let failed = 0;
  for (const projectId of projectIds) {
    try {
      const catalog = await fetchCatalog(settings, projectId);
      if (epoch !== connectionEpoch) break;
      await setCachedCatalog(projectId, catalog);
      functions += catalog.length;
    } catch {
      failed++;
    }
  }
  if (epoch === connectionEpoch) await pruneCachedCatalogs(projectIds);
  return { projects: projectIds.length, functions, failed };
}

/** The projects the last sync of URL patterns read: every project the instance shows this account. */
function syncedProjectOptions(): ProjectOption[] {
  return stored.serverProjects.map((p) => ({ id: p.id, name: p.label, label: p.label }));
}

/** The lines of this browser as the table edits them. */
function editableMappings(settings: ConnectionSettings): EditableMapping[] {
  return settings.projectMappings.map((m) => ({
    urlPattern: m.urlPattern,
    projectId: m.projectId,
    projectLabel: m.projectLabel,
    branch: m.branch ?? '',
    pathPrefix: m.pathPrefix ?? '',
    testPathPrefix: m.testPathPrefix ?? '',
  }));
}

async function loadInitial(): Promise<void> {
  const settings = stored;
  const epoch = connectionEpoch;
  instanceUrlEl.value = settings.instanceUrl;
  apiKeyEl.value = storedApiKey;
  // A key typed by hand stays visible where it was typed.
  apiKeyFallback.open = storedApiKey !== '' && settings.serverSyncedAt === 0;
  mappings = editableMappings(settings);
  projectOptions = syncedProjectOptions();
  renderMappings();
  renderServerMappings();
  renderInstanceState();
  const offered = prefillAddSite();

  if (settings.instanceUrl) {
    if (await syncServerPatterns(settings, epoch)) {
      projectOptions = syncedProjectOptions();
      renderMappings();
    }
    if (offered && epoch === connectionEpoch) showOfferedSite(offered);
    try {
      const projects = await fetchProjects(settings);
      if (epoch !== connectionEpoch) return;
      projectOptions = projects;
      renderMappings();
    } catch {
      // Instance unreachable at load time: the lines keep the projects the last sync read.
    }
  }
}

/**
 * `options.html#add=<pattern>`, as the popup opens it for a site no pattern covers: fills the Add a site form in.
 * Answers the pattern when the form waits for the instance's projects, hidden, for {@link showOfferedSite}.
 */
function prefillAddSite(): string | null {
  const match = /^#add=(.+)$/.exec(location.hash);
  if (!match) return null;
  let pattern: string;
  try {
    pattern = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  history.replaceState(null, '', location.pathname);
  addPatternEl.value = pattern;
  (addSiteEl as HTMLDetailsElement).open = true;
  if (addSiteEl.hidden) return pattern;
  requestAnimationFrame(() => showField(addPatternEl));
  return null;
}

/**
 * The site the popup offered, once the instance has been read: in the Add a site form it opened, or, the instance's
 * projects still unread, as a line of this browser whose project is left to choose.
 */
function showOfferedSite(pattern: string): void {
  if (!addSiteEl.hidden) {
    showField(addPatternEl);
    return;
  }
  addPatternEl.value = '';
  mappings.push({
    urlPattern: pattern,
    projectId: null,
    projectLabel: '',
    branch: '',
    pathPrefix: '',
    testPathPrefix: '',
  });
  renderMappings();
  const project = mappingsEl.querySelector<HTMLSelectElement>('.mapping-row:last-child .mapping-project');
  if (project) showField(project);
}

function showField(field: HTMLElement): void {
  field.scrollIntoView({ block: 'center' });
  field.focus();
}

function setConnecting(active: boolean): void {
  connectPanel.hidden = !active;
  if (!active) connectCodeLine.replaceChildren();
}

connectBtn.addEventListener('click', () => {
  const instanceUrl = instanceUrlEl.value.trim();
  // Before any await, so the click still counts as the user gesture.
  const permission = requestInstanceHostPermission(instanceUrl);
  // Disabled until this connect ends, so a second click starts no second one.
  connectBtn.disabled = true;
  void (async () => {
    try {
      if (!instanceUrl) {
        setStatus(t('common_enterInstanceUrl'), 'error');
        return;
      }
      if (!(await permission)) {
        setStatus(t('options_accessDenied'), 'error');
        return;
      }
      await connect(instanceUrl);
    } finally {
      connectBtn.disabled = false;
    }
  })();
});

connectCancelBtn.addEventListener('click', () => {
  pendingConnect?.abort();
});

/**
 * Connects in one step: the instance shows a code on a page where the signed-in
 * user allows Piwi Picker, and the answer to the next poll carries an API key
 * created for them. The page it opens for that is closed however the wait ends.
 */
async function connect(instanceUrl: string): Promise<void> {
  pendingConnect?.abort();
  const controller = new AbortController();
  pendingConnect = controller;
  const epoch = connectionEpoch;
  setStatus(t('options_connectStarting'));
  let tabId: number | undefined;
  try {
    const start = await startConnect(instanceUrl, describeClient(navigator.userAgent));
    const code = document.createElement('code');
    code.textContent = start.userCode;
    connectCodeLine.replaceChildren(...tNodes('options_connectCode', { code }));
    setConnecting(true);
    setStatus('');
    tabId = (await chrome.tabs.create({ url: start.verificationUrl })).id;
    const outcome = await waitForApproval({
      poll: () => pollConnect(instanceUrl, start.deviceCode),
      interval: start.interval,
      expiresIn: start.expiresIn,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      signal: controller.signal,
    });
    if (outcome.status !== 'approved') {
      const messages = {
        denied: t('options_connectDenied'),
        expired: t('options_connectExpired'),
        cancelled: t('options_connectCancelled'),
      } as const;
      setStatus(messages[outcome.status], 'error');
      return;
    }
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => undefined);
    tabId = undefined;
    const previous = await getConnectionSettings();
    // Disconnected while the answer was on its way: nothing is kept.
    if (epoch !== connectionEpoch) return;
    const sameInstance = previous.instanceUrl === instanceUrl;
    const next: ConnectionSettings = {
      ...previous,
      instanceUrl,
      connectedAs: outcome.user?.name ?? '',
      // Another instance's patterns and projects do not apply to this one.
      ...(sameInstance ? {} : { serverMappings: [], serverProjects: [], serverSyncedAt: 0 }),
      ...(previous.instanceUrl.trim() ? {} : { projectMappings: await takeKeptMappings(instanceUrl) }),
    };
    const kept = ++connectionEpoch;
    await setInstanceApiKey(instanceUrl, outcome.apiKey);
    if (kept !== connectionEpoch) return;
    stored = next;
    await setConnectionSettings(next);
    if (!sameInstance) await forgetInstanceData();
    mappings = editableMappings(next);
    apiKeyEl.value = outcome.apiKey;
    apiKeyFallback.open = false;
    await syncServerPatterns(next, kept);
    if (kept !== connectionEpoch) return;
    projectOptions = syncedProjectOptions();
    renderMappings();
    const catalogs = await refreshCatalogs(stored, kept);
    if (kept !== connectionEpoch) return;
    const parts = [
      outcome.user ? t('options_connectedAs', { name: outcome.user.name }) : t('options_connectedNoAuth'),
      tn('options_serverPatterns', stored.serverMappings.length),
    ];
    if (catalogs.failed > 0) parts.push(tn('options_catalogsFailed', catalogs.failed));
    setStatus(parts.join(' '), catalogs.failed > 0 || serverSyncError ? 'error' : 'ok');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => undefined);
    if (pendingConnect === controller) pendingConnect = null;
    setConnecting(false);
  }
}

refreshServerBtn.addEventListener('click', () => {
  const settings = stored;
  // Before any await, so the click still counts as the user gesture.
  const permission = requestInstanceHostPermission(settings.instanceUrl);
  const epoch = connectionEpoch;
  void (async () => {
    await permission;
    setMappingsStatus(t('options_serverReading'));
    if (await syncServerPatterns(settings, epoch)) {
      projectOptions = syncedProjectOptions();
      renderMappings();
      setMappingsStatus(tn('options_serverPatterns', stored.serverMappings.length), 'ok');
    } else if (epoch === connectionEpoch) {
      setMappingsStatus(t('options_serverSyncFailed', { error: serverSyncError }), 'error');
    }
  })();
});

addToServerBtn.addEventListener('click', () => {
  const pattern = addPatternEl.value.trim();
  const projectId = addProjectEl.value ? Number(addProjectEl.value) : null;
  if (!pattern) {
    setMappingsStatus(t('options_addNeedsPattern'), 'error');
    return;
  }
  if (projectId == null) {
    setMappingsStatus(t('options_addNeedsProject'), 'error');
    return;
  }
  const prefixError = prefixesError(addPrefixEl.value, addTestPrefixEl.value);
  if (prefixError) {
    setMappingsStatus(prefixError, 'error');
    return;
  }
  const label = addProjectEl.selectedOptions[0]?.textContent ?? `#${projectId}`;
  const settings = stored;
  const epoch = connectionEpoch;
  // Disabled until the pattern is sent, so a second click sends it once.
  addingToServer = true;
  addToServerBtn.disabled = true;
  void (async () => {
    try {
      try {
        await addServerPattern(settings, projectId, {
          pattern,
          environment: addEnvironmentEl.value.trim() || null,
          branch: addBranchEl.value.trim() || null,
          pathPrefix: normalizePathPrefix(addPrefixEl.value),
          testPathPrefix: normalizePathPrefix(addTestPrefixEl.value),
        });
      } catch (err) {
        setMappingsStatus(err instanceof Error ? err.message : String(err), 'error');
        return;
      }
      addPatternEl.value = '';
      addEnvironmentEl.value = '';
      addBranchEl.value = '';
      addPrefixEl.value = '';
      addTestPrefixEl.value = '';
      await syncServerPatterns(settings, epoch);
      await refreshCatalogs(stored, epoch);
      if (epoch !== connectionEpoch) return;
      setMappingsStatus(tNodes('options_added', { pattern: patternView(pattern), project: strong(label) }), 'ok');
    } finally {
      addingToServer = false;
      renderAddSite();
    }
  })();
});

addLocallyBtn.addEventListener('click', () => {
  const pattern = addPatternEl.value.trim();
  if (!pattern) {
    setMappingsStatus(t('options_addNeedsPattern'), 'error');
    return;
  }
  const prefixError = prefixesError(addPrefixEl.value, addTestPrefixEl.value);
  if (prefixError) {
    setMappingsStatus(prefixError, 'error');
    return;
  }
  const projectId = addProjectEl.value ? Number(addProjectEl.value) : null;
  mappings.push({
    urlPattern: pattern,
    projectId,
    projectLabel: projectId != null ? (addProjectEl.selectedOptions[0]?.textContent ?? '') : '',
    branch: addBranchEl.value.trim(),
    pathPrefix: normalizePathPrefix(addPrefixEl.value) ?? '',
    testPathPrefix: normalizePathPrefix(addTestPrefixEl.value) ?? '',
  });
  renderMappings();
  addPatternEl.value = '';
  addPrefixEl.value = '';
  addTestPrefixEl.value = '';
  setMappingsStatus(t('options_addedLocally'), 'ok');
});

/**
 * Use an API key instead: checks the address and the key typed against the
 * instance, keeps them, then reads its patterns and catalogs as Connect does.
 */
apiKeySaveBtn.addEventListener('click', () => {
  const typed = { instanceUrl: instanceUrlEl.value.trim(), apiKey: apiKeyEl.value.trim() };
  // Before any await, so the click still counts as the user gesture.
  const permission = requestInstanceHostPermission(typed.instanceUrl);
  const epoch = connectionEpoch;
  whileRunning(apiKeySaveBtn, async () => {
    await connectWithKey(typed, permission, epoch);
  });
});

/**
 * Checks `typed`'s address and key against the instance, keeps them, then reads its patterns and catalogs as Connect
 * does. `permission` is the host permission asked for inside the click; `desktop` says the address and the key are
 * the paired desktop app's. Answers whether the connection was kept.
 */
async function connectWithKey(
  typed: { instanceUrl: string; apiKey: string },
  permission: Promise<boolean>,
  epoch: number,
  desktop = false,
): Promise<boolean> {
  if (!typed.instanceUrl) {
    setStatus(t('common_enterInstanceUrl'), 'error');
    return false;
  }
  setStatus(t('options_testing'));
  if (!(await permission)) {
    setStatus(t('options_accessDenied'), 'error');
    return false;
  }
  const sameInstance = stored.instanceUrl === typed.instanceUrl;
  const settings: ConnectionSettings = {
    ...stored,
    instanceUrl: typed.instanceUrl,
    ...(sameInstance ? {} : { serverMappings: [], serverProjects: [], serverSyncedAt: 0, connectedAs: '' }),
  };
  const result = await testConnection(settings, typed.apiKey);
  if (!result.ok) {
    setStatus(result.error, 'error');
    return false;
  }
  // Disconnected while the instance was tested: nothing is kept.
  if (epoch !== connectionEpoch) return false;
  const restored = stored.instanceUrl.trim() ? null : await takeKeptMappings(settings.instanceUrl);
  const kept = ++connectionEpoch;
  await setInstanceApiKey(settings.instanceUrl, typed.apiKey);
  // The paired app's token, kept as the key, is marked so: Unpair leaves it sent only to the app that proves it.
  const paired = await getDesktopSettings().catch(() => null);
  if (paired) await markDesktopApiKey(paired);
  if (kept !== connectionEpoch) return false;
  stored = restored ? { ...settings, projectMappings: restored } : settings;
  await setConnectionSettings(stored);
  if (!sameInstance) await forgetInstanceData();
  mappings = editableMappings(stored);
  renderInstanceState();
  await syncServerPatterns(settings, kept);
  try {
    projectOptions = await fetchProjects(settings);
  } catch {
    projectOptions = syncedProjectOptions();
  }
  if (kept !== connectionEpoch) return true;
  renderMappings();
  const catalogs = await refreshCatalogs(stored, kept);
  if (kept !== connectionEpoch) return true;
  const parts = [tn('options_connected', projectOptions.length)];
  // The API key travels on every catalog fetch; over plain HTTP it travels in
  // the clear. Worth saying once, at the moment the choice is made — not a
  // reason to refuse a local instance on `http://localhost`. The desktop app
  // answers on this computer's loopback alone, which its token never leaves.
  if (/^http:\/\//i.test(settings.instanceUrl) && typed.apiKey && !desktop) parts.push(t('options_plainHttp'));
  if (catalogs.failed > 0) parts.push(tn('options_catalogsFailed', catalogs.failed));
  setStatus(parts.join(' '), catalogs.failed > 0 ? 'error' : 'ok');
  return true;
}

/** Save keeps the lines of this browser, then fetches the catalogs of the projects they map. */
saveBtn.addEventListener('click', () => {
  const instanceUrl = stored.instanceUrl;
  // Before any await, so the click still counts as the user gesture.
  const permission = requestInstanceHostPermission(instanceUrl);
  const epoch = connectionEpoch;
  whileRunning(saveBtn, async () => {
    if (!instanceUrl.trim()) {
      setMappingsStatus(t('common_enterInstanceUrl'), 'error');
      return;
    }
    const granted = await permission;

    const badPrefix = mappings.find((m) => prefixesError(m.pathPrefix, m.testPathPrefix));
    if (badPrefix) {
      setMappingsStatus(prefixesError(badPrefix.pathPrefix, badPrefix.testPathPrefix), 'error');
      return;
    }
    const valid = mappings.filter((m) => m.urlPattern.trim() && m.projectId != null);
    const incompleteCount = mappings.length - valid.length;

    const projectMappings = valid.map((m) => ({
      urlPattern: m.urlPattern.trim(),
      projectId: m.projectId!,
      projectLabel: m.projectLabel,
      ...(m.branch.trim() ? { branch: m.branch.trim() } : {}),
      ...pathPrefixFields(m.pathPrefix, m.testPathPrefix),
    }));
    if (!(await writeConnection(epoch, instanceUrl, (current) => ({ ...current, projectMappings })))) return;
    await syncServerPatterns(stored, epoch);

    const catalogs = await refreshCatalogs(stored, epoch);
    if (epoch !== connectionEpoch) return;

    const parts = [tn('options_saved', valid.length)];
    if (incompleteCount > 0) parts.push(tn('options_skipped', incompleteCount));
    // Without the host permission the catalog can still be fetched from this
    // page if the instance happens to allow the origin, but the background
    // refresh never can — so the catalog would silently stop updating.
    if (!granted) parts.push(t('options_refreshDenied'));
    if (catalogs.projects > 0) {
      parts.push(
        t('options_cached', {
          functions: tn('options_functionCount', catalogs.functions),
          projects: tn('options_projectCount', catalogs.projects),
        }),
      );
    }
    if (catalogs.failed > 0) parts.push(tn('options_catalogsFailed', catalogs.failed));
    setMappingsStatus(parts.join(' '), catalogs.failed > 0 ? 'error' : 'ok');
  });
});

/**
 * Gives back the host permission for an instance we are no longer connected to,
 * so "Disconnect" leaves no standing grant for a host the extension has no
 * further business with. Never touches anything but that one origin: a
 * recording's own granted site is a separate grant with its own lifetime.
 */
async function revokeInstanceHostPermission(instanceUrl: string): Promise<void> {
  const pattern = originPattern(instanceUrl);
  if (!pattern) return;
  // The desktop app paired at the same address keeps it for Run with Playwright; Unpair gives it back.
  const desktop = await getDesktopSettings().catch(() => null);
  if (desktop && hostPattern(desktop.url) === pattern) return;
  await chrome.permissions.remove({ origins: [pattern] }).catch(() => undefined);
}

disconnectBtn.addEventListener('click', () => {
  // At once: a write any earlier action still has to make is dropped from here on.
  connectionEpoch++;
  pendingConnect?.abort();
  void (async () => {
    const previousUrl = stored.instanceUrl;
    const keptLines = await keepMappings(previousUrl, (await getConnectionSettings()).projectMappings).catch(() => 0);
    await clearConnectionSettings();
    await clearInstanceApiKey().catch(() => undefined);
    await clearConnectionHealth().catch(() => undefined);
    stored = await getConnectionSettings();
    serverSyncError = '';
    await forgetInstanceData();
    await revokeInstanceHostPermission(previousUrl);
    instanceUrlEl.value = '';
    apiKeyEl.value = '';
    projectOptions = [];
    mappings = [];
    renderMappings();
    renderServerMappings();
    renderInstanceState();
    setStatus(keptLines > 0 ? tn('options_disconnectedKept', keptLines) : t('options_disconnected'), 'ok');
  })();
});

/**
 * The Language setting: follow the browser, or one of the shipped languages,
 * each named in itself. The background worker stores the choice with its
 * catalog; this page then reads it again and redraws in the new language.
 */
function renderLanguageSelect(): void {
  const follow = document.createElement('option');
  follow.value = '';
  follow.textContent = t('options_languageBrowser', { language: languageName(browserCatalogLanguage()) });
  const options = LANGUAGES.map((code) => {
    const option = document.createElement('option');
    option.value = code;
    option.lang = languageTag(code);
    option.textContent = languageName(code);
    return option;
  });
  languageSelect.replaceChildren(follow, ...options);
  languageSelect.value = chosenLanguage() ?? '';
  renderDraftNote();
}

/** Under the setting, in a draft language: the translation is a draft, and where to suggest a correction. */
function renderDraftNote(): void {
  const shown = chosenLanguage() ?? browserCatalogLanguage();
  draftNote.hidden = !isDraftLanguage(shown);
  if (draftNote.hidden) {
    draftNote.replaceChildren();
    return;
  }
  const link = document.createElement('a');
  link.href = TRANSLATION_ISSUE_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = t('options_draftNoteLink');
  draftNote.replaceChildren(...tNodes('options_draftNote', { link }));
}

languageSelect.addEventListener('change', () => {
  const code = (languageSelect.value || null) as Language | null;
  void (async () => {
    let answer: { ok: boolean; error?: string } | undefined;
    try {
      answer = (await chrome.runtime.sendMessage({ type: 'piwi-set-language', code })) as typeof answer;
    } catch (err) {
      answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await initI18n();
    localizeDocument();
    decorateIcons();
    renderLanguageSelect();
    renderMappings();
    renderServerMappings();
    renderInstanceState();
    renderEditorPill();
    void renderDesktopState();
    if (answer?.ok) writeStatus(languageStatusEl, t('options_languageSaved'), 'ok');
    else {
      const error = answer?.error ?? t('common_workerNoAnswer');
      writeStatus(languageStatusEl, t('options_languageFailed', { error }), 'error');
    }
  })();
});

// Send to editor: the pairing lives in extension storage; the editor's origin is granted inside the Pair click.
const editorAddressEl = document.getElementById('editor-address') as HTMLInputElement;
const editorPairBtn = document.getElementById('editor-pair') as HTMLButtonElement;
const editorUnpairBtn = document.getElementById('editor-unpair') as HTMLButtonElement;
const editorStatusEl = document.getElementById('editor-status') as HTMLElement;
const editorPill = document.getElementById('editor-pill') as HTMLElement;
let editorPaired = false;

function renderEditorPill(): void {
  setPill(editorPill, editorPaired, 'options_statePaired', 'options_stateNotPaired');
}

async function renderEditorPairing(): Promise<void> {
  const pairing = await getEditorPairing();
  editorPaired = !!pairing;
  writeStatus(
    editorStatusEl,
    pairing ? tNodes('options_editorPaired', { url: patternView(pairing.url) }) : '',
    pairing ? 'ok' : '',
  );
  editorUnpairBtn.hidden = !pairing;
  editorPairBtn.classList.toggle('primary', !pairing);
  renderEditorPill();
  void renderSiteAccess();
}

editorPairBtn.addEventListener('click', () => {
  const pairing = parsePairing(editorAddressEl.value);
  if (!pairing) {
    writeStatus(editorStatusEl, t('options_editorInvalid'), 'error');
    return;
  }
  // Requested before anything is awaited: the permission prompt needs the live click.
  const granted = requestOrigins([editorOriginPattern(pairing)]);
  whileRunning(editorPairBtn, async () => {
    if (!(await granted)) {
      writeStatus(editorStatusEl, t('options_editorPermission'), 'error');
      return;
    }
    await setEditorPairing(pairing);
    editorAddressEl.value = '';
    await renderEditorPairing();
  });
});

editorUnpairBtn.addEventListener('click', () => {
  void (async () => {
    const pairing = await getEditorPairing();
    await setEditorPairing(null);
    if (pairing) await chrome.permissions.remove({ origins: [editorOriginPattern(pairing)] }).catch(() => false);
    await renderEditorPairing();
  })();
});

// ---------------------------------------------------------------------------
// The desktop app, for Run with Playwright

const desktopUrlEl = document.getElementById('desktop-url') as HTMLInputElement;
const desktopTokenEl = document.getElementById('desktop-token') as HTMLInputElement;
const desktopStatusEl = document.getElementById('desktop-status')!;
const desktopPill = document.getElementById('desktop-pill') as HTMLElement;
const desktopPairBtn = document.getElementById('desktop-pair') as HTMLButtonElement;
const desktopPairPanel = document.getElementById('desktop-pair-panel') as HTMLElement;
const desktopCodeLine = document.getElementById('desktop-code-line')!;
const desktopForgetBtn = document.getElementById('desktop-forget') as HTMLButtonElement;
const desktopManual = document.getElementById('desktop-manual') as HTMLDetailsElement;
/** Set while a pairing waits for the Allow in the app's window; aborting it stops the wait. */
let pendingDesktopPairing: AbortController | null = null;

function setDesktopStatus(text: StatusText, kind: StatusKind = ''): void {
  writeStatus(desktopStatusEl, text, kind);
}

/** The card as the stored pairing says: its badge, its address, and Unpair. */
async function renderDesktopState(): Promise<void> {
  const desktop = await getDesktopSettings();
  pairedDesktop = desktop;
  renderDesktopAsInstance();
  setPill(desktopPill, !!desktop, 'options_statePaired', 'options_stateNotPaired');
  desktopPairBtn.classList.toggle('primary', !desktop);
  desktopForgetBtn.hidden = !desktop;
  if (desktop && !desktopUrlEl.value) desktopUrlEl.value = desktop.url;
  if (!desktop && !desktopUrlEl.value) desktopUrlEl.value = DESKTOP_DEFAULT_URL;
  void renderSiteAccess();
}

/** Keeps a pairing that works: checked against the app first, then stored and said. */
async function keepDesktopPairing(url: string, token: string): Promise<void> {
  const check = await testDesktop({ url, token });
  if (!check.ok) {
    setDesktopStatus(check.error, 'error');
    return;
  }
  // The instance kept with the earlier pairing's token, or with this one, goes on proving it.
  const previous = await getDesktopSettings().catch(() => null);
  if (previous) await markDesktopApiKey(previous);
  await setDesktopSettings({ url, token });
  await markDesktopApiKey({ url, token });
  desktopUrlEl.value = url;
  desktopTokenEl.value = '';
  desktopManual.open = false;
  setDesktopStatus(tNodes('options_desktopPairedAt', { url: patternView(url) }), 'ok');
  await renderDesktopState();
}

function setDesktopPairing(active: boolean): void {
  desktopPairPanel.hidden = !active;
  if (!active) desktopCodeLine.replaceChildren();
}

/**
 * Pair: the app's window shows the request with a code this card shows too;
 * the developer's Allow there hands this extension the app's token on the next
 * poll. The one loopback origin is asked for first, inside the click.
 */
desktopPairBtn.addEventListener('click', () => {
  const url = desktopOrigin(desktopUrlEl.value);
  if (!url) {
    setDesktopStatus(t('options_desktopNotLoopback'), 'error');
    return;
  }
  const granted = requestOrigins([hostPattern(url)]);
  // Disabled until this pairing ends, so a second click starts no second one.
  desktopPairBtn.disabled = true;
  void (async () => {
    if (!(await granted)) {
      setDesktopStatus(t('options_desktopNeedsAccess'), 'error');
      desktopPairBtn.disabled = false;
      return;
    }
    pendingDesktopPairing?.abort();
    const controller = new AbortController();
    pendingDesktopPairing = controller;
    setDesktopStatus(t('options_desktopPairStarting'));
    try {
      const start = await startDesktopPairing(url, describeClient(navigator.userAgent));
      const code = document.createElement('code');
      code.textContent = start.code;
      desktopCodeLine.replaceChildren(...tNodes('options_desktopPairCode', { code }));
      setDesktopPairing(true);
      setDesktopStatus(start.windowOpen ? '' : t('options_desktopPairNoWindow'));
      const outcome = await waitForApproval({
        poll: () => pollDesktopPairing(url, start),
        interval: start.interval,
        expiresIn: start.expiresIn,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        signal: controller.signal,
      });
      setDesktopPairing(false);
      if (outcome.status === 'approved') {
        await keepDesktopPairing(url, outcome.apiKey);
        return;
      }
      const messages = {
        denied: t('options_desktopPairDenied'),
        expired: t('options_desktopPairExpired'),
        cancelled: t('options_desktopPairCancelled'),
      } as const;
      setDesktopStatus(messages[outcome.status], 'error');
    } catch (err) {
      setDesktopStatus(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      if (pendingDesktopPairing === controller) pendingDesktopPairing = null;
      setDesktopPairing(false);
      desktopPairBtn.disabled = false;
    }
  })();
});

document.getElementById('desktop-pair-cancel')!.addEventListener('click', () => {
  pendingDesktopPairing?.abort();
});

/** Pair by hand: the address and the token pasted from the app's Setup page. */
const desktopSaveBtn = document.getElementById('desktop-save') as HTMLButtonElement;
desktopSaveBtn.addEventListener('click', () => {
  const url = desktopOrigin(desktopUrlEl.value);
  const token = desktopTokenEl.value.trim();
  if (!url) {
    setDesktopStatus(t('options_desktopNotLoopback'), 'error');
    return;
  }
  if (!token) {
    setDesktopStatus(t('options_desktopNeedsToken'), 'error');
    return;
  }
  // Asked first, while the click still counts as a user gesture; the one loopback origin only.
  const granted = requestOrigins([hostPattern(url)]);
  whileRunning(desktopSaveBtn, async () => {
    if (!(await granted)) {
      setDesktopStatus(t('options_desktopNeedsAccess'), 'error');
      return;
    }
    setDesktopStatus(t('options_testing'));
    await keepDesktopPairing(url, token);
  });
});

desktopForgetBtn.addEventListener('click', () => {
  void (async () => {
    const desktop = await getDesktopSettings();
    // The instance kept at the app's address with its token goes on sending it only to a program that proves it.
    if (desktop) await markDesktopApiKey(desktop).catch(() => undefined);
    await clearDesktopSettings();
    // The instance kept at the app's address goes on using it; Disconnect gives it back.
    const pattern = desktop ? hostPattern(desktop.url) : null;
    if (pattern && pattern !== originPattern(stored.instanceUrl)) {
      await chrome.permissions.remove({ origins: [pattern] }).catch(() => false);
    }
    desktopTokenEl.value = '';
    setDesktopStatus(t('options_desktopForgotten'), 'ok');
    await renderDesktopState();
  })();
});

void getDesktopSettings().then((desktop) => {
  if (desktop) setDesktopStatus(tNodes('options_desktopPairedAt', { url: patternView(desktop.url) }), 'ok');
  return renderDesktopState();
});

// ---------------------------------------------------------------------------
// The sites Piwi Picker may run on

const siteAccessEl = document.getElementById('site-access') as HTMLElement;
const siteAccessStatusEl = document.getElementById('site-access-status') as HTMLElement;

/** What a grant held by the instance or a pairing says, and where it is given back. */
const GRANT_USE_NOTES: Record<GrantUse, MessageKey> = {
  instance: 'options_siteUseInstance',
  desktop: 'options_siteUseDesktop',
  editor: 'options_siteUseEditor',
};

/** The grant each use and each running tool holds now. */
async function grantHolders(): Promise<GrantHolders> {
  const [desktop, editor, recording, replay] = await Promise.all([
    getDesktopSettings().catch(() => null),
    getEditorPairing().catch(() => null),
    getRecordingState().catch(() => null),
    getReplayState().catch(() => null),
  ]);
  const replaying = !!replay && !replay.finished && (replay.status === 'running' || replay.status === 'paused');
  return {
    instance: originPattern(stored.instanceUrl),
    desktop: desktop ? hostPattern(desktop.url) : null,
    editor: editor ? editorOriginPattern(editor) : null,
    recording: recording?.active ? recording.grantedOriginPattern : null,
    replay: replaying ? originPattern(replay.origin) : null,
  };
}

/** Bumped by each render, so the last one started is the one the card shows. */
let siteAccessRender = 0;

/**
 * The card lists every site granted, with Revoke; a site a recording or a
 * replay runs on, or the instance or a pairing uses, says so instead.
 */
async function renderSiteAccess(): Promise<void> {
  const render = ++siteAccessRender;
  const [granted, holders] = await Promise.all([
    chrome.permissions.getAll().catch((): chrome.permissions.Permissions => ({ origins: [] })),
    grantHolders(),
  ]);
  if (render !== siteAccessRender) return;
  const grants = siteGrants(granted.origins ?? [], holders);
  siteAccessEl.replaceChildren();
  if (grants.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-mappings';
    empty.textContent = t('options_siteAccessEmpty');
    siteAccessEl.appendChild(empty);
    return;
  }
  for (const grant of grants) {
    const row = document.createElement('div');
    row.className = 'grant-row';
    const pattern = document.createElement('span');
    pattern.className = 'pattern';
    pattern.appendChild(patternView(grant.pattern));
    const notes = [
      ...grant.uses.map((use) => t(GRANT_USE_NOTES[use])),
      ...(grant.busy ? [t(grant.busy === 'recording' ? 'options_siteBusyRecording' : 'options_siteBusyReplay')] : []),
    ];
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = notes.join(' ');
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'danger small';
    revoke.textContent = t('options_siteRevoke');
    revoke.setAttribute('aria-label', t('options_siteRevokeLabel', { site: grant.pattern }));
    withIcon(revoke, 'unlink');
    revoke.disabled = !canRevoke(grant);
    revoke.addEventListener('click', () => {
      whileRunning(revoke, () => revokeSite(grant.pattern));
    });
    row.append(pattern, ...(notes.length ? [meta] : []), revoke);
    siteAccessEl.appendChild(row);
  }
}

/** Takes the grant of `pattern` back, unless a recording, a replay, the instance or a pairing has come to hold it. */
async function revokeSite(pattern: string): Promise<void> {
  const [grant] = siteGrants([pattern], await grantHolders());
  if (!grant || !canRevoke(grant)) {
    await renderSiteAccess();
    return;
  }
  const removed = await chrome.permissions.remove({ origins: [pattern] }).catch(() => false);
  writeStatus(
    siteAccessStatusEl,
    tNodes(removed ? 'options_siteRevoked' : 'options_siteRevokeFailed', { site: patternView(pattern) }),
    removed ? 'ok' : 'error',
  );
  await renderSiteAccess();
}

chrome.permissions.onAdded.addListener(() => void renderSiteAccess());
chrome.permissions.onRemoved.addListener(() => void renderSiteAccess());
chrome.storage.onChanged.addListener((changes, area) => {
  const recordingOrReplay = area === 'session' && (RECORDING_KEY in changes || REPLAY_KEY in changes);
  if (recordingOrReplay || (area === 'local' && CONNECTION_KEY in changes)) void renderSiteAccess();
});

renderLanguageSelect();
void loadInitial();
void renderSiteAccess();
void renderEditorPairing();

// Every listener is attached from here on; the e2e specs wait for `html[data-ready]` before they interact.
document.documentElement.dataset.ready = 'true';
