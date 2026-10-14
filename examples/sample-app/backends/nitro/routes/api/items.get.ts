import { defineEventHandler } from 'h3';
import * as inventory from '../../services/inventory-service';

export default defineEventHandler(() => inventory.items());
