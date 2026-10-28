# MinFS and compressed modules

On the investigated V6.2 image, ROOTFS occupies `[0x130000, 0xf20000)` (0xdf0000 bytes); UDISK occupies `[0xf20000, 0x1000000)`. The GPT region begins at 0xc000: physical partition offsets are `0xc000 + LBA * 512`. The related V6.3 board's 0x190000 ROOTFS offset does not apply here.

MinFS begins with `MINFS\0`, u16 version (observed 0x0100), and six u32s: root offset, root length, entry count, dentry length, data length, declared filesystem size. The observed root starts at filesystem offset 0x200 and is 164 bytes long. The audited tree contains 174 files and 17 directories: 111 ordinary files and 63 modules.

`build_firmware.py` walks directory entries with `<IIIHHHH>` (20 bytes): data offset, stored size, unpacked size, record size, attributes, name byte length, extension byte length. Offsets are filesystem-relative; directory records advance by record size. UTF-8 names follow the fixed header and are padded to a four-byte boundary before extensions. Attribute bit 0 identifies directories. In this image ordinary replacement files have attr 0, while init.axf has attr 6. Module identification and per-section compression are separate: the module audit uses entry bit 1 for module extents; section attribute bit 1 marks compressed section payloads.

A module entry has one 32-byte extent per stored ELF section, after the aligned name:

```
u32 section_offset, stored_size, unpacked_size, memory_size;
u32 virtual_address, section_type, section_flags, section_attributes;
```

Section offsets are relative to the module's data area. Compressed sections use a five-byte LZMA1 property header (one property byte, then little-endian dictionary size) followed by a raw LZMA1 stream. Property decoding is `lc = p % 9`, `lp = (p // 9) % 5`, `pb = p // 45`. The unpacked size is known from the extent; original streams need not have an end marker. The builder uses Python's raw decompressor with an output-size limit. SDK behavior documented during the work uses `LZMA_FINISH_ANY`; a Python-generated end marker is not needed to produce those known output bytes.

`dump_tool` reconstructs ELF headers; the recovered ELF hash is therefore different from the module's stored MinFS representation. The modules use ELF32 little-endian containers with RISC-V machine ID 243, despite carrying RV64 instructions. Module extents preserve section addresses, flags, and types; copying a reconstructed `.axf` file over the stored compressed representation would be incorrect.

The replacement recipe keeps allocation stable. Equal-size ordinary files overwrite their original slot. Other replacements go into the unused tail of the **already shortened** boot-video allocation, each starting at a 4 KiB boundary; only the relevant entry's offset/stored/unpacked sizes are repointed. The original video allocation was 1,396,942 bytes; the exact supported base uses 565,051 bytes. The gap ends at flash offset 0xc7681a. This is not a free-space allocator for arbitrary images. The builder checks capacity and that unrelated files do not occupy the used gap. These uncompressed entries have no checksum or allocation bitmap requiring updates.

For the minimum-brightness change, only init.axf's first `.text` extent is decompressed and patched. It is recompressed with dictionary 0x8000, lc=2, lp=1, pb=1, with the same dictionary and lc+lp budget as the original. The new stream must fit the old slot; the remainder is zeroed and that extent's stored size changes. The builder verifies all 174 file bodies (or patched decompressed text plus untouched remaining module bytes), the path set, and all changed byte ranges. See [exact hashes and recipe limitations](mods.md). Run Python normally: assertions are integrity checks and must not be disabled with `-O`.

Full repacking was deliberately avoided for local modifications. An unchanged v0.5.0 pack/extract round trip preserved all extracted file hashes but changed 11,613,776 ROOTFS bytes and 872,371 UDISK bytes. It reordered entries, relocated data, and recompressed sections; stored file data grew by 2,796 bytes. The declared MinFS size changed from 0xdf0000 to 0xb47a00 while the GPT partition size stayed fixed. More significantly, two identical 448 KiB FAT12 UDISK areas became one 896 KiB volume. Whether that duplication matters to the firmware was unresolved. Byte-equivalent extracted files are not a hardware boot test, so a small in-place recipe avoids these unrelated changes.
