#!/bin/sh
# Guest side of the Phase 0 number-gathering: virtio-fs throughput on work/
# (sequential write/read and many small files) plus a small npm install.
# The host must pass --share work=<a writable directory>.
set -e
echo PERF_START
mount -t virtiofs work /mnt/work
cd /mnt/work
export HOME=/dev/shm
export npm_config_cache=/dev/shm/npm-cache
mkdir -p "$npm_config_cache"
rm -rf ddtest many npmtest
mkdir ddtest

echo "--- write 256 MiB"
t0=$(cut -d' ' -f1 /proc/uptime)
dd if=/dev/zero of=ddtest/write.bin bs=1M count=256 conv=fsync 2>&1
t1=$(cut -d' ' -f1 /proc/uptime)
seconds=$(awk "BEGIN{printf \"%.3f\", $t1-$t0}")
mibps=$(awk "BEGIN{printf \"%.1f\", 256/($t1-$t0)}")
echo "WRITE_SECONDS=$seconds WRITE_MIBPS=$mibps"

echo "--- read 256 MiB"
t0=$(cut -d' ' -f1 /proc/uptime)
dd if=ddtest/write.bin of=/dev/null bs=1M 2>&1
t1=$(cut -d' ' -f1 /proc/uptime)
seconds=$(awk "BEGIN{printf \"%.3f\", $t1-$t0}")
mibps=$(awk "BEGIN{printf \"%.1f\", 256/($t1-$t0)}")
echo "READ_SECONDS=$seconds READ_MIBPS=$mibps"

echo "--- 2000 small files"
t0=$(cut -d' ' -f1 /proc/uptime)
mkdir many
i=0
while [ "$i" -lt 2000 ]; do
    echo "file $i" > "many/f$i"
    i=$((i + 1))
done
t1=$(cut -d' ' -f1 /proc/uptime)
files_per_second=$(awk "BEGIN{printf \"%.0f\", 2000/($t1-$t0)}")
echo "SMALL_FILES_SECONDS=$(awk "BEGIN{printf \"%.3f\", $t1-$t0}") SMALL_FILES_PER_SECOND=$files_per_second"

if [ -f /mnt/work/hive-spike-tiny-1.0.0.tgz ]; then
    echo "--- npm install local tarball"
    mkdir npmtest
    cd npmtest
    npm init -y >/dev/null 2>&1
    t0=$(cut -d' ' -f1 /proc/uptime)
    npm install ../hive-spike-tiny-1.0.0.tgz --no-audit --no-fund --ignore-scripts 2>&1 | tail -5
    t1=$(cut -d' ' -f1 /proc/uptime)
    echo "NPM_SECONDS=$(awk "BEGIN{printf \"%.3f\", $t1-$t0}")"
    node -e 'console.log("npm_module=" + require("hive-spike-tiny")())'
    cd ..
else
    echo "skipped npm (hive-spike-tiny-1.0.0.tgz not in work/)"
fi

echo PERF_DONE
