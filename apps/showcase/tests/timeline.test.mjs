import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  chapterTime,
  chaptersText,
  chaptersVtt,
  cueTime,
  frameCount,
  lineMs,
  masterFrame,
  scheduleLines,
  subtitleRows,
  teaserParts,
  toSrt,
  toVtt,
} from '../lib/timeline.mjs';

describe('a line’s hold', () => {
  test('reads at 15 characters a second, then pauses 0.4 s', () => {
    assert.equal(lineMs('x'.repeat(30)), 2400);
    assert.equal(lineMs(''), 400);
  });

  test('the lines of a beat follow one another from its start', () => {
    const lines = scheduleLines(['x'.repeat(15), 'y'.repeat(30)], 10_000);
    assert.deepEqual(lines, [
      { text: 'x'.repeat(15), start: 10_000, ms: 1400 },
      { text: 'y'.repeat(30), start: 11_400, ms: 2400 },
    ]);
  });
});

describe('the master’s frame for an output frame', () => {
  test('30 output frames a second show each of the 24 master frames, once or twice, in order', () => {
    const shown = Array.from({ length: frameCount(1) }, (_, i) => masterFrame(i / 30));
    assert.equal(shown.length, 30);
    assert.deepEqual(
      [...new Set(shown)],
      Array.from({ length: 24 }, (_, i) => i),
    );
    for (let i = 1; i < shown.length; i++) assert.ok(shown[i] - shown[i - 1] <= 1);
  });

  test('is the nearest frame', () => {
    assert.equal(masterFrame(1 / 24 + 0.01), 1);
    assert.equal(masterFrame(1 / 24 + 0.03), 2);
  });

  test('stays within the master', () => {
    assert.equal(masterFrame(-1), 0);
    assert.equal(masterFrame(100, { frames: 48 }), 47);
  });
});

describe('the subtitles', () => {
  test('a short line is one row; a long one two rows, as even as its words allow', () => {
    assert.deepEqual(subtitleRows('Resume: the test passes.'), ['Resume: the test passes.']);
    const rows = subtitleRows('The test stops at the failing line, and the editor shows the same place.');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.length <= 42));
    assert.ok(Math.abs(rows[0].length - rows[1].length) <= 10, rows.join(' | '));
  });

  test('cue times are hours, minutes, seconds and milliseconds', () => {
    assert.equal(cueTime(3725.5), '01:02:05.500');
    assert.equal(cueTime(0.0004), '00:00:00.000');
    assert.equal(cueTime(61.25, ','), '00:01:01,250');
  });

  const cues = [
    { start: 4.2, end: 7.5, text: 'The checkout was redesigned, and CI went red on main.' },
    { start: 7.5, end: 9, text: 'Green.' },
  ];

  test('WebVTT numbers each cue, in its rows', () => {
    assert.equal(
      toVtt(cues),
      'WEBVTT\n\n' +
        '1\n00:00:04.200 --> 00:00:07.500\nThe checkout was redesigned,\nand CI went red on main.\n\n' +
        '2\n00:00:07.500 --> 00:00:09.000\nGreen.\n',
    );
  });

  test('SubRip uses a comma before the milliseconds, and no header', () => {
    assert.equal(
      toSrt(cues),
      '1\n00:00:04,200 --> 00:00:07,500\nThe checkout was redesigned,\nand CI went red on main.\n\n' +
        '2\n00:00:07,500 --> 00:00:09,000\nGreen.\n',
    );
  });
});

describe('the chapters', () => {
  const chapters = [
    { start: 0, title: 'Piwi' },
    { start: 4.3, title: 'The red run' },
    { start: 3661, title: 'Long' },
  ];

  test('the list starts at 0:00, minutes and seconds, hours past the hour', () => {
    assert.equal(chapterTime(65.9), '1:05');
    assert.equal(chaptersText(chapters), '0:00 Piwi\n0:04 The red run\n1:01:01 Long\n');
  });

  test('WebVTT chapters end where the next starts', () => {
    assert.match(chaptersVtt(chapters, 3700), /2\n00:00:04.300 --> 01:01:01.000\nThe red run/);
    assert.match(chaptersVtt(chapters, 3700), /3\n01:01:01.000 --> 01:01:40.000\nLong\n$/);
  });
});

describe('the teaser', () => {
  const beat = (id, start, linesEnd, end) => ({ id, start, linesEnd, end });

  test('takes its beats in order, each from its start through its lines', () => {
    const beats = [beat('green', 50, 57, 60), beat('red-run', 0, 7, 20), beat('paused', 30, 37, 40)];
    const parts = teaserParts(beats, { ids: ['red-run', 'paused', 'green'], target: 22.8, tail: 0.6 });
    assert.deepEqual(
      parts.map((p) => p.id),
      ['red-run', 'paused', 'green'],
    );
    assert.deepEqual(
      parts.map((p) => [p.start, Number(p.end.toFixed(3))]),
      [
        [0, 7.6],
        [30, 37.6],
        [50, 57.6],
      ],
    );
  });

  test('grows toward its target, never past a beat’s end', () => {
    const beats = [beat('red-run', 0, 5, 30), beat('paused', 40, 45, 46)];
    const parts = teaserParts(beats, { ids: ['red-run', 'paused'], target: 30, tail: 0 });
    assert.equal(parts[1].end, 46);
    const total = parts.reduce((sum, p) => sum + p.end - p.start, 0);
    assert.ok(Math.abs(total - 30) < 1e-6, String(total));
  });

  test('shrinks evenly when its beats’ lines run longer than the target', () => {
    const beats = [beat('red-run', 0, 20, 30), beat('paused', 40, 60, 70)];
    const parts = teaserParts(beats, { ids: ['red-run', 'paused'], target: 20, tail: 0 });
    assert.deepEqual(
      parts.map((p) => [p.start, p.end]),
      [
        [0, 10],
        [40, 50],
      ],
    );
  });

  test('leaves out a beat the take did not play', () => {
    const parts = teaserParts([beat('red-run', 0, 5, 10)], { ids: ['red-run', 'green'], target: 5, tail: 0 });
    assert.deepEqual(
      parts.map((p) => p.id),
      ['red-run'],
    );
  });
});
