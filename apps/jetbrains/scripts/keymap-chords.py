#!/usr/bin/env python3
"""
What each keymap bundled with a JetBrains IDE binds to Ctrl+Alt+Shift and Cmd+Alt+Shift with a letter, the chords Piwi
chooses its keys from, written to `apps/jetbrains/keymap-chords.json` for `packages/editor/tests/keys.test.ts`.

Each IDE is read from its folder, its `.tar.gz`, or a `.tar.gz` piped to stdin (`-`), so an IDE never needs the disk:

    curl -sSL https://download.jetbrains.com/rider/JetBrains.Rider-2026.2.2.tar.gz | \\
      python3 scripts/keymap-chords.py RD-2026.2.2=- WS-2024.1=.ide/WebStorm-2024.1 IU-2026.2.3=ideaIU.tar.gz

An IDE named replaces the one of the same name in the file, and `--drop NAME` removes one; the others are kept.
Every jar's `keymaps/*.xml` is read, and every `<keyboard-shortcut keymap="…">` of a plugin's descriptors. A keymap
resolves its actions as the platform does: an action it lists replaces its parent's shortcuts, a plugin's shortcut is
added to the keymap it names (`replace-all` and `remove` as the platform reads them), and a keymap whose name starts with
`Mac OS X` inherits its parent's with Ctrl and Cmd swapped (`MacOSDefaultKeymap`), which the other macOS keymaps descend
from.
"""
import io
import json
import os
import re
import sys
import tarfile
import xml.etree.ElementTree as ET
import zipfile

OUT = os.path.join(os.path.dirname(__file__), '..', 'keymap-chords.json')
# A keymap whose name starts with this converts what it inherits (`DefaultKeymap`: `MacOSDefaultKeymap`).
MAC_PREFIX = 'Mac OS X'
CHORD = re.compile(r'^(ctrl|meta) alt shift [A-Z]$')


def strokes(text):
    """A keystroke as a sorted set of modifiers and its key: `control alt shift R` is `alt ctrl shift R`."""
    parts = text.replace('control', 'ctrl').split()
    mods = sorted(p for p in parts[:-1] if p in ('ctrl', 'alt', 'shift', 'meta', 'altGraph'))
    return ' '.join(mods + [parts[-1]]) if parts else ''


def mac(stroke):
    """The platform's conversion for the macOS keymaps: Ctrl and Cmd swapped, in each keystroke of the shortcut."""

    def one(keystroke):
        parts = keystroke.split()
        mods = sorted({'ctrl': 'meta', 'meta': 'ctrl'}.get(p, p) for p in parts[:-1])
        return ' '.join(mods + parts[-1:])

    return ' then '.join(one(k) for k in stroke.split(' then '))


def chord(stroke):
    """`ctrl alt shift R` as `ctrl alt shift R`: modifiers in the order Piwi writes them, or None for another key."""
    parts = stroke.split()
    mods, key = set(parts[:-1]), parts[-1] if parts else ''
    for first in ('ctrl', 'meta'):
        if mods == {first, 'alt', 'shift'} and len(key) == 1 and key.isalpha():
            return f'{first} alt shift {key.upper()}'
    return None


