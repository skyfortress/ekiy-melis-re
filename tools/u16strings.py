import re,sys
for fn in sys.argv[1:]:
    d=open(fn,'rb').read()
    for m in re.finditer(rb'(?:[\x20-\x7e]\x00){3,}',d):
        print(f"{fn}:{m.start():#08x} {m.group().decode('utf-16le')}")
