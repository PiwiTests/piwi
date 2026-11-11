import { JETBRAINS_PORTS } from '#shared/jetbrains-ports';

/**
 * The origins Open in editor reaches from the page: a JetBrains IDE's built-in
 * server on the loopback interface (the Piwi plugin's endpoint, IDE Remote
 * Control), on the ports the IDE takes and no other.
 */
const JETBRAINS_IDE_ORIGINS = JETBRAINS_PORTS.flatMap((port) => [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
]);

/**
 * The origin of Tauri's IPC endpoint on the platform the shell runs on (the
 * server runs beside it): `http://ipc.localhost` on Windows, `ipc:` elsewhere.
 * `invoke` and event subscriptions are `fetch` requests to it, and the commands
 * they carry stay limited by the runtime capability
 * (`apps/desktop/src-tauri/runtime-capabilities/remote.json`).
 */
export function tauriIpcOrigin(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'http://ipc.localhost' : 'ipc:';
}

/**
 * The desktop build's Content-Security-Policy (see `plugins/desktop-csp.ts`).
 * `connect-src` allows the page's own origin, Tauri's IPC endpoint and the
 * JetBrains IDE's built-in server on the loopback interface, so a request can
 * reach no other host.
 */
export function desktopContentSecurityPolicy(nonce: string, platform: NodeJS.Platform = process.platform): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${[tauriIpcOrigin(platform), ...JETBRAINS_IDE_ORIGINS].join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}
