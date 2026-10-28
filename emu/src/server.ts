// Interactive viewer: runs the emulator in real time and serves the screen to a browser canvas.
// Mouse down/drag/up on the canvas become LTSDev touch events.
//   npm run serve -- --dump <extracted-dir> [--fresh] [--port 8133]   then open http://localhost:8133
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Kernel } from './kernel.ts';
import { encodePng, SCREEN_W, SCREEN_H } from './devices.ts';
import { parseArgs, createEmulator } from './boot.ts';

const a = parseArgs(process.argv.slice(2));
const port = Number(a.opt('--port', '8133'));
const k = createEmulator(a, { realtime: true });
const logFile = join(resolve(a.opt('--state', fileURLToPath(new URL('../state', import.meta.url)))), 'emu.log');
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, '');
k.log = s => appendFileSync(logFile, s + '\n');

let halted = '';
let mips = 0;
// Run guest code in ~40 ms bursts so HTTP requests stay responsive.
function pump(): void {
  if (halted) return;
  const start = Date.now(), s0 = k.cpu.steps;
  let r: 'idle' | 'budget' = 'budget';
  try {
    while (Date.now() - start < 40) { r = k.run(1_000_000); if (r === 'idle') break; }
  } catch (e) {
    halted = (e as Error).message;
    console.error('HALT:', halted, `pc=0x${k.cpu.lastPc.toString(16)}`);
    return;
  }
  const dt = Date.now() - start;
  if (dt > 0) mips = mips * 0.9 + ((k.cpu.steps - s0) / dt / 1000) * 0.1;
  if (r === 'idle') setTimeout(pump, 5); else setImmediate(pump);
}

let png: Buffer = Buffer.alloc(0), pngHash = '';
function frame(): Buffer {
  const img = k.disp.render();
  const h = createHash('sha1').update(img).digest('hex');
  if (h !== pngHash) { pngHash = h; png = encodePng(img, SCREEN_W, SCREEN_H); }
  return png;
}

const page = `<!doctype html><meta charset="utf-8"><title>EKIY emulator</title>
<style>body{background:#111;color:#ccc;font:13px system-ui;margin:20px}canvas{border:1px solid #444;cursor:crosshair;image-rendering:pixelated}</style>
<canvas id=c width=${SCREEN_W} height=${SCREEN_H}></canvas><div id=s></div>
<script>
const c = document.getElementById('c'), g = c.getContext('2d'), s = document.getElementById('s');
let etag = '';
async function poll() {
  try {
    const r = await fetch('/frame.png', { headers: etag ? { 'if-none-match': etag } : {} });
    if (r.status === 200) { etag = r.headers.get('etag'); g.drawImage(await createImageBitmap(await r.blob()), 0, 0); }
    s.textContent = await (await fetch('/status')).text();
  } catch {}
  setTimeout(poll, 50);
}
poll();
const pos = e => { const b = c.getBoundingClientRect(); return [Math.round((e.clientX - b.left) * c.width / b.width), Math.round((e.clientY - b.top) * c.height / b.height)]; };
const send = (a, [x, y]) => fetch('/touch', { method: 'POST', body: JSON.stringify({ a, x, y }) });
let down = false, last = 0;
c.onmousedown = e => { down = true; send('down', pos(e)); };
c.onmousemove = e => { if (down && Date.now() - last > 30) { last = Date.now(); send('move', pos(e)); } };
window.onmouseup = e => { if (down) { down = false; send('up', pos(e)); } };
</script>`;

createServer((req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(page); return; }
  if (req.url === '/frame.png') {
    const body = frame();
    if (req.headers['if-none-match'] === pngHash) { res.statusCode = 304; res.end(); return; }
    res.setHeader('content-type', 'image/png'); res.setHeader('etag', pngHash); res.end(body); return;
  }
  if (req.url === '/status') {
    res.end(halted ? `HALTED: ${halted}` : `tick ${k.ticks} (${(k.ticks / 100).toFixed(1)} s guest) · ${(k.cpu.steps / 1e6).toFixed(0)}M instructions · ${mips.toFixed(1)} MIPS · log: ${logFile}`);
    return;
  }
  if (req.url === '/touch' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const { a: act, x, y } = JSON.parse(body);
      const action = act === 'down' ? Kernel.TP.DOWN : act === 'move' ? Kernel.TP.MOVE : Kernel.TP.UP;
      k.log(`>>> touch ${act} ${x},${y}`);
      k.touch(action, x, y);
      res.end('ok');
    });
    return;
  }
  res.statusCode = 404; res.end();
}).listen(port, '127.0.0.1', () => console.log(`EKIY emulator: http://localhost:${port}  (log: ${logFile})`));

pump();
