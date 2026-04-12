#!/usr/bin/env bash
# Enforce atomic + detailed task quality constraints for Invoker plans.
# Usage: bash lint-task-atomicity.sh [--warn-delegation] <plan.yaml>
#
# --warn-delegation  Print advisory warnings if task descriptions omit best-effort
#                    delegation headings (Files: / Change types: / Acceptance criteria:).
#                    Does not change exit code (still 0 if no hard errors). Optional.
set -euo pipefail

warn_delegation=0
if [[ "${1:-}" == "--warn-delegation" ]]; then
  warn_delegation=1
  shift
fi

file="${1:?Usage: lint-task-atomicity.sh [--warn-delegation] <plan.yaml>}"

if [[ ! -f "$file" ]]; then
  echo "ERROR: File not found: $file" >&2
  exit 1
fi

awk -v warnDelegation="$warn_delegation" '
function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
function flush_task(    wc, and_count, valid_id, d) {
  if (!in_task) return

  if (id == "") {
    errors[++errn] = "Task without id detected"
  }

  valid_id = (id ~ /^[a-z0-9]+(-[a-z0-9]+)+$/)
  if (!valid_id) {
    warnings[++warnn] = "Task id \"" id "\" is not kebab-case; prefer descriptive kebab-case for new plans"
  }
  if (id ~ /^(task|step|todo|tmp|t)[-_]?[0-9]*$/) {
    errors[++errn] = "Task id \"" id "\" is too generic; use intent-based naming"
  }

  if (desc == "") {
    errors[++errn] = "Task \"" id "\" missing description"
  } else {
    wc = split(desc, words, /[ \t]+/)
    if (wc < 5) {
      errors[++errn] = "Task \"" id "\" description too short (<5 words); make it specific and outcome-oriented"
    }
  }

  if (has_command + has_prompt != 1) {
    errors[++errn] = "Task \"" id "\" must define exactly one of command or prompt"
  }

  if (has_command) {
    and_count = gsub(/&&/, "&&", command_line)
    if (and_count > 2) {
      errors[++errn] = "Task \"" id "\" command chains too many steps (>2 &&); split into atomic command tasks"
    }
    if (command_line ~ /(;|\|\|)/) {
      errors[++errn] = "Task \"" id "\" command appears multi-purpose (; or || found); split into atomic command tasks"
    }
  }

  if (has_prompt) {
    if (length(prompt_text) < 120) {
      errors[++errn] = "Task \"" id "\" prompt too short (<120 chars); include file paths + explicit acceptance criteria"
    }
    if (prompt_text !~ /(packages\/|scripts\/|docs\/|skills\/|\.ts|\.tsx|\.js|\.jsx|\.json|\.md|\.sh|\.yaml|\.yml)/) {
      errors[++errn] = "Task \"" id "\" prompt missing concrete file paths or file extensions"
    }
    if (tolower(prompt_text) !~ /(acceptance criteria|must|ensure|verify|expected|should)/) {
      errors[++errn] = "Task \"" id "\" prompt missing explicit acceptance language (must/ensure/verify/expected)"
    }
  }

  if (warnDelegation == 1 && desc != "") {
    d = tolower(desc)
    if (d !~ /files:/) {
      warnings[++warnn] = "Delegation hint: task \"" id "\" description has no \"Files:\" heading (optional; best-effort)"
    }
    if (d !~ /change types:/) {
      warnings[++warnn] = "Delegation hint: task \"" id "\" description has no \"Change types:\" heading (optional; best-effort)"
    }
    if (d !~ /acceptance criteria:/) {
      warnings[++warnn] = "Delegation hint: task \"" id "\" description has no \"Acceptance criteria:\" heading (optional; best-effort)"
    }
  }
}

BEGIN {
  in_task = 0
  in_prompt_block = 0
  errn = 0
  warnn = 0
}

{
  line = $0

  if (line ~ /^[[:space:]]*-[[:space:]]+id:[[:space:]]*/) {
    flush_task()
    in_task = 1
    in_prompt_block = 0

    id = line
    sub(/^[[:space:]]*-[[:space:]]+id:[[:space:]]*/, "", id)
    gsub(/["'\''"]/, "", id)
    id = trim(id)

    desc = ""
    has_command = 0
    has_prompt = 0
    command_line = ""
    prompt_text = ""
    next
  }

  if (!in_task) next

  if (line ~ /^[[:space:]]+description:[[:space:]]*/) {
    desc = line
    sub(/^[[:space:]]+description:[[:space:]]*/, "", desc)
    gsub(/["'\''"]/, "", desc)
    desc = trim(desc)
    next
  }

  if (line ~ /^[[:space:]]+command:[[:space:]]*/) {
    has_command = 1
    command_line = line
    sub(/^[[:space:]]+command:[[:space:]]*/, "", command_line)
    command_line = trim(command_line)
    in_prompt_block = 0
    next
  }

  if (line ~ /^[[:space:]]+prompt:[[:space:]]*/) {
    has_prompt = 1
    in_prompt_block = 1
    p = line
    sub(/^[[:space:]]+prompt:[[:space:]]*/, "", p)
    if (p != "|" && p != "") prompt_text = prompt_text " " p
    next
  }

  if (in_prompt_block) {
    # Note: mawk does not support {4,} bounded quantifiers; use explicit 4 spaces + *
    if (line ~ /^[[:space:]][[:space:]][[:space:]][[:space:]][[:space:]]*[^[:space:]]/) {
      prompt_text = prompt_text " " trim(line)
      next
    }
    in_prompt_block = 0
  }
}

END {
  flush_task()
  for (w = 1; w <= warnn; w++) {
    print "Atomicity lint warning: " warnings[w] > "/dev/stderr"
  }
  if (errn > 0) {
    print "Atomicity lint FAILED:" > "/dev/stderr"
    for (i = 1; i <= errn; i++) {
      print "  - " errors[i] > "/dev/stderr"
    }
    exit 1
  }
  print "Atomicity lint passed: " ARGV[1]
}
' "$file"
