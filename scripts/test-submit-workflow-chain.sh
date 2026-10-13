#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CHAIN_SKILL="$ROOT/skills/workflow-chain-submit/SKILL.md"
[[ -f "$CHAIN_SKILL" ]] || { echo "missing $CHAIN_SKILL"; exit 1; }
grep -qF 'Stacked onto WF-X' "$CHAIN_SKILL" || { echo "workflow-chain-submit SKILL missing stacked-onto rule"; exit 1; }
grep -qF -- '--onto-workflow' "$CHAIN_SKILL" || { echo "workflow-chain-submit SKILL missing --onto-workflow"; exit 1; }
grep -qF 'gate-only wait' "$CHAIN_SKILL" || { echo "workflow-chain-submit SKILL missing gate-only wait distinction"; exit 1; }

mkdir -p "$TMP_DIR/scripts" "$TMP_DIR/plans" "$TMP_DIR/bin"
cp "$ROOT/scripts/submit-workflow-chain.sh" "$TMP_DIR/scripts/submit-workflow-chain.sh"
chmod +x "$TMP_DIR/scripts/submit-workflow-chain.sh"

cat > "$TMP_DIR/bin/invoker-cli" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${INVOKER_CLI_FORBIDDEN:-0}" == "1" ]]; then
  echo "TEST FAILURE: invoker-cli mock invoked during a local-backend scenario" >&2
  exit 1
fi

STATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.state"
mkdir -p "$STATE_DIR"

WORKFLOWS_JSON="$STATE_DIR/workflows.json"
TASKS_JSON="$STATE_DIR/tasks.json"
SEQ_FILE="$STATE_DIR/seq"

[[ -f "$WORKFLOWS_JSON" ]] || printf '[]' > "$WORKFLOWS_JSON"
[[ -f "$TASKS_JSON" ]] || printf '[]' > "$TASKS_JSON"
[[ -f "$SEQ_FILE" ]] || printf '1000' > "$SEQ_FILE"

cmd="${1:-}"
shift || true

case "$cmd" in
  query)
    sub="${1:-}"
    if [[ "$sub" == "workflows" ]]; then
      cat "$WORKFLOWS_JSON"
      exit 0
    fi
    if [[ "$sub" == "tasks" ]]; then
      cat "$TASKS_JSON"
      exit 0
    fi
    echo "unsupported query subcommand: $sub" >&2
    exit 1
    ;;
  run)
    plan="${1:-}"
    [[ -f "$plan" ]] || { echo "missing plan: $plan" >&2; exit 1; }

    seq="$(cat "$SEQ_FILE")"
    wf_id="wf-${seq}-1"
    printf '%s' "$((seq + 1))" > "$SEQ_FILE"

    name="$(awk -F': *' '/^name:/{v=$2; gsub(/^"|"$/, "", v); print v; exit}' "$plan")"
    base="$(awk -F': *' '/^baseBranch:/{print $2; exit}' "$plan")"
    feature="$(awk -F': *' '/^featureBranch:/{print $2; exit}' "$plan")"
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    jq --arg id "$wf_id" \
      --arg name "$name" \
      --arg base "$base" \
      --arg feature "$feature" \
      --arg now "$now" \
      '. += [{id:$id,name:$name,status:"running",baseBranch:$base,featureBranch:$feature,createdAt:$now}]' \
      "$WORKFLOWS_JSON" > "$WORKFLOWS_JSON.tmp"
    mv "$WORKFLOWS_JSON.tmp" "$WORKFLOWS_JSON"

    jq --arg id "__merge__${wf_id}" \
      '. += [{id:$id,status:"pending",config:{}}]' \
      "$TASKS_JSON" > "$TASKS_JSON.tmp"
    mv "$TASKS_JSON.tmp" "$TASKS_JSON"

    jq -n --arg id "$wf_id" '{workflow:{id:$id,status:"success"},result:{workflowId:$id,status:"success",completedTasks:0,failedTasks:0,mode:"live"}}'
    ;;
  *)
    echo "unsupported command: $cmd" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$TMP_DIR/bin/invoker-cli"

