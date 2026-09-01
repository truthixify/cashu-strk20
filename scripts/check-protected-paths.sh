#!/usr/bin/env bash

set -euo pipefail

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "No Git repository found; protected-path check skipped."
  exit 0
fi

protected_pattern='^(AGENTS\.md|CLAUDE\.md|RESEARCH\.md|cashu-starknet-landscape\.html|\.superstack/|research/|tmp/)'
staged_paths=$(git diff --cached --name-only --diff-filter=ACMR)

if [ -n "$staged_paths" ] && echo "$staged_paths" | grep -E "$protected_pattern"; then
  echo "Protected local files are staged. Unstage the paths listed above before committing." >&2
  exit 1
fi

echo "Protected-path check passed."
