/// <reference lib="dom" />
import { ViewInputBatcher, keyOnView, pastedText, type ViewModifier } from '@piwitests/run-model/view-input';
import type { LaneLayersMessage, PausedPageView } from './run-control';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const picture = document.getElementById('page') as HTMLImageElement;
const live = document.getElementById('live') as HTMLInputElement;
const interact = document.getElementById('interact') as HTMLInputElement;
const note = document.getElementById('note')!;
const shown = Number(picture.dataset.shown);
let view: PausedPageView | null = null;
let captured = false;
const post = (message: Record<string, unknown>) => vscode.postMessage({ ...message, shown });
const active = () => live.checked && interact.checked && !!view?.live?.on;
let requestId = 0;
/** The batches posted and not answered yet, with the input they came from. */
const pending = new Map<number, { from: ViewInputBatcher; answered: (ok: boolean) => void }>();
/** The input of a toggle changed, still going out before the toggle's message, whatever the toggles show now. */
const finishing = new Set<ViewInputBatcher>();
/** The toggles' messages, each posted once the input before it went out. */
let toggled = Promise.resolve();
/** Toggles changed whose message is not posted yet: the extension's state leaves the checkboxes as they are. */
let toggling = 0;
const createInput = (): ViewInputBatcher => {
  const own: ViewInputBatcher = new ViewInputBatcher({
    clickCounts: picture.dataset.clickCounts === 'true',
    send: async (events) => {
      const ending = finishing.has(own);
      if (!ending && !active()) return false;
      // Input made after a toggle changed goes after the toggle's message.
      if (!ending) await toggled;
      const id = ++requestId;
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          resolve(false);
        }, 10_000);
        pending.set(id, {
          from: own,
          answered: (ok) => {
            clearTimeout(timeout);
            resolve(ok);
          },
        });
        post({ type: 'input', events, id });
      });
    },
  });
  return own;
};
let input = createInput();

function point(e: MouseEvent) {
  const box = picture.getBoundingClientRect();
  if (!box.width || !box.height || !view?.image?.width || !view.image.height) return null;
  const x = e.clientX - box.left,
    y = e.clientY - box.top;
  if (x < 0 || y < 0 || x > box.width || y > box.height) return null;
  return {
    x: Math.min(view.image.width - 1, (x * view.image.width) / box.width),
    y: Math.min(view.image.height - 1, (y * view.image.height) / box.height),
  };
}
/** The input waiting is dropped, and what the page holds let go of: the pointer or the focus left the image. */
function release() {
  captured = false;
  const dropped = input;
  dropped.dispose();
  for (const [id, wait] of pending) {
    if (wait.from !== dropped) continue;
    pending.delete(id);
    wait.answered(false);
  }
  input = createInput();
  post({ type: 'release' });
}
/**
 * A toggle changed (`message`): the input before it goes out first, the click held back for a second one included,
 * then the release, then `message`, as the Runs window does; the toggles' messages keep the order they changed in.
 */