cat > "$TMP_DIR/run.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${RUN_SH_FORBIDDEN:-0}" == "1" ]]; then
  echo "TEST FAILURE: ./run.sh mock invoked during a live-backend scenario" >&2
  exit 1
fi

STATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.state"
mkdir -p "$STATE_DIR"

WORKFLOWS_JSON="$STATE_DIR/workflows.json"
TASKS_JSON="$STATE_DIR/tasks.json"
SEQ_FILE="$STATE_DIR/seq"

[[ -f "$WORKFLOWS_JSON" ]] || printf '[]' > "$WORKFLOWS_JSON"
[[ -f "$TASKS_JSON" ]] || printf '[]' > "$TASKS_JSON"
[[ -f "$SEQ_FILE" ]] || printf '1000' > "$SEQ_FILE"

if [[ "${1:-}" != "--headless" ]]; then
  echo "mock run.sh expects --headless" >&2
  exit 1
fi
shift

cmd="${1:-}"
shift || true

case "$cmd" in
  query)
    sub="${1:-}"
    if [[ "$sub" == "workflows" ]]; then
      cat "$WORKFLOWS_JSON"
      exit 0
    fi
    if [[ "$sub" == "tasks" ]]; then
      cat "$TASKS_JSON"
      exit 0
    fi
    echo "unsupported query subcommand: $sub" >&2
    exit 1
    ;;
  run)
    plan="${1:-}"
    [[ -f "$plan" ]] || { echo "missing plan: $plan" >&2; exit 1; }

    seq="$(cat "$SEQ_FILE")"
    wf_id="wf-${seq}-1"
    printf '%s' "$((seq + 1))" > "$SEQ_FILE"

    name="$(awk -F': *' '/^name:/{v=$2; gsub(/^"|"$/, "", v); print v; exit}' "$plan")"
    base="$(awk -F': *' '/^baseBranch:/{print $2; exit}' "$plan")"
    feature="$(awk -F': *' '/^featureBranch:/{print $2; exit}' "$plan")"
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    jq --arg id "$wf_id" \
      --arg name "$name" \
      --arg base "$base" \
      --arg feature "$feature" \
      --arg now "$now" \
      '. += [{id:$id,name:$name,status:"running",baseBranch:$base,featureBranch:$feature,createdAt:$now}]' \
      "$WORKFLOWS_JSON" > "$WORKFLOWS_JSON.tmp"
    mv "$WORKFLOWS_JSON.tmp" "$WORKFLOWS_JSON"

    jq --arg id "__merge__${wf_id}" \
      '. += [{id:$id,status:"pending",config:{}}]' \
      "$TASKS_JSON" > "$TASKS_JSON.tmp"
    mv "$TASKS_JSON.tmp" "$TASKS_JSON"

    echo "Workflow ID: $wf_id"
    ;;
  *)
    echo "unsupported command: $cmd" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$TMP_DIR/run.sh"
export PATH="$TMP_DIR/bin:$PATH"

cat > "$TMP_DIR/plans/a.yaml" <<'EOF'
name: "A"
repoUrl: git@github.com:example-org/acme-repo.git
baseBranch: master
featureBranch: feature/a
tasks:
  - id: t1
    description: "a"
    command: echo a
EOF

cat > "$TMP_DIR/plans/b.yaml" <<'EOF'
name: "B"
repoUrl: git@github.com:example-org/acme-repo.git
baseBranch: master
featureBranch: feature/b
tasks:
  - id: t2
    description: "b"
    command: echo b
    externalDependencies:
      - workflowId: "__UPSTREAM_WORKFLOW_ID__"
        taskId: "leaf-task"
        requiredStatus: completed
      - workflowId: "wf-static"
        taskId: "__merge__"
        requiredStatus: completed
        gatePolicy: review_ready
