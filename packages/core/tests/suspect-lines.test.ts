import { describe, expect, test } from 'vitest';
import type { CoverageCapture, CoverageFile, LineRange } from '../src/coverage';
import { diffFileFromPatch, parseUnifiedDiff, type DiffHunk } from '../src/diff-anchors';
import { diffLines } from '../src/line-diff';
import { MAX_SUSPECTS, hunkHeadLines, ochiai, suspectLines, type SuspectChange } from '../src/suspect-lines';

const BLOB_HEAD = 'a'.repeat(40);
const BLOB_OTHER = 'b'.repeat(40);

/** The hunks of a `git diff` of one file. */
function hunksOf(diff: string): DiffHunk[] {
  return parseUnifiedDiff(`diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n${diff}`)[0]!.hunks;
}

function capture(...files: CoverageFile[]): CoverageCapture {
  return { v: 1, files };
}

function server(path: string, extra: Partial<CoverageFile> = {}): CoverageFile {
  return { path, runtime: 'server', ...extra };
}

/** A modified file whose one hunk adds the given head lines. */
function change(path: string, lines: number[], extra: Partial<SuspectChange> = {}): SuspectChange {
  const hunk: DiffHunk = {
    oldStart: lines[0]!,
    newStart: lines[0]!,
    removed: lines.map((line) => ({ line, text: 'old' })),
    added: lines.map((line) => ({ line, text: 'new' })),
  };
  return { path, status: 'modified', hunks: [hunk], ...extra };
}

describe('hunkHeadLines', () => {
  test('a hunk that adds or replaces lines changes its added lines', () => {
    const [hunk] = hunksOf('@@ -3 +3,2 @@\n-l3\n+new\n+new2\n');
    expect(hunkHeadLines(hunk!)).toEqual([[3, 4]]);
  });

  test('a -U0 deletion (+n,0) changes the head lines on both sides of the deletion point', () => {
    // git diff -U0 of deleting l10 after a hunk that added a line: l9 is head line 10, l11 head line 11.
    const hunks = hunksOf('@@ -3 +3,2 @@\n-l3\n+new\n+new2\n@@ -10 +10,0 @@\n-l10\n');
    expect(hunks.map(hunkHeadLines)).toEqual([[[3, 4]], [[10, 11]]]);
  });

  test('a -U0 deletion at the start of the file (+0,0) changes line 1', () => {
    expect(hunkHeadLines(hunksOf('@@ -1,2 +0,0 @@\n-l1\n-l2\n')[0]!)).toEqual([[1, 1]]);
  });

  test('a deletion with context is placed from the context line before it', () => {
    const [hunk] = hunksOf('@@ -1,5 +1,4 @@\n l1\n l2\n-l3\n l4\n l5\n');
    expect(hunkHeadLines(hunk!)).toEqual([[2, 3]]);
  });

  test('a deletion with context at the start of the file changes line 1', () => {
    const [hunk] = hunksOf('@@ -1,4 +1,3 @@\n-l1\n l2\n l3\n l4\n');
    expect(hunkHeadLines(hunk!)).toEqual([[1, 1]]);
  });

  test('a context hunk keeps its added lines and the deletion no added line replaces', () => {
    // git diff -U3 of the same change as the -U0 test above: one hunk holds both.
    const diff = '@@ -1,12 +1,12 @@\n l1\n l2\n-l3\n+new\n+new2\n l4\n l5\n l6\n l7\n l8\n l9\n-l10\n l11\n l12\n';
    expect(hunkHeadLines(hunksOf(diff)[0]!)).toEqual([
      [3, 4],
      [10, 11],
    ]);
  });

  test('two deletions in one context hunk give two deletion points', () => {
    const [hunk] = hunksOf('@@ -4,9 +4,6 @@\n l4\n l5\n-l6\n l7\n l8\n-l9\n-l10\n l11\n l12\n');
    // l5 is head line 5, l7 head 6, l8 head 7, l11 head 8.
    expect(hunkHeadLines(hunk!)).toEqual([[5, 8]]);
  });

  test('a deletion after an earlier hunk is placed in head lines, with or without context', () => {
    const u0 = hunksOf('@@ -2,0 +3,2 @@\n+a\n+b\n@@ -10 +11,0 @@\n-l10\n');
    const u3 = hunksOf('@@ -7,7 +9,6 @@\n l7\n l8\n l9\n-l10\n l11\n l12\n l13\n');
    expect(hunkHeadLines(u0[1]!)).toEqual([[11, 12]]);
    expect(hunkHeadLines(u3[0]!)).toEqual([[11, 12]]);
  });

  test('a provider patch and diffLines agree with git', () => {
    const patch = diffFileFromPatch('f.txt', '@@ -1,5 +1,4 @@\n l1\n l2\n-l3\n l4\n l5', 'modified');
    expect(hunkHeadLines(patch.hunks[0]!)).toEqual([[2, 3]]);
    const lines = diffLines('f.txt', 'l1\nl2\nl3\nl4\nl5\n', 'l1\nl2\nl4\nl5\n');
    expect(lines.hunks.map(hunkHeadLines)).toEqual([[[2, 3]]]);
    const first = diffLines('f.txt', 'l1\nl2\nl3\n', 'l2\nl3\n');
    expect(first.hunks.map(hunkHeadLines)).toEqual([[[1, 1]]]);
  });
});

