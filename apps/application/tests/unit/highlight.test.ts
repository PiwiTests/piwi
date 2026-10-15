import { describe, it, expect } from 'vitest';
import {
  highlightCode,
  highlightDiffRows,
  highlightLines,
  highlightLinesToSpans,
  highlightToSpans,
  isKnownLanguage,
  languageForPath,
} from '../../shared/highlight';

/** The visible text of a highlighted fragment. */
function textOf(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Whether every `<span …>` in a fragment is closed within it. */
function isBalanced(fragment: string): boolean {
  return (fragment.match(/<span\b/g) ?? []).length === (fragment.match(/<\/span>/g) ?? []).length;
}

describe('highlightCode', () => {
  it.each(['typescript', 'javascript', 'json', 'diff', 'yaml', 'bash', 'css', 'xml', 'python'])('knows %s', (lang) => {
    expect(isKnownLanguage(lang)).toBe(true);
  });

  it.each(['ts', 'js', 'sh', 'yml', 'html'])('accepts the %s alias the codebase writes in fences', (alias) => {
    expect(isKnownLanguage(alias)).toBe(true);
  });

  // ARIA snapshots are passed as ```yaml from several call sites; before this
  // module they fell through to auto-detection because no consumer registered it.
  it('highlights an ARIA snapshot as yaml rather than guessing', () => {
    const result = highlightCode('- button "Pay now"\n- link "Home"', 'yaml');
    expect(result.language).toBe('yaml');
    expect(result.html).toContain('hljs-');
  });

  it('marks additions and deletions in a diff', () => {
    const { html } = highlightCode('--- a/x.ts\n+++ b/x.ts\n-const a = 1;\n+const a = 2;', 'diff');
    expect(html).toContain('hljs-deletion');
    expect(html).toContain('hljs-addition');
  });

  it('emits token spans for typescript', () => {
    const { html } = highlightCode("const greeting: string = 'hi';", 'typescript');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('hljs-string');
  });

  describe('safety', () => {
    // The result is injected with v-html and raw(), so escaping is the module's job.
    it('escapes markup in highlighted source', () => {
      const { html } = highlightCode('const x = "<script>alert(1)</script>";', 'typescript');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    // Auto-detection may tokenize the source *as* HTML, splitting `&lt;` from
    // the tag name across spans. The property that matters is that the only
    // real tags in the output are highlight.js's own.
    it('emits no tags of its own beyond hljs spans', () => {
      const { html } = highlightCode('<img src=x onerror=alert(1)>');
      const withoutHljsSpans = html.replace(/<span class="hljs-[\w-]+">/g, '').replace(/<\/span>/g, '');
      expect(withoutHljsSpans).not.toMatch(/<[a-z]/i);
      expect(withoutHljsSpans).toContain('&lt;img');
    });

    it('escapes markup in a block too large to auto-detect', () => {
      const big = '<script>alert(1)</script>\n' + 'x'.repeat(200_000);
      const { html, language } = highlightCode(big);
      expect(language).toBe('');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes markup for an unknown language', () => {
      const { html } = highlightCode('<b>x</b>', 'not-a-language');
      expect(html).not.toContain('<b>');
    });
  });

  it('does not throw on source that violates its grammar', () => {
    expect(() => highlightCode('function ( { unbalanced', 'typescript')).not.toThrow();
  });

  it('returns empty output for empty input', () => {
    expect(highlightCode('', 'typescript').html).toBe('');
  });
});

describe('highlightToSpans', () => {
  // The PDF export paints these spans, so the concatenated text must be exactly
  // the source — no dropped, doubled, or reordered characters.
  it('reconstructs the source verbatim, quotes and angle brackets included', () => {
    const source = 'const x = "<a>" + \'y\';';
    const { spans, language } = highlightToSpans(source, 'typescript');
    expect(language).toBe('typescript');
    expect(spans.map((s) => s.text).join('')).toBe(source);
  });

  it('preserves newlines inside the span text so the caller can lay out lines', () => {
    const { spans } = highlightToSpans('const a = 1;\nconst b = 2;', 'typescript');
    expect(spans.map((s) => s.text).join('')).toContain('\n');
  });

  it('tags keywords, strings and numbers with their scope', () => {
    const { spans } = highlightToSpans("const greeting = 'hi';", 'typescript');
    const scopes = new Set(spans.map((s) => s.scope));
    expect(scopes).toContain('keyword');
    expect(scopes).toContain('string');
  });

  it('marks diff additions and deletions', () => {
    const { spans } = highlightToSpans('-const a = 1;\n+const a = 2;', 'diff');
    const scopes = spans.map((s) => s.scope);
    expect(scopes).toContain('addition');
    expect(scopes).toContain('deletion');
  });

  // highlight.js escapes `< > " '` in its output; the token stream must decode
  // them so what the PDF draws is the original text, not `&lt;`.
  it('decodes escaped entities so markup round-trips through the token stream', () => {
    const source = '<img src=x onerror="y">';
    const { spans } = highlightToSpans(source);
    expect(spans.map((s) => s.text).join('')).toBe(source);
  });

  it('leaves a block too large to auto-detect as one plain span', () => {
    const big = 'x'.repeat(200_000);
    const { spans, language } = highlightToSpans(big);
    expect(language).toBe('');
    expect(spans).toEqual([{ text: big, scope: '' }]);
  });
});

describe('languageForPath', () => {
  it.each([
    ['tests/checkout.spec.ts', 'typescript'],
    ['tests/helpers/payment.mjs', 'javascript'],
    ['src/App.vue', 'xml'],
    ['playwright.config.TS', 'typescript'],
    ['tests/checkout.spec.ts:16', 'typescript'],
    ['tests/checkout.spec.ts:16:7', 'typescript'],
    ['api/Users/UsersEndpoints.cs', 'csharp'],
  ])('reads %s as %s', (path, lang) => {
    expect(languageForPath(path)).toBe(lang);
  });

  it.each(['Program.fs', 'Makefile', '', null, undefined])('has no language for %s', (path) => {
    expect(languageForPath(path)).toBeNull();
  });

  it('highlights C# only when a path or a fence names it', () => {
    const code = 'public static int Count(string s) { return s.Length; }';
    expect(highlightLines([code], languageForPath('api/Count.cs'))[0]).toContain('hljs-keyword');
    expect(highlightCode(code).language).not.toBe('csharp');
  });
});

describe('highlightLines', () => {
  it('returns one balanced fragment per line, text intact', () => {
    const lines = ['const a = `one', 'two`;', '/* block', '   comment */ const b = 1;'];
    const html = highlightLines(lines, 'typescript');
    expect(html).toHaveLength(lines.length);
    html.forEach((fragment, i) => {
      expect(isBalanced(fragment)).toBe(true);
      expect(textOf(fragment)).toBe(lines[i]);
    });
  });

  it('keeps a multi-line construct colored on every line it spans', () => {
    const html = highlightLines(['/* first', '   second */', 'const x = 1;'], 'typescript');
    expect(html[0]).toContain('hljs-comment');
    expect(html[1]).toContain('hljs-comment');
    expect(html[2]).not.toContain('hljs-comment');
  });

  // A captured snippet often starts part-way into a JSDoc block.
  it('reads an excerpt that opens inside a block comment as a comment', () => {
    const lines = [
      ' * The Pay button stays disabled,',
      ' * so the click waits.',
      ' */',
      'export async function pay() {',
    ];
    const html = highlightLines(lines, 'typescript');
    expect(html).toHaveLength(lines.length);
    expect(html[0]).toMatch(/^<span class="hljs-comment">/);
    expect(html[2]).toContain('hljs-comment');
    expect(html[3]).toContain('hljs-keyword');
    expect(html.map(textOf)).toEqual(lines);
  });

  it('does not treat a glob inside a string as a comment', () => {
    const html = highlightLines(["  testMatch: '**/*.spec.ts',", '});'], 'typescript');
    expect(html[0]).not.toContain('hljs-comment');
  });

  it('escapes the lines of an unknown language without highlighting them', () => {
    expect(highlightLines(['<b>x</b>'], 'not-a-language')).toEqual(['&lt;b&gt;x&lt;/b&gt;']);
    expect(highlightLines(['<b>x</b>'], null)).toEqual(['&lt;b&gt;x&lt;/b&gt;']);
  });

  it('escapes markup in the source', () => {
    const [line] = highlightLines(['const x = "<script>alert(1)</script>";'], 'typescript');
    expect(line).not.toContain('<script>');
  });

  it('keeps empty lines and returns nothing for no lines', () => {
    expect(highlightLines(['const a = 1;', '', 'const b = 2;'], 'typescript')[1]).toBe('');
    expect(highlightLines([], 'typescript')).toEqual([]);
  });

  it('gives the PDF export the same lines as spans', () => {
    const lines = [' * tail of a comment', ' */', "const s = '<a>';"];
    const spans = highlightLinesToSpans(lines, 'typescript');
    expect(spans.map((line) => line.map((s) => s.text).join(''))).toEqual(lines);
    expect(spans[0]!.every((s) => s.scope === 'comment')).toBe(true);
  });
});

describe('highlightDiffRows', () => {
  const rows = [
    { type: 'context', text: '--- a/tests/pay.spec.ts' },
    { type: 'context', text: '+++ b/tests/pay.spec.ts' },
    { type: 'hunk', text: '@@ -1,3 +1,3 @@' },
    { type: 'context', text: ' const page = await open();' },
    { type: 'remove', text: "-await page.getByRole('button', { name: 'Pay' }).click();" },
    { type: 'add', text: "+await page.getByRole('button', { name: 'Pay now' }).click();" },
    { type: 'context', text: '' },
  ] as const;

  it('highlights the code after each prefix and leaves headers alone', () => {
    const html = highlightDiffRows([...rows], 'typescript');
    expect(html.slice(0, 3)).toEqual([null, null, null]);
    expect(textOf(html[3]!)).toBe('const page = await open();');
    expect(html[4]).toContain('hljs-string');
    expect(textOf(html[5]!)).toBe("await page.getByRole('button', { name: 'Pay now' }).click();");
    expect(html[6]).toBe('');
  });

  it('highlights nothing for an unknown language', () => {
    expect(highlightDiffRows([...rows], null).every((html) => html === null)).toBe(true);
  });

  // The removed and added sides are separate blocks: an unclosed string on the
  // removed line must not bleed into the added one.
  it('keeps the old and new sides apart', () => {
    const html = highlightDiffRows(
      [
        { type: 'remove', text: '-const a = `open' },
        { type: 'add', text: '+const a = 1;' },
      ],
      'typescript',
    );
    expect(html[1]).toContain('hljs-number');
    expect(html[1]).not.toContain('hljs-string');
  });
});