EOF

cat > "$TMP_DIR/plans/c.yaml" <<'EOF'
name: "C"
repoUrl: git@github.com:example-org/acme-repo.git
baseBranch: master
featureBranch: feature/c
tasks:
  - id: t3
    description: "c"
    command: echo c
    externalDependencies:
      - workflowId: "__UPSTREAM_WORKFLOW_ID__"
        taskId: "another-leaf"
        requiredStatus: completed
EOF

out="$(
  cd "$TMP_DIR"
  INVOKER_CLI_FORBIDDEN=1 ./scripts/submit-workflow-chain.sh ./plans/a.yaml ./plans/b.yaml ./plans/c.yaml
)"

grep -q '^BACKEND=local$' <<<"$out" || { echo "expected local backend for a plain chain with no external ref"; echo "$out"; exit 1; }

wf1="$(printf '%s\n' "$out" | awk -F'[ =]' '/^WF1=/{print $2; exit}')"
wf2="$(printf '%s\n' "$out" | awk -F'[ =]' '/^WF2=/{print $2; exit}')"
wf3="$(printf '%s\n' "$out" | awk -F'[ =]' '/^WF3=/{print $2; exit}')"
rp2="$(printf '%s\n' "$out" | sed -n 's/^RENDERED_PLAN=//p' | sed -n '1p')"
rp3="$(printf '%s\n' "$out" | sed -n 's/^RENDERED_PLAN=//p' | sed -n '2p')"

[[ -n "$wf1" && -n "$wf2" && -n "$wf3" ]] || { echo "missing WF IDs in output"; echo "$out"; exit 1; }
[[ -f "$rp2" && -f "$rp3" ]] || { echo "missing rendered plans in output"; echo "$out"; exit 1; }

grep -q "workflowId: \"$wf1\"" "$rp2"
grep -q 'taskId: "__merge__"' "$rp2"
grep -q '^ *gatePolicy: completed$' "$rp2"
grep -q '^baseBranch: feature/a$' "$rp2"
grep -q 'workflowId: "wf-static"' "$rp2"
grep -q '^ *gatePolicy: review_ready$' "$rp2"

grep -q "workflowId: \"$wf2\"" "$rp3"
grep -q 'taskId: "__merge__"' "$rp3"
grep -q '^ *gatePolicy: completed$' "$rp3"
grep -q '^baseBranch: feature/b$' "$rp3"

out_rr="$(
  cd "$TMP_DIR"
  INVOKER_CLI_FORBIDDEN=1 ./scripts/submit-workflow-chain.sh --gate-policy review_ready ./plans/a.yaml ./plans/b.yaml ./plans/c.yaml
)"

grep -q '^BACKEND=local$' <<<"$out_rr" || { echo "expected local backend for review_ready chain with no external ref"; echo "$out_rr"; exit 1; }

rp2_rr="$(printf '%s\n' "$out_rr" | sed -n 's/^RENDERED_PLAN=//p' | sed -n '1p')"
rp3_rr="$(printf '%s\n' "$out_rr" | sed -n 's/^RENDERED_PLAN=//p' | sed -n '2p')"
[[ -f "$rp2_rr" && -f "$rp3_rr" ]] || { echo "missing rendered plans for review_ready"; echo "$out_rr"; exit 1; }
grep -q '^ *gatePolicy: review_ready$' "$rp2_rr"
grep -q '^ *gatePolicy: review_ready$' "$rp3_rr"

SEED_STATE="$TMP_DIR/.state"
mkdir -p "$SEED_STATE"
printf '[]' > "$SEED_STATE/workflows.json"
printf '[]' > "$SEED_STATE/tasks.json"
printf '2000' > "$SEED_STATE/seq"
jq -n \
  --arg id "wf-fanout-1" \
  --arg name "Fanout Upstream" \
  --arg base "master" \
  --arg feature "plan/fanout-upstream" \
  --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '[{id:$id,name:$name,status:"review_ready",baseBranch:$base,featureBranch:$feature,createdAt:$now}]' \
  > "$SEED_STATE/workflows.json"
