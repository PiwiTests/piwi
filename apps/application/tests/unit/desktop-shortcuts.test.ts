import { describe, expect, it } from 'vitest';
import { desktopShortcut } from '../../app/utils/desktop-shortcuts';

const press = (
  key: string,
  modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat', boolean>> = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...modifiers,
});

const WINDOWS = { macOS: false, inField: false };
const shortcut = (event: ReturnType<typeof press>, context = WINDOWS) => desktopShortcut(event, context);

describe('the desktop app’s Ctrl shortcuts', () => {
  it('maps Ctrl with the macOS menu’s keys to their actions', () => {
    expect(shortcut(press(',', { ctrlKey: true }))).toBe('settings');
    expect(shortcut(press('o', { ctrlKey: true }))).toBe('import');
    expect(shortcut(press('O', { ctrlKey: true }))).toBe('import');
    expect(shortcut(press('[', { ctrlKey: true }))).toBe('back');
    expect(shortcut(press(']', { ctrlKey: true }))).toBe('forward');
  });

  it('leaves every other key press alone', () => {
    expect(shortcut(press(','))).toBeNull();
    expect(shortcut(press('k', { ctrlKey: true }))).toBeNull();
    expect(shortcut(press(',', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shortcut(press('o', { ctrlKey: true, altKey: true }))).toBeNull();
    // ⌘ belongs to the macOS menu, and a held key acts once.
    expect(shortcut(press(',', { metaKey: true }))).toBeNull();
    expect(shortcut(press(',', { ctrlKey: true, metaKey: true }))).toBeNull();
    expect(shortcut(press('[', { ctrlKey: true, repeat: true }))).toBeNull();
  });

  it('leaves the keys to macOS, whose menu holds them, and to a field being typed in', () => {
    const ctrlComma = press(',', { ctrlKey: true });
    expect(shortcut(ctrlComma, { macOS: true, inField: false })).toBeNull();
    expect(shortcut(ctrlComma, { macOS: false, inField: true })).toBeNull();
  });
});
