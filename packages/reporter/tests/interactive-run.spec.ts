import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaywrightTestConfig } from '@playwright/test';
import { formatEditorDiscovery, type EditorDiscovery } from '@piwitests/core/editor-discovery';
import { formatRecordChannel } from '@piwitests/core/ide-recorder';
import { runChannelRef, runInteractive, type FollowedHub } from '../src/internal/config/hub.js';
import { detectCi } from '../src/internal/support/ci.js';
import { getSetupFilePath } from '../src/internal/support/setup-file.js';
import { wrapConfig } from '../src/public/config-wrapper.js';
import { createGlobalSetup } from '../src/public/global-setup.js';
import type { PiwiDashboardOptions } from '../src/public/options.js';
import { PiwiDashboardReporter } from '../src/public/reporter.js';
import { fakeConfig, fakeSuite, jsonRes, startServer, type FakeServer } from './_helpers.js';

/**
 * A run says at `/begin` that a hub steers it (`piwiInteractive` in its metadata) exactly when its workers connect to
 * one: a run an editor or the desktop app started on its run channel, and a run started in a terminal that follows the
 * editor whose workspace holds it. A run that follows no hub says nothing.
 */

const CHANNEL = formatRecordChannel({
  path: path.join(os.tmpdir(), 'piwi-hub.sock'),
  token: 'interactive-token-0123456789',
});

/** The editor a terminal's run follows, as `followHub` finds it. */
function followed(client: string | null): FollowedHub {
  const name = client ?? 'the editor';
  return { kind: 'editor', pid: 1, name, client: client ?? 'editor', ref: 'terminal-41-1730000000000', attended: true };
}

describe('the hub a run follows', () => {
  it('is the run channel its workers connect to, under the name they give it there', () => {
    expect(runChannelRef({})).toBeNull();
    expect(runChannelRef({ PIWI_ORIGIN_REF: 'ed-1' })).toBeNull();
    expect(runChannelRef({ PIWI_RUN_CHANNEL: 'off', PIWI_ORIGIN_REF: 'ed-1' })).toBeNull();
    expect(runChannelRef({ PIWI_RUN_CHANNEL: CHANNEL })).toBeNull();
    expect(runChannelRef({ PIWI_RUN_CHANNEL: CHANNEL, PIWI_ORIGIN_REF: 'ed-1' })).toBe('ed-1');
    expect(runChannelRef({ PIWI_RUN_CHANNEL: CHANNEL, PIWI_ORIGIN_REF: '42', PIWI_RUN_REF: 'desktop-7' })).toBe(
      'desktop-7',
    );
    // A name no hub takes: the workers connect to none.
    expect(runChannelRef({ PIWI_RUN_CHANNEL: CHANNEL, PIWI_ORIGIN_REF: 'cluster/12' })).toBeNull();
    expect(runChannelRef({ PIWI_RUN_CHANNEL: CHANNEL, PIWI_RUN_REF: 'x'.repeat(65) })).toBeNull();
  });

  it('names the editor it follows, else the launcher the run names, and nothing for a run with no hub', () => {
    const editorRun = { PIWI_RUN_CHANNEL: CHANNEL, PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: 'ed-1' };
    expect(runInteractive(editorRun, null)).toEqual({ client: 'editor', ref: 'ed-1' });
    const desktopRun = { PIWI_RUN_CHANNEL: CHANNEL, PIWI_ORIGIN: 'desktop', PIWI_RUN_REF: 'desktop-7' };
    expect(runInteractive(desktopRun, null)).toEqual({ client: 'desktop', ref: 'desktop-7' });
    const terminalRun = { PIWI_RUN_CHANNEL: CHANNEL, PIWI_RUN_REF: 'terminal-41-1730000000000' };
    expect(runInteractive(terminalRun, followed('WebStorm'))).toEqual({
      client: 'WebStorm',
      ref: 'terminal-41-1730000000000',
    });
    expect(runInteractive(terminalRun, followed(null))).toEqual({ client: 'editor', ref: 'terminal-41-1730000000000' });
    // A run the desktop app's linked folder holds is the app's.
    const desktopHub: FollowedHub = { ...followed(null), kind: 'desktop', name: 'the desktop app', client: 'desktop' };
    expect(runInteractive(terminalRun, desktopHub)).toEqual({ client: 'desktop', ref: 'terminal-41-1730000000000' });
    expect(runInteractive(terminalRun, null)).toEqual({ client: null, ref: 'terminal-41-1730000000000' });
    expect(runInteractive({ PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: 'ed-1' }, null)).toBeNull();
    expect(runInteractive({ PIWI_ORIGIN: 'desktop', PIWI_RUN_REF: 'desktop-7' }, null)).toBeNull();
    // A run the desktop app starts unattended still takes a person's Pause from its window.
    const unattended = { PIWI_RUN_CHANNEL: CHANNEL, PIWI_ORIGIN: 'desktop', PIWI_RUN_REF: 'desktop-9-unattended' };
    expect(runInteractive(unattended, null)).toEqual({ client: 'desktop', ref: 'desktop-9-unattended' });
  });
});

