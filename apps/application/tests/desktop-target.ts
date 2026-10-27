import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEV_SERVER_PORT } from '../shared/dev-server-port.mjs';

/**
 * The server the E2E suite runs against.
 *
 * By default that is the Playwright-managed dev/preview server on
 * `http://localhost:7494` (`DEV_SERVER_PORT`). Set `PIWI_DESKTOP_E2E` to instead run the whole suite
 * against the Piwi **desktop app** already running on this machine: the shell
 * publishes its loopback URL and access token to `~/.piwi/desktop.json`
 * while it runs (the same discovery file the reporter reads — see
 * `packages/reporter/src/internal/config/desktop.ts`), and that token gates every
 * `/api` and `/mcp` request (`server/middleware/desktop-guard.ts`). Override the
 * discovery path with `PIWI_DESKTOP_CONFIG`.
 */
export interface E2ETarget {
  /** Base URL the suite navigates and submits to (no trailing slash). */
  baseUrl: string;
  /** Desktop access token, when targeting the desktop app; otherwise `undefined`. */
  token?: string;
  /** True when targeting the locally running desktop app. */
  desktop: boolean;
}

/** Read `~/.piwi/desktop.json` (or `$PIWI_DESKTOP_CONFIG`), failing loudly when it is absent. */
function readDesktopTarget(): E2ETarget {
  const configPath = process.env.PIWI_DESKTOP_CONFIG || join(homedir(), '.piwi', 'desktop.json');
  let parsed: { url?: unknown; token?: unknown };
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error(
      `PIWI_DESKTOP_E2E is set, but the desktop app's discovery file is missing or unreadable at ${configPath}.\n` +
        `Launch the Piwi desktop app first — it writes this file while running and removes it on quit.`,
    );
  }
  const url = typeof parsed.url === 'string' ? parsed.url.replace(/\/+$/, '') : '';
  const token = typeof parsed.token === 'string' ? parsed.token : '';
  if (!url || !token) {
    throw new Error(
      `Desktop discovery file ${configPath} is missing a "url" or "token" — is the app still starting up?`,
    );
  }
  return { baseUrl: url, token, desktop: true };
}

/** Resolve the server the E2E suite targets from the environment. */
export function resolveE2ETarget(): E2ETarget {
  if (process.env.PIWI_DESKTOP_E2E) return readDesktopTarget();
  return { baseUrl: process.env.PIWI_BASE_URL || `http://localhost:${DEV_SERVER_PORT}`, desktop: false };
}

/** Headers that satisfy the desktop access guard; empty when not targeting the desktop. */
export function targetAuthHeaders(target: E2ETarget): Record<string, string> {
  return target.token ? { 'x-piwi-token': target.token } : {};
}
