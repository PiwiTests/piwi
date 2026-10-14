/**
 * Pure unified-diff parser and dry-run applier used to validate an AI-suggested
 * `suggestedFix.patch` against the real file content the model was shown. No
 * dependencies, no filesystem — safe to run on the server (and, later, the UI).
 *
 * The goal is a trustworthy signal, not a full `git apply` reimplementation:
 * we parse the hunks, then check that each hunk's context/deletion lines can be
 * located in the target file (at its stated position, or shifted — "offset"),
 * so the UI can badge a patch as verified rather than taking it on faith.
 */

/** The line a patch cut short ends with (`truncatePatch`, the AI context's patch budget). */
export const PATCH_TRUNCATED_NOTE = '[... patch truncated ...]';

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Body lines including their leading marker (' ' context, '+' add, '-' delete). */
  lines: string[];
}

export interface PatchFile {
  /** Path from `--- a/…` (null for /dev/null, i.e. a newly added file). */
  oldPath: string | null;
  /** Path from `+++ b/…` (null for /dev/null, i.e. a deleted file). */
  newPath: string | null;
  hunks: PatchHunk[];
}

export interface ParsedPatch {
  files: PatchFile[];
}

export type PatchValidationStatus = 'applies' | 'applies-with-offset' | 'stale-file' | 'invalid' | 'unchecked';

