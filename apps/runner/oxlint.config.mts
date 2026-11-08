import { defineConfig } from 'oxlint';
import base from '../../shared/oxlint.baseConfig.mts';

export default defineConfig({
  ...base,
  plugins: ['typescript', 'unicorn', 'import', 'vue'],
  ignorePatterns: [...base.ignorePatterns],
  rules: {
    ...base.rules,
    'unicorn/prefer-node-protocol': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
  },
});
