import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { EDITOR_CHORDS, MAC_KEYMAP_PREFIX, SHARED_CHORDS, VSCODE_TAKEN, type EditorChord } from '../src/keys';

const root = path.resolve(__dirname, '..', '..', '..');
const vscodeManifest = JSON.parse(fs.readFileSync(path.join(root, 'apps/vscode/package.json'), 'utf-8'));
const pluginXml = fs.readFileSync(path.join(root, 'apps/jetbrains/src/main/resources/META-INF/plugin.xml'), 'utf-8');
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
 * the entry's own, else `$default`'s, with Ctrl turned to Cmd by a macOS keymap in between.
 */
function chordIn(keymaps: Keymaps, name: string, chord: EditorChord): string {
  const names = chain(keymaps, name);
  const at = names.findIndex((n) => chord.keymaps?.[n]);
  const letter = at >= 0 ? chord.keymaps![names[at]!]! : chord.letter;
  const below = at >= 0 ? names.slice(0, at + 1) : names;
  const mac = at >= 0 ? isMac(keymaps, names[at]!) : below.some((n) => n.startsWith(MAC_KEYMAP_PREFIX));
  return `${mac ? 'meta' : 'ctrl'} alt shift ${letter}`;
}

describe('the chords both editors bind', () => {
  test('collide in no keymap bundled with WebStorm, IntelliJ IDEA Ultimate or Rider', () => {
    expect(
      Object.keys(bundled.ides)
        .map((ide) => ide.split('-')[0])
        .sort(),
    ).toEqual(['IU', 'RD', 'WS']);
    const collisions: string[] = [];
    for (const [ide, keymaps] of Object.entries(bundled.ides)) {
      for (const name of Object.keys(keymaps)) {
        const ours = new Map<string, string>();
        for (const chord of EDITOR_CHORDS) {
          const stroke = chordIn(keymaps, name, chord);
          // Two of Piwi's in one keymap collide too.
          if (ours.has(stroke))
            collisions.push(`${ide} ${name}: ${stroke} for ${ours.get(stroke)} and ${chord.jetbrains[0]}`);
          ours.set(stroke, chord.jetbrains[0]!);
          const others = (keymaps[name]!.chords[stroke] ?? []).filter((action) => !(action in SHARED_CHORDS));
          if (others.length)
            collisions.push(`${ide} ${name}: ${stroke} for ${chord.jetbrains[0]} is ${others.join(', ')}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  test('share a chord only with actions some bundled keymap binds', () => {
    const bound = new Set(
      Object.values(bundled.ides).flatMap((keymaps) =>
        Object.values(keymaps).flatMap((k) => Object.values(k.chords).flat()),
      ),
    );
    expect(Object.keys(SHARED_CHORDS).filter((action) => !bound.has(action))).toEqual([]);
  });

  test('override a letter only in a keymap some IDE bundles', () => {
    const names = new Set(Object.values(bundled.ides).flatMap((keymaps) => Object.keys(keymaps)));
    for (const chord of EDITOR_CHORDS) {
      for (const keymap of Object.keys(chord.keymaps ?? {})) expect(names.has(keymap), keymap).toBe(true);
    }
  });

  test("are VS Code's keybindings, free in its default keymap", () => {
    const bindings = vscodeManifest.contributes.keybindings as Array<{ command: string; key: string; mac?: string }>;
    const chorded = bindings.filter((b) => b.key.startsWith('ctrl+shift+alt+'));
    expect(chorded.map((b) => b.command).sort()).toEqual(EDITOR_CHORDS.flatMap((c) => c.vscode).sort());
    for (const chord of EDITOR_CHORDS) {
      expect(VSCODE_TAKEN, chord.letter).not.toContain(chord.letter);
      for (const command of chord.vscode) {
        const binding = chorded.find((b) => b.command === command)!;
        expect(binding.key, command).toBe(`ctrl+shift+alt+${chord.letter.toLowerCase()}`);
        expect(binding.mac, command).toBe(`cmd+shift+alt+${chord.letter.toLowerCase()}`);
      }
    }
  });

  test("are plugin.xml's shortcuts: $default's, and each keymap's own replacing what it inherits", () => {
    const keymaps = Object.values(bundled.ides).reduce<Keymaps>((all, k) => ({ ...all, ...k }), {});
    const declared = (id: string) => {
      const action =
        new RegExp(`<action id="${id.replace(/\./g, '\\.')}"[\\s\\S]*?</action>`).exec(pluginXml)?.[0] ?? '';
      return [...action.matchAll(/<keyboard-shortcut ([^>]*)\/>/g)].map((m) => m[1]!.trim()).sort();
    };
    for (const chord of EDITOR_CHORDS) {
      const expected = [
        `keymap="$default" first-keystroke="ctrl alt shift ${chord.letter}"`,
        ...Object.entries(chord.keymaps ?? {}).map(
          ([keymap, letter]) =>
            `keymap="${keymap}" first-keystroke="${isMac(keymaps, keymap) ? 'meta' : 'ctrl'} alt shift ${letter}" replace-all="true"`,
        ),
      ].sort();
      for (const id of chord.jetbrains) expect(declared(id), id).toEqual(expected);
    }
    // No other action of the plugin binds Ctrl+Alt+Shift with a letter.
    const all = [...pluginXml.matchAll(/first-keystroke="(ctrl|meta) alt shift [A-Z]"/g)].length;
    const ours = EDITOR_CHORDS.reduce((n, c) => n + c.jetbrains.length * (1 + Object.keys(c.keymaps ?? {}).length), 0);
    expect(all).toBe(ours);
  });
});
