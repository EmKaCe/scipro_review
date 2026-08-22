#!/bin/sh
# =============================================================================
# SciPro Review — frontend container entrypoint
# =============================================================================
# Seeds the shared data volume from the repo's tracked criteria on first boot.
#
# The frontend and executor share a named volume mounted at /app/data. A fresh
# volume is EMPTY, so without seeding a new machine boots into a broken
# dashboard ("assignments.yaml not found"). docker-compose mounts the repo's
# tracked data/ read-only at /app/data-default; when the volume has no
# assignments registry yet, the tracked defaults are copied in.
#
# Rules:
#   * Seed ONLY when /app/data/assignments.yaml is missing — teacher-authored
#     state in the volume is never clobbered (cp -n: no-clobber).
#   * Only the TRACKED shared layer is seeded (registry, settings defaults,
#     grading config, criteria, scoring). Gitignored runtime dirs
#     (submissions/, materials/, copilot/, plagiarism/) are machine-specific
#     and never copied.
#   * The seed mount is read-only; the container never writes into the repo
#     tree. Runtime edits live in the volume and flow back via
#     scripts/criteria-export.mjs (see README "Sharing grading criteria").
#
# NOTE: the BusyBox cp in node:22-alpine silently no-ops on the `src/. dest/`
# content-copy idiom — copy each top-level item explicitly instead.
# =============================================================================
set -eu

SEED_ITEMS="assignments.yaml settings.yaml grading_config.yaml criteria scoring"

if [ -d /app/data-default ] && [ ! -f /app/data/assignments.yaml ]; then
	if [ -f /app/data-default/assignments.yaml ]; then
		echo "[seed] /app/data/assignments.yaml missing — copying tracked defaults from /app/data-default"
		mkdir -p /app/data
		for item in $SEED_ITEMS; do
			if [ -e "/app/data-default/$item" ]; then
				cp -rn "/app/data-default/$item" /app/data/
			fi
		done
		echo "[seed] done."
	else
		echo "[seed] /app/data-default has no assignments.yaml — nothing to seed."
		echo "[seed] Set up the first assignment via the /onboarding checklist in the app,"
		echo "[seed] or run: node scripts/criteria-import.mjs --apply"
	fi
fi

exec "$@"