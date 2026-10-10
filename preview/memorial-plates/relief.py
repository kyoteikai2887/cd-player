"""Relief renderer for the memorial plates (Claude, core.27). Authoring tool only: nothing here is
imported by the app or the preview, and the build does not see it.
Everything is built as height (H), albedo (C, RGB 0-1), coverage (A) at supersampled resolution,
then lit from the upper left and downsampled."""
import numpy as np, cv2, math, os
from PIL import Image

D = os.path.dirname(os.path.abspath(__file__))
SS = 3                        # supersampling
LIGHT = np.array([-0.5, -0.8, 1.1]); LIGHT = LIGHT / np.linalg.norm(LIGHT)

def c(rgb): return np.array(rgb, np.float32) / 255.0

METALS = {
    'gun':    dict(field=c((66, 71, 80)),  dark=c((24, 26, 31)), mid=c((96, 103, 114)), hi=c((186, 194, 206)), ks=0.55),
    'copper': dict(field=c((128, 74, 43)), dark=c((50, 26, 15)), mid=c((172, 98, 56)),  hi=c((240, 176, 126)), ks=0.6),
    'black':  dict(field=c((30, 31, 34)),  dark=c((16, 16, 18)), mid=c((150, 154, 160)), hi=c((214, 218, 224)), ks=0.45),
    'steel':  dict(field=c((120, 126, 134)), dark=c((44, 47, 53)), mid=c((140, 147, 157)), hi=c((215, 221, 230)), ks=0.6),
}

_SIL = {}
def _levels(name):
    """Tone levels of a silhouette: its darkest tone lowest, its lightest highest (0.22 … 1)."""
    if name not in _SIL:
        im = np.asarray(Image.open(f'{D}/source/{name}.png').convert('RGBA')).astype(np.float32)
        a = im[..., 3] / 255
        if name == 'codex':      # drop the specks the transparent cut-out leaves outside the figure
            n, lab, st, _ = cv2.connectedComponentsWithStats((a > 0.02).astype(np.uint8), 8)
            keep = np.zeros(n, bool); keep[1:] = st[1:, 4] >= 60; a = a * keep[lab]
        L = 0.299 * im[..., 0] + 0.587 * im[..., 1] + 0.114 * im[..., 2]
        h = (np.interp(L, [60, 110, 190, 236, 246], [0.22, 0.32, 0.62, 0.9, 1.0]) if name == 'codex'
             else np.interp(L, [30, 80, 131, 190, 224], [0.22, 0.35, 0.62, 0.85, 1.0]))
        _SIL[name] = (h.astype(np.float32), a.astype(np.float32))
    return _SIL[name]

def silhouette(name, box_h):
    """Height (0..1) and alpha of a silhouette scaled to box_h (supersampled px)."""
    h, a = _levels(name)
    s = box_h / h.shape[0]; w = int(round(h.shape[1] * s))
    h = cv2.resize(h * a, (w, box_h), interpolation=cv2.INTER_AREA)
    a = cv2.resize(a, (w, box_h), interpolation=cv2.INTER_AREA)
    hh = np.where(a > 1e-3, h / np.maximum(a, 1e-3), 0)
    return hh.astype(np.float32), a.astype(np.float32)

def text_mask(name, height):
    im = np.asarray(Image.open(f'{D}/text/{name}.png').convert('RGBA'))[..., 3].astype(np.float32) / 255
    ys, xs = np.nonzero(im > 0.05); im = im[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    s = height / im.shape[0]
    return cv2.resize(im, (max(1, int(round(im.shape[1] * s))), height), interpolation=cv2.INTER_AREA)

class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w * SS, h * SS
        self.H = np.zeros((self.h, self.w), np.float32)
        self.C = np.zeros((self.h, self.w, 3), np.float32)
        self.A = np.zeros((self.h, self.w), np.float32)
        self.K = np.zeros((self.h, self.w), np.float32)    # specular strength
    def region(self, x, y, arr):
        """Slices for pasting arr with top-left at (x, y) in supersampled px (clipped)."""
        h, w = arr.shape[:2]
        x0, y0 = max(0, x), max(0, y); x1, y1 = min(self.w, x + w), min(self.h, y + h)
        return (slice(y0, y1), slice(x0, x1)), (slice(y0 - y, y1 - y), slice(x0 - x, x1 - x))

def sdf_rrect(w, h, r):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32) + 0.5
    qx = np.abs(xx - w / 2) - (w / 2 - r); qy = np.abs(yy - h / 2) - (h / 2 - r)
    return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r

