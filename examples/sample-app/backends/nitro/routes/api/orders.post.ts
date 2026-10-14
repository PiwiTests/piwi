import { defineEventHandler, readBody, setResponseStatus } from 'h3';
import * as orders from '../../services/order-service';
import type { OrderRequest } from '../../services/order-service';
import { shopperOf, signInFirst } from '../../utils/shopper';

export default defineEventHandler(async (event) => {
  const shopper = shopperOf(event);
  if (!shopper) return signInFirst(event);

  const placed = orders.place(shopper, await readBody<OrderRequest | undefined>(event));
  if ('problem' in placed) {
    setResponseStatus(event, 400);
    return { error: placed.problem };
  }
  setResponseStatus(event, 201);
  return placed.order;
});
