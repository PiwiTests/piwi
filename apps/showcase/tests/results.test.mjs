import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { RESULTS_MARKER, prepareOut, refusal } from '../lib/results.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-results-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A take's results: its marker and its log. */
function takeAt(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RESULTS_MARKER), '');
  fs.writeFileSync(path.join(dir, 'take.json'), '{}');
  return dir;
}

describe('a results folder', () => {
  test('is never the take a cut reads, nor a folder holding it', () => {
    const take = takeAt(path.join(root, 'a', 'results'));
    assert.match(refusal(take, { keep: take, cwd: root }), /the take the cut reads/);
    assert.match(refusal(path.join(root, 'a'), { keep: take, cwd: root }), /the take the cut reads/);
    assert.throws(() => prepareOut(take, { keep: take, cwd: root }), /the take the cut reads/);
    assert.ok(fs.existsSync(path.join(take, 'take.json')), 'the take is still there');
  });

  test('may be inside the take, or beside it', () => {
    const take = takeAt(path.join(root, 'b', 'results'));
    assert.equal(refusal(path.join(take, 'cut'), { keep: take, cwd: root }), null);
    assert.equal(refusal(path.join(root, 'b', 'cut'), { keep: take, cwd: root }), null);
    assert.equal(refusal(`${take}-cut`, { keep: take, cwd: root }), null, 'a name that only starts like it');
  });

  test('is never a folder of files no take wrote, nor the current folder', () => {
    const other = path.join(root, 'c');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'notes.txt'), '');
    assert.match(refusal(other, { cwd: root }), /no take or cut wrote/);
    assert.match(refusal(root, { cwd: root }), /not results/);
  });

  test('is emptied and marked', () => {
    const dir = takeAt(path.join(root, 'd'));
    fs.writeFileSync(path.join(dir, 'old.mp4'), '');
    prepareOut(dir, { cwd: root });
    assert.deepEqual(fs.readdirSync(dir), [RESULTS_MARKER]);
  });
});
