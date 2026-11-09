/**
 * The inputs of the change-time detectors, read from a pull request's patches and
 * title.
 */
import { describe, expect, test } from 'vitest';
import { addedControls, addedErrorStatuses, intentMatchedByTests, intentWords } from '../../shared/change-time';

const patch = (...added: string[]) =>
  ['@@ -1,2 +1,4 @@', ' const a = 1;', '-const gone = 409;', ...added.map((l) => `+${l}`)].join('\n');

describe('addedErrorStatuses', () => {
  test('reads the statuses an added line answers with or throws', () => {
    expect(
      addedErrorStatuses(
        patch(
          "  if (order.closed) throw createError({ statusCode: 409, message: 'closed' });",
          '  setResponseStatus(event, 403);',
          '  return res.status(422).json(errors);',
          '  return Results.NotFound();',
        ),
      ),
    ).toEqual([403, 404, 409, 422]);
  });

  test('a number on a line that sets no status, a removed line or a success is no error path', () => {
    expect(addedErrorStatuses(patch('  const timeout = 500;', '  return res.status(201).json(order);'))).toEqual([]);
  });
});

describe('intentWords and intentMatchedByTests', () => {
  test('a title is read without its prefix, its tickets and common words', () => {
    expect(intentWords('fix(cart): reject a negative quantity in the cart PROJ-12 (#88)')).toEqual([
      'reject',
      'negative',
      'quantity',
      'cart',
    ]);
  });

  test('a test holding half of the words mentions the change', () => {
    const words = intentWords('fix: reject a negative quantity');
    expect(intentMatchedByTests(words, ['cart › rejects a negative quantity', 'checkout pays'])).toBe(true);
    expect(intentMatchedByTests(words, ['cart › adds an item', 'checkout › pays by card'])).toBe(false);
    expect(intentMatchedByTests(intentWords('chore: bump'), [])).toBe(true);
  });
});

describe('addedControls', () => {
  test('names the controls a template patch adds', () => {
    expect(
      addedControls(
        patch(
          '  <UInput v-model="promo" placeholder="Promo code" />',
          '  <UButton label="Apply" @click="apply" />',
          '  <button type="submit">Place order</button>',
          '  <UButton :label="dynamic" />',
          '  <p>Total</p>',
        ),
      ),
    ).toEqual(['textbox "Promo code"', 'button "Apply"', 'button "Place order"']);
  });
});
