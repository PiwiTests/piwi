import { describe, test, expect } from 'vitest';
import {
  gitApplyCommand,
  parseUnifiedDiff,
  patchExcerpt,
  patchInCode,
  patchStillAppliesAtFix,
  patchValidationLabel,
  storedPatchValidation,
  storedPatchValidationAtFix,
  stripAbPrefix,
  validatePatch,
  type PatchValidationAtFix,
} from '#shared/patch';
import { buildHealEdit } from '#shared/heal-edit';
import { renderSnippet, SOURCE_FILES, storyByClusterId } from '#shared/demo/failure-stories.mjs';

const SAMPLE = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

describe('stripAbPrefix', () => {
  test('strips a/ and b/ prefixes', () => {
    expect(stripAbPrefix('a/src/foo.ts')).toBe('src/foo.ts');
    expect(stripAbPrefix('b/src/foo.ts')).toBe('src/foo.ts');
  });
  test('maps /dev/null to null', () => {
    expect(stripAbPrefix('/dev/null')).toBeNull();
  });
  test('leaves prefix-less paths untouched', () => {
    expect(stripAbPrefix('tests/x.spec.ts')).toBe('tests/x.spec.ts');
  });
});

describe('parseUnifiedDiff', () => {
  test('parses a single-file, single-hunk diff', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    expect(parsed.files).toHaveLength(1);
    const f = parsed.files[0]!;
    expect(f.oldPath).toBe('a/src/foo.ts');
    expect(f.newPath).toBe('b/src/foo.ts');
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]!.oldStart).toBe(1);
    expect(f.hunks[0]!.lines).toHaveLength(4);
  });

  test('tolerates a diff --git preamble and multiple files', () => {
    const multi = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-a
+b
diff --git a/y.ts b/y.ts
--- a/y.ts
+++ b/y.ts
@@ -1 +1 @@
-c
+d
`;
    const parsed = parseUnifiedDiff(multi);
    expect(parsed.files.map((f) => f.newPath)).toEqual(['b/x.ts', 'b/y.ts']);
  });

  test('returns no files for non-diff text', () => {
    expect(parseUnifiedDiff('just some prose').files).toHaveLength(0);
  });
});

describe('validatePatch', () => {
  const fooContent = 'const a = 1;\nconst b = 2;\nconst c = 4;\n';

  test('applies cleanly when context matches at the stated position', () => {
    const res = validatePatch(SAMPLE, { 'src/foo.ts': fooContent });
    expect(res.status).toBe('applies');
    expect(res.filesChecked).toBe(1);
    expect(res.filesInPatch).toBe(1);
  });

  test('reports offset when the hunk matches at a shifted line', () => {
    const shifted = '// header\n// added line\n' + fooContent;
    const res = validatePatch(SAMPLE, { 'src/foo.ts': shifted });
    expect(res.status).toBe('applies-with-offset');
  });

  test('reports stale-file when context does not match', () => {
    const diverged = 'const a = 1;\nconst b = 999;\nconst c = 4;\n';
    const res = validatePatch(SAMPLE, { 'src/foo.ts': diverged });
    expect(res.status).toBe('stale-file');
    expect(res.errors.length).toBeGreaterThan(0);
  });

  test('is unchecked when we do not have the target file', () => {
    const res = validatePatch(SAMPLE, { 'src/other.ts': 'x' });
    expect(res.status).toBe('unchecked');
    expect(res.filesChecked).toBe(0);
  });

  test('is invalid for unparseable patch text', () => {
    const res = validatePatch('not a patch at all', { 'src/foo.ts': fooContent });
    expect(res.status).toBe('invalid');
  });

  test('is unchecked for a null/empty patch', () => {
    expect(validatePatch(null, {}).status).toBe('unchecked');
    expect(validatePatch('', {}).status).toBe('unchecked');
  });

  test('resolves via unambiguous suffix when the model drops a leading dir', () => {
    const patch = `--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;\n`;
    const res = validatePatch(patch, { 'src/foo.ts': fooContent });
    expect(res.status).toBe('applies');
    expect(res.filesChecked).toBe(1);
  });

  test('handles a multi-file patch, flagging the stale one', () => {
    const patch = `--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    const res = validatePatch(patch, { 'a.ts': 'x\n', 'b.ts': 'DIFFERENT\n' });
    expect(res.filesChecked).toBe(2);
    expect(res.status).toBe('stale-file');
  });
});

