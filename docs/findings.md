# Findings

The following behavior was established for the investigated firmware and exercised in the emulator. Event numbers and addresses are firmware-specific.

- `0x227`: home brightness button's cycle (observed 100 → 43 → off).
- `0x76`: toggles `ViewShowWndBackLightBar`; the handler auto-hides it after about three seconds.
- `0x58`: screen off; a touch wakes it.
- `0x6d`: volume popup.

The backlight setter is at `0xe91a8978`. The popup slider's logical level is 0–100. The minimum-brightness recipe changes the lower clamp from `if (v < 0) v = 0` to `if (v < 5) v = 5`, while leaving explicit screen-off available. The Main page already binds the name `ViewShowSliderBackLight` to its show/set handler (`0xe915b5da`); the mod reuses existing firmware behavior rather than adding a new application handler.

UI selection matters: with the observed saved settings the device selects the UI2 skin, whose main layout is `apps/UI2/Data/Main.data`. Editing `apps/Data/Main.data` alone does not change that home screen. Shared resources such as `SystemBar.data` and `VolumeBar.data` are under `apps/Data/`. The supported experiment establishes the active UI2 Main location and shared SystemBar lookup; a complete fallback order for every UI ID has not been established. Saved UDISK settings and `uiType`/`uiID` influence selection, so preserve or deliberately reset state when comparing runs.

Display ABI mistakes can produce plausible but incorrect output: the observed 192-byte structure differs from the reference SDK header, and enums use `-fshort-enums`. Returning success for every device open is also unsafe for emulation: `/dev/tpadc_rtp` must be absent or the application forces calibration. Treating guest pointers as sign-extended JavaScript numbers caused precision errors; keep low pointer bits explicitly.

The first six SPI reads differed, including runs of 0xff within data, until the Orange Pi reader received a suitable power supply. Later reads matched SHA-256. A successful “Reading flash... done” message does not establish a stable dump: compare multiple complete reads before analyzing or writing. Preserve the original image and distinguish extraction verification, emulator execution, and actual hardware results. A related board reference is useful evidence, but not authority for this PCB's offsets.
