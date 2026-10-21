#!/usr/bin/env python3
"""Sends keyboard and mouse input to an X display through the XTEST extension, for the IDE screenshots.

Usage (DISPLAY set):
  xinput.py key alt+Return          # a chord: ctrl, alt, shift, super and X keysym names (Return, Escape, F1, a, …)
  xinput.py type "some text"        # ASCII text, one key at a time
  xinput.py move 640 400            # the pointer, in screen pixels
  xinput.py click [1|2|3]           # a button at the pointer's position
  xinput.py sleep 0.5

Several commands chain on one line: xinput.py move 640 400 sleep 0.3 click 1 sleep 1 key alt+Return
"""
import ctypes
import sys
import time

x11 = ctypes.CDLL('libX11.so.6')
xtst = ctypes.CDLL('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

MODIFIERS = {'ctrl': 'Control_L', 'control': 'Control_L', 'alt': 'Alt_L', 'shift': 'Shift_L', 'super': 'Super_L'}
# Characters typed through a shifted key, and the keysym of the key that carries them.
SHIFTED = {
    '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', '$': 'dollar', '%': 'percent', '&': 'ampersand',
    '(': 'parenleft', ')': 'parenright', '*': 'asterisk', '+': 'plus', ':': 'colon', '<': 'less', '>': 'greater',
    '?': 'question', '@': 'at', '^': 'asciicircum', '_': 'underscore', '{': 'braceleft', '|': 'bar',
    '}': 'braceright', '~': 'asciitilde',
}
PLAIN = {
    ' ': 'space', "'": 'apostrophe', ',': 'comma', '-': 'minus', '.': 'period', '/': 'slash', ';': 'semicolon',
    '=': 'equal', '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', '`': 'grave', '\n': 'Return',
    '\t': 'Tab',
}


class Display:
    def __init__(self):
        self.d = x11.XOpenDisplay(None)
        if not self.d:
            raise SystemExit('cannot open the X display: is DISPLAY set?')

    def keycode(self, keysym_name):
        keysym = x11.XStringToKeysym(keysym_name.encode())
        if keysym == 0:
            raise SystemExit(f'unknown keysym: {keysym_name}')
        code = x11.XKeysymToKeycode(self.d, keysym)
        if code == 0:
            raise SystemExit(f'no keycode for: {keysym_name}')
        return code

    def press(self, keysym_name, down):
        xtst.XTestFakeKeyEvent(self.d, self.keycode(keysym_name), 1 if down else 0, 0)
        x11.XFlush(self.d)

    def key(self, chord):
        parts = chord.split('+')
        mods = [MODIFIERS[p.lower()] for p in parts[:-1]]
        key = parts[-1]
        for m in mods:
            self.press(m, True)
        self.press(key, True)
        self.press(key, False)
        for m in reversed(mods):
            self.press(m, False)
        time.sleep(0.05)

    def type(self, text):
        for ch in text:
            if ch in SHIFTED:
                self.key(f'shift+{SHIFTED[ch]}')
            elif ch in PLAIN:
                self.key(PLAIN[ch])
            elif ch.isupper():
                self.key(f'shift+{ch.lower()}')
            else:
                self.key(ch)
            time.sleep(0.02)

    def move(self, x, y):
        xtst.XTestFakeMotionEvent(self.d, -1, int(x), int(y), 0)
        x11.XFlush(self.d)

    def click(self, button=1):
        xtst.XTestFakeButtonEvent(self.d, int(button), 1, 0)
        x11.XFlush(self.d)
        time.sleep(0.05)
        xtst.XTestFakeButtonEvent(self.d, int(button), 0, 0)
        x11.XFlush(self.d)

    def close(self):
        x11.XCloseDisplay(self.d)


def main(argv):
    display = Display()
    i = 0
    try:
        while i < len(argv):
            op = argv[i]
            if op == 'key':
                display.key(argv[i + 1])
                i += 2
            elif op == 'type':
                display.type(argv[i + 1])
                i += 2
            elif op == 'move':
                display.move(argv[i + 1], argv[i + 2])
                i += 3
            elif op == 'click':
                button = argv[i + 1] if i + 1 < len(argv) and argv[i + 1].isdigit() else '1'
                display.click(button)
                i += 2 if i + 1 < len(argv) and argv[i + 1].isdigit() else 1
            elif op == 'sleep':
                time.sleep(float(argv[i + 1]))
                i += 2
            else:
                raise SystemExit(f'unknown command: {op}')
    finally:
        display.close()


if __name__ == '__main__':
    main(sys.argv[1:])
