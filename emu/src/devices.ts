// Emulated /dev/* drivers. Guest code reaches them through newlib open()/ioctl()/read()/write()
// (NLIBOPS syscalls). The display driver follows sunxi_display2.h (Allwinner disp2); struct
// offsets were computed by clang from that header (see tools/layout.c and docs/emulator.md; SDK headers are not bundled).

import { deflateSync } from 'node:zlib';
import type { Memory } from './mem.ts';

export interface Device {
  name: string;
  ioctl(cmd: number, arg: number): number;
  read?(buf: number, n: number): number | 'block';
  write?(buf: number, n: number): number;
}

export const SCREEN_W = 800, SCREEN_H = 480;

// sunxi_display2.h command numbers
const DISP = {
  BLANK: 0x0c, SHADOW_PROTECT: 0x0d, GET_SCN_WIDTH: 0x07, GET_SCN_HEIGHT: 0x08, GET_OUTPUT_TYPE: 0x09,
  VSYNC_EVENT_EN: 0x0b, SET_BKCOLOR: 0x03, GET_BKCOLOR: 0x04, DEVICE_SWITCH: 0x0f, GET_OUTPUT: 0x10,
  LAYER_SET_CONFIG: 0x47, LAYER_GET_CONFIG: 0x48, LAYER_SET_CONFIG2: 0x49, LAYER_GET_CONFIG2: 0x4a,
  LAYER_GET_FRAME_ID: 0x46,
  LCD_ENABLE: 0x100, LCD_DISABLE: 0x101, LCD_SET_BRIGHTNESS: 0x102, LCD_GET_BRIGHTNESS: 0x103,
  LCD_BACKLIGHT_ENABLE: 0x104, LCD_BACKLIGHT_DISABLE: 0x105,
} as const;

// struct disp_layer_config as compiled into this firmware's display.mod: riscv64 lp64d with
// -fshort-enums (enums are 1-2 bytes). The info part is 8 bytes longer than the SDK header
// (176 vs 168), so enable/channel/layer_id sit at 176/180/184. Verified against live guest data.
const LC = {
  SIZE: 192, MODE: 0, ZORDER: 1, ALPHA_MODE: 2, ALPHA_VALUE: 3, WIN: 4, COLOR: 24,
  FB_ADDR: 24, FB_SIZE: 24 + 24, FB_ALIGN: 24 + 48, FB_FORMAT: 24 + 60, FB_PREMUL: 24 + 76, FB_CROP: 24 + 80,
  ENABLE: 176, CHANNEL: 180, LAYER_ID: 184,
} as const;

export interface Layer {
  channel: number; layerId: number; enable: boolean;
  mode: number; zorder: number; alphaMode: number; alphaValue: number;
  win: { x: number; y: number; w: number; h: number };
  color: number;
  addr: number; fbW: number; fbH: number; format: number; premul: boolean;
  crop: { x: number; y: number; w: number; h: number };
  raw: Uint8Array;
}

export class DispDevice implements Device {
  name = '/dev/disp';
  layers = new Map<string, Layer>();
  brightness = 255;
  backlight = true;
  blank = false;
  frames = 0; // number of layer commits (used to detect UI updates)
  private mem: Memory;
  private log: (s: string) => void;
  constructor(mem: Memory, log: (s: string) => void) { this.mem = mem; this.log = log; }

