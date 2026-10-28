// Minimal ELF32 reader for Melis .axf / .mod images (RV64 code in an ELF32 container).

export interface Section { name: string; addr: number; offset: number; size: number; type: number }
export interface Segment { vaddr: number; offset: number; filesz: number; memsz: number }

export interface Elf {
  base: number;          // vaddr of first LOAD minus its file offset (for quick va -> file lookups)
  data: Buffer;
  sections: Section[];
  segments: Segment[];
  magic?: ModMagic;
}

// __module_mgsec_t from melis emodules/mod_defs.h, as laid out by an LP64 compiler.
export interface ModMagic {
  magic: string; version: number; type: number; heapaddr: number; heapsize: number;
  mif: { MInit: number; MExit: number; MOpen: number; MClose: number; MRead: number; MWrite: number; MIoctrl: number };
}

export function loadElf(data: Buffer): Elf {
  if (data.readUInt32BE(0) !== 0x7f454c46 || data[4] !== 1) throw new Error('not an ELF32 file');
  const phoff = data.readUInt32LE(28), shoff = data.readUInt32LE(32);
  const phentsize = data.readUInt16LE(42), phnum = data.readUInt16LE(44);
  const shentsize = data.readUInt16LE(46), shnum = data.readUInt16LE(48), shstrndx = data.readUInt16LE(50);

  const segments: Segment[] = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (data.readUInt32LE(o) !== 1) continue; // PT_LOAD
    segments.push({
      offset: data.readUInt32LE(o + 4), vaddr: data.readUInt32LE(o + 8),
      filesz: data.readUInt32LE(o + 16), memsz: data.readUInt32LE(o + 20),
    });
  }
  const raw: Omit<Section, 'name'>[] & { nameOff: number }[] = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    raw.push({
      nameOff: data.readUInt32LE(o), type: data.readUInt32LE(o + 4), addr: data.readUInt32LE(o + 12),
      offset: data.readUInt32LE(o + 16), size: data.readUInt32LE(o + 20),
    } as Section & { nameOff: number });
  }
  const strtab = raw[shstrndx] as unknown as Section;
  const cstr = (o: number) => { const e = data.indexOf(0, o); return data.toString('latin1', o, e); };
  const sections = (raw as unknown as (Section & { nameOff: number })[]).map(s => ({
    name: cstr(strtab.offset + s.nameOff), addr: s.addr, offset: s.offset, size: s.size, type: s.type,
  }));

  const elf: Elf = { base: segments[0].vaddr - segments[0].offset, data, sections, segments };
  const m = sections.find(s => s.name === 'MAGIC');
  if (m && m.size >= 80) {
    const o = m.offset;
    const p = (k: number) => data.readUInt32LE(o + 24 + 8 * k);
    elf.magic = {
      magic: data.toString('latin1', o, o + 8), version: data.readUInt32LE(o + 8), type: data[o + 12],
      heapaddr: data.readUInt32LE(o + 16), heapsize: data.readUInt32LE(o + 20),
      mif: { MInit: p(0), MExit: p(1), MOpen: p(2), MClose: p(3), MRead: p(4), MWrite: p(5), MIoctrl: p(6) },
    };
  }
  return elf;
}
