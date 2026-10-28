"""Build a SystemBar.data that contains a brightness popup (ViewShowWndBackLightBar).

The popup is a clone of the volume popup (VolumeBar.data: ViewShowWndVolumeBar) with the
widgets renamed to the backlight ones that init.axf's SystemBar app already handles:
  window  ViewShowWndBackLightBar  (shown while setting +0x12f0 is set; key 0x76 toggles it,
                                    the handler auto-hides it after 3 s)
  slider  ViewShowSliderBackLight  (reads/sets the backlight level 0..100)
  label   ViewShowStrBackLight
  button  sun icon, event 0x58     (screen off; any touch wakes it. Icon = pull-down DayNight)
The popup's bitmaps (background + slider track/fill/thumb) are appended to SystemBar's image table.

usage: build_brightness_bar.py <SystemBar.data> <VolumeBar.data> <out.data>
"""
import struct
import sys
from uidata import UiData, Window, U, rec_name, set_name


def main(sb_path, vb_path, out_path):
    sb = UiData(open(sb_path, 'rb').read())
    vb = UiData(open(vb_path, 'rb').read())
    assert 'ViewShowWndBackLightBar' not in sb.window_names()

    # images: VolumeBar 0 = 364x200 background, 1/2/3 = slider track/fill/thumb
    base_img = len(sb.images)
    sb.images += vb.images[0:4]

    vw, vbase = vb.windows[0]
    assert rec_name(vw.raw, 0) == 'ViewShowWndVolumeBar'
    raw = bytearray(vw.raw)
    set_name(raw, 0, 'ViewShowWndBackLightBar')
    assert U(raw, 0xe4) == 0
    struct.pack_into('<I', raw, 0xe4, base_img + 0)          # window background

    # sun icon record from SystemBar's pull-down window
    pw, pbase = next((w, b) for w, b in sb.windows if rec_name(w.raw, 0) == 'ViewShowWndSystemBarPullDown')
    dn_rel = next(r for t, r in pw.children(pbase) if t == 4 and rec_name(pw.raw, r) == 'ViewShowImageDayNight')
    daynight = bytearray(pw.raw[dn_rel:dn_rel + U(pw.raw, dn_rel)])
    sw, sbase = sb.windows[0]
    sun_rel = next(r for t, r in sw.children(sbase) if t == 1 and U(sw.raw, r + 0xf8) == 0x227)
    sun_button = sw.raw[sun_rel:sun_rel + U(sw.raw, sun_rel)]

    hdr = U(raw, 4)
    for k in range(U(raw, 0xf4)):
        pair = hdr + 8 + 8 * k
        typ, rel = U(raw, pair), U(raw, pair + 4) - vbase
        name = rec_name(raw, rel)
        if typ == 2:
            assert name == 'ViewShowSliderVolume'
            set_name(raw, rel, 'ViewShowSliderBackLight')
            for f in (0xe4, 0xe8, 0xec):                      # track / fill / thumb images 1..3
                struct.pack_into('<I', raw, rel + f, base_img + U(raw, rel + f))
        elif typ == 0:
            assert name == 'ViewShowStrVolume'
            set_name(raw, rel, 'ViewShowStrBackLight')
        elif typ == 4:
            assert name == 'ViewShowImageMute'
            # Replace the mute icon with a sun *button* centred in its area. Template: the status
            # bar's sun button (540 bytes = 0x110-byte transparent button + its DayNight image
            # record inline at +0x110). The inline image becomes the 52x52 pull-down one at (0,0)
            # and the event becomes 0x58 (screen off; the pull-down's own screen-off tile uses it,
            # any touch wakes the screen).
            mx, my, mw, mh = struct.unpack_from('<iiii', raw, rel + 0xd4)
            dw, dh = struct.unpack_from('<ii', daynight, 0xdc)
            btn = bytearray(sun_button)
            assert len(daynight) == U(btn, 0x110) and U(btn, 0x104) == 1 and U(btn, 0x108) == 4
            btn[0x110:] = daynight
            struct.pack_into('<ii', btn, 0x110 + 0xd4, 0, 0)
            struct.pack_into('<iiii', btn, 0xd4, mx + (mw - dw) // 2, my + (mh - dh) // 2, dw, dh)
            struct.pack_into('<I', btn, 0xf8, 0x58)
            new_rel = len(raw)
            struct.pack_into('<I', btn, 0x10c, vbase + new_rel + 0x110)     # nested pair -> inline image
            raw += btn
            struct.pack_into('<II', raw, pair, 1, vbase + new_rel)
    struct.pack_into('<I', raw, 0, len(raw))                    # window record size covers children

    sb.windows.append((Window(bytes(raw), vbase), vbase))
    out = sb.build()
    open(out_path, 'wb').write(out)

    # sanity: re-parse and list
    chk = UiData(out)
    for w, b in chk.windows:
        print(rec_name(w.raw, 0), [rec_name(w.raw, r) for _, r in w.children(b)][-4:])
    print(f'{out_path}: {len(out)} bytes, {len(chk.images)} images')


if __name__ == '__main__':
    main(*sys.argv[1:4])