function toggle(message: Record<string, unknown>) {
  captured = false;
  const ending = input;
  finishing.add(ending);
  input = createInput();
  const drained = ending.finish();
  toggling++;
  toggled = toggled
    .then(() => drained)
    .then(() => {
      finishing.delete(ending);
      toggling--;
      post({ type: 'release' });
      post(message);
    });
}
live.addEventListener('change', () => {
  if (!live.checked) interact.disabled = true;
  toggle({ type: 'view', on: live.checked });
});
interact.addEventListener('change', () => toggle({ type: 'interact', on: interact.checked }));
picture.addEventListener('click', (e) => {
  if (active() && !e.shiftKey) return;
  if (!view?.pick) return;
  post({ type: 'pick', x: e.offsetX, y: e.offsetY, width: picture.clientWidth, height: picture.clientHeight });
});
picture.addEventListener('mousedown', (e) => {
  if (!active() || e.shiftKey || e.button === 1) return;
  const at = point(e);
  if (!at) return;
  e.preventDefault();
  picture.focus();
  captured = true;
  const modifiers: ViewModifier[] = [];
  if (e.ctrlKey) modifiers.push('Control');
  if (e.altKey) modifiers.push('Alt');
  if (e.metaKey) modifiers.push('Meta');
  input.down(e.button === 2 ? 'right' : 'left', at.x, at.y, { count: e.detail, modifiers });
});
picture.addEventListener('pointermove', (e) => {
  const at = point(e);
  if (active() && at && !e.shiftKey) input.move(at.x, at.y);
});
window.addEventListener('mouseup', (e) => {
  const at = point(e);
  if (active() && at && !e.shiftKey && e.button !== 1)
    input.up(e.button === 2 ? 'right' : 'left', at.x, at.y, { count: e.detail });
  else if (captured) release();
});
picture.addEventListener('pointercancel', release);
picture.addEventListener('contextmenu', (e) => {
  if (active()) e.preventDefault();
});
picture.addEventListener(
  'wheel',
  (e) => {
    const at = point(e);
    if (active() && at && document.activeElement === picture) {
      e.preventDefault();
      input.wheel(at.x, at.y, e.deltaX, e.deltaY);
    }
  },
  { passive: false },
);
picture.addEventListener('keydown', (e) => {
  if (!active()) return;
  const key = keyOnView(
    {
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      isComposing: e.isComposing,
      altGraph: e.getModifierState('AltGraph'),
    },
    // An action runs in the test's window at the stop (a pick, a check): its Escape is the page's.
    { mac: /Mac/.test(navigator.platform), captured, acting: !!view?.acting },
  );
  if (key === 'leave') {
    // Escape turns Interact off: the input held goes out and is let go of, then the stop is given back.
    e.preventDefault();
    interact.checked = false;
    toggle({ type: 'interact', on: false });
    interact.focus();
  } else if (typeof key === 'object') {
    e.preventDefault();
    input.key(key.send);
  }
});
picture.addEventListener('paste', (e) => {
  if (active()) {
    e.preventDefault();
    pastedText(e.clipboardData?.getData('text/plain') ?? '').forEach((event) => input.key(event));
  }
});
picture.addEventListener('blur', release);
window.addEventListener('blur', release);
window.addEventListener('message', (event: MessageEvent<{ type: string; view: PausedPageView }>) => {
  if (event.data?.type === 'input-result') {
    const result = event.data as unknown as { id: number; ok: boolean };
    pending.get(result.id)?.answered(result.ok);
    pending.delete(result.id);
    return;
  }
  if (event.data?.type !== 'state' || event.data.view.live?.shown !== shown) return;
  if (active() && (!event.data.view.live.on || !event.data.view.live.interacting)) release();
  view = event.data.view;
  if (!toggling) {
    live.checked = view.live?.on === true;
    interact.disabled = !live.checked || !view.live?.input;
    interact.checked = !interact.disabled && view.live?.interacting === true;
  }
  note.textContent = view.note ?? '';
  document.getElementById('caption')!.textContent = view.caption;
  picture.classList.toggle('pick', !!view.pick && !active());
  picture.classList.toggle('stale', !!view.stale);
  if (view.image?.data) {
    picture.src = `data:image/jpeg;base64,${view.image.data}`;
    picture.hidden = false;
  } else {
    picture.removeAttribute('src');
    picture.hidden = true;
  }
});
/**
 * The worker panel's sections under the image, when the document has them: every text of the run is set as text,
 * never as markup, and an image of the filmstrip only from base64 of a JPEG.
 */
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const textSection = byId<HTMLDetailsElement>('text-section');
const stripSection = byId<HTMLDetailsElement>('strip-section');
const strip = byId<HTMLDivElement>('strip');
/** The strip's JPEGs, by call, as the extension posted them. */
const images = new Map<string, string>();
/** The image of the strip shown larger, by call. */
let enlarged: string | null = null;
const JPEG_BASE64 = /^\/9j\/[A-Za-z0-9+/]*={0,2}$/;
const sections = () => post({ type: 'layers', text: !!textSection?.open, filmstrip: !!stripSection?.open });
textSection?.addEventListener('toggle', sections);
stripSection?.addEventListener('toggle', sections);
byId<HTMLButtonElement>('text-again')?.addEventListener('click', () => post({ type: 'text' }));

