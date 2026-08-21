#!/usr/bin/env bash
# Post-edit auto-formatter for the svelte frontend project.
# Runs Prettier on the edited file to keep formatting consistent.
# Called by the PostToolUse hook after any edit operation.

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract the file path from the hook input JSON
FILE_PATH=$(echo "$INPUT" | jq -r '.toolInput.filePath // .toolInput.path // empty' 2>/dev/null || echo "")

# If no file path found, exit gracefully
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Only format files inside the frontend directory
if [[ "$FILE_PATH" != *"/frontend/"* ]]; then
  exit 0
fi

# Only format files Prettier handles
EXT="${FILE_PATH##*.}"
case "$EXT" in
  svelte|ts|js|css|html|json|md|yaml|yml) ;;
  *) exit 0 ;;
esac

# File must exist
if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

# Run Prettier on the specific file
cd "$(dirname "$0")/../../frontend" 2>/dev/null || exit 0
npx prettier --write "$FILE_PATH" 2>/dev/null || true

exit 0