#!/usr/bin/env bash
# Launcher for media-search (Git Bash / Windows friendly).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
QUERY_PY="${SCRIPT_DIR}/query.py"

# Load local + shared Tavily secrets without overriding exported vars.
for f in \
  "${SKILL_ROOT}/.env" \
  "${SKILL_ROOT}/../.tavily.env" \
  "${SKILL_ROOT}/../tavily-search/.env"
do
  if [[ -f "$f" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$f"
    set +a
  fi
done

# Prefer system Python Scripts so tvly / yt-dlp resolve.
export PATH="/c/Users/Admin/AppData/Local/Programs/Python/Python312/Scripts:${HOME}/.local/bin:${PATH}"

pick_python() {
  local candidates=(
    "${MEDIA_SEARCH_PYTHON:-}"
    "/c/Users/Admin/AppData/Local/Programs/Python/Python312/python.exe"
    "/c/Users/Admin/AppData/Local/Programs/Python/Python311/python.exe"
    "python"
    "python3"
  )
  local p
  for p in "${candidates[@]}"; do
    [[ -z "$p" ]] && continue
    if command -v "$p" >/dev/null 2>&1 || [[ -x "$p" ]] || [[ -f "$p" ]]; then
      if "$p" -c "import socket, json" >/dev/null 2>&1; then
        echo "$p"
        return 0
      fi
    fi
  done
  echo "python3"
}

PY="$(pick_python)"
exec "$PY" "$QUERY_PY" "$@"
