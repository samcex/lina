#!/usr/bin/env bash
# Installs the `lina` command for the current user (no sudo, no global npm changes).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
echo "→ Installing dependencies"
npm install --no-audit --no-fund
echo "→ Building daemon/CLI and web UI"
npm run build
mkdir -p "$HOME/.local/bin"
TARGET="$HOME/.local/bin/lina"
if [ -e "$TARGET" ] && [ "$(readlink -f "$TARGET")" != "$ROOT/bin/lina" ]; then
  echo "✖ $TARGET already exists and is not LINA's launcher — refusing to overwrite." >&2
  exit 1
fi
ln -sfn "$ROOT/bin/lina" "$TARGET"
echo "✔ Installed: $TARGET → $ROOT/bin/lina"
PHONE_TARGET="$HOME/.local/bin/lina-phone"
if [ ! -e "$PHONE_TARGET" ] || cmp -s "$PHONE_TARGET" "$ROOT/scripts/lina-phone"; then
  install -m 755 "$ROOT/scripts/lina-phone" "$PHONE_TARGET"
  echo "✔ Installed phone reconnect helper: $PHONE_TARGET"
else
  echo "  Existing $PHONE_TARGET preserved; install scripts/lina-phone manually if desired."
fi
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  Add ~/.local/bin to your PATH to use 'lina'.";; esac
# Restart a running daemon so it picks up the new build
if [ -f "${LINA_HOME:-$HOME/.lina}/daemon.json" ]; then "$ROOT/bin/lina" daemon stop >/dev/null 2>&1 || true; fi
echo "Run: lina doctor --live   (then: lina)"
