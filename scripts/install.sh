#!/usr/bin/env sh
# kolm bootstrap installer — POSIX (macOS + Linux + WSL).
#
# usage:
#   curl -sSL https://kolm.ai/install.sh | sh
#   curl -sSL https://kolm.ai/install.sh | KOLM_VERSION=v7.4.0 sh
#   curl -sSL https://kolm.ai/install.sh | KOLM_INSTALL_DIR=$HOME/.local/share/kolm sh
#
# what it does:
#   1. detects OS + arch
#   2. ensures node >=20 (uses existing if found, otherwise tells user to install)
#   3. clones the kolm repo into KOLM_INSTALL_DIR (default ~/.kolm/lib/kolm)
#   4. symlinks `kolm` into KOLM_BIN_DIR (default ~/.local/bin)
#   5. runs `kolm doctor` to verify the install
#
# exits 0 on success, non-zero with a printed reason on failure.

set -eu

KOLM_VERSION="${KOLM_VERSION:-main}"
KOLM_INSTALL_DIR="${KOLM_INSTALL_DIR:-$HOME/.kolm/lib/kolm}"
KOLM_BIN_DIR="${KOLM_BIN_DIR:-$HOME/.local/bin}"
KOLM_REPO_URL="${KOLM_REPO_URL:-https://github.com/sneaky-hippo/kolm-stack.git}"
KOLM_REQUIRE_NODE_MAJOR="${KOLM_REQUIRE_NODE_MAJOR:-20}"

log()  { printf "[kolm-install] %s\n" "$*"; }
die()  { printf "[kolm-install] error: %s\n" "$*" >&2; exit 1; }
warn() { printf "[kolm-install] warn:  %s\n" "$*" >&2; }

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *MINGW*|*MSYS*|*CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x86_64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) echo "unknown" ;;
  esac
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "node not found. install Node.js >=${KOLM_REQUIRE_NODE_MAJOR} from https://nodejs.org and re-run."
  fi
  NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(\".\")[0]))')"
  if [ "$NODE_MAJOR" -lt "$KOLM_REQUIRE_NODE_MAJOR" ]; then
    die "node version $NODE_MAJOR found, need >=${KOLM_REQUIRE_NODE_MAJOR}. upgrade Node.js and re-run."
  fi
  log "node $(node -v) OK"
}

require_git() {
  if ! command -v git >/dev/null 2>&1; then
    die "git not found. install git and re-run."
  fi
}

clone_or_update() {
  if [ -d "$KOLM_INSTALL_DIR/.git" ]; then
    log "updating existing checkout at $KOLM_INSTALL_DIR"
    (cd "$KOLM_INSTALL_DIR" && git fetch --depth=1 origin "$KOLM_VERSION" && git checkout -q "$KOLM_VERSION" && git reset --hard "origin/$KOLM_VERSION" 2>/dev/null || git reset --hard "$KOLM_VERSION")
  else
    log "cloning $KOLM_REPO_URL@$KOLM_VERSION into $KOLM_INSTALL_DIR"
    mkdir -p "$(dirname "$KOLM_INSTALL_DIR")"
    git clone --depth=1 --branch "$KOLM_VERSION" "$KOLM_REPO_URL" "$KOLM_INSTALL_DIR" 2>/dev/null \
      || git clone --depth=1 "$KOLM_REPO_URL" "$KOLM_INSTALL_DIR"
  fi
}

install_link() {
  mkdir -p "$KOLM_BIN_DIR"
  TARGET="$KOLM_BIN_DIR/kolm"
  ENTRY="$KOLM_INSTALL_DIR/cli/kolm.js"
  if [ ! -f "$ENTRY" ]; then
    die "expected $ENTRY after clone, not found"
  fi
  chmod +x "$ENTRY"
  if [ -L "$TARGET" ] || [ -f "$TARGET" ]; then rm -f "$TARGET"; fi
  ln -s "$ENTRY" "$TARGET"
  log "symlinked $TARGET -> $ENTRY"
}

ensure_path_hint() {
  case ":$PATH:" in
    *":$KOLM_BIN_DIR:"*) : ;;
    *)
      warn "$KOLM_BIN_DIR is not on your PATH."
      warn "add this to your shell rc (~/.zshrc, ~/.bashrc, ~/.profile):"
      warn '    export PATH="$HOME/.local/bin:$PATH"'
      ;;
  esac
}

post_install_check() {
  if "$KOLM_BIN_DIR/kolm" version >/dev/null 2>&1; then
    VER="$("$KOLM_BIN_DIR/kolm" version 2>/dev/null | head -1)"
    log "kolm installed: $VER"
  else
    warn "kolm symlinked but 'kolm version' failed — investigate $KOLM_INSTALL_DIR"
  fi
  if "$KOLM_BIN_DIR/kolm" doctor --quick >/dev/null 2>&1; then
    log "kolm doctor: pass"
  else
    warn "kolm doctor reported issues — run 'kolm doctor' to inspect"
  fi
}

main() {
  OS="$(detect_os)"
  ARCH="$(detect_arch)"
  log "platform: $OS/$ARCH"
  [ "$OS" = "unknown" ] && warn "unrecognized OS — proceeding optimistically"
  [ "$ARCH" = "unknown" ] && warn "unrecognized arch — proceeding optimistically"

  require_node
  require_git
  clone_or_update
  install_link
  ensure_path_hint
  post_install_check

  cat <<EOF

next steps:
  1. open a new shell or run: export PATH="$KOLM_BIN_DIR:\$PATH"
  2. kolm quickstart            # 60-second tour
  3. kolm services start all    # boot redactor + compiler + proxy locally
  4. kolm bootstrap             # finish multi-device + cloud config (optional)

docs:    https://kolm.ai/quickstart
install: $KOLM_INSTALL_DIR
binary:  $KOLM_BIN_DIR/kolm

EOF
}

main "$@"
