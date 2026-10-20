import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

/**
 * Desktop shell ACL consistency.
 *
 * The desktop dashboard is served from a real loopback server, so its webview
 * runs at a *remote* origin (`http://127.0.0.1:<port>`). Tauri refuses to expose
 * app (custom) commands to remote content unless a capability explicitly grants
 * them — so a command that is registered in `generate_handler!` but not declared
 * in `build.rs` and granted in `runtime-capabilities/remote.json` is silently rejected
 * by the ACL at runtime (`Command … not allowed by ACL`), which is invisible to
 * every compile-time and lint check.
 *
 * This test closes that gap: it asserts the three lists stay in lockstep, so
 * adding a new `#[tauri::command]` fails here until it's wired end to end. (A
 * true runtime check would need a `tauri-driver` WebDriver harness driving the
 * built app; this static check catches the specific wiring bug cheaply in the
 * existing unit-test CI job.)
 */

function read(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
}

/** Commands registered with the webview via `tauri::generate_handler![…]`. */
function handlerCommands(libRs: string): string[] {
  const block = libRs.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!block) throw new Error('generate_handler![…] block not found in lib.rs');
  return block[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-z][a-z0-9_]*$/.test(s));
}

/** Commands declared for permission autogeneration in `build.rs`. */
function manifestCommands(buildRs: string): string[] {
  const block = buildRs.match(/\.commands\(&\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('.commands(&[…]) block not found in build.rs');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** `allow-*` app-command grants in a capability's `permissions` array. */
function grantedCommands(capabilityJson: string): string[] {
  const cap = JSON.parse(capabilityJson) as { permissions: unknown[] };
  return cap.permissions
    .filter((p): p is string => typeof p === 'string' && p.startsWith('allow-desktop-'))
    .map((p) => p.replace(/^allow-/, '').replace(/-/g, '_'));
}

describe('desktop shell ACL wiring', () => {
  const handlers = handlerCommands(read('../../../desktop/src-tauri/src/lib.rs'));
  const manifest = manifestCommands(read('../../../desktop/src-tauri/build.rs'));
  const remoteGrants = grantedCommands(read('../../../desktop/src-tauri/runtime-capabilities/remote.json'));

  test('every registered command exists (sanity)', () => {
    expect(handlers.length).toBeGreaterThan(0);
  });

  test('build.rs app-manifest commands match the registered handlers', () => {
    expect([...manifest].sort()).toEqual([...handlers].sort());
  });

  test('remote capability grants every registered command', () => {
    // Missing grants here are exactly the "not allowed by ACL" runtime bug.
    const missing = handlers.filter((cmd) => !remoteGrants.includes(cmd));
    expect(missing, `commands not granted to the loopback origin in remote.json: ${missing.join(', ')}`).toEqual([]);
  });

  test('no capability compiled into the app grants remote content: the shell adds it for the sidecar origin', () => {
    const dir = fileURLToPath(new URL('../../../desktop/src-tauri/capabilities/', import.meta.url));
    const remote = readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .filter((file) => 'remote' in (JSON.parse(readFileSync(`${dir}${file}`, 'utf8')) as object));
    expect(remote).toEqual([]);
  });

  test('no stale grants that no longer map to a command', () => {
    const stale = remoteGrants.filter((cmd) => !handlers.includes(cmd));
    expect(stale, `allow-* grants in remote.json with no matching command: ${stale.join(', ')}`).toEqual([]);
  });
});
