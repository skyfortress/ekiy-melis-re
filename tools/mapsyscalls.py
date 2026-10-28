import re,json,sys
# usage: mapsyscalls.py <SDK kapi.h> <syscalls.json> <output.json>
src=open(sys.argv[1],'rb').read().decode('latin1')
structs={}
for m in re.finditer(r'typedef\s+struct\s*\{([^}]*)\}\s*(SWIHandler_\w+_t)\s*;',src):
    body=re.sub(r'/\*.*?\*/','',m[1],flags=re.S); body=re.sub(r'//.*','',body)
    structs[m[2]]=[f.split()[-1].strip('*') for f in body.split(';') if f.strip()]
groups=[g.replace('SWIHandler_','') for g in structs['SWIHandler_SWIT_t']]
stubs=json.load(open(sys.argv[2]))
for s in sorted(stubs,key=lambda s:s['a7'] or 0):
    if s['a7'] is None: continue
    g=(s['a7']>>8)&0xff; i=s['a7']&0xff
    gn=groups[g] if g<len(groups) else f'?{g:#x}'
    tbl=structs.get(f'SWIHandler_{gn}_t',[])
    s.update(group=gn,name=tbl[i] if i<len(tbl) else '?')
    print(f"{s['a7']:#010x} {gn:7} {s['name']:30} callers={s['callers']}")
json.dump(stubs,open(sys.argv[3],'w'),indent=1)