def sdf_circle(d):
    yy, xx = np.mgrid[0:d, 0:d].astype(np.float32) + 0.5
    return np.hypot(xx - d / 2, yy - d / 2) - d / 2

def brushed(h, w, seed, radial=False):
    rng = np.random.default_rng(seed)
    n = rng.standard_normal((h, w)).astype(np.float32)
    if radial:
        # concentric brushing: blur along the angle via polar warp
        R = max(h, w) / 2
        pol = cv2.warpPolar(n.astype(np.float32), (int(R), 720), (w / 2, h / 2), R, cv2.WARP_POLAR_LINEAR)
        pol = cv2.GaussianBlur(pol, (1, 0), sigmaX=0.6, sigmaY=14)
        n = cv2.warpPolar(pol, (w, h), (w / 2, h / 2), R, cv2.WARP_POLAR_LINEAR | cv2.WARP_INVERSE_MAP)
    else:
        n = cv2.GaussianBlur(n, (0, 0), sigmaX=40, sigmaY=0.6)
    n = np.nan_to_num(n, nan=0.0, posinf=0.0, neginf=0.0).clip(-50, 50)
    return (n / (n.std() + 1e-6)).clip(-4, 4)

def plate_body(cv, x, y, w, h, metal, shape='rrect', radius=None, bevel=None, seed=1, brush=0.05):
    """Adds a plate (raised slab with rounded bevel) of a metal."""
    M = METALS[metal]
    bevel = bevel or 3 * SS
    if shape == 'circle': sd = sdf_circle(w); h = w
    else: sd = sdf_rrect(w, h, radius if radius is not None else 8 * SS)
    cov = np.clip(0.5 - sd, 0, 1)
    rise = np.clip(-sd / bevel, 0, 1); rise = rise * rise * (3 - 2 * rise)
    tex = brushed(h, w, seed, radial=(shape == 'circle'))
    col = M['field'][None, None, :] * (1 + brush * tex[..., None])
    (dst, src) = cv.region(x, y, cov)
    a = cov[src]
    cv.H[dst] = cv.H[dst] * (1 - a) + (1.0 * rise[src]) * a
    cv.C[dst] = cv.C[dst] * (1 - a[..., None]) + col[src] * a[..., None]
    cv.A[dst] = np.maximum(cv.A[dst], a)
    cv.K[dst] = cv.K[dst] * (1 - a) + M['ks'] * a
    return sd

def recess(cv, x, y, w, h, depth=0.5, shape='rrect', radius=None, bevel=None, darken=0.82):
    bevel = bevel or 2 * SS
    sd = sdf_circle(w) if shape == 'circle' else sdf_rrect(w, h, radius if radius is not None else 5 * SS)
    if shape == 'circle': h = w
    m = np.clip(-sd / bevel, 0, 1); m = m * m * (3 - 2 * m)
    (dst, src) = cv.region(x, y, m)
    cv.H[dst] -= depth * m[src]
    cv.C[dst] *= (1 - (1 - darken) * m[src])[..., None]

