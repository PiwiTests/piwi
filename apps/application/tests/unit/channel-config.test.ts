import { describe, expect, test } from 'vitest';
import { channelConfigFor } from '../../server/utils/channels';

describe('channelConfigFor', () => {
  const config = {
    url: 'https://hooks.example.com/services/T0/abc123?token=s3cret',
    secret: 'enc',
    events: ['run.failed'],
  };

  test('shows a webhook URL in full to the channel owner and to administrators, never the secret', () => {
    expect(channelConfigFor(config, { ownsChannel: true, isAdmin: false })).toEqual({
      url: config.url,
      events: ['run.failed'],
    });
    expect(channelConfigFor(config, { ownsChannel: false, isAdmin: true }).url).toBe(config.url);
  });

  test('shows anyone else the origin of a webhook URL', () => {
    expect(channelConfigFor(config, { ownsChannel: false, isAdmin: false })).toEqual({
      url: 'https://hooks.example.com/…',
      events: ['run.failed'],
    });
    expect(channelConfigFor({ url: 'https://hooks.example.com' }, { ownsChannel: false, isAdmin: false }).url).toBe(
      'https://hooks.example.com',
    );
    expect(channelConfigFor({ url: 'not a url' }, { ownsChannel: false, isAdmin: false }).url).toBeNull();
  });

  test('leaves an email address and a channel without a URL as they are', () => {
    expect(channelConfigFor({ address: 'qa@example.com' }, { ownsChannel: false, isAdmin: false })).toEqual({
      address: 'qa@example.com',
    });
  });
});
