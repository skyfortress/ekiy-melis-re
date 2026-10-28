// High-level emulation of the Melis kernel underneath the apps/modules.
// Guest code reaches us through `ecall` (a7 = syscall number) and through trap addresses
// (continuations used when the kernel has to call back into guest code, e.g. MInit).

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { Cpu, CpuHalt, TRAP_BASE, type Host } from './cpu.ts';
import { Memory } from './mem.ts';
import { loadElf, type ModMagic } from './elf.ts';
import { SWI_NAMES } from './swi-names.ts';
import { DispDevice, StubDevice, SCREEN_W, SCREEN_H, type Device } from './devices.ts';

// /dev nodes treated as absent on this board
const ABSENT_DEVICES = new Set(['/dev/tpadc_rtp']);

const A0 = 10, A1 = 11, A2 = 12, A3 = 13, A4 = 14, A5 = 15, A7 = 17, RA = 1, SP = 2;

// Guest memory layout (all inside the 0xe0000000 window)
const HEAP_BASE = 0xea000000, HEAP_END = 0xee000000;
const STACK_BASE = 0xee000000, STACK_END = 0xef000000;
const TRAP_THREAD_EXIT = TRAP_BASE;
const TRAP_DYN_BASE = TRAP_BASE + 0x1000;

export interface KernelOptions {
  rootfs: string;            // extracted MinFS tree, mounted read-only as d:\
  overlay?: string;          // optional folder whose files shadow d:\ (for testing modified files)
  stateDir: string;          // host folder holding writable drives (e:\ = UDISK)
  trace?: boolean;           // log every syscall
  realtime?: boolean;        // tie the kernel tick (10 ms) to wall-clock time
  stubUnknown?: boolean;     // survey mode: unknown syscalls return 0 instead of halting
  udiskSeed?: string;        // folder copied into e:\ when it is empty (real UDISK contents)
  sysConfig?: string;        // sys_config.fex served through esCFG_GetKeyValue
  cfgOverride?: Record<string, string>; // "section.key" -> value
}

interface Module { mid: number; path: string; magic: ModMagic }

type ThreadState = 'ready' | 'sleep' | 'blocked' | 'dead';
interface Thread {
  tid: number; prio: number; name: string;
  R: Int32Array; F: Int32Array; pc: number;
  state: ThreadState; wakeAt: number; waitObj?: number;
  onWake?: (t: Thread, timedOut: boolean) => void;
}

interface Sem { cnt: number }
interface Queue { size: number; items: number[] }

export class Kernel implements Host {
  readonly mem = new Memory();
  readonly cpu: Cpu;
  readonly opt: KernelOptions;
  modules = new Map<number, Module>();
  private heapTop = HEAP_BASE;
  private allocs = new Map<number, number>(); // addr -> size
  private freeList: { addr: number; size: number }[] = [];
  private stackTop = STACK_END;
  private conts = new Map<number, (cpu: Cpu) => void>();
  private nextCont = TRAP_DYN_BASE;
  threads: Thread[] = [];
  cur!: Thread;
  private nextTid = 1;
  ticks = 0;
  private rr = 0;
  readonly t0 = Date.now();
  private sems = new Map<number, Sem>();
  private queues = new Map<number, Queue>();
  private drives: Record<string, { host: string; rw: boolean }>;
  private files = new Map<number, { path: string; host: string; data: Buffer; pos: number; dirty: boolean; rw: boolean }>();
  private dirs = new Map<number, { path: string; entries: string[]; pos: number; ent: number }>();
  private seen = new Set<number>();
  missing = new Map<string, number>();
  private cfg: Record<string, Record<string, string>> = {};
  private seenIoctl = new Set<string>();
  private ksrvMsgs: number[] = [];
  readonly disp: DispDevice;
  private fds = new Map<number, Device>();
  private nextFd = 3;
  private displayHld = 0;
  mixtureHld = { mid: 0, mp: 0 };
  grabs = new Map<number, { name: string; cb: number; arg: number; aux: number }>();
  log: (s: string) => void = s => console.log(s);
  onSlice?: () => void;

  constructor(opt: KernelOptions) {
    this.opt = opt;
    const e = join(opt.stateDir, 'e');
    mkdirSync(e, { recursive: true });
    if (opt.udiskSeed && readdirSync(e).length === 0) cpSync(opt.udiskSeed, e, { recursive: true });
    if (opt.sysConfig) this.cfg = parseFex(readFileSync(opt.sysConfig, 'latin1'));
    for (const [k, v] of Object.entries(opt.cfgOverride ?? {})) {
      const [sec, key] = k.split('.'); (this.cfg[sec] ??= {})[key] = v;
    }
    this.drives = { d: { host: opt.rootfs, rw: false }, e: { host: e, rw: true } };
    this.cpu = new Cpu(this.mem, this);
    this.disp = new DispDevice(this.mem, s => this.log(s));
  }

