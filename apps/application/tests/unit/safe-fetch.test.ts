import { describe, test, expect } from 'vitest';
import { isBlockedAddress, assertPublicHttpUrl } from '../../server/utils/safe-fetch';

describe('isBlockedAddress', () => {
  test('blocks private / loopback / link-local / reserved addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '198.18.0.1', // benchmarking
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback (dotted)
      '::ffff:7f00:1', // IPv4-mapped loopback (hex hextets) — 127.0.0.1
      '::ffff:a9fe:a9fe', // IPv4-mapped 169.254.169.254 metadata (hex)
      '::ffff:0a00:1', // IPv4-mapped 10.0.0.1 (hex)
      'not-an-ip',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  test('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '::ffff:8.8.8.8']) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  test('blocks the whole of fe80::/10 as link-local', () => {
    for (const ip of ['fe80::1', 'fe81::1', 'fe9a::1', 'feab:cd::1', 'febf:ffff::1', 'FEBF::1', 'fe80::1%eth0']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress('fe7f::1')).toBe(false);
  });

  test('blocks unique local, site-local and multicast IPv6', () => {
    for (const ip of ['fc00::1', 'fdff:1234::1', 'fec0::1', 'feff::1', 'ff02::1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress('fc::1'), 'fc::1 is 00fc::1, outside fc00::/7').toBe(false);
  });

  test('judges IPv4-compatible and IPv4-mapped addresses by their IPv4 address', () => {
    for (const ip of [
      '::127.0.0.1',
      '::7f00:1',
      '::a00:1', // 10.0.0.1
      '::a9fe:a9fe', // 169.254.169.254
      '::ffff:7f00:1',
      '::ffff:0:0:1', // 0.0.0.1 ("this network")
      '0:0:0:0:0:ffff:c0a8:101', // 192.168.1.1
      '::ffff:0:7f00:1', // IPv4-translated 127.0.0.1
      '::ffff:0:10.1.2.3',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['::808:808', '::8.8.8.8', '::ffff:808:808', '::ffff:0:8.8.8.8']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  test('judges NAT64 addresses by their IPv4 address', () => {
    for (const ip of ['64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::c0a8:101']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress('64:ff9b::808:808')).toBe(false);
    expect(isBlockedAddress('64:ff9b::8.8.8.8')).toBe(false);
  });

  test('blocks the local-use NAT64 prefix, whose IPv4 address the network places', () => {
    for (const ip of ['64:ff9b:1::7f00:1', '64:ff9b:1:a00::1', '64:ff9b:1::808:808', '64:ff9b:1:ffff::1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  test('judges 6to4 addresses by their IPv4 address', () => {
    for (const ip of ['2002:7f00:1::1', '2002:a00:1::', '2002:a9fe:a9fe::1', '2002:c0a8:101:1::1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress('2002:808:808::1')).toBe(false);
  });

  test('allows public IPv6 addresses', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4007:80c::200e']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe('assertPublicHttpUrl', () => {
  test('rejects non-http(s), localhost, and private literals', async () => {
    await expect(assertPublicHttpUrl('ftp://example.com')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://localhost/x')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://127.0.0.1/x')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://[::1]/x')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://[::127.0.0.1]/x')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://[64:ff9b::169.254.169.254]/latest/meta-data')).rejects.toThrow();
    await expect(assertPublicHttpUrl('http://[fe90::1]/x')).rejects.toThrow();
  });

  test('accepts a public literal IP without a DNS lookup', async () => {
    const url = await assertPublicHttpUrl('https://8.8.8.8/path');
    expect(url.hostname).toBe('8.8.8.8');
  });
});