def figure(cv, name, x, y, box_h, metal, lift=0.55, base=0.0, align='center', box_w=None, flip=False):
    """Relief of a silhouette, raised from the surface: dark tones lowest, light tones highest."""
    M = METALS[metal]
    hh, a = silhouette(name, box_h)
    if flip: hh, a = hh[:, ::-1], a[:, ::-1]
    if box_w is not None:
        if align == 'center': x = x + (box_w - hh.shape[1]) // 2
        elif align == 'right': x = x + box_w - hh.shape[1]
    lev = np.clip(hh, 0, 1)
    col = np.where(lev[..., None] < 0.62,
                   M['dark'] + (M['mid'] - M['dark']) * ((lev - 0.22) / 0.40).clip(0, 1)[..., None],
                   M['mid'] + (M['hi'] - M['mid']) * ((lev - 0.62) / 0.38).clip(0, 1)[..., None])
    hs = cv2.GaussianBlur(lev, (0, 0), 0.7 * SS)
    (dst, src) = cv.region(x, y, a)
    aa = a[src]
    cv.H[dst] = cv.H[dst] + (base + lift * hs[src]) * aa
    cv.C[dst] = cv.C[dst] * (1 - aa[..., None]) + col[src] * aa[..., None]
    cv.K[dst] = cv.K[dst] * (1 - aa) + (M['ks'] * (0.5 + 0.6 * lev[src])) * aa
    return hh.shape[1]

def engrave(cv, mask, x, y, depth=0.45, darken=0.5, fill=None):
    """Cuts a mask into the surface. fill: colour revealed in the cut (anodised plates show bare metal)."""
    m = cv2.GaussianBlur(mask, (0, 0), 0.35 * SS)
    (dst, src) = cv.region(x, y, m)
    mm = m[src]
    cv.H[dst] -= depth * mm
    if fill is None: cv.C[dst] *= (1 - (1 - darken) * mm)[..., None]
    else: cv.C[dst] = cv.C[dst] * (1 - mm[..., None]) + fill * mm[..., None]

def screw(cv, x, y, d, metal):
    sd = plate_body(cv, x, y, d, d, metal, shape='circle', bevel=d * 0.35, brush=0.0)
    slot = np.zeros((d, d), np.float32); t = max(1, d // 7)
    cv2.line(slot, (int(d * 0.22), int(d * 0.78)), (int(d * 0.78), int(d * 0.22)), 1.0, t, cv2.LINE_AA)
    engrave(cv, slot, x, y, depth=0.6, darken=0.35)

def shade(cv, depth_px=None, amb=0.4):
    D_ = depth_px or 2.2 * SS
    H = cv.H * D_
    gx = cv2.Sobel(H, cv2.CV_32F, 1, 0, ksize=3) / 8; gy = cv2.Sobel(H, cv2.CV_32F, 0, 1, ksize=3) / 8
    n = np.dstack([-gx, -gy, np.ones_like(H)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    ndl = (n @ LIGHT).clip(0, None); flat = LIGHT[2]
    diff = amb + (1 - amb) * ndl / flat
    half = LIGHT + np.array([0, 0, 1.0]); half /= np.linalg.norm(half)
    s = (n @ half).clip(0, None) ** 40 - half[2] ** 40
    rgb = cv.C * diff[..., None] + (cv.K * s.clip(0, None) * 0.9)[..., None]
    return np.dstack([rgb.clip(0, 1), cv.A])

def drop_shadow(rgba, dy=3, blur=4, alpha=0.5):
    a = rgba[..., 3]
    sh = cv2.GaussianBlur(np.roll(a, dy * SS, axis=0), (0, 0), blur * SS) * alpha
    out = np.zeros_like(rgba); out[..., 3] = sh
    # composite rgba over shadow
    A = rgba[..., 3:4]; ao = A[..., 0] + sh * (1 - A[..., 0])
    out[..., :3] = rgba[..., :3] * A / np.maximum(ao, 1e-6)[..., None]
    out[..., 3] = ao
    return out

def to_image(rgba):
    h, w = rgba.shape[:2]
    pre = rgba.copy(); pre[..., :3] *= pre[..., 3:4]
    small = cv2.resize(pre, (w // SS, h // SS), interpolation=cv2.INTER_AREA)
    a = small[..., 3:4]; rgb = np.where(a > 1e-4, small[..., :3] / np.maximum(a, 1e-4), 0)
    return Image.fromarray((np.dstack([rgb, a]) * 255).clip(0, 255).astype(np.uint8), 'RGBA')
