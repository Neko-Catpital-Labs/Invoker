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
function strip_quotes(s) { gsub(/["'\''"]/, "", s); return s }
function parse_metadata(desc_lower,    tmp, parts) {
  layer = ""
  feature_state = ""
  layer_exception_allowed = 0
  has_acceptance_criteria = (desc_lower ~ /acceptance criteria:/)

  tmp = desc_lower
  sub(/^.*layer:[ \t]*/, "", tmp)
  if (tmp != desc_lower) {
    split(tmp, parts, /[^a-z0-9_]/)
    layer = parts[1]
  }

  tmp = desc_lower
  sub(/^.*feature state:[ \t]*/, "", tmp)
  if (tmp != desc_lower) {
    split(tmp, parts, /[^a-z0-9_]/)
    feature_state = parts[1]
  }

  if (desc_lower ~ /layer exception:[ \t]*allowed/) {
    layer_exception_allowed = 1
  }
}
function layer_rank(layer_name) {
  if (layer_name == "persistence") return 10
  if (layer_name == "domain") return 20
  if (layer_name == "transport") return 30
  if (layer_name == "api") return 40
  if (layer_name == "contact_surface") return 45
  if (layer_name == "app_bridge") return 50
  if (layer_name == "owner_delegation") return 60
  if (layer_name == "ui_activation") return 70
  if (layer_name == "app_regression") return 80
  if (layer_name == "e2e_regression") return 90
  if (layer_name == "ui") return 100
  if (layer_name == "docs") return 110
  return 0
}
function flush_task(    wc, and_count, valid_id, d, desc_lower, idx) {
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

  desc_lower = tolower(desc)
  parse_metadata(desc_lower)

  if (enforce_layering == 1) {
    if (layer == "") {
      errors[++errn] = "Task \"" id "\" missing required \"Layer:\" heading in description (implementation plans require layer metadata)"
    } else if (layer_rank(layer) == 0) {
      errors[++errn] = "Task \"" id "\" has invalid Layer \"" layer "\"; expected one of: persistence, domain, transport, api, contact_surface, app_bridge, owner_delegation, ui_activation, app_regression, e2e_regression, ui, docs"
    }

    if (feature_state == "") {
      errors[++errn] = "Task \"" id "\" missing required \"Feature state:\" heading in description (expected active or dormant)"
    } else if (feature_state != "active" && feature_state != "dormant") {
      errors[++errn] = "Task \"" id "\" has invalid Feature state \"" feature_state "\"; expected active or dormant"
    }

    if (feature_state == "dormant" && has_acceptance_criteria == 0) {
      errors[++errn] = "Task \"" id "\" uses Feature state dormant but omits \"Acceptance criteria:\" in description"
    }
  }

  if (warnDelegation == 1 && desc != "") {
    d = desc_lower
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

  idx = ++taskn
  task_ids[idx] = id
  task_layers[idx] = layer
  task_feature_states[idx] = feature_state
  task_layer_exceptions[idx] = layer_exception_allowed
  task_dependencies[idx] = dependencies_csv
  task_id_to_index[id] = idx
}

BEGIN {
  in_task = 0
  in_dep_block = 0
  in_description_block = 0
  in_prompt_block = 0
  errn = 0
  warnn = 0
  taskn = 0
  on_finish = "pull_request"
  enforce_layering = 1
}

{
  line = $0

  if (!in_task && line ~ /^[[:space:]]*onFinish:[[:space:]]*/) {
    on_finish = line
    sub(/^[[:space:]]*onFinish:[[:space:]]*/, "", on_finish)
    on_finish = trim(strip_quotes(on_finish))
    enforce_layering = (tolower(on_finish) != "none")
    next
  }

  if (in_description_block) {
    # Note: mawk does not support {6,} bounded quantifiers; use explicit 6 spaces + *
    if (line ~ /^[[:space:]][[:space:]][[:space:]][[:space:]][[:space:]][[:space:]]*[^[:space:]]/) {
      desc = desc "\n" trim(line)
      next
    }
    in_description_block = 0
  }

  if (in_dep_block) {
    # Note: mawk does not support {6,} bounded quantifiers; use explicit 6 spaces + *
    if (line ~ /^[[:space:]][[:space:]][[:space:]][[:space:]][[:space:]][[:space:]]*-[[:space:]]*[^[:space:]]/) {
      dep = line
      sub(/^[[:space:]][[:space:]][[:space:]][[:space:]][[:space:]][[:space:]]*-[[:space:]]*/, "", dep)
      dep = trim(strip_quotes(dep))
      if (dep != "") {
        if (dependencies_csv != "") dependencies_csv = dependencies_csv ","
        dependencies_csv = dependencies_csv dep
      }
      next
    }
    in_dep_block = 0
  }

  if (line ~ /^[[:space:]]*-[[:space:]]+id:[[:space:]]*/) {
    flush_task()
    in_task = 1
    in_dep_block = 0
    in_description_block = 0
    in_prompt_block = 0

    id = line
    sub(/^[[:space:]]*-[[:space:]]+id:[[:space:]]*/, "", id)
    id = trim(strip_quotes(id))

    desc = ""
    has_command = 0
    has_prompt = 0
    command_line = ""
    prompt_text = ""
    dependencies_csv = ""
    next
  }

  if (!in_task) next

  if (line ~ /^[[:space:]]+description:[[:space:]]*/) {
    desc = line
    sub(/^[[:space:]]+description:[[:space:]]*/, "", desc)
    desc = trim(strip_quotes(desc))
    if (desc == "|" || desc == ">") {
      desc = ""
      in_description_block = 1
    }
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

  if (line ~ /^[[:space:]]+dependencies:[[:space:]]*/) {
    dep_line = line
    sub(/^[[:space:]]+dependencies:[[:space:]]*/, "", dep_line)
    dep_line = trim(dep_line)

    if (dep_line == "" || dep_line == "|" || dep_line == ">") {
      in_dep_block = 1
    } else if (dep_line ~ /^\[[^]]*\]$/) {
      gsub(/^\[/, "", dep_line)
      gsub(/\]$/, "", dep_line)
      split(dep_line, dep_parts, /,/)
      for (k in dep_parts) {
        dep = trim(strip_quotes(dep_parts[k]))
        if (dep != "") {
          if (dependencies_csv != "") dependencies_csv = dependencies_csv ","
          dependencies_csv = dependencies_csv dep
        }
      }
    }
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
    # Note: mawk does not support {6,} bounded quantifiers; use explicit 6 spaces + *
    if (line ~ /^[[:space:]][[:space:]][[:space:]][[:space:]][[:space:]][[:space:]]*[^[:space:]]/) {
      prompt_text = prompt_text " " trim(line)
      next
    }
    in_prompt_block = 0
  }
}

END {
  flush_task()

  if (enforce_layering == 1) {
    for (idx = 1; idx <= taskn; idx++) {
      deps_csv = task_dependencies[idx]
      if (deps_csv == "") continue
      split(deps_csv, dep_ids, /,/)
      for (didx in dep_ids) {
        dep_id = trim(dep_ids[didx])
        if (dep_id == "") continue
        dep_index = task_id_to_index[dep_id]
        if (dep_index == 0) continue
        dep_layer = task_layers[dep_index]
        cur_layer = task_layers[idx]
        if (layer_rank(cur_layer) > 0 && layer_rank(dep_layer) > 0) {
          if (layer_rank(cur_layer) < layer_rank(dep_layer) && task_layer_exceptions[idx] != 1) {
            errors[++errn] = "Task \"" task_ids[idx] "\" layer ordering violation: lower layer \"" cur_layer "\" depends on higher layer \"" dep_layer "\" via dependency \"" dep_id "\" (add \"Layer exception: allowed\" with rationale to override)"
          }
        }
      }
    }
  }

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
