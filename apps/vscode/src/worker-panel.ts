/**
 * "Piwi: worker N": a webview beside the editor that watches one worker's slot of a run (`piwi/laneView`), running or
 * stopped: the page of the test the worker there runs, a few images a second, through its tests and stops and the
 * worker Playwright starts in its place, the last image kept, dimmed, until the next one comes. At a stop of its test,
 * Interact sends clicks and keys to the page (`piwi/pageInput`) and Shift+click picks the element under it
 * (`piwi/pickAt`), as on the paused page; each stop, and each stretch the worker runs between them, is drawn anew, so a
 * message of the panel names the stop it was drawn for. Interact is offered once the service accepts the watch, and
 * stays on through the slot's next stops while the watch goes on; the person's first click, key, wheel or pick drives
 * the stop, and Interact going off gives it back (`piwi/driveStop`). One slot at a time; a stop elsewhere never takes
 * it over. The view ends while the panel is hidden and starts again as it shows. A press, a key, text, the wheel or a
 * pick at a stop make its slot the person's, and the panel hidden or closed offers its held stops to the paused page as
 * new ones (`hooks`). It also watches a CI run's lane through the team instance (`piwi/ciWatch`, `piwi/ciFrame`),
 * read-only: Watch alone, no Interact, input or pick, its caption from the CI sessions, and why the watch ended said
 * under it. One slot, local or CI, at a time. Under the image, the lane's layers (`piwi/laneLayer`, `piwi/ciLayer`):
 * Why it waits and Events, asked for while it watches, and Text and Filmstrip, asked for while their section is open,
 * kept for the slot it shows. The pure half is `run-control.ts`.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { isViewFrameData, readViewInput } from '@piwitests/core/run-view';
import {
  CI_FRAME_NOTIFICATION,
  CI_LAYER_NOTIFICATION,
  CI_WATCH_REQUEST,
  DRIVE_STOP_REQUEST,
  LANE_FRAME_NOTIFICATION,
  LANE_LAYER_NOTIFICATION,
  LANE_VIEW_REQUEST,
  PAGE_INPUT_REQUEST,
  PICK_AT_REQUEST,
  type CiFrame,
  type CiLayer,
  type CiWatchParams,
  type LaneFrame,
  type LaneViewLayer,
  type LaneViewParams,
  type PausedImage,
  type PickAtParams,
  type PickAtResult,
  type RunControlResult,
  type RunSession,
} from '@piwitests/editor/protocol';
import {
  actsOnPage,
  ciKey,
  ciLaneCaption,
  ciLaneRedraws,
  ciLaneTakes,
  ciLaneTitle,
  frameIsCurrent,
  giveBackParams,
  imageClickOf,
  LANE_LAYER_PARTS,
  laneKeepsInteract,
  laneLayersAsked,
  laneLayersMessage,
  laneLayersNote,
  laneShown,
  NO_LANE_LAYERS,
  pagePoint,
  pausedPageHtml,
  pausedPageViewChange,
  picksOnImage,
  withLaneLayer,
  workerName,
  type CiLane,
  type CiSessions,
  type LaneLayerPart,
  type LaneLayersShown,
  type LaneSections,
  type LaneShown,
  type PausedPageView,
  type ShownStop,
} from './run-control';

export interface WorkerPanel extends vscode.Disposable {
  /** Watch the slot `lane` of the run `ref` in the panel, opened beside the editor without focus; what came of it. */
  open(ref: string, lane: number): Promise<RunControlResult>;
  /** Watch a CI run's lane in the panel, read-only, opened beside the editor without focus; what came of it. */
  openCi(lane: CiLane): Promise<RunControlResult>;
  /** The CI sessions changed: what the panel says of the CI lane it shows follows. */
  ciChanged(sessions: CiSessions): void;
  /** Whether the panel shows the slot `lane` of the run `ref`, in sight, and watches it. */
  watches(ref: string, lane: number): boolean;
  /** The editor group the panel shows in while in sight; undefined otherwise. */
  column(): vscode.ViewColumn | undefined;
  /** The sessions changed: what the panel says of its slot follows, `stops` at their lines now. */
  changed(sessions: ReadonlyMap<string, RunSession>, stops: readonly ShownStop[]): void;
  /** What the panel shows; null while it is closed. */
  view(): PausedPageView | null;
  /** A message of the panel's script: the view turned on or off, Interact, input, a pick. */
  message(message: unknown): Promise<void>;
}

