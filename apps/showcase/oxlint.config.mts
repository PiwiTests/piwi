import { defineConfig } from 'oxlint';
import base from '../../shared/oxlint.baseConfig.mts';

export default defineConfig({
  ...base,
  plugins: ['unicorn', 'import'],
  ignorePatterns: [...base.ignorePatterns, 'results/**'],
  rules: {
    ...base.rules,
    'unicorn/prefer-node-protocol': 'error',
  },
});
