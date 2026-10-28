// RV64GC + T-Head (C906) instruction decoder.
// Encodings: RISC-V unprivileged spec + QEMU target/riscv/xthead.decode.
// Compressed instructions are expanded into the same Insn form as 32-bit ones.

export const O = {
  ILLEGAL: 0,
  LUI: 1, AUIPC: 2, JAL: 3, JALR: 4,
  BEQ: 5, BNE: 6, BLT: 7, BGE: 8, BLTU: 9, BGEU: 10,
  LB: 11, LH: 12, LW: 13, LD: 14, LBU: 15, LHU: 16, LWU: 17,
  SB: 18, SH: 19, SW: 20, SD: 21,
  ADDI: 22, SLTI: 23, SLTIU: 24, XORI: 25, ORI: 26, ANDI: 27, SLLI: 28, SRLI: 29, SRAI: 30,
  ADD: 31, SUB: 32, SLL: 33, SLT: 34, SLTU: 35, XOR: 36, SRL: 37, SRA: 38, OR: 39, AND: 40,
  ADDIW: 41, SLLIW: 42, SRLIW: 43, SRAIW: 44,
  ADDW: 45, SUBW: 46, SLLW: 47, SRLW: 48, SRAW: 49,
  MUL: 50, MULH: 51, MULHSU: 52, MULHU: 53, DIV: 54, DIVU: 55, REM: 56, REMU: 57,
  MULW: 58, DIVW: 59, DIVUW: 60, REMW: 61, REMUW: 62,
  FENCE: 63, ECALL: 64, EBREAK: 65,
  CSRRW: 66, CSRRS: 67, CSRRC: 68, CSRRWI: 69, CSRRSI: 70, CSRRCI: 71,
  LR: 72, SC: 73, AMO: 74, // AMO: imm2 = funct5, fmt = 0 (W) / 1 (D)
  FLW: 75, FLD: 76, FSW: 77, FSD: 78,
  FMADD: 79, FMSUB: 80, FNMSUB: 81, FNMADD: 82,
  FADD: 83, FSUB: 84, FMUL: 85, FDIV: 86, FSQRT: 87,
  FSGNJ: 88, FSGNJN: 89, FSGNJX: 90, FMIN: 91, FMAX: 92,
  FCVT_FF: 93, // fcvt.s.d / fcvt.d.s
  FEQ: 94, FLT: 95, FLE: 96,
  FCVT_IF: 97, // fp -> int, imm2 = 0 w,1 wu,2 l,3 lu
  FCVT_FI: 98, // int -> fp, imm2 = 0 w,1 wu,2 l,3 lu
  FMV_XF: 99, FCLASS: 100, FMV_FX: 101,
  // T-Head
  TH_ADDSL: 102, TH_SRRI: 103, TH_SRRIW: 104, TH_EXT: 105, TH_EXTU: 106,
  TH_FF0: 107, TH_FF1: 108, TH_REV: 109, TH_REVW: 110, TH_TSTNBZ: 111, TH_TST: 112,
  TH_MVEQZ: 113, TH_MVNEZ: 114,
  TH_MULA: 115, TH_MULAH: 116, TH_MULAW: 117, TH_MULS: 118, TH_MULSH: 119, TH_MULSW: 120,
  TH_LINC: 121,  // load + rs1 update. imm = offset, imm2: bit0 ia(1)/ib(0); size/sign in fmt
  TH_SINC: 122,
  TH_LIDX: 123,  // load rs1 + (rs2 << imm2)
  TH_SIDX: 124,
  TH_LPAIR: 125, TH_SPAIR: 126, // rd, rs2 = rd2, imm = byte offset, fmt = size
  TH_FLIDX: 127, TH_FSIDX: 128,
  NOP: 129,
} as const;

export const OP_NAMES: string[] = [];
for (const [k, v] of Object.entries(O)) OP_NAMES[v] = k.toLowerCase();

export interface Insn {
  op: number;
  rd: number; rs1: number; rs2: number; rs3: number;
  imm: number;   // sign-extended 32-bit immediate (or shamt / csr number)
  imm2: number;  // secondary field (funct, shift amount, lsb, ...)
  fmt: number;   // fp format 0=S 1=D, or memory access size code
  rm: number;
  len: number;   // 2 or 4
  raw: number;
}

function mk(op: number, len: number, raw: number): Insn {
  return { op, rd: 0, rs1: 0, rs2: 0, rs3: 0, imm: 0, imm2: 0, fmt: 0, rm: 0, len, raw };
}

