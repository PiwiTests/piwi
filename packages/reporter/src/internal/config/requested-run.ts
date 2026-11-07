import * as fs from 'node:fs';
import { REQUEST_RUN_ENV, REQUEST_TOKEN } from '@piwitests/core/run-request';
import { readPrivateFile } from '../support/private-file.js';

/** A run a team instance asked for: the instance to upload it to, and the request token that starts it there. */
export interface RequestedRun {
  instance: string;
  token: string;
}

/**
 * The run the target named in `env` (`REQUEST_RUN_ENV`): `null` when it named none, a problem when it named one this
 * reporter cannot take (an instance that is not an http(s) URL, a token file that is missing, not this user's alone,
 * or holds no request token). The file is the target's: read, never deleted.
 */
export function readRequestedRun(env: NodeJS.ProcessEnv): RequestedRun | { problem: string } | null {
  const file = env[REQUEST_RUN_ENV.tokenFile];
  const instance = env[REQUEST_RUN_ENV.instance];
  if (!file && !instance) return null;
  if (!file || !instance) {
    return { problem: `${REQUEST_RUN_ENV.tokenFile} and ${REQUEST_RUN_ENV.instance} are set together, or not at all.` };
  }
  let url: URL;
  try {
    url = new URL(instance);
  } catch {
    return { problem: `${REQUEST_RUN_ENV.instance} is not a URL.` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { problem: `${REQUEST_RUN_ENV.instance} is not an http or https URL.` };
  }
  let read: ReturnType<typeof readPrivateFile>;
  try {
    read = readPrivateFile(file);
  } catch {
    read = null;
  }
  if (!read) return { problem: `The request token file in ${REQUEST_RUN_ENV.tokenFile} cannot be read.` };
  if ('untrusted' in read || readableByOthers(file)) {
    return { problem: `The request token file in ${REQUEST_RUN_ENV.tokenFile} is not this user's alone.` };
  }
  const token = read.text.trim();
  if (!REQUEST_TOKEN.test(token)) {
    return { problem: `The file in ${REQUEST_RUN_ENV.tokenFile} holds no request token.` };
  }
  return { instance: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, token };
}

/** Whether another user may read `file`: a request token is this user's alone, to read as to write. */
function readableByOthers(file: string): boolean {
  if (typeof process.getuid !== 'function') return false;
  try {
    return (fs.statSync(file).mode & 0o044) !== 0;
  } catch {
    return true;
  }
}
