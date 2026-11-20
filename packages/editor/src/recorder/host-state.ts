/**
 * The launcher's half of the recorder's binding: the storage areas the IDE bundle's `chrome` surface reads and
 * writes, and the answers to the recorder's messages. Session storage is absent from that surface, so the recorder
 * reads and writes the recording through messages (`piwi-session-storage`) and appends each event in one message
 * (`piwi-append-recording-event`), which this host answers from the areas it holds. Only the main frame of the page
 * the recording opened records: a call from any other frame or page is answered as outside a recording
 * (`handleOutside`). Pure: the launcher passes it each call of the binding.
 */
import { IDE_PAUSED_MESSAGE, IDE_SETTINGS_KEY, type IdeRecorderSettings } from '@piwitests/core/ide-recorder';
import { parseCaptureEvent, type RawCaptureEvent } from '@piwitests/core/recording';

/** `chrome.storage.local`'s key for the recorder's language and its catalog. */
export const LANGUAGE_KEY = 'piwiLanguage';

/** The session area's key for the recording: its events and whether it is on. */
export const RECORDING_KEY = 'piwiRecording';

const UNAVAILABLE = 'Not available in a recording started from the editor.';

const OUTSIDE = 'Only the page the recording opened is recorded.';

/** The most events one recording passes on: a page calling the binding in a loop cannot grow it without end. */
export const MAX_EVENTS = 5_000;

/** The recording, as the recorder stores it. */
export interface HostRecording {
  active: boolean;
  events: RawCaptureEvent[];
  startedAt: number | null;
  grantedOriginPattern: string | null;
  /** Paused from the recorder's bar or the editor: no event is appended until it resumes. */
  paused: boolean;
}

export interface RecorderHostOptions {
  /** The recorder's language and its catalog, merged over English. */
  language: { code: string; messages: Record<string, unknown> };
  settings: IdeRecorderSettings;
  /** When the recording started, in ms. */
  startedAt: number;
  /** An event the recording appended. */
  onEvent(event: RawCaptureEvent): void;
  /** The person pressed Stop in the browser. */
  onStopped(): void;
  /** The person pressed Pause or Resume in the browser. */
  onPaused(paused: boolean): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keyList(keys: unknown): string[] {
  if (typeof keys === 'string') return [keys];
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
}

export class RecorderHost {
  /** `chrome.storage.local`, seeded with the recorder's language and settings. */
  readonly local: Record<string, unknown>;
  /** The session area, holding the recording. */
  readonly session: Record<string, unknown>;
  /** How many events were passed on, whatever the page wrote into the session area since. */
  private passedOn = 0;

  constructor(private readonly options: RecorderHostOptions) {
    this.local = { [LANGUAGE_KEY]: options.language, [IDE_SETTINGS_KEY]: options.settings };
    const recording: HostRecording = {
      active: true,
      events: [],
      startedAt: options.startedAt,
      grantedOriginPattern: null,
      paused: false,
    };
    this.session = { [RECORDING_KEY]: recording };
  }

  /** The answer to one call of the binding (an `IdeRecorderRequest`, as the page sent it). Never throws. */
  handle(request: unknown): unknown {
    try {
      if (!isRecord(request)) return null;
      switch (request.kind) {
        case 'local-get':
          return this.localGet(request.keys);
        case 'local-set':
          if (isRecord(request.items)) Object.assign(this.local, request.items);
          return null;
        case 'local-remove':
          for (const key of keyList(request.keys)) delete this.local[key];
          return null;
        case 'message':
          return this.message(request.message);
        default:
          return null;
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The answer to a call from a frame or a page outside the recording, as outside a recording: `chrome.storage.local`
   * reads but no writes, an empty session area that takes no writes (no recording, so the recorder stays inert), no
   * event appended and no Stop passed on. Never throws.
   */
  handleOutside(request: unknown): unknown {
    try {
      if (!isRecord(request)) return null;
      if (request.kind === 'local-get') return this.localGet(request.keys);
      if (request.kind !== 'message') return null;
      const message = request.message;
      if (!isRecord(message)) return { ok: false, error: UNAVAILABLE };
      switch (message.type) {
        case 'piwi-ping':
          return { ok: true };
        case 'piwi-session-storage':
          return message.op === 'get' ? { ok: true, items: {} } : { ok: true };
        case 'piwi-append-recording-event':
        case 'piwi-recording-stopped':
        case IDE_PAUSED_MESSAGE:
          return { ok: false, error: OUTSIDE };
        case 'piwi-tab-zoom':
          return { zoom: 1 };
        default:
          return { ok: false, error: UNAVAILABLE };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The recording as stored; a stored value that is not one reads as a recording that is off. */
  recording(): HostRecording {
    const stored = this.session[RECORDING_KEY];
    if (isRecord(stored) && Array.isArray(stored.events)) return stored as unknown as HostRecording;
    return { active: false, events: [], startedAt: null, grantedOriginPattern: null, paused: false };
  }

  /** Pauses or resumes the recording, as the editor asks: the recorder reads it on every page it records. */
  setPaused(paused: boolean): void {
    const state = this.recording();
    if (state.active) state.paused = paused;
  }

  /** `chrome.storage.local.get`: every item for null, the items present for a key or keys, defaults for an object. */
  private localGet(keys: unknown): Record<string, unknown> {
    if (keys == null) return { ...this.local };
    if (isRecord(keys)) {
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [key, key in this.local ? this.local[key] : fallback]),
      );
    }
    return Object.fromEntries(
      keyList(keys)
        .filter((key) => key in this.local)
        .map((key) => [key, this.local[key]]),
    );
  }

  private message(message: unknown): unknown {
    if (!isRecord(message)) return { ok: false, error: UNAVAILABLE };
    switch (message.type) {
      case 'piwi-ping':
        return { ok: true };
      case 'piwi-session-storage':
        return this.sessionStorage(message);
      case 'piwi-append-recording-event':
        return this.append(message.event);
      case 'piwi-recording-stopped':
        this.options.onStopped();
        return { ok: true };
      case IDE_PAUSED_MESSAGE:
        if (typeof message.paused !== 'boolean') return { ok: false, error: 'Malformed pause request.' };
        this.setPaused(message.paused);
        this.options.onPaused(message.paused);
        return { ok: true };
      case 'piwi-tab-zoom':
        return { zoom: 1 };
      default:
        return { ok: false, error: UNAVAILABLE };
    }
  }

  private sessionStorage(request: Record<string, unknown>): unknown {
    const { op, key, items } = request;
    if (op === 'get' && typeof key === 'string') {
      return { ok: true, items: key in this.session ? { [key]: this.session[key] } : {} };
    }
    if (op === 'set' && isRecord(items)) {
      Object.assign(this.session, items);
      return { ok: true };
    }
    if (op === 'remove' && typeof key === 'string') {
      delete this.session[key];
      return { ok: true };
    }
    return { ok: false, error: 'Malformed session-storage request.' };
  }

  /**
   * Appends an event that parses while the recording is on and not paused, up to {@link MAX_EVENTS}, and answers with
   * the recording as it is then.
   */
  private append(value: unknown): unknown {
    const event = parseCaptureEvent(value);
    if (!event) return { ok: false, error: 'Malformed recording event.' };
    const state = this.recording();
    if (state.active !== true || state.paused === true) return { ok: true, state };
    if (this.passedOn >= MAX_EVENTS) return { ok: false, error: 'The recording is full: stop it to keep its steps.' };
    this.passedOn++;
    state.events.push(event);
    this.options.onEvent(event);
    return { ok: true, state };
  }
}
