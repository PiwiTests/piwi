/**
 * A watched lane's layers beside its images (`@piwitests/core/live-layers`), as Piwi Picker's Runs window and the
 * desktop app's Local runs tray show them under the lane's page: why the call the test runs waits (`calls`), what its
 * page and its requests said (`events`), the page's text, taken as the person asks and followed after (`text`), and
 * the test's filmstrip (`filmstrip`). A surface asks for them at a hub whose features list `layers` (`laneLayersAsked`,
 * `watch`'s `layers`), keeps each lane's as they come (`takeLaneLayer`, a test's starting afresh) and says them through
 * its `RunSpeaker`, a time through its own `seconds`. Nothing here is stored: a surface keeps them in memory while it
 * watches the lane.
 */
import {
  LANE_LAYERS,
  MAX_FILMSTRIP,
  isLaneThumbData,
  type LaneLayer,
  type LaneText,
  type LaneThumb,
  type PageEvent,
} from '@piwitests/core/live-layers';
import type { LiveCallLog } from '@piwitests/core/live-view';
import type { LaneLayerData } from '@piwitests/core/run-channel';
import type { RunSpeaker } from './words';

/** The most events a lane's view lists, the newest first: the older ones go. */
export const MAX_LANE_EVENTS = 30;
/** The most lines of a call's log a lane's view shows, the latest. */
export const LANE_LOG_LINES = 6;

/** The layers a surface takes of a lane it watches: every one, the page's text once the person asked for it. */
export function laneLayersAsked(text: boolean): LaneLayer[] {
  return LANE_LAYERS.filter((layer) => layer !== 'text' || text);
}

/** An event of the lane's page, with when it came (`at`, epoch ms) and a key of its own for the surface's list. */
export interface LaneEventEntry {
  key: string;
  at: number;
  event: PageEvent;
}

/** An image of the test's filmstrip, and its JPEG in base64. */
export interface LaneFilmEntry {
  thumb: LaneThumb;
  data: string;
}

/** What a surface keeps of a lane's layers: those of the test `test` its worker `worker` runs or ran last. */
export interface LaneLayers {
  worker: number | null;
  test: string | null;
  /** The latest call the test is in, as Playwright logs it. */
  log: LiveCallLog | null;
  /** Newest first, `MAX_LANE_EVENTS` at most; a pending request is one entry, its time told again in place. */
  events: LaneEventEntry[];
  /** How many events came, which keys the next one. */
  heard: number;
  /** The page's text as it came last, or why none comes. */
  text: LaneText | null;
  textRefused: string | null;
  /** By their place in the strip, one image a call, the latest `MAX_FILMSTRIP`. */
  film: LaneFilmEntry[];
}

/** A lane's layers before any came. */
export function noLaneLayers(): LaneLayers {
  return { worker: null, test: null, log: null, events: [], heard: 0, text: null, textRefused: null, film: [] };
}

/** A layer as a surface hears it from its hub: the worker and the test it is of (null for a page no test shows). */
export type HeardLaneLayer = { worker: number; test: string | null } & LaneLayerData;

/**
 * The lane's layers with `heard` in them; the ones given are left as they were. A layer of another worker or test
 * starts afresh: what the surface kept was of the test before. A text of a page no test shows keeps the rest. An image
 * whose data is not a JPEG in base64 is left out, and an image of a call the strip holds takes its place.
 */
export function takeLaneLayer(layers: LaneLayers, heard: HeardLaneLayer): LaneLayers {
  const another = heard.test !== null && (heard.test !== layers.test || heard.worker !== layers.worker);
  const base: LaneLayers = another ? { ...noLaneLayers(), worker: heard.worker, test: heard.test } : layers;
  switch (heard.layer) {
    case 'calls':
      return { ...base, log: heard.log };
    case 'events':
      return takeEvent(base, heard.event, heard.at);
    case 'text':
      return 'refused' in heard
        ? { ...base, textRefused: heard.refused }
        : { ...base, text: heard.text, textRefused: null };
    case 'filmstrip': {
      if (!isLaneThumbData(heard.data)) return base;
      const film = [
        ...base.film.filter((entry) => entry.thumb.call !== heard.thumb.call),
        { thumb: heard.thumb, data: heard.data },
      ].sort((a, b) => a.thumb.index - b.thumb.index);
      return { ...base, film: film.slice(Math.max(0, film.length - MAX_FILMSTRIP)) };
    }
  }
}

function takeEvent(layers: LaneLayers, event: PageEvent, at: number): LaneLayers {
  if (event.kind === 'request-pending') {
    const key = `pending-${event.id}`;
    const index = layers.events.findIndex((entry) => entry.key === key);
    if (index >= 0) {
      return { ...layers, events: layers.events.map((entry, i) => (i === index ? { key, at, event } : entry)) };
    }
    return { ...layers, events: [{ key, at, event }, ...layers.events].slice(0, MAX_LANE_EVENTS) };
  }
  const heard = layers.heard + 1;
  const events = [{ key: `event-${heard}`, at, event }, ...layers.events].slice(0, MAX_LANE_EVENTS);
  return { ...layers, events, heard };
}

/** How a time is said: a number of seconds, in the surface's language (`12s`). */
export type SaySeconds = (seconds: number) => string;

