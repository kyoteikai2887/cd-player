"""Rebuild the bundled UI fonts (Claude, R1.1).

Four families, all SIL OFL 1.1 (licences in ../OFL-*.txt):
  Noto Sans CJK 2.004  (= Source Han Sans)   NotoSansCJK-{Regular,Medium}.ttc
  Noto Serif CJK 2.002 (= Source Han Serif)  NotoSerifCJK-{Regular,Medium}.ttc
      https://github.com/notofonts/noto-cjk  (collection order: 0 JP, 1 KR, 2 SC, 3 TC, 4 HK)
  Instrument Serif 1.000  InstrumentSerif-Regular.ttf  https://github.com/Instrument/instrument-serif
  Crimson Pro 1.003       CrimsonPro-Regular.ttf       https://github.com/Fonthausen/CrimsonPro

Requires fontTools and brotli (pip install fonttools brotli). Put all source files in one
directory and run:
    python build_fonts.py <source dir> <output dir> [job names, e.g. serif-jp-500]

Roles (see ../../styles/fonts.css):
  sans  — interface text, lists, numbers          SC 400/500, JP 400/500
  serif — lyrics, titles and other reading text   SC 400/500, JP 500
  Latin — Instrument Serif for display sizes, Crimson Pro for text sizes; they precede the CJK
          serif in the CSS stacks, so Latin in titles and lyrics is set in a slender serif.

Character coverage is derived from Python codecs so the result is reproducible:
  SC 400: GB 2312 (6763 hanzi); SC 500: GB 2312 level 1 (3755)
  JP: CP932 kanji (JIS X 0208 levels 1+2 and extensions, 6716) — ACG titles and lyrics often
      need level-2 kanji (絆, 翔, 儚, 煌, 凛, 刹那 ...)
  CJK common: Latin, Latin-1, Latin Extended-A, Greek, punctuation, arrows, enclosed numbers,
      shapes and symbols, CJK punctuation, full/half-width forms; JP also kana.
  Latin faces: Basic Latin, Latin-1, Latin Extended-A, general punctuation, currency.
Characters outside a subset fall back per character to the next font in the CSS stack.
CJK files keep only: ccmp kern palt halt vert vrt2 vpal vhal vkrn ('locl' is dropped on
purpose: regional forms come from separate SC and JP files). Latin files keep all features.
"""
import os
import sys
from fontTools import subset
from fontTools.ttLib import TTCollection, TTFont


def rng(a, b):
    return [chr(c) for c in range(a, b + 1)]


def enc(ch, codec):
    try:
        return ch.encode(codec)
    except Exception:
        return None


HAN = rng(0x3400, 0x9FFF) + rng(0xF900, 0xFAFF)
COMMON = (rng(0x20, 0x7E) + rng(0xA0, 0x17F) + rng(0x370, 0x3FF) + rng(0x2000, 0x206F) + rng(0x2100, 0x218F)
          + rng(0x2190, 0x21FF) + rng(0x2460, 0x24FF) + rng(0x25A0, 0x27BF) + rng(0x3000, 0x303F)
          + rng(0x3200, 0x32FF) + rng(0xFE30, 0xFE4F) + rng(0xFF00, 0xFFEF))
KANA = rng(0x3040, 0x30FF) + rng(0x31F0, 0x31FF)
GB2312 = [c for c in HAN if enc(c, 'gb2312')]
GB2312_L1 = [c for c in GB2312 if 0xB0 <= enc(c, 'gb2312')[0] <= 0xD7]
CP932 = [c for c in HAN if enc(c, 'cp932')]
LATIN = rng(0x20, 0x7E) + rng(0xA0, 0x17F) + rng(0x2010, 0x2027) + rng(0x2030, 0x203A) + ['€', '™']

CJK_FEATURES = ['ccmp', 'kern', 'palt', 'halt', 'vert', 'vrt2', 'vpal', 'vhal', 'vkrn']
REGION_INDEX = {'jp': 0, 'sc': 2}
CJK_WEIGHT = {400: 'Regular', 500: 'Medium'}

# name: (source file, collection index or None, characters, features)
JOBS = {}
for region, weight, chars in [('sc', 400, COMMON + GB2312), ('sc', 500, COMMON + GB2312_L1),
                              ('jp', 400, COMMON + KANA + CP932), ('jp', 500, COMMON + KANA + CP932)]:
    JOBS[f'noto-sans-cjk-{region}-{weight}'] = (f'NotoSansCJK-{CJK_WEIGHT[weight]}.ttc', REGION_INDEX[region], chars, CJK_FEATURES)
for region, weight, chars in [('sc', 400, COMMON + GB2312), ('sc', 500, COMMON + GB2312_L1),
                              ('jp', 500, COMMON + KANA + CP932)]:
    JOBS[f'noto-serif-cjk-{region}-{weight}'] = (f'NotoSerifCJK-{CJK_WEIGHT[weight]}.ttc', REGION_INDEX[region], chars, CJK_FEATURES)
JOBS['instrument-serif-400'] = ('InstrumentSerif-Regular.ttf', None, LATIN, ['*'])
JOBS['crimson-pro-400'] = ('CrimsonPro-Regular.ttf', None, LATIN, ['*'])


def build(src_dir, out_dir, only=None):
    os.makedirs(out_dir, exist_ok=True)
    for name, (source, index, chars, features) in JOBS.items():
        if only and name not in only:
            continue
        path = os.path.join(src_dir, source)
        font = TTCollection(path).fonts[index] if index is not None else TTFont(path)
        options = subset.Options()
        options.flavor = 'woff2'
        options.layout_features = features
        options.name_IDs = ['*']          # keep copyright, licence and version strings
        options.name_languages = ['*']
        options.notdef_outline = True
        options.hinting = False
        options.drop_tables += ['DSIG']
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=sorted({ord(c) for c in chars}))
        subsetter.subset(font)
        font.flavor = 'woff2'
        out = os.path.join(out_dir, f'{name}.woff2')
        font.save(out)
        print(out, os.path.getsize(out))


if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2], set(sys.argv[3:]) or None)
