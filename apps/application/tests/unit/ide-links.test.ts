import { describe, test, expect } from 'vitest';
import {
  buildJetbrainsHttpUrl,
  buildJetbrainsNavigateUrl,
  buildPiwiPluginOpenUrl,
  buildVscodeExtensionUrl,
  buildVscodeUrl,
  debugTargetOf,
  encodePathForUrl,
  failurePlace,
  isJetbrainsProduct,
  jetbrainsPorts,
  joinWorkspacePath,
  parseLocation,
  pickPiwiPluginAnswer,
  VSCODE_CLI_COMMANDS,
} from '../../app/utils/ide-links';

describe('joinWorkspacePath', () => {
  test('joins a root and a relative path', () => {
    expect(joinWorkspacePath('/home/me/repo', 'tests/a.spec.ts')).toBe('/home/me/repo/tests/a.spec.ts');
  });

  test('trims a trailing slash on the root', () => {
    expect(joinWorkspacePath('/home/me/repo/', 'tests/a.spec.ts')).toBe('/home/me/repo/tests/a.spec.ts');
  });

  test('strips a leading ./ or / on the relative path', () => {
    expect(joinWorkspacePath('/root', './tests/a.spec.ts')).toBe('/root/tests/a.spec.ts');
    expect(joinWorkspacePath('/root', '/tests/a.spec.ts')).toBe('/root/tests/a.spec.ts');
  });

  test('normalizes backslashes on a Windows relative path', () => {
    expect(joinWorkspacePath('C:\\repo', 'tests\\a.spec.ts')).toBe('C:/repo/tests/a.spec.ts');
  });

  test('returns the relative path unchanged when the root is empty', () => {
    expect(joinWorkspacePath('', 'tests/a.spec.ts')).toBe('tests/a.spec.ts');
  });
});

describe('encodePathForUrl', () => {
  test('encodes spaces but keeps slashes and the drive colon', () => {
    expect(encodePathForUrl('C:/my repo/a.ts')).toBe('C:/my%20repo/a.ts');
  });

  test('encodes % first so it is not double-encoded', () => {
    expect(encodePathForUrl('/a%b/c#d?e')).toBe('/a%25b/c%23d%3Fe');
  });
});

describe('buildVscodeUrl', () => {
  test('builds a Unix absolute path with line and column', () => {
    expect(buildVscodeUrl({ scheme: 'vscode', absPath: '/home/me/repo/tests/a.spec.ts', line: 12, column: 3 })).toBe(
      'vscode://file/home/me/repo/tests/a.spec.ts:12:3',
    );
  });

  test('preserves the Windows drive colon and adds one slash after file', () => {
    expect(buildVscodeUrl({ scheme: 'vscode', absPath: 'C:\\repo\\tests\\a.spec.ts', line: 5 })).toBe(
      'vscode://file/C:/repo/tests/a.spec.ts:5',
    );
  });

  test('omits the position when no line is given', () => {
    expect(buildVscodeUrl({ scheme: 'cursor', absPath: '/repo/a.ts' })).toBe('cursor://file/repo/a.ts');
  });

  test('omits the column when only a line is given', () => {
    expect(buildVscodeUrl({ scheme: 'vscode-insiders', absPath: '/repo/a.ts', line: 9 })).toBe(
      'vscode-insiders://file/repo/a.ts:9',
    );
  });

  test('encodes a space in the path', () => {
    expect(buildVscodeUrl({ scheme: 'vscode', absPath: '/my repo/a.ts', line: 1 })).toBe(
      'vscode://file/my%20repo/a.ts:1',
    );
  });
});

