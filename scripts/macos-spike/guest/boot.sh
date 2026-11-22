#!/bin/sh
# Guest probe for the Phase 0 boot check. /run.sh in the image mounts the
# "scripts" share at /mnt/scripts and execs this file.
echo BOOT_START
echo "uptime=$(cut -d' ' -f1 /proc/uptime)"
echo "root=$(grep ' / ' /proc/mounts)"
echo "tsi_count=$(grep -c tsi_hijack /proc/cmdline || true)"
echo "links:"
ip link
echo BOOT_DONE
