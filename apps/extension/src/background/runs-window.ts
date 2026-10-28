/**
 * The worker's side of the Runs window: the one `RunHubs` of the worker, wired to the paired editor, the paired
 * desktop app, the secret area and the browser's WebSocket; the window's port (`RUNS_PORT`, taken from `runs.html` alone), which gets the state at
 * each change, what each code written at a stop came to and the frames of the live views it watches, and passes the
 * window's commands on, its views stopped as it closes; the popup's Runs tile; and the global shortcut.
 */
import { parseLiveAnswer } from '@piwitests/core/run-hub';
import {
  EDITOR_PAIRING_KEY,
  editorOriginPattern,
  getEditorPairing,
  parseEditorPairing,
} from '../shared/editor-pairing.js';
import { DESKTOP_PAIRED_AT_KEY, getDesktopSettings } from '../shared/desktop-settings.js';
import { fetchDesktopHubs } from '../shared/piwi-client.js';
import { secretArea } from '../shared/secret-store.js';
import { hostPattern } from '../shared/web-origin.js';
import { RUNS_PAGE, RUNS_PORT, liveRuns, parseRunsRequest, type RunsEvent } from '../shared/runs.js';
import { browserSocket } from './hub-connection.js';
import { RunHubs, type RunsViewer } from './run-hubs.js';

/** The Runs window's size: beside the test's window, the width of a phone. */
const RUNS_WINDOW = { width: 440, height: 720 };

export const runHubs = new RunHubs({
  pairing: async () => {
    const stored = await getEditorPairing();
    // Checked as a pasted pairing is: a loopback address and a token.
    return stored ? parseEditorPairing(`${stored.url}#${stored.token}`) : null;
  },
  granted: (pairing) => chrome.permissions.contains({ origins: [editorOriginPattern(pairing)] }),
  fetch: (url, init) => fetch(url, init),
  open: browserSocket,
  readHubs: async () => parseLiveAnswer({ hubs: await secretArea().get('hubs') }) ?? [],
  writeHubs: async (hubs) => {
    if (hubs.length > 0) await secretArea().set('hubs', hubs);
    else await secretArea().remove('hubs');
  },
  desktopHubs: async () => {
    const desktop = await getDesktopSettings();
    if (!desktop) return { discovery: 'unpaired', hubs: [] };
    if (!(await chrome.permissions.contains({ origins: [hostPattern(desktop.url)] }))) {
      return { discovery: 'no-access', hubs: [] };
    }
    const answer = await fetchDesktopHubs(desktop);
    return 'hubs' in answer ? { discovery: 'found', hubs: answer.hubs } : { discovery: answer.failure, hubs: [] };
  },
});

/** The browser windows of the Runs windows connected now, by their port. */
const runsWindows = new Map<chrome.runtime.Port, number | null>();

/** Whether a port comes from the extension's own Runs page: never a content script, nor another extension. */
export function fromRunsPage(sender: chrome.runtime.MessageSender | undefined): boolean {
  if (!sender || sender.id !== chrome.runtime.id || !sender.url) return false;
  return sender.url.split(/[?#]/)[0] === chrome.runtime.getURL(RUNS_PAGE);
}

function serveRunsPort(port: chrome.runtime.Port): void {
  runsWindows.set(port, null);
  const post = (event: RunsEvent) => {
    try {
      port.postMessage(event);
    } catch {
      // The window closed meanwhile.
    }
  };
  // The window as a viewer of the live views it watches: their frames, and the word that one ended.
  const viewer: RunsViewer = {
    frame: (frame) => post({ type: 'frame', ...frame }),
    ended: (view) => post({ type: 'view-ended', ...view }),
  };
  const unlisten = runHubs.listen(
    () => post({ type: 'state', state: runHubs.state(viewer) }),
    (code) => post({ type: 'code', ...code }),
  );
  post({ type: 'state', state: runHubs.state(viewer) });
  if (!runHubs.connected()) void runHubs.find();
  port.onMessage.addListener((raw: unknown) => {
    const request = parseRunsRequest(raw);
    if (!request) return;
    if (request.type === 'window') runsWindows.set(port, request.windowId);
    else if (request.type === 'find') void runHubs.find();
    else if (request.type === 'command') {
      const { id, ...command } = request;
      void runHubs.command(command, viewer).then((answer) => post({ type: 'answer', id, ...answer }));
    }
  });
  port.onDisconnect.addListener(() => {
    unlisten();
    runHubs.unwatchAll(viewer);
    runsWindows.delete(port);
  });
}

/** The browser window a Runs page shows in, from the ports, else from the browser's list of the extension's pages. */
async function openRunsWindowId(url: string): Promise<number | null> {
  for (const windowId of runsWindows.values()) if (windowId !== null) return windowId;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.TAB],
      documentUrls: [url],
    });
    return contexts.find((context) => context.windowId >= 0)?.windowId ?? null;
  } catch {
    // Firefox before `getContexts`: the ports alone.
    return null;
  }
}

/** The popup's Runs tile: the Runs window comes to the front, opened in a small window of its own when none is. */
export async function openRunsWindow(): Promise<{ ok: boolean }> {
  const url = chrome.runtime.getURL(RUNS_PAGE);
  const windowId = await openRunsWindowId(url);
  if (windowId !== null) {
    try {
      await chrome.windows.update(windowId, { focused: true });
      return { ok: true };
    } catch {
      // Closed meanwhile: a new one.
    }
  }
  try {
    await chrome.windows.create({ url, type: 'popup', ...RUNS_WINDOW, focused: true });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** What the popup's Runs tile shows: whether a hub answers, and how many runs are live. */
export async function runsSummary(): Promise<{ connected: boolean; runs: number }> {
  await runHubs.ready();
  return { connected: runHubs.connected(), runs: liveRuns(runHubs.state()).length };
}

/** Starts finding the hubs, and follows the pairings and their grants. */
export function startRunHubs(): void {
  void runHubs.find();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (EDITOR_PAIRING_KEY in changes || DESKTOP_PAIRED_AT_KEY in changes)) void runHubs.find();
  });
  chrome.permissions.onRemoved.addListener(() => void runHubs.find());
  chrome.permissions.onAdded.addListener(() => {
    if (!runHubs.connected()) void runHubs.find();
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== RUNS_PORT) return;
    if (!fromRunsPage(port.sender)) {
      port.disconnect();
      return;
    }
    serveRunsPort(port);
  });
  // What the run shortcut does, for the e2e suite, which cannot press a shortcut the browser holds.
  (globalThis as { __piwiRunShortcut?: () => Promise<unknown> }).__piwiRunShortcut = () => runHubs.shortcut();
}