const sext = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits);

// Memory size codes used in fmt for load/store variants: 0=b 1=h 2=w 3=d, +4 = unsigned
export const SZ_U = 4;

export function decode(raw: number): Insn {
  if ((raw & 3) !== 3) return decodeC(raw & 0xffff);
  return decode32(raw | 0);
}

function decode32(raw: number): Insn {
  const opc = raw & 0x7f;
  const rd = (raw >>> 7) & 0x1f, rs1 = (raw >>> 15) & 0x1f, rs2 = (raw >>> 20) & 0x1f;
  const f3 = (raw >>> 12) & 7, f7 = raw >>> 25;
  const immI = raw >> 20;
  const immS = ((raw >> 25) << 5) | ((raw >>> 7) & 0x1f);
  let i: Insn;
  const R = (op: number) => { i = mk(op, 4, raw); i.rd = rd; i.rs1 = rs1; i.rs2 = rs2; return i; };
  const I = (op: number, imm = immI) => { R(op); i.imm = imm; return i; };

  switch (opc) {
    case 0x37: return I(O.LUI, raw & 0xfffff000);
    case 0x17: return I(O.AUIPC, raw & 0xfffff000);
    case 0x6f: return I(O.JAL, ((raw >> 31) << 20) | (raw & 0xff000) | (((raw >>> 20) & 1) << 11) | (((raw >>> 21) & 0x3ff) << 1));
    case 0x67: return f3 === 0 ? I(O.JALR) : mk(O.ILLEGAL, 4, raw);
    case 0x63: {
      const imm = ((raw >> 31) << 12) | (((raw >>> 7) & 1) << 11) | (((raw >>> 25) & 0x3f) << 5) | (((raw >>> 8) & 0xf) << 1);
      const ops = [O.BEQ, O.BNE, -1, -1, O.BLT, O.BGE, O.BLTU, O.BGEU];
      return ops[f3] < 0 ? mk(O.ILLEGAL, 4, raw) : I(ops[f3], imm);
    }
    case 0x03: {
      const ops = [O.LB, O.LH, O.LW, O.LD, O.LBU, O.LHU, O.LWU, -1];
      return ops[f3] < 0 ? mk(O.ILLEGAL, 4, raw) : I(ops[f3]);
    }
    case 0x23: {
      const ops = [O.SB, O.SH, O.SW, O.SD];
      return f3 > 3 ? mk(O.ILLEGAL, 4, raw) : I(ops[f3], immS);
    }
    case 0x13: {
      const sh = (raw >>> 20) & 0x3f, f6 = raw >>> 26;
      switch (f3) {
        case 0: return I(O.ADDI); case 2: return I(O.SLTI); case 3: return I(O.SLTIU);
        case 4: return I(O.XORI); case 6: return I(O.ORI); case 7: return I(O.ANDI);
        case 1: return f6 === 0 ? I(O.SLLI, sh) : mk(O.ILLEGAL, 4, raw);
        case 5: return f6 === 0 ? I(O.SRLI, sh) : f6 === 0x10 ? I(O.SRAI, sh) : mk(O.ILLEGAL, 4, raw);
      }
      break;
    }
    case 0x1b: {
      const sh = (raw >>> 20) & 0x1f;
      if (f3 === 0) return I(O.ADDIW);
      if (f3 === 1 && f7 === 0) return I(O.SLLIW, sh);
      if (f3 === 5 && f7 === 0) return I(O.SRLIW, sh);
      if (f3 === 5 && f7 === 0x20) return I(O.SRAIW, sh);
      break;
    }
    case 0x33: {
      if (f7 === 1) return R([O.MUL, O.MULH, O.MULHSU, O.MULHU, O.DIV, O.DIVU, O.REM, O.REMU][f3]);
      if (f7 === 0) return R([O.ADD, O.SLL, O.SLT, O.SLTU, O.XOR, O.SRL, O.OR, O.AND][f3]);
      if (f7 === 0x20 && f3 === 0) return R(O.SUB);
      if (f7 === 0x20 && f3 === 5) return R(O.SRA);
      break;
    }
    case 0x3b: {
      if (f7 === 1) {
        const ops = [O.MULW, -1, -1, -1, O.DIVW, O.DIVUW, O.REMW, O.REMUW];
        if (ops[f3] >= 0) return R(ops[f3]);
        break;
      }
      if (f7 === 0 && f3 === 0) return R(O.ADDW);
      if (f7 === 0x20 && f3 === 0) return R(O.SUBW);
      if (f7 === 0 && f3 === 1) return R(O.SLLW);
      if (f7 === 0 && f3 === 5) return R(O.SRLW);
      if (f7 === 0x20 && f3 === 5) return R(O.SRAW);
      break;
    }
    case 0x0f: return mk(O.FENCE, 4, raw);
    case 0x73: {
      if (f3 === 0) {
        if (raw === 0x00000073) return mk(O.ECALL, 4, raw);
        if (raw === 0x00100073) return mk(O.EBREAK, 4, raw);
        return mk(O.NOP, 4, raw); // wfi / sret / sfence.vma: not expected in app code
      }
      const ops = [-1, O.CSRRW, O.CSRRS, O.CSRRC, -1, O.CSRRWI, O.CSRRSI, O.CSRRCI];
      if (ops[f3] < 0) break;
      R(ops[f3]); i!.imm = (raw >>> 20) & 0xfff; i!.imm2 = rs1; return i!;
    }
    case 0x2f: {
      if (f3 !== 2 && f3 !== 3) break;
      const f5 = raw >>> 27;
      R(f5 === 2 ? O.LR : f5 === 3 ? O.SC : O.AMO);
      i!.imm2 = f5; i!.fmt = f3 === 3 ? 1 : 0; return i!;
    }
    case 0x07: if (f3 === 2) return I(O.FLW); if (f3 === 3) return I(O.FLD); break;
    case 0x27: if (f3 === 2) return I(O.FSW, immS); if (f3 === 3) return I(O.FSD, immS); break;
    case 0x43: case 0x47: case 0x4b: case 0x4f: {
      const op = opc === 0x43 ? O.FMADD : opc === 0x47 ? O.FMSUB : opc === 0x4b ? O.FNMSUB : O.FNMADD;
      R(op); i!.rs3 = raw >>> 27; i!.fmt = f7 & 3; i!.rm = f3; return i!;
    }
    case 0x53: {
      const f5 = raw >>> 27, fmt = f7 & 3;
      if (fmt > 1) break;
      let op = -1, imm2 = 0;
      switch (f5) {
        case 0x00: op = O.FADD; break; case 0x01: op = O.FSUB; break;
        case 0x02: op = O.FMUL; break; case 0x03: op = O.FDIV; break;
        case 0x0b: op = O.FSQRT; break;
        case 0x04: op = [O.FSGNJ, O.FSGNJN, O.FSGNJX][f3] ?? -1; break;
        case 0x05: op = f3 === 0 ? O.FMIN : f3 === 1 ? O.FMAX : -1; break;
        case 0x08: op = O.FCVT_FF; break;
        case 0x14: op = f3 === 2 ? O.FEQ : f3 === 1 ? O.FLT : f3 === 0 ? O.FLE : -1; break;
        case 0x18: op = O.FCVT_IF; imm2 = rs2; break;
        case 0x1a: op = O.FCVT_FI; imm2 = rs2; break;
        case 0x1c: op = f3 === 0 ? O.FMV_XF : f3 === 1 ? O.FCLASS : -1; break;
        case 0x1e: op = O.FMV_FX; break;
      }
      if (op < 0) break;
      R(op); i!.fmt = fmt; i!.rm = f3; i!.imm2 = imm2; return i!;
    }
    case 0x0b: return decodeThead(raw);
  }
  return mk(O.ILLEGAL, 4, raw);
}

