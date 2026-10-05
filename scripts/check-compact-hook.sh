#!/usr/bin/env bash
# Does a plugin SessionStart hook with matcher "compact" fire in headless Claude Code, and does
# its additionalContext reach the next model turn? Checks the two shapes reqforge uses
# (design/context-management.md, REQ-0058#AC3):
#   chat  - one `claude -p` process per turn, continuity via --resume
#   agent - one long `claude -p` process (stream-json input, several user messages)
# Each case compacts with /compact, then asks for a nonce that only the hook supplies.
#   scripts/check-compact-hook.sh            # both cases, model from $MODEL (default haiku)
# Prints one PASS/FAIL line per case; exits 1 if either fails. Costs a few cents.
set -uo pipefail
CLAUDE="${REQFORGE_CLAUDE_BIN:-claude}"
MODEL="${MODEL:-haiku}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
NONCE="ORCHID-$RANDOM-$RANDOM"
mkdir -p "$T/plugin/.claude-plugin" "$T/plugin/hooks" "$T/work"
echo '{"name":"compact-check","version":"0.0.1"}' >"$T/plugin/.claude-plugin/plugin.json"
cat >"$T/plugin/hook.sh" <<EOF
#!/usr/bin/env bash
cat >>"$T/hook.log"; echo >>"$T/hook.log"
printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<project-state source=\"state/HOT.md\">The project codeword is $NONCE.</project-state>"}}'
EOF
chmod +x "$T/plugin/hook.sh"
cat >"$T/plugin/hooks/hooks.json" <<EOF
{"hooks":{"SessionStart":[{"matcher":"compact","hooks":[{"type":"command","command":"$T/plugin/hook.sh","timeout":10}]}]}}
EOF
ASK="What is the project codeword? Reply with the codeword only, or NONE if you have not been told one."
run() { (cd "$T/work" && "$CLAUDE" -p --model "$MODEL" --plugin-dir "$T/plugin" "$@"); }
fired() { grep -c '"source": *"compact"' "$T/hook.log" 2>/dev/null || echo 0; }
rc=0
report() { # case, hook-fired-count, answer
  if [ "$2" -gt 0 ] && grep -q "$NONCE" <<<"$3"; then echo "PASS $1: hook fired ($2x), codeword reached the next turn"
  else echo "FAIL $1: hook fired $2x; answer: $(tr '\n' ' ' <<<"$3" | cut -c1-200)"; rc=1; fi
}

# chat: separate processes joined by --resume
: >"$T/hook.log"
sid="$(run --output-format json "Reply OK." | sed -n 's/.*"session_id": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$sid" ] || { echo "FAIL chat: no session id from first turn"; exit 1; }
run --resume "$sid" --output-format json "/compact" >/dev/null
ans="$(run --resume "$sid" "$ASK")"
report chat "$(fired)" "$ans"

# agent: one process, several user messages over stream-json stdin
: >"$T/hook.log"
msg() { printf '{"type":"user","message":{"role":"user","content":%s}}\n' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')"; }
ans="$( { msg "Reply OK."; msg "/compact"; msg "$ASK"; } | run --input-format stream-json --output-format stream-json --verbose \
  | grep '"type":"result"' | tail -1)"
report agent "$(fired)" "$ans"
exit $rc
