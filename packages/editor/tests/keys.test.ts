import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ALTGR_LETTERS,
  CHORD_CONTEXT,
  EDITOR_CHORDS,
  MAC_KEYMAP_PREFIX,
  SHARED_CHORDS,
  VSCODE_TAKEN,
  type EditorChord,
} from '../src/keys';

const root = path.resolve(__dirname, '..', '..', '..');
const vscodeManifest = JSON.parse(fs.readFileSync(path.join(root, 'apps/vscode/package.json'), 'utf-8'));
const pluginXml = fs.readFileSync(path.join(root, 'apps/jetbrains/src/main/resources/META-INF/plugin.xml'), 'utf-8');
const keysDoc = fs.readFileSync(path.join(root, 'apps/docs/reference/editor-commands.md'), 'utf-8');
/** What each keymap bundled with each IDE binds to Ctrl/Cmd+Alt+Shift with a letter: `scripts/keymap-chords.py`. */
const bundled = JSON.parse(fs.readFileSync(path.join(root, 'apps/jetbrains/keymap-chords.json'), 'utf-8')) as {
  ides: Record<string, Record<string, { parent: string | null; chords: Record<string, string[]> }>>;
};

type Keymaps = (typeof bundled.ides)[string];

/** A keymap and those it descends from, nearest first. */
function chain(keymaps: Keymaps, name: string): string[] {
  const names: string[] = [];
  for (let at: string | null | undefined = name; at && !names.includes(at); at = keymaps[at]?.parent) names.push(at);
  return names;
}

/** Whether a keymap takes Cmd for Ctrl: its name, or one it descends from, starts with `Mac OS X`. */
function isMac(keymaps: Keymaps, name: string): boolean {
  return chain(keymaps, name).some((n) => n.startsWith(MAC_KEYMAP_PREFIX));
}

/**
 * The chord a keymap gives an entry, as the platform resolves Piwi's shortcuts: the letter of the nearest keymap of
 * the entry's own, else `$default`'s, with Ctrl and Cmd swapped by each macOS keymap in between; null for none.
 */
function chordIn(keymaps: Keymaps, name: string, chord: EditorChord): string | null {
  const names = chain(keymaps, name);
  const at = names.findIndex((n) => chord.keymaps && n in chord.keymaps);
  const letter = at >= 0 ? chord.keymaps![names[at]!]! : chord.letter;
  if (letter === null) return null;
  // The platform swaps Ctrl and Cmd as a keymap named `Mac OS X…` inherits; a keymap's own shortcut is as written.
  const own = at >= 0 ? isMac(keymaps, names[at]!) : false;
  const swaps = (at >= 0 ? names.slice(0, at) : names).filter((n) => n.startsWith(MAC_KEYMAP_PREFIX)).length;
  const mac = swaps % 2 === 1 ? !own : own;
  return `${mac ? 'meta' : 'ctrl'} alt shift ${letter}`;
}

/** Every keymap name of the snapshot, with one IDE's keymaps it is found in. */
const allKeymaps = new Map<string, Keymaps>();
for (const keymaps of Object.values(bundled.ides))
  for (const name of Object.keys(keymaps)) allKeymaps.set(name, keymaps);

/** `ctrl alt shift R` from any order and case of the modifiers, or null for a chord of another shape. */
function normalized(keystroke: string): string | null {
  const parts = keystroke
    .toLowerCase()
    .replace('control', 'ctrl')
    .split(/[\s+]+/);
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => (p === 'cmd' ? 'meta' : p)));
  if (!/^[a-z]$/.test(key) || mods.size !== 3 || !mods.has('alt') || !mods.has('shift')) return null;
  const first = mods.has('ctrl') ? 'ctrl' : mods.has('meta') ? 'meta' : null;
  return first ? `${first} alt shift ${key.toUpperCase()}` : null;
}

