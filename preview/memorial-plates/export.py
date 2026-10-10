"""Exports the runtime images for the memorial plates (Claude, core.27) into src/ui/assets/memorial/:
  memorial-plate.webp         the equipment plate for the instrumental lyrics pane, graphite (灰黑), 3x of 360x240 CSS px
  memorial-plate-silver.webp  the same plate in brushed silver (纸白)
  memorial-plate-blue.webp    the same plate in cold blue-silver (阿根廷蓝)
  memorial-etch.webp          the walls of the stage etching on charcoal, 3x of ~141x112 CSS px
  memorial-etch-light.webp    the same walls for the pale papers
  memorial-etch-cut.webp      the etching's cut as an alpha mask (where the page drops its grain)

Usage (from the repository root):  python3 preview/memorial-plates/export.py src/ui/assets/memorial [back|same]
  back (default, V1.1 final polish)  Codex on the left facing left as drawn, Claude mirrored to face right:
                                     back to back. The mirror is applied to Claude's silhouette (tones and
                                     coverage) before any relief, lighting, metal or text is computed, so the
                                     light still falls from the upper left and the screws and words read as before.
  same                               both facing left as drawn (the V1.1 rc layout), for the A/B comparison.
Needs numpy, opencv-python and Pillow (with WebP). Sources: source/codex.png (Codex's transparent cut-out
of the user's artwork), source/claude.png (the user's artwork as given), text/line.png (the engraved
line, set in the app's Crimson Pro by text/textmask.mjs). Authoring only; the app never imports this.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, cv2
from PIL import Image
from relief import *

ARRANGEMENT = sys.argv[2] if len(sys.argv) > 2 else 'back'
assert ARRANGEMENT in ('back', 'same'), ARRANGEMENT
MIRROR_CLAUDE = ARRANGEMENT == 'back'
# Placement inside each half: how far each figure sits from its half's centre, as a fraction of the
# plate width (positive = towards the middle). Back to back, the two backs of hair meet in the middle,
# so they are drawn a little apart instead of a little together; the stage etching widens its gap.
PLATE_SHIFT = {'same': (0.02, 0.02), 'back': (-0.005, -0.005)}[ARRANGEMENT]
ETCH_GAP = {'same': 0.06, 'back': 0.10}[ARRANGEMENT]

def claude_silhouette(box_h):
    """Claude's silhouette in the arrangement's direction (the source file is never changed)."""
    hh, a = silhouette('claude', box_h)
    return (np.ascontiguousarray(hh[:, ::-1]), np.ascontiguousarray(a[:, ::-1])) if MIRROR_CLAUDE else (hh, a)

# Plate finishes (V1.1): graphite for 灰黑 (the core.27 plate, unchanged), brushed silver for 纸白 and
# cold blue-silver for 阿根廷蓝. On the black plate Codex is laser-engraved to bare silver; on the pale
# plates there is no bare metal to reveal, so Codex is engraved and filled in a dark enamel ramp
# instead, the figure's tones kept the same way round. Claude stays copper inlay on all three.
METALS['silver'] = dict(field=c((196, 200, 207)), dark=c((60, 64, 72)), mid=c((150, 156, 166)), hi=c((236, 239, 244)), ks=0.55)
METALS['blueSilver'] = dict(field=c((160, 180, 203)), dark=c((54, 70, 96)), mid=c((124, 146, 174)), hi=c((226, 236, 247)), ks=0.55)
METALS['steelDark'] = dict(field=c((92, 98, 108)), dark=c((34, 37, 43)), mid=c((120, 127, 138)), hi=c((200, 206, 216)), ks=0.6)
FINISH = {
    'graphite': dict(plate='black', brush=0.08, screw='steel', mode='laser',
                     rule=METALS['black']['mid'], text=METALS['black']['hi'] * 0.92),
    'silver': dict(plate='silver', brush=0.04, screw='steelDark', mode='enamel',
                   enamel=(c((40, 44, 52)), c((110, 116, 126)), c((238, 241, 245))),
                   rule=c((108, 114, 124)), text=c((52, 57, 66))),
    'blue': dict(plate='blueSilver', brush=0.04, screw='steelDark', mode='enamel',
                 enamel=(c((26, 40, 62)), c((92, 114, 142)), c((232, 240, 249))),
                 rule=c((82, 102, 130)), text=c((28, 44, 68))),
}

def style_faceplate(T, finish='graphite'):
    """C · 器材铭牌：面板（石墨黑阳极氧化 / 拉丝银 / 冷银蓝），Codex 刻（激光或填漆），Claude 铜镶嵌，四颗螺丝。"""
    F = FINISH[finish]
    H = T; W = int(T * 1.5)
    cv = Canvas(W + 16, H + 16); o = 8 * SS
    plate_body(cv, o, o, W * SS, H * SS, F['plate'], radius=int(H * 0.05 * SS), bevel=int(max(2, H * 0.015) * SS), seed=11, brush=F['brush'])
    sd = int(H * 0.055)
    for (fx, fy) in [(0.045, 0.06), (0.955, 0.06), (0.045, 0.94), (0.955, 0.94)]:
        screw(cv, o + int((fx * W - sd / 2) * SS), o + int((fy * H - sd / 2) * SS), sd * SS, F['screw'])
    fh = int(H * 0.70 * SS); top = o + int(H * 0.07 * SS)
    half = W * SS // 2
    hh, a = silhouette('codex', fh)
    fx = o + int(W * 0.06 * SS) + (half - int(W * 0.06 * SS) - hh.shape[1]) // 2 + int(W * PLATE_SHIFT[0] * SS)
    lev = hh.clip(0, 1)
    (dst, src) = cv.region(fx, top, a)
    if F['mode'] == 'laser':
        # Codex: laser-engraved into the anodising (bare silver revealed, slightly below the surface)
        G = METALS['black']
        col = np.where(lev[..., None] < 0.5, G['dark'][None, None, :] * np.ones_like(lev)[..., None],
                       G['mid'] + (G['hi'] - G['mid']) * ((lev - 0.5) / 0.5).clip(0, 1)[..., None])
        mask = a * (lev > 0.45)
        m = cv2.GaussianBlur(mask, (0, 0), 0.35 * SS)[src]
        cv.H[dst] -= 0.25 * m
        cv.C[dst] = cv.C[dst] * (1 - m[..., None]) + col[src] * m[..., None]
        cv.K[dst] = cv.K[dst] * (1 - m) + 0.5 * m
    else:
        # Codex: engraved and enamel-filled, dark tones dark, light tones a pale polished fill
        d0, d1, d2 = F['enamel']
        t = lev[..., None]
        col = np.where(t < 0.5, d0 + (d1 - d0) * (t / 0.5).clip(0, 1), d1 + (d2 - d1) * ((t - 0.5) / 0.5).clip(0, 1))
        m = cv2.GaussianBlur(a, (0, 0), 0.35 * SS)[src]
        cv.H[dst] -= 0.18 * m
        cv.C[dst] = cv.C[dst] * (1 - m[..., None]) + col[src] * m[..., None]
        cv.K[dst] = cv.K[dst] * (1 - m) + 0.35 * m
        # a fine filled outline, so the pale hair still parts from the pale plate
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * SS + 1, 2 * SS + 1))
        edge = np.clip(cv2.dilate(a, k) - cv2.erode(a, k), 0, 1)
        e = cv2.GaussianBlur(edge, (0, 0), 0.4 * SS)[src] * 0.55
        cv.C[dst] = cv.C[dst] * (1 - e[..., None]) + d1 * e[..., None]
    # Claude: copper inlay, slightly proud of the face
    hh2, a2 = claude_silhouette(fh)
    fx2 = o + half + (half - int(W * 0.06 * SS) - hh2.shape[1]) // 2 - int(W * PLATE_SHIFT[1] * SS)
    figure(cv, 'claude', fx2, top, fh, 'copper', lift=0.35, base=0.0, flip=MIRROR_CLAUDE)
    # engraved rule and line
    ly = o + int(H * 0.80 * SS)
    rule = np.zeros((max(1, SS), int(W * 0.78 * SS)), np.float32) + 1
    engrave(cv, rule, o + int(W * 0.11 * SS), ly, depth=0.25, fill=F['rule'])
    m = text_mask('line', int(H * 0.055 * SS))
    if m.shape[1] > W * SS * 0.8: m = cv2.resize(m, (int(W * SS * 0.8), int(m.shape[0] * W * SS * 0.8 / m.shape[1])), interpolation=cv2.INTER_AREA)
    engrave(cv, m, o + (W * SS - m.shape[1]) // 2, o + int(H * 0.855 * SS), depth=0.3, fill=F['text'])
    return cv

def smooth_below(x, t, w=0.05):
    """1 where x is clearly below t, 0 clearly above, a short ramp between (anti-aliased tier edge)."""
    return np.clip((t - x) / w + 0.5, 0, 1).astype(np.float32)

def clean_floor(m, area):
    """A terrace as a clean binary floor: islands and holes smaller than `area` (supersampled px) go,
    but thin, long shapes — a strand of hair, the edge of a fold — stay (V1.1 round 2). A morphological
    opening did this before and erased exactly those thin shapes along with the specks."""
    b = (m > 0.5).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(b, 8)
    keep = np.zeros(n, bool); keep[1:] = st[1:, 4] >= area; b = keep[lab].astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(1 - b, 4)
    fill = np.zeros(n, bool); fill[1:] = st[1:, 4] < area; b = np.maximum(b, fill[lab].astype(np.uint8))
    return b.astype(np.float32)

def main_lines(hh, a, inner, k=4 * SS + 1, threshold=0.10, area=60):
    """The figure's main drawn lines (hair partings, folds, the profile): thin features darker than
    what is round them (a black-hat of the artwork's own tones), long enough to be structure rather
    than texture, kept off the outline. They are cut as narrow grooves into the flat floor."""
    raw = hh.clip(0, 1) * a + (1 - a)
    bh = cv2.morphologyEx(raw, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1)))
    ln = np.clip((bh - threshold) / 0.08, 0, 1) * inner
    n, lab, st, _ = cv2.connectedComponentsWithStats((ln > 0.5).astype(np.uint8), 8)
    keep = np.zeros(n, bool); keep[1:] = st[1:, 4] >= area
    return cv2.GaussianBlur(ln * keep[lab], (0, 0), 0.3 * SS)

def etch_maps(T):
    """D · 玻璃蚀刻 (V1.1): flat-bottomed cuts. Each silhouette is cut in three terraces from its own
    tones (light tones shallow, mid deeper, dark deepest), so every floor is flat and polished and the
    relief is only the short walls between terraces and at the outline — and, from round 2, narrow
    grooves along the figure's main inner lines. Returns (terraces, text, inner lines, cut, interior)
    at supersampled px: depths >= 0 (deeper is larger), cut is the coverage of the cut area."""
    # The canvas keeps the width of the original layout (both figures at 0.80 T, a 0.06 T gap), so the
    # page's box, aspect ratio and the cut's alignment never change with the arrangement; a wider gap
    # makes the figures a little smaller instead, standing on the same baseline above the line.
    fh0 = int(T * 0.80 * SS)
    W = silhouette('codex', fh0)[0].shape[1] + int(T * 0.06 * SS) + silhouette('claude', fh0)[0].shape[1]
    gap = int(T * ETCH_GAP * SS)
    fh = fh0 if ETCH_GAP == 0.06 else int(fh0 * (W - gap) / (W - int(T * 0.06 * SS)))
    h1, a1 = silhouette('codex', fh); h2, a2 = claude_silhouette(fh)
    gap = W - h1.shape[1] - h2.shape[1]
    y0 = fh0 - fh
    Dm = np.zeros((T * SS, W), np.float32); Cm = np.zeros_like(Dm); Lm = np.zeros_like(Dm); Im = np.zeros_like(Dm)
    rim = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (4 * SS + 1, 4 * SS + 1))
    for hh, a, x in [(h1, a1, 0), (h2, a2, h1.shape[1] + gap)]:
        lev = cv2.GaussianBlur(hh.clip(0, 1), (0, 0), 0.5 * SS)
        cut = np.clip((a - 0.5) * 4 + 0.5, 0, 1)
        inner = cv2.erode(cut, rim)                                 # the interior, a little off the outline
        terraces = [cv2.GaussianBlur(clean_floor(smooth_below(lev, t) * cut, 60), (0, 0), 0.35 * SS) for t in (0.80, 0.42)]
        d = cut * 0.30 + 0.20 * terraces[0] + 0.20 * terraces[1]
        sl = (slice(y0, y0 + fh), slice(x, x + hh.shape[1]))
        Dm[sl] = np.maximum(Dm[sl], d); Cm[sl] = np.maximum(Cm[sl], cut); Im[sl] = np.maximum(Im[sl], inner)
        Lm[sl] = np.maximum(Lm[sl], main_lines(hh, a, inner))
    m = text_mask('line', int(T * 0.075 * SS))
    if m.shape[1] > W: m = cv2.resize(m, (W, int(m.shape[0] * W / m.shape[1])), interpolation=cv2.INTER_AREA)
    ty = int(T * 0.88 * SS); tx = (W - m.shape[1]) // 2
    # The line is cut on its own map: its strokes are a few px wide, so it takes a deeper cut and a
    # tighter bevel than the figures to keep its walls (and so its words) as legible as before.
    Tm = np.zeros_like(Dm)
    Tm[ty:ty + m.shape[0], tx:tx + m.shape[1]] = 1.0 * m
    Cm[ty:ty + m.shape[0], tx:tx + m.shape[1]] = np.maximum(Cm[ty:ty + m.shape[0], tx:tx + m.shape[1]], m)
    return Dm, Tm, Lm, Cm, Im

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

# ── Plate: no baked shadow (the page draws it), margin cropped ──
T = 720
for finish, name in [('graphite', 'memorial-plate.webp'), ('silver', 'memorial-plate-silver.webp'), ('blue', 'memorial-plate-blue.webp')]:
    cv = style_faceplate(T, finish)
    img = to_image(shade(cv))
    m = 8
    img = img.crop((m, m, img.width - m, img.height - m))
    img.save(f'{out}/{name}', 'WEBP', quality=86, method=6, alpha_quality=100)
    print(name, img.size, os.path.getsize(f'{out}/{name}'))

# ── Etching (V1.1): walls only, a separate cut mask; the floors are left to the page ──
# The page lays the frosted surface (grain and paper) everywhere except inside the cut mask, and a thin
# smooth veil inside it, so the floors are flat, polished and a little clearer than the frost around.
T = 336
Dm, Tm, Lm, Cm, Im = etch_maps(T)
D_ = 2.0 * SS
def lighting(height, bevel):
    Hs = cv2.GaussianBlur(-height, (0, 0), bevel)
    gx = cv2.Sobel(Hs * D_, cv2.CV_32F, 1, 0, ksize=3) / 8; gy = cv2.Sobel(Hs * D_, cv2.CV_32F, 0, 1, ksize=3) / 8
    n = np.dstack([-gx, -gy, np.ones_like(Hs)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    return (n @ LIGHT) / LIGHT[2] - 1                             # 0 on every flat floor and on the surface
# Round 2: the terrace walls take a tighter bevel (0.9 → 0.65 supersampled px per SS) and read a
# quarter stronger inside the figure than at its outline; the inner lines are narrow grooves with
# the tightest bevel, so both their walls — one lit, one shaded — survive the 3× reduction on screen.
inside = 1 + 0.25 * cv2.GaussianBlur(Im, (0, 0), 1.0 * SS)
s = lighting(Dm, 0.65 * SS) * inside + lighting(Tm, 0.5 * SS) + lighting(0.22 * Lm, 0.4 * SS)
h, w = Dm.shape
small = lambda x: cv2.resize(x, (w // SS, h // SS), interpolation=cv2.INTER_AREA)
s_s, c_s = small(s), small(Cm)

def save(name, rgba, q=90, lossless=False):
    im = Image.fromarray((rgba * 255).round().clip(0, 255).astype(np.uint8), 'RGBA')
    if lossless: im.save(f'{out}/{name}', 'WEBP', lossless=True, quality=100, method=6)
    else: im.save(f'{out}/{name}', 'WEBP', quality=q, method=6, alpha_quality=100)
    print(name, rgba.shape[1::-1], os.path.getsize(f'{out}/{name}'))

def walls(name, shade_rgb, shade_amt, lit_amt):
    """The walls of the cut: the ones turned from the light in `shade_rgb`, the ones facing it in white."""
    d = np.clip(shade_amt * np.clip(-s_s, 0, None), 0, 1); l = np.clip(lit_amt * np.clip(s_s, 0, None), 0, 1)
    alpha = np.clip(d + l, 0, 1); tot = np.maximum(d + l, 1e-4)[..., None]
    rgb = (shade_rgb * d[..., None] + 1.0 * l[..., None]) / tot
    save(name, np.dstack([rgb, alpha]), lossless=True)   # exact thin walls, and smaller than lossy here

walls('memorial-etch.webp', np.array([0.0, 0.0, 0.0]), 0.95, 1.25)                  # charcoal
walls('memorial-etch-light.webp', np.array([15, 45, 80]) / 255, 0.7, 0.95)        # the pale papers
# The cut itself, as an alpha mask (white): where the page drops its grain and thins its frost.
save('memorial-etch-cut.webp', np.dstack([np.ones_like(c_s), np.ones_like(c_s), np.ones_like(c_s), c_s]), q=80)
