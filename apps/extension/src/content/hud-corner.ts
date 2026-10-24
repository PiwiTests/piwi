import { makeButton } from '../shared/buttons.js';
import { t } from '../shared/i18n.js';

/**
 * Where the recorder's bar sits: a corner of the viewport, which the person
 * moves it to when it covers what they need to click (a checkout bar, a chat
 * button, a form's last button). The corner is kept in `chrome.storage.local`
 * for every page and every later recording.
 */
export type HudCorner = 'bottom-right' | 'bottom-left' | 'top-left' | 'top-right';

const CORNERS: readonly HudCorner[] = ['bottom-right', 'bottom-left', 'top-left', 'top-right'];
const HUD_CORNER_KEY = 'piwiHudCorner';

/** The corner after `corner`, round the viewport. */
export function nextCorner(corner: HudCorner): HudCorner {
  return CORNERS[(CORNERS.indexOf(corner) + 1) % CORNERS.length]!;
}

/** The `inset` that puts a bar in `corner`, 16 pixels from its edges. */
export function cornerInset(corner: HudCorner): string {
  switch (corner) {
    case 'bottom-left':
      return 'auto auto 16px 16px';
    case 'top-left':
      return '16px auto auto 16px';
    case 'top-right':
      return '16px 16px auto auto';
    default:
      return 'auto 16px 16px auto';
  }
}

/** The corner this page's bar is in: the stored one once {@link loadHudCorner} has read it. */
let current: HudCorner = 'bottom-right';

export function hudCorner(): HudCorner {
  return current;
}

/** Reads the corner the person last moved the bar to. Never rejects: the bar then stays bottom right. */
export async function loadHudCorner(): Promise<void> {
  try {
    const stored = (await chrome.storage.local.get(HUD_CORNER_KEY))[HUD_CORNER_KEY];
    if (CORNERS.includes(stored as HudCorner)) current = stored as HudCorner;
  } catch {
    // No storage here: the default corner.
  }
}

/** A button that moves the bar `host` holds to the next corner, and keeps it there. */
export function moveHudButton(host: HTMLElement): HTMLButtonElement {
  const button = makeButton(
    t('record_hudMove'),
    () => {
      current = nextCorner(current);
      host.style.inset = cornerInset(current);
      void chrome.storage.local.set({ [HUD_CORNER_KEY]: current }).catch(() => undefined);
    },
    { icon: 'move', iconOnly: true, small: true },
  );
  button.dataset.piwiControl = 'hud-move';
  return button;
}
