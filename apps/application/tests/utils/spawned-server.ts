/**
 * A Piwi server a spec starts for itself, on its own port, database, storage
 * and build directory under `tempDir` (emptied first). CI runs the production
 * output it built; locally a dev server compiles on demand.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface SpawnedServer {
  baseUrl: string;
  /** Waits until `/api/health` answers, failing early when the process exits. */
  ready(timeoutMs: number): Promise<void>;
  /** Stops the process and waits for it to exit, so the next server can take the port. */
  stop(): Promise<void>;
}

export function startSpawnedServer(opts: {
  port: number;
  tempDir: string;
  env?: Record<string, string>;
}): SpawnedServer {
  const { port, tempDir } = opts;
  const baseUrl = `http://127.0.0.1:${port}`;
  const logPath = join(tempDir, 'server.log');
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(join(tempDir, 'storage'), { recursive: true });
  const [command, args] = process.env.CI
    ? ['node', ['.output/server/index.mjs']]
    : ['npx', ['nuxt', 'dev', '--port', String(port)]];
  const child: ChildProcess = spawn(command, args, {
    env: {
      ...process.env,
      NITRO_PORT: String(port),
      PORT: String(port),
      PIWI_DATABASE_PATH: join(tempDir, 'piwi.db'),
      PIWI_DATABASE_URL: '',
      PIWI_STORAGE_TYPE: 'local',
      PIWI_STORAGE_PATH: join(tempDir, 'storage'),
      PIWI_BUILD_DIR: join(tempDir, 'nuxt-build'),
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const log = createWriteStream(logPath);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  return {
    baseUrl,
    async ready(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`The server exited; see ${logPath}`);
        try {
          if ((await fetch(`${baseUrl}/api/health`)).ok) return;
        } catch {
          // Not listening yet.
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(`The server did not answer within ${timeoutMs / 1000} s; see ${logPath}`);
    },
    async stop() {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGTERM');
      } catch {
        return;
      }
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
    },
  };
}
