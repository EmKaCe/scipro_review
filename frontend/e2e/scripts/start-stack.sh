#!/usr/bin/env bash
#
# start-stack.sh — hermetic E2E stack for the SciPro Review teacher app.
#
# Spawns, on DEDICATED ports that no other process uses:
#   - FastAPI executor on 127.0.0.1:8767   (repo real stack uses 8766)
#   - Vite dev server   on 127.0.0.1:5174  (repo real stack uses 5173)
# against a throwaway temp DATA_DIR (mktemp -d /tmp/scipro-e2e-XXXXXX).
# The repo's real data/ dir is NEVER touched.
#
# KI_CONNECT_API_KEY is deliberately NOT set (and unset here): the autofix
# stage skips deterministically instead of hitting the live KI service, so
# tests never depend on network/LLM behavior.
#
# Seeding (idempotent per DATA_DIR):
#   - data/assignments.yaml + grading_config.yaml + data/criteria/*.yaml
#   - tiny notebooks written directly at submissions/soil_contamination/
#     (2026SS_910 clean, 2026SS_911 with a SyntaxError cell, 2026SS_912 clean)
#   - a copy of the temp DATA_DIR under frontend/static/data so client-side
#     /data/*.yaml fetches resolve (static/data is gitignored, safe).
#
# Used as the Playwright webServer command (see playwright.config.ts).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND/.." && pwd)"
EXECUTOR="$REPO_ROOT/executor"

EXEC_PORT=8767
VITE_PORT=5174

# ---------------------------------------------------------------------------
# Hermetic DATA_DIR — never the repo's data/
# ---------------------------------------------------------------------------
TMP="${SCIPRO_E2E_DATA_DIR:-}"
if [ -z "$TMP" ]; then
	TMP="$(mktemp -d /tmp/scipro-e2e-XXXXXX)"
fi
export SCIPRO_E2E_DATA_DIR="$TMP"
export DATA_DIR="$TMP"

# Kill stale hermetic-stack listeners from crashed runs (8767/5174 belong to
# this suite only — the repo stack lives on 8766/5173).
for port in "$EXEC_PORT" "$VITE_PORT"; do
	if fuser -k "${port}/tcp" >/dev/null 2>&1; then
		echo "[start-stack] killed stale listener on :$port" >&2
	fi
done

# ---------------------------------------------------------------------------
# Seed the temp DATA_DIR (idempotent)
# ---------------------------------------------------------------------------
mkdir -p "$TMP/submissions/soil_contamination" "$TMP/criteria"
cp "$REPO_ROOT/data/assignments.yaml" "$TMP/assignments.yaml"
cp "$REPO_ROOT/data/grading_config.yaml" "$TMP/grading_config.yaml"
cp "$REPO_ROOT/data/criteria/"*.yaml "$TMP/criteria/"
# Tiny synthetic notebooks straight onto the submissions dir.
cp "$FRONTEND/e2e/fixtures/"*.ipynb "$TMP/submissions/soil_contamination/"

# Static copy for client-side /data/*.yaml fetches (gitignored, overwrite ok).
rm -rf "$FRONTEND/static/data"
cp -r "$TMP" "$FRONTEND/static/data"

# ---------------------------------------------------------------------------
# Executor (FastAPI). No KI key → autofix skips deterministically.
# ---------------------------------------------------------------------------
unset KI_CONNECT_API_KEY
(
	cd "$EXECUTOR"
	.venv/bin/uvicorn app:app --host 127.0.0.1 --port "$EXEC_PORT"
) &
EXEC_PID=$!

# ---------------------------------------------------------------------------
# Vite dev server, teacher mode (ADAPTER=node), port 5174.
# ---------------------------------------------------------------------------
(
	cd "$FRONTEND"
	DATA_DIR="$TMP" EXECUTOR_URL="http://127.0.0.1:${EXEC_PORT}" ADAPTER=node \
		npx vite dev --port "$VITE_PORT" --host 127.0.0.1
) &
VITE_PID=$!

cleanup() {
	kill "$EXEC_PID" "$VITE_PID" 2>/dev/null || true
	wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Readiness (fail loudly so Playwright reports webServer startup failure)
# ---------------------------------------------------------------------------
ok=0
for _ in $(seq 1 90); do
	if curl -sf "http://127.0.0.1:${EXEC_PORT}/health" >/dev/null 2>&1; then
		ok=1
		break
	fi
	sleep 1
done
[ "$ok" = 1 ] || { echo "[start-stack] executor failed to start on :$EXEC_PORT" >&2; exit 1; }

ok=0
for _ in $(seq 1 120); do
	if curl -sf "http://127.0.0.1:${VITE_PORT}/api/assignments" >/dev/null 2>&1; then
		ok=1
		break
	fi
	sleep 1
done
[ "$ok" = 1 ] || { echo "[start-stack] vite failed to start on :$VITE_PORT" >&2; exit 1; }

echo "[start-stack] ready — executor :$EXEC_PORT, vite :$VITE_PORT, DATA_DIR=$TMP" >&2

# Keep running until Playwright tears the webServer down.
wait
