/**
 * V1.1 final polish (Claude): one flat glass for everything you press. The older bead glass
 * (radial glint, caustic pool, corner-flashing ring, domed knobs) is gone; its token names now
 * name parts of the crystal slab and are declared once. Disabled states fade by one amount, the
 * checkbox is native underneath, and the motion stays on the shared duration scale.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8');
const tokens = read('src/ui/styles/tokens.css');
const components = read('src/ui/styles/components.css');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.css') ? [join(d, e.name)] : []);
const sheets = walk('src/ui').map(file => [file, read(file)] as const);
/** Every declaration of a custom property, as written. */
const decls = (source: string, name: string) => [...source.matchAll(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`, 'g'))].map(m => m[1].trim());

describe('flat glass', () => {
  test('the bead\'s names are declared once and name the slab', () => {
    const map: Record<string, string> = {
      '--btn-gloss': 'var(--slab-face)', '--btn-sheen': 'var(--slab-face)', '--btn-sheen-hover': 'var(--slab-face-hover)',
      '--btn-ring': 'var(--slab-lights-long), var(--slab-wall)', '--btn-rim': 'var(--slab-facet)', '--btn-rim-press': 'var(--slab-facet-press)',
      '--btn-lift': 'var(--slab-edge), var(--slab-lip), var(--slab-drop)',
      '--btn-lift-hover': 'var(--slab-edge), var(--slab-lip), var(--slab-drop-hover)',
      '--btn-lift-press': 'var(--slab-edge), var(--slab-drop)',
    };
    for (const [name, value] of Object.entries(map)) expect(decls(tokens, name)).toEqual([value]);
    // No bead left anywhere: no radial glint, no caustic pool, no domed knob.
    for (const name of ['--btn-gloss', '--btn-caustic', '--btn-ring', '--thumb-bg', '--knob']) {
      for (const value of decls(tokens, name)) expect(value).not.toMatch(/radial-gradient/);
    }
    for (const [, css] of sheets) expect(css).not.toMatch(/radial-gradient\(42% 34% at 30% 10%|radial-gradient\(70% 30% at 50% 112%/);
  });

  test('every theme sets the slab, light and dark; long slabs are lit along their length, not round a centre', () => {
    for (const selector of ['.cdp {', '.cdp[data-theme="charcoal"] {']) {
      const at = tokens.indexOf('\n' + selector);
      const body = tokens.slice(at, tokens.indexOf('\n}', at));
      for (const name of ['--slab-face', '--slab-lights', '--slab-lights-long', '--slab-wall', '--slab-facet', '--slab-edge', '--slab-lip', '--slab-drop']) {
        expect(body).toContain(name + ':');
      }
      expect(decls(body, '--slab-lights-long')[0]).not.toMatch(/conic/);
    }
    expect(components).toContain('.cdp .cdp-btn--primary::before { background: var(--slab-lights-long), var(--crystal-wall); }');
    // Pills and chips: the wall at one fixed width and the facet line inside it.
    expect(decls(tokens, '--pill-wall')).toEqual(['2.25px']);
    expect(components).toMatch(/padding: var\(--wall, 1\.25px\)/);
  });

  test('disabled fades by one amount for controls and one for rows of text', () => {
    expect(decls(tokens, '--o-disabled')).toEqual(['0.42']);
    expect(decls(tokens, '--o-disabled-row')).toEqual(['0.5']);
    for (const [file, css] of sheets) {
      for (const m of css.matchAll(/:disabled[^{]*\{([^}]*)\}/g)) {
        const opacity = /opacity:\s*([^;]+)/.exec(m[1])?.[1].trim();
        if (opacity === undefined || opacity.startsWith('0 ')) continue;       // a drag grip hides outright
        expect(`${file}: ${opacity}`).toMatch(/var\(--o-disabled(-row)?\)$/);
      }
    }
  });

  test('the checkbox is the native input drawn as flat glass, and the system control in high contrast', () => {
    const at = components.indexOf('\n.cdp input[type="checkbox"] {');
    const rule = components.slice(at, components.indexOf('}', at));
    expect(rule).toContain('appearance: none;');
    expect(rule).toMatch(/inset 0 0 0 1\.25px color-mix\(in srgb, var\(--ink-2\) 70%, transparent\)/);   // an edge that reads when off
    expect(components).toContain('.cdp input[type="checkbox"]:checked::after {');
    expect(components).toMatch(/:checked::after \{[^}]*background: var\(--on-accent\);/);
    expect(components).toContain('.cdp input[type="checkbox"]:disabled { opacity: var(--o-disabled); cursor: default; }');
    const forced = components.slice(components.indexOf('@media (forced-colors: active) {\n  .cdp .cdp-seg'));
    expect(forced).toContain('.cdp input[type="checkbox"] { appearance: auto; -webkit-appearance: auto; background: none; box-shadow: none; }');
    expect(forced).toContain('.cdp input[type="checkbox"]::after { display: none; }');
    expect(forced).toContain('.cdp .cdp-btn::after, .cdp .cdp-chip::after { display: none; }');
  });

  test('motion stays on the shared scale; the only raw timings are the lyric pacing and the spinner\'s grace delay', () => {
    const allowed = new Set(['src/ui/views/LyricsPanel.module.css', 'src/ui/components/Transport.module.css']);
    for (const [file, css] of sheets) {
      const raw = [...css.matchAll(/(?:transition|animation)[^;{]*?(?<![\d.])(\d+)ms/g)].map(m => m[1]);
      if (!allowed.has(file.replaceAll('\\', '/'))) expect(`${file}: ${raw.join(',')}`).toBe(`${file}: `);
    }
    expect(read('src/ui/views/MiniSurface.module.css')).toContain('.card[data-entering="true"] { animation: riseIn var(--d-base) var(--ease-out); }');
    // Reduced motion still collapses every duration on the scale.
    const reduced = tokens.slice(tokens.indexOf('\n.cdp[data-motion="reduced"] {'));
    for (const d of ['--d-fast', '--d-base', '--d-slow']) expect(reduced.slice(0, reduced.indexOf('}'))).toContain(`${d}: 0.01ms;`);
  });
});