describe('storedPatchValidation', () => {
  const applies = { status: 'applies', filesChecked: 1, filesInPatch: 1, errors: [] };
  const stale = { status: 'stale-file', filesChecked: 1, filesInPatch: 1, errors: ['a.ts: did not apply'] };

  test("reads Piwi's diagnosis, which stores it at the top of the details", () => {
    expect(storedPatchValidation({ patchValidation: applies, suggestedFix: { patch: SAMPLE } })).toEqual(applies);
  });

  test("reads an agent's diagnosis, at the top of the details or, recorded earlier, inside the suggested fix", () => {
    expect(storedPatchValidation({ patchValidation: stale, suggestedFix: { patch: SAMPLE } })).toEqual(stale);
    expect(storedPatchValidation({ suggestedFix: { patch: SAMPLE, patchValidation: stale } })).toEqual(stale);
  });

  test('prefers the top-level one when both are stored', () => {
    expect(storedPatchValidation({ patchValidation: applies, suggestedFix: { patchValidation: stale } })).toEqual(
      applies,
    );
  });

  test('skips a malformed value for the other place', () => {
    expect(storedPatchValidation({ patchValidation: 'applies', suggestedFix: { patchValidation: stale } })).toEqual(
      stale,
    );
  });

  test('is null when nothing usable is stored', () => {
    expect(storedPatchValidation(null)).toBeNull();
    expect(storedPatchValidation('applies')).toBeNull();
    expect(storedPatchValidation({ suggestedFix: { patch: SAMPLE } })).toBeNull();
    expect(storedPatchValidation({ patchValidation: 'applies' })).toBeNull();
    expect(storedPatchValidation({ patchValidation: { status: 3 } })).toBeNull();
    expect(storedPatchValidation({ suggestedFix: null, patchValidation: null })).toBeNull();
  });
});

describe('patchInCode', () => {
  test("is true once every hunk's post-image is in its file", () => {
    expect(patchInCode(SAMPLE, { 'src/foo.ts': 'const a = 1;\nconst b = 3;\nconst c = 4;\n' })).toBe(true);
    expect(patchInCode(SAMPLE, { 'src/foo.ts': 'const a = 1;\nconst b = 2;\nconst c = 4;\n' })).toBe(false);
  });

  test('tells an applied addition from one that still dry-runs as applying', () => {
    // Context on one side only: the pre-image is still in the file once applied.
    const addImport = `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,2 +1,3 @@\n+import x from 'x';\n const a = 1;\n const b = 2;\n`;
    const applied = "import x from 'x';\nconst a = 1;\nconst b = 2;\n";
    expect(validatePatch(addImport, { 'src/foo.ts': applied }).status).toBe('applies-with-offset');
    expect(patchInCode(addImport, { 'src/foo.ts': applied })).toBe(true);
    expect(patchInCode(addImport, { 'src/foo.ts': 'const a = 1;\nconst b = 2;\n' })).toBe(false);
  });

  test('is false when a file is missing or the patch does not parse', () => {
    expect(patchInCode(SAMPLE, {})).toBe(false);
    expect(patchInCode('not a diff', { 'src/foo.ts': 'x' })).toBe(false);
    expect(patchInCode(null, {})).toBe(false);
  });
});

describe('the patch checked at a verified fix', () => {
  const check = (over: Partial<PatchValidationAtFix> = {}): PatchValidationAtFix => ({
    status: 'applies',
    filesChecked: 1,
    filesInPatch: 1,
    errors: [],
    inCode: false,
    runId: 62,
    commit: 'abc1234',
    ...over,
  });

  test('reads the check stored on the details', () => {
    expect(storedPatchValidationAtFix({ patchValidationAtFix: check() })).toEqual(check());
    expect(storedPatchValidationAtFix({ patchValidation: check() })).toBeNull();
    expect(storedPatchValidationAtFix({ patchValidationAtFix: { status: 'applies' } })).toBeNull();
    expect(storedPatchValidationAtFix(null)).toBeNull();
  });

  test('still applies only for the fix it was made for, its change not in the code', () => {
    expect(patchStillAppliesAtFix(check(), 62)).toBe(true);
    expect(patchStillAppliesAtFix(check({ status: 'applies-with-offset' }), 62)).toBe(true);
    expect(patchStillAppliesAtFix(check(), 70)).toBe(false);
    expect(patchStillAppliesAtFix(check(), null)).toBe(false);
    expect(patchStillAppliesAtFix(check({ inCode: true }), 62)).toBe(false);
    for (const status of ['stale-file', 'invalid', 'unchecked'] as const) {
      expect(patchStillAppliesAtFix(check({ status }), 62)).toBe(false);
    }
    expect(patchStillAppliesAtFix(null, 62)).toBe(false);
  });
});

