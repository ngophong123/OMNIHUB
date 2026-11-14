#!/bin/sh
set -eu
for arg in "$@"; do
  case "$arg" in --file=*) target="${arg#--file=}";; esac
done
head -c 80 /dev/zero > "$target"
