import re,sys,collections,pickle
# usage: xrefs.py <llvm-listing> <output.pkl>
lines=open(sys.argv[1]).read().splitlines()
rx=re.compile(r'^\s*([0-9a-f]+):\s+(\S+)\s*(.*)$')
regs={}; refs=collections.defaultdict(list); func=None; funcs={}
for L in lines:
    if L.endswith('>:'):
        regs={}; continue
    m=rx.match(L)
    if not m: continue
    pc=int(m[1],16); op=m[2]; a=[x.strip() for x in m[3].split(',')]
    def imm(s):
        return int(s,0)
    try:
        if op in('lui','c.lui'):
            regs[a[0]]=(imm(a[1])<<12)&0xffffffff
        elif op=='auipc':
            regs[a[0]]=(pc+(imm(a[1])<<12))&0xffffffff
        elif op in('addi','c.addi') and len(a)==3 and a[1] in regs:
            v=(regs[a[1]]+imm(a[2]))&0xffffffff; refs[v].append(pc); regs[a[0]]=v
        elif op in('lw','sw','flw','fld','lbu','lb','lh','lhu','sb','sh') :
            mm=re.match(r'(-?\w+)\((\w+)\)',a[1])
            if mm and mm[2] in regs:
                refs[(regs[mm[2]]+int(mm[1],0))&0xffffffff].append(pc)
            if op.startswith('l') and a[0] in regs: del regs[a[0]]
        else:
            if a and a[0] in regs and op not in('sw','sb','sh','beq','bne','blt','bge','bltu','bgeu','j','jal'): del regs[a[0]]
    except Exception: pass
pickle.dump(dict(refs),open(sys.argv[2],'wb'))
print(len(refs))
