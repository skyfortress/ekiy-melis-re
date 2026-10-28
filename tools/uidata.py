"""Reader/writer for the EKIY UI layout files (apps/Data/*.data, "DATAV1.0").

Layout (all little-endian, offsets absolute):
  0x00  UTF-16 "DATAV1.0" + padding
  0x10  u32 H (header size: 0x18 or 0x20), 0x14 u32 image_section_offset
  0x18  two u32 flags, present only when H == 0x20
  H     u32 image_section_offset - H
  H+4   u32 0x14, u32 0, u32 0       H+0x10 u32 width, u32 height
  H+0x18 u32 n_windows, then (n_windows + 3) x (u32 type, u32 offset):
        type 5 = window record, type 6 = trailing table (glyph map etc.)
  records ...
  image section: u32 count, count x (u32 offset, u32 payload_size), blobs

Each image blob starts with its own u32 header size (0x18 or 0x20),
followed by width, height, two format fields, and an absolute payload pointer
at +0x14. The 0x20 variant has eight additional header bytes, preserved as-is.
The table's payload size excludes the entire image header. All observed blobs
are contiguous and their payloads are complete zlib streams: the apparent
eight-byte gaps/trailers came from assuming a fixed 0x18-byte image header.
Black, WallPaper and ScreenOff use the shorter file header; this is independent
of image count. Empty input is supported as an empty passthrough.

Records start with u32 size, u32 hdr_size, UTF-16 name (0xc8 bytes), then x,y,w,h at +0xd4.
Windows keep a child count at +0xf4 and (type, offset) child pairs at +hdr+8.
Buttons (type 1) keep nested (type, offset) pairs: count at +0x104, pairs from +0x108.
"""
import struct

U = lambda b, o: struct.unpack_from('<I', b, o)[0]
I = lambda b, o: struct.unpack_from('<i', b, o)[0]


def rec_name(b, o):
    raw = bytes(b[o + 8:o + 8 + 0xc8])
    n = raw.find(b'\0\0')
    while n % 2:
        n = raw.find(b'\0\0', n + 1)
    return raw[:n].decode('utf-16le') if n >= 0 else ''


def set_name(b, o, name):
    enc = name.encode('utf-16le')
    assert len(enc) < 0xc8
    b[o + 8:o + 8 + 0xc8] = enc + b'\0' * (0xc8 - len(enc))


class Window:
    """A window record plus all its children, kept as raw bytes relative to the window start."""

    def __init__(self, raw: bytes, base: int):
        self.raw = bytearray(raw)
        self.ptrs = []  # offsets (relative) of u32 fields that hold absolute file offsets
        hdr = U(self.raw, 4)
        n = U(self.raw, 0xf4)
        for k in range(n):
            self._child(hdr + 8 + 8 * k, base)

    def _child(self, pair_rel, base):
        self.ptrs.append(pair_rel + 4)
        typ, off = U(self.raw, pair_rel), U(self.raw, pair_rel + 4)
        rel = off - base
        assert 0 <= rel < len(self.raw), (hex(off), hex(base))
        if typ == 1 and U(self.raw, rel) > 0x108:
            for k in range(U(self.raw, rel + 0x104)):
                self._child(rel + 0x108 + 8 * k, base)

    def children(self, base=0):
        """(type, relative offset) of every record in the tree."""
        out = []
        for p in self.ptrs:
            out.append((U(self.raw, p - 4), U(self.raw, p) - base))
        return out

    def rebased(self, old_base, new_base):
        b = bytearray(self.raw)
        for p in self.ptrs:
            struct.pack_into('<I', b, p, U(b, p) - old_base + new_base)
        return bytes(b)


class UiData:
    def __init__(self, data: bytes):
        d = self.d = bytes(data)
        self.windows = []   # (Window, original base)
        self.tail = []      # raw type-6 records
        self.images = []    # complete image headers and payloads
        self.head = bytearray()
        if not d:
            return
        assert d[:16].decode('utf-16le').startswith('DATAV1.0')
        hdr = U(d, 0x10)
        assert hdr in (0x18, 0x20), f'unknown header size {hdr:#x}'
        self.head = bytearray(d[:hdr + 0x18])
        nwin = U(d, len(self.head))
        ents = [struct.unpack_from('<II', d, len(self.head) + 4 + 8 * k)
                for k in range(nwin + 3)]
        img_off = U(d, 0x14)
        offs = [o for _, o in ents] + [img_off]
        for k, (t, o) in enumerate(ents):
            raw = d[o:offs[k + 1]]
            assert U(raw, 0) == len(raw), f'record size mismatch at {o:#x}'
            if t == 5:
                self.windows.append((Window(raw, o), o))
            else:
                assert t == 6
                self.tail.append(raw)
        n = U(d, img_off)
        end = img_off + 4 + 8 * n
        for k in range(n):
            o, s = struct.unpack_from('<II', d, img_off + 4 + 8 * k)
            assert o == end, f'noncontiguous image at {o:#x}'
            image_hdr = U(d, o)
            assert image_hdr in (0x18, 0x20), f'unknown image header size {image_hdr:#x}'
            assert U(d, o + 0x14) == o + image_hdr, f'image payload pointer at {o:#x}'
            end = o + image_hdr + s
            assert end <= len(d), f'truncated image at {o:#x}'
            self.images.append(d[o:end])
        assert end == len(d), f'trailing data {len(d) - end}'

    def window_names(self):
        return [rec_name(w.raw, 0) for w, _ in self.windows]

    def build(self) -> bytes:
        if not self.d:
            return b''
        nwin = len(self.windows)
        pos = len(self.head) + 4 + 8 * (nwin + len(self.tail))
        ents, body = [], bytearray()
        for w, base in self.windows:
            ents.append((5, pos))
            body += w.rebased(base, pos)
            pos += len(w.raw)
        for t in self.tail:
            ents.append((6, pos))
            body += t
            pos += len(t)
        img_off = pos
        head = bytearray(self.head)
        struct.pack_into('<I', head, 0x14, img_off)
        hdr = U(head, 0x10)
        struct.pack_into('<I', head, hdr, img_off - hdr)
        out = bytearray(head) + struct.pack('<I', nwin)
        for t, o in ents:
            out += struct.pack('<II', t, o)
        out += body
        assert len(out) == img_off
        out += struct.pack('<I', len(self.images))
        p = img_off + 4 + 8 * len(self.images)
        for im in self.images:
            out += struct.pack('<II', p, len(im) - U(im, 0))
            p += len(im)
        p = len(out)
        for im in self.images:
            blob = bytearray(im)
            struct.pack_into('<I', blob, 0x14, p + U(blob, 0))
            out += blob
            p += len(blob)
        return bytes(out)
