/**
 * Desktop build: the editor whose hub a job the shell runs in a throwaway checkout of a linked folder runs on (a
 * reproduction, a bisect step, a Flake Lab), picked as a run started in a terminal picks one (`editorForRun`): of the
 * live editors' discovery files (`~/.piwi/editors`, `readLiveEditorsIn`, which deletes
 * a file whose process is gone), the editor whose workspace holds the linked folder, as the reporter takes one
 * (`stillServing`): its file written since this machine started, its run channel's socket this user's in a folder no
 * other user can enter (but on Windows, where a named pipe tells no owner). A job goes only to an editor whose file
 * says it knows a throwaway checkout's runs (`checkout`), and one nobody attends only to an editor that knows such runs
 * too (`unattended`). The shell alone hears the channel, through `GET /api/desktop/run-channel`, which refuses a
 * browser: no window ever reads the editor's token.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { editorForRun, writtenSinceBoot, type EditorDiscovery } from '@piwitests/core/editor-discovery';
import { formatRecordChannel } from '@piwitests/core/ide-recorder';
import { editorsDir, readLiveEditorsIn } from '@piwitests/editor/discovery';

/** The editor a job runs on: its run channel as `PIWI_RUN_CHANNEL` names it (`<path>#<token>`), and its name. */
export interface DesktopEditorHub {
  runChannel: string;
  client: string | null;
}

export interface EditorHubPick {
  /** A folder's real path, its links followed; null for one that is gone. */
  real(folder: string): string | null;
  win32: boolean;
  /** Whether the editor's file and run channel are still its own (`editorStillServing` by default). */
  serving(editor: EditorDiscovery): boolean;
}

/** A folder's real path, as the file system spells it; null for one that is gone. */
function realFolder(folder: string): string | null {
  try {
    return fs.realpathSync.native(folder);
  } catch {
    return null;
  }
}

/** Whether `dir` is a folder, not a link, that this user owns and no other user can enter. */
function privateFolder(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) return false;
    if (typeof process.getuid !== 'function') return true;
    return stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * Whether an editor's file and run channel are still its own, as the reporter's `stillServing` tells: the file written
 * since this machine started (`writtenSinceBoot`: a file of before names an id another process may have taken since),
 * its channel a socket, not a link, this user owns, in a folder no other user can enter. On Windows, a named pipe tells
 * no owner: the file's time and its process running (`readLiveEditorsIn`) are what is checked.
 */
export function editorStillServing(
  editor: EditorDiscovery,
  now: number = Date.now(),
  uptimeMs: number = os.uptime() * 1000,
): boolean {
  const channel = editor.runChannel;
  if (!channel || !writtenSinceBoot(editor, now, uptimeMs)) return false;
  if (process.platform === 'win32') return true;
  try {
    const stat = fs.lstatSync(channel.path);
    const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
    return stat.isSocket() && owned && privateFolder(path.dirname(channel.path));
  } catch {
    return false;
  }
}

/**
 * The editor of `editors` a job of the linked folder `folder` runs on: the one whose workspace holds the folder, the
 * most specific first (`editorForRun`), whose channel still serves and that knows a throwaway checkout's runs; for a job
 * nobody attends (`attended` false), only one that knows such runs too. Null when none does.
 */
export function editorHubOf(
  editors: readonly EditorDiscovery[],
  folder: string,
  attended: boolean,
  pick: EditorHubPick,
): DesktopEditorHub | null {
  const serving = editors.filter(
    (editor) => editor.checkout === true && (attended || editor.unattended === true) && pick.serving(editor),
  );
  const editor = editorForRun(serving, [folder], pick.real, pick.win32);
  if (!editor?.runChannel) return null;
  return { runChannel: formatRecordChannel(editor.runChannel), client: editor.client };
}

/** The editor a job of the linked folder `folder` runs on, from the discovery files of `dir`; null for none. */
export function editorHubFor(folder: string, attended: boolean, dir: string = editorsDir()): DesktopEditorHub | null {
  if (!path.isAbsolute(folder)) return null;
  return editorHubOf(readLiveEditorsIn(dir), folder, attended, {
    real: realFolder,
    win32: process.platform === 'win32',
    serving: (editor) => editorStillServing(editor),
  });
}
