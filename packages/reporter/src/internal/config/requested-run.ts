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
  if ('untrusted' in read || readableByOthers(read.mode)) {
    return { problem: `The request token file in ${REQUEST_RUN_ENV.tokenFile} is not this user's alone.` };
  }
  const token = read.text.trim();
  if (!REQUEST_TOKEN.test(token)) {
    return { problem: `The file in ${REQUEST_RUN_ENV.tokenFile} holds no request token.` };
  }
  return { instance: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, token };
}

/**
 * Whether another user may read the file opened with `mode`: a request token is this user's alone, to read as to
 * write. Unix only: on Windows the mode bits say nothing, and the private temp folder's access list guards the file.
 */
function readableByOthers(mode: number): boolean {
  if (typeof process.getuid !== 'function') return false;
  return (mode & 0o044) !== 0;
}

/** Whether `env` names a requested run at all, one this reporter can take or not. */
export function namesRequestedRun(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[REQUEST_RUN_ENV.tokenFile] || env[REQUEST_RUN_ENV.instance]);
}

/**
 * The worker environment of a requested run, written over what the config bridged: AI steps replay only, code reach,
 * coverage and environment snapshots stay off, and no worker holds the config's server or credentials, which the
 * request does not reach.
 */
export function applyRequestedRunEnv(env: NodeJS.ProcessEnv): void {
  env.PIWI_AI = 'replay';
  env.PIWI_AI_UPDATE = 'false';
  env.PIWI_CAPTURE_CODE_REACH = 'false';
  env.PIWI_COVERAGE_BROWSER = 'off';
  env.PIWI_COVERAGE_SERVER = 'off';
  env.PIWI_COVERAGE_CSS = 'off';
  env.PIWI_COLLECT_ENVIRONMENT_INFO = 'false';
  delete env.PIWI_DASHBOARD_URL;
  delete env.PIWI_API_KEY;
  delete env.PIWI_USERNAME;
  delete env.PIWI_PASSWORD;
}
