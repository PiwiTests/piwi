import { defineConfig, devices } from '@playwright/test';

/**
 * The window's specs: the window `npm run runner:window` built, served as a single-page app, with the shell's bridge
 * and the host's routes played by each spec. At the window's smallest size, so a text that does not fit shows.
 */
const PORT = 7595;

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  webServer: {
    command: `node tests/e2e/serve-window.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 640, height: 480 } } }],
});
