#!/bin/sh
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 1
if [ ! -x "./portable/python/bin/python3" ]; then
  printf '%s\n' '请下载并解压对应 Mac 芯片的便携包。源码包不包含运行环境。'
  exit 1
fi
exec ./portable/python/bin/python3 ./desktop.py "$@"
