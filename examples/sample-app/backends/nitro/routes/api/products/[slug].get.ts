import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3';
import * as catalog from '../../../services/product-catalog';

export default defineEventHandler((event) => {
  const product = catalog.find(getRouterParam(event, 'slug', { decode: true }) ?? '');
  if (!product) {
    setResponseStatus(event, 404);
    return { error: 'No such product' };
  }
  return product;
});
