// RV64GC + T-Head interpreter.
// Integer registers are kept as (lo, hi) int32 pairs in an Int32Array: x[i] = R[2i] | R[2i+1] << 32.
// This avoids BigInt on the hot path; BigInt is only used for 64-bit mulh/div/rem.

import { decode, O, OP_NAMES, SZ_U, type Insn } from './decode.ts';
import { Memory, MEM_BASE } from './mem.ts';

export const TRAP_BASE = 0xeff00000; // PCs in [TRAP_BASE, TRAP_END) call into the host
export const TRAP_END = 0xf0000000;

export class CpuHalt extends Error {}

export interface Host {
  ecall(cpu: Cpu): void;
  trap(cpu: Cpu, pc: number): void; // must set cpu.pc
}

const PAGE_BITS = 12;

// --- 64-bit helpers on (lo, hi) pairs -------------------------------------------------------
function mulhu32(a: number, b: number): number {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const t = a0 * b0, m1 = a1 * b0, m2 = a0 * b1;
  const mid = (t >>> 16) + (m1 & 0xffff) + (m2 & 0xffff);
  return (a1 * b1 + (m1 >>> 16) + (m2 >>> 16) + (mid >>> 16)) | 0;
}
const big = (lo: number, hi: number) => (BigInt(hi) << 32n) | BigInt(lo >>> 0);
const bigU = (lo: number, hi: number) => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
function roundRM(v: number, rm: number): number {
  switch (rm) {
    case 1: return Math.trunc(v);
    case 2: return Math.floor(v);
    case 3: return Math.ceil(v);
    case 4: return v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
    default: { const r = Math.round(v); return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; }
  }
}

export class Cpu {
  readonly R = new Int32Array(64);
  readonly fbuf = new ArrayBuffer(32 * 8);
  readonly F64 = new Float64Array(this.fbuf);
  readonly F32 = new Float32Array(this.fbuf);
  readonly FI = new Int32Array(this.fbuf);
  pc = 0;
  steps = 0;
  frm = 0; fflags = 0;
  csrs = new Map<number, number>();
  lastPc = 0;
  stopReq = false; // set by the host to leave run() after the current ecall/trap
  private pages = new Map<number, (Insn | undefined)[]>();
  readonly mem: Memory;
  readonly host: Host;

  constructor(mem: Memory, host: Host) { this.mem = mem; this.host = host; }

  // register accessors for host code
  get(r: number): number { return this.R[2 * r]; }             // low 32 bits (signed)
  getU(r: number): number { return this.R[2 * r] >>> 0; }
  get64(r: number): bigint { return big(this.R[2 * r], this.R[2 * r + 1]); }
  set(r: number, v: number): void { if (r) { this.R[2 * r] = v | 0; this.R[2 * r + 1] = (v | 0) >> 31; } }
  setU32(r: number, v: number): void { if (r) { this.R[2 * r] = v | 0; this.R[2 * r + 1] = 0; } }
  set64(r: number, v: bigint): void {
    if (!r) return;
    this.R[2 * r] = Number(BigInt.asIntN(32, v)); this.R[2 * r + 1] = Number(BigInt.asIntN(32, v >> 32n));
  }
  /** Set a register to a guest pointer (addresses are zero-extended 32-bit). */
  setPtr(r: number, v: number): void { this.setU32(r, v); }

  invalidate(): void { this.pages.clear(); }

  fetch(pc: number): Insn {
    const pg = pc >>> PAGE_BITS;
    let page = this.pages.get(pg);
    if (!page) { page = new Array(1 << (PAGE_BITS - 1)); this.pages.set(pg, page); }
    const idx = (pc & ((1 << PAGE_BITS) - 1)) >>> 1;
    let ins = page[idx];
    if (!ins) {
      const lo = this.mem.r16(pc);
      const raw = (lo & 3) === 3 ? (lo | (this.mem.r16(pc + 2) << 16)) : lo;
      ins = decode(raw);
      page[idx] = ins;
    }
    return ins;
  }

