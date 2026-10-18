import { describe, test, expect } from 'vitest';
import {
  parseAriaCandidates,
  textSimilarity,
  fingerprintPresent,
  matchRenamedElement,
  freshLocatorsFromCandidate,
  elementMatchOutcome,
  generateFromAriaSnapshot,
} from '#shared/locator-fingerprint';

describe('parseAriaCandidates', () => {
  test('parses role + name lines, keeping the heading level', () => {
    const aria = ['- button "Open page"', '- heading "Welcome" [level=1]', '- textbox "Email"'].join('\n');
    expect(parseAriaCandidates(aria)).toEqual([
      { role: 'button', name: 'Open page', level: null },
      { role: 'heading', name: 'Welcome', level: 1 },
      { role: 'textbox', name: 'Email', level: null },
    ]);
  });

  test('keeps roles without a name but drops structural wrappers', () => {
    const aria = ['- button', '- generic', '- group', '- list', '- link "Home"'].join('\n');
    expect(parseAriaCandidates(aria)).toEqual([
      { role: 'button', name: null, level: null },
      { role: 'link', name: 'Home', level: null },
    ]);
  });

  test('handles indentation, refs, and escaped quotes', () => {
    const aria = ['    - button "Save \\"now\\"" [ref=e5]'].join('\n');
    expect(parseAriaCandidates(aria)).toEqual([{ role: 'button', name: 'Save "now"', level: null }]);
  });

  test('reads level next to a ref marker and ignores brackets inside the name', () => {
    const aria = ['- heading "Results [level=9] shown" [level=2] [ref=e3]', '- heading [level=3]'].join('\n');
    expect(parseAriaCandidates(aria)).toEqual([
      { role: 'heading', name: 'Results [level=9] shown', level: 2 },
      { role: 'heading', name: null, level: 3 },
    ]);
  });

  test('returns [] for empty input', () => {
    expect(parseAriaCandidates(null)).toEqual([]);
    expect(parseAriaCandidates('')).toEqual([]);
  });
});

describe('textSimilarity', () => {
  test('identical strings score 1', () => {
    expect(textSimilarity('Open page', 'Open page')).toBe(1);
  });

  test('is case- and punctuation-insensitive', () => {
    expect(textSimilarity('Open Page!', 'open page')).toBe(1);
  });

  test('partial token overlap is between 0 and 1', () => {
    // {go,to,page} vs {open,page} → 2*1/(3+2) = 0.4
    expect(textSimilarity('Go to page', 'Open page')).toBeCloseTo(0.4, 5);
  });

  test('disjoint strings score 0', () => {
    expect(textSimilarity('Submit', 'Cancel')).toBe(0);
  });

  test('empty handling', () => {
    expect(textSimilarity('', '')).toBe(1);
    expect(textSimilarity('Submit', '')).toBe(0);
    expect(textSimilarity(null, 'x')).toBe(0);
  });
});

describe('fingerprintPresent', () => {
  const candidates = [
    { role: 'button', name: 'Open page', level: null },
    { role: 'link', name: 'Home', level: null },
  ];

  test('true when same role keeps a near-identical name', () => {
    expect(fingerprintPresent({ role: 'link', name: 'Home' }, candidates)).toBe(true);
  });

  test('false when the name changed (renamed element)', () => {
    expect(fingerprintPresent({ role: 'button', name: 'Go to page' }, candidates)).toBe(false);
  });

  test('false when fingerprint has no name', () => {
    expect(fingerprintPresent({ role: 'button', name: null }, candidates)).toBe(false);
  });
});