jq -n --arg id "__merge__wf-fanout-1" '[{id:$id,status:"review_ready",config:{}}]' > "$SEED_STATE/tasks.json"

cat > "$TMP_DIR/plans/onto-head.yaml" <<'EOF'
name: "OntoHead"
repoUrl: git@github.com:example-org/acme-repo.git
baseBranch: main
featureBranch: feature/onto-head
externalDependencies:
  - workflowId: "wf-fanout-1"
    taskId: "__merge__"
    requiredStatus: completed
    gatePolicy: review_ready
tasks:
  - id: t-onto
    description: "onto head"
    command: echo onto
EOF

cat > "$TMP_DIR/plans/onto-next.yaml" <<'EOF'
name: "OntoNext"
repoUrl: git@github.com:example-org/acme-repo.git
baseBranch: master
featureBranch: feature/onto-next
tasks:
  - id: t-next
    description: "onto next"
    command: echo next
    externalDependencies:
      - workflowId: "__UPSTREAM_WORKFLOW_ID__"
        taskId: "__merge__"
        requiredStatus: completed
EOF

out_onto="$(
  cd "$TMP_DIR"
  RUN_SH_FORBIDDEN=1 ./scripts/submit-workflow-chain.sh --onto-workflow wf-fanout-1 ./plans/onto-head.yaml ./plans/onto-next.yaml
)"
grep -q '^BACKEND=live$' <<<"$out_onto" || { echo "expected live backend for --onto-workflow"; echo "$out_onto"; exit 1; }
rp_onto="$(printf '%s\n' "$out_onto" | sed -n 's/^RENDERED_PLAN=//p' | sed -n '1p')"
[[ -f "$rp_onto" ]] || { echo "missing rendered onto-head plan"; echo "$out_onto"; exit 1; }
grep -q '^baseBranch: plan/fanout-upstream$' "$rp_onto"
wf_onto_base="$(printf '%s\n' "$out_onto" | awk -F'[= ]' '/^WF1=/{print $4; exit}')"
[[ "$wf_onto_base" == "plan/fanout-upstream" ]] || { echo "WF1 base should be fanout feature; got: $wf_onto_base"; echo "$out_onto"; exit 1; }

printf '[]' > "$SEED_STATE/workflows.json"
printf '[]' > "$SEED_STATE/tasks.json"
printf '3000' > "$SEED_STATE/seq"
jq -n \
  --arg id "wf-fanout-1" \
  --arg name "Fanout Upstream" \
  --arg base "master" \
  --arg feature "plan/fanout-upstream" \
  --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '[{id:$id,name:$name,status:"review_ready",baseBranch:$base,featureBranch:$feature,createdAt:$now}]' \
  > "$SEED_STATE/workflows.json"
jq -n --arg id "__merge__wf-fanout-1" '[{id:$id,status:"review_ready",config:{}}]' > "$SEED_STATE/tasks.json"

out_auto="$(
  cd "$TMP_DIR"
  RUN_SH_FORBIDDEN=1 ./scripts/submit-workflow-chain.sh ./plans/onto-head.yaml ./plans/onto-next.yaml
)"
grep -q '^BACKEND=live$' <<<"$out_auto" || { echo "expected live backend for auto-detected concrete externalDependency"; echo "$out_auto"; exit 1; }
rp_auto="$(printf '%s\n' "$out_auto" | sed -n 's/^RENDERED_PLAN=//p' | sed -n '1p')"
[[ -f "$rp_auto" ]] || { echo "missing auto-onto rendered plan"; echo "$out_auto"; exit 1; }
grep -q '^baseBranch: plan/fanout-upstream$' "$rp_auto"

echo "PASS: submit-workflow-chain enforces merge-gate deps, branch chaining, gate policy, --onto-workflow, and local/live backend isolation"
