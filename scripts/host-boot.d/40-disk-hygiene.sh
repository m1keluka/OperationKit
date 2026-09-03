#!/usr/bin/env bash
# host-boot.d tick (every ~5 min): if the VPS is at 90%+ or under 2 GiB free,
# run disk-cleanup.sh. Cheap no-op otherwise. flock so a long prune can't stack.
set -uo pipefail
LOCK=/tmp/cc-disk-hygiene.lock
SCRIPT=/home/operator/projects/command-center-infra/scripts/disk-cleanup.sh

exec 9>"$LOCK"
if ! flock -n 9; then
  exit 0
fi

STAMP=/tmp/cc-disk-hygiene.last
now=$(date +%s)
if [ -f "$STAMP" ]; then
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt 1800 ]; then
    exit 0
  fi
fi

# df -Pk: 1K-blocks, field 4 = available, field 5 = Use%.
read -r _avail_k _pct < <(df -Pk / | awk 'NR==2{gsub("%","",$5); print $4, $5}')
_avail_k=${_avail_k:-999999999}
_pct=${_pct:-0}
# 2 GiB in 1K blocks = 2 * 1024 * 1024
if [ "$_pct" -lt 90 ] && [ "$_avail_k" -ge 2097152 ]; then
  exit 0
fi

echo "$now" > "$STAMP"
DISK_CLEANUP_REASON=host-boot exec /bin/bash "$SCRIPT"
