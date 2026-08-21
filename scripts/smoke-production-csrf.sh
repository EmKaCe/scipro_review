#!/usr/bin/env bash
# =============================================================================
# smoke-production-csrf.sh — ORIGIN/CSRF regression gate for the teacher build
# =============================================================================
#
# adapter-node derives the request origin from ORIGIN. When ORIGIN is unset it
# falls back to https, so a plain-http deployment rejects every multipart POST
# (materials/submissions uploads) with 403 "Cross-site POST form submissions
# are forbidden" — while GETs keep working and the health check stays green.
#
# This script pins that behavior on the REAL production build:
#   Leg 1 — server WITHOUT ORIGIN  → multipart upload must be 403
#   Leg 2 — server WITH ORIGIN     → same upload must be 200
#
# Usage:
#   scripts/smoke-production-csrf.sh               # builds teacher mode, runs both legs
#   SKIP_BUILD=1 scripts/smoke-production-csrf.sh  # reuse frontend/build/
#
# Hermetic: uses a temp DATA_DIR + dedicated port; the repo's data/ is never
# touched. Run from anywhere; resolves the repo root itself.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND="$REPO_ROOT/frontend"

PORT="${SMOKE_PORT:-4199}"
UPLOAD_ENDPOINT="http://127.0.0.1:$PORT/api/assignments/soil_contamination/materials"

# Exported so the `exec node build/index.js` subshell inherits them (the
# subshell only sees the environment, not plain shell variables).
export PORT
export EXECUTOR_URL="http://127.0.0.1:9" # CSRF fires before any executor call
TMP_DATA_DIR="$(mktemp -d /tmp/scipro-csrf-XXXXXX)"
export DATA_DIR="$TMP_DATA_DIR"
SERVER_LOG="$TMP_DATA_DIR/server.log"
TMP_FILE="$TMP_DATA_DIR/upload.pdf"
SERVER_PID=""
FAILED=0

cleanup() {
	if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	# Belt and braces: never leave an orphaned listener on the suite's port.
	fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
	rm -rf "$TMP_DATA_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Build teacher mode (or reuse an existing build with SKIP_BUILD=1)
# ---------------------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" = "1" ]; then
	echo "[csrf-smoke] SKIP_BUILD=1 — reusing frontend/build/"
	[ -f "$FRONTEND/build/index.js" ] || {
		echo "ERROR: SKIP_BUILD=1 but frontend/build/index.js is missing" >&2
		exit 1
	}
else
	echo "[csrf-smoke] building teacher mode (ADAPTER=node)..."
	(cd "$FRONTEND" && unset ADAPTER NODE_ENV KI_CONNECT_API_KEY && ADAPTER=node pnpm build:teacher >/dev/null)
fi

# Kill stale listeners from crashed runs — this port belongs to this suite only.
if fuser -k "${PORT}/tcp" >/dev/null 2>&1; then
	echo "[csrf-smoke] killed stale listener on :$PORT" >&2
fi
sleep 1

# Minimal upload payload (the CSRF check fires before any route logic, but the
# 200 leg really persists the file, so keep it a valid PDF-ish blob).
printf '%%PDF-1.4 smoke-test-upload' > "$TMP_FILE"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
start_server() { # $1 = ORIGIN value or "" for unset
	if [ -n "$1" ]; then
		export ORIGIN="$1"
	else
		unset ORIGIN
	fi
	# `exec` replaces the subshell with node, so $! IS the server PID — a plain
	# `( ... ) &` would leave an orphaned node holding the port after kill.
	(cd "$FRONTEND" && exec node build/index.js >"$SERVER_LOG" 2>&1) &
	SERVER_PID=$!
	unset ORIGIN

	# Wait for readiness (max ~30s); fail fast if the process dies (e.g. port
	# still taken) and dump the server log instead of guessing.
	for _ in $(seq 1 60); do
		if ! kill -0 "$SERVER_PID" 2>/dev/null; then
			echo "ERROR: server process died during startup:" >&2
			cat "$SERVER_LOG" >&2
			exit 1
		fi
		if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
			return 0
		fi
		sleep 0.5
	done
	echo "ERROR: server did not become ready on :$PORT" >&2
	cat "$SERVER_LOG" >&2
	exit 1
}

stop_server() {
	if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
		SERVER_PID=""
	fi
	sleep 0.5
}

upload_status() { # prints just the HTTP status code
	curl -s -o /dev/null -w "%{http_code}" -X POST "$UPLOAD_ENDPOINT" \
		-H "Origin: http://localhost:$PORT" \
		-F "file=@$TMP_FILE;type=application/pdf"
}

# ---------------------------------------------------------------------------
# Leg 1 — no ORIGIN: uploads must be rejected (the regression this pins)
# ---------------------------------------------------------------------------
echo "[csrf-smoke] Leg 1: server WITHOUT ORIGIN → upload must be 403"
start_server ""
status="$(upload_status)"
if [ "$status" = "403" ]; then
	echo "[csrf-smoke]   PASS — upload returned 403 (CSRF guard active)"
else
	echo "[csrf-smoke]   FAIL — expected 403, got $status" >&2
	FAILED=1
fi
stop_server

# ---------------------------------------------------------------------------
# Leg 2 — ORIGIN set to the address teachers actually use: uploads work
# ---------------------------------------------------------------------------
echo "[csrf-smoke] Leg 2: server WITH ORIGIN=http://localhost:$PORT → upload must be 200"
start_server "http://localhost:$PORT"
status="$(upload_status)"
if [ "$status" = "200" ]; then
	echo "[csrf-smoke]   PASS — upload returned 200 (file persisted)"
else
	echo "[csrf-smoke]   FAIL — expected 200, got $status" >&2
	FAILED=1
fi
stop_server

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if [ "$FAILED" = "1" ]; then
	echo "[csrf-smoke] RESULT: FAIL — ORIGIN/CSRF behavior regressed" >&2
	exit 1
fi
echo "[csrf-smoke] RESULT: PASS — both legs match the documented deployment contract"
