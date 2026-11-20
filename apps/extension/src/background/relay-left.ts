import { readRelayedEntries } from '../shared/bug-relay.js';
import { appendBugEntries } from '../shared/bug-storage.js';
import { getRecordingState } from '../shared/recording-storage.js';
import { appendReplayEvidence, getReplayState } from '../shared/replay-storage.js';

/**
 * The worker's side of a page left with evidence its relay had not stored yet
 * (`storeAsPageLeaves`, `piwi-relay-left`): one message, which the worker
 * finishes whatever becomes of the page, where a read and a write of session
 * storage the page started would not. The entries are checked as relayed ones
 * are, and kept for the recording or the replay whose token they carry,
 * never for another.
 */
export async function handleRelayLeft(message: { token?: unknown; entries?: unknown }): Promise<{ ok: boolean }> {
  const token = typeof message.token === 'string' ? message.token : '';
  if (!token) return { ok: false };
  const entries = readRelayedEntries(message.entries);
  const recording = await getRecordingState();
  if (recording.active && recording.bugToken === token) {
    await appendBugEntries(entries);
    return { ok: true };
  }
  const replay = await getReplayState();
  if (replay?.evidenceToken === token) {
    await appendReplayEvidence(token, entries);
    return { ok: true };
  }
  return { ok: false };
}
