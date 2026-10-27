import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Worker } from '@playwright/test';
import {
  EDITOR_CHALLENGE_HEADER,
  EDITOR_PROOF_HEADER,
  editorTokenProof,
  isEditorChallenge,
} from '@piwitests/core/editor-send';
import { liveHubsOf, type LiveHub } from '@piwitests/core/run-hub';
import {
  FakeWorker,
  service,
  waitFor,
  writeRunWorkspace,
  type Service,
} from '../../../../packages/editor/tests/run-fixtures.js';
import { extensionWorker, launchWithExtension } from './fixtures.js';

/**
 * The editor the Runs window follows: the real editor service, started in-process on a workspace folder as its own
 * tests start it, its hub and run channel included, and a local server standing in for the editor's Send to editor
 * endpoint, whose `GET /piwi/live` lists the service's hub as VS Code's listener does, and which answers a request
 * carrying a challenge with the proof that it holds the pairing's token. A run is a fake worker on the run channel its
 * command names (`FakeWorker`), played by the spec.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

export const PAIRING_TOKEN = 'pairing_token_0123456789';

export { FakeWorker, waitFor };

export interface Editor {
  dir: string;
  svc: Service;
  /** The editor's endpoint's origin, which also serves a plain page at `/`. */
  origin: string;
  hub: LiveHub;
  close(): Promise<void>;
}

/** Starts the editor service and its Send to editor endpoint. */
export async function startEditor(): Promise<Editor> {
  // A folder named as a project is: the window names a run after it.
  const dir = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'piwi-runs-'))), 'shop');
  writeRunWorkspace(dir);
  const svc = await service(dir, true);
  const published = await waitFor(() => svc.published[0] ?? undefined);
  const [hub] = liveHubsOf([published]);
  const server: Server = createServer(async (req, res) => {
    const challenge = req.headers[EDITOR_CHALLENGE_HEADER];
    if (isEditorChallenge(challenge)) {
      const port = (server.address() as AddressInfo).port;
      res.setHeader(EDITOR_PROOF_HEADER, await editorTokenProof(PAIRING_TOKEN, port, challenge));
    }
    if (req.url === '/piwi/live' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${PAIRING_TOKEN}`) {
        res.statusCode = 401;
        res.end('{"error":"not paired"}');
        return;
      }
      res.end(JSON.stringify({ hubs: [hub] }));
      return;
    }
    if (req.url === '/') {
      // A page of this machine, which must not reach the hub.
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>A page on 127.0.0.1</title><p>Hello</p>');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    dir,
    svc,
    origin,
    hub: hub!,
    close: async () => {
      svc.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(path.dirname(dir), { recursive: true, force: true });
    },
  };
}

/**
 * The extension, loaded with the grant of the editor's address the settings page requests in Pair's click, which a
 * test cannot make, and paired with the editor as an older version kept its pairing (the worker moves the token to
 * the secret area).
 */
export async function pairedExtension(
  editor: Editor,
  options: { deviceScaleFactor?: number } = {},
): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'piwi-picker-runs-'));
  cpSync(DIST, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [`${editor.origin}/*`];
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const context = await launchWithExtension(dir, options);
  const worker = await extensionWorker(context);
  await worker.evaluate(({ url, token }) => chrome.storage.local.set({ piwiEditorPairing: { url, token } }), {
    url: `${editor.origin}/piwi/send`,
    token: PAIRING_TOKEN,
  });
  return { context, worker, extensionId: worker.url().split('/')[2]! };
}

/** A run the editor built, with one worker on its run channel, running its test. */
export async function startRun(editor: Editor, title?: string): Promise<{ ref: string; worker: FakeWorker }> {
  const { ref, channel } = await editor.svc.command();
  const worker = new FakeWorker(channel.path, editor.dir).attach(channel.token, ref, 0);
  worker.begin(title);
  return { ref, worker };
}
