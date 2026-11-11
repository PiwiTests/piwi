/**
 * What the window shows of **Run on my machine**, the app taking run requests from one team instance
 * (`./run-target.ts`). Never the instance's key nor a request token: the shell alone reads those. Types only, so the
 * window's code imports it with nothing of the server.
 */
import type { RunRequestOptions, RunRequestSource, RunRequestTest } from '@piwitests/core/run-request';

/** Where the connection to the team instance stands. */
export type RunTargetConnectionState =
  /** No instance connected. */
  | 'none'
  /** The device flow waits for the person to allow the app on the instance's page. */
  | 'signing-in'
  | 'connecting'
  | 'online'
  | 'offline'
  /** The instance revoked the app's key, or disconnected it. */
  | 'revoked';

export interface RunTargetConnectionView {
  state: RunTargetConnectionState;
  /** The instance's URL, or null with none. */
  instance: string | null;
  /** While signing in: the code the instance's page shows, and the page. */
  userCode: string | null;
  verificationUrl: string | null;
  /** Why the last connect failed, in words. */
  error: string | null;
  /** Whether the shell still has to keep the key the device flow gave in the keychain. */
  keyToKeep: boolean;
  /** The project ids of the instance with a folder linked on this machine. */
  linkedProjectIds: number[];
  /** The names the instance gave for its projects, by id; a project it did not name shows as its id. */
  projectNames: Record<number, string>;
}

/** One row of the confirmation, as `@piwitests/editor/request-run` checks it. */
export interface RunRequestCheckView {
  id: string;
  level: 'ok' | 'warn' | 'fail';
  message: string;
}

/** A run request the window asks the person about, after the app claimed it. */
export interface RunRequestPromptView {
  id: string;
  instance: string;
  projectId: number;
  /** The project's name on the instance, or null when it gave none. */
  projectName: string | null;
  tests: RunRequestTest[];
  options: RunRequestOptions;
  source: RunRequestSource;
  checks: RunRequestCheckView[];
  /** Whether **Run** may start it: no check failed. */
  runnable: boolean;
  /** The command it runs, as shown. */
  command: string;
  /** Whether a folder is linked to its project on this machine. */
  hasFolder: boolean;
  /** When the instance ends the request unanswered (ISO 8601). */
  answerBy: string;
}

/** What the desktop event stream says of **Run on my machine**. */
export type RunTargetMessage =
  | { type: 'run-target'; connection: RunTargetConnectionView }
  | { type: 'run-request'; request: RunRequestPromptView }
  | { type: 'run-request-gone'; id: string; reason: 'stopped' | 'answered' | 'expired' };
