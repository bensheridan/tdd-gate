#!/usr/bin/env bash
# Builds eval cases from real agent runs, one plan at a time:
#   1. a fresh repository containing only the plan
#   2. tdd-gate run with two agents, recording every gate decision (unlabeled cases)
#   3. tdd-gate harvest from the finished run branch (labeled by construction)
#
# Usage: eval/harvest.sh <workspace dir> [plan ...]     (default: every plan in eval/plans)
# Needs TYPESAFE_API_KEY, a built dist/, node_modules (linked into each project for Vitest),
# and an agent CLI (Claude Code by default; set AGENT to use another).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:?workspace directory}"; shift || true
PLANS=("$@"); [ ${#PLANS[@]} -eq 0 ] && PLANS=($(ls "$ROOT/eval/plans"))
TEST_CMD="npx vitest run --reporter=junit --outputFile={junit}"
AGENT_ARGS=(); [ -n "${AGENT:-}" ] && AGENT_ARGS=(--agent "$AGENT")
CLI="node $ROOT/dist/cli.js"

for plan in "${PLANS[@]}"; do
  echo "=== $plan"
  proj="$WORK/$plan"
  rm -rf "$proj" && mkdir -p "$proj"
  cp "$ROOT/eval/plans/$plan/requirements.yml" "$proj/"
  printf 'node_modules\n' > "$proj/.gitignore"
  printf '{ "name": "%s", "private": true, "type": "module" }\n' "$plan" > "$proj/package.json"
  ln -s "$ROOT/node_modules" "$proj/node_modules"
  git -C "$proj" init -q -b main
  git -C "$proj" add -A
  git -C "$proj" -c user.name=tdd-gate -c user.email=tdd-gate@localhost commit -q -m "Plan for $plan"

  set +e
  $CLI run --repo "$proj" --requirements "$proj/requirements.yml" --tests tests --test-command "$TEST_CMD" \
    --max-turns 10 --record "$ROOT/eval/cases/$plan/natural" --format json ${AGENT_ARGS[@]+"${AGENT_ARGS[@]}"} > "$WORK/$plan-run.json"
  status=$?
  set -e
  branch=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).branch)' "$WORK/$plan-run.json")
  echo "run: exit $status, branch $branch"
  if [ $status -ne 0 ]; then echo "run did not finish green; skipping harvest for $plan"; continue; fi

  $CLI harvest --repo "$proj" --head "$branch" --base main --requirements "$proj/requirements.yml" --name "$plan" \
    --tests tests --test-command "$TEST_CMD" --skip-requirements interface --out "$ROOT/eval/cases/$plan/harvest" \
    --concurrency 3 ${AGENT_ARGS[@]+"${AGENT_ARGS[@]}"}
done
