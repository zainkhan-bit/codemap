#!/usr/bin/env bash
# CodeMap installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/zainkhan-bit/codemap/main/scripts/install.sh | bash
#
# Installs into ~/.codemap (override with CODEMAP_HOME) and links `codemap` into ~/.local/bin
# (override with CODEMAP_BIN_DIR). Re-running updates an existing install. Nothing is installed
# globally and no administrator rights are needed. Uninstall: rm -rf ~/.codemap ~/.local/bin/codemap
set -euo pipefail

REPO="${CODEMAP_REPO:-https://github.com/zainkhan-bit/codemap.git}"
REF="${CODEMAP_REF:-main}"
HOME_DIR="${CODEMAP_HOME:-$HOME/.codemap}"
BIN_DIR="${CODEMAP_BIN_DIR:-$HOME/.local/bin}"
SRC="$HOME_DIR/src"
PNPM="pnpm@10.34.9"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required (https://git-scm.com/downloads)"
command -v node >/dev/null 2>&1 || fail "Node.js 24 or newer is required (https://nodejs.org)"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 24 ] || fail "Node.js 24 or newer is required (found $(node --version))"
command -v npx >/dev/null 2>&1 || fail "npx is required (it ships with Node.js)"

if [ -d "$SRC/.git" ]; then
  say "Updating CodeMap in $SRC"
  git -C "$SRC" fetch --quiet --depth 1 origin "$REF"
  git -C "$SRC" checkout --quiet --force FETCH_HEAD
else
  say "Downloading CodeMap into $SRC"
  mkdir -p "$HOME_DIR"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$SRC"
fi

cd "$SRC"
say "Installing dependencies"
for attempt in 1 2 3; do
  if npx --yes "$PNPM" install --frozen-lockfile --reporter=silent; then break; fi
  [ "$attempt" -lt 3 ] || fail "dependency install failed (see output above)"
  say "Install failed (attempt $attempt), retrying…"
  sleep $((attempt * 5))
done

say "Building"
npx --yes "$PNPM" build >/dev/null

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/codemap" <<EOF
#!/usr/bin/env sh
exec node "$SRC/apps/cli/dist/index.js" "\$@"
EOF
chmod +x "$BIN_DIR/codemap"

"$BIN_DIR/codemap" doctor >/dev/null || fail "installed, but 'codemap doctor' reported a problem; run it to see details"
say "Installed CodeMap $("$BIN_DIR/codemap" --version) → $BIN_DIR/codemap"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\nAdd %s to your PATH, e.g.:\n  echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc   # or ~/.zshrc\n' "$BIN_DIR" "$BIN_DIR" ;;
esac
printf '\nTry it:\n  codemap scan .\n  codemap dashboard\n'
