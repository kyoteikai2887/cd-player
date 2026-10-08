/**
 * Top bar over Mica (Claude, R2.2 follow-up on core.15). With Mica behind the window the paper is
 * translucent, so the blur the bar takes of the shelf was translucent too, and the sharp shelf
 * showed through it as a faint ghost in WebView2. The bar fills its blurred copy in to opaque.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/ui/views/MainSurface.module.css'), 'utf8');
const rule = (selector: string) => {
  const at = css.indexOf(selector);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};
const backdropFilter = (block: string) => /\sbackdrop-filter:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? '';
const MICA_BAR = ':global(.cdp[data-backdrop="mica"]) .barWrap[data-scrolled="true"]';

describe('top bar over Mica', () => {
  test('the scrolled bar is the same glass, with its blurred copy of the translucent page filled in', () => {
    const glass = backdropFilter(rule('.barWrap[data-scrolled="true"] {'));
    expect(glass).toBe('blur(var(--glass-blur)) saturate(var(--glass-sat))');
    const mica = backdropFilter(rule(MICA_BAR));
    expect(mica.startsWith(glass)).toBe(true);
    const fills = mica.slice(glass.length).match(/drop-shadow\(0 0 0 var\(--paper\)\)/g) ?? [];
    expect(fills.length).toBe(2);

    // Each zero-offset shadow lays the copy over itself: alpha a becomes a + a(1 - a). The thinnest
    // the page gets is the Mica paper; after the fills, what is left to show the sharp shelf through
    // must be far below what the eye picks out (the ghost Codex measured was ~9% before the glass).
    const paper = Number(/opacity:\s*([\d.]+)/.exec(rule(':global(.cdp[data-backdrop="mica"]) .backdrop'))?.[1]);
    expect(paper).toBeGreaterThan(0);
    expect(paper).toBeLessThan(1);
    const filled = fills.reduce(a => a + a * (1 - a), paper);
    expect(1 - filled).toBeLessThan(0.005);
  });

  test('high contrast keeps its own solid bar', () => {
    const at = css.indexOf(MICA_BAR);
    const media = css.lastIndexOf('@media', at);
    expect(css.slice(media, css.indexOf('{', media))).toContain('(forced-colors: none)');
    expect(css).toMatch(/@media \(forced-colors: active\) \{[^@]*\.barWrap\[data-scrolled="true"\] \{ background: Canvas; backdrop-filter: none;/);
  });
});
