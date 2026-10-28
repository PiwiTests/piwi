import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { debugFiles, debugLink, debugPrompt, debugRefusal, isDebugLink, type DebugDisk } from '../src/debug-link';

/** A debug link's query as `vscode.Uri.query` gives it, decoded, with `fields` over the dashboard's own. */
function query(fields: Record<string, string | null> = {}): string {
  const all: Record<string, string | null> = {
    file: 'tests/pages/checkout.page.ts',
    line: '5',
    debug: '1',
    spec: 'tests/checkout.spec.ts',
    test: 'checkout › pays with a coupon',
    playwrightProject: 'chromium',
    execution: '900',
    ...fields,
  };
  return Object.entries(all)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

describe('a debug link', () => {
  test('is told apart from a plain open link', () => {
    expect(isDebugLink(query())).toBe(true);
    expect(isDebugLink('file=tests/a.spec.ts&line=3')).toBe(false);
  });

  test('names the failing line, the test, its project and its execution', () => {
    expect(debugLink(query())).toEqual({
      file: 'tests/pages/checkout.page.ts',
      line: 5,
      column: 1,
      root: null,
      spec: 'tests/checkout.spec.ts',
      title: 'checkout › pays with a coupon',
      project: 'chromium',
      execution: 900,
    });
    // A title or a path may hold an `&`; the spec is the failing file when the link names none.
    expect(
      debugLink(
        query({
          spec: null,
          file: 'tests/a&b.spec.ts',
          test: 'adds & removes',
          column: '7',
          execution: null,
          playwrightProject: null,
        }),
      ),
    ).toEqual({
      file: 'tests/a&b.spec.ts',
      line: 5,
      column: 7,
      root: null,
      spec: 'tests/a&b.spec.ts',
      title: 'adds & removes',
      project: null,
      execution: null,
    });
  });

  test('refuses a line, a column or an execution that is not a positive whole number', () => {
    for (const line of ['0', '-1', '1.5', '1e3', '', '05', 'five', '99999999999', ' 5']) {
      expect(debugLink(query({ line }))).toEqual({ refused: 'line is not a positive whole number' });
    }
    expect(debugLink(query({ line: null }))).toEqual({ refused: 'line is not a positive whole number' });
    expect(debugLink(query({ column: '0' }))).toEqual({ refused: 'column is not a positive whole number' });
    for (const execution of ['0', 'abc', '-3', '2147483648']) {
      expect(debugLink(query({ execution }))).toEqual({ refused: 'execution is not an id' });
    }
  });

  test('refuses a path that climbs out of its folder, a network path and a control character', () => {
    expect(debugLink(query({ file: '../../etc/passwd' }))).toEqual({
      refused: 'file climbs out of its folder with ..',
    });
    expect(debugLink(query({ spec: 'tests/../../../home/me/.ssh/id_rsa' }))).toEqual({
      refused: 'spec climbs out of its folder with ..',
    });
    expect(debugLink(query({ file: 'tests\\..\\..\\secret.ts' }))).toEqual({
      refused: 'file climbs out of its folder with ..',
    });
    expect(debugLink(query({ file: '//server/share/a.spec.ts' }))).toEqual({ refused: 'file is a network path' });
    expect(debugLink(query({ file: '\\\\server\\share\\a.spec.ts' }))).toEqual({ refused: 'file is a network path' });
    expect(debugLink(query({ root: '/w/../etc' }))).toEqual({ refused: 'root climbs out of its folder with ..' });
    expect(debugLink(query({ file: 'tests/a\u0000.spec.ts' }))).toEqual({ refused: 'file holds a control character' });
    expect(debugLink(query({ file: null }))).toEqual({ refused: 'it names no file' });
  });

  test('refuses a title or a project that is not plain text, or a project a shell would expand', () => {
    const refusedTitle = { refused: 'test is not a title of 1 to 1000 characters of plain text' };
    for (const title of [
      '',
      '[Run me](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22rm%22%7D)',
      '<img src=x onerror=alert(1)>',
      'pays`rm -rf ~`',
      'line one\nline two',
      'a\\b',
      'x'.repeat(1001),
    ]) {
      expect(debugLink(query({ test: title }))).toEqual(refusedTitle);
    }
    expect(debugLink(query({ test: null }))).toEqual(refusedTitle);
    // A title with quotes and a shell's characters is text: it names a test, and never reaches a shell.
    expect(debugLink(query({ test: 'shows "Welcome" for $5 (50% off!)' }))).toMatchObject({
      title: 'shows "Welcome" for $5 (50% off!)',
    });
    const refusedProject = { refused: 'playwrightProject is not a project name of 1 to 200 characters of plain text' };
    // PowerShell reads “ ” „ as `"`: one would end the quoted --project and run what follows.
    const smartQuotes = ['chromium\u201C ; calc.exe ; #', 'chromium\u201D ; calc.exe', 'a\u201Eb'];
    for (const project of [
      'chromium$(touch pwned)',
      'a"b',
      '%PATH%',
      'x!',
      '[a](b)',
      'p'.repeat(201),
      ...smartQuotes,
    ]) {
      expect(debugLink(query({ playwrightProject: project }))).toEqual(refusedProject);
    }
    expect(debugLink(query({ playwrightProject: 'Mobile Chrome' }))).toMatchObject({ project: 'Mobile Chrome' });
  });

  test('refuses a field named twice, and anything but debug=1', () => {
    expect(debugLink(`${query()}&file=/etc/passwd`)).toEqual({ refused: 'it names file twice' });
    // A title that tries to slip in a second field is a field named twice.
    expect(debugLink(query({ test: 'pays&line=999' }))).toEqual({ refused: 'it names line twice' });
    expect(debugLink(query({ debug: 'true' }))).toEqual({ refused: 'debug is not 1' });
    expect(debugLink(query({ debug: '' }))).toEqual({ refused: 'debug is not 1' });
  });

  test('asks before it runs anything, and says what it refused', () => {
    expect(debugPrompt({ title: 'checkout › pays', line: 5, project: null })).toBe(
      'Piwi: Debug this test here? Piwi runs “checkout › pays” headed, one worker, and stops at line 5.',
    );
    // The project the run passes to Playwright is said too.
    expect(debugPrompt({ title: 'checkout › pays', line: 5, project: 'Mobile Chrome' })).toBe(
      'Piwi: Debug this test here? Piwi runs “checkout › pays” in the Playwright project “Mobile Chrome”, headed, one ' +
        'worker, and stops at line 5.',
    );
    expect(debugRefusal('line is not a positive whole number')).toBe(
      'Piwi: this Debug in my editor link was refused: line is not a positive whole number. Nothing was opened or run.',
    );
  });

  test('says a refused path as text: a link it holds does not read as one', () => {
    const named = '[Repair the link](command:workbench.action.terminal.sendSequence?{"text":"calc\n"})';
    const refused = debugFiles(
      { file: named, spec: named, root: null },
      { workspaceFolders: ['/work'], configRoots: ['/work'] },
      { isFile: () => false, realpath: (file) => file },
    );
    expect(refused).toMatchObject({ refused: expect.stringContaining('no file of this window matches') });
    const message = debugRefusal((refused as { refused: string }).refused);
    expect(message).not.toContain('](');
    expect(message).toContain('[Repair the link] (command:');
  });
});

describe('the files a debug link names', () => {
  let base = '';
  let workspace = '';
  let outside = '';
  const disk: DebugDisk = {
    isFile: (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
    realpath: (file) => {
      try {
        return fs.realpathSync(file);
      } catch {
        return null;
      }
    },
  };
  const places = () => ({ workspaceFolders: [workspace], configRoots: [path.join(workspace, 'e2e')] });

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-debug-link-')));
    workspace = path.join(base, 'shop');
    outside = path.join(base, 'elsewhere');
    const write = (file: string, text = '') => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    write(path.join(workspace, 'e2e/tests/checkout.spec.ts'));
    write(path.join(workspace, 'e2e/tests/pages/checkout.page.ts'));
    write(path.join(workspace, 'e2e/tests/data.json'));
    write(path.join(workspace, 'scripts/seed.spec.ts'));
    write(path.join(outside, 'tests/evil.spec.ts'));
    // A link inside the workspace to a file outside it.
    fs.symlinkSync(path.join(outside, 'tests/evil.spec.ts'), path.join(workspace, 'e2e/tests/linked.spec.ts'));
    fs.symlinkSync(path.join(outside, 'tests'), path.join(workspace, 'e2e/linked'));
  });

  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  test('are found under the Playwright configs’ folders, as an open link’s are', () => {
    expect(
      debugFiles({ file: 'tests/pages/checkout.page.ts', spec: 'tests/checkout.spec.ts', root: null }, places(), disk),
    ).toEqual({
      file: path.join(workspace, 'e2e/tests/pages/checkout.page.ts'),
      spec: path.join(workspace, 'e2e/tests/checkout.spec.ts'),
    });
    // The CI checkout's absolute path is matched by its end.
    expect(
      debugFiles(
        { file: '/ci/work/e2e/tests/checkout.spec.ts', spec: 'tests/checkout.spec.ts', root: null },
        places(),
        disk,
      ),
    ).toMatchObject({ file: path.join(workspace, 'e2e/tests/checkout.spec.ts') });
  });

  test('refuse a file outside the workspace, through a link or not', () => {
    expect(
      debugFiles(
        { file: path.join(outside, 'tests/evil.spec.ts'), spec: 'tests/checkout.spec.ts', root: null },
        places(),
        disk,
      ),
    ).toEqual({ refused: `no file of this window matches ${path.join(outside, 'tests/evil.spec.ts')}` });
    expect(
      debugFiles({ file: 'tests/linked.spec.ts', spec: 'tests/checkout.spec.ts', root: null }, places(), disk),
    ).toEqual({
      refused: "tests/linked.spec.ts is outside this window's folders",
    });
    expect(
      debugFiles({ file: 'linked/evil.spec.ts', spec: 'tests/checkout.spec.ts', root: null }, places(), disk),
    ).toEqual({
      refused: "linked/evil.spec.ts is outside this window's folders",
    });
    // A root outside the workspace is no place to look in.
    expect(
      debugFiles({ file: 'tests/evil.spec.ts', spec: 'tests/evil.spec.ts', root: outside }, places(), disk),
    ).toEqual({
      refused: 'no file of this window matches tests/evil.spec.ts',
    });
  });

  test('refuse a file under no Playwright config, one no test can stop in, and a spec that is not one', () => {
    expect(
      debugFiles({ file: 'scripts/seed.spec.ts', spec: 'scripts/seed.spec.ts', root: null }, places(), disk),
    ).toEqual({
      refused: "scripts/seed.spec.ts is under no Playwright config's folder",
    });
    expect(debugFiles({ file: 'tests/data.json', spec: 'tests/checkout.spec.ts', root: null }, places(), disk)).toEqual(
      {
        refused: 'tests/data.json is not a JavaScript or TypeScript file',
      },
    );
    expect(
      debugFiles({ file: 'tests/checkout.spec.ts', spec: 'tests/pages/checkout.page.ts', root: null }, places(), disk),
    ).toEqual({ refused: 'tests/pages/checkout.page.ts is not a spec' });
  });
});
