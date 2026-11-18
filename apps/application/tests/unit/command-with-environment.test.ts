import { describe, expect, test } from 'vitest';
import { commandWithEnvironment } from '../../shared/run-variables';

const variables = [
  { name: 'TENANT', value: 'acme' },
  { name: 'TEST_ENV', value: 'production' },
];
const staging = { id: 3, key: 'staging', name: 'Staging', protected: false, requiredTags: [], envFile: null };
const production = {
  id: 4,
  key: 'production',
  name: 'Production',
  protected: true,
  requiredTags: ['@smoke'],
  envFile: null,
};
const FILTER = "--grep-invert '^(?!.*(?:^|\\s)(?:@smoke)(?:\\s|$))'";

describe('commandWithEnvironment', () => {
  test('sets the variables and the key on each command of a chain', () => {
    expect(commandWithEnvironment('npx playwright test a && npx playwright test b', variables, staging, 'bash')).toBe(
      'TENANT=acme TEST_ENV=production PIWI_ENVIRONMENT=staging npx playwright test a && ' +
        'TENANT=acme TEST_ENV=production PIWI_ENVIRONMENT=staging npx playwright test b',
    );
    expect(commandWithEnvironment('npx playwright test a', variables, staging, 'powershell')).toBe(
      "$env:TENANT='acme'; $env:TEST_ENV='production'; $env:PIWI_ENVIRONMENT='staging'; npx playwright test a",
    );
  });

  test('adds a protected environment filter where Playwright receives it', () => {
    expect(commandWithEnvironment('npx playwright test a', variables, production, 'bash')).toBe(
      `TENANT=acme TEST_ENV=production PIWI_ENVIRONMENT=production npx playwright test a ${FILTER}`,
    );
    expect(commandWithEnvironment('npx @piwitests/reporter run k1', [], production, 'bash')).toBe(
      `PIWI_ENVIRONMENT=production npx @piwitests/reporter run k1 -- ${FILTER}`,
    );
    expect(commandWithEnvironment('npx @piwitests/reporter run k1 -- --headed', [], production, 'bash')).toBe(
      `PIWI_ENVIRONMENT=production npx @piwitests/reporter run k1 -- --headed ${FILTER}`,
    );
  });

  test('leaves a command that cannot take the filter as it is for a protected environment', () => {
    expect(commandWithEnvironment('npx @piwitests/reporter flake 12', variables, production, 'bash')).toBe(
      'npx @piwitests/reporter flake 12',
    );
  });
});