const NO_ANSWER = 'The editor service did not answer.';

/** What the run view hears of the panel. */
interface WorkerPanelHooks {
  /** The person sent a press, a key, text, the wheel or a pick to `stop`'s page (`actsOnPage`). */
  acted(stop: ShownStop): void;
  /** The panel was hidden or closed, or stopped watching: the stops it showed may go to the paused page. */
  changed(): void;
}

export function createWorkerPanel(
  context: vscode.ExtensionContext,
  lc: LanguageClient,
  hooks: WorkerPanelHooks,
): WorkerPanel {
  let panel: vscode.WebviewPanel | null = null;
  let target: { ref: string; lane: number } | null = null;
  /** The CI run's lane shown in place of a local slot, the CI sessions it is captioned from, and its watch. */
  let ciTarget: CiLane | null = null;
  let ciSessions: CiSessions = new Map();
  let ciWatching: CiWatchParams | null = null;
  let sessions: ReadonlyMap<string, RunSession> = new Map();
  let stops: readonly ShownStop[] = [];
  let lane: LaneShown = { worker: null, stop: null, caption: '' };
  /** The person keeps Watch on: the view starts again as the panel shows. */
  let wantOn = true;
  let watching: LaneViewParams | null = null;
  /** The views drawn, counted (a slot, then each stop of it): a message of the panel's script names the one it was on. */
  let shown = 0;
  let image: PausedImage | null = null;
  let imageOf: { worker: number; test: string | null; since: string | null } | null = null;
  /** What the last pick or input came to; why the worker sends no image now, until one comes. */
  let note: string | null = null;
  let refused: string | null = null;
  /** The service accepted the watch: Interact is offered, and input goes to the page, only then. */
  let accepted = false;
  /** The service opened the CI watch: a change of its layers goes on it only then. */
  let ciAccepted = false;
  /** Interact is on: kept through the slot's next stops while the watch goes on, off at a stop that takes no input. */
  let interacting = false;
  /** The stop Interact was last on for, which Interact going off gives back. */
  let interactAt: ShownStop | null = null;
  let view: PausedPageView | null = null;
  /** The extension disposes of the panel: nothing is shown again. */
  let disposed = false;
  /** The lane's layers as they came, for the slot shown; the sections open, which ask for theirs; the JPEGs posted. */
  let layers: LaneLayersShown = NO_LANE_LAYERS;
  let sections: LaneSections = { text: false, filmstrip: false };
  let posted = new Set<string>();
  /** Why the page's text asked again did not come, until the next text. */
  let textNote: string | null = null;
  /** The layers the watch asked last, as text: a change of the sections asks again when they differ. */
  let layersSent = '';

  const script = () =>
    panel!.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'paused-page.js')).toString();

  /** The view as it stands, posted to the panel's script, or drawn anew for a new slot (`fresh`). */
  const draw = (fresh = false) => {
    if (ciTarget) {
      view = {
        image,
        caption: ciLaneCaption(ciSessions, ciTarget),
        note: refused ?? note,
        lane: true,
        ci: true,
        pick: null,
        live: { shown, on: !!ciWatching, input: false, interacting: false, clickCounts: false },
        layers: { ...sections, note: null },
      };
      if (!panel) return;
      if (fresh) panel.webview.html = pausedPageHtml(view, randomBytes(16).toString('base64'), script());
      else void panel.webview.postMessage({ type: 'state', view });
      return;
    }
    const stop = lane.stop;
    const input = !!stop && stop.takes.includes('input') && accepted;
    const current = !!imageOf && frameIsCurrent(imageOf, lane.worker);
    view = {
      image,
      caption: lane.caption,
      note: refused ?? note,
      lane: true,
      stale: !!image && !current,
      pick: stop && current && picksOnImage(stop.takes, image) ? { shown } : null,
      live: {
        shown,
        on: !!watching,
        input,
        interacting,
        clickCounts: lane.worker?.takes.includes('input-clicks') ?? true,
      },
      // An action runs in the test's window at the stop the input goes to: Escape on the view goes to the page.
      acting: !!stop?.stop.acting,
      layers: { ...sections, note: laneLayersNote(lane.worker) },
    };
    if (!panel) return;
    if (fresh) panel.webview.html = pausedPageHtml(view, randomBytes(16).toString('base64'), script());
    else void panel.webview.postMessage({ type: 'state', view });
  };

  /** Post the parts of the layers that changed to the panel's script, the strip's JPEGs it lacks alone. */
  const postLayers = (parts: readonly LaneLayerPart[]) => {
    if (!panel || !parts.length) return;
    // The script lets go of the images the strip no longer holds: a later test's call of the same id is posted again.
    if (parts.includes('strip'))
      posted = new Set(layers.strip.flatMap((image) => (posted.has(image.call) ? [image.call] : [])));
    const message = laneLayersMessage(shown, layers, parts, posted, textNote);
    for (const call of Object.keys(message.images ?? {})) posted.add(call);
    void panel.webview.postMessage(message);
  };

  /** A layer of the slot or CI lane the panel watches, kept and posted as it changes what the panel shows. */
  const heardLayer = (layer: Parameters<typeof withLaneLayer>[1]) => {
    const next = withLaneLayer(layers, layer);
    layers = next.shown;
    if (next.changed.includes('text')) textNote = null;
    postLayers(next.changed);
  };

  /** The layers start anew for another slot or CI lane. */
  const forgetLayers = () => {
    layers = NO_LANE_LAYERS;
    posted = new Set();
    textNote = null;
    layersSent = '';
  };

  /**
   * The sections open changed, or a watch was accepted: the watch asks for the layers they show when they differ from
   * those it asked last, the lane's view kept on.
   */
  const askLayers = () => {
    const asked = laneLayersAsked(sections);
    if (asked.join() === layersSent) return;
    if (ciTarget && ciWatching && ciAccepted) {
      layersSent = asked.join();
      ciWatching.layers = asked;
      void lc.sendRequest(CI_WATCH_REQUEST, { ...ciWatching, on: true }).catch(() => undefined);
    } else if (!ciTarget && watching && accepted) {
      layersSent = asked.join();
      watching.layers = asked;
      void lc.sendRequest(LANE_VIEW_REQUEST, { ...watching, on: true }).catch(() => undefined);
    }
  };

  /** Ask the lane's worker for its page's text now; why not shows over the text. */
  const askText = async () => {
    const own = ciTarget ? ciWatching : watching;
    if (!own || !sections.text || !(ciTarget ? ciAccepted : accepted)) return;
    const params = { ...own, on: true, layers: laneLayersAsked(sections), text: true };
    const answer = await lc
      .sendRequest<RunControlResult>(ciTarget ? CI_WATCH_REQUEST : LANE_VIEW_REQUEST, params)
      .catch(() => null);
    if (answer?.ok || (ciTarget ? ciWatching : watching) !== own) return;
    textNote = answer?.message ?? NO_ANSWER;
    postLayers(['text']);
  };

  const stopWatching = () => {
    const previous = watching;
    watching = null;
    accepted = false;
    ciAccepted = false;
    layersSent = '';
    if (previous) void lc.sendRequest(LANE_VIEW_REQUEST, { ...previous, on: false }).catch(() => undefined);
    const ci = ciWatching;
    ciWatching = null;
    if (ci) void lc.sendRequest(CI_WATCH_REQUEST, { ...ci, on: false }).catch(() => undefined);
  };

  /** Watch the CI lane shown, or stop: the service opens the instance's watch, and says why when it cannot. */
  const watchCi = async (on: boolean): Promise<RunControlResult> => {
    stopWatching();
    const ci = ciTarget;
    if (!on || !ci || !panel?.visible) {
      draw();
      return { ok: true, message: 'You no longer watch the CI run’s worker.' };
    }
    const asked = laneLayersAsked(sections);
    const params: CiWatchParams = {
      root: ci.root,
      runId: ci.runId,
      shard: ci.shard,
      lane: ci.lane,
      on: true,
      layers: asked,
    };
    ciWatching = params;
    layersSent = asked.join();
    note = null;
    refused = null;
    draw();
    const answer = await lc.sendRequest<RunControlResult>(CI_WATCH_REQUEST, params).catch(() => null);
    if (ciWatching !== params) return answer ?? { ok: false, message: NO_ANSWER };
    if (answer?.ok) {
      ciAccepted = true;
      // A section opened or closed while the watch opened asks for its layer now.
      askLayers();
    } else {
      ciWatching = null;
      // A request the service never answered may have opened the watch: it is let go.
      if (!answer) void lc.sendRequest(CI_WATCH_REQUEST, { ...params, on: false }).catch(() => undefined);
      note = answer?.message ?? NO_ANSWER;
      draw();
    }
    return answer ?? { ok: false, message: NO_ANSWER };
  };

  /**
   * Interact goes off: when it was on, the stop it was last on for is given back (`piwi/driveStop`, `on: false`), a
   * refusal said under the caption while the panel shows that stop.
   */
  const interactOff = () => {
    const stop = interacting ? interactAt : null;
    interacting = false;
    interactAt = null;
    if (!stop) return;
    const at = shown;
    void lc
      .sendRequest<RunControlResult>(DRIVE_STOP_REQUEST, giveBackParams(stop))
      .catch(() => null)
      .then((answer) => {
        if (answer?.ok || at !== shown || lane.stop?.stop.since !== stop.stop.since) return;
        note = answer?.message ?? NO_ANSWER;
        draw();
      });
  };

  const watch = async (on: boolean): Promise<RunControlResult> => {
    if (ciTarget) return watchCi(on);
    // Each watch starts with Interact off, and Interact goes off with the watch.
    interactOff();
    stopWatching();
    const slot = target;
    if (!on || !slot || !panel?.visible) {
      draw();
      hooks.changed();
      return { ok: true, message: 'You no longer watch the worker.' };
    }
    const asked = laneLayersAsked(sections);
    const params: LaneViewParams = { ...slot, on: true, layers: asked };
    watching = params;
    layersSent = asked.join();
    note = null;
    refused = null;
    draw();
    const answer = await lc.sendRequest<RunControlResult>(LANE_VIEW_REQUEST, params).catch(() => null);
    if (watching !== params) return answer ?? { ok: false, message: NO_ANSWER };
    if (answer?.ok) {
      accepted = true;
      draw();
      // A section opened or closed while the watch started asks for its layer now.
      askLayers();
    } else {
      watching = null;
      note = answer?.message ?? NO_ANSWER;
      draw();
      hooks.changed();
    }
    return answer ?? { ok: false, message: NO_ANSWER };
  };

  /** A click on the image at a stop: the element under it picked on the stopped page, as on the paused page. */
  const pick = async (message: unknown) => {
    const click = imageClickOf(message);
    const stop = lane.stop;
    if (!click || !view?.pick || click.shown !== view.pick.shown || !stop) return;
    const point = pagePoint(click, view.image);
    if (!point) return;
    note = 'Picking the element under the click…';
    draw();
    hooks.acted(stop);
    const params: PickAtParams = { ref: stop.ref, worker: stop.worker, since: stop.stop.since, ...point };
    const answer = await lc.sendRequest<PickAtResult>(PICK_AT_REQUEST, params).catch(() => null);
    if (click.shown !== shown) return;
    note = answer?.message ?? NO_ANSWER;
    draw();
  };

  const message = async (raw: unknown) => {
    const m = raw as Record<string, unknown> | null;
    if (!m || m.shown !== shown || !view) return;
    // A CI run's lane is read-only: nothing goes to its page.
    if (ciTarget && !ciLaneTakes(m)) {
      if (m.type === 'input') void panel?.webview.postMessage({ type: 'input-result', id: m.id, ok: false });
      return;
    }
    if (m.type === 'ready') {
      void panel?.webview.postMessage({ type: 'state', view });
      // A document drawn anew holds none of the layers: each part goes again, every JPEG of the strip with it.
      posted = new Set();
      return postLayers(LANE_LAYER_PARTS);
    }
    if (m.type === 'layers' && typeof m.text === 'boolean' && typeof m.filmstrip === 'boolean') {
      sections = { text: m.text, filmstrip: m.filmstrip };
      if (view?.layers) view.layers = { ...view.layers, ...sections };
      return askLayers();
    }
    if (m.type === 'text') return void askText();
    if (m.type === 'view' && typeof m.on === 'boolean') {
      wantOn = m.on;
      return void watch(m.on);
    }
    if (m.type === 'interact' && typeof m.on === 'boolean') {
      // Interact on only routes the page's input: the person's first click, key, wheel or pick drives the stop.
      const stop = lane.stop;
      if (m.on && accepted && stop?.takes.includes('input')) {
        interacting = true;
        interactAt = stop;
      } else interactOff();
      return draw();
    }
    if (m.type === 'pick') return pick(raw);
    const refused = () => {
      if (m.type === 'input') void panel?.webview.postMessage({ type: 'input-result', id: m.id, ok: false });
    };
    const stop = lane.stop;
    if (!watching || !accepted || !stop || !panel?.visible) return refused();
    const events =
      m.type === 'release' ? [] : m.type === 'input' && view.live?.interacting ? readViewInput(m.events) : null;
    if (!events || typeof events === 'string') return refused();
    if (m.type === 'input' && actsOnPage(events)) hooks.acted(stop);
    const at = { ref: stop.ref, worker: stop.worker, since: stop.stop.since };
    const answer = await lc
      .sendRequest<RunControlResult>(PAGE_INPUT_REQUEST, { ...at, events, release: m.type === 'release' })
      .catch(() => null);
    if (m.type === 'input')
      void panel?.webview.postMessage({ type: 'input-result', id: m.id, ok: answer?.ok === true });
    // A refused batch may have held the `up` of a button sent down before it: what the page holds is let go.
    if (m.type === 'input' && !answer?.ok) {
      void lc.sendRequest(PAGE_INPUT_REQUEST, { ...at, events: [], release: true }).catch(() => undefined);
    }
    if (!answer?.ok && m.shown === shown) {
      note = answer?.message ?? NO_ANSWER;
      draw();
    }
  };

  const create = () => {
    const made = vscode.window.createWebviewPanel(
      'piwi.workerView',
      'Piwi: worker',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // Find searches the page's text and the events.
      {
        enableScripts: true,
        enableFindWidget: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    );
    made.webview.onDidReceiveMessage((m: unknown) => void message(m));
    let visible = made.visible;
    made.onDidChangeViewState(() => {
      if (panel !== made) return;
      const change = pausedPageViewChange(visible, made.visible, wantOn);
      visible = made.visible;
      if (change === 'end') {
        interactOff();
        stopWatching();
        draw();
        hooks.changed();
      } else if (change === 'watch') void watch(true);
    });
    made.onDidDispose(() => {
      if (panel !== made) return;
      interactOff();
      stopWatching();
      panel = null;
      target = null;
      ciTarget = null;
      view = null;
      if (!disposed) hooks.changed();
    });
    return made;
  };

  const frame = (f: LaneFrame) => {
    if (!target || !watching || f.ref !== target.ref || f.lane !== target.lane || !panel?.visible) return;
    if ('refused' in f) {
      refused = f.refused;
      return draw();
    }
    if (!isViewFrameData(f.data)) return;
    refused = null;
    image = { mime: 'image/jpeg', data: f.data, width: f.width, height: f.height };
    imageOf = { worker: f.worker, test: f.test, since: f.since };
    draw();
  };

  /** An image of the CI lane watched, why none shows, or why its watch ended (Watch then shows off). */
  const ciFrame = (f: CiFrame) => {
    const ci = ciTarget;
    const own = ciWatching;
    if (!ci || !own || !panel?.visible) return;
    if (f.root !== ci.root || f.runId !== ci.runId || f.shard !== ci.shard || f.lane !== ci.lane) return;
    if ('ended' in f) {
      ciWatching = null;
      refused = null;
      note = f.ended;
    } else if ('refused' in f) refused = f.refused;
    else {
      if (!isViewFrameData(f.data)) return;
      refused = null;
      image = { mime: 'image/jpeg', data: f.data };
    }
    draw();
  };

  /** A layer of the slot the panel watches, asked for by its sections. */
  const laneLayer = (l: LaneViewLayer) => {
    if (!target || !watching || l.ref !== target.ref || l.lane !== target.lane || !panel?.visible) return;
    heardLayer(l);
  };

  /** A layer of the CI lane the panel watches, asked for by its sections. */
  const ciLayer = (l: CiLayer) => {
    const ci = ciTarget;
    if (!ci || !ciWatching || !panel?.visible) return;
    if (l.root !== ci.root || l.runId !== ci.runId || l.shard !== ci.shard || l.lane !== ci.lane) return;
    heardLayer(l);
  };

  const subscriptions = [
    lc.onNotification(LANE_FRAME_NOTIFICATION, frame),
    lc.onNotification(CI_FRAME_NOTIFICATION, ciFrame),
    lc.onNotification(LANE_LAYER_NOTIFICATION, laneLayer),
    lc.onNotification(CI_LAYER_NOTIFICATION, ciLayer),
  ];

  return {
    async open(ref, slot) {
      if (!panel) panel = create();
      else panel.reveal(vscode.ViewColumn.Beside, true);
      panel.title = `Piwi: ${workerName(slot).toLowerCase()}`;
      if (ciTarget || target?.ref !== ref || target.lane !== slot) {
        ciTarget = null;
        // Another slot's view turns Interact off.
        interactOff();
        stopWatching();
        target = { ref, lane: slot };
        shown++;
        image = null;
        imageOf = null;
        note = null;
        refused = null;
        forgetLayers();
        lane = laneShown(sessions.get(ref), slot, stops);
        draw(true);
      }
      wantOn = true;
      return watching ? { ok: true, message: `You watch ${workerName(slot).toLowerCase()}.` } : watch(true);
    },
    async openCi(ci) {
      if (!panel) panel = create();
      else panel.reveal(vscode.ViewColumn.Beside, true);
      panel.title = ciLaneTitle(ci);
      const same =
        ciTarget?.root === ci.root &&
        ciTarget.runId === ci.runId &&
        ciTarget.shard === ci.shard &&
        ciTarget.lane === ci.lane;
      if (!same) {
        interactOff();
        // Another CI lane takes the place of the one watched on the service's side: no word of the one before.
        if (ciTarget) ciWatching = null;
        stopWatching();
        target = null;
        ciTarget = ci;
        shown++;
        image = null;
        imageOf = null;
        note = null;
        refused = null;
        forgetLayers();
        lane = { worker: null, stop: null, caption: '' };
        draw(true);
      }
      wantOn = true;
      return ciWatching ? { ok: true, message: 'You watch the CI run’s worker.' } : watch(true);
    },
    ciChanged(now) {
      ciSessions = now;
      if (!ciTarget) return;
      // The service ends the watch with the run's session, and Watch shows off.
      if (!now.has(ciKey(ciTarget))) ciWatching = null;
      if (ciLaneRedraws(view, ciLaneCaption(now, ciTarget), !!ciWatching)) draw();
    },
    view: () => (panel ? view : null),
    message,
    watches(ref, slot) {
      return !!panel?.visible && !!watching && watching.ref === ref && watching.lane === slot;
    },
    column: () => (panel?.visible ? panel.viewColumn : undefined),
    changed(now, at) {
      sessions = now;
      stops = at;
      if (!target) return;
      const before = lane.stop?.stop.since ?? null;
      lane = laneShown(now.get(target.ref), target.lane, at);
      // The service ends the view with the run, and Interact goes off with it: a rerun under its ref starts off.
      if (!now.has(target.ref)) {
        interactOff();
        watching = null;
        accepted = false;
      }
      // Interact stays on through the slot's stops that take input and the stretches between them.
      if (!laneKeepsInteract(interacting, lane.stop)) interactOff();
      else if (lane.stop) interactAt = lane.stop;
      if ((lane.stop?.stop.since ?? null) === before) return draw();
      // A new stop, or the worker going on, is drawn anew, Interact kept: no message of the view before reaches it.
      shown++;
      note = null;
      draw(true);
    },
    dispose() {
      disposed = true;
      for (const subscription of subscriptions) subscription.dispose();
      stopWatching();
      panel?.dispose();
    },
  };
}
