import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'bench/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // Presets turn on Node's compile cache; the tests run without it.
    env: { NODE_DISABLE_COMPILE_CACHE: '1' },
  },
});
