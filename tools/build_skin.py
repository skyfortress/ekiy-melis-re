"""Apply a skin spec to a UI layout file (DATAV1.0, e.g. apps/UI2/Data/Main.data).

Image blobs: 0x20-byte header {0x20, width, height, 1, 3, payload_ptr, 1, 0} followed by
zlib (level 9 reproduces the original bytes) of width*height BGRA pixels.

Spec (JSON):
  {"images": {"<index>": "<png path, relative to the spec file>", ...},
   "rects":  [{"window": w, "child": c, "xywh": [x, y, w, h]}, ...],
   "fields": [{"window": w, "child": c, "off": "0x2c4", "u32": "0xffffff"}, ...]}
`child` indexes Window.children() of window `w` (same order as tools/uidata.py lists them);
child -1 means the window record itself. Coordinates of children are window-relative. `fields` pokes raw u32s at a record offset
(e.g. button label colours, stored 0x00BBGGRR).

usage: build_skin.py <base.data> <spec.json> <out.data>
"""
import json
import struct
import sys
import zlib
from pathlib import Path

from PIL import Image

from uidata import UiData, U


def encode_image(png: Image.Image) -> bytes:
    im = png.convert('RGBA')
    w, h = im.size
    payload = zlib.compress(im.tobytes('raw', 'BGRA'), 9)
    return struct.pack('<8I', 0x20, w, h, 1, 3, 0, 1, 0) + payload   # ptr is set by UiData.build()


def decode_image(blob: bytes) -> Image.Image:
    hdr = U(blob, 0)
    w, h = struct.unpack_from('<2I', blob, 4)
    return Image.frombytes('RGBA', (w, h), zlib.decompress(blob[hdr:]), 'raw', 'BGRA')


def main(base, spec_path, out):
    spec_path = Path(spec_path)
    spec = json.loads(spec_path.read_text())
    d = UiData(Path(base).read_bytes())
    for idx, png in spec.get('images', {}).items():
        i = int(idx)
        assert 0 <= i < len(d.images), i
        d.images[i] = encode_image(Image.open(spec_path.parent / png))
    for r in spec.get('rects', []):
        w, wbase = d.windows[r['window']]
        rel = 0 if r['child'] == -1 else w.children(wbase)[r['child']][1]
        struct.pack_into('<4i', w.raw, rel + 0xd4, *r['xywh'])
    for f in spec.get('fields', []):
        w, wbase = d.windows[f['window']]
        rel = 0 if f['child'] == -1 else w.children(wbase)[f['child']][1]
        struct.pack_into('<I', w.raw, rel + int(f['off'], 0), int(f['u32'], 0))
    data = d.build()
    Path(out).write_bytes(data)
    # sanity: reparse and decode every replaced image
    chk = UiData(data)
    for idx, png in spec.get('images', {}).items():
        a = decode_image(chk.images[int(idx)])
        assert a.tobytes() == Image.open(spec_path.parent / png).convert('RGBA').tobytes(), idx
    print(f'{out}: {len(data)} bytes ({len(data) - len(d.d):+d}), {len(spec.get("images", {}))} images, '
          f'{len(spec.get("rects", []))} rects')


if __name__ == '__main__':
    main(*sys.argv[1:4])
