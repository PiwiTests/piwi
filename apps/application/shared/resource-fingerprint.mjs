/**
 * A resource finding's identity across runs: its verdict, its kind, the scope
 * it outlived, what piled up, and where it was opened (`findingPlace`): the
 * line that opened it, or the fixture's location when that line is unknown,
 * so two leaks of one file are two findings. What the finding shows besides
 * (a fixture's name, a test's title, the fixtures its tests set up, the other
 * lines of its file) stays out of it, so the identity holds while the leak
 * does. Its group is the same identity without line numbers: an edit above
 * the line moves a finding to a new identity of the same group, and the
 * history pairs the two (`shared/handlers/resource-findings.ts`). Plain JS, so
 * the demo seed generator computes the same identity as the server and the
 * demo.
 */

/**
 * The version of the identity. A change to `resourceFingerprint` bumps it, and
 * startup gives the stored findings the new identity once
 * (`rekeyResourceFindingsOnce`, which reads the identity of the version before).
 */
export const RESOURCE_IDENTITY_VERSION = 2;

const LINE = /(\.[cm]?[jt]sx?):\d+(?::\d+)?/g;
const FIRST_LINE = /\.[cm]?[jt]sx?:(\d+)/;
/** A whole text that names a source file, with its line or not; a name cut short has no extension and is not one. */
const FILE_REF = /^(.+\.[cm]?[jt]sx?)(?::\d+){0,2}$/;
/** The spec file a probable finding was counted in, as the reporter names it: `2 opened, 1 closed in <file>`. */
const COUNTED_IN = / closed in (.+)$/;

/** `tests/cart.spec.ts:12:5` as `tests/cart.spec.ts`, wherever it appears in the text. */
function withoutLines(text) {
  return String(text ?? '').replace(LINE, '$1');
}

/** The file a `file` or `file:line` names, or null for any other text. */
function fileOf(text) {
  return FILE_REF.exec(String(text ?? ''))?.[1] ?? null;
}

/** The file of a handle's test, as the reporter names the test, `"title" (file)`, or null when the text is cut short. */
function testFileOf(detail) {
  const at = detail.lastIndexOf('" (');
  return at >= 0 && detail.endsWith(')') ? detail.slice(at + 3, -1) : null;
}

/**
 * Where a finding was opened, as its identity holds it: the line that opened
 * it (`site`, which is a fixture's location when the line is unknown), else
 * what names it (a Playwright fixture, the worker process). A handle is its
 * type at that line, or without one in its test's file. A probable leak,
 * counted per spec file, is that file (else the first file its opening lines
 * are in).
 */
function findingPlace(finding) {
  const where = String(finding.where ?? '');
  const site = finding.site ? String(finding.site) : '';
  const detail = String(finding.detail ?? '');
  if (finding.verdict === 'handle') {
    if (site) return `${where} at ${site}`;
    const test = testFileOf(detail) ?? detail;
    return test ? `${where} in ${test}` : where;
  }
  if (finding.verdict === 'probable') return COUNTED_IN.exec(detail)?.[1] ?? fileOf(where.split(', ')[0]) ?? where;
  return site || where;
}

/** The identity of a finding, the same for every run that reports it at that line. */
export function resourceFingerprint(finding) {
  return [finding.verdict, finding.kind, finding.scope ?? '', findingPlace(finding), finding.growth?.what ?? '']
    .join('|')
    .slice(0, 500);
}

/**
 * The group of a finding: the findings an edit above their line would turn
 * into one another. Its identity and what it names (`where`, or a stored
 * finding's `place`), both without line numbers.
 */
export function resourceGroup(fingerprint, where) {
  return `${withoutLines(fingerprint)}\n${withoutLines(where)}`;
}

/** The source file an identity names: its line's, a handle's test's, a probable leak's spec file; null for none. */
export function identityFile(fingerprint) {
  const fields = String(fingerprint ?? '').split('|');
  const place = fields.slice(3, -1).join('|');
  return fileOf(fields[0] === 'handle' ? place.replace(/^\S+ (?:at|in) /, '') : place);
}

/** The first line an identity (or a `file:line`) names, or null when it names none. */
export function openingLine(text) {
  const match = FIRST_LINE.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

/** A leak is an object left open: past its scope with the fixtures, or counted from the steps without them. */
export function isLeak(finding) {
  return finding.verdict === 'leaked' || finding.verdict === 'probable';
}
