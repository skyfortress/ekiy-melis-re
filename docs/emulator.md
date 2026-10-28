# Emulator

This is application-level HLE: the original Melis modules execute on an RV64GC interpreter with T-Head `xthead*` instructions. It does not boot the original RTOS kernel. `cpu.ts` executes instructions; `decode.ts` decodes them; `mem.ts` supplies guest memory; `elf.ts` reads the unusual ELF32 containers holding RV64 code. Integer registers use pairs of 32-bit words. Converting sign-extended 64-bit pointers through JavaScript doubles loses precision: device pointers must use their low 32 bits.

`kernel.ts` implements scheduling, memory allocation, module calls, files, configuration, timers, queues, semaphores, and selected services. Melis syscalls arrive via `ecall`, with `a7 = 0x10000000 | (group << 8) | index`. The generated `swi-names.ts` follows the open Allwinner d1s-melis SDK's `include/melis/ekernel/kapi.h` SWI handler tables ([SDK mirror](https://gitee.com/grantho/d1s-melis)). Unimplemented services are logged and return zero with `--stub`; without that flag they can halt execution. The home UI currently needs `--stub` (included by the `serve` script).

`boot.ts` installs `slib.mod`, `display.mod`, `mixture.mod`, and `desktop.mod`, invoking `MInit` and, except for slib, `MOpen`. The shared C library exposes a table at `0xe8700000`. The kernel saves the mixture handle; desktop loads `apps/init.axf`. This is a modeled startup sequence, not execution of a host shell script.

`d:` mounts the extracted `2_ROOTFS.bin.out` read-only; optional overlays shadow individual rootfs files. `e:` uses `emu/state/e`, seeded from `3_UDISK.bin.out` when empty. `esCFG` reads `1_bootA.bin.out/sys_config.fex`. Use `--fresh` to discard the selected state directory and reseed it. Saved UDISK settings affect the selected UI; an empty UDISK need not reproduce the same screen.

The `/dev/disp` model composes the display into an 800×480 RGBA framebuffer and encodes PNG without an image dependency. The observed home UI uses an RGB888 layer. Its layer configuration is **192 bytes**, with `enable/channel/layer_id` at **176/180/184**. The observed ABI uses `-fshort-enums`; the information part is eight bytes larger than the reference SDK header's 168 bytes. Do not simply reuse the host compiler's default enum layout. The two `emu/tools/layout*.c` probes accept external `sunxi_display2*.h` headers via the compiler include path; the headers are not bundled. The authoritative observed offsets are in `devices.ts`.

Touch uses the `LTSDev` grabber callback. The input packet has logical/physical device IDs at +0/+4, count at +0x10, and 12-byte `{u32 type, u32 code, s32 value}` events at +0x14. It emits ABS_X `(3,0)`, ABS_Y `(3,1)`, ABS_MISC `(3,0x28)` and a sync event. Actions are `0xf0` down, `0xf1` move, zero up. The emulator applies configured coordinate reversal before delivery (including `bTouchXReverse=1` from saved settings). `/dev/tpadc_rtp` must fail as absent: returning a stub handle selects the resistive-touch calibration path. Legacy directory entries also require attributes at +4 (`0x10` for directories) and names at +0x10.

From `emu/`, after `npm ci`:

```sh
npm run run -- --dump /path/to/extracted --stub --steps 1000000000 --png home.png
npm run serve -- --dump /path/to/extracted --fresh
# Browser: http://localhost:8133 (bound to loopback)
npm run serve:mod -- --dump /path/to/extracted
```

The dump directory must contain `gpt.bin.out/`; `EKIY_DUMP` supplies the same value. Missing input produces an explicit error. `--rootfs`, `--udisk`, and `--sys-config` override individual extracted paths, but a dump directory is still required. `--empty-udisk` disables seeding. `--state <dir>` selects writable state, `--overlay <dir>` shadows rootfs paths, and repeated `--cfg section.key=value` override FEX keys. The realtime viewer supports mouse down/drag/up and logs to the selected state's `emu.log`.

Batch options include `--trace`, `--frames <dir> --every <instructions>`, repeated `--tap x,y@M`, and `--drag x1,y1,x2,y2@M`, where M is a million-instruction timestamp. `emu/tools/sheet.py` builds contact sheets from frame dumps (Pillow required).

```sh
npm run typecheck
npm test
# Optional full firmware-dependent comparison:
npm run check-decode -- --dump /path/to/extracted
# Or use a previously generated LLVM disassembly:
npm run check-decode -- --dump /path/to/extracted --dis /path/to/init.dis
```

`LLVM_OBJDUMP` selects the executable, otherwise `llvm-objdump` is used. The test enables the relevant RISC-V/T-Head attributes; `EKIY_DISASSEMBLY` is an alternative to `--dis`. Without a dump the decoder test explicitly skips, while the deterministic ALU fuzz suite still runs. Supplied but invalid inputs fail. The decoder was previously compared across init.axf's `.text` with zero mismatches against LLVM objdump. It compares mapped instruction classes, lengths as decoded from bytes, targets, offsets, and selected registers; it skips LLVM `<unknown>` lines. This is evidence for the covered firmware, not proof of complete ISA or hardware behavior.
