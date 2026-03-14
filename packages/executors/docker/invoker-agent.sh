#!/bin/bash
#
# Invoker Worker Agent
#
# This script runs inside Docker containers and handles the worker protocol:
# 1. Reads WorkRequest from /app/.invoker/request.json
# 2. Executes the action based on actionType
# 3. POSTs WorkResponse to the callback URL
#
# Supports action types:
# - command: Run a shell command
# - claude: Run Claude Code CLI with a prompt
# - reconciliation: Interactive reconciliation session
#

set -e

# Configuration
REQUEST_FILE="/app/.invoker/request.json"
LOG_FILE="/app/.invoker/agent.log"

# Logging helper
log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $1" | tee -a "$LOG_FILE"
}

# Error handler
error_exit() {
    local message="$1"
    local exit_code="${2:-1}"
    log "ERROR: $message"
    send_response "failed" "$exit_code" "$message"
    exit "$exit_code"
}

# Read and parse the request
read_request() {
    if [ ! -f "$REQUEST_FILE" ]; then
        error_exit "Request file not found: $REQUEST_FILE"
    fi

    log "Reading request from $REQUEST_FILE"
    REQUEST=$(cat "$REQUEST_FILE")

    # Parse fields using jq
    REQUEST_ID=$(echo "$REQUEST" | jq -r '.requestId')
    ACTION_ID=$(echo "$REQUEST" | jq -r '.actionId')
    ACTION_TYPE=$(echo "$REQUEST" | jq -r '.actionType')
    CALLBACK_URL=$(echo "$REQUEST" | jq -r '.callbackUrl')

    # Fall back to env var if callbackUrl is empty or null
    if [ -z "$CALLBACK_URL" ] || [ "$CALLBACK_URL" = "null" ]; then
        CALLBACK_URL="${INVOKER_CALLBACK_URL:-http://host.docker.internal:4000/api/worker/response}"
    fi

    # Parse inputs
    WORKSPACE_PATH=$(echo "$REQUEST" | jq -r '.inputs.workspacePath // "/app"')
    PROMPT=$(echo "$REQUEST" | jq -r '.inputs.prompt // empty')
    COMMAND=$(echo "$REQUEST" | jq -r '.inputs.command // empty')
    EXPERIMENT_BRANCHES=$(echo "$REQUEST" | jq -r '.inputs.experimentBranches // empty')

    log "Request ID: $REQUEST_ID"
    log "Action ID: $ACTION_ID"
    log "Action Type: $ACTION_TYPE"
    log "Callback URL: $CALLBACK_URL"
}

# Send response to callback URL
send_response() {
    local status="$1"
    local exit_code="${2:-0}"
    local error_message="$3"
    local summary="$4"
    local dag_mutation="$5"

    # Build outputs JSON
    local outputs="{\"exitCode\": $exit_code"
    if [ -n "$error_message" ]; then
        outputs="$outputs, \"error\": $(echo "$error_message" | jq -Rs .)"
    fi
    if [ -n "$summary" ]; then
        outputs="$outputs, \"summary\": $(echo "$summary" | jq -Rs .)"
    fi
    outputs="$outputs}"

    # Build response JSON
    local response="{
        \"requestId\": \"$REQUEST_ID\",
        \"actionId\": \"$ACTION_ID\",
        \"status\": \"$status\",
        \"outputs\": $outputs"

    if [ -n "$dag_mutation" ]; then
        response="$response, \"dagMutation\": $dag_mutation"
    fi

    response="$response}"

    log "Sending response: $status (exit_code=$exit_code)"
    log "Response payload: $response"

    # POST to callback URL
    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "$CALLBACK_URL" \
        -H "Content-Type: application/json" \
        -d "$response" \
        --connect-timeout 10 \
        --max-time 30 || echo "000")

    if [ "$http_code" = "200" ]; then
        log "Response sent successfully"
    else
        log "WARNING: Failed to send response (HTTP $http_code)"
    fi
}

# Build a structured commit message from request.json
build_commit_message() {
    local description
    description=$(echo "$REQUEST" | jq -r '.inputs.description // empty')

    local headline="invoker: ${ACTION_ID}"
    if [ -n "$description" ]; then
        headline="invoker: ${ACTION_ID} — ${description}"
    fi

    local msg="$headline"

    # Context section from upstream deps
    local upstream_count
    upstream_count=$(echo "$REQUEST" | jq -r '.inputs.upstreamContext // [] | length')
    if [ "$upstream_count" -gt 0 ]; then
        msg="$msg"$'\n\nContext:'
        local i=0
        while [ "$i" -lt "$upstream_count" ]; do
            local tid hash desc
            tid=$(echo "$REQUEST" | jq -r ".inputs.upstreamContext[$i].taskId")
            hash=$(echo "$REQUEST" | jq -r ".inputs.upstreamContext[$i].commitHash // empty")
            desc=$(echo "$REQUEST" | jq -r ".inputs.upstreamContext[$i].description")
            if [ -n "$hash" ]; then
                msg="$msg"$'\n'"  ${tid} (${hash:0:7}): ${desc}"
            else
                msg="$msg"$'\n'"  ${tid}: ${desc}"
            fi
            i=$((i + 1))
        done
    fi

    # Prompt or Command section
    if [ -n "$PROMPT" ]; then
        msg="$msg"$'\n\nPrompt:\n'"  $PROMPT"
    elif [ -n "$COMMAND" ]; then
        msg="$msg"$'\n\nCommand:\n'"  $COMMAND"
    fi

    # Solution section
    if [ -n "$description" ]; then
        msg="$msg"$'\n\nSolution:\n'"  $description"
    fi

    printf '%s' "$msg"
}

