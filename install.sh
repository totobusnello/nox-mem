#!/usr/bin/env bash
# =============================================================================
# nox-mem — Standalone Installer (Linux)
# =============================================================================
# ⚠️  LINUX ONLY — uses apt/dnf/yum for build tools.
#     macOS / Windows: use  npm i -g nox-mem  instead (no script needed).
#     On Linux you do not need this script either: with Node 20+ and a C
#     toolchain, `npm i -g nox-mem` is the whole install. The script adds the
#     checks, the data directory and an .env template around that one command.
# =============================================================================
# Installs nox-mem FROM THE NPM REGISTRY (`npm install -g nox-mem`), not from
# this checkout. Does NOT require OpenClaw.
#
# Usage:
#   bash install.sh [--dry-run] [--with-cron] [--with-watcher]
#
# What this does:
#   1. Checks Node.js >= 20 (and a C toolchain + python3, which better-sqlite3
#      needs when it has to compile)
#   2. npm install -g nox-mem            (NOX_MEM_VERSION=3.4.0 to pin a version)
#   3. Creates ~/.nox-mem and writes an .env template there if none exists
#
# Root is needed ONLY for: installing missing build tools, a global npm prefix
# that root owns, and --with-watcher. Otherwise run it as your own user.
#
# Off by default (opt in with a flag):
#   --with-cron     vectorize every 4h; consolidate 23:00 only when
#                   OPENCLAW_WORKSPACE is set (consolidate writes into that
#                   workspace and commits there). Crons source the .env.
#   --with-watcher  systemd unit for the OpenClaw layout ($OPENCLAW_WORKSPACE/
#                   memory and /shared). Needs root, systemd and a repo checkout.
#                   For a plain notes folder do this instead, no unit needed:
#                     NOX_WATCH_DIRS="$HOME/.nox-mem/memory" nox-mem watch
#
# What this does NOT do:
#   - Does NOT install OpenClaw
#   - Does NOT install Ollama (nox-mem uses Gemini by default)
# =============================================================================

set -euo pipefail

# Platform check — the system-package step targets Linux only
if [[ "$(uname -s)" != "Linux" ]]; then
  echo ""
  echo "⚠️  install.sh is Linux only (apt/dnf/yum for build tools)."
  echo "   macOS / Windows: run  npm i -g nox-mem  instead."
  echo ""
  exit 1
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

ORIG_ARGS="$*"
DRY_RUN=false
WITH_CRON=false
WITH_WATCHER=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=true ;;
    --with-cron)    WITH_CRON=true ;;
    --with-watcher) WITH_WATCHER=true ;;
    -h|--help)      sed -n '/^# Usage:/,/^# What this does NOT do/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg  (try: bash install.sh --help)" >&2; exit 2 ;;
  esac
done

LOG_FILE="${TMPDIR:-/tmp}/nox-mem-install.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ENGINE_DIR="$SCRIPT_DIR/nox-mem"          # only used for the .env template and the watcher unit
DATA_DIR="${NOX_HOME:-$HOME/.nox-mem}"
ENV_DEST="$DATA_DIR/.env"
PKG="nox-mem${NOX_MEM_VERSION:+@$NOX_MEM_VERSION}"

