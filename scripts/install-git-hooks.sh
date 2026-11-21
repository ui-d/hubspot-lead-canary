#!/bin/sh
# Installs a gitleaks pre-commit hook. No husky needed.
# An existing non-managed hook is backed up, never silently overwritten.
set -eu

if [ ! -d .git ]; then
  echo "install-git-hooks: not a git repository, skipping"
  exit 0
fi

HOOK=.git/hooks/pre-commit
MARKER="# Managed by scripts/install-git-hooks.sh"
if [ -f "$HOOK" ] && ! grep -q "$MARKER" "$HOOK"; then
  cp "$HOOK" "$HOOK.backup.$(date +%s)"
  echo "install-git-hooks: existing pre-commit hook backed up"
fi

cat > "$HOOK" <<HOOKEOF
#!/bin/sh
$MARKER
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "pre-commit: gitleaks not installed (brew install gitleaks). Commit blocked." >&2
  exit 1
fi
gitleaks git --pre-commit --staged --redact --no-banner
HOOKEOF
chmod +x "$HOOK"
echo "install-git-hooks: gitleaks pre-commit hook installed"
