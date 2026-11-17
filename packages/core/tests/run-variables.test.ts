import { describe, expect, test } from 'vitest';
import {
  RUN_VARIABLE_LIMITS,
  bashQuote,
  isRefusedRunVariableName,
  parseRunVariables,
  powerShellQuote,
  runVariableAssignments,
  runVariableNameProblem,
  runVariableValueProblem,
  withRunVariables,
} from '../src/run-variables';

function problemsOf(value: unknown): string[] {
  const parsed = parseRunVariables(value);
  return parsed.ok ? [] : parsed.problems;
}

describe('runVariableNameProblem', () => {
  test.each(['TENANT', '_TENANT', 'A', 'TENANT_2', 'X'.repeat(64)])('takes %s', (name) => {
    expect(runVariableNameProblem(name)).toBeNull();
  });

  test.each(['', 'tenant', 'Tenant', '2TENANT', 'TEN-ANT', 'TEN ANT', 'TENANT=1', 'X'.repeat(65), 'BASH_FUNC_npx%%'])(
    'refuses the name %s',
    (name) => {
      expect(runVariableNameProblem(name)).toMatch(/is not a variable name/);
    },
  );

  test.each([
    'PATH',
    'PATHEXT',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'ELECTRON_RUN_AS_NODE',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'NPM_CONFIG_SCRIPT_SHELL',
    'NPM_EXECPATH',
    'PIWI_PROJECT_NAME',
    'PIWI_SERVER_URL',
    'PLAYWRIGHT_BROWSERS_PATH',
    'PW_TEST_REPORTER',
    'PWDEBUG',
    'GIT_CONFIG_COUNT',
    'GIT_SSH_COMMAND',
    'BASH_ENV',
    'ENV',
    'SHELLOPTS',
    'PS4',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TMP',
    'TEMP',
    'TMPDIR',
    'SHELL',
    'COMSPEC',
    'HTTPS_PROXY',
    'SSL_CERT_FILE',
    'DOTNET_STARTUP_HOOKS',
    'JAVA_TOOL_OPTIONS',
    'PYTHONPATH',
    'PERL5OPT',
    'RUBYOPT',
    'XDG_CONFIG_HOME',
    'DISPLAY',
  ])('refuses %s, a variable that changes what runs or where results go', (name) => {
    expect(runVariableNameProblem(name)).toMatch(/is not a variable a project can set/);
  });

  test('refuses a name whatever its case, as Windows reads it', () => {
    expect(isRefusedRunVariableName('Path')).toBe(true);
    expect(isRefusedRunVariableName('node_options')).toBe(true);
    expect(isRefusedRunVariableName('piwi_project_name')).toBe(true);
    expect(isRefusedRunVariableName('TENANT')).toBe(false);
  });
});

describe('runVariableValueProblem', () => {
  test('takes an empty value and one of 500 characters', () => {
    expect(runVariableValueProblem('TENANT', '')).toBeNull();
    expect(runVariableValueProblem('TENANT', 'a'.repeat(RUN_VARIABLE_LIMITS.valueChars))).toBeNull();
    expect(runVariableValueProblem('TENANT', `it's "acme" $HOME; rm -rf / & | \` %PATH%`)).toBeNull();
  });

  test('refuses a longer value', () => {
    expect(runVariableValueProblem('TENANT', 'a'.repeat(501))).toMatch(/longer than 500/);
  });

  test.each(['a\nb', 'a\rb', 'a\u0000b', 'a\tb', 'a‮b', 'a​b', 'a b', 'a️b'])(
    'refuses a hidden character in %j',
    (value) => {
      expect(runVariableValueProblem('TENANT', value)).toMatch(/hidden|line break|invisible/);
    },
  );
});

