#!/usr/bin/env bash
# Cherry-pick a mainline commit onto the current release branch.
# Usage: scripts/cherry-pick-to-release.sh <commit-sha>
set -euo pipefail

SHA="${1:?usage: cherry-pick-to-release.sh <commit-sha>}"

RELEASE_BRANCH="$(git branch -r --list 'origin/release/*' | sort -V | tail -1 | sed 's|^ *origin/||')"
if [ -z "$RELEASE_BRANCH" ]; then
  echo "no release/* branch found" >&2
  exit 1
fi

git fetch origin "$RELEASE_BRANCH"
git checkout "$RELEASE_BRANCH"
git cherry-pick -x "$SHA" || {
  echo "cherry-pick hit conflicts — resolve, then: git cherry-pick --continue && git push origin $RELEASE_BRANCH" >&2
  exit 1
}
git push origin "$RELEASE_BRANCH"
