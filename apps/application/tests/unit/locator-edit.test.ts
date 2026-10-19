import { describe, test, expect } from 'vitest';
import { buildLocatorEdit, locatorEditPatch, diffLocatorArgs, buildLocatorFixPrompt } from '#shared/locator-edit';

describe('buildLocatorEdit', () => {
  test('replaces the failing call in place, preserving the prefix and trailing chain', () => {
    const edit = buildLocatorEdit(
      "  await page.getByRole('heading', { name: 'Old' }).click();",
      'getByRole',
      "getByRole('heading', { name: 'New' })",
    );
    expect(edit).toEqual({
      old: "  await page.getByRole('heading', { name: 'Old' }).click();",
      new: "  await page.getByRole('heading', { name: 'New' }).click();",
    });
  });

  test('slots a chained recommendation ahead of the trailing action', () => {
    const edit = buildLocatorEdit(
      "  await page.getByRole('button').click();",
      'getByRole',
      "getByTestId('cart-row').getByRole('button')",
    );
    expect(edit!.new).toBe("  await page.getByTestId('cart-row').getByRole('button').click();");
  });

  test('handles nested parens and quotes in the failing args', () => {
    const edit = buildLocatorEdit(
      "  page.getByText('a (b) c').click()",
      'getByText',
      "getByRole('link', { name: 'a (b) c' })",
    );
    expect(edit!.new).toBe("  page.getByRole('link', { name: 'a (b) c' }).click()");
  });

  test('does not match the method inside a longer identifier', () => {
    expect(buildLocatorEdit('  myGetByRole(1)', 'getByRole', "getByRole('x')")).toBeNull();
  });

  test('writes the recommendation only as the locator grammar re-renders it', () => {
    // A role that closes the call and runs code, as an element's raw role attribute could carry.
    const injected = "getByRole('button'), require('child_process').execSync('id'), ('x')";
    expect(buildLocatorEdit("  await page.getByRole('button').click();", 'getByRole', injected)).toBeNull();
    expect(buildLocatorEdit("  await page.getByText('x').click();", 'getByText', 'getByText(x)')).toBeNull();
    expect(
      buildLocatorEdit("  await page.getByText('x').click();", 'getByText', 'getByRole("link", {name: "Pay"})')!.new,
    ).toBe("  await page.getByRole('link', { name: 'Pay' }).click();");
    // A line break in a name is escaped, so the edit stays on its line.
    expect(
      buildLocatorEdit("  await page.getByText('x').click();", 'getByText', "getByText('a\\nb\u2028c')")!.new,
    ).toBe("  await page.getByText('a\\nb\\u2028c').click();");
  });

  test('returns null when the method is absent, unbalanced, or a no-op', () => {
    expect(buildLocatorEdit('  page.click()', 'getByRole', "getByRole('x')")).toBeNull();
    expect(buildLocatorEdit("  page.getByRole('x'", 'getByRole', "getByRole('y')")).toBeNull();
    expect(buildLocatorEdit("  page.getByRole('x')", 'getByRole', "getByRole('x')")).toBeNull();
  });
});

describe('locatorEditPatch', () => {
  test('emits a -/+ patch with an optional @@ header', () => {
    const patch = locatorEditPatch({ old: "  a.foo('x')", new: "  a.bar('x')" }, 'tests/f.spec.ts:42:5');
    expect(patch).toBe("@@ tests/f.spec.ts:42:5 @@\n-  a.foo('x')\n+  a.bar('x')");
    expect(locatorEditPatch({ old: 'a', new: 'b' })).toBe('-a\n+b');
  });
});

describe('diffLocatorArgs', () => {
  test('lists only the changed scalar args', () => {
    expect(diffLocatorArgs({ role: 'button', name: 'Pay' }, { role: 'button', name: 'Pay now' })).toEqual([
      { key: 'name', from: 'Pay', to: 'Pay now' },
    ]);
  });

  test('reports added and removed keys and compares objects by JSON', () => {
    expect(diffLocatorArgs({ name: 'x' }, { name: 'x', exact: true })).toEqual([
      { key: 'exact', from: null, to: 'true' },
    ]);
    expect(diffLocatorArgs({ role: 'heading' }, { role: 'heading', level: 2 })).toEqual([
      { key: 'level', from: null, to: '2' },
    ]);
  });

  test('returns nothing when args are identical', () => {
    expect(diffLocatorArgs({ role: 'button', name: 'Go' }, { role: 'button', name: 'Go' })).toEqual([]);
  });
});

describe('buildLocatorFixPrompt', () => {
  test('names the call site, the broken locator, the fix, and the current line', () => {
    const prompt = buildLocatorFixPrompt({
      location: 'tests/checkout.spec.ts:42:5',
      sourceLine: { line: 42, text: "  await page.getByRole('button', { name: 'Pay' }).click();" },
      failing: "getByRole('button', { name: 'Pay' })",
      recommended: "getByTestId('pay-btn')",
    });
    expect(prompt).toContain('tests/checkout.spec.ts:42:5');
    expect(prompt).toContain("Replace it with `getByTestId('pay-btn')`");
    expect(prompt).toContain("await page.getByRole('button', { name: 'Pay' }).click();");
  });

  test('falls back to a line number, then a generic phrase, when no location', () => {
    expect(
      buildLocatorFixPrompt({ location: null, sourceLine: { line: 7, text: 'x' }, failing: 'a', recommended: 'b' }),
    ).toContain('line 7');
    expect(buildLocatorFixPrompt({ location: null, sourceLine: null, failing: 'a', recommended: 'b' })).toContain(
      'the failing test',
    );
  });
});
