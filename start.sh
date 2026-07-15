#!/usr/bin/env bash
#
# Start the Crossword Builder backend (FastAPI on :8080) and frontend
# (Next.js on :3030) together. Press Ctrl+C to stop both.
#
set -euo pipefail

# Resolve the repo root (directory this script lives in) so it works from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

BACKEND_PORT="${BACKEND_PORT:-8080}"
FRONTEND_PORT="${FRONTEND_PORT:-3030}"

# --- sanity checks ---------------------------------------------------------
if [ ! -x "$BACKEND/venv/bin/uvicorn" ]; then
  echo "ERROR: backend virtualenv not found at $BACKEND/venv."
  echo "Create it with:  cd backend && python3 -m venv venv && venv/bin/pip install -r requirements.txt"
  exit 1
fi

if [ ! -d "$FRONTEND/node_modules" ]; then
  echo "Frontend dependencies not installed — running 'npm install' first..."
  (cd "$FRONTEND" && npm install)
fi

# --- shutdown handling -----------------------------------------------------
# Kill the whole process group of each child on exit so uvicorn/next and any
# workers they spawn are cleaned up together.
PIDS=()
cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# --- start backend ---------------------------------------------------------
echo "Starting backend  → http://localhost:$BACKEND_PORT"
(
  cd "$BACKEND"
  exec venv/bin/uvicorn main:app --host 0.0.0.0 --port "$BACKEND_PORT" --reload
) &
PIDS+=("$!")

# --- start frontend --------------------------------------------------------
echo "Starting frontend → http://localhost:$FRONTEND_PORT"
(
  cd "$FRONTEND"
  exec npm run dev -- --port "$FRONTEND_PORT"
) &
PIDS+=("$!")

echo ""
echo "Both servers are starting. Open http://localhost:$FRONTEND_PORT"
echo "Press Ctrl+C to stop both."
echo ""

# Wait for either process to exit; if one dies, the loop ends and cleanup()
# (via trap) stops the other. Uses a poll loop instead of 'wait -n' so it works
# on macOS's default bash 3.2.
while kill -0 "${PIDS[0]}" 2>/dev/null && kill -0 "${PIDS[1]}" 2>/dev/null; do
  sleep 1
done
