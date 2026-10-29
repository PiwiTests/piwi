// The folders a take and a cut write their results into, which they empty first: only a folder the showcase made, and
// never one that holds what they read.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { REPO_ROOT } from './workspace.mjs';

/** The file that marks a folder as the showcase's results, which a take or a cut may empty. */
export const RESULTS_MARKER = '.piwi-showcase-results';

/** Whether `dir` is `parent` or lies inside it. */
const within = (dir, parent) => dir === parent || dir.startsWith(`${parent}${path.sep}`);

/**
 * Why `dir` may not be emptied for results, or null: the file system's root, the home folder, the repository's root
 * or the current folder; a folder that holds, or is, the take a cut reads (`keep`); a folder that holds files without
 * the marker.
 */
export function refusal(dir, { keep = null, cwd = process.cwd() } = {}) {
  const resolved = path.resolve(dir);
  const refused = [path.parse(resolved).root, os.homedir(), REPO_ROOT, cwd].map((p) => path.resolve(p));
  if (refused.includes(resolved))
    return 'emptying it for results would remove what is not results: name a folder of its own';
  if (keep && within(path.resolve(keep), resolved)) {
    return `it is, or holds, the take the cut reads (${path.resolve(keep)}): name a folder in the take or beside it`;
  }
  if (fs.existsSync(resolved)) {
    const entries = fs.readdirSync(resolved);
    if (entries.length && !entries.includes(RESULTS_MARKER)) {
      return "it holds files no take or cut wrote: name an empty folder or a take's results";
    }
  }
  return null;
}

/** Empties `dir` for results and marks it, unless `refusal` refuses it, which throws. */
export function prepareOut(dir, options = {}) {
  const why = refusal(dir, options);
  if (why) throw new Error(`--out ${dir}: ${why}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, RESULTS_MARKER),
    'The results of a showcase take or cut: the next one empties this folder.\n',
  );
}
