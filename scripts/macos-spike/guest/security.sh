#!/bin/sh
# Guest side of the Phase 0 security gate. Run the VM with --vsock (so TSI is
# disabled) and the host-bridge on the other end.
#
#   LAN_IP=192.168.1.1 PUBLIC_IP=1.1.1.1 HOST=example.com PROXY_FORWARD=1
#
# Direct connections to the LAN, a public IP, a hostname and ping must all fail.
# With PROXY_FORWARD=1 the script also starts
#   socat TCP-LISTEN:3128 -> VSOCK-CONNECT:2:1024
# and checks that hive's egress proxy works for HTTP/HTTPS and denies the LAN
# and the metadata address.
LAN_IP=${LAN_IP:-192.168.1.1}
PUBLIC_IP=${PUBLIC_IP:-1.1.1.1}
HOST=${HOST:-example.com}
PROXY_FORWARD=${PROXY_FORWARD:-1}
failures=0
proxy_pid=

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; failures=$((failures + 1)); }

check_direct() {
    name=$1
    shift
    if "$@" >/dev/null 2>&1; then
        fail "$name unexpectedly succeeded"
    else
        pass "$name blocked"
    fi
}

echo SECURITY_START
echo "--- TSI"
tsi=$(grep -c tsi_hijack /proc/cmdline || true)
if [ "$tsi" = 0 ]; then pass "cmdline has no tsi_hijack"; else fail "tsi_hijack still in cmdline"; fi
if ip link 2>/dev/null | grep -q 'eth0'; then fail "eth0 exists"; else pass "no eth0"; fi
ip link
ip route 2>/dev/null || true

echo "--- direct network must fail"
check_direct "LAN $LAN_IP" curl --noproxy '*' -sS --connect-timeout 3 "http://$LAN_IP/"
check_direct "public IP $PUBLIC_IP" curl --noproxy '*' -sS --connect-timeout 3 "http://$PUBLIC_IP/"
check_direct "hostname $HOST" curl --noproxy '*' -sS --connect-timeout 3 "https://$HOST/"
check_direct "ping $PUBLIC_IP" ping -c 1 -W 2 "$PUBLIC_IP"

echo "--- proxy through vsock"
if [ "$PROXY_FORWARD" = 1 ]; then
    socat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr VSOCK-CONNECT:2:1024 >/dev/shm/socat.log 2>&1 &
    proxy_pid=$!
    trap 'if [ -n "$proxy_pid" ]; then kill "$proxy_pid" 2>/dev/null; fi' EXIT INT TERM
    sleep 1

    check_proxy_http() {
        name=$1
        expected=$2
        url=$3
        code=$(curl -x http://127.0.0.1:3128 -sS --connect-timeout 10 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)
        if [ "$code" = "$expected" ]; then
            pass "$name HTTP $code"
        else
            fail "$name expected $expected, got $code"
        fi
    }

    check_proxy_http "proxy HTTP example.com" 200 "http://$HOST/"
    check_proxy_http "proxy HTTPS example.com" 200 "https://$HOST/"
    check_proxy_http "proxy denies LAN" 403 "http://$LAN_IP/"
    check_proxy_http "proxy denies metadata" 403 "http://169.254.169.254/"
else
    echo "skipped (PROXY_FORWARD=0)"
fi

echo "SECURITY_FAILURES=$failures"
if [ "$failures" -ne 0 ]; then
    echo SECURITY_RESULT=FAIL
    exit 1
fi
echo SECURITY_RESULT=PASS
