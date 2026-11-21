#!/usr/bin/env bash
# PreToolUse guard for Write|Edit|MultiEdit.
# Blocks writes to secret files and content that looks like a real credential.
# Exit 2 = block; stderr is shown to Claude.
set -euo pipefail
# Fail closed: any unexpected error blocks the write (Claude Code only blocks on exit 2).
trap 'echo "guard-secrets: internal error, blocking write" >&2; exit 2' ERR
command -v jq >/dev/null || { echo "guard-secrets: jq missing, blocking write" >&2; exit 2; }

input="$(cat)"
file_path="$(jq -r '.tool_input.file_path // empty' <<<"$input")"
content="$(jq -r '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | .[].new_string)] | map(select(. != null)) | join("\n")' <<<"$input")"

base="$(basename -- "${file_path:-}")"
case "$base" in
  .dev.vars.example | .env.example) ;; # placeholders only, allowed
  .dev.vars | .dev.vars.* | .env | .env.*)
    echo "guard-secrets: blocked write to secret file '$base'. The user edits secret files manually." >&2
    exit 2
    ;;
esac

# Patterns are anchored on real credential shapes, so docs that merely mention a prefix pass.
declare -a names=(
  "HubSpot private app token"
  "Resend API key"
  "Sentry DSN"
)
declare -a patterns=(
  'pat-(na|eu|ap)[0-9]+-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-'
  '(^|[^A-Za-z0-9])re_[A-Za-z0-9]{6,}_[A-Za-z0-9]{12,}'
  'https://[0-9a-f]{32}@[A-Za-z0-9.-]+/[0-9]+'
)

for i in "${!patterns[@]}"; do
  if grep -Eq -- "${patterns[$i]}" <<<"$content"; then
    echo "guard-secrets: blocked write to '${file_path}': content matches a ${names[$i]} pattern. Use .dev.vars or 'wrangler secret put' (typed by the user), never source files." >&2
    exit 2
  fi
done

exit 0
