#!/bin/sh
# Clone or refresh the two migration repos, then start the tower.
# GITHUB_PAT is required for private COG-GTM repos.
set -e

REPOS_DIR="${REPOS_DIR:-/repos}"
LEGACY_REPO_DIR="${LEGACY_REPO_DIR:-$REPOS_DIR/abinitio-retail-dwh}"
MDP_REPO_DIR="${MDP_REPO_DIR:-$REPOS_DIR/modern-data-platform}"
MDP_REF="${MDP_REF:-main}"
LEGACY_REF="${LEGACY_REF:-main}"

# supply the PAT through a credential helper reading the environment so the
# token never appears in git command arguments or the remote config
authgit() {
  git -c credential.helper= \
      -c credential.helper='!f() { echo "username=x-access-token"; echo "password=${GITHUB_PAT}"; }; f' "$@"
}

clone_or_update() {
  dir="$1"; repo="$2"; ref="$3"
  url="https://github.com/COG-GTM/${repo}.git"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" remote set-url origin "$url"
    # checkout FETCH_HEAD so a changed ref takes effect even when the
    # remote-tracking name from an older shallow clone doesn't exist
    authgit -C "$dir" fetch origin "$ref" && git -C "$dir" checkout -q FETCH_HEAD || echo "warn: refresh of $repo failed, using existing checkout"
  else
    authgit clone --depth 1 --branch "$ref" "$url" "$dir" || { echo "fatal: cannot clone $repo"; exit 1; }
  fi
}

if [ -z "$GITHUB_PAT" ]; then
  echo "warn: GITHUB_PAT not set; assuming repos are pre-mounted at $REPOS_DIR"
else
  mkdir -p "$REPOS_DIR"
  clone_or_update "$LEGACY_REPO_DIR" "abinitio-retail-dwh" "$LEGACY_REF"
  clone_or_update "$MDP_REPO_DIR" "modern-data-platform" "$MDP_REF"
fi

# fail fast if either checkout is missing (e.g. GITHUB_PAT unset and the
# volume is empty) rather than letting the first parity run crash the server
if [ ! -f "$MDP_REPO_DIR/control_tower/run_parity.py" ] || [ ! -d "$LEGACY_REPO_DIR" ]; then
  echo "fatal: required repos not present under $REPOS_DIR (set GITHUB_PAT or pre-mount them)"
  exit 1
fi

exec node server.js
