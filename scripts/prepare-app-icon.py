"""Convert the selected transparent master to Windows ICO; no creative image edits.

Requires Pillow. Run from any directory; reads only src-tauri/icons/memorial-master.png.
"""
from pathlib import Path
import hashlib
import json
import struct
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
folder = root / "src-tauri/icons"
master = Image.open(folder / "memorial-master.png").convert("RGBA")
assert master.width == master.height and master.width >= 512
assert master.getchannel("A").getextrema() == (0, 255)
sizes = [16, 24, 32, 48, 64, 128, 256]
master.save(folder / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes])
master.resize((256, 256), Image.Resampling.LANCZOS).save(folder / "memorial-preview.png")
ico = Image.open(folder / "icon.ico")
assert ico.ico.sizes() == {(s, s) for s in sizes}
for s in sizes:
    frame = ico.ico.getimage((s, s)).convert("RGBA")
    assert frame.getchannel("A").getextrema() == (0, 255)
    assert frame.getbbox() is not None
# A contact sheet shows the actual encoded frames on dark and light backgrounds.
sheet = Image.new("RGB", (740, 350), "#F0F2F5")
draw = ImageDraw.Draw(sheet)
for row, background in enumerate(["#F0F2F5", "#191C21"]):
    y = row * 175
    draw.rectangle((0, y, 739, y + 174), fill=background)
    x = 12
    for s in sizes[:-1]:
        frame = ico.ico.getimage((s, s)).convert("RGBA")
        sheet.paste(frame, (x, y + 32), frame)
        draw.text((x, y + 10), f"{s}px", fill="#57616D" if row == 0 else "#E1E6EC")
        x += max(s + 24, 65)
sheet.save(folder / "memorial-size-check.png")
data = (folder / "icon.ico").read_bytes()
reserved, kind, count = struct.unpack_from("<HHH", data)
assert (reserved, kind, count) == (0, 1, 7)
report = {"masterSize": list(master.size), "frames": sizes, "transparent": True,
          "icoSHA256": hashlib.sha256(data).hexdigest(),
          "masterSHA256": hashlib.sha256((folder / "memorial-master.png").read_bytes()).hexdigest(),
          "conversionOnly": True}
(folder / "icon-manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
