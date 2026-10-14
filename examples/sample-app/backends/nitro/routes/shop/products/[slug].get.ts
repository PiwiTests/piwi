import { defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from 'h3';
import * as catalog from '../../../services/product-catalog';
import { servePage } from '../../../utils/page-files';

/** The page of a product, or a 404 for a product the catalog does not have. */
export default defineEventHandler((event) => {
  if (!catalog.find(getRouterParam(event, 'slug', { decode: true }) ?? '')) {
    setResponseStatus(event, 404);
    setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8');
    return 'No such product';
  }
  return servePage(event, 'shop/product.html');
});
