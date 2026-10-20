import { describe, expect, it } from 'vitest';
import type { H3Event } from 'h3';
import { bearerToken } from '../../server/utils/bearer';

/** A request carrying just this Authorization header. */
function withAuthorization(value?: string): H3Event {
  const headers = value === undefined ? {} : { authorization: value };
  return { context: {}, node: { req: { headers }, res: {} } } as unknown as H3Event;
}

describe('bearerToken', () => {
  it('reads the token after the scheme, in any case, without the spaces around it', () => {
    expect(bearerToken(withAuthorization('Bearer pd_abc'))).toBe('pd_abc');
    expect(bearerToken(withAuthorization('bearer pd_abc'))).toBe('pd_abc');
    expect(bearerToken(withAuthorization('BEARER   pdo_xyz  '))).toBe('pdo_xyz');
  });

  it('is null without a bearer token', () => {
    expect(bearerToken(withAuthorization())).toBeNull();
    expect(bearerToken(withAuthorization('Basic dXNlcjpwYXNz'))).toBeNull();
    expect(bearerToken(withAuthorization('Bearer'))).toBeNull();
    expect(bearerToken(withAuthorization('Bearer    '))).toBeNull();
    expect(bearerToken(withAuthorization('Bearerpd_abc'))).toBeNull();
  });
});
