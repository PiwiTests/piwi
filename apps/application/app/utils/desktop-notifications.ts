/**
 * The native notifications the desktop shim showed, by the id the shell reports a click with
 * (`piwi:notification-click`). Ids start at a random point of each page load, so a click on a
 * notification an earlier load showed finds nothing rather than another notification. The oldest
 * entries go once `limit` is passed: the OS keeps notifications longer than the page needs them.
 */
export interface ShownNotifications<T> {
  /** Remember `item` and return its id: a positive 32-bit integer, as the notification plugin takes. */
  add: (item: T) => number;
  /** The item shown under `id`, if it is still remembered. */
  get: (id: number) => T | undefined;
  /** Forget the item shown under `id`. */
  remove: (id: number) => void;
}

/** The largest id the notification plugin takes (a signed 32-bit integer). */
const MAX_NOTIFICATION_ID = 2 ** 31 - 1;

export function createShownNotifications<T>(
  limit = 100,
  firstId = 1 + Math.floor(Math.random() * 1_000_000_000),
): ShownNotifications<T> {
  const items = new Map<number, T>();
  let nextId = firstId;
  return {
    add(item) {
      const id = nextId;
      nextId = nextId >= MAX_NOTIFICATION_ID ? 1 : nextId + 1;
      items.set(id, item);
      while (items.size > limit) {
        const oldest = items.keys().next().value;
        if (oldest === undefined) break;
        items.delete(oldest);
      }
      return id;
    },
    get: (id) => items.get(id),
    remove(id) {
      items.delete(id);
    },
  };
}
