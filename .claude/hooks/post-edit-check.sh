#!/usr/bin/env bash
# PostToolUse check for Write|Edit|MultiEdit on *.ts files:
# Biome format on the edited file, then a project typecheck.
# Exit 2 surfaces short errors to Claude; exit 0 otherwise.
set -uo pipefail

input="$(cat)"
file_path="$(jq -r '.tool_input.file_path // empty' <<<"$input")"

case "$file_path" in
  *.ts) ;;
  *) exit 0 ;;
esac
project_dir="${CLAUDE_PROJECT_DIR:-}"
[ -n "$project_dir" ] || exit 0
case "$file_path" in
  "$project_dir"/*) ;;
  *) exit 0 ;; # only touch files inside this project
esac
[ -f "$file_path" ] || exit 0

cd "$project_dir" || exit 0

fmt_out="$(pnpm exec biome format --write "$file_path" 2>&1)"
if [ $? -ne 0 ]; then
  echo "post-edit-check: biome format failed for $file_path" >&2
  echo "$fmt_out" | grep -E "×|error" | head -n 10 >&2
  exit 2
fi

tsc_out="$(pnpm exec tsc --noEmit --pretty false 2>&1)"
if [ $? -ne 0 ]; then
  echo "post-edit-check: typecheck errors (first 15):" >&2
  echo "$tsc_out" | grep -E "error TS" | head -n 15 >&2
  exit 2
fi

exit 0
