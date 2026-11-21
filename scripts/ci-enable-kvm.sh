#!/usr/bin/env bash
# Make /dev/kvm usable and install pasta on GitHub's Ubuntu runners, so the VM jobs can boot a real
# microVM. Needs sudo; the runner user already has it.
set -euo pipefail

sudo tee /etc/udev/rules.d/99-kvm4all.rules >/dev/null <<'EOF'
KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm

# Ubuntu 24.04's AppArmor restriction on unprivileged user namespaces stops pasta from creating its
# namespace; the key only exists on kernels that have the restriction.
if sysctl -n kernel.apparmor_restrict_unprivileged_userns >/dev/null 2>&1; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi

sudo apt-get update -qq
sudo apt-get install -y passt

ls -l /dev/kvm
pasta --version
