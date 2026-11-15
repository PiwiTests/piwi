#!/usr/bin/env python3
"""
What each keymap bundled with a JetBrains IDE binds to Ctrl+Alt+Shift and Cmd+Alt+Shift with a letter, the chords Piwi
chooses its keys from, written to `apps/jetbrains/keymap-chords.json` for `packages/editor/tests/keys.test.ts`.

Each IDE is read from its folder, its `.tar.gz`, or a `.tar.gz` piped to stdin (`-`), so an IDE never needs the disk:

    curl -sSL https://download.jetbrains.com/rider/JetBrains.Rider-2026.2.2.tar.gz | \\
      python3 scripts/keymap-chords.py RD-2026.2.2=- WS-263.7307.202=.ide/WebStorm-263.7307.202 IU-2026.2.3=ideaIU.tar.gz

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
    """The platform's conversion for the macOS keymaps: Ctrl and Cmd swapped."""
    parts = stroke.split()
    mods = sorted({'ctrl': 'meta', 'meta': 'ctrl'}.get(p, p) for p in parts[:-1])
    return ' '.join(mods + parts[-1:])


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
        self.keymaps = {}  # name -> {'parent': str|None, 'actions': {id: [stroke]}}
        self.plugin = []  # (keymap, action, op, stroke)

    def xml(self, name, data):
        if b'<keymap' in data and (name.startswith('keymaps/') or '/keymaps/' in name):
            self.keymap(data)
        elif b'<keyboard-shortcut' in data:
            self.descriptor(data)

    def keymap(self, data):
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            return
        if root.tag != 'keymap' or not root.get('name'):
            return
        actions = {}
        for action in root.findall('action'):
            actions[action.get('id')] = [
                strokes(s.get('first-keystroke', '')) + (' then ' + strokes(s.get('second-keystroke')) if s.get('second-keystroke') else '')
                for s in action.findall('keyboard-shortcut')
            ]
        self.keymaps[root.get('name')] = {'parent': root.get('parent'), 'actions': actions}

    def descriptor(self, data):
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            return
        for action in root.iter():
            if action.tag not in ('action', 'reference'):
                continue
            id = action.get('id') or action.get('ref')
            for s in action.findall('keyboard-shortcut'):
                op = 'remove' if s.get('remove') == 'true' else 'replace' if s.get('replace-all') == 'true' else 'add'
                stroke = strokes(s.get('first-keystroke', ''))
                if s.get('second-keystroke'):
                    stroke += ' then ' + strokes(s.get('second-keystroke'))
                self.plugin.append((s.get('keymap', '$default'), id, op, stroke))

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
        own = {name: {a: list(s) for a, s in k['actions'].items()} for name, k in self.keymaps.items()}
        resolved = {}

        def effective(name, action, seen=()):
            if name in own and action in own[name]:
                return own[name][action]
            parent = self.keymaps.get(name, {}).get('parent')
            if not parent or parent in seen:
                return []
            inherited = effective(parent, action, seen + (name,))
            return [mac(s) for s in inherited] if name.startswith(MAC_PREFIX) else inherited

        # A plugin's shortcut goes to the keymap it names, the parent's first so that its children inherit it.
        depth = lambda name: 0 if not self.keymaps.get(name, {}).get('parent') else 1 + depth(self.keymaps[name]['parent'])
        for keymap, action, op, stroke in sorted(self.plugin, key=lambda p: depth(p[0]) if p[0] in self.keymaps else 0):
            if keymap not in self.keymaps:
                continue
            current = list(effective(keymap, action))
            if op == 'replace':
                current = [stroke]
            elif op == 'remove':
                current = [s for s in current if s != stroke]
            elif stroke not in current:
                current.append(stroke)
            own.setdefault(keymap, {})[action] = current

        actions = set(a for k in own.values() for a in k) | set(p[1] for p in self.plugin)
        for name in self.keymaps:
            chords = {}
            for action in actions:
                for s in effective(name, action):
                    first = s.split(' then ')[0]
                    c = chord(first)
                    if c:
                        chords.setdefault(c, set()).add(action)
            resolved[name] = {
                'parent': self.keymaps[name]['parent'],
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
        elif member.name.endswith('.xml') and member.size < 4_000_000:
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