export interface PatchValidation {
  status: PatchValidationStatus;
  /** How many target files we actually had content for and could check. */
  filesChecked: number;
  /** How many distinct files the patch touches. */
  filesInPatch: number;
  /** Human-readable reasons, one per problem file. */
  errors: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The patch validation stored on a diagnosis's details: at the top of the
 * details, where Piwi's own diagnoses and agents' store it, else inside the
 * suggested fix, where agents' diagnoses recorded earlier keep it. `null` when
 * neither holds an object with a string `status`.
 */
export function storedPatchValidation(details: unknown): PatchValidation | null {
  const d = details as { patchValidation?: unknown; suggestedFix?: { patchValidation?: unknown } | null } | null;
  for (const candidate of [d?.patchValidation, d?.suggestedFix?.patchValidation]) {
    if (candidate && typeof candidate === 'object' && typeof (candidate as { status?: unknown }).status === 'string') {
      return candidate as PatchValidation;
    }
  }
  return null;
}

/** Whether a patch validation status says the patch applies (at its stated lines or shifted). */
export function patchApplies(status: unknown): boolean {
  return status === 'applies' || status === 'applies-with-offset';
}

const VALIDATION_LABELS: Record<PatchValidationStatus, string> = {
  applies: 'Applies cleanly',
  'applies-with-offset': 'Applies with offset',
  'stale-file': 'Does not apply',
  invalid: 'Invalid diff',
  unchecked: 'Unverified',
};

/** The words that state a patch validation status, as the patch's badge shows them. */
export function patchValidationLabel(status: PatchValidationStatus): string {
  return VALIDATION_LABELS[status] ?? VALIDATION_LABELS.unchecked;
}

/** A few lines of a unified diff around one changed run, as a small diff of their own. */
export interface PatchExcerpt {
  /** The `@@` row recomputed for the window, then the window's lines; no file headers. */
  diff: string;
  /** The file the window is in, without its `a/` or `b/` prefix. */
  file: string | null;
  /**
   * The body lines of every hunk of every file that the window leaves out,
   * except a blank context line it drops after its run.
   */
  hiddenLines: number;
  /** The removed and added lines among `hiddenLines`. */
  hiddenChanges: number;
  /** How many files the diff touches. */
  files: number;
}

/** A run of removed and added lines inside a hunk: `first` and `last` index its lines. */
interface ChangedRun {
  file: PatchFile;
  hunk: PatchHunk;
  first: number;
  last: number;
}

const isChange = (line: string) => line[0] === '+' || line[0] === '-';

/** A JavaScript or TypeScript import statement (not a dynamic `import(…)`). */
const IMPORT_RE = /^\s*import\b(?!\s*\()/;

/** Whether every non-blank line a run changes is an import statement. */
function importsOnly(run: ChangedRun): boolean {
  const changed = run.hunk.lines.slice(run.first, run.last + 1).map((line) => line.slice(1));
  const code = changed.filter((text) => text.trim() !== '');
  return code.length > 0 && code.every((text) => IMPORT_RE.test(text));
}

/**
 * The changed run a short preview shows: the one with the most removed and
 * added lines, the first on a tie. A run that only changes imports counts when
 * the diff changes nothing else, since the substance of a fix is rarely there.
 */
function previewRun(runs: ChangedRun[]): ChangedRun | null {
  const code = runs.filter((run) => !importsOnly(run));
  let best: ChangedRun | null = null;
  for (const run of code.length > 0 ? code : runs) {
    if (!best || run.last - run.first > best.last - best.first) best = run;
  }
  return best;
}

/**
 * A window of at most `maxLines` body lines on one changed run of a unified
 * diff (`previewRun`): the context line before it, the run of removed and added
 * lines, and the context line after it unless that line is blank, cut at
 * `maxLines`. The `@@` row is recomputed for the window by counting the old and
 * new lines from the hunk's start, so every line keeps its number. Null when
 * the diff does not parse or changes nothing.
 */
export function patchExcerpt(patch: string, maxLines = 6): PatchExcerpt | null {
  const parsed = parseUnifiedDiff(patch);
  const runs: ChangedRun[] = [];
  let total = 0;
  let totalChanges = 0;
  for (const file of parsed.files) {
    for (const hunk of file.hunks) {
      total += hunk.lines.length;
      for (let i = 0; i < hunk.lines.length; i++) {
        if (!isChange(hunk.lines[i]!)) continue;
        const first = i;
        while (i + 1 < hunk.lines.length && isChange(hunk.lines[i + 1]!)) i++;
        runs.push({ file, hunk, first, last: i });
        totalChanges += i - first + 1;
      }
    }
  }
  const run = previewRun(runs);
  if (!run) return null;

  const { file, hunk, first, last } = run;
  const start = Math.max(0, first - 1);
  let end = Math.min(hunk.lines.length - 1, last + 1, start + maxLines - 1);
  const blankAfter = end > last && hunk.lines[end]!.slice(1).trim() === '';
  if (blankAfter) end--;
  const window = hunk.lines.slice(start, end + 1);

  // The next old and new line numbers; an empty range's start names the line before it.
  let oldLine = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
  let newLine = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  for (const line of hunk.lines.slice(0, start)) {
    if (line[0] !== '+') oldLine++;
    if (line[0] !== '-') newLine++;
  }
  const oldCount = window.filter((line) => line[0] !== '+').length;
  const newCount = window.filter((line) => line[0] !== '-').length;
  const range = (line: number, count: number) => `${count === 0 ? line - 1 : line},${count}`;
  return {
    diff: [`@@ -${range(oldLine, oldCount)} +${range(newLine, newCount)} @@`, ...window].join('\n'),
    file: stripAbPrefix(file.newPath) ?? stripAbPrefix(file.oldPath),
    hiddenLines: total - window.length - (blankAfter ? 1 : 0),
    hiddenChanges: totalChanges - window.filter(isChange).length,
    files: parsed.files.length,
  };
}

/**
 * The command that applies a unified diff from the repository root: `git apply`
 * reading the patch from a quoted heredoc, so the shell expands nothing in it
 * (bash, zsh, Git Bash). A hunk without a context line is placed only under
 * `--unidiff-zero`, which the command then passes. Only the trailing line
 * breaks are dropped: a line holding a single space is an empty context line.
 */
export function gitApplyCommand(patch: string): string {
  const body = patch.replace(/(\r?\n)+$/, '');
  const contextFree = parseUnifiedDiff(body).files.some((file) =>
    file.hunks.some((hunk) => !hunk.lines.some((line) => line[0] === ' ')),
  );
  return `git apply${contextFree ? ' --unidiff-zero' : ''} <<'EOF'\n${body}\nEOF`;
}

/**
 * A diagnosis's patch checked again when a fix the diagnosis predicted landed,
 * against the code at the fix's commit: the validation there, whether the
 * patch's change is already in that code, and the run and commit of the fix.
 * Fix verification stores it on the diagnosis details as `patchValidationAtFix`.
 */
export interface PatchValidationAtFix extends PatchValidation {
  /** Every hunk's post-image (context and added lines) is in its file at the fix's commit. */
  inCode: boolean;
  runId: number;
  commit: string;
}

/** The fix-time check stored on a diagnosis's details, or null when none was stored. */
export function storedPatchValidationAtFix(details: unknown): PatchValidationAtFix | null {
  const check = (details as { patchValidationAtFix?: unknown } | null)?.patchValidationAtFix as
    | Partial<PatchValidationAtFix>
    | null
    | undefined;
  if (!check || typeof check !== 'object' || typeof check.status !== 'string' || typeof check.runId !== 'number') {
    return null;
  }
  return check as PatchValidationAtFix;
}

/**
 * Whether the diagnosed patch still applied at the commit of the fix that landed
 * in `fixLandedRunId`, its change not being there: the fix was another change,
 * so the diagnosed one may not be in the code yet. False with no check for that
 * fix.
 */
export function patchStillAppliesAtFix(
  check: PatchValidationAtFix | null | undefined,
  fixLandedRunId: number | null | undefined,
): boolean {
  if (!check || fixLandedRunId == null || check.runId !== fixLandedRunId || check.inCode) return false;
  return patchApplies(check.status);
}

/** Strip a leading `a/` or `b/` diff prefix; leave other paths untouched. `/dev/null` → null. */
export function stripAbPrefix(path: string | null | undefined): string | null {
  if (!path) return null;
  const p = path.trim();
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

/**
 * Parse a unified diff into files and hunks. Tolerant of `diff --git` preamble
 * lines and of hunks that omit the count (defaulting to 1). Returns
 * `{ files: [] }` when nothing parseable is found.
 */
export function parseUnifiedDiff(text: string): ParsedPatch {
  const files: PatchFile[] = [];
  const lines = text.split('\n');
  let current: PatchFile | null = null;
  let hunk: PatchHunk | null = null;

  const closeHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };
  const closeFile = () => {
    closeHunk();
    if (current && current.hunks.length > 0) files.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith('--- ')) {
      closeFile();
      current = { oldPath: parsePathLine(line.slice(4)), newPath: null, hunks: [] };
      continue;
    }
    if (line.startsWith('+++ ') && current) {
      current.newPath = parsePathLine(line.slice(4));
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m && current) {
      closeHunk();
      hunk = {
        oldStart: parseInt(m[1]!, 10),
        oldLines: m[2] != null ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3]!, 10),
        newLines: m[4] != null ? parseInt(m[4], 10) : 1,
        lines: [],
      };
      continue;
    }

