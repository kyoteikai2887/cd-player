/**
 * V1.1 wide shelf (Claude), the stylesheet half: the side discs are decoration only and the shelf
 * widens with the window up to a cap. (The rendered half is in stage-wide.test.tsx.)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('wide shelf rules', () => {
  test('no pointer, nothing moving, gone below the width that holds them and in high contrast', () => {
    const css = readFileSync('src/ui/views/LibraryView.module.css', 'utf8');
    const sides = css.slice(css.indexOf('\n.sides {'), css.indexOf('}', css.indexOf('\n.sides {')));
    expect(sides).toContain('pointer-events: none;');
    const all = css.slice(css.indexOf('/* ── Sides (V1.1)'), css.indexOf('@container surface (width < 1760px)'));
    expect(all).not.toMatch(/animation|transition|filter|backdrop-filter/);
    expect(css).toContain('@container surface (width < 1760px) { .sides { display: none; } }');
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced.slice(0, forced.indexOf('\n}'))).toMatch(/\.sides \{ display: none; \}|\.tileGlow, \.sides \{ display: none; \}/);
    // The shelf widens with the window but stops: covers and titles keep their own caps.
    expect(css).toContain('--shelf-max: clamp(1320px, 82cqi, 1840px);');
  });
});
