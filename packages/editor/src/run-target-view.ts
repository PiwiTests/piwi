/**
 * What the window shows of **Run on my machine**, the app taking run requests from one team instance
 * (`./run-target.ts`). Never the instance's key nor a request token: the shell alone reads those. Types and the English
 * sentence of an error's code only, so the window's code imports it with nothing of the server.
 */
import type { RunRequestOptions, RunRequestSource, RunRequestTest } from '@piwitests/core/run-request';
import type { RequestCheckArgs, RequestCheckCode } from './request-run';

/**
 * Why connecting to the team instance failed, in the app's own words: the instance disconnected it without a word
 * (`disconnected`), did not answer (`no-answer`), answered connect with an unexpected status (`answered-status`, its
 * `status`), the sign-in ran out of time (`sign-in-timed-out`) or the instance said it expired (`sign-in-expired`), or
 * it was denied there (`denied`).
 */
export type RunTargetErrorCode =
  | 'disconnected'
  | 'no-answer'
  | 'answered-status'
  | 'sign-in-timed-out'
  | 'sign-in-expired'
  | 'denied';

/** What an error of `code` says in English, with the values of `args`: what `RunTargetConnectionView.error` holds. */
export function runTargetErrorSentence(
  code: RunTargetErrorCode,
  args: Readonly<Record<string, string | number>> = {},
): string {
  switch (code) {
    case 'disconnected':
      return 'The instance disconnected this app.';
    case 'no-answer':
      return 'The instance did not answer.';
    case 'answered-status':
      return `The instance answered ${args.status ?? ''} to connect.`;
    case 'sign-in-timed-out':
      return 'The sign-in on the instance expired: connect again.';
    case 'sign-in-expired':
      return 'The sign-in expired.';
    case 'denied':
      return 'The connection was denied on the instance.';
  }
}

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
  /** Why the last connect failed, in English words. */
  error: string | null;
  /**
   * Why the last connect failed, as a code the window words in its language with `errorArgs`; null with no error, and
   * for one the instance or the network worded, which the window shows as `error` says it.
   */
  errorCode: RunTargetErrorCode | null;
  errorArgs: Readonly<Record<string, string | number>>;
  /** Whether the shell still has to keep the key the device flow gave in the keychain. */
  keyToKeep: boolean;
  /** The project ids of the instance with a folder linked on this machine. */
  linkedProjectIds: number[];
  /** The names the instance gave for its projects, by id; a project it did not name shows as its id. */
  projectNames: Record<number, string>;
}

/**
 * One row of the confirmation, as `@piwitests/editor/request-run` checks it: its code and the values it names, which
 * the window words in its language, and the same sentence in English (`message`).
 */
export interface RunRequestCheckView {
  id: string;
  level: 'ok' | 'warn' | 'fail';
  code: RequestCheckCode;
  args: RequestCheckArgs;
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