log()  { echo -e "${GREEN}[OK]${RESET} $*" | tee -a "$LOG_FILE"; }
info() { echo -e "${BLUE}[->]${RESET} $*" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*" | tee -a "$LOG_FILE"; }
err()  { echo -e "${RED}[ERR]${RESET} $*" | tee -a "$LOG_FILE"; exit 1; }
step() { echo -e "\n${BOLD}${BLUE}=== $* ===${RESET}" | tee -a "$LOG_FILE"; }
dry()  { echo -e "${YELLOW}[DRY]${RESET} $*"; }

run() {
  if $DRY_RUN; then dry "$*"; else "$@" >> "$LOG_FILE" 2>&1 || err "Failed: $*  (see $LOG_FILE)"; fi
}

# Fail fast, with the fix, before anything is half-done.
need_root() {
  if [[ $EUID -ne 0 ]] && ! $DRY_RUN; then
    err "$1 needs root. Re-run as:  sudo bash $0 $ORIG_ARGS   (or fix that yourself and re-run as your user)"
  fi
}

# Banner
echo -e "${BOLD}"
echo "  nox-mem — Standalone Installer (from the npm registry: $PKG)"
echo -e "${RESET}"
echo -e "  $([ "$DRY_RUN" = true ] && echo "${YELLOW}DRY-RUN MODE — no changes will be made${RESET}" || echo "Starting installation...")"
echo ""

# =============================================================================
# STEP 1 — Node.js >= 20
# =============================================================================
step "Step 1/3 — Check Node.js"

if ! command -v node &>/dev/null; then
  err "Node.js not found. Install Node.js 20+ first: https://nodejs.org"
fi

NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if ! [[ "$NODE_VERSION" =~ ^[0-9]+$ ]] || [[ "$NODE_VERSION" -lt 20 ]]; then
  err "Node.js $NODE_VERSION found but >= 20 required. See: https://nodejs.org"
fi
log "Node.js $(node --version) — OK"

if ! command -v npm &>/dev/null; then
  err "npm not found (it ships with Node.js). Reinstall Node.js from https://nodejs.org"
fi

# Build tools: better-sqlite3 downloads a prebuilt binary when it can and
# compiles only when it cannot; python3 + a C++ toolchain cover that case.
MISSING_PKGS=()
command -v gcc &>/dev/null     || MISSING_PKGS+=(gcc)
command -v make &>/dev/null    || MISSING_PKGS+=(make)
command -v python3 &>/dev/null || MISSING_PKGS+=(python3)

if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
  info "Missing build tools: ${MISSING_PKGS[*]}"
  need_root "Installing build tools (${MISSING_PKGS[*]})"
  if command -v apt-get &>/dev/null; then
    PKGS=(); for p in "${MISSING_PKGS[@]}"; do [[ "$p" == gcc || "$p" == make ]] && p=build-essential; PKGS+=("$p"); done
    run apt-get update
    run apt-get install -y "${PKGS[@]}"
  elif command -v dnf &>/dev/null; then
    PKGS=(); for p in "${MISSING_PKGS[@]}"; do [[ "$p" == gcc ]] && PKGS+=(gcc gcc-c++) || PKGS+=("$p"); done
    run dnf install -y "${PKGS[@]}"
  elif command -v yum &>/dev/null; then
    PKGS=(); for p in "${MISSING_PKGS[@]}"; do [[ "$p" == gcc ]] && PKGS+=(gcc gcc-c++) || PKGS+=("$p"); done
    run yum install -y "${PKGS[@]}"
  else
    warn "Unknown package manager. Install manually: ${MISSING_PKGS[*]}"
  fi
fi
log "Build tools — OK"

# =============================================================================
# STEP 2 — Install from the npm registry
# =============================================================================
step "Step 2/3 — npm install -g $PKG"

NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
if [[ -n "$NPM_PREFIX" && $EUID -ne 0 && ! -w "$NPM_PREFIX/lib/node_modules" ]] && ! $DRY_RUN; then
  err "The global npm prefix ($NPM_PREFIX) is not writable by you. Either re-run with sudo, or point npm at your own prefix:  npm config set prefix \"\$HOME/.npm-global\" && export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
fi

if $DRY_RUN; then
  dry "npm install -g $PKG"
else
  npm install -g "$PKG" 2>&1 | tee -a "$LOG_FILE" | tail -3
fi

if ! $DRY_RUN; then
  if ! command -v nox-mem &>/dev/null; then
    warn "nox-mem not found in PATH after global install. Check npm prefix: $(npm prefix -g)/bin"
    warn "You may need to add it to PATH: export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  else
    log "nox-mem $(nox-mem --version 2>/dev/null | head -1 || echo 'installed') — OK"
  fi
fi

# =============================================================================
# STEP 3 — Data directory and .env template
# =============================================================================
step "Step 3/3 — Data directory and environment"

if $DRY_RUN; then
  dry "mkdir -p $DATA_DIR/memory"
else
  mkdir -p "$DATA_DIR/memory"
  chmod 700 "$DATA_DIR"
  log "Data directory: $DATA_DIR  (database default: $DATA_DIR/nox.db; put notes in $DATA_DIR/memory)"
fi

if [[ -f "$ENV_DEST" ]]; then
  warn ".env already exists at $ENV_DEST — not overwriting"
elif $DRY_RUN; then
  dry "Write $ENV_DEST (fill in GEMINI_API_KEY)"
else
  if [[ -f "$REPO_ENGINE_DIR/.env.example" ]]; then
    cp "$REPO_ENGINE_DIR/.env.example" "$ENV_DEST"
  else
    # Not running from a checkout: write the minimum.
    cat > "$ENV_DEST" <<EOF
# nox-mem environment. Load it with:  set -a; source $ENV_DEST; set +a
GEMINI_API_KEY=
NOX_DB_PATH=$DATA_DIR/nox.db
EOF
  fi
  chmod 600 "$ENV_DEST"
  log ".env created at $ENV_DEST (mode 600)"
  warn "ACTION REQUIRED: edit $ENV_DEST and set GEMINI_API_KEY (https://aistudio.google.com/apikey)"
fi

# ─── Optional: cron jobs (--with-cron) ───────────────────────────────────────
if $WITH_CRON; then
  step "Optional — cron jobs"
  if ! command -v crontab &>/dev/null; then
    warn "crontab not found — skipping crons"
  else
    NOX_BIN="$(command -v nox-mem || echo nox-mem)"
    LOG_DIR="${NOX_LOG_DIR:-$DATA_DIR/logs}"
    # Cron gives jobs an empty environment: source the .env so they have the key.
    LOAD_ENV="set -a; . $ENV_DEST; set +a;"
    CRON_VECTORIZE="0 */4 * * * $LOAD_ENV $NOX_BIN vectorize >> $LOG_DIR/nox-mem.log 2>&1"
    CRON_CONSOLIDATE=""
    if [[ -n "${OPENCLAW_WORKSPACE:-}" ]]; then
      CRON_CONSOLIDATE="0 23 * * * $LOAD_ENV OPENCLAW_WORKSPACE=$OPENCLAW_WORKSPACE $NOX_BIN consolidate >> $LOG_DIR/nox-mem.log 2>&1"
    else
      info "consolidate cron skipped: it writes into \$OPENCLAW_WORKSPACE/memory (not set here)"
    fi
    MARKER_START="# NOX-MEM-CRON-START"
    MARKER_END="# NOX-MEM-CRON-END"
    if $DRY_RUN; then
      dry "Install crons: vectorize every 4h${CRON_CONSOLIDATE:+, consolidate 23:00 daily} (sourcing $ENV_DEST)"
    else
      mkdir -p "$LOG_DIR"
      (
        # A user with no crontab makes `crontab -l` exit 1; under pipefail that
        # used to abort the script silently. `|| true` keeps it going.
        (crontab -l 2>/dev/null || true) | sed "/$MARKER_START/,/$MARKER_END/d"
        echo "$MARKER_START"
        echo "$CRON_VECTORIZE"
        [[ -n "$CRON_CONSOLIDATE" ]] && echo "$CRON_CONSOLIDATE"
        echo "$MARKER_END"
      ) | crontab -
      log "Crons installed (vectorize every 4h${CRON_CONSOLIDATE:+, consolidate daily 23:00})"
    fi
  fi
fi

# ─── Optional: systemd watcher (--with-watcher) ──────────────────────────────
if $WITH_WATCHER; then
  step "Optional — systemd watcher"
  UNIT_SRC="$REPO_ENGINE_DIR/nox-mem-watcher.service"
  if ! command -v systemctl &>/dev/null || [[ ! -f "$UNIT_SRC" ]]; then
    warn "watcher skipped: needs systemd and a repo checkout ($UNIT_SRC not found)"
  else
    need_root "Installing the systemd watcher"
    warn "This unit watches \$OPENCLAW_WORKSPACE/memory and /shared (OpenClaw layout), not \$NOX_MEM_DIR."
    warn "For a plain notes folder skip it and run:  NOX_WATCH_DIRS=\"$DATA_DIR/memory\" nox-mem watch"
    if ! command -v inotifywait &>/dev/null; then
      info "Installing inotify-tools..."
      if command -v apt-get &>/dev/null; then run apt-get install -y inotify-tools
      else warn "inotify-tools not found — install it with your package manager"; fi
    fi
    if $DRY_RUN; then
      dry "Install and enable nox-mem-watcher.service"
    else
      sed "s|__NOX_MEM_PATH__|$REPO_ENGINE_DIR|g" "$UNIT_SRC" > /etc/systemd/system/nox-mem-watcher.service
      chmod +x "$REPO_ENGINE_DIR/nox-mem-watch.sh" 2>/dev/null || true
      systemctl daemon-reload
      systemctl enable nox-mem-watcher --quiet
      systemctl start nox-mem-watcher
      log "File watcher active (systemd: nox-mem-watcher)"
    fi
  fi
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${BOLD}${GREEN}=== Installation complete ===${RESET}"
echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo "  1. Edit $ENV_DEST and set GEMINI_API_KEY"
echo "  2. Load it:        set -a; source $ENV_DEST; set +a"
echo "  3. Index notes:    nox-mem ingest $DATA_DIR/memory/*.md     (one or many files)"
echo "  4. Keep indexing:  NOX_WATCH_DIRS=\"$DATA_DIR/memory\" nox-mem watch"
echo "  5. Start the API:  nox-mem-api &"
echo "  6. Health check:   curl -s http://127.0.0.1:18802/api/health | jq '.vectorCoverage | .embedded/.total'"
echo ""
echo -e "${BOLD}Key commands:${RESET}"
echo "  nox-mem search \"query\"  — hybrid search"
echo "  nox-mem stats           — chunk/vector/KG counts"
echo "  nox-mem vectorize       — embed pending chunks"
echo "  nox-mem kg-build        — extract knowledge graph"
echo "  nox-mem doctor          — health check"
echo "  nox-mem --help          — full command list"
echo ""
if $DRY_RUN; then
  echo -e "${YELLOW}DRY-RUN: no changes were made. Re-run without --dry-run to install.${RESET}"
fi
echo "Install log: $LOG_FILE"
echo ""
