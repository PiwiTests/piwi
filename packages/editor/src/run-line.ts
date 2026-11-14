import { RUN_STOP_WORDS, type RunLine, type RunLineState, type RunSession, type RunStop } from './protocol.js';

/** The longest call the line names before it cuts it, in characters. */
const CALL_MAX = 60;

/**
 * How far runs are, as both clients word it wherever they count one: `3 of 9 · 1 failed · 1 flaky · 1 ended at a
 * stop`, an outcome named only when some test has it.
 */
export function countWords(done: number, total: number, failed = 0, flaky = 0, endedAtStop = 0): string {
  return [
    `${done} of ${total}`,
    failed ? `${failed} failed` : '',
    flaky ? `${flaky} flaky` : '',
    endedAtStop ? `${endedAtStop} ended at a stop` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Why a stop's test stands there, as the line says it: `held at its failure`, `paused by the agent`. */
function stopWhy(stop: RunStop): string {
  const words =
    stop.reason === 'failure'
      ? RUN_STOP_WORDS.failure
      : stop.by === 'agent'
        ? 'Paused by the agent'
        : (RUN_STOP_WORDS[stop.reason] ?? RUN_STOP_WORDS.other);
  return words.charAt(0).toLowerCase() + words.slice(1);
}

/** A stop's place: its file's name and its 1-based line, `checkout.page.ts:12`. */
function stopPlace(stop: RunStop): string {
  const name = decodeURIComponent(stop.uri.slice(stop.uri.lastIndexOf('/') + 1));
  return `${name}:${stop.line + 1}`;
}

function clipped(title: string): string {
  return title.length <= CALL_MAX ? title : `${title.slice(0, CALL_MAX - 1).trimEnd()}…`;
}

function views(count: number): string {
  return count === 1 ? '1 view' : `${count} views`;
}

/**
 * The one line both clients' status items show of the runs the editor follows (`piwi/runLineChanged`), else null:
 * where a test stands stopped, or the call a pausing test waits in, then the share, then how far the runs are, with the
 * state its glyph shows and how many stops wait for the person (`RunStop.calls`), the item's badge until answered.
 * `Piwi: held at its failure · checkout.page.ts:12 · shared live · 2 views · run #78 · 3 of 9 · 1 failed`.
 */
export function runLine(sessions: readonly RunSession[], sharingWindow: boolean): RunLine | null {
  const workers = sessions.flatMap((s) => s.workers);
  const stops = workers.flatMap((w) => (w.state === 'stopped' && w.stop ? [w.stop] : []));
  const pausing = workers.filter((w) => w.state !== 'stopped' && w.pausing);
  const shared = sessions.filter((s) => s.live?.shared);
  const viewers = shared.reduce((sum, s) => sum + (s.live?.viewers ?? 0), 0);
  const told = sessions.filter((s) => s.progress);
  const parts: string[] = [];
  let since: string | null = null;
  if (stops.length === 1) parts.push(`${stopWhy(stops[0]!)} · ${stopPlace(stops[0]!)}`);
  else if (stops.length > 1) parts.push(`${stops.length} tests stopped`);
  else if (pausing.length) {
    const waiting = pausing.find((w) => w.waiting)?.waiting;
    parts.push(waiting ? `pausing… · waits in ${clipped(waiting.title)}` : 'pausing…');
    since = waiting?.since ?? null;
  }
  if (sharingWindow) parts.push(`each run shared live${viewers ? ` · ${views(viewers)}` : ''}`);
  else if (shared.length) parts.push(`shared live${viewers ? ` · ${views(viewers)}` : ''}`);
  if (told.length) {
    const progress = told.map((s) => s.progress!);
    const sum = (count: (p: (typeof progress)[number]) => number) => progress.reduce((n, p) => n + count(p), 0);
    const one = told.length === 1 ? told[0]! : null;
    const page = one?.page && one.page.id > 0 ? one.page : null;
    parts.push(
      `${page ? `run #${page.id} · ` : ''}${countWords(
        sum((p) => p.done),
        sum((p) => p.total),
        sum((p) => p.failed),
        sum((p) => p.flaky),
        sum((p) => p.endedAtStop ?? 0),
      )}${one?.label ? ` · ${one.label}` : ''}`,
    );
  }
  if (!parts.length) return null;
  const state: RunLineState = stops.length
    ? stops.every((s) => s.reason === 'failure')
      ? 'held'
      : 'stopped'
    : pausing.length
      ? 'pausing'
      : sharingWindow || shared.length
        ? 'live'
        : told.some((s) => s.progress!.status === 'running')
          ? 'running'
          : told.some((s) => s.progress!.failed > 0 || ['failed', 'timedout'].includes(s.progress!.status))
            ? 'failed'
            : told.every((s) => s.progress!.status === 'passed')
              ? 'passed'
              : 'interrupted';
  return {
    text: `Piwi: ${parts.join(' · ')}`,
    state,
    calls: stops.filter((s) => s.calls).length,
    ...(since ? { since } : {}),
  };
}
