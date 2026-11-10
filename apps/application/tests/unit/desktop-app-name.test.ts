import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ECOSYSTEM_PIECES } from '../../shared/piwi-ecosystem';

/**
 * The desktop app goes by one name in its windows, splash, tray and notifications, the one Piwi Picker and the
 * dashboard's desktop pages use: `ECOSYSTEM_PIECES`' `app`. The installed product keeps `productName` until its
 * installers' upgrade path is checked.
 */

const desktop = path.resolve(__dirname, '../../../desktop/src-tauri');
const app = ECOSYSTEM_PIECES.find((piece) => piece.id === 'desktop')?.app;

describe('the desktop app’s name', () => {
  test('is the registry’s', () => {
    expect(app).toBe('Piwi Desktop');
  });

  test('titles the main window', () => {
    const conf = JSON.parse(fs.readFileSync(path.join(desktop, 'tauri.conf.json'), 'utf8'));
    expect(conf.app.windows[0].title).toBe(app);
  });

  test('is the shell’s name for its windows, tray, questions and notifications', () => {
    const lib = fs.readFileSync(path.join(desktop, 'src/lib.rs'), 'utf8');
    expect(lib).toContain(`pub(crate) const APP_NAME: &str = "${app}";`);
    for (const file of ['src/lib.rs', 'src/taskbar_win.rs', 'src/updates.rs', 'src/mcp_stdio.rs']) {
      const source = fs.readFileSync(path.join(desktop, file), 'utf8');
      // The code, without its tests module, whose fixtures hold what a server sends.
      const tests = source.search(/#\[cfg\(test\)\]\s*mod tests\b/);
      const text = tests < 0 ? source : source.slice(0, tests);
      // The tray, built near the end of the shell's code, is read.
      if (file === 'src/lib.rs') expect(text).toContain('format!("Quit {APP_NAME}")');
      // The product name stays in comments, in an error naming the build and where the OS lists the installed app.
      const shown = [...text.matchAll(/"[^"\n]*Piwi Dashboard[^"\n]*"/g)].map((m) => m[0]);
      expect(
        shown.filter((s) => !/building the|Start menu/.test(s)),
        file,
      ).toEqual([]);
    }
  });

  test('titles the splash the window shows while the server starts', () => {
    const splash = fs.readFileSync(path.join(desktop, '../src/index.html'), 'utf8');
    expect(splash).toContain(`<title>${app}</title>`);
    expect(splash).not.toContain('Piwi Dashboard');
  });
});
