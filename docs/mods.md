# Modification experiments

**Brightness popup, minimum brightness 5, and Adventure skin: emulator-verified, not yet tested on hardware.** No modified firmware or replacement artwork is distributed.

The earlier boot-video replacement is a separate completed hardware experiment. A 565,051-byte, 6.12-second H.264/AAC clip replaced the 1,396,942-byte uncompressed `res/stamovie.mp4` at flash 0xb2174c. Only the file data and stored/unpacked size fields at 0x13440c–0x134413 were changed; the unused tail and all other allocation were retained. Boot0, GPT, bootA, and both UDISK areas stayed byte-identical. The local build notes recorded re-extraction, independent MinFS auditing, and matching hashes for the other 173 files; later project notes record flashing and verification on the V6.2 device. That hardware result does not validate the later UI/code changes.

`tools/build_firmware.py` is a recipe for precisely this pair of identities:

```
init.axf SHA-256 (dump_tool v0.5.0 reconstructed ELF):
0204a6b48ab365b5b93cd9b4555d847e57fec6f58f6ea0daf412d5985bb4e698
base image SHA-256 (the private BMW boot-video image):
df3469bd608582b294784c992c257c6b5d136f5a553a4704de7cc45f6961f4e4
original image SHA-256 (not accepted as the builder base):
bb2e5f9ebf19a698d29bfe41ef672d23973a0e221d89c02d3b06a2e1c1e8e49e
```

The init hash was calculated read-only from the existing extraction when preparing this repository. The builder checks the entire base image hash, 174-file count, expected section address/attributes, original instruction bytes, space limits, and output differences. **Other versions need fresh reverse engineering**; changing the expected hash alone does not port the recipe. The exact base is private and is not supplied or downloadable here. The builder accepts base/output/replacement paths as arguments, refuses an existing output, and writes a checksum sidecar and JSON report. It does not flash anything.

For the brightness popup (**emulator-verified, not yet tested on hardware**), clone the volume popup, rename its window/slider/label to the existing backlight handler names, and append its four background/slider images to SystemBar's table. `build_brightness_bar.py` also replaces the mute image with a sun button using existing SystemBar records, event 0x58. These vendor images are read only from your own supplied resources, not bundled here. The Main button must change from event 0x227 to 0x76. For the exact source layout that field is at file offset 0xb60 (button at 0xa68 plus 0xf8).

From the repository root, substituting your own external input/output paths:

```sh
python3 tools/build_brightness_bar.py /path/to/SystemBar.data /path/to/VolumeBar.data /path/to/new-SystemBar.data
# Minimal Main edit; does not include any replacement imagery:
python3 tools/build_skin.py /path/to/UI2-Main.data examples/brightness.skin.json /path/to/new-Main.data
```

First try files through an emulator overlay mirroring rootfs paths (`apps/UI2/Data/Main.data`, `apps/Data/SystemBar.data`). For the exact supported base only:

```sh
python3 tools/build_firmware.py /path/to/exact-base.bin /path/to/new-output.bin --min-brightness \
  apps/UI2/Data/Main.data=/path/to/new-Main.data \
  apps/Data/SystemBar.data=/path/to/new-SystemBar.data
```

The minimum-brightness patch (**emulator-verified, not yet tested on hardware**) changes eight `.text` bytes at `0xe91a8978` (text base `0xe9100000`): `aa86635305008146` → `95466343d500aa86`. The builder handles the compressed MinFS section; do not apply an ELF-file offset directly to flash. Slider minimum becomes 5, with full screen-off still available through the sun button. Grab the slider handle when dragging in the viewer.

The Adventure skin (**emulator-verified, not yet tested on hardware**) changes UI2 images, geometry, label rectangles/colours, and the Main brightness event. `examples/adventure.skin.json` contains its asset-free spec with relative paths. Supply original replacement art yourself; the original logo extraction script, mockup, generated plates, and PNG assets are omitted. The research build also changed the English Main language label from Menu to Home separately; that language file is not included and the skin JSON does not perform that edit.

For independently checking an output, extract it to a **new** directory with dump_tool and run the emulator against that extraction without an overlay. Compare the builder's changed regions and unchanged files as well as visual/touch behavior. Emulator verification is not hardware validation; keep a recoverable original before any flashing experiment.
