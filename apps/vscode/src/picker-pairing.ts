/**
 * The **Piwi Picker** view's pure half: what it shows of the pairing with Piwi Picker (the requests waiting for the
 * person's answer, the pairing kept, when Piwi Picker was last heard from, the port this window listens on), and the
 * words of the request's notification. Tested without an editor; `picker-view.ts` draws it.
 */
import { VSCODE_PAIRING_PORTS, type EditorPairingRequestView } from '@piwitests/core/editor-pairing';
import { relativeTime } from './glue';

/** Global state: the pairing Piwi Picker was given, by code (`client` names its browser) or by address (`client` null). */
export const PICKER_PAIRED_KEY = 'piwi.pickerPaired';
/** Global state: when a request the token let through last came from a browser extension. */
export const PICKER_HEARD_KEY = 'piwi.pickerHeard';
/** How often the time Piwi Picker was last heard from is written: once a minute at most. */
export const PICKER_HEARD_EVERY_MS = 60_000;

export interface PickerPaired {
  /** When it was paired, in milliseconds. */
  at: number;
  /** "Chrome on macOS" for a pairing by code; null for one by address. */
  client: string | null;
}

/** The pairing kept in global state; null for anything else. */
export function readPickerPaired(value: unknown): PickerPaired | null {
  const v = value as Partial<PickerPaired> | null | undefined;
  if (!v || typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
  return { at: v.at, client: typeof v.client === 'string' && v.client ? v.client : null };
}

/** Whether the time Piwi Picker was last heard from is old enough to be written again. */
export function heardAgain(last: number | undefined, now: number): boolean {
  return last === undefined || now - last >= PICKER_HEARD_EVERY_MS;
}

export interface PickerViewState {
  /** The requests waiting for the person's answer in this window. */
  waiting: readonly EditorPairingRequestView[];
  /** The pairing kept; null before one, and after Unpair. */
  paired: PickerPaired | null;
  /** When Piwi Picker was last heard from; null before. */
  heard: number | null;
  /** The port this window listens on for Piwi Picker; null while it listens on none. */
  port: number | null;
  /** The port the pairing is saved on, which another window may hold. */
  savedPort: number | null;
}

/** What the view shows: the welcome of a window not paired, or its rows. */
export type PickerViewKind = 'unpaired' | 'paired';

export function pickerViewKind(state: PickerViewState): PickerViewKind {
  return state.waiting.length || state.paired || state.heard !== null ? 'paired' : 'unpaired';
}

export interface PickerRow {
  key: string;
  label: string;
  description: string;
  tooltip: string;
  /** A codicon's name. */
  icon: string;
  /** `piwi.pairingRequest` for a request waiting, whose menu allows or denies it. */
  contextValue?: string;
  /** The request a row stands for. */
  requestId?: string;
}

/** The date a pairing was made, as the view writes it: `Nov 19` this year, `Nov 19, 2025` another. */
function day(at: number, now: number): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Where this window listens, and whether Piwi Picker finds it there by itself. */
function listeningRow(state: PickerViewState): PickerRow {
  if (state.port === null) {
    return {
      key: 'listening',
      label: state.savedPort ? `Another window listens on 127.0.0.1:${state.savedPort}` : 'Not listening',
      description: '',
      tooltip: state.savedPort
        ? 'Another window of this editor holds the pairing’s port; it takes Piwi Picker’s requests while it is open.'
        : 'No port of this editor is free for Piwi Picker. Copy the pairing address to pair by hand.',
      icon: 'circle-slash',
    };
  }
  const found = VSCODE_PAIRING_PORTS.includes(state.port);
  return {
    key: 'listening',
    label: `Listening on 127.0.0.1:${state.port}`,
    description: found ? '' : 'not where Piwi Picker looks',
    tooltip: found
      ? 'Piwi Picker finds this editor here when you click Pair in its settings.'
      : 'Piwi Picker looks for VS Code on ports 7247 to 7251; this window kept the port of an earlier pairing. Copy the pairing address to pair by hand, or Unpair to move to a port Piwi Picker finds.',
    icon: 'radio-tower',
  };
}

/** The view's rows: the requests waiting first, then the pairing, when it was last heard from, and the port. */
export function pickerRows(state: PickerViewState, now: number): PickerRow[] {
  const rows: PickerRow[] = state.waiting.map((request) => ({
    key: `request:${request.id}`,
    label: `${request.client} asks to pair`,
    description: `code ${request.code}`,
    tooltip: `Allow it only if Piwi Picker shows the code ${request.code}. It waits until ${new Date(request.expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`,
    icon: 'bell-dot',
    contextValue: 'piwi.pairingRequest',
    requestId: request.id,
  }));
  if (pickerViewKind(state) === 'unpaired') return rows;
  if (state.paired || state.heard !== null) {
    const paired = state.paired;
    rows.push({
      key: 'paired',
      label: paired?.client ? `Paired with Piwi Picker in ${paired.client}` : 'Paired with Piwi Picker',
      description: paired ? `since ${day(paired.at, now)}` : '',
      tooltip: paired?.client
        ? 'Paired by code. Unpair gives this editor a new token: Piwi Picker reaches it again only once paired again.'
        : 'Paired with the pairing address. Unpair gives this editor a new token: Piwi Picker reaches it again only once paired again.',
      icon: 'pass',
    });
    rows.push({
      key: 'heard',
      label:
        state.heard === null
          ? 'Not heard from yet'
          : `Last heard ${relativeTime(new Date(state.heard).toISOString(), now)}`,
      description: '',
      tooltip:
        'When Piwi Picker last sent a locator or asked for the runs with the pairing’s token. It asks for the runs while its Runs window is open.',
      icon: 'pulse',
    });
  }
  rows.push(listeningRow(state));
  return rows;
}

/** The notification of a request: who asks, and the code to compare with Piwi Picker's. */
export function pairingPrompt(request: Pick<EditorPairingRequestView, 'client' | 'code'>): string {
  return `Piwi Picker in ${request.client} asks to pair with this editor, to send it the locators you pick and follow its runs. Allow it only if Piwi Picker shows the code ${request.code}.`;
}
