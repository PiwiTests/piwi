import { describe, expect, it } from 'vitest';
import { ciLiveViewNote } from '../src/internal/streaming/live-view-note';

describe('the line a CI run without a live view prints', () => {
  it('names what turns the view on for each reason', () => {
    expect(ciLiveViewNote('off')).toMatch(/^Live view off: .*Project → Settings → Live view/);
    expect(ciLiveViewNote('unregistered')).toMatch(/^Live view unavailable: .*global setup.*wrapConfig/);
    expect(ciLiveViewNote('streaming-off')).toMatch(/^Live view unavailable: .*streaming: false/);
  });
});