describe('the metadata a run begins with', () => {
  const projectName = `piwi-interactive-${process.pid}`;
  let saved: NodeJS.ProcessEnv = {};
  let folder = '';
  let workspace = '';
  let server: FakeServer;
  let hub: net.Server | null = null;

  beforeEach(async () => {
    saved = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('PIWI_') || key === 'PWDEBUG' || detectCi({ [key]: process.env[key] }))
        delete process.env[key];
    }
    process.env.PIWI_DESKTOP_CONFIG = path.join(os.tmpdir(), 'piwi-no-desktop-app', 'desktop.json');
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-interactive-'));
    workspace = path.join(folder, 'workspace');
    fs.mkdirSync(workspace);
    server = await startServer((req, res) => {
      if (req.url === '/api/test-runs/setup') return jsonRes(res, 200, { runId: 7, setupToken: 'setup-tok' });
      if (req.url === '/api/test-runs/7/begin') return jsonRes(res, 200, { runId: 7, streamToken: 'stream-tok' });
      return jsonRes(res, 200, { success: true });
    });
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(getSetupFilePath(projectName), { force: true });
    await server.close();
    if (hub) await new Promise<void>((resolve) => hub!.close(() => resolve()));
    hub = null;
    fs.rmSync(folder, { recursive: true, force: true });
  });

  /** The metadata of the `/begin` a run sends with `env`, its global setup and its reporter run in this process. */
  async function beginMetadata(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
    Object.assign(process.env, env);
    const configFile = path.join(workspace, 'playwright.config.ts');
    const options: PiwiDashboardOptions = {
      serverUrl: server.url,
      apiKey: 'pd_interactive',
      projectName,
      uploadReport: false,
      uploadTraces: false,
      liveFileUploads: false,
      uploadManifest: false,
      sampleAriaOnPass: false,
      captureResources: false,
    };
    const config = wrapConfig<PlaywrightTestConfig>({}, options);
    await createGlobalSetup()({ configFile, reporter: config.reporter });
    new PiwiDashboardReporter({ ...options, configDir: workspace }).onBegin(fakeConfig({ configFile }), fakeSuite());
    const deadline = Date.now() + 5000;
    for (;;) {
      const request = server.requests.find((r) => r.url === '/api/test-runs/7/begin');
      if (request) return (JSON.parse(request.body) as { metadata: Record<string, unknown> }).metadata;
      if (Date.now() > deadline) throw new Error('no /begin');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('names no hub for a run that follows none', async () => {
    const metadata = await beginMetadata({});
    expect(metadata.piwiOrigin).toEqual({ kind: 'local' });
    expect(metadata).not.toHaveProperty('piwiInteractive');
  });

  it('names the editor and its ref for a run the editor started on its run channel', async () => {
    const metadata = await beginMetadata({
      PIWI_RUN_CHANNEL: CHANNEL,
      PIWI_ORIGIN: 'editor',
      PIWI_ORIGIN_REF: 'ed-5a1e',
    });
    expect(metadata.piwiOrigin).toEqual({ kind: 'editor', ref: 'ed-5a1e' });
    expect(metadata.piwiInteractive).toEqual({ client: 'editor', ref: 'ed-5a1e' });
  });

  it('names no hub for a run a launcher started without a run channel', async () => {
    const metadata = await beginMetadata({ PIWI_ORIGIN: 'desktop', PIWI_RUN_REF: 'desktop-3' });
    expect(metadata.piwiRunRef).toBe('desktop-3');
    expect(metadata).not.toHaveProperty('piwiInteractive');
  });

  it.skipIf(process.platform === 'win32')(
    'names the editor a terminal’s run follows, by its discovery file, under the run’s own ref',
    async () => {
      const editors = path.join(folder, 'editors');
      fs.mkdirSync(editors, { mode: 0o700 });
      const channels = fs.mkdtempSync(path.join(folder, 'channel-'));
      const socketPath = path.join(channels, 'channel.sock');
      hub = net.createServer((socket) => socket.destroy());
      await new Promise<void>((resolve) => hub!.listen(socketPath, resolve));
      const discovery: EditorDiscovery = {
        pid: process.pid,
        host: os.hostname(),
        version: '0.66.0',
        client: 'Test Editor',
        startedAt: new Date().toISOString(),
        roots: [workspace],
        hub: null,
        runChannel: { path: socketPath, token: 'interactive-token-0123456789' },
        recorderBundle: null,
      };
      fs.writeFileSync(path.join(editors, `${process.pid}.json`), formatEditorDiscovery(discovery), { mode: 0o600 });

      const metadata = await beginMetadata({ PIWI_EDITORS_DIR: editors, PIWI_EDITOR: 'on' });
      expect(metadata.piwiOrigin).toEqual({ kind: 'local' });
      expect(metadata.piwiInteractive).toEqual({
        client: 'Test Editor',
        ref: expect.stringMatching(/^terminal-\d+-\d+$/),
      });
      expect((metadata.piwiInteractive as { ref: string }).ref).toBe(process.env.PIWI_RUN_REF);
    },
  );
});
