// The voice: each line of the story read by Kokoro, a local neural voice, before the take (lines first), so that a beat
// holds as long as its lines are spoken; and the voice track the cut mixes from those readings, each at its cue.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The reader, which Kokoro's Python package runs: it reads a job's lines with the model loaded once. */
const READER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'voice.py');

/**
 * The voice: Kokoro's `am_michael`, a young US man's, at its own speed, from Kokoro-82M (Apache-2.0) as the
 * kokoro-onnx project releases it, each file checked by its SHA-256. Kokoro runs in a Python environment of its own
 * (`pip install kokoro-onnx`), never bundled.
 */
export const VOICE = {
  name: 'am_michael',
  speed: 1,
  lang: 'en-us',
  base: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/',
  files: {
    model: { name: 'kokoro-v1.0.onnx', sha256: '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5' },
    voices: { name: 'voices-v1.0.bin', sha256: 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d' },
  },
};

/** The voice track's loudness for the web, in LUFS, and its true peak's ceiling, in dBTP. */
export const LOUDNESS = { lufs: -16, peak: -1.5 };

/** Where the voice's model is kept between takes: `SHOWCASE_VOICE_CACHE`, else the user's cache folder. */
export function voiceCache() {
  return process.env.SHOWCASE_VOICE_CACHE ?? path.join(os.homedir(), '.cache', 'piwi-showcase', 'voices');
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * The voice's files in `dir` (`{ model, voices }`, their paths), downloaded there once (with curl, which follows the
 * machine's proxy) and checked.
 */
export function ensureVoice(dir = voiceCache(), say = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const paths = {};
  for (const [key, { name, sha256: sum }] of Object.entries(VOICE.files)) {
    const file = path.join(dir, name);
    paths[key] = file;
    if (fs.existsSync(file) && sha256(file) === sum) continue;
    say(`the voice's ${name}, downloaded once into ${dir}`);
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', file, VOICE.base + name], { stdio: 'inherit' });
    if (sha256(file) !== sum) {
      fs.rmSync(file);
      throw new Error(`the voice's ${name} is not the file expected: its SHA-256 differs`);
    }
  }
  return paths;
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

/**
 * The file a line's reading by `voice` (`VOICE`'s fields) is kept in: named by a hash of the voice, its model, its
 * speed and the text.
 */
export function readingFile(text, voice = VOICE) {
  const hash = createHash('sha256')
    .update([voice.name, voice.files.model.sha256, voice.speed, voice.lang, text].join('\n'))
    .digest('hex');
  return `${hash.slice(0, 16)}.wav`;
}

/**
 * Each of `texts` read by the voice (`files`, from `ensureVoice`) into a WAV in `dir`, once per text, by Kokoro's
 * Python package (`SHOWCASE_PYTHON`, else `python3`) in one run: resolves with each text's `file` (in `dir`) and its
 * length, `ms`.
 */
export function readLines(texts, { files, dir, python = process.env.SHOWCASE_PYTHON ?? 'python3', say = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const unique = [...new Set(texts)];
  const missing = unique.filter((text) => !fs.existsSync(path.join(dir, readingFile(text))));
  say(`${unique.length} lines read by Kokoro's ${VOICE.name} into ${dir}, ${missing.length} of them now`);
  if (missing.length) {
    const job = {
      model: files.model,
      voices: files.voices,
      voice: VOICE.name,
      speed: VOICE.speed,
      lang: VOICE.lang,
      lines: missing.map((text) => ({ text, file: path.join(dir, readingFile(text)) })),
    };
    try {
      execFileSync(python, ['-I', READER], { input: JSON.stringify(job), stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (error) {
      const stderr = String(error.stderr ?? '');
      const why =
        error.code === 'ENOENT'
          ? `${python} was not found: set SHOWCASE_PYTHON to a Python with kokoro-onnx`
          : /No module named 'kokoro_onnx'/.test(stderr)
            ? `${python} has no kokoro-onnx: pip install kokoro-onnx, or set SHOWCASE_PYTHON`
            : stderr.trim().split('\n').at(-1);
      throw new Error(`the voice could not read the lines: ${why}`);
    }
  }
  return Object.fromEntries(
    unique.map((text) => {
      const file = readingFile(text);
      return [text, { file, ms: wavMs(fs.readFileSync(path.join(dir, file))) }];
    }),
  );
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