    if (hunk) {
      const c = line[0];
      if (c === ' ' || c === '+' || c === '-') {
        hunk.lines.push(line);
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
      // Anything else ends the hunk (and, if not a new file/hunk marker, the file).
      closeHunk();
    }
  }
  closeFile();

  return { files };
}

/** Extract the path token from a `--- ` / `+++ ` line (drops a trailing tab-timestamp). */
function parsePathLine(rest: string): string | null {
  const token = rest.split('\t')[0]!.trim();
  return token === '/dev/null' ? null : token;
}

/** Lines of the pre-image (context + deletions), marker stripped. */
function oldBlock(hunk: PatchHunk): string[] {
  return hunk.lines.filter((l) => l[0] === ' ' || l[0] === '-').map((l) => l.slice(1));
}

/** Lines of the post-image (context + additions), marker stripped. */
function newBlock(hunk: PatchHunk): string[] {
  return hunk.lines.filter((l) => l[0] === ' ' || l[0] === '+').map((l) => l.slice(1));
}

function normalize(line: string): string {
  return line.replace(/\r$/, '');
}

/** Find `block` in `lines`, preferring the match closest to `expected`. -1 if none. */
function findBlock(lines: string[], block: string[], expected: number): number {
  if (block.length === 0) return Math.max(0, Math.min(expected, lines.length));
  let best = -1;
  let bestDist = Infinity;
  const last = lines.length - block.length;
  for (let i = 0; i <= last; i++) {
    let match = true;
    for (let j = 0; j < block.length; j++) {
      if (normalize(lines[i + j]!) !== normalize(block[j]!)) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const dist = Math.abs(i - expected);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
      if (dist === 0) break;
    }
  }
  return best;
}

