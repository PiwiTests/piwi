import { describe, expect, it } from 'vitest';
import { ciLiveViewNote } from '../src/internal/streaming/live-view-note';

describe('the line a CI run without a live view prints', () => {
  it('names what turns the view on for each reason', () => {
    expect(ciLiveViewNote('off')).toMatch(/^Live view off: .*Project → Settings → Live view/);
    expect(ciLiveViewNote('unregistered')).toMatch(/^Live view unavailable: .*global setup did not register this run.*wrapConfig/);
    expect(ciLiveViewNote('streaming-off')).toMatch(/^Live view unavailable: .*streaming: false/);
  });

  it('names the error the instance answered the global setup with, and blames no wrapConfig for it', () => {
    const note = ciLiveViewNote('setup-failed', 'Request failed with status 503: Service Unavailable');
    expect(note).toMatch(
      /^Live view unavailable: the instance did not register this run as it started \(Request failed with status 503: Service Unavailable\), /,
    );
    expect(note).not.toContain('wrapConfig');
    expect(ciLiveViewNote('setup-failed')).toMatch(/^Live view unavailable: the instance did not register this run as it started, /);
  });
});
