// Differential check of our decoder against llvm-objdump over the whole init.axf .text.
// Compares mnemonic class, instruction length, branch/jump targets and load/store offsets.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from '../src/boot.ts';
import { readFileSync } from 'node:fs';
import { decode, O, OP_NAMES, type Insn } from '../src/decode.ts';
import { loadElf } from '../src/elf.ts';

const a = parseArgs(process.argv.slice(2));
const dump = a.opt('--dump', process.env.EKIY_DUMP ?? '');
if (!dump.trim()) {
  console.log('SKIP check-decode: provide --dump <dump_tool output dir> or EKIY_DUMP (and LLVM objdump, or --dis <listing>).');
  process.exit(0);
}
const elfPath = resolve(dump, 'gpt.bin.out/2_ROOTFS.bin.out/apps/init.axf');
const disPath = a.opt('--dis', process.env.EKIY_DISASSEMBLY ?? '');
let disassembly: string;
if (disPath) {
  disassembly = readFileSync(disPath, 'utf8');
} else {
  const result = spawnSync(process.env.LLVM_OBJDUMP ?? 'llvm-objdump', [
    '-d', '--no-show-raw-insn', '--triple=riscv64',
    '--mattr=+c,+m,+a,+f,+d,+zicsr,+zifencei,+xtheadba,+xtheadbb,+xtheadbs,+xtheadcondmov,+xtheadmac,+xtheadmemidx,+xtheadmempair,+xtheadsync,+xtheadfmemidx,+xtheadcmo',
    elfPath,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`LLVM objdump failed: ${result.error?.message ?? result.stderr}. Set LLVM_OBJDUMP or pass --dis <listing>.`);
  disassembly = result.stdout;
}
const elf = loadElf(readFileSync(elfPath));
const text = elf.sections.find(s => s.name === '.text')!;
const img = elf.data;

// llvm mnemonic -> accepted ops
const A: Record<string, number[]> = {
  mv: [O.ADDI, O.ADD], li: [O.ADDI], nop: [O.ADDI], 'sext.w': [O.ADDIW], ret: [O.JALR], jr: [O.JALR], jalr: [O.JALR],
  j: [O.JAL], jal: [O.JAL], beqz: [O.BEQ], bnez: [O.BNE], blez: [O.BGE], bgez: [O.BGE], bltz: [O.BLT], bgtz: [O.BLT],
  bgt: [O.BLT], ble: [O.BGE], bgtu: [O.BLTU], bleu: [O.BGEU], neg: [O.SUB], negw: [O.SUBW], not: [O.XORI],
  seqz: [O.SLTIU], snez: [O.SLTU], sltz: [O.SLT], sgtz: [O.SLT], 'zext.b': [O.ANDI],
  'fmv.s': [O.FSGNJ], 'fmv.d': [O.FSGNJ], 'fneg.s': [O.FSGNJN], 'fneg.d': [O.FSGNJN], 'fabs.s': [O.FSGNJX], 'fabs.d': [O.FSGNJX],
  csrr: [O.CSRRS], csrw: [O.CSRRW], csrs: [O.CSRRS], csrc: [O.CSRRC], csrwi: [O.CSRRWI], csrsi: [O.CSRRSI], csrci: [O.CSRRCI],
  frflags: [O.CSRRS], fsflags: [O.CSRRW], frrm: [O.CSRRS], fsrm: [O.CSRRW], frcsr: [O.CSRRS], fscsr: [O.CSRRW],
  fsflagsi: [O.CSRRWI], fsrmi: [O.CSRRWI], rdcycle: [O.CSRRS], rdtime: [O.CSRRS], rdinstret: [O.CSRRS],
  fence: [O.FENCE], 'fence.i': [O.FENCE], 'fence.tso': [O.FENCE], unimp: [O.ILLEGAL], 'c.unimp': [O.ILLEGAL],
  'flw': [O.FLW], 'fld': [O.FLD], 'fsw': [O.FSW], 'fsd': [O.FSD],
  'fmv.x.w': [O.FMV_XF], 'fmv.x.d': [O.FMV_XF], 'fmv.w.x': [O.FMV_FX], 'fmv.d.x': [O.FMV_FX],
  'fclass.s': [O.FCLASS], 'fclass.d': [O.FCLASS], 'fcvt.s.d': [O.FCVT_FF], 'fcvt.d.s': [O.FCVT_FF],
  'th.addsl': [O.TH_ADDSL], 'th.srri': [O.TH_SRRI], 'th.srriw': [O.TH_SRRIW], 'th.ext': [O.TH_EXT], 'th.extu': [O.TH_EXTU],
  'th.ff0': [O.TH_FF0], 'th.ff1': [O.TH_FF1], 'th.rev': [O.TH_REV], 'th.revw': [O.TH_REVW], 'th.tstnbz': [O.TH_TSTNBZ], 'th.tst': [O.TH_TST],
  'th.mveqz': [O.TH_MVEQZ], 'th.mvnez': [O.TH_MVNEZ], 'th.mula': [O.TH_MULA], 'th.mulah': [O.TH_MULAH], 'th.mulaw': [O.TH_MULAW],
  'th.muls': [O.TH_MULS], 'th.mulsh': [O.TH_MULSH], 'th.mulsw': [O.TH_MULSW],
  'th.ldd': [O.TH_LPAIR], 'th.lwd': [O.TH_LPAIR], 'th.lwud': [O.TH_LPAIR], 'th.sdd': [O.TH_SPAIR], 'th.swd': [O.TH_SPAIR],
  'th.sync': [O.NOP], 'th.sync.s': [O.NOP], 'th.sync.i': [O.NOP], 'th.sync.is': [O.NOP],
};
const fp = /^f(add|sub|mul|div|sqrt|sgnj|sgnjn|sgnjx|min|max|eq|lt|le|madd|msub|nmsub|nmadd)\.[sd]$/;
const fpOp: Record<string, number> = {
  add: O.FADD, sub: O.FSUB, mul: O.FMUL, div: O.FDIV, sqrt: O.FSQRT, sgnj: O.FSGNJ, sgnjn: O.FSGNJN, sgnjx: O.FSGNJX,
  min: O.FMIN, max: O.FMAX, eq: O.FEQ, lt: O.FLT, le: O.FLE, madd: O.FMADD, msub: O.FMSUB, nmsub: O.FNMSUB, nmadd: O.FNMADD,
};

function accepted(m: string): number[] | undefined {
  if (A[m]) return A[m];
  const f = fp.exec(m); if (f) return [fpOp[f[1]]];
  if (/^fcvt\.[wl]u?\.[sd]$/.test(m)) return [O.FCVT_IF];
  if (/^fcvt\.[sd]\.[wl]u?$/.test(m)) return [O.FCVT_FI];
  if (/^th\.(l[bhwd]u?i[ab])$/.test(m)) return [O.TH_LINC];
  if (/^th\.(s[bhwd]i[ab])$/.test(m)) return [O.TH_SINC];
  if (/^th\.lu?r[bhwd]u?$/.test(m)) return [O.TH_LIDX];
  if (/^th\.su?r[bhwd]$/.test(m)) return [O.TH_SIDX];
  if (/^th\.fl(u)?r[wd]$/.test(m)) return [O.TH_FLIDX];
  if (/^th\.fs(u)?r[wd]$/.test(m)) return [O.TH_FSIDX];
  if (/^th\.(dcache|icache|l2cache)/.test(m)) return [O.NOP];
  if (/^amo\w+\.[wd]/.test(m)) return [O.AMO];
  if (/^lr\.[wd]/.test(m)) return [O.LR];
  if (/^sc\.[wd]/.test(m)) return [O.SC];
  const k = (O as Record<string, number>)[m.toUpperCase().replace(/\./g, '_')];
  return k !== undefined ? [k] : undefined;
}

const ABI = ['zero','ra','sp','gp','tp','t0','t1','t2','s0','s1','a0','a1','a2','a3','a4','a5','a6','a7','s2','s3','s4','s5','s6','s7','s8','s9','s10','s11','t3','t4','t5','t6'];
const REG: Record<string, number> = Object.fromEntries(ABI.map((n, i) => [n, i]));
const lines = disassembly.split('\n');
const rx = /^\s*([0-9a-f]+):\s+(\S+)\s*(.*)$/;
let n = 0, bad = 0, unk = new Map<string, number>();
const rd16 = (va: number) => img.readUInt16LE(va - elf.base);
for (const l of lines) {
  const m = rx.exec(l); if (!m) continue;
  const pc = parseInt(m[1], 16), mn = m[2], args = m[3];
  if (pc < text.addr || pc >= text.addr + text.size) continue;
  if (mn === '<unknown>') continue;
  const lo = rd16(pc);
  const raw = (lo & 3) === 3 ? (lo | (rd16(pc + 2) << 16)) : lo;
  const ins: Insn = decode(raw);
  n++;
  const acc = accepted(mn);
  if (!acc) { unk.set(mn, (unk.get(mn) ?? 0) + 1); continue; }
  let err = '';
  if (!acc.includes(ins.op)) err = `op ${OP_NAMES[ins.op]}`;
  // branch / jump targets
  const t = /0x([0-9a-f]+) </.exec(args);
  if (!err && t && (ins.op === O.JAL || (ins.op >= O.BEQ && ins.op <= O.BGEU))) {
    if (((pc + ins.imm) >>> 0) !== parseInt(t[1], 16)) err = `target ${(pc + ins.imm) >>> 0}`;
  }
  // load/store displacement
  const d = /(-?0x[0-9a-f]+|-?\d+)\((\w+)\)$/.exec(args);
  if (!err && d && ins.op >= O.LB && ins.op <= O.SD) {
    if (ins.imm !== parseInt(d[1], 16) && ins.imm !== Number(d[1])) err = `disp ${ins.imm}`;
  }
  // register fields for plain integer ops / loads / stores
  if (!err) {
    const regs = args.split(',').map(x => x.trim());
    const want: [string, number][] = [];
    const isR = ins.op >= O.ADD && ins.op <= O.AND || ins.op >= O.ADDW && ins.op <= O.REMUW;
    const isI = ins.op >= O.ADDI && ins.op <= O.SRAI || ins.op >= O.ADDIW && ins.op <= O.SRAIW;
    const isL = ins.op >= O.LB && ins.op <= O.LWU, isS = ins.op >= O.SB && ins.op <= O.SD;
    if (isR && mn === OP_NAMES[ins.op]) want.push([regs[0], ins.rd], [regs[1], ins.rs1], [regs[2], ins.rs2]);
    if (isI && mn === OP_NAMES[ins.op]) want.push([regs[0], ins.rd], [regs[1], ins.rs1]);
    if (mn === 'mv') want.push([regs[0], ins.rd], [regs[1], ins.op === O.ADD ? ins.rs2 : ins.rs1]);
    if (isL || isS) { const b = /\((\w+)\)/.exec(regs[1])?.[1]; want.push([regs[0], isL ? ins.rd : ins.rs2]); if (b) want.push([b, ins.rs1]); }
    for (const [name, num] of want) if (REG[name] !== num) { err = `reg ${name}!=x${num}`; break; }
  }
  if (err) { if (bad++ < 25) console.log(`${pc.toString(16)} ${raw.toString(16).padStart(8, '0')} llvm="${mn} ${args}" ours=${err}`); }
}
console.log(`checked ${n} instructions, mismatches ${bad}`);
if (unk.size) console.log('unmapped llvm mnemonics:', [...unk].sort((a, b) => b[1] - a[1]).slice(0, 40));

if (n === 0 || bad > 0 || unk.size > 0) process.exitCode = 1;