describe('buildVscodeExtensionUrl', () => {
  test('names the path as the run reported it, its line and column, for the Piwi extension', () => {
    expect(buildVscodeExtensionUrl({ scheme: 'vscode', path: 'tests/a.spec.ts', line: 12, column: 3 })).toBe(
      'vscode://piwitests.piwi/open?file=tests%2Fa.spec.ts&line=12&column=3',
    );
  });

  test('uses the flavor as the scheme, and adds the root when known', () => {
    expect(buildVscodeExtensionUrl({ scheme: 'cursor', path: 'a.ts', root: 'C:\\my repo' })).toBe(
      'cursor://piwitests.piwi/open?file=a.ts&root=C%3A%2Fmy%20repo',
    );
    expect(buildVscodeExtensionUrl({ scheme: 'vscodium', path: 'a.ts', line: 4 })).toBe(
      'vscodium://piwitests.piwi/open?file=a.ts&line=4',
    );
  });

  test('encodes a space as %20 and keeps a plus, an ampersand and a hash inside the value', () => {
    expect(buildVscodeExtensionUrl({ scheme: 'vscode-insiders', path: 'tests\\a b+c&d#e.spec.ts' })).toBe(
      'vscode-insiders://piwitests.piwi/open?file=tests%2Fa%20b%2Bc%26d%23e.spec.ts',
    );
  });
});

describe('buildJetbrainsNavigateUrl', () => {
  test('puts the 0-based line and column the IDE reads inside the path value', () => {
    expect(
      buildJetbrainsNavigateUrl({
        product: 'idea',
        projectName: 'my-app',
        relPath: 'tests/a.spec.ts',
        line: 12,
        column: 3,
      }),
    ).toBe('jetbrains://idea/navigate/reference?project=my-app&path=tests/a.spec.ts:11:2');
  });

  test('sends line 1 as 0 and a line without a column alone', () => {
    expect(buildJetbrainsNavigateUrl({ product: 'rider', projectName: 'Shop', relPath: 'a.ts', line: 1 })).toBe(
      'jetbrains://rider/navigate/reference?project=Shop&path=a.ts:0',
    );
  });

  test('encodes a project name with a space', () => {
    expect(buildJetbrainsNavigateUrl({ product: 'webstorm', projectName: 'My App', relPath: 'a.ts' })).toBe(
      'jetbrains://webstorm/navigate/reference?project=My%20App&path=a.ts',
    );
  });
});

describe('buildJetbrainsHttpUrl', () => {
  test('builds an endpoint on the default port with a double slash for an absolute path', () => {
    expect(buildJetbrainsHttpUrl({ port: 63342, path: '/home/me/repo/a.ts', line: 4, column: 2 })).toBe(
      'http://localhost:63342/api/file//home/me/repo/a.ts:4:2',
    );
  });

  test('honors a custom port', () => {
    expect(buildJetbrainsHttpUrl({ port: 63350, path: 'tests/a.ts', line: 7 })).toBe(
      'http://localhost:63350/api/file/tests/a.ts:7',
    );
  });
});

describe('jetbrainsPorts', () => {
  test('asks the configured port first, then the rest of the range the IDEs take', () => {
    const ports = jetbrainsPorts(63345);
    expect(ports[0]).toBe(63345);
    expect(ports).toHaveLength(20);
    expect(ports.slice(1, 4)).toEqual([63342, 63343, 63344]);
    expect(ports.at(-1)).toBe(63361);
  });

  test('adds a port outside the range, and drops an invalid one', () => {
    expect(jetbrainsPorts(8080)).toHaveLength(21);
    expect(jetbrainsPorts(Number.NaN)[0]).toBe(63342);
  });
});

describe('buildPiwiPluginOpenUrl', () => {
  test('sends the run path, the root, the 1-based position and the project as query parameters', () => {
    expect(
      buildPiwiPluginOpenUrl({
        port: 63342,
        path: 'tests\\checkout #1.spec.ts',
        root: 'C:\\repo\\e2e',
        line: 12,
        column: 3,
        project: 'Shop & Co',
      }),
    ).toBe(
      'http://127.0.0.1:63342/api/piwi/open?file=tests%2Fcheckout+%231.spec.ts&root=C%3A%2Frepo%2Fe2e&line=12&column=3&project=Shop+%26+Co',
    );
  });

  test('asks for a check, and leaves out what is unknown', () => {
    expect(buildPiwiPluginOpenUrl({ port: 63343, path: 'a.ts', column: 4, check: true })).toBe(
      'http://127.0.0.1:63343/api/piwi/open?file=a.ts&check=1',
    );
  });
});

