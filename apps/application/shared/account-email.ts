import { z } from 'zod';

/** An account's email address as the server takes it, so a form can refuse what the server would. */
export const accountEmailSchema = z.string().trim().max(254).email();