function decodeThead(raw: number): Insn {
  const rd = (raw >>> 7) & 0x1f, rs1 = (raw >>> 15) & 0x1f, rs2 = (raw >>> 20) & 0x1f;
  const f3 = (raw >>> 12) & 7, f7 = raw >>> 25, f6 = raw >>> 26, f5 = raw >>> 27;
  const imm2 = (raw >>> 25) & 3;
  const i = mk(O.ILLEGAL, 4, raw);
  i.rd = rd; i.rs1 = rs1; i.rs2 = rs2;
  const set = (op: number) => { i.op = op; return i; };

  switch (f3) {
    case 0: return set(O.NOP); // cache maintenance, sync, sfence
    case 1:
      if (f7 <= 3) { i.imm2 = f7; return set(O.TH_ADDSL); }
      if (f6 === 0x04) { i.imm = (raw >>> 20) & 0x3f; return set(O.TH_SRRI); }
      if (f7 === 0x0a) { i.imm = rs2; return set(O.TH_SRRIW); }
      if (f6 === 0x22) { i.imm = (raw >>> 20) & 0x3f; return set(O.TH_TST); }
      if (rs2 === 0) {
        if (f7 === 0x42) return set(O.TH_FF0);
        if (f7 === 0x43) return set(O.TH_FF1);
        if (f7 === 0x41) return set(O.TH_REV);
        if (f7 === 0x48) return set(O.TH_REVW);
        if (f7 === 0x40) return set(O.TH_TSTNBZ);
      }
      switch (f7) {
        case 0x20: return set(O.TH_MVEQZ); case 0x21: return set(O.TH_MVNEZ);
        case 0x10: return set(O.TH_MULA); case 0x14: return set(O.TH_MULAH); case 0x12: return set(O.TH_MULAW);
        case 0x11: return set(O.TH_MULS); case 0x15: return set(O.TH_MULSH); case 0x13: return set(O.TH_MULSW);
      }
      return i;
    case 2: case 3:
      i.imm = raw >>> 26;               // msb
      i.imm2 = (raw >>> 20) & 0x3f;     // lsb
      return set(f3 === 2 ? O.TH_EXT : O.TH_EXTU);
    case 4: case 5: {
      const load = f3 === 4;
      const size = (f5 >>> 2) & 3, uns = (f5 >>> 4) & 1;
      if (f5 === 0x1f || f5 === 0x1c || f5 === 0x1e) {
        if (!load && f5 === 0x1e) return i;
        i.rs2 = rs2; // second destination / source register
        i.fmt = f5 === 0x1f ? 3 : f5 === 0x1e ? 2 + SZ_U : 2;
        i.imm = imm2 << (f5 === 0x1f ? 4 : 3);
        return set(load ? O.TH_LPAIR : O.TH_SPAIR);
      }
      if (f5 & 1) {
        // meminc: bit1 = increment after
        if (!load && uns) return i;
        i.fmt = size + (uns ? SZ_U : 0);
        i.imm = sext(rs2, 5) << imm2;
        i.imm2 = (f5 >>> 1) & 1;
        return set(load ? O.TH_LINC : O.TH_SINC);
      }
      // memidx: bit1 = zero-extend rs2 (ur)
      if (!load && uns) return i;
      i.fmt = size + (uns ? SZ_U : 0);
      i.imm2 = imm2;
      i.rs3 = (f5 >>> 1) & 1;
      return set(load ? O.TH_LIDX : O.TH_SIDX);
    }
    case 6: case 7: {
      if ((f5 & 0x11) !== 0 || !(f5 & 0x08)) return i;
      // 01000 w, 01010 uw, 01100 d, 01110 ud
      i.fmt = (f5 >>> 2) & 1; // 0 = S, 1 = D
      i.rs3 = (f5 >>> 1) & 1;
      i.imm2 = imm2;
      return set(f3 === 6 ? O.TH_FLIDX : O.TH_FSIDX);
    }
  }
  return i;
}