/** Show the image of the strip `call` larger, with its call's title; null hides it. */
function enlarge(call: string | null, title = '') {
  const figure = byId<HTMLElement>('thumb');
  const image = byId<HTMLImageElement>('thumb-image');
  const data = call ? images.get(call) : undefined;
  enlarged = data ? call : null;
  for (const button of strip?.querySelectorAll('button') ?? []) {
    button.setAttribute('aria-pressed', String(button.dataset.call === enlarged));
  }
  if (!figure || !image) return;
  figure.hidden = !data;
  if (!data) return image.removeAttribute('src');
  image.src = `data:image/jpeg;base64,${data}`;
  image.alt = title;
  byId('thumb-title')!.textContent = title;
}

function drawLayers(message: LaneLayersMessage) {
  if (message.waits !== undefined) {
    const waits = byId('waits');
    if (waits) {
      waits.hidden = !message.waits;
      waits.classList.toggle('failed', !!message.waits?.failed);
      byId('waits-head')!.textContent = message.waits?.head ?? '';
      const target = byId('waits-target')!;
      target.textContent = message.waits?.target ?? '';
      target.hidden = !message.waits?.target;
      byId('waits-lines')!.textContent = message.waits?.lines.join('\n') ?? '';
    }
  }
  if (message.events) {
    const list = byId<HTMLOListElement>('events');
    if (list) {
      list.replaceChildren(
        ...message.events.map((event) => {
          const item = document.createElement('li');
          item.className = event.level;
          item.textContent = event.text;
          if (event.url) item.title = event.url;
          return item;
        }),
      );
      byId('events-empty')!.hidden = message.events.length > 0;
      byId('events-count')!.textContent = message.events.length ? `(${message.events.length})` : '';
    }
  }
  if (message.text) {
    const text = byId('text');
    if (text) text.textContent = message.text.text ?? '';
    const note = byId('text-note');
    if (note) note.textContent = message.text.note;
  }
  if (message.strip && strip) {
    for (const [call, data] of Object.entries(message.images ?? {})) {
      if (JPEG_BASE64.test(data)) images.set(call, data);
    }
    const calls = new Set(message.strip.map((image) => image.call));
    for (const call of images.keys()) if (!calls.has(call)) images.delete(call);
    strip.replaceChildren(
      ...message.strip.flatMap((thumb) => {
        const data = images.get(thumb.call);
        if (!data) return [];
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.call = thumb.call;
        button.title = thumb.title;
        button.setAttribute('aria-label', `${thumb.index}. ${thumb.title}`);
        button.setAttribute('aria-pressed', String(thumb.call === enlarged));
        const image = document.createElement('img');
        image.src = `data:image/jpeg;base64,${data}`;
        image.alt = '';
        button.append(image);
        button.addEventListener('click', () => enlarge(enlarged === thumb.call ? null : thumb.call, thumb.title));
        return [button];
      }),
    );
    byId('strip-empty')!.hidden = message.strip.length > 0;
    if (enlarged && !images.has(enlarged)) enlarge(null);
  }
}

window.addEventListener('message', (event: MessageEvent<LaneLayersMessage>) => {
  if (event.data?.type === 'layers' && event.data.shown === shown) drawLayers(event.data);
});
window.addEventListener('message', (event: MessageEvent<{ type: string; view: PausedPageView }>) => {
  if (event.data?.type !== 'state' || event.data.view.live?.shown !== shown) return;
  const note = byId('layers-note');
  if (note) {
    note.textContent = event.data.view.layers?.note ?? '';
    note.hidden = !event.data.view.layers?.note;
  }
});
// The extension ends the watch itself when the panel hides or closes, and keeps Watch live for when it shows again.
window.addEventListener('pagehide', () => input.dispose());
post({ type: 'ready' });
