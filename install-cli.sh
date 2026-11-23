#!/bin/sh
# install-cli.sh - install the latest Agent Hive CLI release.
#
# Downloads over HTTPS and checks the download against the release's SHA256SUMS, so a corrupted
# or truncated download is rejected. `hive update` additionally verifies the release's ed25519
# signature before switching versions.
set -eu

REPO=${HIVE_RELEASE_REPO:-Old-GenS/agent-hive}
API=${HIVE_RELEASE_API:-https://api.github.com}

os=$(uname -s)
arch=$(uname -m)
case "$os:$arch" in
  Linux:x86_64) platform=linux-x86_64 ;;
  Darwin:arm64) platform=darwin-arm64 ;;
  *)
    echo "hive: only Linux x86_64 and macOS arm64 (Apple silicon) releases exist for now" >&2
    exit 1
    ;;
esac

missing=
for bin in curl tar; do
  command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
done
if [ "$os" = Darwin ]; then
  command -v shasum >/dev/null 2>&1 || missing="$missing shasum"
  sum_cmd="shasum -a 256"
else
  command -v sha256sum >/dev/null 2>&1 || missing="$missing sha256sum"
  sum_cmd=sha256sum
fi
if [ -n "$missing" ]; then
  echo "hive: missing required command(s):$missing" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$API/repos/$REPO/releases/latest" -o "$tmp/release.json"

ver=$(sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' "$tmp/release.json" | head -n 1)
if [ -z "$ver" ]; then
  echo "hive: no latest release found for $REPO" >&2
  exit 1
fi

# Download URLs must be HTTPS, unless the release API itself was pointed at plain HTTP (tests).
case $API in
  http://*) url_re='https\{0,1\}://' ;;
  *) url_re='https://' ;;
esac
urls=$(grep -o '"browser_download_url": *"[^"]*"' "$tmp/release.json" | sed 's/.*"\([^"]*\)"/\1/' | grep "^$url_re" || true)
app=hive-$ver-$platform.tar.gz
sums_url=$(printf '%s\n' "$urls" | grep '/SHA256SUMS$' | head -n 1)
app_url=$(printf '%s\n' "$urls" | grep "/$app$" | head -n 1)
if [ -z "$sums_url" ] || [ -z "$app_url" ]; then
  echo "hive: release v$ver has no $platform build" >&2
  exit 1
fi

curl -fsSL "$sums_url" -o "$tmp/SHA256SUMS"
curl -fsSL "$app_url" -o "$tmp/$app"
(cd "$tmp" && grep " $app\$" SHA256SUMS | $sum_cmd -c -)

data=${XDG_DATA_HOME:-$HOME/.local/share}/agent-hive
tar -xzf "$tmp/$app" -C "$tmp"
mkdir -p "$data/versions"
if [ ! -d "$data/versions/$ver" ]; then
  mv "$tmp/hive-$ver" "$data/versions/$ver"
fi

ln -sfn "$data/versions/$ver" "$data/current"
mkdir -p "$HOME/.local/bin"
ln -sfn "$data/current/bin/hive" "$HOME/.local/bin/hive"

# Put ~/.local/bin on PATH in the shell's startup file, unless it already is. zsh is macOS's
# default; bash is the Linux one.
if [ "$os" = Darwin ]; then
  first_rc=$HOME/.zprofile
  second_rc=$HOME/.zshrc
else
  first_rc=$HOME/.profile
  second_rc=$HOME/.bashrc
fi
path_line='export PATH="$HOME/.local/bin:$PATH"  # added by agent-hive'
case ":${PATH:-}:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    if [ "${HIVE_NO_MODIFY_PATH:-}" = "1" ]; then
      echo "hive: add ~/.local/bin to your PATH:"
      echo "  $path_line"
    else
      for rc in "$first_rc" "$second_rc"; do
        if [ "$rc" = "$second_rc" ] && [ ! -f "$rc" ]; then
          continue
        fi
        if [ ! -f "$rc" ] || ! grep -q "added by agent-hive" "$rc"; then
          printf '\n%s\n' "$path_line" >> "$rc"
        fi
      done
      echo "hive: added ~/.local/bin to your PATH; open a new terminal or run: . $first_rc"
    fi
    ;;
esac

if [ "${HIVE_INSTALL_SKIP_SETUP:-}" = "1" ]; then
  :
else
  if [ "$os" = Darwin ]; then size="about 610 MB"; else size="about 660 MB"; fi
  echo "hive: downloading the VM filesystem ($size, one time)…"
  "$data/current/bin/hive" setup || true
fi

# Things that will stop a run, with what to do. Never runs sudo and never fails the install.

if [ "$os" = Darwin ]; then
  if [ "$(sysctl -n kern.hv_support 2>/dev/null || echo 0)" != "1" ]; then
    echo "hive: Hypervisor.framework is not available, so hive can't boot its VMs"
    echo "hive: it needs an Apple silicon Mac with macOS 14 or newer"
  fi
else
  if [ -e /dev/kvm ]; then
    if ! { [ -r /dev/kvm ] && [ -w /dev/kvm ]; }; then
      echo "hive: add yourself to the kvm group: sudo usermod -aG kvm \$USER"
      echo "hive: then log out and back in (WSL: run wsl --shutdown in Windows)"
    fi
  else
    echo "hive: /dev/kvm is missing, so hive can't boot its VMs; it needs KVM (hardware virtualization)"
    if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then
      echo "hive: WSL needs nested virtualization: set nestedVirtualization=true under [wsl2] in %UserProfile%\\\\.wslconfig,"
      echo "hive: then run wsl --shutdown in Windows"
    else
      echo "hive: turn on virtualization in the BIOS/UEFI (on a VPS, use a KVM host)"
    fi
  fi

  if ! command -v pasta >/dev/null 2>&1; then
    osid=$(sed -n 's/^ID=//p' /etc/os-release 2>/dev/null | tr -d '"' | head -n 1 || true)
    oslike=$(sed -n 's/^ID_LIKE=//p' /etc/os-release 2>/dev/null | tr -d '"' | head -n 1 || true)
    case " $osid $oslike " in
      *debian*|*ubuntu*) pasta_cmd="sudo apt install -y passt" ;;
      *fedora*|*rhel*|*centos*) pasta_cmd="sudo dnf install -y passt" ;;
      *arch*) pasta_cmd="sudo pacman -S passt" ;;
      *) pasta_cmd="" ;;
    esac
    if [ -n "$pasta_cmd" ]; then
      echo "hive: pasta is missing; install it with: $pasta_cmd"
      echo "hive: (release installs also bundle a static copy, used when the system one can't)"
    else
      echo "hive: pasta is missing; install your distro's passt package (a bundled copy is used if it can't)"
    fi
  fi
fi

echo "hive $ver installed"
echo "next: hive doctor"
