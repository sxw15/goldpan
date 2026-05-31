#!/usr/bin/env bash
# Clean build artifacts and dependencies across the monorepo.
# Preserves: data/ (SQLite + assets), source, configs, lockfile.
#
# Usage:
#   ./scripts/clean.sh              # clean only
#   ./scripts/clean.sh --install    # clean then run pnpm install
#   ./scripts/clean.sh --dry-run    # show what would be deleted
#   ./scripts/clean.sh --help

set -euo pipefail

print_help() {
  cat <<'EOF'
Usage: clean.sh [--install] [--dry-run] [--help]

Removes the following from the monorepo (recursively):
  - node_modules/
  - dist/
  - .next/
  - .turbo/
  - .vitest-cache/

Preserves:
  - data/   (SQLite DBs, user assets)
  - drizzle/ (migration history)
  - all source code, configs, lockfile

Platform: auto-detects macOS / Linux / Windows (Git Bash / MSYS / Cygwin).
On Windows uses cmd `rd /s /q` for speed when available.

Options:
  --install   run `pnpm install` after cleaning
  --dry-run   list paths that would be removed, do not delete
  --help      show this help
EOF
}

# Parse args.
DO_INSTALL=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h) print_help; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; print_help; exit 2 ;;
  esac
done

# Detect platform.
case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin*) PLATFORM="mac" ;;
  Linux*)  PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
  *) echo "Unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac
echo "Platform: $PLATFORM"

# Resolve monorepo root (script lives in scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
echo "Root: $ROOT"

# Windows-aware path removal. rm -rf works in Git Bash but is slow on huge trees;
# delegating to cmd's `rd /s /q` is dramatically faster on Windows.
remove_path() {
  local path="$1"
  if [ ! -e "$path" ]; then return; fi
  echo "  rm: $path"
  if [ "$DRY_RUN" -eq 1 ]; then return; fi

  case "$PLATFORM" in
    windows)
      if command -v cygpath >/dev/null 2>&1 && command -v cmd >/dev/null 2>&1; then
        local winpath
        winpath="$(cygpath -w "$path")"
        cmd //c "rd /s /q \"$winpath\"" 2>/dev/null || rm -rf "$path"
      else
        rm -rf "$path"
      fi
      ;;
    *)
      rm -rf "$path"
      ;;
  esac
}

echo "Scanning for build artifacts..."
# -prune after a match so we don't descend into a matched dir looking for nested matches.
# -path ./data -prune skips the entire data/ tree.
# Use NUL-separated output so paths with spaces survive.
while IFS= read -r -d '' dir; do
  remove_path "$dir"
done < <(
  find . \
    -path ./data -prune -o \
    -path ./drizzle -prune -o \
    \( \
      -name node_modules -o \
      -name dist -o \
      -name .next -o \
      -name .turbo -o \
      -name .vitest-cache \
    \) -type d -prune -print0
)

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run complete. Nothing was deleted."
  exit 0
fi

echo "Clean complete."

if [ "$DO_INSTALL" -eq 1 ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm not found in PATH; skipping install." >&2
    exit 1
  fi
  echo "Running pnpm install..."
  pnpm install
fi
