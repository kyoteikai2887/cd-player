/**
 * MV round (Claude): the stylesheet half of the music videos — motion on the shared scale and only
 * once, a high-contrast fallback, and the UI never reaching past the bridge for files or programs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : /\.(tsx?|css)$/.test(e.name) ? [join(d, e.name)] : []);

describe('music video rules', () => {
  test('one arrival highlight on the duration scale, no loop; high contrast keeps the shapes', () => {
    const css = read('src/ui/views/AlbumVideos.module.css');
    expect(css).toContain('.row[data-fresh="true"] { animation: arrive calc(var(--d-slow) * 3) var(--ease-out); }');
    expect(css).not.toMatch(/infinite/);
    expect(css).not.toMatch(/(?<![\d.])\d+ms/);
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('.row[data-fresh="true"] { animation: none; }');
    expect(forced).toContain('.glyph { background: none; border: 1px solid CanvasText; box-shadow: none; }');
  });

  test('the UI only speaks through the bridge: no fetch, invoke, file system or shell for videos or the player', () => {
    for (const file of walk('src/ui')) {
      const source = read(file);
      expect(`${file}: ${/\bfetch\(|@tauri-apps|\binvoke\(|node:fs|child_process|\.exe['"]/.test(source)}`).toBe(`${file}: false`);
    }
  });

  test('potPlayerConfigured is read, never written; the MV actions are the contract\'s own', () => {
    const settings = read('src/ui/views/SettingsSheet.tsx');
    expect(settings).toContain("{ type: 'detectPotPlayer' }");
    expect(settings).toContain("{ type: 'pickPotPlayer' }");
    expect(settings).not.toMatch(/potPlayerConfigured\s*:/);
    const videos = read('src/ui/views/AlbumVideos.tsx');
    for (const type of ['addMusicVideo', 'relinkMusicVideo', 'renameMusicVideo', 'removeMusicVideo', 'playMusicVideo']) expect(videos).toContain(`type: '${type}'`);
    // The UI never pauses or resumes music around a launch: the core does the pause, nobody resumes.
    expect(videos).not.toMatch(/togglePlayback|type: 'pause'|type: 'play'/);
  });
});
