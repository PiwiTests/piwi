import { defineEventHandler } from 'h3';
import * as inventory from '../../services/inventory-service';

/** The stock report, which logs a warning and an error on its way. */
export default defineEventHandler(() => inventory.report());
