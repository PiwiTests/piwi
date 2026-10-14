import { defineEventHandler } from 'h3';
import * as catalog from '../../services/product-catalog';

export default defineEventHandler(() => catalog.all());
