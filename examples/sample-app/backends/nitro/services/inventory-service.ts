import { consola } from 'consola';
import * as prices from './price-feed';

export interface Item {
  name: string;
  stock: number;
}

export interface StockReport {
  items: number;
  cached: boolean;
}

const LOW_STOCK = 5;

/** The stock of the demo items. */
const stock: readonly Item[] = [
  { name: 'Alpha', stock: 2 },
  { name: 'Beta', stock: 14 },
  { name: 'Gamma', stock: 9 },
];

const logger = consola.withTag('inventory');

export const items = (): readonly Item[] => stock;

/**
 * Counts the items, warning about each one running low, and falls back to the cached prices when the price feed
 * fails: one Warning and one Error with its exception, both on the response's X-Piwi-Logs header.
 */
export function report(): StockReport {
  for (const item of stock) {
    if (item.stock < LOW_STOCK) logger.warn(`demo: low stock for item ${item.name}`);
  }

  let cached = false;
  try {
    prices.refresh();
  } catch (error) {
    logger.error('demo: price sync failed, using cached prices', error);
    cached = true;
  }

  return { items: stock.length, cached };
}

/** Synchronizes the stock with the inventory backend, which always fails. */
export function sync(): void {
  throw new Error('demo: inventory backend exploded');
}
