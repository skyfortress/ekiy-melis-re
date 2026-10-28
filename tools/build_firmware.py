"""Version-specific image recipe: BMW-video base + replaced ROOTFS files.

Emulator-verified, not yet tested on hardware. See docs/mods.md for exact hashes.
Other firmware versions require fresh reverse engineering. Run without Python -O: assertions
are required integrity checks.

usage: build_firmware.py <base.bin> <out.bin> [--min-brightness] <rootfs/path=host_file> ...

  rootfs/path=host_file   replace an uncompressed MinFS file (attr 0). Same size -> written in place.
                          Different size -> written into the unused tail of the old boot video
                          region (res/stamovie.mp4 shrank when the BMW clip was installed; files
                          are placed one after another, 4 KiB aligned) and the MinFS entry's
                          offset/size/unpacked fields are repointed. MinFS has no checksums or
                          allocation bitmap for these fields.
  --min-brightness        apps/init.axf: backlight-level setter 0xe91a8978 lower clamp
                          `if (v < 0) v = 0` -> `if (v < 5) v = 5` (slider can't black the panel;
                          screen-off stays available via event 0x58). init.axf is a MinFS module
                          entry (attr 6): the dentry ends with one 32-byte extent per ELF section
                          {off, stored, unpacked, memsz, va, type, flags, attr}; attr&2 = raw LZMA1
                          (5-byte props, no end marker). .text is decompressed, patched and
                          recompressed with lc=2 lp=1 pb=1 (same dict 32 KiB and lc+lp, so the
                          kernel's LzmaDecode needs no more memory); the shorter stream goes in
                          place, the rest of the slot is zeroed and only its stored size changes.
                          The kernel decodes with LZMA_FINISH_ANY to the known size
                          (Allwinner d1s-melis SDK ekernel/legacy/az100), so Python's end marker is unread.

Verification: every one of the 174 files is re-read from the output and compared with the expected
content (replacements, patched .text, or the base image), and every changed byte range must lie in
an expected region. Writes <out>.sha256 and <out>.report.json.
"""
import argparse
import hashlib
import json
import lzma
import struct
import sys
from pathlib import Path

ROOTFS, ROOTFS_END = 0x130000, 0xF20000          # GPT partition 2; see docs/minfs-and-modules.md
BASE_SHA = 'df3469bd608582b294784c992c257c6b5d136f5a553a4704de7cc45f6961f4e4'  # firmware_bmw_stamovie.bin
OLD_VIDEO_SIZE = 1396942                          # original res/stamovie.mp4; see docs/mods.md
TEXT_VA, PATCH_VA = 0xe9100000, 0xe91a8978
PATCH_OLD, PATCH_NEW = bytes.fromhex('aa86635305008146'), bytes.fromhex('95466343d500aa86')
TEXT_LZMA = dict(id=lzma.FILTER_LZMA1, preset=9 | lzma.PRESET_EXTREME, dict_size=0x8000, lc=2, lp=1, pb=1)


def walk(fs, offset, length, parent=''):
    p, out = offset, []
    while p < offset + length:
        data, stored, unpacked, rec, attr, nl, el = struct.unpack_from('<IIIHHHH', fs, p)
        name = bytes(fs[p + 20:p + 20 + nl]).split(b'\0')[0].decode('utf-8')
        out.append(dict(path=f'{parent}/{name}' if parent else name, entry=p, data=data, size=stored,
                        unpacked=unpacked, attr=attr))
        p += rec
    assert p == offset + length
    return out


def tree(fs):
    magic, version, root, root_size = struct.unpack_from('<6sHII', fs, 0)
    assert magic == b'MINFS\0', magic
    files, stack = [], [(root, root_size, '')]
    while stack:
        off, ln, parent = stack.pop()
        for e in walk(fs, off, ln, parent):
            if e['attr'] & 1:
                stack.append((e['data'], e['size'], e['path']))
            else:
                files.append(e)
    return {f['path']: f for f in files}


def lzma_props(f):
    return bytes([(f['pb'] * 5 + f['lp']) * 9 + f['lc']]) + struct.pack('<I', f['dict_size'])


def lzma_unpack(raw, size):
    pr = raw[0]
    f = dict(id=lzma.FILTER_LZMA1, dict_size=struct.unpack_from('<I', raw, 1)[0], lc=pr % 9, lp=pr // 9 % 5, pb=pr // 45)
    out = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[f]).decompress(bytes(raw[5:]), max_length=size)
    assert len(out) == size
    return out


