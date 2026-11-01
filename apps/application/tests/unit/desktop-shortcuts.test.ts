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

describe('the desktop app’s Ctrl shortcuts', () => {
  it('maps Ctrl with the macOS menu’s keys to their actions', () => {
    expect(desktopShortcut(press(',', { ctrlKey: true }))).toBe('settings');
    expect(desktopShortcut(press('o', { ctrlKey: true }))).toBe('import');
    expect(desktopShortcut(press('O', { ctrlKey: true }))).toBe('import');
    expect(desktopShortcut(press('[', { ctrlKey: true }))).toBe('back');
    expect(desktopShortcut(press(']', { ctrlKey: true }))).toBe('forward');
  });

  it('leaves every other key press alone', () => {
    expect(desktopShortcut(press(','))).toBeNull();
    expect(desktopShortcut(press('k', { ctrlKey: true }))).toBeNull();
    expect(desktopShortcut(press(',', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(desktopShortcut(press('o', { ctrlKey: true, altKey: true }))).toBeNull();
    // ⌘ belongs to the macOS menu, and a held key acts once.
    expect(desktopShortcut(press(',', { metaKey: true }))).toBeNull();
    expect(desktopShortcut(press(',', { ctrlKey: true, metaKey: true }))).toBeNull();
    expect(desktopShortcut(press('[', { ctrlKey: true, repeat: true }))).toBeNull();
  });
});