const englishSecondsFormat = new Intl.NumberFormat('en', {
  style: 'unit',
  unit: 'second',
  unitDisplay: 'narrow',
  maximumFractionDigits: 1,
});

/** A number of seconds in English, as the Runs window says it in English (`12s`, `0.4s`). */
export const englishSeconds: SaySeconds = (seconds) => englishSecondsFormat.format(seconds);

/** A time in milliseconds as seconds, a tenth kept under ten seconds. */
function secondsOf(ms: number): number {
  return ms < 10_000 ? Math.round(ms / 100) / 10 : Math.round(ms / 1000);
}

/** How a call stands, by its log's status. */
export type CallTone = 'running' | 'passed' | 'failed';

/**
 * Why the lane's call waits, as a surface shows it: its title (the hub's, to render as the call's title), its place in
 * the test's code (`file:line`), how it stands and for how long, what its locator matches while it waits, the error it
 * ended with, and the latest lines of Playwright's log of it.
 */
export interface CallWait {
  title: string;
  place: string | null;
  tone: CallTone;
  state: string;
  target: string | null;
  error: string | null;
  lines: string[];
}

/** Why the call of `log` waits, in the surface's words. */
export function callWait(log: LiveCallLog, speaker: RunSpeaker, seconds: SaySeconds): CallWait {
  const time = seconds(secondsOf(log.ms));
  const state =
    log.status === 'running'
      ? speaker.say('runs_callRunning', { time })
      : speaker.say(log.status === 'passed' ? 'runs_callPassed' : 'runs_callFailed', { time });
  const { file, line } = log.call;
  return {
    title: log.call.title,
    place: file ? (line ? `${file}:${line}` : file) : null,
    tone: log.status,
    state,
    target: log.status === 'running' ? targetWords(log.target, speaker) : null,
    error: log.error,
    lines: log.lines.slice(-LANE_LOG_LINES),
  };
}

/** What a waiting call's locator matches, and whether its element is enabled; null when there is nothing to say. */
function targetWords(target: LiveCallLog['target'], speaker: RunSpeaker): string | null {
  if (!target) return null;
  if (target.count === 0) return speaker.say('runs_targetNone');
  const said = [speaker.count('runs_targetMatches', target.count)];
  if (target.enabled === false) said.push(speaker.say('runs_targetDisabled'));
  return said.join(' · ');
}

/** How an event reads at a glance: an error, a warning, a request still waiting, or news. */
export type EventTone = 'error' | 'warning' | 'waiting' | 'info';

/** An event of the lane's page in the surface's words: what it is, what it says, and how it reads at a glance. */
export interface LaneEventSaid {
  label: string;
  text: string;
  tone: EventTone;
}

/** An event of the lane's page, in the surface's words. */
export function laneEventSaid(event: PageEvent, speaker: RunSpeaker, seconds: SaySeconds): LaneEventSaid {
  switch (event.kind) {
    case 'console':
      return { label: speaker.say('runs_eventConsole'), text: event.text, tone: 'error' };
    case 'page-error':
      return { label: speaker.say('runs_eventPageError'), text: event.text, tone: 'error' };
    case 'request-failed':
      return {
        label: speaker.say('runs_eventFailed'),
        text: requestOutcome(`${event.method} ${event.url}`, event.status, event.failure, speaker),
        tone: 'error',
      };
    case 'request-pending': {
      const request = `${event.method} ${event.url}`;
      const time = seconds(secondsOf(event.ms));
      return event.done
        ? {
            label: speaker.say('runs_eventSlow'),
            text: speaker.say('runs_requestAnsweredAfter', { request, time }),
            tone: 'warning',
          }
        : {
            label: speaker.say('runs_eventPending'),
            text: speaker.say('runs_requestPending', { request, time }),
            tone: 'waiting',
          };
    }
    case 'backend':
      return {
        label: speaker.say(event.level === 'error' ? 'runs_eventBackendError' : 'runs_eventBackendWarning'),
        text: speaker.say('runs_requestLogged', { request: `${event.method} ${event.url}`, text: event.text }),
        tone: event.level,
      };
    case 'api': {
      const request = `${event.method} ${event.url}`;
      const answered = event.status !== null && event.status < 400;
      const text =
        event.status !== null
          ? speaker.say('runs_requestAnsweredIn', {
              request,
              status: String(event.status),
              time: seconds(secondsOf(event.ms)),
            })
          : requestOutcome(request, null, event.failure, speaker);
      return { label: speaker.say('runs_eventApi'), text, tone: answered ? 'info' : 'error' };
    }
    case 'dropped':
      return { label: speaker.count('runs_eventDropped', event.count), text: '', tone: 'info' };
  }
}

/** How a request ended without a good answer: the status it was answered with, else why it failed. */
function requestOutcome(request: string, status: number | null, failure: string | null, speaker: RunSpeaker): string {
  if (status !== null) return speaker.say('runs_requestAnswered', { request, status: String(status) });
  return failure
    ? speaker.say('runs_requestFailed', { request, failure })
    : speaker.say('runs_requestUnanswered', { request });
}

/** Where the page's text came from, in the surface's words, and whether it was cut. */
export function laneTextSource(text: LaneText, speaker: RunSpeaker): string {
  const source = speaker.say(text.source === 'trace' ? 'runs_textTrace' : 'runs_textSnapshot');
  return text.cut ? `${source} · ${speaker.say('runs_textCut')}` : source;
}
