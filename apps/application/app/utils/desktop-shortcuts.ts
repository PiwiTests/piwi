/**
 * The desktop app's keys in its dashboard window: the ones its macOS app menu holds with ⌘ (`app_menu` in the
 * shell), taken here with Ctrl, which is how Windows and Linux reach them. On macOS the menu takes the ⌘ keys first.
 * One list, which the desktop plugin's handler and the Keyboard shortcuts page's check both read.
 */
export type DesktopShortcutAction = 'settings' | 'import' | 'back' | 'forward';

/** The key pressed with Ctrl, and what it does. */
export const DESKTOP_SHORTCUTS: Readonly<Record<string, DesktopShortcutAction>> = {
  ',': 'settings',
  o: 'import',
  '[': 'back',
  ']': 'forward',
};

/** The action of a key press: Ctrl with one of the keys and no other modifier, not repeated; `null` otherwise. */
export function desktopShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>,
): DesktopShortcutAction | null {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return null;
  return DESKTOP_SHORTCUTS[event.key.toLowerCase()] ?? null;
}