describe('gitApplyCommand', () => {
  test('reads the patch from a quoted heredoc, trailing line breaks dropped', () => {
    expect(gitApplyCommand(SAMPLE)).toBe(`git apply <<'EOF'\n${SAMPLE.trimEnd()}\nEOF`);
    expect(gitApplyCommand(SAMPLE + '\n\n')).toBe(gitApplyCommand(SAMPLE));
    expect(gitApplyCommand(SAMPLE.replace(/\n/g, '\r\n'))).not.toMatch(/\r\nEOF$/);
  });

  test('passes --unidiff-zero when a hunk has no context line', () => {
    const contextFree = '--- a/tests/a.spec.ts\n+++ b/tests/a.spec.ts\n@@ -4,1 +4,1 @@\n-old();\n+next();\n';
    expect(gitApplyCommand(contextFree)).toMatch(/^git apply --unidiff-zero <<'EOF'\n--- a\/tests\/a\.spec\.ts\n/);
    const twoHunks = `${SAMPLE}@@ -9,1 +9,1 @@\n-x();\n+y();\n`;
    expect(gitApplyCommand(twoHunks)).toMatch(/^git apply --unidiff-zero /);
    expect(gitApplyCommand(SAMPLE)).toMatch(/^git apply <<'EOF'/);
  });

  test('keeps a final empty context line, which is a single space', () => {
    const endsOnBlank = '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n x();\n-y();\n+z();\n \n';
    expect(gitApplyCommand(endsOnBlank).endsWith('+z();\n \nEOF')).toBe(true);
  });
});

describe('patchValidationLabel', () => {
  test("says each status in the patch badge's words", () => {
    expect(patchValidationLabel('applies')).toBe('Applies cleanly');
    expect(patchValidationLabel('applies-with-offset')).toBe('Applies with offset');
    expect(patchValidationLabel('stale-file')).toBe('Does not apply');
    expect(patchValidationLabel('invalid')).toBe('Invalid diff');
    expect(patchValidationLabel('unchecked')).toBe('Unverified');
  });
});