describe('matchRenamedElement', () => {
  test('matches a unique same-role candidate even when the name changed', () => {
    const m = matchRenamedElement({ role: 'button', name: 'Go to page' }, [
      { role: 'button', name: 'Open page', level: null },
    ]);
    expect(m?.candidate).toEqual({ role: 'button', name: 'Open page', level: null });
    expect(m?.confidence).toBeGreaterThan(0.5);
  });

  test('picks the best name-similarity among several same-role candidates', () => {
    const m = matchRenamedElement({ role: 'button', name: 'Go to page' }, [
      { role: 'button', name: 'Cancel', level: null },
      { role: 'button', name: 'Open page', level: null },
    ]);
    expect(m?.candidate.name).toBe('Open page');
  });

  test('a shared short or function word is no match', () => {
    const m = matchRenamedElement({ role: 'link', name: 'Go to your cart' }, [
      { role: 'link', name: 'Back to top', level: null },
      { role: 'link', name: 'Update your profile', level: null },
    ]);
    expect(m).toBeNull();
  });

  test('returns null when several candidates and none clears the similarity floor', () => {
    const m = matchRenamedElement({ role: 'button', name: 'Delete' }, [
      { role: 'button', name: 'Save', level: null },
      { role: 'button', name: 'Cancel', level: null },
    ]);
    expect(m).toBeNull();
  });

  test('returns null when no candidate shares the role', () => {
    expect(matchRenamedElement({ role: 'button', name: 'x' }, [{ role: 'link', name: 'y', level: null }])).toBeNull();
  });

  describe('heading level narrowing', () => {
    const headings = [
      { role: 'heading', name: 'Overview', level: 1 },
      { role: 'heading', name: 'Stats', level: 2 },
      { role: 'heading', name: 'History', level: 2 },
    ];

    test('a totally renamed lone h1 among h2s matches via its level', () => {
      const m = matchRenamedElement({ role: 'heading', name: 'Dashboard', level: 1 }, headings);
      expect(m?.candidate.name).toBe('Overview');
      expect(m?.confidence).toBe(0.7);
    });

    test('falls back to all same-role candidates when no candidate shares the level', () => {
      const m = matchRenamedElement({ role: 'heading', name: 'Site stats', level: 3 }, headings);
      // No level-3 candidates — name similarity over all headings still wins.
      expect(m?.candidate.name).toBe('Stats');
    });

    test('several candidates at the same level still need name similarity', () => {
      const m = matchRenamedElement({ role: 'heading', name: 'Dashboard', level: 2 }, headings);
      expect(m).toBeNull();
    });
  });

  describe('positional tiebreak (rolePosition)', () => {
    const fields = [
      { role: 'textbox', name: 'Correo electrónico', level: null },
      { role: 'textbox', name: 'Nombre completo', level: null },
    ];
    const fp = {
      role: 'textbox',
      name: 'Email',
      rolePosition: { role: 'textbox', count: 2, index: 0 },
    };

    test('a total rename resolves to the candidate at the captured index', () => {
      const m = matchRenamedElement(fp, fields);
      expect(m?.candidate.name).toBe('Correo electrónico');
      expect(m?.confidence).toBe(0.5);
    });

    test('rejected when the same-role count changed since capture', () => {
      const m = matchRenamedElement({ ...fp, rolePosition: { role: 'textbox', count: 3, index: 0 } }, fields);
      expect(m).toBeNull();
    });

    test('rejected when the stored position is for a different role', () => {
      const m = matchRenamedElement({ ...fp, rolePosition: { role: 'button', count: 2, index: 0 } }, fields);
      expect(m).toBeNull();
    });

    test('name similarity still wins over position when it clears the floor', () => {
      const m = matchRenamedElement({ ...fp, name: 'Nombre' }, fields);
      expect(m?.candidate.name).toBe('Nombre completo');
    });
  });
});

describe('freshLocatorsFromCandidate', () => {
  test('button yields getByRole + getByText', () => {
    const alts = freshLocatorsFromCandidate({ role: 'button', name: 'Open page', level: null });
    expect(alts.map((a) => a.method)).toEqual(['getByRole', 'getByText']);
    expect(alts[1]!.locator).toBe("getByText('Open page')");
  });

  test('textbox yields getByRole + getByLabel', () => {
    const alts = freshLocatorsFromCandidate({ role: 'textbox', name: 'Email', level: null });
    expect(alts.map((a) => a.method)).toEqual(['getByRole', 'getByLabel']);
  });

  test('a heading candidate carries its level in the getByRole', () => {
    const alts = freshLocatorsFromCandidate({ role: 'heading', name: 'Overview', level: 1 });
    expect(alts[0]!.locator).toBe("getByRole('heading', { name: 'Overview', level: 1 })");
    expect(alts[0]!.args).toEqual({ role: 'heading', name: 'Overview', level: 1 });
  });

  test('escapes single quotes in the name', () => {
    const alts = freshLocatorsFromCandidate({ role: 'button', name: "It's here", level: null });
    expect(alts[0]!.locator).toBe("getByRole('button', { name: 'It\\'s here' })");
  });

  test('no name yields nothing', () => {
    expect(freshLocatorsFromCandidate({ role: 'button', name: null, level: null })).toEqual([]);
  });
});

