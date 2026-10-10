/**
 * V1.1 final polish (Claude): the memorial figures are made from Codex's revised drawing and stand
 * back to back (arrangement B). The mirror is taken on the figure itself, before its walls, light
 * and metal are worked out, so the light still comes from the upper left; the text, the screws
 * and the original drawings are untouched. Arrangement A (both facing the same way) is one
 * argument away: `python3 preview/memorial-plates/export.py src/ui/assets/memorial same`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const exporter = readFileSync('preview/memorial-plates/export.py', 'utf8');

describe('memorial arrangement', () => {
  test('published memorial assets exactly match the approved back-to-back release', () => {
    expect(sha('src/ui/assets/memorial/memorial-etch-cut.webp')).toBe('7f30a90d3e5710f4d2a829b3c00d608188456257c3e50f2c03f1ee167996de9a');
    expect(sha('src/ui/assets/memorial/memorial-etch-light.webp')).toBe('785f301e70593ccc0d1cf9cea35ebf1ea39b67520ef9605e66fd398be4458c6d');
    expect(sha('src/ui/assets/memorial/memorial-etch.webp')).toBe('9b27c19ebe9ef41ddf1e0e0789d8f8c8dd431254dca6d580b0e34bd6d4f98552');
    expect(sha('src/ui/assets/memorial/memorial-plate-blue.webp')).toBe('9a47abc496610c9859142a67af3ca23217114aa0b80fa39f4558990e83eca906');
    expect(sha('src/ui/assets/memorial/memorial-plate-silver.webp')).toBe('632dc81caca7f338817083d5232e944301c7673647167dc8bc93fcc2c25034ae');
    expect(sha('src/ui/assets/memorial/memorial-plate.webp')).toBe('366f04133cf7da741e0e4ca32e7f602c7d9f70c10e0764e8a029d4ffd2d078b3');
  });

  test('back to back by default, the same way on request, nothing else', () => {
    expect(exporter).toContain("ARRANGEMENT = sys.argv[2] if len(sys.argv) > 2 else 'back'");
    expect(exporter).toContain("assert ARRANGEMENT in ('back', 'same'), ARRANGEMENT");
    expect(exporter).toContain("MIRROR_CLAUDE = ARRANGEMENT == 'back'");
  });

  test('the mirror is taken on the figure before relief and light; the light and the text are never flipped', () => {
    // The plate: the Claude figure is flipped inside figure(), before its relief is shaded.
    expect(exporter).toContain("figure(cv, 'claude', fx2, top, fh, 'copper', lift=0.35, base=0.0, flip=MIRROR_CLAUDE)");
    expect(readFileSync('preview/memorial-plates/relief.py', 'utf8')).toMatch(/if flip: hh, a = hh\[:, ::-1\], a\[:, ::-1\]/);
    // The etching: the flipped silhouette goes into the height maps; lighting() runs on those maps afterwards.
    const maps = exporter.indexOf('h2, a2 = claude_silhouette(fh)');
    const light = exporter.indexOf('s = lighting(');
    expect(maps).toBeGreaterThan(-1);
    expect(light).toBeGreaterThan(maps);
    // Nothing downstream of the figures is mirrored: no flip of the canvas, the text or the light.
    expect(exporter.match(/\[:, ::-1\]/g)).toHaveLength(2);                    // only inside claude_silhouette
    expect(exporter).not.toMatch(/fliplr|ImageOps\.mirror|FLIP_LEFT_RIGHT/);
  });
});