describe('patchExcerpt', () => {
  /** The excerpt's body lines, without its `@@` row. */
  const body = (diff: string) => diff.split('\n').slice(1);
  const seededPatch = (clusterId: number) => storyByClusterId(clusterId)!.diagnosis.fix.patch as string;

  test("windows on cluster 1's fix, past its import tweak, and counts everything else as hidden", () => {
    const patch = seededPatch(1);
    const excerpt = patchExcerpt(patch)!;
    expect(excerpt).toMatchObject({ file: 'tests/helpers/payment.ts', files: 1 });
    expect(excerpt.diff.split('\n')[0]).toBe('@@ -11,2 +11,4 @@');
    expect(body(excerpt.diff)).toEqual([
      ' export async function fillPaymentDetails(page: Page) {',
      '+  test.slow();',
      "+  const quoteResponse = page.waitForResponse('**/api/checkout/quote');",
      "   await page.getByLabel('Card number').fill(TEST_CARD);",
    ]);
    const hunks = parseUnifiedDiff(patch).files[0]!.hunks;
    expect(hunks).toHaveLength(2);
    const total = hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(excerpt.hiddenLines).toBe(total - 4);
    // The import tweak and the awaited response stay out of the window.
    expect(excerpt.hiddenChanges).toBe(3);
  });

  test('windows on the run with the most changed lines, the first on a tie', () => {
    const diff = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,9 +1,10 @@',
      ' one();',
      '-two();',
      '+deux();',
      ' three();',
      ' four();',
      '-five();',
      '+cinq();',
      '+cinq2();',
      ' six();',
      ' seven();',
      '-eight();',
      '+huit();',
      ' nine();',
    ].join('\n');
    expect(body(patchExcerpt(diff)!.diff)).toEqual([' four();', '-five();', '+cinq();', '+cinq2();', ' six();']);
    const tie = '--- a/a.ts\n+++ b/a.ts\n@@ -1,4 +1,2 @@\n a();\n-b();\n c();\n-d();\n';
    expect(body(patchExcerpt(tie)!.diff)).toEqual([' a();', '-b();', ' c();']);
  });

  test('shows an import-only change when the diff changes nothing else', () => {
    const excerpt = patchExcerpt(
      "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-import { a } from './a';\n+import { a, b } from './a';\n x();\n",
    )!;
    expect(body(excerpt.diff)).toEqual(["-import { a } from './a';", "+import { a, b } from './a';", ' x();']);
    expect(excerpt).toMatchObject({ hiddenLines: 0, hiddenChanges: 0 });
  });

  test('drops a blank context line after the run, and keeps one before it', () => {
    const excerpt = patchExcerpt('--- a/a.ts\n+++ b/a.ts\n@@ -4,3 +4,3 @@\n \n-a();\n+b();\n \n')!;
    expect(excerpt.diff).toBe('@@ -4,2 +4,2 @@\n \n-a();\n+b();');
    // The dropped line is blank: nothing for "N more lines" to count.
    expect(excerpt.hiddenLines).toBe(0);
    // Cluster 10's patch ends on a blank context line.
    const seeded = patchExcerpt(seededPatch(10))!;
    expect(body(seeded.diff).at(-1)).toBe('+    private const int DefaultPageSize = 25;');
    expect(seeded.hiddenLines).toBe(0);
  });

  test("shows cluster 3's added lines between their context lines", () => {
    const excerpt = patchExcerpt(seededPatch(3))!;
    expect(excerpt.file).toBe('src/routes/auth.ts');
    expect(excerpt.diff.split('\n')[0]).toBe('@@ -8,2 +8,5 @@');
    expect(body(excerpt.diff)).toHaveLength(5);
    expect(body(excerpt.diff).filter((l) => l.startsWith('+'))).toHaveLength(3);
    expect(excerpt.hiddenLines).toBe(0);
  });

  test('cuts the 42-line locator edit of cluster 2 to the changed line and its neighbors', () => {
    const spec = 'tests/checkout/checkout.spec.ts';
    const lines = SOURCE_FILES[spec] as string[];
    const edit = buildHealEdit({
      location: `${spec}:23:10`,
      sourceLine: { line: 23, text: lines[22]! },
      failingMethod: 'getByLabel',
      recommendedLocator: "getByTestId('email-field').getByRole('textbox')",
      testSource: renderSnippet(lines, { declLine: 22, failingLine: 23, context: 30 }),
    })!;
    expect(edit.unifiedDiff).toMatch(/^@@ -1,42 \+1,42 @@$/m);
    const excerpt = patchExcerpt(edit.unifiedDiff!)!;
    expect(excerpt.diff.split('\n')[0]).toBe('@@ -22,3 +22,3 @@');
    expect(body(excerpt.diff)).toEqual([` ${lines[21]}`, `-${edit.oldLine}`, `+${edit.newLine}`, ` ${lines[23]}`]);
    expect(excerpt).toMatchObject({ hiddenLines: 39, hiddenChanges: 0 });
  });

  test('keeps a deletion-only run with its context', () => {
    const excerpt = patchExcerpt('--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,2 @@\n a();\n-b();\n c();\n')!;
    expect(excerpt.diff).toBe('@@ -10,3 +10,2 @@\n a();\n-b();\n c();');
  });

  test('cuts a changed run longer than the window, keeping the context before it', () => {
    const removed = Array.from({ length: 5 }, (_, i) => `-old${i}();`);
    const added = Array.from({ length: 5 }, (_, i) => `+new${i}();`);
    const hunk = ['@@ -4,7 +4,7 @@', ' before();', ...removed, ...added, ' after();'];
    const excerpt = patchExcerpt(['--- a/a.ts', '+++ b/a.ts', ...hunk].join('\n'))!;
    expect(excerpt.diff.split('\n')[0]).toBe('@@ -4,6 +4,1 @@');
    expect(body(excerpt.diff)).toEqual([' before();', ...removed]);
    expect(excerpt).toMatchObject({ hiddenLines: 12 - 6, hiddenChanges: 5 });
  });

  test('counts the hunks and files it leaves out', () => {
    const second = '--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,1 @@\n-x();\n+y();\n';
    const excerpt = patchExcerpt(`${SAMPLE}${second}`)!;
    expect(excerpt).toMatchObject({ file: 'src/foo.ts', files: 2, hiddenLines: 2, hiddenChanges: 2 });
  });

  test('reads a hunk without counts, and a new file', () => {
    expect(patchExcerpt('--- a/a.ts\n+++ b/a.ts\n@@ -3 +3 @@\n-a();\n+b();\n')!.diff).toBe(
      '@@ -3,1 +3,1 @@\n-a();\n+b();',
    );
    expect(patchExcerpt('--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a();\n+b();\n')).toMatchObject({
      diff: '@@ -0,0 +1,2 @@\n+a();\n+b();',
      file: 'new.ts',
    });
  });

  test('is null for a diff that does not parse or changes nothing', () => {
    expect(patchExcerpt('not a diff')).toBeNull();
    expect(patchExcerpt('--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n a();\n')).toBeNull();
  });

  test('what it shows is in the command that applies the patch, in order', () => {
    for (const clusterId of [1, 3, 6, 7, 10]) {
      const patch = seededPatch(clusterId);
      const command = gitApplyCommand(patch);
      let from = 0;
      for (const line of body(patchExcerpt(patch)!.diff)) {
        const at = command.indexOf(`\n${line}\n`, from);
        expect(at, `"${line}" in the command of cluster ${clusterId}`).toBeGreaterThanOrEqual(from);
        from = at + 1;
      }
    }
  });
});