  csrRead(n: number): number {
    switch (n) {
      case 1: return this.fflags;
      case 2: return this.frm;
      case 3: return (this.frm << 5) | this.fflags;
      case 0xc00: case 0xc01: case 0xc02: case 0xb00: case 0xb02: return this.steps | 0;
    }
    return this.csrs.get(n) ?? 0;
  }
  csrWrite(n: number, v: number): void {
    switch (n) {
      case 1: this.fflags = v & 0x1f; return;
      case 2: this.frm = v & 7; return;
      case 3: this.fflags = v & 0x1f; this.frm = (v >>> 5) & 7; return;
    }
    this.csrs.set(n, v);
  }

  /** Run until `maxSteps` instructions have executed or a host handler throws CpuHalt. */
  run(maxSteps: number): void {
    const R = this.R, mem = this.mem, F64 = this.F64, F32 = this.F32, FI = this.FI;
    const end = this.steps + maxSteps;
    let pc = this.pc;
    try {
      while (this.steps < end) {
        if (pc >= TRAP_BASE) {
          this.pc = pc;
          this.host.trap(this, pc);
          pc = this.pc;
          if (this.stopReq) { this.stopReq = false; break; }
          continue;
        }
        const i = this.fetch(pc);
        this.lastPc = pc;
        this.steps++;
        let npc = (pc + i.len) >>> 0;
        const rd = i.rd, a = 2 * i.rs1, b = 2 * i.rs2, d = 2 * rd;
        let lo = 0, hi = 0, wr = true; // result for rd

        switch (i.op) {
          case O.LUI: lo = i.imm; hi = lo >> 31; break;
          case O.AUIPC: { lo = (pc + i.imm) | 0; hi = ((pc >>> 0) + (i.imm >>> 0) > 0xffffffff ? 1 : 0) + (i.imm >> 31); break; }
          case O.JAL: lo = npc | 0; hi = 0; npc = (pc + i.imm) >>> 0; break;
          case O.JALR: { const t = ((R[a] + i.imm) & ~1) >>> 0; lo = npc | 0; hi = 0; npc = t; break; }
          case O.BEQ: wr = false; if (R[a] === R[b] && R[a + 1] === R[b + 1]) npc = (pc + i.imm) >>> 0; break;
          case O.BNE: wr = false; if (R[a] !== R[b] || R[a + 1] !== R[b + 1]) npc = (pc + i.imm) >>> 0; break;
          case O.BLT: wr = false; if (R[a + 1] < R[b + 1] || (R[a + 1] === R[b + 1] && (R[a] >>> 0) < (R[b] >>> 0))) npc = (pc + i.imm) >>> 0; break;
          case O.BGE: wr = false; if (!(R[a + 1] < R[b + 1] || (R[a + 1] === R[b + 1] && (R[a] >>> 0) < (R[b] >>> 0)))) npc = (pc + i.imm) >>> 0; break;
          case O.BLTU: wr = false; if ((R[a + 1] >>> 0) < (R[b + 1] >>> 0) || (R[a + 1] === R[b + 1] && (R[a] >>> 0) < (R[b] >>> 0))) npc = (pc + i.imm) >>> 0; break;
          case O.BGEU: wr = false; if (!((R[a + 1] >>> 0) < (R[b + 1] >>> 0) || (R[a + 1] === R[b + 1] && (R[a] >>> 0) < (R[b] >>> 0)))) npc = (pc + i.imm) >>> 0; break;

          case O.LB: lo = (mem.r8(R[a] + i.imm) << 24) >> 24; hi = lo >> 31; break;
          case O.LH: lo = (mem.r16(R[a] + i.imm) << 16) >> 16; hi = lo >> 31; break;
          case O.LW: lo = mem.r32(R[a] + i.imm); hi = lo >> 31; break;
          case O.LD: { const ad = R[a] + i.imm; lo = mem.r32(ad); hi = mem.r32(ad + 4); break; }
          case O.LBU: lo = mem.r8(R[a] + i.imm); break;
          case O.LHU: lo = mem.r16(R[a] + i.imm); break;
          case O.LWU: lo = mem.r32(R[a] + i.imm); break;
          case O.SB: wr = false; mem.w8(R[a] + i.imm, R[b]); break;
          case O.SH: wr = false; mem.w16(R[a] + i.imm, R[b]); break;
          case O.SW: wr = false; mem.w32(R[a] + i.imm, R[b]); break;
          case O.SD: { wr = false; const ad = R[a] + i.imm; mem.w32(ad, R[b]); mem.w32(ad + 4, R[b + 1]); break; }

          case O.ADDI: { const x = R[a], y = i.imm; lo = (x + y) | 0; hi = (R[a + 1] + (y >> 31) + ((x >>> 0) + (y >>> 0) > 0xffffffff ? 1 : 0)) | 0; break; }
          case O.SLTI: { const yh = i.imm >> 31; lo = (R[a + 1] < yh || (R[a + 1] === yh && (R[a] >>> 0) < (i.imm >>> 0))) ? 1 : 0; break; }
          case O.SLTIU: { const yh = (i.imm >> 31) >>> 0; lo = ((R[a + 1] >>> 0) < yh || ((R[a + 1] >>> 0) === yh && (R[a] >>> 0) < (i.imm >>> 0))) ? 1 : 0; break; }
          case O.XORI: lo = R[a] ^ i.imm; hi = R[a + 1] ^ (i.imm >> 31); break;
          case O.ORI: lo = R[a] | i.imm; hi = R[a + 1] | (i.imm >> 31); break;
          case O.ANDI: lo = R[a] & i.imm; hi = R[a + 1] & (i.imm >> 31); break;
          case O.SLLI: case O.SLL: case O.SRLI: case O.SRL: case O.SRAI: case O.SRA: {
            const s = (i.op === O.SLLI || i.op === O.SRLI || i.op === O.SRAI) ? i.imm & 63 : R[b] & 63;
            const xl = R[a], xh = R[a + 1];
            if (s === 0) { lo = xl; hi = xh; }
            else if (i.op === O.SLLI || i.op === O.SLL) {
              if (s < 32) { hi = (xh << s) | (xl >>> (32 - s)); lo = xl << s; } else { hi = xl << (s - 32); lo = 0; }
            } else if (i.op === O.SRLI || i.op === O.SRL) {
              if (s < 32) { lo = (xl >>> s) | (xh << (32 - s)); hi = xh >>> s; } else { lo = xh >>> (s - 32); hi = 0; }
            } else {
              if (s < 32) { lo = (xl >>> s) | (xh << (32 - s)); hi = xh >> s; } else { lo = xh >> (s - 32); hi = xh >> 31; }
            }
            break;
          }
          case O.ADD: { const x = R[a], y = R[b]; lo = (x + y) | 0; hi = (R[a + 1] + R[b + 1] + ((x >>> 0) + (y >>> 0) > 0xffffffff ? 1 : 0)) | 0; break; }
          case O.SUB: { const x = R[a], y = R[b]; lo = (x - y) | 0; hi = (R[a + 1] - R[b + 1] - ((x >>> 0) < (y >>> 0) ? 1 : 0)) | 0; break; }
          case O.SLT: lo = (R[a + 1] < R[b + 1] || (R[a + 1] === R[b + 1] && (R[a] >>> 0) < (R[b] >>> 0))) ? 1 : 0; break;
          case O.SLTU: lo = ((R[a + 1] >>> 0) < (R[b + 1] >>> 0) || (R[a + 1] === R[b + 1] && (R[a] >>> 0) < (R[b] >>> 0))) ? 1 : 0; break;
          case O.XOR: lo = R[a] ^ R[b]; hi = R[a + 1] ^ R[b + 1]; break;
          case O.OR: lo = R[a] | R[b]; hi = R[a + 1] | R[b + 1]; break;
          case O.AND: lo = R[a] & R[b]; hi = R[a + 1] & R[b + 1]; break;

          case O.ADDIW: lo = (R[a] + i.imm) | 0; hi = lo >> 31; break;
          case O.SLLIW: lo = R[a] << i.imm; hi = lo >> 31; break;
          case O.SRLIW: lo = (R[a] >>> i.imm) | 0; hi = lo >> 31; break;
          case O.SRAIW: lo = R[a] >> i.imm; hi = lo >> 31; break;
          case O.ADDW: lo = (R[a] + R[b]) | 0; hi = lo >> 31; break;
          case O.SUBW: lo = (R[a] - R[b]) | 0; hi = lo >> 31; break;
          case O.SLLW: lo = R[a] << (R[b] & 31); hi = lo >> 31; break;
          case O.SRLW: lo = (R[a] >>> (R[b] & 31)) | 0; hi = lo >> 31; break;
          case O.SRAW: lo = R[a] >> (R[b] & 31); hi = lo >> 31; break;

          case O.MUL: lo = Math.imul(R[a], R[b]); hi = (mulhu32(R[a], R[b]) + Math.imul(R[a], R[b + 1]) + Math.imul(R[a + 1], R[b])) | 0; break;
          case O.MULH: case O.MULHSU: case O.MULHU: {
            const x = i.op === O.MULHU ? bigU(R[a], R[a + 1]) : big(R[a], R[a + 1]);
            const y = i.op === O.MULH ? big(R[b], R[b + 1]) : bigU(R[b], R[b + 1]);
            const r = (x * y) >> 64n; lo = Number(BigInt.asIntN(32, r)); hi = Number(BigInt.asIntN(32, r >> 32n)); break;
          }
          case O.DIV: case O.DIVU: case O.REM: case O.REMU: {
            const s = i.op === O.DIV || i.op === O.REM;
            const x = s ? big(R[a], R[a + 1]) : bigU(R[a], R[a + 1]);
            const y = s ? big(R[b], R[b + 1]) : bigU(R[b], R[b + 1]);
            let r: bigint;
            if (y === 0n) r = (i.op === O.DIV || i.op === O.DIVU) ? -1n : x;
            else if (s && x === -(1n << 63n) && y === -1n) r = i.op === O.DIV ? x : 0n;
            else r = (i.op === O.DIV || i.op === O.DIVU) ? x / y : x % y;
            lo = Number(BigInt.asIntN(32, r)); hi = Number(BigInt.asIntN(32, r >> 32n)); break;
          }
          case O.MULW: lo = Math.imul(R[a], R[b]); hi = lo >> 31; break;
          case O.DIVW: { const x = R[a], y = R[b]; lo = y === 0 ? -1 : (x === -0x80000000 && y === -1) ? x : (x / y) | 0; hi = lo >> 31; break; }
          case O.DIVUW: { const x = R[a] >>> 0, y = R[b] >>> 0; lo = y === 0 ? -1 : Math.floor(x / y) | 0; hi = lo >> 31; break; }
          case O.REMW: { const x = R[a], y = R[b]; lo = y === 0 ? x : (x === -0x80000000 && y === -1) ? 0 : (x % y) | 0; hi = lo >> 31; break; }
          case O.REMUW: { const x = R[a] >>> 0, y = R[b] >>> 0; lo = y === 0 ? x | 0 : (x % y) | 0; hi = lo >> 31; break; }

          case O.FENCE: case O.NOP: wr = false; break;
          case O.ECALL:
            this.pc = npc; this.host.ecall(this); npc = this.pc; wr = false;
            if (this.stopReq) { this.stopReq = false; pc = npc; return; }
            break;
          case O.EBREAK: throw new CpuHalt(`ebreak at 0x${pc.toString(16)}`);
          case O.CSRRW: case O.CSRRS: case O.CSRRC: case O.CSRRWI: case O.CSRRSI: case O.CSRRCI: {
            const old = this.csrRead(i.imm);
            const v = i.op >= O.CSRRWI ? i.imm2 : R[a];
            if (i.op === O.CSRRW || i.op === O.CSRRWI) this.csrWrite(i.imm, v);
            else if (i.imm2 !== 0) this.csrWrite(i.imm, (i.op === O.CSRRS || i.op === O.CSRRSI) ? old | v : old & ~v);
            lo = old; hi = old >> 31; break;
          }
          case O.LR: { const ad = R[a]; lo = mem.r32(ad); hi = i.fmt ? mem.r32(ad + 4) : lo >> 31; break; }
          case O.SC: { const ad = R[a]; mem.w32(ad, R[b]); if (i.fmt) mem.w32(ad + 4, R[b + 1]); lo = 0; break; }
          case O.AMO: {
            const ad = R[a];
            const ol = mem.r32(ad), oh = i.fmt ? mem.r32(ad + 4) : ol >> 31;
            const x = i.fmt ? big(ol, oh) : BigInt(ol), y = i.fmt ? big(R[b], R[b + 1]) : BigInt(R[b]);
            const ux = i.fmt ? BigInt.asUintN(64, x) : BigInt.asUintN(32, x), uy = i.fmt ? BigInt.asUintN(64, y) : BigInt.asUintN(32, y);
            let r: bigint;
            switch (i.imm2) {
              case 0x01: r = y; break; case 0x00: r = x + y; break; case 0x04: r = x ^ y; break;
              case 0x0c: r = x & y; break; case 0x08: r = x | y; break;
              case 0x10: r = x < y ? x : y; break; case 0x14: r = x > y ? x : y; break;
              case 0x18: r = ux < uy ? x : y; break; case 0x1c: r = ux > uy ? x : y; break;
              default: throw new CpuHalt(`bad amo ${i.imm2}`);
            }
            mem.w32(ad, Number(BigInt.asIntN(32, r)));
            if (i.fmt) mem.w32(ad + 4, Number(BigInt.asIntN(32, r >> 32n)));
            lo = ol; hi = oh; break;
          }

          // ---- floating point ---------------------------------------------------------------
          case O.FLW: wr = false; FI[d] = mem.r32(R[a] + i.imm); FI[d + 1] = -1; break;
          case O.FLD: { wr = false; const ad = R[a] + i.imm; FI[d] = mem.r32(ad); FI[d + 1] = mem.r32(ad + 4); break; }
          case O.FSW: wr = false; mem.w32(R[a] + i.imm, FI[b]); break;
          case O.FSD: { wr = false; const ad = R[a] + i.imm; mem.w32(ad, FI[b]); mem.w32(ad + 4, FI[b + 1]); break; }
          case O.FMADD: case O.FMSUB: case O.FNMSUB: case O.FNMADD: {
            wr = false;
            const c = 2 * i.rs3;
            const x = i.fmt ? F64[i.rs1] : F32[a], y = i.fmt ? F64[i.rs2] : F32[b], z = i.fmt ? F64[i.rs3] : F32[c];
            const p = x * y;
            const r = i.op === O.FMADD ? p + z : i.op === O.FMSUB ? p - z : i.op === O.FNMSUB ? -p + z : -p - z;
            this.fwrite(rd, i.fmt, r); break;
          }
          case O.FADD: case O.FSUB: case O.FMUL: case O.FDIV: case O.FSQRT: case O.FMIN: case O.FMAX: {
            wr = false;
            const x = i.fmt ? F64[i.rs1] : F32[a], y = i.fmt ? F64[i.rs2] : F32[b];
            let r: number;
            switch (i.op) {
              case O.FADD: r = x + y; break; case O.FSUB: r = x - y; break; case O.FMUL: r = x * y; break;
              case O.FDIV: r = x / y; break; case O.FSQRT: r = Math.sqrt(x); break;
              case O.FMIN: r = Number.isNaN(x) ? y : Number.isNaN(y) ? x : (x === 0 && y === 0 ? (Object.is(x, -0) ? x : y) : Math.min(x, y)); break;
              default: r = Number.isNaN(x) ? y : Number.isNaN(y) ? x : (x === 0 && y === 0 ? (Object.is(x, -0) ? y : x) : Math.max(x, y)); break;
            }
            this.fwrite(rd, i.fmt, r); break;
          }
          case O.FSGNJ: case O.FSGNJN: case O.FSGNJX: {
            wr = false;
            const si = i.fmt ? 1 : 0; // word holding the sign bit
            const sa = FI[a + si] & 0x80000000, sb = FI[b + si] & 0x80000000;
            const s = i.op === O.FSGNJ ? sb : i.op === O.FSGNJN ? (~sb & 0x80000000) : (sa ^ sb);
            const l = FI[a], h = FI[a + 1];
            if (i.fmt) { FI[d] = l; FI[d + 1] = (h & 0x7fffffff) | s; }
            else { FI[d] = (l & 0x7fffffff) | s; FI[d + 1] = -1; }
            break;
          }
          case O.FCVT_FF: wr = false; if (i.fmt) F64[rd] = F32[a]; else { F32[d] = F64[i.rs1]; FI[d + 1] = -1; } break;
          case O.FEQ: case O.FLT: case O.FLE: {
            const x = i.fmt ? F64[i.rs1] : F32[a], y = i.fmt ? F64[i.rs2] : F32[b];
            lo = (i.op === O.FEQ ? x === y : i.op === O.FLT ? x < y : x <= y) ? 1 : 0; break;
          }
          case O.FCVT_IF: {
            const x = i.fmt ? F64[i.rs1] : F32[a];
            const r = roundRM(x, i.rm === 7 ? this.frm : i.rm);
            switch (i.imm2) {
              case 0: lo = Number.isNaN(x) || r > 2147483647 ? 2147483647 : r < -2147483648 ? -2147483648 : r; hi = lo >> 31; break;
              case 1: lo = Number.isNaN(x) || r > 4294967295 ? -1 : r < 0 ? 0 : r | 0; hi = lo >> 31; break;
              case 2: {
                const v = Number.isNaN(x) || r >= 9223372036854775807 ? 9223372036854775807n : r <= -9223372036854775808 ? -9223372036854775808n : BigInt(r);
                lo = Number(BigInt.asIntN(32, v)); hi = Number(BigInt.asIntN(32, v >> 32n)); break;
              }
              default: {
                const v = Number.isNaN(x) || r >= 18446744073709551615 ? 0xffffffffffffffffn : r <= 0 ? 0n : BigInt(r);
                lo = Number(BigInt.asIntN(32, v)); hi = Number(BigInt.asIntN(32, v >> 32n)); break;
              }
            }
            break;
          }
          case O.FCVT_FI: {
            wr = false;
            let v: number;
            switch (i.imm2) {
              case 0: v = R[a]; break; case 1: v = R[a] >>> 0; break;
              case 2: v = R[a + 1] * 4294967296 + (R[a] >>> 0); break;
              default: v = (R[a + 1] >>> 0) * 4294967296 + (R[a] >>> 0); break;
            }
            this.fwrite(rd, i.fmt, v); break;
          }
          case O.FMV_XF: if (i.fmt) { lo = FI[a]; hi = FI[a + 1]; } else { lo = FI[a]; hi = lo >> 31; } break;
          case O.FMV_FX: wr = false; FI[d] = R[a]; FI[d + 1] = i.fmt ? R[a + 1] : -1; break;
          case O.FCLASS: {
            const x = i.fmt ? F64[i.rs1] : F32[a];
            const neg = (FI[a + (i.fmt ? 1 : 0)] & 0x80000000) !== 0;
            const tiny = i.fmt ? 2.2250738585072014e-308 : 1.1754943508222875e-38;
            if (Number.isNaN(x)) lo = (i.fmt ? (FI[a + 1] & 0x80000) : (FI[a] & 0x400000)) ? 0x200 : 0x100;
            else if (x === Infinity) lo = 0x80; else if (x === -Infinity) lo = 0x1;
            else if (x === 0) lo = neg ? 0x8 : 0x10;
            else if (Math.abs(x) < tiny) lo = neg ? 0x4 : 0x20;
            else lo = neg ? 0x2 : 0x40;
            break;
          }

          // ---- T-Head ------------------------------------------------------------------------
          case O.TH_ADDSL: {
            const s = i.imm2; let yl = R[b], yh = R[b + 1];
            if (s) { yh = (yh << s) | (yl >>> (32 - s)); yl = yl << s; }
            const x = R[a]; lo = (x + yl) | 0; hi = (R[a + 1] + yh + ((x >>> 0) + (yl >>> 0) > 0xffffffff ? 1 : 0)) | 0; break;
          }
          case O.TH_SRRI: {
            const s = i.imm & 63, x = bigU(R[a], R[a + 1]);
            const r = BigInt.asUintN(64, (x >> BigInt(s)) | (x << BigInt((64 - s) & 63)));
            lo = Number(BigInt.asIntN(32, r)); hi = Number(BigInt.asIntN(32, r >> 32n)); break;
          }
          case O.TH_SRRIW: { const s = i.imm & 31, x = R[a]; lo = s ? (x >>> s) | (x << (32 - s)) : x; hi = lo >> 31; break; }
          case O.TH_EXT: case O.TH_EXTU: {
            const msb = i.imm, lsb = i.imm2;
            const x = bigU(R[a], R[a + 1]);
            const w = BigInt(msb - lsb + 1);
            let r = (x >> BigInt(lsb)) & ((1n << w) - 1n);
            if (i.op === O.TH_EXT) r = BigInt.asIntN(Number(w), r);
            lo = Number(BigInt.asIntN(32, r)); hi = Number(BigInt.asIntN(32, r >> 32n)); break;
          }
          case O.TH_FF0: case O.TH_FF1: {
            let xl = R[a], xh = R[a + 1];
            if (i.op === O.TH_FF0) { xl = ~xl; xh = ~xh; }
            lo = xh !== 0 ? Math.clz32(xh) : 32 + Math.clz32(xl); break;
          }
          case O.TH_REV: {
            const bs = (v: number) => ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24);
            lo = bs(R[a + 1]); hi = bs(R[a]); break;
          }
          case O.TH_REVW: { const v = R[a]; lo = ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24); hi = lo >> 31; break; }
          case O.TH_TSTNBZ: {
            const t = (v: number) => { let r = 0; for (let k = 0; k < 32; k += 8) if (((v >>> k) & 0xff) === 0) r |= 0xff << k; return r; };
            lo = t(R[a]); hi = t(R[a + 1]); break;
          }
          case O.TH_TST: { const s = i.imm; lo = s < 32 ? (R[a] >>> s) & 1 : (R[a + 1] >>> (s - 32)) & 1; break; }
          case O.TH_MVEQZ: if (R[b] === 0 && R[b + 1] === 0) { lo = R[a]; hi = R[a + 1]; } else wr = false; break;
          case O.TH_MVNEZ: if (R[b] !== 0 || R[b + 1] !== 0) { lo = R[a]; hi = R[a + 1]; } else wr = false; break;
          case O.TH_MULA: case O.TH_MULS: {
            const pl = Math.imul(R[a], R[b]);
            const ph = (mulhu32(R[a], R[b]) + Math.imul(R[a], R[b + 1]) + Math.imul(R[a + 1], R[b])) | 0;
            const xl = R[d], xh = R[d + 1];
            if (i.op === O.TH_MULA) { lo = (xl + pl) | 0; hi = (xh + ph + ((xl >>> 0) + (pl >>> 0) > 0xffffffff ? 1 : 0)) | 0; }
            else { lo = (xl - pl) | 0; hi = (xh - ph - ((xl >>> 0) < (pl >>> 0) ? 1 : 0)) | 0; }
            break;
          }
          case O.TH_MULAW: lo = (R[d] + Math.imul(R[a], R[b])) | 0; hi = lo >> 31; break;
          case O.TH_MULSW: lo = (R[d] - Math.imul(R[a], R[b])) | 0; hi = lo >> 31; break;
          case O.TH_MULAH: lo = (R[d] + Math.imul((R[a] << 16) >> 16, (R[b] << 16) >> 16)) | 0; hi = lo >> 31; break;
          case O.TH_MULSH: lo = (R[d] - Math.imul((R[a] << 16) >> 16, (R[b] << 16) >> 16)) | 0; hi = lo >> 31; break;
          case O.TH_LINC: case O.TH_LIDX: {
            let ad: number;
            if (i.op === O.TH_LINC) {
              const after = i.imm2 === 1;
              const base = R[a], nb = (base + i.imm) | 0;
              ad = after ? base : nb;
              // update base register (64-bit add of sign-extended immediate)
              const bh = (R[a + 1] + (i.imm >> 31) + ((base >>> 0) + (i.imm >>> 0) > 0xffffffff ? 1 : 0)) | 0;
              [lo, hi] = this.loadSized(ad, i.fmt);
              R[a] = nb; R[a + 1] = bh;
            } else {
              ad = (R[a] + (R[b] << i.imm2)) | 0;
              [lo, hi] = this.loadSized(ad, i.fmt);
            }
            break;
          }
          case O.TH_SINC: case O.TH_SIDX: {
            wr = false;
            if (i.op === O.TH_SINC) {
              const base = R[a], nb = (base + i.imm) | 0;
              const ad = i.imm2 === 1 ? base : nb;
              this.storeSized(ad, i.fmt, R[d], R[d + 1]);
              R[a + 1] = (R[a + 1] + (i.imm >> 31) + ((base >>> 0) + (i.imm >>> 0) > 0xffffffff ? 1 : 0)) | 0;
              R[a] = nb;
            } else {
              this.storeSized((R[a] + (R[b] << i.imm2)) | 0, i.fmt, R[d], R[d + 1]);
            }
            break;
          }
          case O.TH_LPAIR: {
            wr = false;
            const ad = (R[a] + i.imm) | 0, sz = (i.fmt & 3) === 3 ? 8 : 4;
            const [l1, h1] = this.loadSized(ad, i.fmt);
            const [l2, h2] = this.loadSized(ad + sz, i.fmt);
            if (rd) { R[d] = l1; R[d + 1] = h1; }
            if (i.rs2) { R[b] = l2; R[b + 1] = h2; }
            break;
          }
          case O.TH_SPAIR: {
            wr = false;
            const ad = (R[a] + i.imm) | 0, sz = (i.fmt & 3) === 3 ? 8 : 4;
            this.storeSized(ad, i.fmt, R[d], R[d + 1]);
            this.storeSized(ad + sz, i.fmt, R[b], R[b + 1]);
            break;
          }
          case O.TH_FLIDX: {
            wr = false;
            const ad = (R[a] + (R[b] << i.imm2)) | 0;
            if (i.fmt) { FI[d] = mem.r32(ad); FI[d + 1] = mem.r32(ad + 4); } else { FI[d] = mem.r32(ad); FI[d + 1] = -1; }
            break;
          }
          case O.TH_FSIDX: {
            wr = false;
            const ad = (R[a] + (R[b] << i.imm2)) | 0;
            mem.w32(ad, FI[d]); if (i.fmt) mem.w32(ad + 4, FI[d + 1]);
            break;
          }
          default:
            throw new CpuHalt(`illegal instruction ${OP_NAMES[i.op]} raw=0x${i.raw.toString(16)} at 0x${pc.toString(16)}`);
        }
        if (wr && rd) { R[d] = lo; R[d + 1] = hi; }
        pc = npc;
      }
    } finally {
      this.pc = pc;
    }
  }

  private fwrite(rd: number, fmt: number, v: number): void {
    if (fmt) this.F64[rd] = v;
    else { this.F32[2 * rd] = v; this.FI[2 * rd + 1] = -1; }
  }

  private loadSized(ad: number, fmt: number): [number, number] {
    const m = this.mem;
    switch (fmt) {
      case 0: { const v = (m.r8(ad) << 24) >> 24; return [v, v >> 31]; }
      case 1: { const v = (m.r16(ad) << 16) >> 16; return [v, v >> 31]; }
      case 2: { const v = m.r32(ad); return [v, v >> 31]; }
      case 3: return [m.r32(ad), m.r32(ad + 4)];
      case SZ_U + 0: return [m.r8(ad), 0];
      case SZ_U + 1: return [m.r16(ad), 0];
      case SZ_U + 2: return [m.r32(ad), 0];
    }
    throw new CpuHalt(`bad load size ${fmt}`);
  }

  private storeSized(ad: number, fmt: number, lo: number, hi: number): void {
    const m = this.mem;
    switch (fmt & 3) {
      case 0: m.w8(ad, lo); return;
      case 1: m.w16(ad, lo); return;
      case 2: m.w32(ad, lo); return;
      case 3: m.w32(ad, lo); m.w32(ad + 4, hi); return;
    }
  }
}

export { MEM_BASE };
