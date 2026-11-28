import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cueSheet, lineMs, scheduleLines, spokenMs } from '../lib/timeline.mjs';
import { LOUDNESS, mixArguments, readingFile, wavMs } from '../lib/voice.mjs';

/** A WAV file of `ms` of silence, 16-bit mono at `rate`, its chunks in `order`. */
function wav(ms, { rate = 22_050, order = ['fmt ', 'data'], extra = false } = {}) {
  const data = Buffer.alloc(Math.round((rate * 2 * ms) / 1000));
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const chunk = (id, body) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const chunks = { 'fmt ': chunk('fmt ', fmt), data: chunk('data', data) };
  const body = Buffer.concat([
    Buffer.from('WAVE'),
    ...(extra ? [chunk('LIST', Buffer.from('odd'))] : []),
    ...order.map((id) => chunks[id]),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

describe('a reading’s length', () => {
  test('is its data over its bytes a second', () => {
    assert.equal(wavMs(wav(2500)), 2500);
    assert.equal(wavMs(wav(1200, { rate: 48_000 })), 1200);
  });

  test('skips the chunks before the data, an odd one padded', () => {
    assert.equal(wavMs(wav(800, { extra: true })), 800);
  });

  test('refuses what is not a WAV file, or one whose data comes first', () => {
    assert.throws(() => wavMs(Buffer.from('not a wav file at all')), /not a WAV file/);
    assert.throws(() => wavMs(wav(100, { order: ['data', 'fmt '] })), /data comes before its format/);
  });
});

describe('the readings', () => {
  test('are kept by the voice, its settings and the text', () => {
    const a = readingFile('/voices/en_US-bryce-medium.onnx', 'A line.');
    assert.match(a, /^[0-9a-f]{16}\.wav$/);
    assert.equal(readingFile('/elsewhere/en_US-bryce-medium.onnx', 'A line.'), a);
    assert.notEqual(readingFile('/voices/en_GB-cori-high.onnx', 'A line.'), a);
    assert.notEqual(readingFile('/voices/en_US-bryce-medium.onnx', 'Another line.'), a);
    assert.notEqual(readingFile('/voices/en_US-bryce-medium.onnx', 'A line.', { '--noise-scale': '0.5' }), a);
  });

  test('hold a line as long as it is spoken, and a pause; a line not read as long as it is read', () => {
    const readings = { 'A line.': { file: 'a.wav', ms: 2000 } };
    assert.equal(spokenMs('A line.', readings), 2400);
    assert.equal(spokenMs('Not read.', readings), lineMs('Not read.'));
    assert.deepEqual(
      scheduleLines(['A line.', 'Not read.'], 1000, readings).map((l) => [l.start, l.ms]),
      [
        [1000, 2400],
        [3400, lineMs('Not read.')],
      ],
    );
  });

  test('are mixed each at its start, into one track as long as the cut, at the web’s loudness', () => {
    const args = mixArguments(
      [
        { file: 'a.wav', start: 1.5 },
        { file: 'b.wav', start: 4.25 },
      ],
      10,
    );
    assert.deepEqual(args.slice(0, 4), ['-i', 'a.wav', '-i', 'b.wav']);
    const graph = args[args.indexOf('-filter_complex') + 1];
    assert.match(graph, /\[0:a\]adelay=1500:all=1\[a0\]/);
    assert.match(graph, /\[1:a\]adelay=4250:all=1\[a1\]/);
    assert.match(graph, /amix=inputs=2:normalize=0/);
    assert.match(graph, /atrim=0:10\.000/);
    assert.match(graph, new RegExp(`loudnorm=I=${LOUDNESS.lufs}:TP=${LOUDNESS.peak}`));
    assert.match(graph, /\[voice\]$/);
  });
});

describe('the cue sheet', () => {
  test('lists each line with its times and its beat, quoting a field that needs it', () => {
    const sheet = cueSheet([
      { start: 4, end: 6.5, beat: 'title', text: 'Hello there.' },
      { start: 65.25, end: 70.57, beat: 'red-run', text: 'Piwi kept it: the page, "the" timeline.' },
      { start: 16.755, end: 21.8, beat: 'red-run', text: 'Rounded alike.' },
    ]);
    assert.equal(
      sheet,
      'start,end,start_s,end_s,beat,line\n' +
        '0:04.00,0:06.50,4.00,6.50,title,Hello there.\n' +
        '1:05.25,1:10.57,65.25,70.57,red-run,"Piwi kept it: the page, ""the"" timeline."\n' +
        '0:16.76,0:21.80,16.76,21.80,red-run,Rounded alike.\n',
    );
  });
});
