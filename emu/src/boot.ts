// Shared setup: build a Kernel from CLI-style options and queue the EKIY boot sequence.
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, statSync } from 'node:fs';
import { Kernel } from './kernel.ts';
import type { Cpu } from './cpu.ts';

export interface Args { flag(n: string): boolean; opt(n: string, d: string): string; all(n: string): string[] }

export function parseArgs(argv: string[]): Args {
  return {
    flag: n => argv.includes(n),
    opt: (n, d) => {
      const i = argv.indexOf(n);
      if (i < 0) return d;
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${n} requires a value`);
      return argv[i + 1];
    },
    all: n => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : [])),
  };
}

export function createEmulator(a: Args, extra: { realtime?: boolean } = {}): Kernel {
  const dump = a.opt('--dump', process.env.EKIY_DUMP ?? '');
  if (!dump.trim()) throw new Error('Firmware dump required: use --dump <dir> or EKIY_DUMP. Select the dump_tool output folder containing gpt.bin.out/.');
  const parts = resolve(dump, 'gpt.bin.out');
  try {
    if (!statSync(parts).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Invalid dump folder: expected ${parts}/ from dump_tool extract`);
  }
  const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  const rootfs = resolve(a.opt('--rootfs', join(parts, '2_ROOTFS.bin.out')));
  const stateDir = resolve(a.opt('--state', here('../state')));
  if (a.flag('--fresh')) rmSync(stateDir, { recursive: true, force: true }); // start from the dump's UDISK again
  const cfgOverride: Record<string, string> = {};
  for (const kv of a.all('--cfg')) { const [k, v] = kv.split('='); cfgOverride[k] = v; }
  const k = new Kernel({
    rootfs, stateDir, overlay: a.opt('--overlay', '') ? resolve(a.opt('--overlay', '')) : undefined, trace: a.flag('--trace'), stubUnknown: a.flag('--stub'), realtime: extra.realtime,
    udiskSeed: a.flag('--empty-udisk') ? undefined : resolve(a.opt('--udisk', join(parts, '3_UDISK.bin.out'))),
    sysConfig: resolve(a.opt('--sys-config', join(parts, '1_bootA.bin.out/sys_config.fex'))),
    cfgOverride,
  });
  queueBoot(k);
  return k;
}

/**
 * Boot sequence on a "kernel init" thread: the kernel installs slib.mod (shared C library,
 * called through its table at 0xe8700000), display.mod and mixture.mod, then startup.sh runs
 * `insmod d:\apps\desktop.mod`. Each step calls MInit, then MOpen where the kernel would.
 */
function queueBoot(k: Kernel): void {
  const steps: { path: string; open: boolean }[] = [
    { path: 'd:\\mod\\slib.mod', open: false },
    { path: 'd:\\mod\\display.mod', open: true },
    { path: 'd:\\mod\\mixture.mod', open: true },
    { path: 'd:\\apps\\desktop.mod', open: true },
  ];
  const t = k.createThread(0, 0, 0x8000, 0x10, 'kernel init');
  const next = (cpu: Cpu): void => {
    const st = steps.shift();
    if (!st) { k.log('boot sequence done; init thread exits'); k.cur.state = 'dead'; k.reschedule(); return; }
    const m = k.loadModuleImage(st.path);
    if (!m) throw new Error(`${st.path} not found`);
    cpu.setU32(1, k.cont(c => {
      k.log(`${st.path} MInit -> ${c.get(10)}`);
      if (!st.open) return next(c);
      c.setU32(10, m.mid); c.setU32(11, 0);
      c.setU32(1, k.cont(c2 => {
        k.log(`${st.path} MOpen -> 0x${c2.getU(10).toString(16)}`);
        // the kernel registers the mixture module handle for apps (esKSRV_Get_Mixture_Hld)
        if (st.path.endsWith('mixture.mod')) k.mixtureHld = { mid: m.mid, mp: c2.getU(10) };
        next(c2);
      }));
      c.pc = m.magic.mif.MOpen;
    }));
    cpu.pc = m.magic.mif.MInit;
  };
  t.pc = k.cont(next);
}
