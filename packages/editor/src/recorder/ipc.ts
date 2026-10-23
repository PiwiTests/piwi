/**
 * The messages between the editor service and the launcher, the child process it forks for each recording session
 * (`child_process.fork`, over its IPC channel).
 */
import type { IdeRecorderSettings } from '@piwitests/core/ide-recorder';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import type { BrowserName } from './context-options.js';

/** What the launcher opens, and what it hands the recorder. */
export interface LaunchRequest {
  /** The folder of the Playwright config: where the project's Playwright is resolved from. */
  cwd: string;
  browserName: BrowserName;
  launchOptions: Record<string, unknown>;
  contextOptions: Record<string, unknown>;
  testIdAttribute: string | null;
  /** The page the browser opens first: an absolute URL, or `about:blank`. */
  startUrl: string;
  /** The recorder's IDE bundle, `record-ide.js`, loaded into every page. */
  bundle: string;
  /** The recorder's language and its catalog, merged over English: `chrome.storage.local`'s `piwiLanguage`. */
  language: { code: string; messages: Record<string, unknown> };
  settings: IdeRecorderSettings;
  /** When the recording started, in ms: the recording state's `startedAt`. */
  startedAt: number;
}

export type ServiceToLauncher =
  | { type: 'start'; request: LaunchRequest }
  /** The editor paused or resumed the recording. */
  | { type: 'pause'; paused: boolean }
  | { type: 'stop' };

/** Why the launcher could not record. */
export type LaunchFailure = 'playwright-missing' | 'browser-missing' | 'launch-failed' | 'crashed';

export type LauncherToService =
  /** The browser is open on its first page. */
  | { type: 'started' }
  /** The recorder captured an event, checked field by field. */
  | { type: 'event'; event: RawCaptureEvent }
  /**
   * Something the person should know that does not end the recording: the start page did not load, the application
   * opened a tab or a popup, where nothing is recorded.
   */
  | { type: 'notice'; message: string }
  /** The person pressed Stop in the browser. */
  | { type: 'stopped-in-browser' }
  /** The person pressed Pause or Resume in the browser. */
  | { type: 'paused'; paused: boolean }
  /** The person closed the browser. */
  | { type: 'closed' }
  | { type: 'failed'; reason: LaunchFailure; message: string };