describe('ochiai', () => {
  test('is 1 when only the failing tests ran it, and falls as passing tests ran it too', () => {
    expect(ochiai(1, 0, 1)).toBe(1);
    expect(ochiai(1, 2, 1)).toBeCloseTo(0.577, 3);
    expect(ochiai(2, 0, 4)).toBeCloseTo(0.707, 3);
    expect(ochiai(0, 3, 1)).toBe(0);
    expect(ochiai(1, 0, 0)).toBe(0);
  });
});

describe('suspectLines: granularities', () => {
  const changes = [change('src/Basket.cs', [57, 58, 59])];

  test('lines: the changed lines the capture executed', () => {
    const result = suspectLines({
      changes,
      failing: [
        capture(
          server('src/Basket.cs', {
            blob: BLOB_HEAD,
            lines: [
              [50, 57],
              [59, 70],
            ],
          }),
        ),
      ],
      passing: [],
    });
    expect(result.suspects).toEqual([
      {
        path: 'src/Basket.cs',
        runtime: 'server',
        hunk: [57, 59],
        lines: [
          [57, 57],
          [59, 59],
        ],
        granularity: 'lines',
        failing: 1,
        passing: 0,
        score: 1,
      },
    ]);
    expect(result.summary.executedLines).toBe(2);
  });

  test('lines: a capture whose executed lines miss the hunk did not execute it', () => {
    const result = suspectLines({
      changes,
      failing: [capture(server('src/Basket.cs', { lines: [[10, 20]], functions: [[50, 70]] }))],
      passing: [],
    });
    expect(result.suspects).toEqual([]);
    expect(result.summary.executedHunks).toBe(0);
  });

  test('functions: the changed lines inside a function that ran', () => {
    const result = suspectLines({
      changes,
      failing: [
        capture(
          server('src/Basket.cs', {
            functions: [
              [40, 58],
              [80, 90],
            ],
          }),
        ),
      ],
      passing: [],
    });
    expect(result.suspects[0]).toMatchObject({ granularity: 'functions', lines: [[57, 58]] });
    expect(result.summary.executedLines).toBe(0);
  });

  test('files: the whole hunk when the file was reached', () => {
    const result = suspectLines({ changes, failing: [capture(server('src/Basket.cs'))], passing: [] });
    expect(result.suspects[0]).toMatchObject({ granularity: 'files', lines: [[57, 59]] });
  });

  test('a file whose blob differs from the head blob counts at files granularity only', () => {
    const covered = server('src/Basket.cs', { blob: BLOB_OTHER, lines: [[1, 2]], functions: [[1, 3]] });
    const other = suspectLines({
      changes: [change('src/Basket.cs', [57, 58, 59], { headBlob: BLOB_HEAD })],
      failing: [capture(covered)],
      passing: [],
    });
    expect(other.suspects[0]).toMatchObject({ granularity: 'files', lines: [[57, 59]] });
    // The same blob (in any case), an unknown head blob, or a head blob of another hash (a SHA-256
    // repository read by a SHA-1 hash) keeps line granularity: lines 1-2 miss the hunk.
    for (const headBlob of [BLOB_OTHER, BLOB_OTHER.toUpperCase(), undefined, 'a'.repeat(64)]) {
      const same = suspectLines({
        changes: [change('src/Basket.cs', [57, 58, 59], { headBlob })],
        failing: [capture(covered)],
        passing: [],
      });
      expect(same.suspects).toEqual([]);
    }
  });

  test('a passing capture counts at its own granularity', () => {
    const result = suspectLines({
      changes,
      failing: [capture(server('src/Basket.cs', { lines: [[57, 59]] }))],
      passing: [
        capture(server('src/Basket.cs', { lines: [[58, 58]] })),
        capture(server('src/Basket.cs', { functions: [[50, 60]] })),
        capture(server('src/Basket.cs')),
        capture(server('src/Basket.cs', { lines: [[1, 10]] })),
        capture(server('src/Other.cs')),
      ],
    });
    expect(result.suspects[0]).toMatchObject({ failing: 1, passing: 3, score: 0.5 });
    expect(result.summary).toMatchObject({ failingWithCoverage: 1, passingWithCoverage: 5 });
  });
});

