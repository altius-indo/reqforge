#!/usr/bin/env bash
# reqforge verifies itself: scan trace tags, run the Rust tests, eval stages and UI e2e suites,
# ingest everything as evidence for the current commit, and print the verification report.
#   scripts/self-verify.sh            # everything
#   scripts/self-verify.sh --fast     # skip the browser e2e suites
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RF=("$ROOT/bin/reqforge" --repo "$ROOT/requirements")
OUT="$ROOT/reqforge-reports"; mkdir -p "$OUT"
SHA="$(git -C "$ROOT" rev-parse HEAD)$(git -C "$ROOT" diff --quiet || echo '+dirty')"
FAST=0; [ "${1:-}" = "--fast" ] && FAST=1

"${RF[@]}" scan >/dev/null
cargo test --manifest-path "$ROOT/server/Cargo.toml" 2>&1 | tee "$OUT/cargo-test.log" | grep -E "^test result" || true
stages=(commit security performance); [ $FAST = 0 ] && stages+=(acceptance)
for s in "${stages[@]}"; do (cd "$ROOT" && "${RF[@]}" evals run --stage "$s" --workdir . >/dev/null) || true; done
files=("$OUT/cargo-test.log"); for s in "${stages[@]}"; do [ -f "$OUT/evals-$s.json" ] && files+=("$OUT/evals-$s.json"); done
if [ $FAST = 0 ]; then for j in "$ROOT"/web/e2e/results/*.xml; do [ -f "$j" ] && files+=("$j"); done; fi
"${RF[@]}" evidence ingest "${files[@]}" --commit "$SHA" --run "local $(date -u +%FT%TZ)" >/dev/null
"${RF[@]}" verify --md