  // ---------------------------------------------------------------- memory
  malloc(size: number): number {
    size = (Math.max(size, 1) + 15) & ~15;
    const fi = this.freeList.findIndex(f => f.size >= size);
    let addr: number;
    if (fi >= 0) {
      const f = this.freeList[fi];
      addr = f.addr;
      if (f.size - size >= 64) { f.addr += size; f.size -= size; } else { this.freeList.splice(fi, 1); size = f.size; }
    } else {
      addr = this.heapTop;
      if (addr + size > HEAP_END) throw new CpuHalt(`guest heap exhausted (${size} bytes)`);
      this.heapTop += size;
    }
    this.allocs.set(addr, size);
    this.mem.fill(addr, size, 0);
    return addr;
  }
  free(addr: number): void {
    addr >>>= 0;
    if (!addr) return;
    const size = this.allocs.get(addr);
    if (size === undefined) { this.log(`  ! free of unknown pointer 0x${addr.toString(16)}`); return; }
    this.allocs.delete(addr);
    this.freeList.push({ addr, size });
  }
  realloc(addr: number, size: number): number {
    if (!addr) return this.malloc(size);
    const old = this.allocs.get(addr >>> 0) ?? 0;
    const n = this.malloc(size);
    this.mem.buf.copyWithin(n - 0xe0000000, (addr >>> 0) - 0xe0000000, (addr >>> 0) - 0xe0000000 + Math.min(old, size));
    this.free(addr);
    return n;
  }
  allocStack(size: number): number {
    size = (size + 0xfff) & ~0xfff;
    this.stackTop -= size + 0x1000; // guard gap
    if (this.stackTop < STACK_BASE) throw new CpuHalt('out of stack space');
    return this.stackTop + size; // initial sp (top)
  }
  newString(s: string): number { const p = this.malloc(s.length + 1); this.mem.writeCstr(p, s); return p; }

  // ---------------------------------------------------------------- guest calls
  /** Allocate a one-shot trap address; when guest code jumps there, `fn` runs. */
  cont(fn: (cpu: Cpu) => void): number {
    const a = this.nextCont; this.nextCont += 4;
    if (this.nextCont >= TRAP_BASE + 0xf0000) this.nextCont = TRAP_DYN_BASE;
    this.conts.set(a, cpu => { this.conts.delete(a); fn(cpu); });
    return a;
  }
  /** From inside a syscall: call guest `fn(args)`, then `then(ret)` decides what the syscall returns. */
  callGuest(fn: number, args: number[], then: (ret: number) => number): void {
    const cpu = this.cpu;
    const retPc = cpu.pc; // where the ecall stub continues
    args.forEach((v, k) => cpu.setU32(A0 + k, v));
    cpu.setU32(RA, this.cont(c => {
      const r = then(c.get(A0));
      if (r !== c.get(A0)) setRet(c, r); // otherwise keep the guest's full 64-bit return value
      c.pc = retPc;
    }));
    cpu.pc = fn >>> 0;
  }

  trap(cpu: Cpu, pc: number): void {
    if (pc === TRAP_THREAD_EXIT) { this.log(`[t${this.cur.tid}] thread "${this.cur.name}" returned`); this.cur.state = 'dead'; this.reschedule(); return; }
    const c = this.conts.get(pc);
    if (!c) throw new CpuHalt(`jump to unknown trap address 0x${pc.toString(16)} (from 0x${cpu.lastPc.toString(16)})`);
    c(cpu);
  }

