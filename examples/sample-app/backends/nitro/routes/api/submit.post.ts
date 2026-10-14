import { defineEventHandler, readBody, setResponseStatus } from 'h3';

/** A message from the contact form. */
interface ContactMessage {
  email?: string;
  message?: string;
  priority?: string;
}

export default defineEventHandler(async (event) => {
  const message = await readBody<ContactMessage | undefined>(event);
  if (typeof message?.email !== 'string' || message.email.trim() === '') {
    setResponseStatus(event, 400);
    return { error: 'email is required' };
  }
  return { ok: true };
});
