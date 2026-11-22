#!/bin/sh
# Guest side of the case-collision check. The host shares a git checkout that
# contains two paths differing only by case (a.txt and A.txt) from a
# case-sensitive APFS volume.
#
#   --share work=<mountpoint>/work
echo CASE_START
failures=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; failures=$((failures + 1)); }

mount -t virtiofs work /mnt/work
export GIT_CONFIG_GLOBAL=/dev/shm/gitconfig
git config --global --add safe.directory '*'

cd /mnt/work
echo "--- git status on the shared checkout"
status=$(git status --porcelain)
if [ -z "$status" ]; then pass "git status is clean"; else fail "git status is dirty: $status"; fi
echo "--- paths"
git ls-files
if [ -f a.txt ] && [ -f A.txt ]; then pass "a.txt and A.txt both exist"; else fail "a case-colliding pair is missing"; fi
echo "--- contents"
cat a.txt A.txt

echo "--- clone into the guest's tmpfs"
rm -rf /dev/shm/clone
if git clone -q /mnt/work /dev/shm/clone; then
    pass "git clone succeeded"
else
    fail "git clone failed"
fi
cd /dev/shm/clone 2>/dev/null || exit 1
status=$(git status --porcelain)
if [ -z "$status" ]; then pass "cloned checkout is clean"; else fail "cloned checkout is dirty: $status"; fi
if [ -f a.txt ] && [ -f A.txt ]; then pass "cloned a.txt and A.txt both exist"; else fail "case-colliding pair lost in the clone"; fi

echo "CASE_FAILURES=$failures"
if [ "$failures" -ne 0 ]; then
    echo CASE_RESULT=FAIL
    exit 1
fi
echo CASE_RESULT=PASS
