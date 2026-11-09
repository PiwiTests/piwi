/**
 * The desktop app's keys in its dashboard window on Windows and Linux: the ones its macOS app menu holds with ⌘
 * (`app_menu` in the shell), taken here with Ctrl. On macOS the menu has them, and Ctrl keeps its text-editing
 * meanings. One list, which the desktop plugin's handler and the Keyboard shortcuts page's check both read.
 */
export type DesktopShortcutAction = 'settings' | 'import' | 'back' | 'forward';

/** The key pressed with Ctrl, and what it does. */
export const DESKTOP_SHORTCUTS: Readonly<Record<string, DesktopShortcutAction>> = {
  ',': 'settings',
  o: 'import',
  '[': 'back',
  ']': 'forward',
};

/** Where a key press happens: on macOS, and in a field the user types in, the keys are left alone. */
export interface DesktopShortcutContext {
  macOS: boolean;
  inField: boolean;
}

/** The action of a key press: Ctrl with one of the keys and no other modifier, not repeated; `null` otherwise. */
export function desktopShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>,
  context: DesktopShortcutContext,
): DesktopShortcutAction | null {
  if (context.macOS || context.inField) return null;
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return null;
  return DESKTOP_SHORTCUTS[event.key.toLowerCase()] ?? null;
}