describe('parseRunVariables', () => {
  test('reads a list, and none for undefined or null', () => {
    expect(parseRunVariables([{ name: 'TENANT', value: 'acme' }])).toEqual({
      ok: true,
      value: [{ name: 'TENANT', value: 'acme' }],
    });
    expect(parseRunVariables(undefined)).toEqual({ ok: true, value: [] });
    expect(parseRunVariables(null)).toEqual({ ok: true, value: [] });
    expect(parseRunVariables([])).toEqual({ ok: true, value: [] });
  });

  test('refuses what is not a list of names and values', () => {
    expect(problemsOf('TENANT=acme')).toEqual(['The run variables must be a list.']);
    expect(problemsOf({ TENANT: 'acme' })).toEqual(['The run variables must be a list.']);
    expect(problemsOf(['TENANT=acme'])).toEqual(['Run variable 1 must be an object with a name and a value.']);
    expect(problemsOf([{ name: 'TENANT', value: 1 }])).toEqual([
      'Run variable 1 must have a text name and a text value.',
    ]);
    expect(problemsOf([{ name: 'TENANT' }])).toEqual(['Run variable 1 must have a text name and a text value.']);
    expect(problemsOf([{ name: 'TENANT', value: 'acme', secret: true }])).toEqual([
      'Run variable 1 has fields a run variable does not have: secret.',
    ]);
  });

  test('refuses more than 10 variables', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `V${i}`, value: '' }));
    expect(problemsOf(many)).toEqual(['A project has at most 10 run variables.']);
    expect(problemsOf(many.slice(0, 10))).toEqual([]);
  });

  test('refuses a name set twice', () => {
    expect(
      problemsOf([
        { name: 'TENANT', value: 'acme' },
        { name: 'TENANT', value: 'globex' },
      ]),
    ).toEqual(['TENANT is set twice.']);
  });

  test('refuses the whole list when one variable is refused', () => {
    expect(
      problemsOf([
        { name: 'TENANT', value: 'acme' },
        { name: 'NODE_OPTIONS', value: '--require ./x.js' },
      ]),
    ).toEqual([expect.stringMatching(/^NODE_OPTIONS is not a variable a project can set/)]);
  });
});

describe('withRunVariables', () => {
  const variables = [
    { name: 'TENANT', value: 'acme' },
    { name: 'REGION', value: "eu west's" },
  ];

  test('leaves a command without variables as it is', () => {
    expect(withRunVariables('npx playwright test', [], 'bash')).toBe('npx playwright test');
    expect(withRunVariables('npx playwright test', [], 'powershell')).toBe('npx playwright test');
  });

  test('sets the variables before the command in bash', () => {
    expect(withRunVariables('npx playwright test', variables, 'bash')).toBe(
      `TENANT=acme REGION='eu west'\\''s' npx playwright test`,
    );
  });

  test('sets the variables for the session in PowerShell', () => {
    expect(withRunVariables('npx playwright test', variables, 'powershell')).toBe(
      `$env:TENANT='acme'; $env:REGION='eu west''s'; npx playwright test`,
    );
  });

  test('writes the variables as words env takes, quoted for each shell', () => {
    expect(runVariableAssignments(variables, 'bash')).toBe(`TENANT=acme REGION='eu west'\\''s'`);
    expect(runVariableAssignments(variables, 'powershell')).toBe(`TENANT='acme' REGION='eu west''s'`);
  });

  test('quotes every value a shell would read', () => {
    expect(bashQuote('')).toBe(`''`);
    expect(bashQuote('acme-1.2/eu:x@y')).toBe('acme-1.2/eu:x@y');
    expect(bashQuote('$(id)')).toBe(`'$(id)'`);
    expect(bashQuote('`id`')).toBe("'`id`'");
    expect(bashQuote('a;b')).toBe(`'a;b'`);
    expect(bashQuote('~/x')).toBe(`'~/x'`);
    expect(powerShellQuote('$(id)')).toBe(`'$(id)'`);
    expect(powerShellQuote('a’b')).toBe(`'a’’b'`);
    expect(powerShellQuote('')).toBe(`''`);
  });
});
