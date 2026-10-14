import { consola } from 'consola';
import * as catalog from './product-catalog';
import type { Product } from './product-catalog';

/** An order as the checkout page sends it: the cart, one product slug per item, and where it goes. */
export interface OrderRequest {
  items?: unknown;
  shipping?: Shipping;
}

export interface Shipping {
  name?: string;
  address?: string;
  city?: string;
  country?: string;
}

export interface Order {
  id: number;
  shopper: string;
  name: string;
  city: string;
  country: string;
  count: number;
  total: number;
  summary: string;
}

/** A placed order, or the problem that kept it from being placed. */
export type OrderResult = { order: Order } | { problem: string };

const COUNTRIES = ['France', 'Germany', 'Spain', 'United Kingdom'];

/** The shop's orders, in memory. */
const orders: Order[] = [];
let lastId = 1000;

const logger = consola.withTag('orders');

/** Checks, prices and keeps an order. */
export function place(shopper: string, request: OrderRequest | undefined): OrderResult {
  const products: Product[] = [];
  const problem = check(request, products);
  if (problem) {
    logger.warn(`demo: order rejected for ${shopper}: ${problem}`);
    return { problem };
  }

  const shipping = request!.shipping!;
  const city = shipping.city!.trim();
  const country = shipping.country!;
  const total = products.reduce((sum, product) => sum + product.price, 0);
  const summary = `${products.length} item(s) on their way to ${city}, ${country}.`;
  const order: Order = {
    id: ++lastId,
    shopper,
    name: shipping.name!.trim(),
    city,
    country,
    count: products.length,
    total,
    summary,
  };
  orders.push(order);

  logger.info(`Order ${order.id} placed for ${shopper}: ${order.count} item(s), ${total}`);
  return { order };
}

/** The shopper's orders, newest first. */
export const forShopper = (shopper: string): Order[] => orders.filter((order) => order.shopper === shopper).reverse();

const blank = (value: unknown) => typeof value !== 'string' || value.trim() === '';

/** Why the order cannot be placed, or null; fills `products` with its items. */
function check(request: OrderRequest | undefined, products: Product[]): string | null {
  const items = request?.items;
  if (!Array.isArray(items) || items.length === 0) return 'Your cart is empty.';

  for (const slug of items) {
    const product = catalog.find(String(slug));
    if (!product) return `The shop does not sell ${slug}.`;
    products.push(product);
  }

  const shipping = request?.shipping;
  if (blank(shipping?.name) || blank(shipping?.address) || blank(shipping?.city)) {
    return 'Enter your name, address and city.';
  }
  if (!COUNTRIES.includes(shipping!.country as string)) return `The shop does not ship to ${shipping!.country ?? ''}.`;

  return null;
}
