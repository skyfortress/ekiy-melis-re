# Tools

Run from the repository root with Python 3. Image/skin tools and `emu/tools/sheet.py` require Pillow (`python3 -m pip install -r requirements.txt`). No firmware inputs or SDK source are bundled. Builders create derived vendor-containing files: keep their outputs outside the repository.

- `uidata.py`: importable `UiData`/`Window` reader and writer; see [the format](../docs/data-format.md).
- `build_skin.py <base.data> <spec.json> <out.data>`: relative PNG paths, geometry, raw field edits; verifies replaced pixels.
- `build_brightness_bar.py <SystemBar.data> <VolumeBar.data> <out.data>`: clone an existing popup using supplied resources.
- `build_firmware.py <base.bin> <out.bin> [--min-brightness] [rootfs/path=host_file ...]`: **exact-base recipe**, not a generic repacker; see [mods](../docs/mods.md). Do not run Python with `-O`.
- `dis.sh <elf> <start-hex> [byte-count]`: LLVM disassembly with RV64/T-Head attributes; `LLVM_OBJDUMP` selects the executable (default `llvm-objdump`, LLVM 19 used in the research).
- `xrefs.py <llvm-listing> <output.pkl>`: heuristic address-reference collection; the pickle is for local analysis only, not untrusted input.
- `syscalls.py <llvm-listing> <output.json>`: heuristic ecall-stub/caller extraction.
- `mapsyscalls.py <SDK-kapi.h> <syscalls.json> <output.json>`: attach generated SDK group/name information; obtain the header from the [SDK](https://gitee.com/grantho/d1s-melis).
- `u16strings.py <file> ...`: scan ASCII-range UTF-16LE strings with offsets.

The heuristic instruction tools are starting points for analysis, not a complete control-flow analysis. `tables.py` was omitted because its address windows and ELF layout assumptions are specific to one private investigation. `dataparse.py` was omitted because the maintained reader supersedes it (its geometry offsets were inconsistent with the verified layout). SDK headers needed by `emu/tools/layout*.c` must be supplied externally.
