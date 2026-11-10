import { randomBytes } from 'node:crypto';
import { desktopContentSecurityPolicy } from '../utils/desktop-csp';

// Content-Security-Policy for the desktop (Tauri) build only.
//
// The bundled dashboard is served to a webview that carries the native IPC
// bridge (`window.__TAURI__`), so any script executing in this origin can drive
// native commands. This policy gives injected script no way to run: inline
// scripts are allowed only with the per-response nonce, `strict-dynamic` lets
// the nonced entry load its chunks, and `connect-src` blocks exfiltration to
// any other host (it allows only the page's origin, Tauri's IPC endpoint and,
// for Open in editor, a JetBrains IDE's built-in server on loopback). It is gated on
// `PIWI_DESKTOP_TOKEN`, so the server / Docker / npx deployments (which are not
// in a native webview) are unaffected.
export default defineNitroPlugin((nitroApp) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) return;

  nitroApp.hooks.hook('render:html', (html, { event }) => {
    const nonce = randomBytes(16).toString('base64');
    const addNonce = (parts: string[]) =>
      parts.map((part) => part.replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`));

    html.head = addNonce(html.head);
    html.bodyPrepend = addNonce(html.bodyPrepend);
    html.body = addNonce(html.body);
    html.bodyAppend = addNonce(html.bodyAppend);

    setResponseHeader(event, 'Content-Security-Policy', desktopContentSecurityPolicy(nonce));
  });
});
