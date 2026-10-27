import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The Nitro backend's unit tests (`npm run coverage:unit` with SAMPLE_BACKEND=nitro). Their coverage counts the
// backend's sources only, every one of them, run or not, and goes out as LCOV with paths relative to the sample's
// folder, which `piwi coverage upload` resolves against the repository.
const sample = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: sample,
  test: {
    include: ['backends/nitro.tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['backends/nitro/**/*.ts'],
      exclude: ['backends/nitro/nitro.config.ts', 'backends/nitro/.nitro/**', 'backends/nitro/.output/**'],
      reporter: ['lcovonly'],
      reportsDirectory: 'backends/nitro.tests/coverage',
    },
  },
});