describe('suspectLines: paths', () => {
  test('an exact path wins over a suffix match', () => {
    const result = suspectLines({
      changes: [change('src/index.ts', [5])],
      failing: [
        capture(
          { path: 'src/index.ts', runtime: 'browser', lines: [[5, 5]] },
          { path: 'app/src/index.ts', runtime: 'browser', lines: [[1, 2]] },
        ),
      ],
      passing: [capture({ path: 'app/src/index.ts', runtime: 'browser', lines: [[5, 5]] })],
    });
    expect(result.suspects[0]).toMatchObject({ path: 'src/index.ts', failing: 1, passing: 0 });
  });

  test('without an exact path, a suffix match counts', () => {
    const result = suspectLines({
      changes: [change('web/src/Pay.vue', [12])],
      failing: [capture({ path: 'src/Pay.vue', runtime: 'browser', functions: [[10, 20]] })],
      passing: [],
    });
    expect(result.suspects[0]).toMatchObject({ path: 'web/src/Pay.vue', runtime: 'browser', granularity: 'functions' });
  });

  test('a bare file name matches no file in another folder, either way', () => {
    const result = suspectLines({
      changes: [change('apps/admin/index.ts', [3]), change('App.tsx', [4])],
      failing: [
        capture(
          { path: 'index.ts', runtime: 'browser', lines: [[3, 3]] },
          { path: 'apps/web/App.tsx', runtime: 'browser', lines: [[4, 4]] },
        ),
      ],
      passing: [],
    });
    expect(result.suspects).toEqual([]);
  });

  test('the runtime is the one most failing captures executed the hunk in', () => {
    const file = (runtime: 'browser' | 'server'): CoverageFile => ({ path: 'shared/price.ts', runtime });
    const result = suspectLines({
      changes: [change('shared/price.ts', [3])],
      failing: [capture(file('server')), capture(file('browser')), capture(file('server'))],
      passing: [],
    });
    expect(result.suspects[0]).toMatchObject({ runtime: 'server', failing: 3 });
  });
});

describe('suspectLines: what counts', () => {
  test('a deleted file has no head side and a capture with no file has no coverage', () => {
    const result = suspectLines({
      changes: [{ ...change('src/gone.ts', [1, 2]), status: 'deleted' }, change('src/kept.ts', [4])],
      failing: [capture(), capture(server('src/kept.ts'))],
      passing: [capture()],
    });
    expect(result.summary).toEqual({
      changedFiles: 1,
      changedLines: 1,
      hunks: 1,
      executedHunks: 1,
      executedLines: 0,
      failingWithCoverage: 1,
      passingWithCoverage: 0,
    });
    expect(result.suspects.map((s) => s.path)).toEqual(['src/kept.ts']);
  });

  test('no failing coverage gives no suspect', () => {
    const result = suspectLines({ changes: [change('src/a.ts', [1])], failing: [], passing: [] });
    expect(result.suspects).toEqual([]);
    expect(result.summary).toMatchObject({ changedLines: 1, hunks: 1, failingWithCoverage: 0 });
  });
});

