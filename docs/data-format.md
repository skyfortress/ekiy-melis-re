# DATAV1.0 UI resources

`tools/uidata.py` reads and rebuilds observed EKIY `.data` packages. It preserves uninterpreted record bytes while rebasing known absolute pointers. This is a format description for the observed firmware, not a universal specification.

Integers are little-endian. The file begins with UTF-16LE `DATAV1.0` and padding. At +0x10 is header size H (0x18 or 0x20), at +0x14 the image-section offset. The 0x20 header has two additional u32 flags. At H is `image_offset - H`; H+4 holds `0x14, 0, 0`, H+0x10 holds width/height, and H+0x18 holds the window count. This is followed by `(window_count + 3)` pairs of `(u32 type, u32 absolute_offset)`: type 5 windows and three type 6 trailing tables. The writer preserves those tables as opaque bytes. Empty input is an empty passthrough.

Records begin with `u32 size`, `u32 header_size`, and a 0xc8-byte UTF-16LE name at +8. Signed x/y/w/h are at +0xd4. A window has child count at +0xf4 and `(type, absolute_offset)` child pairs at `header_size + 8`. Child types encountered here are 0 text, 1 button, 2 slider, 4 image. Button event ID is +0xf8. Buttons may contain nested records: count at +0x104 and pairs from +0x108. `Window.children(base)` returns the flattened tree in pointer traversal order, including nested children; example `child` indices refer to that order, not merely direct children. The builder rebases these nested pointers too.

The Adventure generator's button label edits use +0x2ac/+0x2b0/+0x2b4/+0x2b8 for the label rectangle, +0x2c0/+0x2c4/+0x2c8/+0x2cc for label colours, and +0x2d8 for its font setting. Colours are stored as `0x00BBGGRR`. These are observed offsets for that button variant, not fields guaranteed to exist in every button. Text controls use a separate rectangle at +0x19c in the example. Type-4 images support state pairs (normal/pressed in the example's adjacent image indices); `uidata.py` preserves their raw records rather than assigning a complete public schema to each state field. Replacing the image table entries avoids guessing those fields.

The brightness popup builder establishes slider image indices at +0xe4, +0xe8, +0xec (track/fill/thumb). The window background image index is +0xe4. It clones an existing slider rather than constructing undocumented range/value fields; the firmware resolves its handler by widget name. Other slider bytes remain opaque.

The image section contains `u32 count`, then `(u32 absolute_blob_offset, u32 payload_size)` pairs. A blob has its own header size (0x18 or 0x20), width/height at +4/+8, two format fields, and an absolute payload pointer at +0x14. The table's payload size excludes the entire blob header. The file-header variant and blob-header variant are independent. Blobs are contiguous and payloads are complete zlib streams: apparent eight-byte gaps came from incorrectly treating all image headers as 0x18 bytes.

`build_skin.encode_image()` writes `{0x20, width, height, 1, 3, pointer, 1, 0}` as eight u32s, then zlib-compressed BGRA pixels. Compression level 9 reproduces the observed encoding. `UiData.build()` updates the payload pointers and image table; `build_skin.py` reparses output and compares replaced image pixels to input PNGs.

```sh
python3 -m pip install -r requirements.txt
python3 tools/build_skin.py /path/to/Main.data examples/adventure.skin.json /path/to/new-Main.data
```

The example contains only JSON layout/index edits and relative `assets/*.png` paths. Supply your own artwork next to the spec, or change/remove its image entries. No Adventure assets, extracted logos, or private mockup are distributed. The spec targets **apps/UI2/Data/Main.data** from this firmware; record indices and offsets may differ elsewhere. `rects` changes x/y/w/h, `fields` writes raw u32s (`off` and `u32` accept hex strings), and `child: -1` selects the window itself. Use an overlay before considering an image build.
