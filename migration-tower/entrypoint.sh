#!/bin/sh
# Clone or refresh the two migration repos, then start the tower.
# GITHUB_PAT is required for private COG-GTM repos.
set -e

REPOS_DIR="${REPOS_DIR:-/repos}"
LEGACY_REPO_DIR="${LEGACY_REPO_DIR:-$REPOS_DIR/abinitio-retail-dwh}"
MDP_REPO_DIR="${MDP_REPO_DIR:-$REPOS_DIR/modern-data-platform}"
MDP_REF="${MDP_REF:-main}"
LEGACY_REF="${LEGACY_REF:-main}"

clone_or_update() {
  dir="$1"; repo="$2"; ref="$3"
  url="https://x-access-token:${GITHUB_PAT}@github.com/COG-GTM/${repo}.git"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" remote set-url origin "$url"
    git -C "$dir" fetch origin "$ref" && git -C "$dir" checkout -q "origin/$ref" || echo "warn: refresh of $repo failed, using existing checkout"
  else
    git clone --depth 1 --branch "$ref" "$url" "$dir" || { echo "fatal: cannot clone $repo"; exit 1; }
  fi
  # never leave the token in the remote config
  git -C "$dir" remote set-url origin "https://github.com/COG-GTM/${repo}.git" || true
}

if [ -z "$GITHUB_PAT" ]; then
  echo "warn: GITHUB_PAT not set; assuming repos are pre-mounted at $REPOS_DIR"
else
  mkdir -p "$REPOS_DIR"
  clone_or_update "$LEGACY_REPO_DIR" "abinitio-retail-dwh" "$LEGACY_REF"
  clone_or_update "$MDP_REPO_DIR" "modern-data-platform" "$MDP_REF"
fi

exec node server.js