  ioctl(cmd: number, arg: number): number {
    const m = this.mem;
    const a = (k: number) => m.r32(arg + 8 * k) >>> 0; // unsigned long args[]
    if (process.env.EMU_TRACE_DISP) this.log(`  disp ioctl 0x${cmd.toString(16)} args=[0x${a(0).toString(16)}, 0x${a(1).toString(16)}, 0x${a(2).toString(16)}]`);
    switch (cmd) {
      case DISP.GET_SCN_WIDTH: return SCREEN_W;
      case DISP.GET_SCN_HEIGHT: return SCREEN_H;
      case DISP.GET_OUTPUT_TYPE: return 1; // DISP_OUTPUT_TYPE_LCD
      case DISP.BLANK: this.blank = a(1) !== 0; return 0;
      case DISP.SHADOW_PROTECT: case DISP.VSYNC_EVENT_EN: case DISP.SET_BKCOLOR: case DISP.DEVICE_SWITCH: return 0;
      case DISP.LCD_SET_BRIGHTNESS: this.brightness = a(1); this.log(`  disp: LCD brightness = ${a(1)}`); return 0;
      case DISP.LCD_GET_BRIGHTNESS: return this.brightness;
      case DISP.LCD_BACKLIGHT_ENABLE: this.backlight = true; return 0;
      case DISP.LCD_BACKLIGHT_DISABLE: this.backlight = false; return 0;
      case DISP.LCD_ENABLE: case DISP.LCD_DISABLE: return 0;
      case DISP.LAYER_SET_CONFIG: {
        const p = a(1), n = a(2);
        for (let k = 0; k < n; k++) this.setLayer(p + k * LC.SIZE);
        this.frames++;
        return 0;
      }
      case DISP.LAYER_GET_CONFIG: {
        const p = a(1), n = a(2);
        for (let k = 0; k < n; k++) {
          const o = p + k * LC.SIZE;
          const l = this.layers.get(`${m.r32(o + LC.CHANNEL)}.${m.r32(o + LC.LAYER_ID)}`);
          if (l) m.write(o, l.raw);
        }
        return 0;
      }
      case DISP.LAYER_GET_FRAME_ID: return this.frames;
    }
    this.log(`  disp: unhandled ioctl 0x${cmd.toString(16)}`);
    return 0;
  }

  private setLayer(o: number): void {
    const m = this.mem;
    const r32 = (k: number) => m.r32(o + k) >>> 0;
    const fix32 = (k: number) => m.r32(o + k + 4); // 32.32 fixed point: integer part is the high word
    const l: Layer = {
      channel: r32(LC.CHANNEL), layerId: r32(LC.LAYER_ID), enable: m.r8(o + LC.ENABLE) !== 0,
      mode: m.r8(o + LC.MODE), zorder: m.r8(o + LC.ZORDER), alphaMode: m.r8(o + LC.ALPHA_MODE), alphaValue: m.r8(o + LC.ALPHA_VALUE),
      win: { x: m.r32(o + LC.WIN), y: m.r32(o + LC.WIN + 4), w: r32(LC.WIN + 8), h: r32(LC.WIN + 12) },
      color: r32(LC.COLOR),
      // pointer: low 32 bits (a double can't hold the sign-extended 64-bit value exactly)
      addr: r32(LC.FB_ADDR), fbW: r32(LC.FB_SIZE), fbH: r32(LC.FB_SIZE + 4), format: m.r8(o + LC.FB_FORMAT),
      premul: m.r8(o + LC.FB_PREMUL) !== 0,
      crop: {
        x: fix32(LC.FB_CROP), y: fix32(LC.FB_CROP + 8), w: fix32(LC.FB_CROP + 16), h: fix32(LC.FB_CROP + 24),
      },
      raw: m.read(o, LC.SIZE).slice(),
    };
    const key = `${l.channel}.${l.layerId}`;
    const prev = this.layers.get(key);
    const desc = `ch${l.channel}.${l.layerId} ${l.enable ? 'on ' : 'off'} z=${l.zorder} fmt=0x${l.format.toString(16)} fb=0x${l.addr.toString(16)} ${l.fbW}x${l.fbH} crop=${l.crop.x},${l.crop.y},${l.crop.w}x${l.crop.h} win=${l.win.x},${l.win.y},${l.win.w}x${l.win.h} alpha=${l.alphaMode}/${l.alphaValue}`;
    if (!prev || prev.raw.some((v, i) => v !== l.raw[i])) {
      this.log(`  disp: layer ${desc}`);
      if (process.env.EMU_DUMP_LAYER) for (let k = 0; k < LC.SIZE; k += 16) this.log(`    +${k.toString(16).padStart(3, '0')}: ` + [...l.raw.subarray(k, k + 16)].map(x => x.toString(16).padStart(2, '0')).join(' '));
    }
    this.layers.set(key, l);
  }

  /** Composite all enabled layers into an RGBA image. */
  render(): Uint8Array {
    const out = new Uint8Array(SCREEN_W * SCREEN_H * 4);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    if (this.blank || !this.backlight) return out;
    const layers = [...this.layers.values()].filter(l => l.enable).sort((p, q) => p.zorder - q.zorder || p.channel - q.channel);
    for (const l of layers) this.drawLayer(out, l);
    // show the backlight level (DISP_LCD_SET_BRIGHTNESS) as dimming
    if (this.brightness < 255) {
      const f = this.brightness / 255;
      for (let i = 0; i < out.length; i += 4) { out[i] *= f; out[i + 1] *= f; out[i + 2] *= f; }
    }
    return out;
  }

