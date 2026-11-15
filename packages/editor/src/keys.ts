/**
 * Piwi's chords in both editors, from one table: `Ctrl+Alt+Shift` with a letter (`Cmd` on macOS) in VS Code's default
 * keybindings and in the JetBrains `$default` keymap, and another letter, or none, in a JetBrains keymap that gives that
 * chord to an action acting where Piwi's do, the keymaps descending from it taking it too. From the keyboard, a chord of
 * Piwi's acts in an editor of a JavaScript or TypeScript file or in Piwi's failures alone (`CHORD_CONTEXT` in VS Code,
 * `Glue.chordActsIn` in JetBrains), so it may share its key with an action acting elsewhere alone (`SHARED_CHORDS`).
 * `tests/keys.test.ts` holds `apps/vscode/package.json`, `apps/jetbrains/.../plugin.xml` and the docs' table of keys to
 * it, and checks each chord against every keymap bundled with the JetBrains IDEs the plugin installs in
 * (`apps/jetbrains/keymap-chords.json`, which `apps/jetbrains/scripts/keymap-chords.py` reads from them) and against
 * VS Code's own (`VSCODE_TAKEN`).
 */
export interface EditorChord {
  /** The VS Code commands the chord runs, the same one where they never apply at once. */
  vscode: string[];
  /** The JetBrains actions the chord runs. */
  jetbrains: string[];
  /** The letter in VS Code and in the JetBrains `$default` keymap. */
  letter: string;
  /** The letter in a JetBrains keymap, and those descending from it, where `letter` is another action's; null for none. */
  keymaps?: Record<string, string | null>;
}

export const EDITOR_CHORDS: readonly EditorChord[] = [
  {
    vscode: ['piwi.record', 'piwi.stopRecording'],
    jetbrains: ['Piwi.RecordHere', 'Piwi.StopRecording'],
    letter: 'R',
    // Choose Run Configuration in the Visual Studio family, Force Refresh in Mac OS X 10.5+'s.
    keymaps: { 'Visual Studio': 'G', ReSharper: null, 'Mac OS X 10.5+': 'Z' },
  },
  {
    vscode: ['piwi.rerunFailing'],
    jetbrains: ['Piwi.RerunFailing'],
    letter: 'F',
    // Silent Code Cleanup in ReSharper's, Replace in Path in TextMate's.
    keymaps: { ReSharper: 'T', 'ReSharper OSX': 'T', TextMate: 'Y' },
  },
  {
    vscode: ['piwi.runTestAtCursor'],
    jetbrains: ['Piwi.RunTestAtCursor'],
    letter: 'K',
    // Commit and Push in the Visual Studio family, Commit in Visual Studio OSX's.
    keymaps: { 'Visual Studio': 'J', 'Visual Studio OSX': 'J' },
  },
  {
    vscode: ['piwi.openFailures'],
    jetbrains: ['Piwi.OpenFailures'],
    letter: 'B',
    // Surround With in the Linux desktops' keymaps, Go to Implementation in ReSharper's.
    keymaps: { 'Default for XWin': 'G', ReSharper: null, 'ReSharper OSX': 'S' },
  },
];

/** A JetBrains keymap whose name starts with this, and every keymap descending from one, takes Cmd for Ctrl. */
export const MAC_KEYMAP_PREFIX = 'Mac OS X';

/** Where a chord of Piwi's acts from the keyboard in VS Code: an editor of a JavaScript or TypeScript file, or the failures. */
export const CHORD_CONTEXT =
  '(editorTextFocus && editorLangId =~ /^(typescript|javascript)(react)?$/) || focusedView == piwi.failures';

/**
 * The actions a chord of Piwi's may share in a JetBrains keymap, each with where it acts alone: never in an editor of a
 * JavaScript or TypeScript file nor in the Piwi tool window, where Piwi's do. Any other action on its key is a collision.
 */
export const SHARED_CHORDS: Record<string, string> = {
  'Console.TableResult.EditFilterCriteria': "a database console's result grid",
  'DatabaseView.CopyDdlAction': 'the Database tool window',
  'DatabaseView.FullTextSearch': 'the Database tool window',
  'DatabaseView.OpenDdlInConsole': 'the Database tool window',
  ConvertJavaToKotlin: 'a Java file',
  ConvertJavaToKotlinInGroup: 'a Java file',
  GoFmtFileAction: 'a Go file',
  ReloadScriptConfiguration: 'a Kotlin script',
  TfFmtFileAction: 'a Terraform file',
};

/**
 * The letters VS Code's default keybindings take with `ctrl+shift+alt` (`cmd` on macOS), read in the `microsoft/vscode`
 * sources (1.145): `i` on Linux alone and `n` in VS Code for the Web alone.
 */
export const VSCODE_TAKEN = ['A', 'C', 'G', 'I', 'L', 'N', 'O'];

/**
 * The letters a chord of Piwi's leaves alone in a keymap of Windows and Linux, where `Ctrl+Alt` is AltGr: a Polish
 * keyboard types ą, ć, ę, ł, ń, ó, ś, ź and ż with them, Shift giving the capitals.
 */
export const ALTGR_LETTERS = ['A', 'C', 'E', 'L', 'N', 'O', 'S', 'X', 'Z'];
