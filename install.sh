#!/usr/bin/env bash
# install.sh - Agent Hive installer
# Run: curl -sL https://raw.githubusercontent.com/stansz/agent-hive/main/install.sh | bash

set -euo pipefail

APP_DIR="${HOME}/agent-hive"
REPO="https://github.com/stansz/agent-hive.git"

echo ""
echo "  Agent Hive Installer"
echo "  Self-hosted coding agent server"
echo ""

# Check Node
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js >= 20 is required. Install it first:"
  echo "  https://nodejs.org/"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo "ERROR: Node.js >= 20 required, found $(node -v)"
  exit 1
fi
echo "  Node: $(node -v) ✓"

# Check git
if ! command -v git &>/dev/null; then
  echo "ERROR: git is required but not found."
  exit 1
fi
echo "  Git: $(git --version | head -1) ✓"

# Check podman (tasks run in podman sandboxes)
if ! command -v podman &>/dev/null; then
  echo "ERROR: podman is required (tasks run in sandboxes). Install it, e.g.: sudo apt install podman"
  exit 1
fi
echo "  Podman: $(podman --version) ✓"
if [ -r /dev/kvm ] && [ -w /dev/kvm ] && command -v krun &>/dev/null; then
  echo "  Isolation: krun microVMs ✓"
else
  echo "  Isolation: rootless containers (no usable /dev/kvm + krun). See README > Isolation levels."
fi

# Clone or update
if [ -d "$APP_DIR" ]; then
  echo ""
  echo "  $APP_DIR already exists, updating..."
  cd "$APP_DIR"
  git pull --ff-only
else
  echo ""
  echo "  Cloning to $APP_DIR ..."
  git clone --depth 1 "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# Install deps and build (dev deps are needed for the build, then pruned)
echo ""
echo "  Building server..."
npm ci
npm run build
npm prune --omit=dev

echo ""
echo "  Building web UI..."
npm run build:ui

echo ""
echo "  Building sandbox image (first time takes a few minutes)..."
npm run build:image

# .env setup
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "  Created .env from .env.example"
  echo "  >>> EDIT .env and set: API_TOKEN and at least one LLM provider key <<<"
else
  echo ""
  echo "  .env already exists, keeping your settings"
fi

echo ""
echo "  === Done ==="
echo ""
echo "  Next steps:"
echo "    1. Edit $APP_DIR/.env"
echo "    2. Start: node $APP_DIR/dist/index.js"
echo "    3. Test: curl http://localhost:8080/health"
echo ""
echo "  For systemd setup and deploy keys, see README.md and AGENTS.md."
echo ""