interface ApplyResult {
  ok: boolean;
  offset: boolean;
  reason?: string;
}

/** Dry-run apply a file's hunks against its content, tracking whether any hunk shifted. */
function applyHunks(content: string, hunks: PatchHunk[]): ApplyResult {
  let lines = content.split('\n');
  let offset = false;

  for (const hunk of hunks) {
    const oldB = oldBlock(hunk);
    const newB = newBlock(hunk);
    const expected = Math.max(0, hunk.oldStart - 1);
    const idx = findBlock(lines, oldB, expected);
    if (idx === -1) {
      return { ok: false, offset, reason: `hunk @@ -${hunk.oldStart} context did not match the file` };
    }
    if (oldB.length > 0 && idx !== expected) offset = true;
    lines = [...lines.slice(0, idx), ...newB, ...lines.slice(idx + oldB.length)];
  }

  return { ok: true, offset };
}

/** Case-exact lookup with an unambiguous path-suffix fallback (model may drop leading dirs). */
function lookupContent(files: Map<string, string>, target: string): string | null {
  const direct = files.get(target);
  if (direct != null) return direct;
  const matches: string[] = [];
  for (const key of files.keys()) {
    if (key === target || key.endsWith('/' + target) || target.endsWith('/' + key)) matches.push(key);
  }
  if (matches.length === 1) return files.get(matches[0]!) ?? null;
  return null;
}

/**
 * Validate an AI-suggested unified-diff patch against the file content the model
 * was shown (repo-relative path → content). Files not present in `available`
 * are counted but not judged, so a partially-grounded patch degrades to
 * `unchecked` rather than a false failure.
 */
export function validatePatch(
  patch: string | null | undefined,
  available: Map<string, string> | Record<string, string>,
): PatchValidation {
  if (!patch || !patch.trim()) {
    return { status: 'unchecked', filesChecked: 0, filesInPatch: 0, errors: [] };
  }

  const files = available instanceof Map ? available : new Map(Object.entries(available));
  const parsed = parseUnifiedDiff(patch);

  if (parsed.files.length === 0) {
    return { status: 'invalid', filesChecked: 0, filesInPatch: 0, errors: ['Could not parse a unified diff.'] };
  }

  const errors: string[] = [];
  let filesChecked = 0;
  let sawOffset = false;
  let sawStale = false;

  for (const f of parsed.files) {
    const target = stripAbPrefix(f.newPath) ?? stripAbPrefix(f.oldPath);
    if (!target) continue; // pure deletion of /dev/null etc. — nothing to verify
    const content = lookupContent(files, target);
    if (content == null) continue; // we don't have this file — leave it unchecked
    filesChecked++;
    const res = applyHunks(content, f.hunks);
    if (!res.ok) {
      sawStale = true;
      errors.push(`${target}: ${res.reason ?? 'did not apply'}`);
    } else if (res.offset) {
      sawOffset = true;
    }
  }

  let status: PatchValidationStatus;
  if (filesChecked === 0) status = 'unchecked';
  else if (sawStale) status = 'stale-file';
  else if (sawOffset) status = 'applies-with-offset';
  else status = 'applies';

  return { status, filesChecked, filesInPatch: parsed.files.length, errors };
}

/**
 * Whether a patch's change is already in the code: every hunk's post-image
 * (context and added lines) is found in its file. A patch that only adds lines
 * next to its context still dry-runs as applying once applied, so a fix-time
 * check reads both. False when the patch does not parse or a file it touches is
 * not available.
 */
export function patchInCode(
  patch: string | null | undefined,
  available: Map<string, string> | Record<string, string>,
): boolean {
  const parsed = parseUnifiedDiff(patch ?? '');
  if (parsed.files.length === 0) return false;
  const files = available instanceof Map ? available : new Map(Object.entries(available));
  for (const f of parsed.files) {
    const target = stripAbPrefix(f.newPath) ?? stripAbPrefix(f.oldPath);
    const content = target ? lookupContent(files, target) : null;
    if (content == null) return false;
    const lines = content.split('\n');
    for (const hunk of f.hunks) {
      const block = newBlock(hunk);
      if (block.length === 0 || findBlock(lines, block, Math.max(0, hunk.newStart - 1)) === -1) return false;
    }
  }
  return true;
}
