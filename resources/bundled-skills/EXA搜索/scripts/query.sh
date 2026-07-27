#!/usr/bin/env bash
# Portable launcher for exa-search query.py (Git Bash / Windows friendly).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
QUERY_PY="${SCRIPT_DIR}/query.py"
ENV_FILE="${SKILL_ROOT}/.env"

# Load local skill secrets without overriding already-exported vars.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

pick_python() {
  local candidates=(
    "${EXA_PYTHON:-}"
    "/c/Users/Admin/AppData/Local/Programs/Python/Python312/python.exe"
    "/c/Users/Admin/AppData/Local/Programs/Python/Python311/python.exe"
    "python"
    "python3"
  )
  local p
  for p in "${candidates[@]}"; do
    [[ -z "$p" ]] && continue
    if command -v "$p" >/dev/null 2>&1 || [[ -x "$p" ]] || [[ -f "$p" ]]; then
      if "$p" -c "import socket, urllib.request" >/dev/null 2>&1; then
        echo "$p"
        return 0
      fi
    fi
  done
  echo "python3"
}

PY="$(pick_python)"
exec "$PY" "$QUERY_PY" "$@"
