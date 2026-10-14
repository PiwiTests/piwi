import { defineEventHandler } from 'h3';
import * as orders from '../../services/order-service';
import { shopperOf, signInFirst } from '../../utils/shopper';

/** The shopper's orders: only the order history calls it. */
export default defineEventHandler((event) => {
  const shopper = shopperOf(event);
  return shopper ? orders.forShopper(shopper) : signInFirst(event);
});
