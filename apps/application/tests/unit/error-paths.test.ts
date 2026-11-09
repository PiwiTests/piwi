/**
 * The error paths of a source file, from a scan of its text: `catch` blocks,
 * `throw`s and statements that answer with an error status.
 */
import { describe, expect, test } from 'vitest';
import { findErrorPaths } from '../../shared/error-paths';

const source = (...lines: string[]) => lines.join('\n');

describe('findErrorPaths', () => {
  test('finds a catch block, a throw and an error return, each with its lines', () => {
    const paths = findErrorPaths(
      source(
        'export async function pay(order) {',
        '  if (!order) throw createError({ statusCode: 400 });',
        '  try {',
        '    await charge(order);',
        '  } catch (err) {',
        '    log(err);',
        '    throw err;',
        '  }',
        '  if (order.closed) {',
        '    return res.status(409).json({',
        "      error: 'closed',",
        '    });',
        '  }',
        '  return res.status(201).json(order);',
        '}',
      ),
    );
    expect(paths.map((p) => [p.kind, p.range])).toEqual([
      ['throw', [2, 2]],
      ['catch', [5, 8]],
      ['error-return', [10, 12]],
    ]);
  });

  test('reads a C# named result across lines, and skips comments and successes', () => {
    const paths = findErrorPaths(
      source(
        '    // throw new InvalidOperationException();',
        '        if (user is null)',
        '            return TypedResults.NotFound();',
        '        return TypedResults.ValidationProblem(new Dictionary<string, string[]>',
        '        {',
        '            ["role"] = ["bad"],',
        '        });',
        '        return TypedResults.Ok(user);',
      ),
    );
    expect(paths.map((p) => [p.kind, p.range, p.text])).toEqual([
      ['error-return', [3, 3], 'return TypedResults.NotFound();'],
      ['error-return', [4, 7], 'return TypedResults.ValidationProblem(new Dictionary<string, string[]>'],
    ]);
  });
});
