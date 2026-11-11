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
 * new ones (`hooks`). The pure half is `run-control.ts`.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { isViewFrameData, readViewInput } from '@piwitests/core/run-view';
import {
  DRIVE_STOP_REQUEST,
  LANE_FRAME_NOTIFICATION,
  LANE_VIEW_REQUEST,
  PAGE_INPUT_REQUEST,
  PICK_AT_REQUEST,
  type LaneFrame,
  type LaneViewParams,
  type PausedImage,
  type PickAtParams,
  type PickAtResult,
  type RunControlResult,
  type RunSession,
} from '@piwitests/editor/protocol';
import {
  actsOnPage,
  frameIsCurrent,
  giveBackParams,
  imageClickOf,
  laneKeepsInteract,
  laneShown,
  pagePoint,
  pausedPageHtml,
  pausedPageViewChange,
  picksOnImage,
  workerName,
  type LaneShown,
  type PausedPageView,
  type ShownStop,
} from './run-control';

export interface WorkerPanel extends vscode.Disposable {
  /** Watch the slot `lane` of the run `ref` in the panel, opened beside the editor without focus; what came of it. */
  open(ref: string, lane: number): Promise<RunControlResult>;
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
  /** Interact is on: kept through the slot's next stops while the watch goes on, off at a stop that takes no input. */
  let interacting = false;
  /** The stop Interact was last on for, which Interact going off gives back. */
  let interactAt: ShownStop | null = null;
  let view: PausedPageView | null = null;
  /** The extension disposes of the panel: nothing is shown again. */
  let disposed = false;

  const script = () =>
    panel!.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'paused-page.js')).toString();

  /** The view as it stands, posted to the panel's script, or drawn anew for a new slot (`fresh`). */
  const draw = (fresh = false) => {
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
    };
    if (!panel) return;
    if (fresh) panel.webview.html = pausedPageHtml(view, randomBytes(16).toString('base64'), script());
    else void panel.webview.postMessage({ type: 'state', view });
  };

  const stopWatching = () => {
    const previous = watching;
    watching = null;
    accepted = false;
    if (previous) void lc.sendRequest(LANE_VIEW_REQUEST, { ...previous, on: false }).catch(() => undefined);
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
    // Each watch starts with Interact off, and Interact goes off with the watch.
    interactOff();
    stopWatching();
    const slot = target;
    if (!on || !slot || !panel?.visible) {
      draw();
      hooks.changed();
      return { ok: true, message: 'You no longer watch the worker.' };
    }
    const params: LaneViewParams = { ...slot, on: true };
    watching = params;
    note = null;
    refused = null;
    draw();
    const answer = await lc.sendRequest<RunControlResult>(LANE_VIEW_REQUEST, params).catch(() => null);
    if (watching !== params) return answer ?? { ok: false, message: NO_ANSWER };
    if (answer?.ok) {
      accepted = true;
      draw();
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
    if (m.type === 'ready') return void panel?.webview.postMessage({ type: 'state', view });
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
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] },
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

  const subscription = lc.onNotification(LANE_FRAME_NOTIFICATION, frame);

  return {
    async open(ref, slot) {
      if (!panel) panel = create();
      else panel.reveal(vscode.ViewColumn.Beside, true);
      panel.title = `Piwi: ${workerName(slot).toLowerCase()}`;
      if (target?.ref !== ref || target.lane !== slot) {
        // Another slot's view turns Interact off.
        interactOff();
        stopWatching();
        target = { ref, lane: slot };
        shown++;
        image = null;
        imageOf = null;
        note = null;
        refused = null;
        lane = laneShown(sessions.get(ref), slot, stops);
        draw(true);
      }
      wantOn = true;
      return watching ? { ok: true, message: `You watch ${workerName(slot).toLowerCase()}.` } : watch(true);
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
      subscription.dispose();
      stopWatching();
      panel?.dispose();
    },
  };
}