function decodeC(h: number): Insn {
  const q = h & 3, f3 = h >>> 13;
  const b = (n: number) => (h >>> n) & 1;
  const rdF = (h >>> 7) & 0x1f, rs2F = (h >>> 2) & 0x1f;
  const rdP = 8 + ((h >>> 2) & 7), rs1P = 8 + ((h >>> 7) & 7);
  const imm6 = sext((b(12) << 5) | ((h >>> 2) & 0x1f), 6);
  const i = mk(O.ILLEGAL, 2, h);
  const set = (op: number, rd: number, rs1: number, rs2: number, imm: number) => {
    i.op = op; i.rd = rd; i.rs1 = rs1; i.rs2 = rs2; i.imm = imm; return i;
  };
  if (h === 0) return i;

  if (q === 0) {
    const uimmLD = (((h >>> 10) & 7) << 3) | (((h >>> 5) & 3) << 6);
    const uimmLW = (((h >>> 10) & 7) << 3) | (b(6) << 2) | (b(5) << 6);
    switch (f3) {
      case 0: {
        const nz = (((h >>> 11) & 3) << 4) | (((h >>> 7) & 0xf) << 6) | (b(6) << 2) | (b(5) << 3);
        return nz ? set(O.ADDI, rdP, 2, 0, nz) : i;
      }
      case 1: return set(O.FLD, rdP, rs1P, 0, uimmLD);
      case 2: return set(O.LW, rdP, rs1P, 0, uimmLW);
      case 3: return set(O.LD, rdP, rs1P, 0, uimmLD);
      case 5: return set(O.FSD, 0, rs1P, rdP, uimmLD);
      case 6: return set(O.SW, 0, rs1P, rdP, uimmLW);
      case 7: return set(O.SD, 0, rs1P, rdP, uimmLD);
    }
    return i;
  }
  if (q === 1) {
    switch (f3) {
      case 0: return set(O.ADDI, rdF, rdF, 0, imm6);
      case 1: return rdF ? set(O.ADDIW, rdF, rdF, 0, imm6) : i;
      case 2: return set(O.ADDI, rdF, 0, 0, imm6);
      case 3:
        if (rdF === 2) {
          const imm = sext((b(12) << 9) | (b(6) << 4) | (b(5) << 6) | (((h >>> 3) & 3) << 7) | (b(2) << 5), 10);
          return imm ? set(O.ADDI, 2, 2, 0, imm) : i;
        }
        return imm6 ? set(O.LUI, rdF, 0, 0, imm6 << 12) : i;
      case 4: {
        const f2 = (h >>> 10) & 3;
        const sh = (b(12) << 5) | ((h >>> 2) & 0x1f);
        if (f2 === 0) return set(O.SRLI, rs1P, rs1P, 0, sh);
        if (f2 === 1) return set(O.SRAI, rs1P, rs1P, 0, sh);
        if (f2 === 2) return set(O.ANDI, rs1P, rs1P, 0, imm6);
        const f = (h >>> 5) & 3;
        if (!b(12)) return set([O.SUB, O.XOR, O.OR, O.AND][f], rs1P, rs1P, rdP, 0);
        if (f === 0) return set(O.SUBW, rs1P, rs1P, rdP, 0);
        if (f === 1) return set(O.ADDW, rs1P, rs1P, rdP, 0);
        return i;
      }
      case 5: {
        const imm = sext((b(12) << 11) | (b(11) << 4) | (((h >>> 9) & 3) << 8) | (b(8) << 10) | (b(7) << 6) |
          (b(6) << 7) | (((h >>> 3) & 7) << 1) | (b(2) << 5), 12);
        return set(O.JAL, 0, 0, 0, imm);
      }
      case 6: case 7: {
        const imm = sext((b(12) << 8) | (((h >>> 10) & 3) << 3) | (((h >>> 5) & 3) << 6) | (((h >>> 3) & 3) << 1) | (b(2) << 5), 9);
        return set(f3 === 6 ? O.BEQ : O.BNE, 0, rs1P, 0, imm);
      }
    }
    return i;
  }
  if (q === 2) {
    const uLDSP = (b(12) << 5) | (((h >>> 5) & 3) << 3) | (((h >>> 2) & 7) << 6);
    const uLWSP = (b(12) << 5) | (((h >>> 4) & 7) << 2) | (((h >>> 2) & 3) << 6);
    const uSDSP = (((h >>> 10) & 7) << 3) | (((h >>> 7) & 7) << 6);
    const uSWSP = (((h >>> 9) & 0xf) << 2) | (((h >>> 7) & 3) << 6);
    switch (f3) {
      case 0: return set(O.SLLI, rdF, rdF, 0, (b(12) << 5) | rs2F);
      case 1: return set(O.FLD, rdF, 2, 0, uLDSP);
      case 2: return rdF ? set(O.LW, rdF, 2, 0, uLWSP) : i;
      case 3: return rdF ? set(O.LD, rdF, 2, 0, uLDSP) : i;
      case 4:
        if (!b(12)) {
          if (rs2F === 0) return rdF ? set(O.JALR, 0, rdF, 0, 0) : i;
          return set(O.ADD, rdF, 0, rs2F, 0);
        }
        if (rs2F === 0) return rdF === 0 ? set(O.EBREAK, 0, 0, 0, 0) : set(O.JALR, 1, rdF, 0, 0);
        return set(O.ADD, rdF, rdF, rs2F, 0);
      case 5: return set(O.FSD, 0, 2, rs2F, uSDSP);
      case 6: return set(O.SW, 0, 2, rs2F, uSWSP);
      case 7: return set(O.SD, 0, 2, rs2F, uSDSP);
    }
  }
  return i;
}