describe('pickPiwiPluginAnswer', () => {
  const webstorm = { port: 63342, answer: { found: true, ide: 'WebStorm' } };
  const rider = { port: 63343, answer: { found: true, ide: 'Rider' } };
  const idea = { port: 63344, answer: { found: false, ide: 'IntelliJ IDEA' } };
  const none = { port: 63345, answer: null };

  test('picks the configured product among the IDEs that hold the file', () => {
    expect(pickPiwiPluginAnswer([webstorm, rider, idea, none], 'rider')).toBe(rider);
  });

  test('falls back to the first IDE that holds the file, and to null when none does', () => {
    expect(pickPiwiPluginAnswer([idea, webstorm, rider], 'idea')).toBe(webstorm);
    expect(pickPiwiPluginAnswer([idea, none], 'idea')).toBeNull();
  });

  test('matches a product tag to the IDE name', () => {
    expect(isJetbrainsProduct('IntelliJ IDEA', 'idea')).toBe(true);
    expect(isJetbrainsProduct('RustRover', 'rustrover')).toBe(true);
    expect(isJetbrainsProduct('WebStorm', 'rider')).toBe(false);
    expect(isJetbrainsProduct('Rider', '')).toBe(false);
  });
});

describe('VSCODE_CLI_COMMANDS', () => {
  test('maps each flavor to the command it installs on the PATH', () => {
    expect(VSCODE_CLI_COMMANDS).toEqual({
      vscode: 'code',
      'vscode-insiders': 'code-insiders',
      vscodium: 'codium',
      cursor: 'cursor',
    });
  });
});

describe('parseLocation (re-exported)', () => {
  test('parses filePath:line:column', () => {
    expect(parseLocation('tests/login.spec.ts:12:5')).toEqual({
      filePath: 'tests/login.spec.ts',
      line: 12,
      column: 5,
    });
  });

  test('handles a Windows path with a drive letter', () => {
    expect(parseLocation('C:\\repo\\tests\\login.spec.ts:10:5')).toEqual({
      filePath: 'C:\\repo\\tests\\login.spec.ts',
      line: 10,
      column: 5,
    });
  });
});