  // ---------------------------------------------------------------- modules
  /** Map a Melis path ("d:\\apps\\x") to a host path. With `create`, the last component may be missing. */
  resolvePath(p: string, create = false): string | undefined {
    if (this.opt.overlay && /^d:/i.test(p) && !create) {
      const o = this.walk(this.opt.overlay, p.slice(2), false);
      if (o && existsSync(o) && statSync(o).isFile()) return o;
    }
    const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p);
    const drv = m && this.drives[m[1].toLowerCase()];
    if (!m || !drv) return undefined;
    return this.walk(drv.host, m[2], create);
  }
  /** Case-insensitive path walk (FAT / MinFS are case-insensitive). */
  private walk(root: string, rel: string, create: boolean): string | undefined {
    let cur = root;
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    for (let k = 0; k < parts.length; k++) {
      if (!existsSync(cur) || !statSync(cur).isDirectory()) return undefined;
      const hit = readdirSync(cur).find(e => e.toLowerCase() === parts[k].toLowerCase());
      if (!hit) return create && k === parts.length - 1 ? join(cur, parts[k]) : undefined;
      cur = join(cur, hit);
    }
    return cur;
  }
  private writable(p: string): boolean { return !!this.drives[p[0]?.toLowerCase()]?.rw; }

  loadModuleImage(path: string): Module | undefined {
    const host = this.resolvePath(path);
    if (!host) return undefined;
    const elf = loadElf(readFileSync(host));
    if (!elf.magic) throw new CpuHalt(`${path}: no MAGIC section`);
    for (const s of elf.segments) {
      this.mem.fill(s.vaddr, s.memsz, 0);
      this.mem.write(s.vaddr, elf.data.subarray(s.offset, s.offset + s.filesz));
    }
    this.cpu.invalidate();
    const mid = 96 + elf.magic.type;
    const m: Module = { mid, path, magic: elf.magic };
    this.modules.set(mid, m);
    this.log(`  loaded ${path} mid=${mid} @0x${elf.segments[0].vaddr.toString(16)} MInit=0x${elf.magic.mif.MInit.toString(16)}`);
    return m;
  }

  // ---------------------------------------------------------------- threads
  createThread(entry: number, arg: number, stack: number, prio: number, name: string): Thread {
    const t: Thread = {
      tid: this.nextTid++, prio, name, R: new Int32Array(64), F: new Int32Array(64), pc: entry >>> 0,
      state: 'ready', wakeAt: 0,
    };
    const sp = this.allocStack(stack || 0x4000);
    t.R[2 * SP] = sp; t.R[2 * RA] = TRAP_THREAD_EXIT | 0; t.R[2 * A0] = arg;
    this.threads.push(t);
    return t;
  }
  private save(t: Thread): void { t.R.set(this.cpu.R); t.F.set(this.cpu.FI); t.pc = this.cpu.pc; }
  private load(t: Thread): void { this.cpu.R.set(t.R); this.cpu.FI.set(t.F); this.cpu.pc = t.pc; this.cur = t; }

  /** Block the current thread and stop the CPU loop so the scheduler can switch. */
  block(state: ThreadState, wakeAt: number, onWake?: (t: Thread, timedOut: boolean) => void, waitObj?: number): void {
    this.cur.state = state; this.cur.wakeAt = wakeAt; this.cur.onWake = onWake; this.cur.waitObj = waitObj;
    this.reschedule();
  }
  reschedule(): void { this.cpu.stopReq = true; }
  wake(t: Thread, timedOut: boolean): void {
    t.state = 'ready';
    const cb = t.onWake; t.onWake = undefined; t.waitObj = undefined;
    if (cb) cb(t, timedOut);
  }

  /** Main loop: round-robin over ready threads with a time slice.
   *  Returns 'idle' in realtime mode when every thread waits for a future tick. */
  run(maxSteps: number, slice = 200_000): 'idle' | 'budget' {
    const stop = this.cpu.steps + maxSteps;
    const rt = this.opt.realtime;
    while (this.cpu.steps < stop) {
      if (rt) this.ticks = Math.max(this.ticks, Math.floor((Date.now() - this.t0) / 10));
      // timers
      for (const t of this.threads) if ((t.state === 'sleep' || t.state === 'blocked') && t.wakeAt && t.wakeAt <= this.ticks) this.wake(t, true);
      const ready = this.threads.filter(t => t.state === 'ready');
      if (!ready.length) {
        const pending = this.threads.filter(t => (t.state === 'sleep' || t.state === 'blocked') && t.wakeAt);
        if (!pending.length) { this.log('all threads blocked forever / dead'); this.dumpThreads(); throw new CpuHalt('deadlock'); }
        if (rt) return 'idle';
        this.ticks = Math.min(...pending.map(t => t.wakeAt));
        continue;
      }
      const t = ready[this.rr++ % ready.length];
      this.load(t);
      const before = this.cpu.steps;
      try {
        this.cpu.run(Math.min(slice, stop - this.cpu.steps));
      } finally {
        this.save(t);
      }
      this.onSlice?.();
      if (!rt) {
        // ~1 tick (10 ms) per 1M instructions of guest work
        this.ticks += Math.floor((this.cpu.steps - before) / 1_000_000);
        if (this.cpu.steps - before >= slice) this.ticks++;
      }
    }
    return 'budget';
  }

  dumpThreads(): void {
    for (const t of this.threads) this.log(`  t${t.tid} prio=${t.prio} ${t.state.padEnd(7)} pc=0x${t.pc.toString(16)} "${t.name}"${t.waitObj ? ` wait=0x${t.waitObj.toString(16)}` : ''}`);
  }

  // ---------------------------------------------------------------- syscalls
  ecall(cpu: Cpu): void {
    const n = cpu.getU(A7);
    const name = SWI_NAMES[n] ?? `swi_0x${n.toString(16)}`;
    const h = this.handlers[name];
    if (this.opt.trace || !this.seen.has(n)) {
      this.seen.add(n);
      const args = [A0, A1, A2, A3].map(r => '0x' + cpu.getU(r).toString(16)).join(', ');
      this.log(`[t${this.cur?.tid ?? 0} 0x${cpu.lastPc.toString(16)}] ${name}(${args})${name in this.handlers ? '' : '  <-- NOT IMPLEMENTED'}`);
    }
    if (!h) {
      if (this.opt.stubUnknown) { this.missing.set(name, (this.missing.get(name) ?? 0) + 1); cpu.set(A0, 0); return; }
      throw new CpuHalt(`unimplemented syscall ${name} (0x${n.toString(16)})`);
    }
    const r = h.call(this, cpu);
    if (typeof r === 'number') setRet(cpu, r);
    else if (typeof r === 'bigint') cpu.set64(A0, r);
  }

  private str(r: number): string { return this.mem.cstr(this.cpu.getU(r)); }

  handlers: Record<string, (this: Kernel, cpu: Cpu) => number | bigint | void> = {
    // --- SIOS
    esSIOS_putstr(cpu) { process.stdout.write(this.str(A0)); },

    // --- memory
    esMEMS_Malloc(cpu) { return this.malloc(cpu.getU(A1)); },
    esMEMS_Mfree(cpu) { this.free(cpu.getU(A1)); },
    esMEMS_Realloc(cpu) { return this.realloc(cpu.getU(A1), cpu.getU(A2)); },
    esMEMS_Calloc(cpu) { return this.malloc(cpu.getU(A1) * cpu.getU(A2)); },
    esMEMS_Balloc(cpu) { return this.malloc(cpu.getU(A0)); },
    esMEMS_Bfree(cpu) { this.free(cpu.getU(A0)); },
    esMEMS_Palloc(cpu) { return this.malloc(cpu.getU(A0) * 1024); },
    esMEMS_Pfree(cpu) { this.free(cpu.getU(A0)); },
    esMEMS_VA2PA(cpu) { return cpu.getU(A0); },
    esMEMS_CleanFlushDCacheRegion() { return 0; },
    esMEMS_CleanDCacheRegion() { return 0; },
    esMEMS_FlushDCacheRegion() { return 0; },
    esMEMS_FreeMemSize() { return HEAP_END - this.heapTop; },
    esMEMS_TotalMemSize() { return 64 << 20; },
    _malloc_r(cpu) { return this.malloc(cpu.getU(A1)); },
    _free_r(cpu) { this.free(cpu.getU(A1)); },
    _realloc_r(cpu) { return this.realloc(cpu.getU(A1), cpu.getU(A2)); },
    _calloc_r(cpu) { return this.malloc(cpu.getU(A1) * cpu.getU(A2)); },

    // --- kernel: threads & time
    esKRNL_TCreate(cpu) {
      const entry = cpu.getU(A0), arg = cpu.getU(A1), stk = cpu.getU(A2), prio = cpu.getU(A3) & 0xffff;
      const t = this.createThread(entry, arg, stk, prio, `entry_0x${entry.toString(16)}`);
      this.log(`  [t${this.cur.tid}] TCreate -> t${t.tid} entry=0x${entry.toString(16)} prio=0x${prio.toString(16)}`);
      return t.tid;
    },
    esKRNL_TaskNameSet(cpu) {
      const t = this.threads.find(x => x.tid === cpu.getU(A0)); if (t) t.name = this.str(A1); return 0;
    },
    esKRNL_GetTIDCur() { return this.cur.tid; },
    esKRNL_TDel(cpu) {
      const tid = cpu.getU(A0), t = tid === 0xff || tid === 0 ? this.cur : this.threads.find(x => x.tid === tid);
      if (t) { t.state = 'dead'; if (t === this.cur) this.reschedule(); }
      return 0;
    },
    esKRNL_TDelReq() { return 0; }, // nobody asked us to die
    esKRNL_TimeDly(cpu) { const n = cpu.getU(A0) & 0xffff; this.block('sleep', this.ticks + Math.max(1, n)); },
    esKRNL_TimeGet() { return this.ticks; },
    esKRNL_Time() { return this.ticks; },
    esKRNL_SchedLock() {}, esKRNL_SchedUnlock() {},
    esKRNL_GetCallBack(cpu) { return cpu.getU(A0); },
    esKRNL_CallBack(cpu) { this.callGuest(cpu.getU(A0), [cpu.getU(A1)], r => r); },
    esKRNL_Version() { return 0x400; },

    // --- semaphores / mutexes
    esKRNL_SemCreate(cpu) { const p = this.malloc(16); this.sems.set(p, { cnt: cpu.getU(A0) & 0xffff }); return p; },
    esKRNL_SemDel(cpu) { this.sems.delete(cpu.getU(A0)); return 0; },
    esKRNL_SemAccept(cpu) { const s = this.sems.get(cpu.getU(A0)); if (s && s.cnt > 0) return s.cnt--; return 0; },
    esKRNL_SemQuery() { return 0; },
    esKRNL_SemPost(cpu) {
      const p = cpu.getU(A0), s = this.sems.get(p); if (!s) return 1;
      const w = this.threads.find(t => t.state === 'blocked' && t.waitObj === p);
      if (w) this.wake(w, false); else s.cnt++;
      return 0;
    },
    esKRNL_SemPend(cpu) {
      const p = cpu.getU(A0), tmo = cpu.getU(A1) & 0xffff, err = cpu.getU(A2);
      const s = this.sems.get(p); if (!s) throw new CpuHalt(`SemPend on unknown sem 0x${p.toString(16)}`);
      const setErr = (v: number) => { if (err) this.mem.w8(err, v); };
      if (s.cnt > 0) { s.cnt--; setErr(0); return; }
      this.block('blocked', tmo ? this.ticks + tmo : 0, (_t, to) => setErr(to ? 10 : 0), p);
    },
    esKRNL_MutexCreate() { const p = this.malloc(16); this.sems.set(p, { cnt: 1 }); return p; },
    esKRNL_MutexDel(cpu) { this.sems.delete(cpu.getU(A0)); return 0; },
    esKRNL_MutexPend(cpu) { return this.handlers.esKRNL_SemPend.call(this, cpu); },
    esKRNL_MutexPost(cpu) { return this.handlers.esKRNL_SemPost.call(this, cpu); },

    // --- message queues
    esKRNL_QCreate(cpu) { const p = this.malloc(16); this.queues.set(p, { size: cpu.getU(A0) & 0xffff, items: [] }); return p; },
    esKRNL_QDel(cpu) { this.queues.delete(cpu.getU(A0)); return 0; },
    esKRNL_QFlush(cpu) { const q = this.queues.get(cpu.getU(A0)); if (q) q.items = []; return 0; },
    esKRNL_QQuery() { return 0; },
    esKRNL_QAccept(cpu) {
      const q = this.queues.get(cpu.getU(A0)), err = cpu.getU(A1);
      if (q && q.items.length) { if (err) this.mem.w8(err, 0); return BigInt.asUintN(64, BigInt(q.items.shift()!)); }
      if (err) this.mem.w8(err, 31); return 0;
    },
    esKRNL_QPost(cpu) { return this.qpost(cpu.getU(A0), cpu.getU(A1), false); },
    esKRNL_QPostFront(cpu) { return this.qpost(cpu.getU(A0), cpu.getU(A1), true); },
    esKRNL_QPend(cpu) {
      const p = cpu.getU(A0), tmo = cpu.getU(A1) & 0xffff, err = cpu.getU(A2);
      const q = this.queues.get(p); if (!q) throw new CpuHalt(`QPend on unknown queue 0x${p.toString(16)}`);
      if (q.items.length) { if (err) this.mem.w8(err, 0); return q.items.shift()!; }
      this.block('blocked', tmo ? this.ticks + tmo : 0, (t, to) => {
        const v = to ? 0 : q.items.shift() ?? 0;
        t.R[2 * A0] = v; t.R[2 * A0 + 1] = 0;
        if (err) this.mem.w8(err, to ? 10 : 0);
      }, p);
    },

    // --- modules
    esMODS_MInstall(cpu) {
      const path = this.str(A0);
      const m = this.loadModuleImage(path);
      if (!m) { this.log(`  MInstall: ${path} not found`); return 0; }
      this.callGuest(m.magic.mif.MInit, [], r => { this.log(`  ${path} MInit -> ${r}`); return m.mid; });
    },
    esMODS_MUninstall(cpu) { const m = this.modules.get(cpu.getU(A0) & 0xff); if (m) this.callGuest(m.magic.mif.MExit, [], () => 0); else return 0; },
    esMODS_MOpen(cpu) {
      const mid = cpu.getU(A0) & 0xff, mode = cpu.getU(A1) & 0xff;
      const m = this.modules.get(mid); if (!m) { this.log(`  MOpen of unknown mid ${mid}`); return 0; }
      this.callGuest(m.magic.mif.MOpen, [mid, mode], r => r);
    },
    esMODS_MClose(cpu) {
      const mp = cpu.getU(A0), m = mp ? this.modules.get(this.mem.r8(mp)) : undefined;
      if (!m) return 0; this.callGuest(m.magic.mif.MClose, [mp], r => r);
    },
    esMODS_MIoctrl(cpu) {
      const mp = cpu.getU(A0); if (!mp) return -1;
      const m = this.modules.get(this.mem.r8(mp));
      if (!m) throw new CpuHalt(`MIoctrl on mp 0x${mp.toString(16)} with unknown mid ${this.mem.r8(mp)}`);
      const key = `${m.path} 0x${cpu.getU(A1).toString(16)}`;
      if (this.opt.trace || !this.seenIoctl.has(key)) { this.seenIoctl.add(key); this.log(`  [t${this.cur.tid}] MIoctrl ${m.path.split('\\').pop()} cmd=0x${cpu.getU(A1).toString(16)} aux=0x${cpu.getU(A2).toString(16)} buf=0x${cpu.getU(A3).toString(16)}`); }
      this.callGuest(m.magic.mif.MIoctrl, [mp, cpu.getU(A1), cpu.getU(A2), cpu.getU(A3)], r => r);
    },

    // --- files
    esFSYS_fopen(cpu) { return this.fopen(this.str(A0), this.str(A1)); },
    _open_r(cpu) {
      const path = this.str(A1);
      if (path.startsWith('/dev/')) return this.openDev(path);
      const fl = cpu.getU(A2); // newlib O_ flags: 0 rdonly, 1 wronly, 2 rdwr, 0x200 creat, 0x400 trunc, 0x8 append
      const mode = (fl & 3) === 0 ? 'r' : (fl & 0x400) ? 'w+' : (fl & 0x8) ? 'a+' : (fl & 0x200) ? 'r+c' : 'r+';
      const h = this.fopen(this.str(A1), mode); return h || -1;
    },
    esFSYS_fclose(cpu) { this.fclose(cpu.getU(A0)); return 0; },
    _close_r(cpu) { const fd = cpu.getU(A1); if (this.fds.delete(fd)) return 0; this.fclose(fd); return 0; },
    esFSYS_fread(cpu) {
      const size = cpu.getU(A1), n = cpu.getU(A2);
      return size ? Math.floor(this.fread(cpu.getU(A3), cpu.getU(A0), size * n) / size) : 0;
    },
    _read_r(cpu) {
      const dev = this.fds.get(cpu.getU(A1));
      if (dev) {
        const r = dev.read ? dev.read(cpu.getU(A2), cpu.getU(A3)) : 0;
        if (r === 'block') { this.block('sleep', this.ticks + 100, t => { t.R[2 * A0] = 0; t.R[2 * A0 + 1] = 0; }); return; }
        return r;
      }
      return this.files.has(cpu.getU(A1)) ? this.fread(cpu.getU(A1), cpu.getU(A2), cpu.getU(A3)) : -1; },
    esFSYS_fwrite(cpu) {
      const size = cpu.getU(A1), n = cpu.getU(A2);
      return size ? Math.floor(this.fwrite(cpu.getU(A3), cpu.getU(A0), size * n) / size) : 0;
    },
    _write_r(cpu) {
      const fd = cpu.getU(A1), n = cpu.getU(A3);
      if (fd === 1 || fd === 2) { process.stdout.write(Buffer.from(this.mem.read(cpu.getU(A2), n)).toString('latin1')); return n; }
      const dev = this.fds.get(fd); if (dev) return dev.write ? dev.write(cpu.getU(A2), n) : n;
      return this.files.has(fd) ? this.fwrite(fd, cpu.getU(A2), n) : -1;
    },
    esFSYS_fseek(cpu) { return this.seek(cpu.getU(A0), cpu.get(A1), cpu.get(A2)); },
    _lseek_r(cpu) { const r = this.seek(cpu.getU(A1), cpu.get(A2), cpu.get(A3)); return r === 0 ? this.files.get(cpu.getU(A1))!.pos : -1; },
    esFSYS_ftell(cpu) { return this.files.get(cpu.getU(A0))?.pos ?? -1; },
    esFSYS_ferror() { return 0; },
    esFSYS_file2fd(cpu) { return cpu.getU(A0); },
    _isatty_r() { return 0; },
    _fstat_r() { return -1; },
    esFSYS_opendir(cpu) {
      const p = this.str(A0), host = this.resolvePath(p);
      const ok = !!host && statSync(host).isDirectory();
      this.log(`  opendir("${p}") -> ${ok ? 'ok' : 'not found'}`);
      if (!ok) return 0;
      const h = this.malloc(16), ent = this.malloc(0x118);
      this.dirs.set(h, { path: p, entries: readdirSync(host!), pos: 0, ent });
      return h;
    },
    esFSYS_readdir(cpu) {
      // legacy Melis dirent as read by init.axf: +4 u8 FAT attributes (0x10 = directory),
      // +8 u64 size, +0x10 char name[]
      const d = this.dirs.get(cpu.getU(A0)); if (!d || d.pos >= d.entries.length) return 0;
      const name = d.entries[d.pos++];
      const st = statSync(join(this.resolvePath(d.path)!, name));
      this.mem.fill(d.ent, 0x118);
      this.mem.w8(d.ent + 4, st.isDirectory() ? 0x10 : 0x20);
      this.mem.w32(d.ent + 8, st.isDirectory() ? 0 : st.size);
      this.mem.writeCstr(d.ent + 0x10, name.slice(0, 255));
      return d.ent;
    },
    esFSYS_rewinddir(cpu) { const d = this.dirs.get(cpu.getU(A0)); if (d) d.pos = 0; },
    esFSYS_closedir(cpu) { const d = this.dirs.get(cpu.getU(A0)); if (d) { this.free(d.ent); this.dirs.delete(cpu.getU(A0)); } return 0; },
    esFSYS_mkdir(cpu) {
      const p = this.str(A0), host = this.writable(p) ? this.resolvePath(p, true) : undefined;
      this.log(`  mkdir("${p}") -> ${host ? 'ok' : 'denied'}`);
      if (!host) return -1; mkdirSync(host, { recursive: true }); return 0;
    },
    esFSYS_remove(cpu) {
      const p = this.str(A0), host = this.writable(p) ? this.resolvePath(p) : undefined;
      this.log(`  remove("${p}") -> ${host ? 'ok' : 'denied/not found'}`);
      if (!host) return -1; rmSync(host, { force: true }); return 0;
    },
    esFSYS_rmdir(cpu) {
      const p = this.str(A0), host = this.writable(p) ? this.resolvePath(p) : undefined;
      if (!host) return -1; rmSync(host, { recursive: true, force: true }); return 0;
    },
    esFSYS_format(cpu) {
      const p = this.str(A0), fs = this.str(A1), host = this.writable(p) ? this.resolvePath(p) : undefined;
      this.log(`  format("${p}", "${fs}") -> ${host ? 'ok (host folder emptied)' : 'denied'}`);
      if (!host) return -1;
      for (const e of readdirSync(host)) rmSync(join(host, e), { recursive: true, force: true });
      return 0;
    },
    esFSYS_statpt() { return -1; },
    esFSYS_querypartupdateflag() { return 0; },

    // --- input: apps grab a logical device ("INPUT_LTS" touch, "INPUT_LKEYBOARD", ...) with a callback
    esINPUT_LdevGrab(cpu) {
      const name = this.str(A0), h = this.malloc(32);
      this.grabs.set(h, { name, cb: cpu.getU(A1), arg: cpu.getU(A2), aux: cpu.getU(A3) });
      if (name === 'LTSDev') this.startTouchThread();
      this.log(`  LdevGrab("${name}", cb=0x${cpu.getU(A1).toString(16)}, arg=0x${cpu.getU(A2).toString(16)}) -> 0x${h.toString(16)}`);
      return h;
    },
    esINPUT_LdevRelease(cpu) { this.grabs.delete(cpu.getU(A0)); return 0; },
    esINPUT_GetLdevID(cpu) { return this.grabs.has(cpu.getU(A0)) ? 1 : -1; },
    esINPUT_LdevCtl() { return 0; },
    esINPUT_LdevFeedback() { return 0; },

    // --- devices
    ioctl(cpu) {
      const fd = cpu.getU(A0), dev = this.fds.get(fd);
      if (!dev) { if (this.opt.trace) this.log(`  ioctl on bad fd ${cpu.get(A0)}`); return -1; }
      return dev.ioctl(cpu.getU(A1), cpu.getU(A2));
    },
    esKSRV_Save_Display_Hld(cpu) { this.displayHld = cpu.getU(A0); this.log(`  display handle = 0x${this.displayHld.toString(16)}`); },
    esKSRV_Get_Display_Hld() { return this.displayHld; },
    esKSRV_Save_Mixture_Hld(cpu) { this.mixtureHld = { mid: cpu.get(A0), mp: cpu.getU(A1) }; this.log(`  mixture handle = mid ${cpu.get(A0)} mp 0x${cpu.getU(A1).toString(16)}`); },
    esKSRV_Get_Mixture_Hld(cpu) {
      const pm = cpu.getU(A0), pp = cpu.getU(A1);
      if (pm) this.mem.w32(pm, this.mixtureHld.mid);
      if (pp) { this.mem.w32(pp, this.mixtureHld.mp); this.mem.w32(pp + 4, 0); }
    },
    esPINS_PinGrpReq(cpu) { return this.malloc(16); },
    esPINS_PinGrpRel() { return 0; },
    esPINS_ReadPinData() { return 0; },
    esPINS_WritePinData() { return 0; },
    esPINS_SetPinIO() { return 0; },
    esPINS_SetPinPull() { return 0; },

    // --- kernel message box (system-wide messages, e.g. keys, power events)
    esKSRV_SendMsg(cpu) { this.ksrvMsgs.push(cpu.getU(A0)); return 0; },
    esKSRV_SendMsgEx(cpu) { this.ksrvMsgs.push(cpu.getU(A0)); return 0; },
    esKSRV_GetMsg() { return this.ksrvMsgs.shift() ?? 0; },

    // --- misc kernel services
    esTIME_GetTime(cpu) { const p = cpu.getU(A0), d = new Date(); this.mem.w8(p, d.getHours()); this.mem.w8(p + 1, d.getMinutes()); this.mem.w8(p + 2, d.getSeconds()); return 0; },
    esTIME_GetDate(cpu) { const p = cpu.getU(A0), d = new Date(); this.mem.w16(p, d.getFullYear()); this.mem.w8(p + 2, d.getMonth() + 1); this.mem.w8(p + 3, d.getDate()); return 0; },
    esTIME_SetTime() { return 0; }, esTIME_SetDate() { return 0; },
    esKSRV_Random(cpu) { return Math.floor(Math.random() * Math.max(1, cpu.getU(A0))); },
    esKSRV_Reset() { throw new CpuHalt('guest requested reset'); },
    esCFG_GetKeyValue(cpu) {
      const sec = this.str(A0), key = this.str(A1), out = cpu.getU(A2), count = cpu.get(A3);
      const v = this.cfg[sec]?.[key];
      this.log(`  esCFG_GetKeyValue("${sec}", "${key}") -> ${v ?? 'not found'}`);
      if (v === undefined) return -1;
      return this.writeCfgValue(key, v, out, count);
    },
  };

  /** Store a sys_config value the way Melis does: int, string, or user_gpio_set_t for port:... */
  private writeCfgValue(key: string, v: string, out: number, count: number): number {
    const m = this.mem;
    const port = /^port:P([A-Z])(\d+)((?:<[^>]*>)*)$/.exec(v);
    if (port) {
      // user_gpio_set_t { char name[32]; int port, port_num, mul_sel, pull, drv_level, data; }
      const f = [...port[3].matchAll(/<([^>]*)>/g)].map(x => (x[1] === 'default' || x[1] === '' ? -1 : parseInt(x[1], 0)));
      const vals = [port[1].charCodeAt(0) - 64, Number(port[2]), f[0] ?? -1, f[1] ?? -1, f[2] ?? -1, f[3] ?? -1];
      m.fill(out, 32); m.writeCstr(out, key.slice(0, 31));
      vals.forEach((x, k) => m.w32(out + 32 + 4 * k, x));
      return 0;
    }
    if (/^".*"$/.test(v) || !/^-?(0x[0-9a-f]+|\d+)$/i.test(v)) {
      const sv = v.replace(/^"|"$/g, '');
      const n = Math.max(1, count) * 4;
      m.fill(out, n); m.writeCstr(out, sv.slice(0, n - 1));
      return 0;
    }
    m.w32(out, parseInt(v, 0));
    return 0;
  }

  // ---------------------------------------------------------------- touch input
  // Melis touch actions carried in ABS_MISC (desktop.mod maps them to GUI messages):
  // 0xf0 press start -> TOUCH_DOWN, 0xf1 move -> TOUCH_MOVE, 0..6 gesture/release -> TOUCH_UP
  static readonly TP = { DOWN: 0xf0, MOVE: 0xf1, UP: 0x00 } as const;
  private touchQueue: { action: number; x: number; y: number }[] = [];
  private touchPacket = 0;
  /** Screen -> raw panel coordinates: undo what the app applies from e:\Config.ini [TOUCH]. */
  touchTransform(x: number, y: number): [number, number] {
    const host = this.resolvePath('e:\\Config.ini');
    const ini = host && existsSync(host) ? parseFex(readFileSync(host, 'latin1')).TOUCH ?? {} : {};
    if (ini.bTouchXReverse === '1') x = SCREEN_W - 1 - x;
    if (ini.bTouchYReverse === '1') y = SCREEN_H - 1 - y;
    if (ini.bTouchXYSwap === '1') [x, y] = [y, x];
    return [x, y];
  }

  /** Queue a touch event in screen coordinates; the LTSDev thread delivers it to the grabbers. */
  touch(action: number, x: number, y: number): void {
    const [tx, ty] = this.touchTransform(x, y);
    this.touchQueue.push({ action, x: Math.round(tx), y: Math.round(ty) });
    const t = this.threads.find(th => th.name === 'LTSDevGraber' && th.state === 'sleep');
    if (t) this.wake(t, false);
  }

  /** Kernel thread equivalent to LTSDevGraberThread: build __input_event_packet_t, call each grabber. */
  private startTouchThread(): void {
    if (this.threads.some(t => t.name === 'LTSDevGraber')) return;
    // packet: +0 ldev_id, +4 pdev_id, +0x10 event_cnt, +0x14 events[{u32 type, u32 code, s32 value}]
    this.touchPacket = this.malloc(0x14 + 64 * 12 + 16);
    const t = this.createThread(0, 0, 0x4000, 1, 'LTSDevGraber');
    const loop = (cpu: Cpu): void => {
      const ev = this.touchQueue.shift();
      if (!ev) { cpu.pc = this.cont(loop); this.block('sleep', this.ticks + 1000); return; }
      const p = this.touchPacket, m = this.mem;
      const events: [number, number, number][] = [[3, 0, ev.x], [3, 1, ev.y], [3, 0x28, ev.action], [0, 0, 0]];
      m.w32(p, 2); m.w32(p + 4, 0); m.w32(p + 0x10, events.length);
      events.forEach(([ty, code, v], k) => { m.w32(p + 0x14 + 12 * k, ty); m.w32(p + 0x18 + 12 * k, code); m.w32(p + 0x1c + 12 * k, v); });
      const grabbers = [...this.grabs.values()].filter(g => g.name === 'LTSDev');
      const callNext = (c: Cpu, k: number): void => {
        if (k >= grabbers.length) { c.pc = this.cont(loop); return; }
        c.setU32(A0, p);
        c.setU32(RA, this.cont(c2 => callNext(c2, k + 1)));
        c.pc = grabbers[k].cb;
      };
      callNext(cpu, 0);
    };
    t.pc = this.cont(loop);
  }

  openDev(path: string): number {
    const name = path.toLowerCase();
    // Drivers this board doesn't have (or we don't emulate) must fail like a missing /dev node,
    // otherwise the app takes the wrong code path (e.g. resistive touch -> forced calibration).
    if (ABSENT_DEVICES.has(name)) { this.log(`  open("${path}") -> ENOENT (absent)`); return -1; }
    const dev: Device = name === '/dev/disp' ? this.disp : new StubDevice(path, s => this.log(s));
    const fd = this.nextFd++;
    this.fds.set(fd, dev);
    this.log(`  open("${path}") -> fd ${fd}${dev instanceof StubDevice ? ' (stub)' : ''}`);
    return fd;
  }

  private qpost(p: number, msg: number, front: boolean): number {
    const q = this.queues.get(p); if (!q) return 1;
    const w = this.threads.find(t => t.state === 'blocked' && t.waitObj === p);
    if (front) q.items.unshift(msg); else q.items.push(msg);
    if (w) this.wake(w, false);
    return 0;
  }

  private fopen(path: string, mode: string): number {
    const write = /[wa+]/.test(mode), create = /[wa]|c/.test(mode);
    if (write && !this.writable(path)) { this.log(`  fopen("${path}", "${mode}") -> denied (read-only drive)`); return 0; }
    const host = this.resolvePath(path, create);
    const exists = !!host && existsSync(host) && statSync(host).isFile();
    if (!host || (!exists && !create)) { this.log(`  fopen("${path}", "${mode}") -> not found`); return 0; }
    this.log(`  fopen("${path}", "${mode}") -> ok${exists ? '' : ' (new)'}`);
    const data = exists && !mode.startsWith('w') ? readFileSync(host) : Buffer.alloc(0);
    const h = this.malloc(16);
    this.files.set(h, { path, host, data, pos: mode.startsWith('a') ? data.length : 0, dirty: !exists || mode.startsWith('w'), rw: write });
    return h;
  }
  private fclose(h: number): void {
    const f = this.files.get(h); if (!f) return;
    if (f.dirty) writeFileSync(f.host, f.data);
    this.files.delete(h); this.free(h);
  }
  private fread(h: number, buf: number, n: number): number {
    const f = this.files.get(h); if (!f) return 0;
    const want = Math.max(0, Math.min(n, f.data.length - f.pos));
    this.mem.write(buf, f.data.subarray(f.pos, f.pos + want)); f.pos += want;
    return want;
  }
  private fwrite(h: number, buf: number, n: number): number {
    const f = this.files.get(h); if (!f || !f.rw) return 0;
    if (f.pos + n > f.data.length) { const nb = Buffer.alloc(f.pos + n); f.data.copy(nb); f.data = nb; }
    f.data.set(this.mem.read(buf, n), f.pos); f.pos += n; f.dirty = true;
    return n;
  }
  private seek(h: number, off: number, whence: number): number {
    const f = this.files.get(h); if (!f) return -1;
    const base = whence === 0 ? 0 : whence === 1 ? f.pos : f.data.length;
    f.pos = Math.max(0, base + off); return 0;
  }
}

/** Return a host value in a0: negatives sign-extend (error codes), values >= 2^31 are unsigned
 *  quantities such as pointers and zero-extend, like the real kernel's 64-bit returns. */
function setRet(cpu: Cpu, r: number): void {
  if (r < 0) cpu.set(A0, r); else cpu.setU32(A0, r);
}

/** Parse an Allwinner sys_config.fex (INI-like) into section -> key -> raw value. */
export function parseFex(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let cur: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { cur = out[sec[1]] ??= {}; continue; }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv && cur) cur[kv[1]] = kv[2];
  }
  return out;
}
