/// <reference lib="dom" />
import { ViewInputBatcher, keyOnView, pastedText, type ViewModifier } from '../../extension/src/shared/view-input';
import type { PausedPageView } from './run-control';

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
const pending = new Map<number, (ok: boolean) => void>();
const createInput = () =>
  new ViewInputBatcher({
    clickCounts: picture.dataset.clickCounts === 'true',
    send: async (events) => {
      if (!active()) return false;
      const id = ++requestId;
      return new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          resolve(false);
        }, 10_000);
        pending.set(id, (ok) => {
          clearTimeout(timeout);
          resolve(ok);
        });
        post({ type: 'input', events, id });
      });
    },
  });
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
function release() {
  captured = false;
  input.dispose();
  for (const resolve of pending.values()) resolve(false);
  pending.clear();
  input = createInput();
  post({ type: 'release' });
}
live.addEventListener('change', () => {
  release();
  post({ type: 'view', on: live.checked });
});
interact.addEventListener('change', () => {
  release();
  post({ type: 'interact', on: interact.checked });
});
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
    { mac: /Mac/.test(navigator.platform), captured },
  );
  if (key === 'leave') {
    e.preventDefault();
    release();
    live.focus();
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
    pending.get(result.id)?.(result.ok);
    pending.delete(result.id);
    return;
  }
  if (event.data?.type !== 'state' || event.data.view.live?.shown !== shown) return;
  if (active() && (!event.data.view.live.on || !event.data.view.live.interacting)) release();
  view = event.data.view;
  live.checked = view.live?.on === true;
  interact.disabled = !live.checked || !view.live?.input;
  interact.checked = !interact.disabled && view.live?.interacting === true;
  note.textContent = view.note ?? '';
  document.getElementById('caption')!.textContent = view.caption;
  picture.classList.toggle('pick', !!view.pick && !active());
  if (view.image?.data) {
    picture.src = `data:image/jpeg;base64,${view.image.data}`;
    picture.hidden = false;
  } else {
    picture.removeAttribute('src');
    picture.hidden = true;
  }
});
// The extension ends the watch itself when the panel hides or closes, and keeps Watch live for when it shows again.
window.addEventListener('pagehide', () => input.dispose());
post({ type: 'ready' });