/**
 * The end-to-end "button text changed" case: the test still says
 * getByText('Go to page'), but the button now reads "Open page". The fresh
 * suggestion must come from the current page.
 */
describe('renamed element', () => {
  const renamedAria = ['- navigation', '  - button "Open page"', '- contentinfo'].join('\n');

  test('suggests fresh locators for a renamed element', () => {
    const alts = elementMatchOutcome({ role: 'button', name: 'Go to page' }, renamedAria).fresh;
    expect(alts).not.toBeNull();
    expect(alts!.some((a) => a.locator === "getByText('Open page')")).toBe(true);
    expect(alts!.some((a) => a.locator === "getByRole('button', { name: 'Open page' })")).toBe(true);
  });
});

describe('elementMatchOutcome', () => {
  const renamedAria = '- button "Open page"';

  test('matched: fresh locators for a confidently renamed element', () => {
    const o = elementMatchOutcome({ role: 'button', name: 'Go to page' }, renamedAria);
    expect(o.status).toBe('matched');
    expect(o.fresh?.length).toBeGreaterThan(0);
  });

  test('unchanged: the identity is still on the page', () => {
    const o = elementMatchOutcome({ role: 'button', name: 'Open page' }, renamedAria);
    expect(o).toEqual({ status: 'unchanged', fresh: null });
  });

  test('no-match: the name is gone but nothing confident replaced it', () => {
    const aria = ['- heading "Pricing" [level=2]', '- heading "Contact" [level=2]'].join('\n');
    const o = elementMatchOutcome({ role: 'heading', name: 'Dashboard', level: 2 }, aria);
    expect(o).toEqual({ status: 'no-match', fresh: null });
  });

  test('no-aria / no-candidates / no-fingerprint statuses', () => {
    expect(elementMatchOutcome({ role: 'button', name: 'x' }, null).status).toBe('no-aria');
    expect(elementMatchOutcome({ role: 'button', name: 'x' }, 'plain text').status).toBe('no-candidates');
    expect(elementMatchOutcome({ role: null, name: null }, renamedAria).status).toBe('no-fingerprint');
  });

  test('a nameless fingerprint can never be unchanged (null-name is not stale evidence)', () => {
    const o = elementMatchOutcome({ role: 'checkbox', name: null }, '- checkbox "Terms"');
    // Sole same-role candidate → confidently matched, not a stale signal.
    expect(o.status).toBe('matched');
  });
});

