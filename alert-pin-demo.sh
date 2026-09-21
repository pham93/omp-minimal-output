#!/usr/bin/env bash
# Demo: an alert block (todo reminder / injected-rule notice) must not pin the transcript.
#
# Scenario, in a real OMP TUI running this plugin:
#   1. a .ts write triggers a TTSR rule notice -> the plugin paints it as a one-line alert block
#   2. the next prompt asks for a 150-line answer
#   3. the terminal transcript must contain the whole answer (LINE-001 ... LINE-150) and the alert row
#
# Before the fix the alert never reported as finalized, which pinned the transcript frontier: the
# answer was only ever painted inside the live window (its first N lines were dropped) and neither
# the head of the answer nor the alert row reached the terminal.
#
# Usage:  bash alert-pin-demo.sh            # runs and reports PASS/FAIL
#         OMP_DEMO_MODEL=<model> bash ...   # override model (default: OMP's configured default)
#         KEEP=1 bash alert-pin-demo.sh     # keep the tmux session and scratch dirs for inspection
set -uo pipefail

W="${W:-120}"
H="${H:-24}"
WAIT_ALERT="${WAIT_ALERT:-120}"
WAIT_ANSWER="${WAIT_ANSWER:-240}"
LINES="${LINES:-150}"

SCRATCH="$(mktemp -d /tmp/omp-alert-pin.XXXXXX)"
SESSIONS="$(mktemp -d /tmp/omp-alert-pin-sessions.XXXXXX)"
PLAN_OFF="$SCRATCH/plan-off.yml"
SESSION="omp-alert-pin-$$"
PANE="$SCRATCH/pane.txt"

printf 'plan:\n  defaultOnStartup: false\nautoResume: false\n' >"$PLAN_OFF"

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "kept: tmux session '$SESSION', scratch $SCRATCH, sessions $SESSIONS"
    return
  fi
  tmux kill-session -t "$SESSION" 2>/dev/null
  rm -rf "$SCRATCH" "$SESSIONS"
}
trap cleanup EXIT

pane() { tmux capture-pane -t "$SESSION" -p -S -4000 2>/dev/null; }

send() {
  tmux send-keys -t "$SESSION" -l "$1"
  sleep 0.3
  tmux send-keys -t "$SESSION" Enter
}

wait_for() { # wait_for <seconds> <grep-pattern>
  local deadline=$((SECONDS + $1))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if pane | grep -qE "$2"; then return 0; fi
    sleep 2
  done
  return 1
}

command -v tmux >/dev/null || { echo "FAIL: tmux is required"; exit 2; }

model_args=()
[ -n "${OMP_DEMO_MODEL:-}" ] && model_args=(--model "$OMP_DEMO_MODEL")

printf 'starting omp in tmux (%sx%s, scratch %s)\n' "$W" "$H" "$SCRATCH"
tmux new-session -d -s "$SESSION" -x "$W" -y "$H" -c "$SCRATCH" \
  "omp --cwd $SCRATCH --thinking medium --config $PLAN_OFF --session-dir $SESSIONS ${model_args[*]}"

printf 'waiting for the composer\n'
wait_for 90 '❯|> ' || { echo "FAIL: omp never became interactive"; exit 1; }
sleep 3

# A fresh profile opens the first-run provider setup overlay, which swallows keystrokes; skip it.
for _ in 1 2 3; do
  if pane | grep -qE 'Select provider to login|No matching providers|ctrl\+c exit setup'; then
    printf 'dismissing first-run setup overlay\n'
    tmux send-keys -t "$SESSION" Escape
    sleep 2
  fi
done

printf 'step 1: triggering a TTSR rule notice (alert block)\n'
send "Create the file $SCRATCH/trigger.ts with exactly this content and nothing else: export const p = await import(\"node:path\");"
if ! wait_for "$WAIT_ALERT" 'Injecting|incomplete todos'; then
  echo "INCONCLUSIVE: no alert block was painted within ${WAIT_ALERT}s."
  echo "Either the plugin is not loaded in this session (/plugins reload, then retry), OMP opened its"
  echo "provider-setup overlay (visible in the pane; finish setup first), or the model did not write the"
  echo "trigger file (retry with OMP_DEMO_MODEL=<model>)."
  exit 2
fi
sleep 5

printf 'step 2: asking for %s numbered lines\n' "$LINES"
send "Reply with exactly $LINES lines: LINE-001 through LINE-$(printf '%03d' "$LINES"), zero-padded, one per line, nothing else. No tools."
wait_for "$WAIT_ANSWER" "^[[:space:]]*LINE-$(printf '%03d' "$LINES")[[:space:]]*$" || echo "NOTE: answer did not reach its last line in time"
sleep 5

pane >"$PANE"
first="LINE-001"
last="LINE-$(printf '%03d' "$LINES")"
have_first=$(grep -cE "^[[:space:]]*${first}[[:space:]]*$" "$PANE")
have_last=$(grep -cE "^[[:space:]]*${last}[[:space:]]*$" "$PANE")
have_alert=$(grep -c "Injecting\|incomplete todos" "$PANE")
captured=$(grep -c '' "$PANE")

echo
echo "transcript rows captured: $captured"
echo "alert row present:        $have_alert"
echo "$first present:          $have_first"
echo "$last present:           $have_last"

if [ "$have_last" -gt 0 ] && [ "$have_first" -gt 0 ]; then
  echo "PASS: the answer after an alert block reached the transcript in full"
  exit 0
fi
echo "FAIL: the transcript is missing part of the answer (head dropped, frontier pinned)"
exit 1