describe('Debug in my editor', () => {
  /** A failed execution as the execution page reads it: failing in a page object called from the test. */
  const failed = {
    id: 37,
    title: 'pays with a coupon',
    filePath: 'tests/checkout.spec.ts',
    line: 12,
    suitePath: ['checkout', 'coupons'],
    testSourceFrames: [
      { file: 'tests/pages/checkout.page.ts', line: 30 },
      { file: 'tests/checkout.spec.ts', line: 15 },
    ],
    browser: { projectName: 'Mobile Chrome' },
  };

  test('the failing line is where the failure enters the test’s code, not the test’s own line', () => {
    expect(failurePlace(failed)).toEqual({ filePath: 'tests/pages/checkout.page.ts', line: 30 });
    // A stack that names only the test's declaration (a test timeout) has no place.
    expect(failurePlace({ ...failed, testSourceFrames: [{ file: 'tests/checkout.spec.ts', line: 12 }] })).toBeNull();
    expect(
      failurePlace({
        ...failed,
        testSourceFrames: [
          { file: 'tests/checkout.spec.ts', line: 12 },
          { file: 'tests/checkout.spec.ts', line: 18 },
        ],
      }),
    ).toEqual({ filePath: 'tests/checkout.spec.ts', line: 18 });
    expect(failurePlace({ ...failed, testSourceFrames: null })).toBeNull();
    expect(
      failurePlace({
        ...failed,
        testSourceFrames: [
          { file: '', line: 3 },
          { file: 'a.ts', line: 0 },
        ],
      }),
    ).toBeNull();
    expect(failurePlace(null)).toBeNull();
  });

  test('shows only for a failure with a place in the test’s code, and names the test, its project and the execution', () => {
    expect(debugTargetOf(failed)).toEqual({
      filePath: 'tests/pages/checkout.page.ts',
      line: 30,
      debug: {
        spec: 'tests/checkout.spec.ts',
        title: 'checkout › coupons › pays with a coupon',
        project: 'Mobile Chrome',
        execution: 37,
      },
    });
    expect(debugTargetOf({ ...failed, testSourceFrames: [] })).toBeNull();
    expect(debugTargetOf({ ...failed, filePath: null })).toBeNull();
    expect(debugTargetOf({ ...failed, title: '' })).toBeNull();
    expect(debugTargetOf({ ...failed, suitePath: null, browser: null, id: null })?.debug).toEqual({
      spec: 'tests/checkout.spec.ts',
      title: 'pays with a coupon',
      project: null,
      execution: null,
    });
  });

  const debug = {
    spec: 'tests\\checkout.spec.ts',
    title: 'pays & saves 10% › “twice”?',
    project: 'Mobile Chrome',
    execution: 37,
  };

  test('the Piwi extension’s link gains debug=1 and the test, each value encoded whole', () => {
    const url = buildVscodeExtensionUrl({ scheme: 'vscode', path: 'tests/pages/checkout.page.ts', line: 30, debug });
    expect(url).toBe(
      'vscode://piwitests.piwi/open?file=tests%2Fpages%2Fcheckout.page.ts&line=30&debug=1' +
        '&spec=tests%2Fcheckout.spec.ts&test=pays%20%26%20saves%2010%25%20%E2%80%BA%20%E2%80%9Ctwice%E2%80%9D%3F' +
        '&playwrightProject=Mobile%20Chrome&execution=37',
    );
    // What the extension reads back: `vscode.Uri.query`, decoded.
    const query = decodeURIComponent(new URL(url).search.slice(1));
    expect(query).toContain('&test=pays & saves 10% › “twice”?&playwrightProject=Mobile Chrome&');
    // No project and no execution leave their fields out; with no line there is nothing to stop at.
    expect(
      buildVscodeExtensionUrl({ scheme: 'cursor', path: 'a.ts', line: 2, debug: { spec: 'a.spec.ts', title: 'pays' } }),
    ).toBe('cursor://piwitests.piwi/open?file=a.ts&line=2&debug=1&spec=a.spec.ts&test=pays');
    expect(buildVscodeExtensionUrl({ scheme: 'vscode', path: 'a.ts', debug })).toBe(
      'vscode://piwitests.piwi/open?file=a.ts',
    );
  });

  test('the Piwi plugin’s open request gains debug=1 and the test, never on a check', () => {
    const url = new URL(
      buildPiwiPluginOpenUrl({ port: 63342, path: 'tests/pages/checkout.page.ts', line: 30, project: 'shop', debug }),
    );
    expect([...url.searchParams]).toEqual([
      ['file', 'tests/pages/checkout.page.ts'],
      ['line', '30'],
      ['project', 'shop'],
      ['debug', '1'],
      ['spec', 'tests/checkout.spec.ts'],
      ['test', 'pays & saves 10% › “twice”?'],
      ['playwrightProject', 'Mobile Chrome'],
      ['execution', '37'],
    ]);
    const check = new URL(buildPiwiPluginOpenUrl({ port: 63342, path: 'a.ts', line: 3, check: true, debug }));
    expect([...check.searchParams.keys()]).toEqual(['file', 'line', 'check']);
  });
});