describe('generateFromAriaSnapshot', () => {
  const failing = { method: 'getByText', args: { text: 'Save changes' } };

  test('ranks the closest name first and leaves out unrelated candidates', () => {
    const aria = '- button "Save changes"\n- button "Save"\n- button "Cancel"';
    const alts = generateFromAriaSnapshot(aria, failing)!;
    expect(alts[0]).toMatchObject({ method: 'getByRole', args: { role: 'button', name: 'Save changes' } });
    const exact = alts.find((a) => a.args.name === 'Save changes')!;
    const partial = alts.find((a) => a.args.name === 'Save')!;
    expect(exact.score).toBeGreaterThan(partial.score);
    expect(alts.some((a) => a.args.name === 'Cancel' || a.args.text === 'Cancel')).toBe(false);
  });

  test('keeps only the candidates that share a word with the failing text', () => {
    const aria = [
      '- navigation:',
      '  - link "Home"',
      '  - link "Orders"',
      '- main:',
      '  - heading "Unsaved changes" [level=2]',
      '  - button "Save draft"',
      '  - button "Cancel"',
      '- contentinfo:',
      '  - link "Privacy policy"',
      '  - link "Contact us"',
    ].join('\n');
    const alts = generateFromAriaSnapshot(aria, failing)!;
    const names = new Set(alts.map((a) => a.args.name ?? a.args.text));
    expect(names).toEqual(new Set(['Unsaved changes', 'Save draft']));
  });

  test('returns null when no candidate relates to the failing text', () => {
    const aria = '- link "Home"\n- link "Docs"\n- link "Privacy policy"';
    expect(generateFromAriaSnapshot(aria, { method: 'getByText', args: { text: 'Checkout' } })).toBeNull();
  });

  test('a shared short or function word does not relate two labels', () => {
    const aria = '- link "Back to top"\n- link "Update your profile"';
    expect(generateFromAriaSnapshot(aria, { method: 'getByText', args: { text: 'Go to your cart' } })).toBeNull();
  });

  test('ranks the role the failing getByRole named above another role at equal overlap', () => {
    const aria = '- button "Export"\n- link "Export"';
    const alts = generateFromAriaSnapshot(aria, {
      method: 'getByRole',
      args: { role: 'button', name: 'Export all' },
    })!;
    expect(alts[0]).toMatchObject({ method: 'getByRole', args: { role: 'button', name: 'Export' } });
    expect(alts.some((a) => a.args.role === 'link')).toBe(true);
  });

  test('keeps the lone candidate of the failing role even with no shared word', () => {
    const failingSubmit = { method: 'getByRole', args: { role: 'button', name: 'Submit' } };
    const lone = generateFromAriaSnapshot('- link "Home"\n- button "Send"', failingSubmit)!;
    expect(lone.map((a) => a.locator)).toEqual(["getByRole('button', { name: 'Send' })", "getByText('Send')"]);
    expect(generateFromAriaSnapshot('- button "Send"\n- button "Cancel"', failingSubmit)).toBeNull();
  });

  test('a getByRole with no name keeps the candidates of its role', () => {
    const alts = generateFromAriaSnapshot('- link "Home"\n- button "Pay"\n- button "Cancel"', {
      method: 'getByRole',
      args: { role: 'button' },
    })!;
    expect(new Set(alts.map((a) => a.args.name ?? a.args.text))).toEqual(new Set(['Pay', 'Cancel']));
  });

  test('reads the words of a test id', () => {
    const aria = '- link "Home"\n- button "Submit order"';
    const alts = generateFromAriaSnapshot(aria, { method: 'getByTestId', args: { testId: 'submitOrder-btn' } })!;
    expect(alts[0]!.locator).toBe("getByRole('button', { name: 'Submit order' })");
    expect(alts.some((a) => a.args.name === 'Home')).toBe(false);
  });

  test('a CSS locator gets no alternative', () => {
    expect(
      generateFromAriaSnapshot('- button "Login"', { method: 'locator', args: { selector: '#login' } }),
    ).toBeNull();
  });

  test('tree order breaks a tie, later first (content sits after the sidebar)', () => {
    const aria = '- link "Billing settings"\n- link "Account settings"';
    const alts = generateFromAriaSnapshot(aria, { method: 'getByText', args: { text: 'Settings' } })!;
    expect(alts[0]!.args.name).toBe('Account settings');
  });

  test('emits getByText for text-bearing roles and getByLabel for fields, below the role locator', () => {
    const alts = generateFromAriaSnapshot('- button "Save changes"', failing)!;
    const role = alts.find((a) => a.method === 'getByRole')!;
    const text = alts.find((a) => a.method === 'getByText')!;
    expect(text.score).toBe(role.score - 5);

    const fieldAlts = generateFromAriaSnapshot('- textbox "Email"', {
      method: 'getByLabel',
      args: { label: 'Email' },
    })!;
    expect(fieldAlts.some((a) => a.method === 'getByLabel' && a.args.label === 'Email')).toBe(true);
  });

  test('returns null when the snapshot is empty or has no named candidates', () => {
    expect(generateFromAriaSnapshot(null, failing)).toBeNull();
    expect(generateFromAriaSnapshot('- generic', failing)).toBeNull();
  });
});
