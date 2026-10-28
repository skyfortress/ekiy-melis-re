// Flat guest memory. Melis links everything into 0xe0000000..0xefffffff, so a single
// 256 MiB buffer covers code, data, heap and stacks. Guest addresses arrive as the low
// 32 bits of a register (RV64 sign-extends 0xe9xxxxxx to 0xffffffffe9xxxxxx).

export const MEM_BASE = 0xe0000000;
export const MEM_SIZE = 0x10000000;

export class MemFault extends Error {
  addr: number;
  constructor(addr: number, kind: string) {
    super(`${kind} fault at 0x${(addr >>> 0).toString(16)}`);
    this.addr = addr >>> 0;
  }
}

export class Memory {
  readonly buf = new Uint8Array(MEM_SIZE);
  readonly dv = new DataView(this.buf.buffer);

  off(addr: number, size: number, kind: string): number {
    const o = (addr >>> 0) - MEM_BASE;
    if (o < 0 || o + size > MEM_SIZE) throw new MemFault(addr, kind);
    return o;
  }

  r8(a: number): number { return this.buf[this.off(a, 1, 'read')]; }
  r16(a: number): number { return this.dv.getUint16(this.off(a, 2, 'read'), true); }
  r32(a: number): number { return this.dv.getInt32(this.off(a, 4, 'read'), true); }
  w8(a: number, v: number): void { this.buf[this.off(a, 1, 'write')] = v; }
  w16(a: number, v: number): void { this.dv.setUint16(this.off(a, 2, 'write'), v, true); }
  w32(a: number, v: number): void { this.dv.setInt32(this.off(a, 4, 'write'), v, true); }

  write(a: number, data: Uint8Array): void { this.buf.set(data, this.off(a, data.length, 'write')); }
  read(a: number, n: number): Uint8Array { const o = this.off(a, n, 'read'); return this.buf.subarray(o, o + n); }
  fill(a: number, n: number, v = 0): void { const o = this.off(a, n, 'write'); this.buf.fill(v, o, o + n); }

  cstr(a: number, max = 4096): string {
    let o = this.off(a, 1, 'read'), s = '';
    for (let i = 0; i < max && this.buf[o + i]; i++) s += String.fromCharCode(this.buf[o + i]);
    return s;
  }
  wcstr(a: number, max = 4096): string {
    let s = '';
    for (let i = 0; i < max; i++) { const c = this.r16(a + 2 * i); if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
  writeCstr(a: number, s: string): void {
    const b = Buffer.from(s + '\0', 'latin1');
    this.write(a, b);
  }
}
