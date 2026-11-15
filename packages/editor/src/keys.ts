/**
 * Piwi's chords in both editors, from one table: `Ctrl+Alt+Shift` with a letter (`Cmd` on macOS) in VS Code's default
 * keybindings and in the JetBrains `$default` keymap, and another letter in a JetBrains keymap where that chord is
 * another action's, the keymaps descending from it taking it too. `tests/keys.test.ts` holds `apps/vscode/package.json`
 * and `apps/jetbrains/.../plugin.xml` to it, and checks each chord against every keymap bundled with WebStorm, IntelliJ
 * IDEA Ultimate and Rider (`apps/jetbrains/keymap-chords.json`, which `apps/jetbrains/scripts/keymap-chords.py` reads
 * from the IDEs) and against VS Code's own (`VSCODE_TAKEN`).
 */
export interface EditorChord {
  /** The VS Code commands the chord runs, the same one where they never apply at once. */
  vscode: string[];
  /** The JetBrains actions the chord runs. */
  jetbrains: string[];
  /** The letter in VS Code and in the JetBrains `$default` keymap. */
  letter: string;
  /** The letter in a JetBrains keymap, and those descending from it, where `letter` is another action's chord. */
  keymaps?: Record<string, string>;
}

export const EDITOR_CHORDS: readonly EditorChord[] = [
  {
    vscode: ['piwi.record', 'piwi.stopRecording'],
    jetbrains: ['Piwi.RecordHere', 'Piwi.StopRecording'],
    letter: 'R',
    // Choose Run Configuration in the Visual Studio family, Force Refresh in Mac OS X 10.5+ and its descendants.
    keymaps: { 'Visual Studio': 'O', 'Mac OS X 10.5+': 'O' },
  },
  {
    vscode: ['piwi.rerunFailing'],
    jetbrains: ['Piwi.RerunFailing'],
    letter: 'F',
    // Silent Code Cleanup.
    keymaps: { ReSharper: 'T', 'ReSharper OSX': 'T' },
  },
  {
    vscode: ['piwi.runTestAtCursor'],
    jetbrains: ['Piwi.RunTestAtCursor'],
    letter: 'K',
    // Commit and Push in the Visual Studio family, Commit in Visual Studio OSX's.
    keymaps: { 'Visual Studio': 'J', 'Visual Studio OSX': 'J' },
  },
  { vscode: ['piwi.openFailures'], jetbrains: ['Piwi.OpenFailures'], letter: 'Z' },
];

/** A JetBrains keymap whose name starts with this, and every keymap descending from one, takes Cmd for Ctrl. */
export const MAC_KEYMAP_PREFIX = 'Mac OS X';

/**
 * The actions a Piwi chord may share in a JetBrains keymap: each acts only where Piwi's do not, so the one that applies
 * runs. A chord shared with any other action is a collision.
 */
export const SHARED_CHORDS: Record<string, string> = {
  'Console.TableResult.CloneColumn': "in a database console's result grid",
  'Console.TableResult.EditFilterCriteria': "in a database console's result grid",
  'Console.TableResult.MaximizeEditingCell': "in a database console's result grid",
  'DatabaseView.CopyDdlAction': 'in the Database tool window',
  'DatabaseView.FullTextSearch': 'in the Database tool window',
  'DatabaseView.OpenDdlInConsole': 'in the Database tool window',
  'Jdbc.OpenConsole.New.InPath': 'in the Database tool window',
  ConvertJavaToKotlin: 'on a Java file',
  ConvertJavaToKotlinInGroup: 'on a Java file',
  ReloadScriptConfiguration: 'in a Kotlin script',
};

/**
 * The letters VS Code's default keybindings take with `ctrl+shift+alt` (`cmd` on macOS), read in the `microsoft/vscode`
 * sources (1.145): `i` on Linux alone and `n` in VS Code for the Web alone.
 */
export const VSCODE_TAKEN = ['A', 'C', 'G', 'I', 'L', 'N', 'O'];
