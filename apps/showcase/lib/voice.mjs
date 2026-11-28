// The voice: each line of the story read by Piper, a local neural voice, before the take (lines first), so that a beat
// holds as long as its lines are spoken; and the voice track the cut mixes from those readings, each at its cue.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The voice: Piper's `en_US-ljspeech-high`, trained on the LJ Speech recordings (public domain), from the piper-voices
 * repository (MIT) at a fixed revision, each file checked by its SHA-256. Piper itself (GPL-3.0) runs as a program of
 * its own, installed beside the showcase, never bundled.
 */
export const VOICE = {
  name: 'en_US-ljspeech-high',
  base: 'https://huggingface.co/rhasspy/piper-voices/resolve/613b6e5ad36ddca4e70e171957291483dc244d9f/en/en_US/ljspeech/high/',
  files: {
    'en_US-ljspeech-high.onnx': '5d4f08ba6a2a48c44592eed3ce56bf85e9de3dd4e20df90541ae68a8310c029a',
    'en_US-ljspeech-high.onnx.json': '7e1f4634af596d83cca997fb7a931ba80b70f8a316a2655ee69c55365e0ace14',
  },
};

/** The voice track's loudness for the web, in LUFS, and its true peak's ceiling, in dBTP. */
export const LOUDNESS = { lufs: -16, peak: -1.5 };

/** Where the voice's model is kept between takes: `SHOWCASE_VOICE_CACHE`, else the user's cache folder. */
export function voiceCache() {
  return process.env.SHOWCASE_VOICE_CACHE ?? path.join(os.homedir(), '.cache', 'piwi-showcase', 'voices');
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The voice's model in `dir`, downloaded there once (with curl, which follows the machine's proxy) and checked. */
export function ensureVoice(dir = voiceCache(), say = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, sum] of Object.entries(VOICE.files)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && sha256(file) === sum) continue;
    say(`the voice's ${name}, downloaded once into ${dir}`);
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', file, VOICE.base + name], { stdio: 'inherit' });
    if (sha256(file) !== sum) {
      fs.rmSync(file);
      throw new Error(`the voice's ${name} is not the file expected: its SHA-256 differs`);
    }
  }
  return path.join(dir, `${VOICE.name}.onnx`);
}

/** The length of a WAV file's sound, in ms, from its header: its `data` chunk's size over its bytes a second. */
export function wavMs(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let byteRate = null;
  for (let at = 12; at + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    if (id === 'fmt ') byteRate = buffer.readUInt32LE(at + 16);
    if (id === 'data') {
      if (!byteRate) throw new Error('a WAV file whose data comes before its format');
      return Math.round((Math.min(size, buffer.length - at - 8) / byteRate) * 1000);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('a WAV file without data');
}

/** The file a line's reading by the voice `model` is kept in: named by a hash of the voice and the text. */
export function readingFile(model, text) {
  const hash = createHash('sha256')
    .update(`${path.basename(model)}\n${text}`)
    .digest('hex');
  return `${hash.slice(0, 16)}.wav`;
}

/**
 * Each of `texts` read by the voice's `model` into a WAV in `dir`, once per text, with Piper (`SHOWCASE_PIPER`, else
 * `piper` on the PATH): resolves with each text's `file` (in `dir`) and its length, `ms`.
 */
export function readLines(texts, { model, dir, piper = process.env.SHOWCASE_PIPER ?? 'piper', say = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const read = {};
  const unique = [...new Set(texts)];
  say(`${unique.length} lines read by ${path.basename(model, '.onnx')}, into ${dir}`);
  for (const text of unique) {
    const file = readingFile(model, text);
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) {
      try {
        execFileSync(piper, ['-m', model, '-f', target], { input: text, stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (error) {
        const why = error.code === 'ENOENT' ? `${piper} is not installed: pip install piper-tts` : String(error.stderr);
        throw new Error(`the voice could not read "${text}": ${why}`);
      }
    }
    read[text] = { file, ms: wavMs(fs.readFileSync(target)) };
  }
  return read;
}

/**
 * The ffmpeg arguments that mix `readings` (`{ file, start }`, start in seconds) into one track `seconds` long, each at
 * its start, normalized to `LOUDNESS`: the inputs, then the filter graph whose output is `[voice]`.
 */
export function mixArguments(readings, seconds) {
  const inputs = readings.flatMap((r) => ['-i', r.file]);
  const delayed = readings.map((r, i) => `[${i}:a]adelay=${Math.round(r.start * 1000)}:all=1[a${i}]`);
  const mix =
    `${readings.map((_, i) => `[a${i}]`).join('')}amix=inputs=${readings.length}:normalize=0:dropout_transition=0,` +
    `apad,atrim=0:${seconds.toFixed(3)},loudnorm=I=${LOUDNESS.lufs}:TP=${LOUDNESS.peak}:LRA=11,aresample=48000[voice]`;
  return [...inputs, '-filter_complex', [...delayed, mix].join(';')];
}