# Execute a command action
execute_command() {
    log "Executing command: $COMMAND"

    cd "$WORKSPACE_PATH"

    # Capture output and exit code
    local output
    local exit_code

    set +e
    output=$(bash -c "$COMMAND" 2>&1)
    exit_code=$?
    set -e

    # Auto-commit any changes
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        git add -A
        git diff --cached --quiet || git commit -m "$(build_commit_message)" --allow-empty-message 2>/dev/null || true
    fi

    log "Command exit code: $exit_code"

    if [ $exit_code -eq 0 ]; then
        send_response "completed" 0 "" "Command completed successfully"
    else
        send_response "failed" "$exit_code" "$output" ""
    fi

    return $exit_code
}

# Execute a Claude action
execute_claude() {
    log "Executing Claude prompt"

    cd "$WORKSPACE_PATH"

    # Escape the prompt for shell
    local escaped_prompt
    escaped_prompt=$(printf '%s' "$PROMPT" | sed "s/'/'\\\\''/g")

    # Run Claude Code CLI
    local output
    local exit_code

    set +e
    output=$(claude -p "$escaped_prompt" --dangerously-skip-permissions 2>&1)
    exit_code=$?
    set -e

    # Auto-commit any changes
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        git add -A
        git diff --cached --quiet || git commit -m "$(build_commit_message)" --allow-empty-message 2>/dev/null || true
    fi

    log "Claude exit code: $exit_code"

    # Check for action.json (Claude may have written a DAG mutation)
    if [ -f "/app/.invoker/action.json" ]; then
        local action
        action=$(cat /app/.invoker/action.json)
        local action_type
        action_type=$(echo "$action" | jq -r '.type // empty')

        if [ "$action_type" = "experiment" ]; then
            log "Claude requested experiments"
            local dag_mutation
            dag_mutation=$(echo "$action" | jq -c '{spawnExperiments: {description: .description, variants: .variants}}')
            send_response "spawn_experiments" 0 "" "" "$dag_mutation"
            rm -f /app/.invoker/action.json
            return 0
        elif [ "$action_type" = "select" ]; then
            log "Claude selected an experiment"
            local experiment_id
            experiment_id=$(echo "$action" | jq -r '.experimentId')
            local dag_mutation="{\"selectExperiment\": {\"experimentId\": \"$experiment_id\"}}"
            send_response "select_experiment" 0 "" "" "$dag_mutation"
            rm -f /app/.invoker/action.json
            return 0
        fi
    fi

    if [ $exit_code -eq 0 ]; then
        send_response "completed" 0 "" "Claude task completed"
    else
        send_response "failed" "$exit_code" "$output" ""
    fi

    return $exit_code
}

# Execute a reconciliation action
execute_reconciliation() {
    log "Starting reconciliation session"

    cd "$WORKSPACE_PATH"

    # Display available experiment branches
    log "Available experiment branches: $EXPERIMENT_BRANCHES"

    # Build context for Claude
    local branches_list
    branches_list=$(echo "$EXPERIMENT_BRANCHES" | jq -r '.[]' 2>/dev/null || echo "")

    if [ -n "$branches_list" ]; then
        echo "=== Reconciliation Mode ==="
        echo "Available experiment branches:"
        echo "$branches_list" | while read branch; do
            echo "  - $branch"
        done
        echo ""
        echo "Use git diff to compare branches, then write selection to /app/.invoker/action.json"
        echo ""
    fi

    # Check if there's already a decision
    if [ -f "/app/.invoker/action.json" ]; then
        local action
        action=$(cat /app/.invoker/action.json)
        local action_type
        action_type=$(echo "$action" | jq -r '.type // empty')

        if [ "$action_type" = "select" ]; then
            local experiment_id
            experiment_id=$(echo "$action" | jq -r '.experimentId')
            log "Pre-selected experiment: $experiment_id"
            local dag_mutation="{\"selectExperiment\": {\"experimentId\": \"$experiment_id\"}}"
            send_response "select_experiment" 0 "" "" "$dag_mutation"
            rm -f /app/.invoker/action.json
            return 0
        fi
    fi

    # Signal that input is needed
    send_response "needs_input" 0 "" "Reconciliation requires user selection"

    log "Reconciliation agent complete"

    return 0
}

# Main execution
main() {
    log "=== Invoker Agent Starting ==="

    # Read the request
    read_request

    # Execute based on action type
    case "$ACTION_TYPE" in
        command)
            execute_command
            ;;
        claude)
            execute_claude
            ;;
        reconciliation)
            execute_reconciliation
            ;;
        *)
            error_exit "Unknown action type: $ACTION_TYPE"
            ;;
    esac

    log "=== Invoker Agent Complete ==="
}

# Run main
main "$@"