class Ide:
    def __init__(self):
        self.files = {}  # a keymap file's name, `Visual Studio` for `keymaps/Visual Studio.xml` -> its keymap
        self.bundled = set()  # the keymap files a descriptor's `bundledKeymap` names, which the platform loads alone
        self.plugin = []  # (keymap, action, op, stroke)

    def xml(self, name, data):
        if name.endswith('JetBrainsClientPlugin.xml'):
            # The JetBrains Client's descriptor, which the IDE does not load.
            return
        if b'<keymap' in data and (name.startswith('keymaps/') or '/keymaps/' in name):
            self.keymap(os.path.basename(name)[: -len('.xml')], data)
        else:
            if b'<bundledKeymap' in data:
                for file in re.findall(rb'<bundledKeymap[^>]*\sfile="([^"]+)"', data):
                    self.bundled.add(os.path.basename(file.decode())[: -len('.xml')])
            if b'<keyboard-shortcut' in data:
                self.descriptor(data)

    @property
    def keymaps(self):
        """The keymaps the platform loads: the files a `bundledKeymap` names, each named after its file."""
        return {name: k for name, k in self.files.items() if name in self.bundled}

    def keymap(self, name, data):
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            return
        if root.tag != 'keymap':
            return
        actions = {}
        for action in root.findall('action'):
            actions[action.get('id')] = [
                strokes(s.get('first-keystroke', '')) + (' then ' + strokes(s.get('second-keystroke')) if s.get('second-keystroke') else '')
                for s in action.findall('keyboard-shortcut')
            ]
        self.files[name] = {'parent': root.get('parent'), 'actions': actions}

    def descriptor(self, data):
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            return
        # The platform reads an action's shortcuts alone (`processActionElement`), never a reference's, and drops one
        # that names no keymap.
        for action in root.iter('action'):
            for s in action.findall('keyboard-shortcut'):
                if not s.get('keymap'):
                    continue
                stroke = strokes(s.get('first-keystroke', ''))
                if s.get('second-keystroke'):
                    stroke += ' then ' + strokes(s.get('second-keystroke'))
                if s.get('replace-all') == 'true':
                    self.plugin.append((s.get('keymap'), action.get('id'), 'clear', stroke))
                if s.get('remove') == 'true':
                    self.plugin.append((s.get('keymap'), action.get('id'), 'remove', stroke))
                else:
                    self.plugin.append((s.get('keymap'), action.get('id'), 'add', stroke))

    def jar(self, name, data):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for entry in z.namelist():
                    if entry.endswith('.xml'):
                        self.xml(entry, z.read(entry))
        except zipfile.BadZipFile:
            pass

    def resolve(self):
        """Each keymap's actions as the platform resolves them, plugins' shortcuts applied."""
        keymaps = self.keymaps
        own = {name: {a: list(s) for a, s in k['actions'].items()} for name, k in keymaps.items()}
        resolved = {}

        def effective(name, action, seen=()):
            if name in own and action in own[name]:
                return own[name][action]
            parent = keymaps.get(name, {}).get('parent')
            if not parent or parent in seen:
                return []
            inherited = effective(parent, action, seen + (name,))
            return [mac(s) for s in inherited] if name.startswith(MAC_PREFIX) else inherited

        # A plugin's shortcut goes to the keymap it names, the parent's first so that its children inherit it.
        def depth(name, seen=()):
            parent = keymaps.get(name, {}).get('parent')
            return 0 if not parent or parent in seen else 1 + depth(parent, seen + (name,))

        for keymap, action, op, stroke in sorted(self.plugin, key=lambda p: depth(p[0])):
            if keymap not in keymaps:
                continue
            current = list(effective(keymap, action))
            if op == 'clear':
                current = []
            elif op == 'remove':
                current = [s for s in current if s != stroke]
            elif stroke not in current:
                current.append(stroke)
            own.setdefault(keymap, {})[action] = current

        actions = set(a for k in own.values() for a in k) | set(p[1] for p in self.plugin)
        for name in keymaps:
            chords = {}
            for action in actions:
                for s in effective(name, action):
                    first = s.split(' then ')[0]
                    c = chord(first)
                    if c:
                        chords.setdefault(c, set()).add(action)
            resolved[name] = {
                'parent': keymaps[name]['parent'],
                'chords': {c: sorted(a) for c, a in sorted(chords.items())},
            }
        return resolved


def read(ide, source):
    if source == '-':
        stream = tarfile.open(fileobj=sys.stdin.buffer, mode='r|gz')
    elif os.path.isdir(source):
        for folder, _, files in os.walk(source):
            for f in files:
                path = os.path.join(folder, f)
                if f.endswith('.jar'):
                    with open(path, 'rb') as jar:
                        ide.jar(path, jar.read())
                elif f.endswith('.xml'):
                    with open(path, 'rb') as x:
                        ide.xml(os.path.relpath(path, source), x.read())
        return
    else:
        stream = tarfile.open(source, mode='r|gz')
    for member in stream:
        if not member.isfile():
            continue
        if member.name.endswith('.jar'):
            ide.jar(member.name, stream.extractfile(member).read())
        elif member.name.endswith('.xml'):
            ide.xml(member.name, stream.extractfile(member).read())


def main():
    snapshot = {'ides': {}}
    if os.path.exists(OUT):
        with open(OUT) as f:
            snapshot = json.load(f)
    args = sys.argv[1:]
    while '--drop' in args:
        at = args.index('--drop')
        snapshot['ides'].pop(args[at + 1], None)
        del args[at : at + 2]
    for arg in args:
        name, source = arg.split('=', 1)
        ide = Ide()
        read(ide, source)
        snapshot['ides'][name] = ide.resolve()
        print(f'{name}: {len(ide.keymaps)} keymaps', file=sys.stderr)
    snapshot['ides'] = dict(sorted(snapshot['ides'].items()))
    with open(OUT, 'w') as f:
        json.dump(snapshot, f, indent=1, sort_keys=False)
        f.write('\n')


if __name__ == '__main__':
    main()