describe('suspectLines: ranking', () => {
  test('granularity first, then score, then failing count, then path and line', () => {
    const failingA = capture(
      server('a.cs'),
      server('b.cs', { functions: [[1, 100]] }),
      server('c.cs', { lines: [[1, 100]] }),
      server('d.cs', { lines: [[1, 100]] }),
    );
    const failingB = capture(server('d.cs', { lines: [[1, 100]] }), server('e.cs', { lines: [[1, 100]] }));
    const result = suspectLines({
      changes: [
        change('a.cs', [5]),
        change('b.cs', [5]),
        change('c.cs', [5]),
        change('d.cs', [9]),
        { path: 'e.cs', status: 'modified', hunks: [change('e.cs', [30]).hunks[0]!, change('e.cs', [7]).hunks[0]!] },
      ],
      failing: [failingA, failingB],
      // c.cs is executed by a passing test too, so it scores below d.cs and e.cs.
      passing: [capture(server('c.cs', { lines: [[5, 5]] }))],
    });
    expect(result.suspects.map((s) => [s.path, s.hunk[0], s.granularity, s.failing, s.score])).toEqual([
      ['d.cs', 9, 'lines', 2, 1],
      ['e.cs', 7, 'lines', 1, 0.707],
      ['e.cs', 30, 'lines', 1, 0.707],
      ['c.cs', 5, 'lines', 1, 0.5],
      ['b.cs', 5, 'functions', 1, 0.707],
      ['a.cs', 5, 'files', 1, 0.707],
    ]);
  });

  test('suspects are capped, and the order holds whatever the input order', () => {
    const changes = Array.from({ length: MAX_SUSPECTS + 10 }, (_, i) =>
      change(`src/f${String(i).padStart(3, '0')}.ts`, [1]),
    );
    const failing = [capture(...changes.map((c) => server(c.path, { lines: [[1, 1]] })))];
    const forward = suspectLines({ changes, failing, passing: [] });
    const backward = suspectLines({ changes: [...changes].reverse(), failing, passing: [] });
    expect(forward.suspects).toHaveLength(MAX_SUSPECTS);
    expect(forward.summary.executedHunks).toBe(MAX_SUSPECTS + 10);
    expect(backward.suspects).toEqual(forward.suspects);
    expect(suspectLines({ changes, failing, passing: [], limit: 5 }).suspects.map((s) => s.path)).toEqual(
      forward.suspects.slice(0, 5).map((s) => s.path),
    );
  });
});

/**
 * One commit on top of eShopOnWeb: 13 changed lines in 5 hunks over 4 files,
 * one of them the bug (a quantity added instead of set). One test failed and
 * 13 passed; the failing test executed exactly the bug's 3 lines.
 */
