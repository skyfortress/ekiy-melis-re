// CLI: boot the extracted EKIY rootfs the way the device does and run for a fixed budget.
import { Kernel } from './kernel.ts';
import { CpuHalt } from './cpu.ts';
import { MemFault } from './mem.ts';
import { encodePng, SCREEN_W, SCREEN_H } from './devices.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs, createEmulator } from './boot.ts';

const argv = process.argv.slice(2);
const a = parseArgs(argv);
const opt = a.opt;
const maxSteps = Number(opt('--steps', '50000000'));
const k = createEmulator(a);

// --frames <dir> --every <steps>: dump the composed screen periodically (only when it changed)
const framesDir = opt('--frames', '');
if (framesDir) {
  mkdirSync(framesDir, { recursive: true });
  const every = Number(opt('--every', '20000000'));
  let nextAt = every, n = 0, last = '';
  k.onSlice = () => {
    if (k.cpu.steps < nextAt) return;
    nextAt = k.cpu.steps + every;
    const img = k.disp.render();
    const h = createHash('sha1').update(img).digest('hex');
    if (h === last) return;
    last = h;
    const f = `${framesDir}/frame-${String(n++).padStart(4, '0')}-${Math.round(k.cpu.steps / 1e6)}M.png`;
    writeFileSync(f, encodePng(img, SCREEN_W, SCREEN_H));
    k.log(`frame -> ${f}`);
  };
}

// --tap x,y@M : press at (x,y) after M million instructions, release ~3M instructions later
const taps = a.all('--tap').map(t => {
  const m = /^(\d+),(\d+)@(\d+)$/.exec(t); if (!m) throw new Error(`bad --tap ${t}`);
  return { x: +m[1], y: +m[2], at: +m[3] * 1e6, phase: 0 };
});
if (taps.length) {
  const prev = k.onSlice;
  k.onSlice = () => {
    prev?.();
    for (const t of taps) {
      if (t.phase === 0 && k.cpu.steps >= t.at) { k.log(`>>> touch down ${t.x},${t.y}`); k.touch(Kernel.TP.DOWN, t.x, t.y); t.phase = 1; }
      else if (t.phase === 1 && k.cpu.steps >= t.at + 3e6) { k.log(`>>> touch up ${t.x},${t.y}`); k.touch(Kernel.TP.UP, t.x, t.y); t.phase = 2; }
    }
  };
}

// --drag x1,y1,x2,y2@M : press at (x1,y1) after M million instructions, move in 8 steps, release
const drags = a.all('--drag').map(t => {
  const m = /^(\d+),(\d+),(\d+),(\d+)@(\d+)$/.exec(t); if (!m) throw new Error(`bad --drag ${t}`);
  return { p: [+m[1], +m[2], +m[3], +m[4]], at: +m[5] * 1e6, step: 0 };
});
if (drags.length) {
  const prev = k.onSlice;
  k.onSlice = () => {
    prev?.();
    for (const d of drags) {
      if (d.step > 9 || k.cpu.steps < d.at + d.step * 2e6) continue;
      const f = Math.min(d.step, 8) / 8, x = d.p[0] + (d.p[2] - d.p[0]) * f, y = d.p[1] + (d.p[3] - d.p[1]) * f;
      const act = d.step === 0 ? Kernel.TP.DOWN : d.step === 9 ? Kernel.TP.UP : Kernel.TP.MOVE;
      k.log(`>>> drag ${d.step === 0 ? 'down' : d.step === 9 ? 'up' : 'move'} ${Math.round(x)},${Math.round(y)}`);
      k.touch(act, x, y);
      d.step++;
    }
  };
}

const t0 = Date.now();
try {
  k.run(maxSteps);
  k.log(`stopped after ${k.cpu.steps} instructions`);
} catch (e) {
  if (e instanceof CpuHalt || e instanceof MemFault) {
    k.log(`HALT: ${e.message}  (pc=0x${k.cpu.lastPc.toString(16)}, thread t${k.cur?.tid})`);
    const ra = k.cpu.getU(1);
    k.log(`  ra=0x${ra.toString(16)} sp=0x${k.cpu.getU(2).toString(16)} a0=0x${k.cpu.getU(10).toString(16)} a1=0x${k.cpu.getU(11).toString(16)} a2=0x${k.cpu.getU(12).toString(16)}`);
  } else throw e;
} finally {
  const dt = (Date.now() - t0) / 1000;
  k.log(`${k.cpu.steps} instructions in ${dt.toFixed(2)} s (${(k.cpu.steps / dt / 1e6).toFixed(1)} MIPS), ticks=${k.ticks}`);
  k.dumpThreads();
  const png = opt('--png', '');
  if (png) { writeFileSync(png, encodePng(k.disp.render(), SCREEN_W, SCREEN_H)); k.log(`frame written to ${png}`); }
  if (k.missing.size) k.log('stubbed (unimplemented) syscalls: ' + [...k.missing].map(([n, c]) => `${n}×${c}`).join(', '));
}
