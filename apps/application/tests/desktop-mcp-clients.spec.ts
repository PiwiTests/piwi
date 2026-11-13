import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * The desktop-only MCP client configuration card on /mcp, driven against the
 * regular web build with a faked Tauri bridge. Detection, file editing and
 * healing live in the Rust shell (unit-tested there); this covers the
 * dashboard side: statuses render, connect/disconnect round-trip, and the
 * card stays out of plain browsers.
 */

interface FakeClient {
  id: string;
  label: string;
  config_path: string;
  status: string;
  detail: string | null;
}

declare global {
  interface Window {
    __piwiMcpInvocations: { cmd: string; args: Record<string, unknown> | undefined }[];
  }
}

async function installFakeBridge(page: Page) {
  await page.addInitScript(() => {
    const clients: FakeClient[] = [
      {
        id: 'claude-code',
        label: 'Claude Code',
        config_path: '/home/dev/.claude.json',
        status: 'not_connected',
        detail: null,
      },
      {
        id: 'opencode',
        label: 'Opencode',
        config_path: '/home/dev/.config/opencode/opencode.json',
        status: 'not_connected',
        detail: null,
      },
      {
        id: 'claude-desktop',
        label: 'Claude Desktop',
        config_path: '/home/dev/.config/Claude/claude_desktop_config.json',
        status: 'stale',
        detail: null,
      },
      { id: 'cursor', label: 'Cursor', config_path: '/home/dev/.cursor/mcp.json', status: 'connected', detail: null },
      {
        id: 'vscode',
        label: 'VS Code',
        config_path: '/home/dev/.config/Code/User/mcp.json',
        status: 'manual',
        detail: 'the file is not plain JSON — add the entry manually',
      },
      { id: 'windsurf', label: 'Windsurf', config_path: '', status: 'not_installed', detail: null },
      {
        id: 'gemini-cli',
        label: 'Gemini CLI',
        config_path: '/home/dev/.gemini/settings.json',
        status: 'manual',
        detail: 'Move Piwi to Applications so assistants can find it',
      },
    ];
    const invocations: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
    Object.assign(window, { __piwiMcpInvocations: invocations });
    Object.assign(window, {
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            invocations.push({ cmd, args });
            switch (cmd) {
              case 'desktop_mcp_clients':
                return clients;
              case 'desktop_mcp_connect':
              case 'desktop_mcp_disconnect': {
                const client = clients.find((c) => c.id === args?.clientId);
                if (!client) throw new Error('unknown client');
                client.status = cmd === 'desktop_mcp_connect' ? 'connected' : 'not_connected';
                return client;
              }
              case 'desktop_take_pending_open_files':
                return [];
              default:
                throw new Error(`unexpected command: ${cmd}`);
            }
          },
        },
        event: {
          listen: async () => () => {},
        },
      },
    });
  });
}

test.describe('Desktop MCP client configuration', () => {
  test('the card does not exist without the bridge', async ({ page }) => {
    await page.goto('/settings/mcp');
    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: 'Client setup' })).toBeVisible();
    await expect(page.getByText('Connect a client on this machine')).toHaveCount(0);
  });

  test('shows detected clients and connects one', async ({ page }) => {
    await installFakeBridge(page);
    await page.goto('/settings/mcp');
    await waitForHydration(page);

    await expect(page.getByText('Connect a client on this machine')).toBeVisible();

    // One row per status flavor.
    await expect(page.getByTestId('mcp-client-cursor').getByText('Connected')).toBeVisible();
    await expect(page.getByTestId('mcp-client-claude-desktop').getByText('Needs update')).toBeVisible();
    await expect(page.getByTestId('mcp-client-vscode').getByText('Manual setup')).toBeVisible();
    await expect(page.getByTestId('mcp-client-windsurf').getByText('Not detected')).toBeVisible();

    // A client the app may not write to says why, and offers no Connect.
    const gemini = page.getByTestId('mcp-client-gemini-cli');
    await expect(gemini.getByText('Manual setup')).toBeVisible();
    await expect(gemini.getByText('Move Piwi to Applications so assistants can find it')).toBeVisible();
    await expect(gemini.getByRole('button', { name: 'Connect' })).toHaveCount(0);

    const claudeCode = page.getByTestId('mcp-client-claude-code');
    await claudeCode.getByRole('button', { name: 'Connect' }).click();
    await expect(claudeCode.getByText('Connected')).toBeVisible();
    await expect(claudeCode.getByRole('button', { name: 'Disconnect' })).toBeVisible();

    const connectCall = await page.evaluate(() =>
      window.__piwiMcpInvocations.find((i) => i.cmd === 'desktop_mcp_connect'),
    );
    expect(connectCall?.args?.clientId).toBe('claude-code');

    // Disconnect round-trips too.
    await claudeCode.getByRole('button', { name: 'Disconnect' }).click();
    await expect(claudeCode.getByRole('button', { name: 'Connect' })).toBeVisible();
  });
});