describe('the chords both editors bind', () => {
  test('collide in no keymap bundled with the JetBrains IDEs of the snapshot', () => {
    expect(new Set(Object.keys(bundled.ides).map((ide) => ide.split('-')[0]))).toEqual(
      new Set(['GO', 'IU', 'PS', 'PY', 'RD', 'RM', 'WS']),
    );
    // The oldest platform the plugin supports, `pluginSinceBuild`.
    expect(Object.keys(bundled.ides)).toContain('WS-2024.1');
    const collisions: string[] = [];
    for (const [ide, keymaps] of Object.entries(bundled.ides)) {
      for (const name of Object.keys(keymaps)) {
        const ours = new Map<string, string>();
        for (const chord of EDITOR_CHORDS) {
          const stroke = chordIn(keymaps, name, chord);
          if (!stroke) continue;
          // Two of Piwi's in one keymap collide too.
          if (ours.has(stroke))
            collisions.push(`${ide} ${name}: ${stroke} for ${ours.get(stroke)} and ${chord.jetbrains[0]}`);
          ours.set(stroke, chord.jetbrains[0]!);
          const others = (keymaps[name]!.chords[stroke] ?? []).filter((action) => !(action in SHARED_CHORDS));
          if (others.length)
            collisions.push(`${ide} ${name}: ${stroke} for ${chord.jetbrains[0]} is ${others.join(', ')}`);
          // A keymap descends from keymaps other IDEs bundle too, each version binding its own: an action another
          // version binds to the chord, which this IDE's binds elsewhere or not at all, is the keymap's in that version.
          for (const [other, theirs] of Object.entries(bundled.ides)) {
            if (other === ide) continue;
            for (const ancestor of chain(keymaps, name).slice(1)) {
              if (!theirs[ancestor] || chordIn(theirs, ancestor, chord) === stroke) continue;
              const here = keymaps[ancestor]?.chords[stroke] ?? [];
              const inherited = (theirs[ancestor].chords[stroke] ?? []).filter(
                (action) => !(action in SHARED_CHORDS) && !here.includes(action),
              );
              if (inherited.length) {
                collisions.push(
                  `${ide} ${name}: ${stroke} for ${chord.jetbrains[0]} is ${inherited.join(', ')} in ${other} ${ancestor}`,
                );
              }
            }
          }
          // A keymap of Windows and Linux, where Ctrl+Alt is AltGr, leaves the letters a keyboard types with it alone.
          if (stroke.startsWith('ctrl') && ALTGR_LETTERS.includes(stroke.slice(-1))) {
            collisions.push(`${ide} ${name}: ${stroke} for ${chord.jetbrains[0]} types a letter with AltGr`);
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  test('share a key only with an action that meets one of them somewhere', () => {
    const met = new Set<string>();
    for (const keymaps of Object.values(bundled.ides)) {
      for (const name of Object.keys(keymaps)) {
        for (const chord of EDITOR_CHORDS) {
          const stroke = chordIn(keymaps, name, chord);
          if (!stroke) continue;
          for (const action of keymaps[name]!.chords[stroke] ?? []) met.add(action);
          // An action of another IDE's version of a keymap this one descends from.
          for (const theirs of Object.values(bundled.ides)) {
            for (const ancestor of chain(keymaps, name).slice(1)) {
              for (const action of theirs[ancestor]?.chords[stroke] ?? []) met.add(action);
            }
          }
        }
      }
    }
    expect(Object.keys(SHARED_CHORDS).filter((action) => !met.has(action))).toEqual([]);
  });

  test('take a letter of their own only in a keymap some IDE bundles', () => {
    for (const chord of EDITOR_CHORDS) {
      for (const keymap of Object.keys(chord.keymaps ?? {})) expect(allKeymaps.has(keymap), keymap).toBe(true);
    }
  });

  test("are VS Code's keybindings, free in its default keymap, acting where Piwi's chords do", () => {
    const bindings = vscodeManifest.contributes.keybindings as Array<{
      command: string;
      key: string;
      mac?: string;
      when?: string;
    }>;
    const chorded = bindings.filter((b) => normalized(b.key) || (b.mac && normalized(b.mac)));
    expect(chorded.map((b) => b.command).sort()).toEqual(EDITOR_CHORDS.flatMap((c) => c.vscode).sort());
    // An action of an editor's alone acts in a JavaScript or TypeScript editor alone.
    const editorOnly = 'editorTextFocus && editorLangId =~ /^(typescript|javascript)(react)?$/';
    for (const chord of EDITOR_CHORDS) {
      expect(VSCODE_TAKEN, chord.letter).not.toContain(chord.letter);
      for (const command of chord.vscode) {
        const binding = chorded.find((b) => b.command === command)!;
        expect(binding.key, command).toBe(`ctrl+shift+alt+${chord.letter.toLowerCase()}`);
        expect(binding.mac, command).toBe(`cmd+shift+alt+${chord.letter.toLowerCase()}`);
        const when = binding.when ?? '';
        const inContext =
          when === CHORD_CONTEXT || when.endsWith(` && (${CHORD_CONTEXT})`) || when.includes(editorOnly);
        expect(inContext, `${command}: ${when}`).toBe(true);
      }
    }
  });

  test("are plugin.xml's shortcuts: $default's, each keymap's own replacing what it inherits", () => {
    const declared = (id: string) => {
      const at = pluginXml.indexOf(`<action id="${id}"`);
      expect(at, id).toBeGreaterThanOrEqual(0);
      const open = pluginXml.indexOf('>', at);
      const action = pluginXml[open - 1] === '/' ? '' : pluginXml.slice(open, pluginXml.indexOf('</action>', open));
      return [...action.matchAll(/<keyboard-shortcut ([^>]*?)\s*\/>/g)].map((m) =>
        Object.fromEntries([...m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])),
      );
    };
    for (const chord of EDITOR_CHORDS) {
      for (const id of chord.jetbrains) {
        const shortcuts = declared(id);
        const own = (keymap: string) => shortcuts.filter((s) => s.keymap === keymap);
        expect(
          own('$default').map((s) => normalized(s['first-keystroke']!)),
          id,
        ).toEqual([`ctrl alt shift ${chord.letter}`]);
        for (const [keymap, letter] of Object.entries(chord.keymaps ?? {})) {
          const keymaps = allKeymaps.get(keymap)!;
          if (letter === null) {
            // None: the chord the keymap inherits is removed.
            const parent = keymaps[keymap]!.parent!;
            const inherited = chordIn(keymaps, parent, chord)!;
            const converted = keymap.startsWith(MAC_KEYMAP_PREFIX)
              ? inherited.replace(/^(ctrl|meta)/, (m) => (m === 'ctrl' ? 'meta' : 'ctrl'))
              : inherited;
            expect(
              own(keymap).map((s) => [normalized(s['first-keystroke']!), s.remove]),
              `${id} ${keymap}`,
            ).toEqual([[converted, 'true']]);
          } else {
            const stroke = `${isMac(keymaps, keymap) ? 'meta' : 'ctrl'} alt shift ${letter}`;
            expect(
              own(keymap).map((s) => [normalized(s['first-keystroke']!), s['replace-all']]),
              `${id} ${keymap}`,
            ).toEqual([[stroke, 'true']]);
          }
        }
        expect(shortcuts.length, id).toBe(1 + Object.keys(chord.keymaps ?? {}).length);
        // The platform applies them in order, so a keymap's own entry follows those of the keymaps it descends from.
        const order = shortcuts.map((s) => s.keymap!);
        for (const [at, keymap] of order.entries()) {
          const ancestors = keymap === '$default' ? [] : chain(allKeymaps.get(keymap)!, keymap).slice(1);
          for (const ancestor of ancestors) {
            if (order.includes(ancestor))
              expect(order.indexOf(ancestor), `${id}: ${ancestor} before ${keymap}`).toBeLessThan(at);
          }
        }
      }
    }
    // No other action of the plugin binds Ctrl or Cmd with Alt, Shift and a letter.
    const all = [...pluginXml.matchAll(/first-keystroke="([^"]*)"/g)].filter((m) => normalized(m[1]!)).length;
    const ours = EDITOR_CHORDS.reduce((n, c) => n + c.jetbrains.length * (1 + Object.keys(c.keymaps ?? {}).length), 0);
    expect(all).toBe(ours);
  });

  test("are the docs' table of keys, keymap by keymap", () => {
    const table = keysDoc
      .slice(keysDoc.indexOf('### Keys'))
      .split('\n')
      .filter((l) => l.startsWith('| '));
    const rows = table.slice(1).map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
    const listed = new Set<string>();
    for (const [first, ...cells] of rows) {
      const letters = cells.map((c) => (c === 'none' ? null : /^`([A-Z])`$/.exec(c)?.[1]));
      for (const keymap of [...first!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)) {
        listed.add(keymap);
        const keymaps = allKeymaps.get(keymap);
        expect(keymaps, keymap).toBeDefined();
        const resolved = EDITOR_CHORDS.map((c) => chordIn(keymaps!, keymap, c)?.slice(-1) ?? null);
        expect(letters, keymap).toEqual(resolved);
      }
    }
    // Every keymap whose chords differ from $default's is listed.
    const base = EDITOR_CHORDS.map((c) => c.letter);
    for (const [name, keymaps] of allKeymaps) {
      const letters = EDITOR_CHORDS.map((c) => chordIn(keymaps, name, c)?.slice(-1) ?? null);
      if (JSON.stringify(letters) !== JSON.stringify(base)) expect(listed.has(name), name).toBe(true);
    }
  });
});
