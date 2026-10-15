#!/usr/bin/env bash
# Compile HLDPOST with GnuCOBOL and run every case in tests/hldpost-cases.txt.
# Usage: resort-inventory/cobol/test-hldpost.sh   (needs cobc, e.g. apt-get install gnucobol3)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="$(mktemp -d)/HLDPOST"
cobc -x -free -I "$here/copy" -o "$bin" "$here/HLDPOST.cbl"
pass=0; fail=0
while IFS='|' read -r want_rc want_prefix record; do
  [[ -z "$want_rc" || "$want_rc" == \#* ]] && continue
  set +e
  out="$(printf '%-40s\n' "$record" | "$bin"; echo "rc=$?")"; rc="${out##*rc=}"
  set -e
  out="${out%%$'\n'*}"
  if [[ "$rc" == "$want_rc" && "$out" == "$want_prefix"* ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL rc=$rc want=$want_rc :: $record :: $out"; fi
done < "$here/tests/hldpost-cases.txt"
echo "HLDPOST tests: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
