// Randomized check of integer ALU ops against a BigInt reference model.
import { Cpu } from '../src/cpu.ts';
import { Memory } from '../src/mem.ts';

const mem = new Memory();
const cpu = new Cpu(mem, { ecall() { throw new Error('ecall'); }, trap() { throw new Error('trap'); } });
const PC = 0xe0001000;
const M64 = (1n << 64n) - 1n;
const s64 = (v: bigint) => BigInt.asIntN(64, v), u64 = (v: bigint) => BigInt.asUintN(64, v);
const s32 = (v: bigint) => BigInt.asIntN(32, v), u32 = (v: bigint) => BigInt.asUintN(32, v);

const R = (f7: number, f3: number, opc: number) => (rd: number, rs1: number, rs2: number) =>
  ((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opc) >>> 0;

type Ref = (a: bigint, b: bigint, d: bigint, imm: number) => bigint;
interface Case { name: string; enc: (rd: number, rs1: number, rs2: number, imm: number) => number; ref: Ref; imm?: () => number }

const div = (a: bigint, b: bigint, signed: boolean, rem: boolean, w: boolean) => {
  const bits = w ? 32 : 64;
  const x = signed ? BigInt.asIntN(bits, a) : BigInt.asUintN(bits, a);
  const y = signed ? BigInt.asIntN(bits, b) : BigInt.asUintN(bits, b);
  let r: bigint;
  if (y === 0n) r = rem ? x : -1n;
  else if (signed && x === -(1n << BigInt(bits - 1)) && y === -1n) r = rem ? 0n : x;
  else r = rem ? x % y : x / y;
  return w ? s32(r) : r;
};
const rnd6 = () => Math.floor(Math.random() * 64);
const rnd5 = () => Math.floor(Math.random() * 32);
const rnd12 = () => Math.floor(Math.random() * 4096) - 2048;

const cases: Case[] = [
  { name: 'add', enc: R(0, 0, 0x33), ref: (a, b) => a + b },
  { name: 'sub', enc: R(0x20, 0, 0x33), ref: (a, b) => a - b },
  { name: 'sll', enc: R(0, 1, 0x33), ref: (a, b) => a << (b & 63n) },
  { name: 'srl', enc: R(0, 5, 0x33), ref: (a, b) => u64(a) >> (b & 63n) },
  { name: 'sra', enc: R(0x20, 5, 0x33), ref: (a, b) => s64(a) >> (b & 63n) },
  { name: 'slt', enc: R(0, 2, 0x33), ref: (a, b) => s64(a) < s64(b) ? 1n : 0n },
  { name: 'sltu', enc: R(0, 3, 0x33), ref: (a, b) => u64(a) < u64(b) ? 1n : 0n },
  { name: 'mul', enc: R(1, 0, 0x33), ref: (a, b) => a * b },
  { name: 'mulh', enc: R(1, 1, 0x33), ref: (a, b) => (s64(a) * s64(b)) >> 64n },
  { name: 'mulhsu', enc: R(1, 2, 0x33), ref: (a, b) => (s64(a) * u64(b)) >> 64n },
  { name: 'mulhu', enc: R(1, 3, 0x33), ref: (a, b) => (u64(a) * u64(b)) >> 64n },
  { name: 'div', enc: R(1, 4, 0x33), ref: (a, b) => div(a, b, true, false, false) },
  { name: 'divu', enc: R(1, 5, 0x33), ref: (a, b) => div(a, b, false, false, false) },
  { name: 'rem', enc: R(1, 6, 0x33), ref: (a, b) => div(a, b, true, true, false) },
  { name: 'remu', enc: R(1, 7, 0x33), ref: (a, b) => div(a, b, false, true, false) },
  { name: 'addw', enc: R(0, 0, 0x3b), ref: (a, b) => s32(a + b) },
  { name: 'subw', enc: R(0x20, 0, 0x3b), ref: (a, b) => s32(a - b) },
  { name: 'sllw', enc: R(0, 1, 0x3b), ref: (a, b) => s32(a << (b & 31n)) },
  { name: 'srlw', enc: R(0, 5, 0x3b), ref: (a, b) => s32(u32(a) >> (b & 31n)) },
  { name: 'sraw', enc: R(0x20, 5, 0x3b), ref: (a, b) => s32(a) >> (b & 31n) },
  { name: 'mulw', enc: R(1, 0, 0x3b), ref: (a, b) => s32(a * b) },
  { name: 'divw', enc: R(1, 4, 0x3b), ref: (a, b) => div(a, b, true, false, true) },
  { name: 'divuw', enc: R(1, 5, 0x3b), ref: (a, b) => s32(div(u32(a), u32(b), false, false, false)) },
  { name: 'remw', enc: R(1, 6, 0x3b), ref: (a, b) => div(a, b, true, true, true) },
  { name: 'remuw', enc: R(1, 7, 0x3b), ref: (a, b) => s32(div(u32(a), u32(b), false, true, false)) },
  { name: 'addi', imm: rnd12, enc: (d, s, _t, k) => ((k & 0xfff) << 20 | s << 15 | d << 7 | 0x13) >>> 0, ref: (a, _b, _d, k) => a + BigInt(k) },
  { name: 'sltiu', imm: rnd12, enc: (d, s, _t, k) => ((k & 0xfff) << 20 | s << 15 | 3 << 12 | d << 7 | 0x13) >>> 0, ref: (a, _b, _d, k) => u64(a) < u64(BigInt(k)) ? 1n : 0n },
  { name: 'slli', imm: rnd6, enc: (d, s, _t, k) => (k << 20 | s << 15 | 1 << 12 | d << 7 | 0x13) >>> 0, ref: (a, _b, _d, k) => a << BigInt(k) },
  { name: 'srai', imm: rnd6, enc: (d, s, _t, k) => (0x10 << 26 | k << 20 | s << 15 | 5 << 12 | d << 7 | 0x13) >>> 0, ref: (a, _b, _d, k) => s64(a) >> BigInt(k) },
  { name: 'srli', imm: rnd6, enc: (d, s, _t, k) => (k << 20 | s << 15 | 5 << 12 | d << 7 | 0x13) >>> 0, ref: (a, _b, _d, k) => u64(a) >> BigInt(k) },
  { name: 'srliw', imm: rnd5, enc: (d, s, _t, k) => (k << 20 | s << 15 | 5 << 12 | d << 7 | 0x1b) >>> 0, ref: (a, _b, _d, k) => s32(u32(a) >> BigInt(k)) },
  { name: 'th.addsl', imm: () => Math.floor(Math.random() * 4), enc: (d, s, t, k) => R(k, 1, 0x0b)(d, s, t), ref: (a, b, _d, k) => a + (b << BigInt(k)) },
  { name: 'th.mula', enc: R(0x10, 1, 0x0b), ref: (a, b, d) => d + a * b },
  { name: 'th.muls', enc: R(0x11, 1, 0x0b), ref: (a, b, d) => d - a * b },
  { name: 'th.mulaw', enc: R(0x12, 1, 0x0b), ref: (a, b, d) => s32(d + a * b) },
  { name: 'th.mulah', enc: R(0x14, 1, 0x0b), ref: (a, b, d) => s32(d + BigInt.asIntN(16, a) * BigInt.asIntN(16, b)) },
  { name: 'th.mveqz', enc: R(0x20, 1, 0x0b), ref: (a, b, d) => u64(b) === 0n ? a : d },
  { name: 'th.srri', imm: rnd6, enc: (d, s, _t, k) => (0x04 << 26 | k << 20 | s << 15 | 1 << 12 | d << 7 | 0x0b) >>> 0, ref: (a, _b, _d, k) => (u64(a) >> BigInt(k)) | (u64(a) << BigInt((64 - k) & 63)) },
  { name: 'th.srriw', imm: rnd5, enc: (d, s, _t, k) => (0x0a << 25 | k << 20 | s << 15 | 1 << 12 | d << 7 | 0x0b) >>> 0, ref: (a, _b, _d, k) => s32((u32(a) >> BigInt(k)) | (u32(a) << BigInt((32 - k) & 31))) },
  { name: 'th.ff1', enc: (d, s) => (0x43 << 25 | s << 15 | 1 << 12 | d << 7 | 0x0b) >>> 0, ref: a => { const x = u64(a); let n = 0n; for (let k = 63n; k >= 0n && !((x >> k) & 1n); k--) n++; return n; } },
  { name: 'th.rev', enc: (d, s) => (0x41 << 25 | s << 15 | 1 << 12 | d << 7 | 0x0b) >>> 0, ref: a => { let x = u64(a), r = 0n; for (let k = 0; k < 8; k++) { r = (r << 8n) | (x & 0xffn); x >>= 8n; } return r; } },
  {
    name: 'th.extu', imm: () => { const l = rnd6(), m = l + Math.floor(Math.random() * (64 - l)); return (m << 6) | l; },
    enc: (d, s, _t, k) => ((k >> 6) << 26 | (k & 63) << 20 | s << 15 | 3 << 12 | d << 7 | 0x0b) >>> 0,
    ref: (a, _b, _d, k) => { const m = k >> 6, l = k & 63; return (u64(a) >> BigInt(l)) & ((1n << BigInt(m - l + 1)) - 1n); },
  },
  {
    name: 'th.ext', imm: () => { const l = rnd6(), m = l + Math.floor(Math.random() * (64 - l)); return (m << 6) | l; },
    enc: (d, s, _t, k) => ((k >> 6) << 26 | (k & 63) << 20 | s << 15 | 2 << 12 | d << 7 | 0x0b) >>> 0,
    ref: (a, _b, _d, k) => { const m = k >> 6, l = k & 63; return BigInt.asIntN(m - l + 1, u64(a) >> BigInt(l)); },
  },
];

function rand64(): bigint {
  const pick = Math.random();
  if (pick < 0.15) return [0n, 1n, -1n, 1n << 63n, (1n << 63n) - 1n, 0x80000000n, 0xffffffffn, 0x7fffffffn][Math.floor(Math.random() * 8)];
  let v = 0n; for (let k = 0; k < 4; k++) v = (v << 16n) | BigInt(Math.floor(Math.random() * 65536));
  return pick < 0.4 ? BigInt.asIntN(32, v) : v;
}

let fails = 0;
for (const c of cases) {
  let bad = 0;
  for (let n = 0; n < 3000; n++) {
    const a = rand64(), b = rand64(), d0 = rand64(), imm = c.imm ? c.imm() : 0;
    cpu.set64(5, a); cpu.set64(6, b); cpu.set64(7, d0);
    mem.w32(PC, c.enc(7, 5, 6, imm) | 0);
    cpu.invalidate(); cpu.pc = PC; cpu.run(1);
    const got = u64(cpu.get64(7)), want = u64(c.ref(a, b, d0, imm) & M64);
    if (got !== want) {
      if (bad++ < 3) console.log(`${c.name}: a=${u64(a).toString(16)} b=${u64(b).toString(16)} d=${u64(d0).toString(16)} imm=${imm} got=${got.toString(16)} want=${want.toString(16)}`);
    }
  }
  if (bad) fails++;
  console.log(`${c.name.padEnd(10)} ${bad ? `FAIL (${bad})` : 'ok'}`);
}
process.exit(fails ? 1 : 0);
