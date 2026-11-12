/**
 * Playwright's ANSI-colored text (an error, a step's output) as HTML: the colors it names rendered in a palette that
 * keeps its contrast (`onDark` for a dark background), every other byte escaped. The dashboard and Piwi Runner's window
 * render errors through it (`ErrorText`).
 */
const ESC = '\u001B';

const ANSI_FG: Record<number, string> = {
  30: '#000000',
  31: '#dc2626',
  32: '#16a34a',
  33: '#d97706',
  34: '#2563eb',
  35: '#9333ea',
  36: '#0891b2',
  37: '#9ca3af',
  90: '#6b7280',
  91: '#ef4444',
  92: '#22c55e',
  93: '#eab308',
  94: '#3b82f6',
  95: '#a855f7',
  96: '#06b6d4',
  97: '#e5e7eb',
};

/** The foreground colors on a dark background (a terminal pane): lighter, each at 7:1 or more on `zinc-950`. */
const ANSI_FG_ON_DARK: Record<number, string> = {
  30: '#a1a1aa',
  31: '#f87171',
  32: '#4ade80',
  33: '#fbbf24',
  34: '#60a5fa',
  35: '#c084fc',
  36: '#22d3ee',
  37: '#d4d4d8',
  90: '#a1a1aa',
  91: '#fca5a5',
  92: '#86efac',
  93: '#fde047',
  94: '#93c5fd',
  95: '#d8b4fe',
  96: '#67e8f9',
  97: '#f4f4f5',
};

const ANSI_BG: Record<number, string> = {
  40: '#000000',
  41: '#dc2626',
  42: '#16a34a',
  43: '#d97706',
  44: '#2563eb',
  45: '#9333ea',
  46: '#0891b2',
  47: '#9ca3af',
  100: '#6b7280',
  101: '#ef4444',
  102: '#22c55e',
  103: '#eab308',
  104: '#3b82f6',
  105: '#a855f7',
  106: '#06b6d4',
  107: '#e5e7eb',
};

/** A CSI escape sequence: its parameters, then its final letter (`m` for SGR, the one that styles text). */
const ANSI_CSI_RE = new RegExp(`${ESC}\\[([0-9;?]*)([A-Za-z])`, 'g');

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The six levels of each channel in the 6×6×6 cube of the 256-color palette. */
const XTERM_CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** Color `n` of the 256-color palette: its first 16 from `table` (`base` 30 or 40), the cube and the grays as RGB. */
function xterm256Color(n: number | undefined, table: Record<number, string>, base: 30 | 40): string | undefined {
  if (n === undefined || !Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 8) return table[base + n];
  if (n < 16) return table[base + 60 + n - 8];
  if (n < 232) {
    const i = n - 16;
    const [r, g, b] = [Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map((level) => XTERM_CUBE_LEVELS[level]);
    return `rgb(${r},${g},${b})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

/**
 * The color an extended 38 (foreground) or 48 (background) code sets, from the codes after it at `at`: `5;n` for
 * the 256-color palette, `2;r;g;b` for an RGB color. `used` is how many codes it took.
 */
function extendedAnsiColor(
  codes: number[],
  at: number,
  table: Record<number, string>,
  base: 30 | 40,
): { color: string | undefined; used: number } {
  if (codes[at] === 5) return { color: xterm256Color(codes[at + 1], table, base), used: 2 };
  if (codes[at] === 2) {
    const [r, g, b] = [1, 2, 3].map((k) => {
      const value = codes[at + k];
      return value !== undefined && Number.isFinite(value) ? Math.min(255, Math.max(0, value)) : 0;
    });
    return { color: `rgb(${r},${g},${b})`, used: 4 };
  }
  return { color: undefined, used: 0 };
}

/**
 * Convert ANSI SGR escape sequences to HTML `<span>` tags with inline styles.
 * Handles bold/dim/italic/underline, the 30–47 color codes, their bright
 * 90–107 variants, and the 256-color and RGB forms of 38 and 48. Unrecognized
 * codes, and CSI sequences other than SGR (cursor moves, line erases), are
 * stripped. `onDark` picks foreground colors that read on a dark background.
 */
export function renderAnsi(text: string, { onDark = false }: { onDark?: boolean } = {}): string {
  const fgTable = onDark ? ANSI_FG_ON_DARK : ANSI_FG;
  const parts: string[] = [];
  let last = 0;
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  let italic = false;
  let uline = false;

  const push = (raw: string) => {
    if (!raw) return;
    const props: string[] = [];
    if (bold) props.push('font-weight:600');
    if (dim) props.push('opacity:.7');
    if (italic) props.push('font-style:italic');
    if (uline) props.push('text-decoration:underline');
    if (fg) props.push(`color:${fg}`);
    if (bg) props.push(`background:${bg}`);
    const e = escapeHtml(raw);
    parts.push(props.length ? `<span style="${props.join(';')}">${e}</span>` : e);
  };

  const apply = (codes: number[]) => {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 38 || c === 48) {
        const extended = extendedAnsiColor(codes, i + 1, c === 38 ? fgTable : ANSI_BG, c === 38 ? 30 : 40);
        if (c === 38) fg = extended.color;
        else bg = extended.color;
        i += extended.used;
      } else if (c === 0) {
        fg = undefined;
        bg = undefined;
        bold = false;
        dim = false;
        italic = false;
        uline = false;
      } else if (c === 1) {
        bold = true;
      } else if (c === 2) {
        dim = true;
      } else if (c === 3) {
        italic = true;
      } else if (c === 4) {
        uline = true;
      } else if (c === 22) {
        bold = false;
        dim = false;
      } else if (c === 23) {
        italic = false;
      } else if (c === 24) {
        uline = false;
      } else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
        fg = fgTable[c];
      } else if (c === 39) {
        fg = undefined;
      } else if ((c >= 40 && c <= 47) || (c >= 100 && c <= 107)) {
        bg = ANSI_BG[c];
      } else if (c === 49) {
        bg = undefined;
      }
    }
  };

  let m: RegExpExecArray | null;
  while ((m = ANSI_CSI_RE.exec(text)) !== null) {
    push(text.slice(last, m.index));
    last = ANSI_CSI_RE.lastIndex;
    if (m[2] !== 'm') continue;
    const codes = m[1] ? m[1].split(';').map(Number) : [0];
    apply(codes);
  }

  push(text.slice(last));
  return parts.join('');
}

/** The text without its ANSI escape sequences (colors, cursor moves), as plain text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}
