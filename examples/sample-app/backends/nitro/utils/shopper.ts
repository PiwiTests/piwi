import { getCookie, setResponseStatus, type H3Event } from 'h3';

/** The signed-in shopper: the shop's pages keep the email in the `shop_user` cookie. */
export const shopperOf = (event: H3Event): string | undefined => getCookie(event, 'shop_user')?.trim() || undefined;

/** The answer to a request that needs a shopper and has none. */
export function signInFirst(event: H3Event) {
  setResponseStatus(event, 401);
  return { error: 'Sign in first.' };
}
