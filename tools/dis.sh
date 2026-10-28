#!/bin/sh
# usage: dis.sh <elf> <start-hex> [count-bytes]
f=$1; s=$((0x${2#0x})); n=${3:-0x80}
"${LLVM_OBJDUMP:-llvm-objdump}" -d --no-show-raw-insn --triple=riscv64 \
  --mattr=+c,+m,+a,+f,+d,+zicsr,+zifencei,+xtheadba,+xtheadbb,+xtheadbs,+xtheadcondmov,+xtheadmac,+xtheadmemidx,+xtheadmempair,+xtheadsync,+xtheadfmemidx,+xtheadcmo \
  --start-address=$s --stop-address=$((s + n)) "$f" | tail -n +7
