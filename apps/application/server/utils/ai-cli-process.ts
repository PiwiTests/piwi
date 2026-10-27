import { spawn } from 'node:child_process';
import { cliCommand } from './ai-claude-cli';

export interface CliProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runCliProcess(
  binary: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    input?: string;
    onLine?: (line: string) => void;
    signal?: AbortSignal;
  },
): Promise<CliProcessResult> {
  const command = cliCommand(binary, args);
  return new Promise<CliProcessResult>((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // Probes retain stdout; generations consume JSONL without retaining a second copy.
      if (!opts.onLine) stdout = (stdout + chunk).slice(-1_000_000);
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) opts.onLine?.(line);
      if (buffer.length > 4_000_000) child.kill('SIGKILL');
    });
    const abort = () => child.kill('SIGKILL');
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener('abort', abort, { once: true });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-1_000_000);
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (buffer) opts.onLine?.(buffer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(opts.input);
  });
}