def text_extent(fs, e):
    nl = struct.unpack_from('<H', fs, e['entry'] + 16)[0]
    ext = e['entry'] + 20 + ((nl + 3) & ~3)
    f = struct.unpack_from('<8I', fs, ext)
    assert f[4] == TEXT_VA and f[0] == 0 and f[7] & 2, f
    return ext, f


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('base', help='exact base image identified by BASE_SHA')
    parser.add_argument('output', help='new output image (must not exist)')
    parser.add_argument('--min-brightness', action='store_true')
    parser.add_argument('replacements', nargs='*', metavar='rootfs/path=host_file')
    args = parser.parse_intermixed_args(argv)
    base_path, out_path = args.base, args.output
    if Path(out_path).exists():
        parser.error('output already exists; choose a new path')
    if any('=' not in a for a in args.replacements):
        parser.error('replacements must use rootfs/path=host_file')
    min_bright = args.min_brightness
    repl = dict(a.split('=', 1) for a in args.replacements)
    base = Path(base_path).read_bytes()
    assert hashlib.sha256(base).hexdigest() == BASE_SHA, 'unexpected base image'
    img = bytearray(base)
    fs = memoryview(img)[ROOTFS:ROOTFS_END]
    files = tree(fs)
    assert len(files) == 174, len(files)
    body = lambda f, m=fs: bytes(m[f['data']:f['data'] + f['size']])

    allowed, expect, report = [], {}, dict(base_sha256=BASE_SHA, files={})
    mov = files['res/stamovie.mp4']
    gap = (mov['data'] + mov['size'] + 0xfff) & ~0xfff
    gap_end = mov['data'] + OLD_VIDEO_SIZE

    for path, host in repl.items():
        e = files[path]
        assert e['attr'] == 0 and e['size'] == e['unpacked'], e          # stored uncompressed
        new = Path(host).read_bytes()
        if len(new) == e['size']:
            at = e['data']
        else:
            at, gap = gap, (gap + len(new) + 0xfff) & ~0xfff
            assert at + len(new) <= gap_end, f'{path}: no room ({at + len(new) - gap_end} bytes over)'
            struct.pack_into('<III', fs, e['entry'], at, len(new), len(new))
            allowed.append((e['entry'], e['entry'] + 12))
        fs[at:at + len(new)] = new
        allowed.append((at, at + len(new)))
        expect[path] = new
        report['files'][path] = dict(flash_offset=hex(ROOTFS + at), size=len(new), old_size=e['size'],
                                     sha256=hashlib.sha256(new).hexdigest(), relocated=at != e['data'])
    for f in files.values():                                            # nothing else lives in the used gap
        if f is not mov and f['path'] not in repl:
            assert f['data'] + f['size'] <= mov['data'] + mov['size'] or f['data'] >= gap_end, f['path']

    if min_bright:
        e = files['apps/init.axf']
        assert e['attr'] == 6, e
        ext, (_, t_stored, t_size, *_r) = text_extent(fs, e)
        slot = e['data']
        text = bytearray(lzma_unpack(fs[slot:slot + t_stored], t_size))
        po = PATCH_VA - TEXT_VA
        assert text[po:po + 8] == PATCH_OLD
        text[po:po + 8] = PATCH_NEW
        stream = lzma_props(TEXT_LZMA) + lzma.compress(bytes(text), format=lzma.FORMAT_RAW, filters=[TEXT_LZMA])
        assert len(stream) <= t_stored, (len(stream), t_stored)
        fs[slot:slot + t_stored] = stream + bytes(t_stored - len(stream))
        struct.pack_into('<I', fs, ext + 4, len(stream))
        allowed += [(slot, slot + t_stored), (ext + 4, ext + 8)]
        report['init_axf_text'] = dict(flash_offset=hex(ROOTFS + slot), stream=len(stream), old_stream=t_stored)

    Path(out_path).write_bytes(img)
    sha = hashlib.sha256(img).hexdigest()
    Path(out_path + '.sha256').write_text(f'{sha}  {Path(out_path).name}\n')

    # verification
    bfs = memoryview(base)[ROOTFS:ROOTFS_END]
    rfs = bytes(fs)
    after = tree(rfs)
    assert set(after) == set(files)
    for p, f in after.items():
        if p in expect:
            assert body(f, rfs) == expect[p], p
        elif p == 'apps/init.axf' and min_bright:
            ext2, f2 = text_extent(rfs, f)
            assert lzma_unpack(rfs[f['data']:f['data'] + f2[1]], f2[2]) == bytes(text)
            assert rfs[f['data'] + t_stored:f['data'] + f['size']] == bytes(bfs[f['data'] + t_stored:f['data'] + f['size']])
        else:
            assert f == files[p] and body(f, rfs) == body(files[p], bfs), p
    diffs, i = [], 0
    while i < len(img):
        if img[i] != base[i]:
            j = i
            while j < len(img) and img[j] != base[j]:
                j += 1
            diffs.append((i - ROOTFS, j - ROOTFS)); i = j
        else:
            i += 1
    assert all(any(x <= a and b <= y for x, y in allowed) for a, b in diffs), diffs
    report.update(output_sha256=sha, changed_ranges=len(diffs), files_checked=len(after),
                  gap_used=hex(ROOTFS + gap), gap_end=hex(ROOTFS + gap_end))
    print(json.dumps(report, indent=2))
    Path(out_path + '.report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main(sys.argv[1:])