  private drawLayer(out: Uint8Array, l: Layer): void {
    const { x: wx, y: wy, w: ww, h: wh } = l.win;
    if (!ww || !wh) return;
    const bpp = l.format <= 0x07 ? 4 : l.format <= 0x09 ? 3 : 2;
    const cw = l.crop.w || l.fbW, ch = l.crop.h || l.fbH;
    const stride = l.fbW * bpp;
    const buf = this.mem.buf, base = l.addr - 0xe0000000;
    for (let y = 0; y < wh; y++) {
      const sy = wy + y; if (sy < 0 || sy >= SCREEN_H) continue;
      const fy = l.crop.y + Math.floor(y * ch / wh);
      for (let x = 0; x < ww; x++) {
        const sx = wx + x; if (sx < 0 || sx >= SCREEN_W) continue;
        let r: number, g: number, b: number, a: number;
        if (l.mode === 1) { // LAYER_MODE_COLOR (ARGB)
          a = l.color >>> 24; r = (l.color >>> 16) & 255; g = (l.color >>> 8) & 255; b = l.color & 255;
        } else {
          const fx = l.crop.x + Math.floor(x * cw / ww);
          const o = base + fy * stride + fx * bpp;
          if (o < 0 || o + bpp > buf.length) continue;
          switch (l.format) {
            case 0x00: b = buf[o]; g = buf[o + 1]; r = buf[o + 2]; a = buf[o + 3]; break;        // ARGB8888 (little endian: B G R A)
            case 0x01: r = buf[o]; g = buf[o + 1]; b = buf[o + 2]; a = buf[o + 3]; break;        // ABGR8888
            case 0x02: a = buf[o]; b = buf[o + 1]; g = buf[o + 2]; r = buf[o + 3]; break;        // RGBA8888
            case 0x03: a = buf[o]; r = buf[o + 1]; g = buf[o + 2]; b = buf[o + 3]; break;        // BGRA8888
            case 0x04: b = buf[o]; g = buf[o + 1]; r = buf[o + 2]; a = 255; break;               // XRGB8888
            case 0x05: r = buf[o]; g = buf[o + 1]; b = buf[o + 2]; a = 255; break;               // XBGR8888
            case 0x08: b = buf[o]; g = buf[o + 1]; r = buf[o + 2]; a = 255; break;               // RGB888
            case 0x09: r = buf[o]; g = buf[o + 1]; b = buf[o + 2]; a = 255; break;               // BGR888
            case 0x0a: { const v = buf[o] | (buf[o + 1] << 8); r = (v >> 11) * 255 / 31; g = ((v >> 5) & 63) * 255 / 63; b = (v & 31) * 255 / 31; a = 255; break; }
            default: r = 255; g = 0; b = 255; a = 255; // unsupported (YUV etc.): magenta
          }
        }
        if (l.alphaMode === 1) a = l.alphaValue;
        else if (l.alphaMode === 2) a = a * l.alphaValue / 255;
        const d = (sy * SCREEN_W + sx) * 4;
        if (a >= 255) { out[d] = r; out[d + 1] = g; out[d + 2] = b; }
        else if (a > 0) {
          const k = a / 255;
          out[d] = l.premul ? r + out[d] * (1 - k) : r * k + out[d] * (1 - k);
          out[d + 1] = l.premul ? g + out[d + 1] * (1 - k) : g * k + out[d + 1] * (1 - k);
          out[d + 2] = l.premul ? b + out[d + 2] * (1 - k) : b * k + out[d + 2] * (1 - k);
        }
      }
    }
  }
}

/** Placeholder for devices whose ioctls we only log. */
export class StubDevice implements Device {
  name: string;
  private log: (s: string) => void;
  private seen = new Set<number>();
  constructor(name: string, log: (s: string) => void) { this.name = name; this.log = log; }
  ioctl(cmd: number): number {
    if (!this.seen.has(cmd)) { this.seen.add(cmd); this.log(`  ${this.name}: ioctl 0x${cmd.toString(16)} (stub)`); }
    return 0;
  }
  read(): number | 'block' { return 'block'; }  // e.g. UARTs: nothing ever arrives
  write(_b: number, n: number): number { return n; }
}

export function encodePng(rgba: Uint8Array, w: number, h: number): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
