/**
 * Coverage written for other tools (Sonar, Codecov, an IDE), as LCOV or
 * Cobertura: per file, its executable lines with a hit count of 1 when they
 * ran and 0 when not, and its functions. Piwi keeps no hit counts, so 1 means
 * "ran", never "ran once". Functions have no names in Piwi's model: each is
 * named by its line extent (`lines_12_18`). No branch data is written.
 *
 * What {@link writeLcov} and {@link writeCobertura} write, `coverage-formats`
 * reads back to the same files.
 */
import { lineInRanges, normalizeFunctionRanges, normalizeLineRanges, type LineRange } from './coverage';

/** One file to write: repository-relative path, normalized ranges. */
export interface WrittenFile {
  path: string;
  /** Every line that can run. */
  executable: LineRange[];
  /** The lines that ran. */
  lines: LineRange[];
  /** Every function, run or not, by start and end line. */
  allFunctions: LineRange[];
  /** The functions that ran, by start and end line. */
  functions: LineRange[];
}

/** Each line of normalized ranges, ascending. */
function* eachLine(ranges: LineRange[]): Generator<number> {
  for (const [start, end] of ranges) for (let line = start; line <= end; line++) yield line;
}

function functionName([start, end]: LineRange): string {
  return `lines_${start}_${end}`;
}

/** A file's lines with their hits, and its functions with whether they ran. */
function fileData(file: WrittenFile) {
  const executable = normalizeLineRanges(file.executable);
  const ran = normalizeLineRanges(file.lines);
  const lines = [...eachLine(executable)].map((line) => ({ line, hits: lineInRanges(ran, line) ? 1 : 0 }));
  const runStarts = new Set(normalizeFunctionRanges(file.functions).map(([start]) => start));
  const functions = normalizeFunctionRanges(file.allFunctions).map((range) => ({
    range,
    hits: runStarts.has(range[0]) ? 1 : 0,
  }));
  return { lines, functions };
}

/** Files as an LCOV tracefile, one record per file. */
export function writeLcov(files: WrittenFile[], testName = ''): string {
  const out: string[] = [];
  for (const file of files) {
    const { lines, functions } = fileData(file);
    out.push(`TN:${testName}`, `SF:${file.path}`);
    for (const fn of functions) out.push(`FN:${fn.range[0]},${fn.range[1]},${functionName(fn.range)}`);
    for (const fn of functions) out.push(`FNDA:${fn.hits},${functionName(fn.range)}`);
    out.push(`FNF:${functions.length}`, `FNH:${functions.filter((f) => f.hits > 0).length}`);
    for (const { line, hits } of lines) out.push(`DA:${line},${hits}`);
    out.push(`LF:${lines.length}`, `LH:${lines.filter((l) => l.hits > 0).length}`, 'end_of_record');
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' }[c]};`);
}

function rate(covered: number, valid: number): string {
  return valid === 0 ? '1' : (covered / valid).toFixed(4).replace(/\.?0+$/, '') || '0';
}

/**
 * Files as a Cobertura report, one package per directory and one class per
 * file, with `.` as the only source so the paths stay repository-relative.
 * `timestamp` is in seconds, as Cobertura writes it.
 */
export function writeCobertura(files: WrittenFile[], timestamp: number): string {
  const byPackage = new Map<string, WrittenFile[]>();
  for (const file of files) {
    const slash = file.path.lastIndexOf('/');
    const name = slash < 0 ? '' : file.path.slice(0, slash).replace(/\//g, '.');
    byPackage.set(name, [...(byPackage.get(name) ?? []), file]);
  }
  let valid = 0;
  let covered = 0;
  const packages: string[] = [];
  for (const [name, members] of byPackage) {
    let packageValid = 0;
    let packageCovered = 0;
    const classes: string[] = [];
    for (const file of members) {
      const { lines, functions } = fileData(file);
      const fileCovered = lines.filter((l) => l.hits > 0).length;
      packageValid += lines.length;
      packageCovered += fileCovered;
      const methods = functions.map((fn) => {
        const [start, end] = fn.range;
        const ends = start === end ? [start] : [start, end];
        const methodLines = ends.map((line) => `<line number="${line}" hits="${fn.hits}" branch="false"/>`).join('');
        return `<method name="${functionName(fn.range)}" signature="" line-rate="${fn.hits}" branch-rate="0" complexity="0"><lines>${methodLines}</lines></method>`;
      });
      const classLines = lines.map((l) => `<line number="${l.line}" hits="${l.hits}" branch="false"/>`).join('');
      const base = file.path.slice(file.path.lastIndexOf('/') + 1);
      classes.push(
        `<class name="${escapeXml(base)}" filename="${escapeXml(file.path)}" line-rate="${rate(fileCovered, lines.length)}" branch-rate="0" complexity="0">` +
          `<methods>${methods.join('')}</methods><lines>${classLines}</lines></class>`,
      );
    }
    valid += packageValid;
    covered += packageCovered;
    packages.push(
      `<package name="${escapeXml(name)}" line-rate="${rate(packageCovered, packageValid)}" branch-rate="0" complexity="0"><classes>${classes.join('\n')}</classes></package>`,
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<coverage line-rate="${rate(covered, valid)}" branch-rate="0" lines-covered="${covered}" lines-valid="${valid}" branches-covered="0" branches-valid="0" complexity="0" version="piwi" timestamp="${Math.floor(timestamp)}">`,
    '<sources><source>.</source></sources>',
    `<packages>${packages.join('\n')}</packages>`,
    '</coverage>',
    '',
  ].join('\n');
}
