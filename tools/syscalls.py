import re,collections,json,sys
# usage: syscalls.py <llvm-listing> <output.json>
L=open(sys.argv[1]).read().splitlines()
rx=re.compile(r'^([0-9a-f]+):\s+(\S+)\s*(.*)$')
ins=[]
for l in L:
    m=rx.match(l)
    if m: ins.append((int(m[1],16),m[2],m[3]))
idx={a:i for i,(a,_,_) in enumerate(ins)}
stubs=[]
for i,(a,op,args) in enumerate(ins):
    if op!='ecall': continue
    a7=None;start=None
    for j in range(i-1,max(i-12,0),-1):
        aa,o,ar=ins[j]
        if o=='addi' and ar.startswith('sp, sp, -'): start=aa;break
    for j in range(i-1,max(i-12,0),-1):
        aa,o,ar=ins[j]; p=[x.strip() for x in ar.split(',')]
        if o=='lui' and p[0]=='a7': a7=(a7 or 0)+(int(p[1],0)<<12); break
        if o=='addi' and p[0]=='a7' and p[1]=='a7': a7=(a7 or 0)+int(p[2],0)
        if o=='li' and p[0]=='a7': a7=int(p[1],0); break
    stubs.append(dict(ecall=a,start=start,a7=a7))
calls=collections.Counter()
for a,op,args in ins:
    if op in('jal','j','call','tail'):
        m=re.search(r'0x([0-9a-f]+)',args)
        if m: calls[int(m[1],16)]+=1
for s in stubs: s['callers']=calls.get(s['start'],0)
json.dump(stubs,open(sys.argv[2],'w'),indent=1)
for s in sorted(stubs,key=lambda s:s['a7'] or 0):
    print(f"a7={s['a7']} stub={s['start']} callers={s['callers']}")