describe('suspectLines: the eShopOnWeb example', () => {
  const BASKET = 'src/ApplicationCore/Services/BasketService.cs';
  const CATALOG = 'src/Web/Services/CatalogViewModelService.cs';
  const REGISTER = 'src/Web/Areas/Identity/Pages/Account/Register.cshtml.cs';
  const MANAGE = 'src/Web/Controllers/ManageController.cs';

  const patches: Record<string, string> = {
    [BASKET]: [
      '@@ -54,9 +54,9 @@ public class BasketService : IBasketService',
      '     {',
      '         var basket = await _basketRepository.FirstOrDefaultAsync(basketSpec);',
      '         if (basket == null) return Result<Basket>.NotFound();',
      '-        _logger.LogInformation("Setting quantities");',
      '-        foreach (var item in basket.Items)',
      '-            if (quantities.TryGetValue(item.Id.ToString(), out var quantity)) item.SetQuantity(quantity);',
      '+        _logger.LogInformation("Updating basket quantities");',
      '+        foreach (var item in basket.Items)',
      '+            if (quantities.TryGetValue(item.Id.ToString(), out var quantity)) item.AddQuantity(quantity);',
      '         basket.RemoveEmptyItems();',
      '         await _basketRepository.UpdateAsync(basket);',
      '         return basket;',
    ].join('\n'),
    [CATALOG]: [
      '@@ -37,8 +37,12 @@ public class CatalogViewModelService : ICatalogViewModelService',
      '         var vm = new CatalogIndexViewModel()',
      '         {',
      '             CatalogItems = itemsOnPage,',
      '-            PaginationInfo = new PaginationInfoViewModel()',
      '-            { ActualPage = pageIndex, TotalPages = (totalItems + itemsPage - 1) / itemsPage }',
      '+            PaginationInfo = new PaginationInfoViewModel()',
      '+            {',
      '+                ActualPage = pageIndex,',
      '+                ItemsPerPage = itemsOnPage.Count,',
      '+                TotalPages = PageCount(totalItems, itemsPage),',
      '+            }',
      '         };',
      '         return vm;',
      '     }',
      '@@ -69,7 +73,7 @@ public class CatalogViewModelService : ICatalogViewModelService',
      '     }',
      '',
      '     private static int PageCount(int totalItems, int itemsPage)',
      '-        => int.Parse(Math.Ceiling((decimal)totalItems / itemsPage).ToString());',
      '+        => (totalItems + itemsPage - 1) / itemsPage;',
      ' ',
      '     public async Task<IEnumerable<SelectListItem>> GetBrands()',
      '     {',
    ].join('\n'),
    [REGISTER]: [
      '@@ -68,7 +68,7 @@ public class RegisterModel : PageModel',
      '         returnUrl = returnUrl ?? Url.Content("~/");',
      '         if (ModelState.IsValid)',
      '         {',
      '-            var user = new ApplicationUser { UserName = Input.Email, Email = Input.Email };',
      '-            var result = await _userManager.CreateAsync(user, Input.Password);',
      '+            var user = new ApplicationUser { UserName = Input.Email.Trim(), Email = Input.Email.Trim() };',
      '+            var result = await _userManager.CreateAsync(user, Input.Password);',
      '             if (result.Succeeded)',
      '             {',
    ].join('\n'),
    [MANAGE]: [
      '@@ -156,7 +156,7 @@ public class ManageController : Controller',
      '         }',
      '',
      '         await _signInManager.SignInAsync(user, isPersistent: false);',
      '-        _logger.LogInformation("User changed their password successfully.");',
      '+        _logger.LogInformation("User changed their password.");',
      '         StatusMessage = "Your password has been changed.";',
      ' ',
      '         return RedirectToAction(nameof(ChangePassword));',
    ].join('\n'),
  };
  const changes: SuspectChange[] = Object.entries(patches).map(([path, patch]) => {
    const file = diffFileFromPatch(path, patch, 'modified');
    return { path: file.path, status: file.status, hunks: file.hunks };
  });

  const layout = server('src/Web/Views/Shared/_Layout.cshtml', { lines: [[1, 60]] });
  const lines = (path: string, ...ranges: LineRange[]) => server(path, { lines: ranges, functions: [[1, 400]] });
  const failing = [
    // The basket's update handler, and the catalog's other code: its view model came from a cache another test filled.
    capture(layout, lines(BASKET, [20, 40], [54, 62]), lines(CATALOG, [20, 30], [90, 95])),
  ];
  const passing = [
    capture(layout, lines(BASKET, [54, 62])),
    capture(layout, lines(BASKET, [54, 62])),
    ...Array.from({ length: 4 }, () => capture(layout, lines(CATALOG, [20, 30], [42, 43], [76, 76]))),
    capture(layout, lines(REGISTER, [60, 75])),
    capture(layout, lines(REGISTER, [60, 75])),
    ...Array.from({ length: 5 }, () => capture(layout)),
  ];

  test('the failing test executed exactly the bug’s hunk', () => {
    const result = suspectLines({ changes, failing, passing });
    expect(result.summary).toEqual({
      changedFiles: 4,
      changedLines: 13,
      hunks: 5,
      executedHunks: 1,
      executedLines: 3,
      failingWithCoverage: 1,
      passingWithCoverage: 13,
    });
    expect(result.suspects).toEqual([
      {
        path: BASKET,
        runtime: 'server',
        hunk: [57, 59],
        lines: [[57, 59]],
        granularity: 'lines',
        failing: 1,
        passing: 2,
        score: 0.577,
      },
    ]);
  });

  test('at functions granularity the catalog change counts too, ranked after the basket', () => {
    const functionsOnly = (c: CoverageCapture) =>
      capture(...c.files.map(({ path, runtime, functions }) => ({ path, runtime, functions })));
    const result = suspectLines({ changes, failing: failing.map(functionsOnly), passing: passing.map(functionsOnly) });
    expect(result.suspects.map((s) => [s.path, s.hunk, s.failing, s.passing, s.score])).toEqual([
      [BASKET, [57, 59], 1, 2, 0.577],
      [CATALOG, [40, 45], 1, 4, 0.447],
      [CATALOG, [76, 76], 1, 4, 0.447],
    ]);
    expect(result.summary.executedLines).toBe(0);
  });
});
