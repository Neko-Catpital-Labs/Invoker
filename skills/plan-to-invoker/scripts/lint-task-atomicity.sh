#!/usr/bin/env bash
# Enforce atomic + detailed task quality constraints for Invoker plans.
# Usage: bash lint-task-atomicity.sh [--warn-delegation] [--strict-delegation] <plan.yaml>
#
# --warn-delegation  Print advisory warnings if task descriptions omit best-effort
#                    delegation headings (Files: / Change types: / Acceptance criteria:).
#                    Does not change exit code (still 0 if no hard errors). Optional.
# --strict-delegation  For implementation plans (onFinish != none), fail prompt tasks
#                    that are not self-contained for zero-context remote execution.
set -euo pipefail

warn_delegation=0
strict_delegation=0
while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --warn-delegation)
      warn_delegation=1
      shift
      ;;
    --strict-delegation)
      strict_delegation=1
      shift
      ;;
    *)
      break
      ;;
  esac
done

file="${1:?Usage: lint-task-atomicity.sh [--warn-delegation] [--strict-delegation] <plan.yaml>}"

if [[ ! -f "$file" ]]; then
  echo "ERROR: File not found: $file" >&2
  exit 1
fi

awk -v warnDelegation="$warn_delegation" -v strictDelegation="$strict_delegation" '
function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
function strip_quotes(s) { gsub(/["'\''"]/, "", s); return s }
function normalize_command(s) {
  s = trim(strip_quotes(s))
  gsub(/[ \t]+/, " ", s)
  return s
}
function first_experiment_artifact(s,    pattern) {
  if (match(s, /docs\/context\/[^ ,`"'\''\t]+\/experiment-brief\.md/)) {
    return substr(s, RSTART, RLENGTH)
  }
  return ""
}
function task_suffix(task_id, prefix,    n) {
  n = length(prefix)
  if (substr(task_id, 1, n) == prefix) {
    return substr(task_id, n + 1)
  }
  return ""
}
function csv_has(csv, needle,    parts, i, item) {
  if (csv == "" || needle == "") return 0
  split(csv, parts, /,/)
  for (i in parts) {
    item = trim(parts[i])
    if (item == needle) return 1
  }
  return 0
}
function parse_metadata(desc_lower,    tmp, parts) {
  layer = ""
  feature_state = ""
  layer_exception_allowed = 0
  has_acceptance_criteria = (desc_lower ~ /acceptance criteria:/)
  has_goal_heading = (desc_lower ~ /(^|\n)[ \t]*goal:/)
  has_motivation_heading = (desc_lower ~ /(^|\n)[ \t]*motivation:/)
  has_alternatives_heading = (desc_lower ~ /(^|\n)[ \t]*(alternative considerations|alternatives):/)
  has_implementation_heading = (desc_lower ~ /(^|\n)[ \t]*(implementation details|implementation):/)

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

    if (has_goal_heading == 0) {
      errors[++errn] = "Task \"" id "\" missing required \"Goal:\" section in description for implementation plans"
    }
    if (has_motivation_heading == 0) {
      errors[++errn] = "Task \"" id "\" missing required \"Motivation:\" section in description for implementation plans"
    }
    if (has_alternatives_heading == 0) {
      errors[++errn] = "Task \"" id "\" missing required \"Alternative considerations:\" (or \"Alternatives:\") section in description for implementation plans"
    }
    if (has_implementation_heading == 0) {
      errors[++errn] = "Task \"" id "\" missing required \"Implementation details:\" (or \"Implementation:\") section in description for implementation plans"
    }

    if (has_prompt) {
      prompt_lower = tolower(prompt_text)
      if (prompt_lower !~ /(^|[ \t])goal:/) {
        errors[++errn] = "Task \"" id "\" prompt missing required \"Goal:\" section for AI implementation tasks"
      }
      if (prompt_lower !~ /(^|[ \t])motivation:/) {
        errors[++errn] = "Task \"" id "\" prompt missing required \"Motivation:\" section for AI implementation tasks"
      }
      if (prompt_lower !~ /(^|[ \t])(alternative considerations|alternatives):/) {
        errors[++errn] = "Task \"" id "\" prompt missing required \"Alternative considerations:\" (or \"Alternatives:\") section for AI implementation tasks"
      }
      if (prompt_lower !~ /(^|[ \t])(implementation details|implementation):/) {
        errors[++errn] = "Task \"" id "\" prompt missing required \"Implementation details:\" (or \"Implementation:\") section for AI implementation tasks"
      }
      if (strictDelegation == 1) {
        if (desc_lower !~ /(^|\n)[ \t]*files:/) {
          errors[++errn] = "Task \"" id "\" prompt execution requires a \"Files:\" section in description for zero-context remote runners"
        }
        if (desc_lower !~ /(^|\n)[ \t]*change types:/) {
          errors[++errn] = "Task \"" id "\" prompt execution requires a \"Change types:\" section in description for zero-context remote runners"
        }
        if (desc_lower !~ /(^|\n)[ \t]*acceptance criteria:/) {
          errors[++errn] = "Task \"" id "\" prompt execution requires an \"Acceptance criteria:\" section in description for zero-context remote runners"
        }
        if (prompt_lower !~ /(assume no prior context|zero-context|zero context|no prior context)/) {
          errors[++errn] = "Task \"" id "\" prompt must state zero-context execution expectations (for example: assume no prior context)"
        }
        if (prompt_lower !~ /(exit code 0|exits 0|pass condition|expected output)/) {
          errors[++errn] = "Task \"" id "\" prompt must include deterministic pass/fail expectations (exit code 0, pass condition, or expected output)"
        }
      }
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
  task_has_command[idx] = has_command
  task_command_line[idx] = normalize_command(command_line)
  task_id_to_index[id] = idx

  artifact_path = first_experiment_artifact(desc " " prompt_text)
  task_artifact[idx] = artifact_path

  if (id ~ /^experiment-/ && has_prompt) {
    has_experiment_tasks = 1
    suffix = task_suffix(id, "experiment-")
    experiment_id_by_suffix[suffix] = id
    experiment_artifact_by_suffix[suffix] = artifact_path
    if (artifact_path == "") {
      errors[++errn] = "Task \"" id "\" must reference deterministic experiment artifact path (docs/context/<issue>/experiment-brief.md) in description/prompt"
    }
    if (tolower(prompt_text) !~ /commit/) {
      errors[++errn] = "Task \"" id "\" must require committing the experiment artifact in prompt text"
    }
  }

  if (id ~ /^implement-/) {
    suffix = task_suffix(id, "implement-")
    implement_id_by_suffix[suffix] = id
    implement_artifact_by_suffix[suffix] = artifact_path
  }

  if (id ~ /^cleanup-experiment-artifacts-/) {
    suffix = task_suffix(id, "cleanup-experiment-artifacts-")
    cleanup_id_by_suffix[suffix] = id
    cleanup_artifact_by_suffix[suffix] = artifact_path
    if (artifact_path == "") {
      errors[++errn] = "Task \"" id "\" must reference experiment artifact path (docs/context/<issue>/experiment-brief.md)"
    }
    if (tolower(command_line) !~ /git commit/) {
      errors[++errn] = "Task \"" id "\" cleanup command must create a cleanup commit"
    }
  }
}

BEGIN {
  in_task = 0
  in_dep_block = 0
  in_description_block = 0
  in_prompt_block = 0
  errn = 0
  warnn = 0
  taskn = 0
  has_experiment_tasks = 0
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

  if (enforce_layering == 1 && has_experiment_tasks == 1) {
    for (suffix in experiment_id_by_suffix) {
      experiment_id = experiment_id_by_suffix[suffix]
      experiment_artifact = experiment_artifact_by_suffix[suffix]
      implement_id = implement_id_by_suffix[suffix]
      implement_artifact = implement_artifact_by_suffix[suffix]
      cleanup_id = cleanup_id_by_suffix[suffix]
      cleanup_artifact = cleanup_artifact_by_suffix[suffix]

      if (implement_id == "") {
        errors[++errn] = "Task \"" experiment_id "\" requires matching implement task \"implement-" suffix "\" for experiment artifact handoff"
      } else if (implement_artifact == "") {
        errors[++errn] = "Task \"" implement_id "\" must reference experiment artifact path (docs/context/<issue>/experiment-brief.md) in description/prompt"
      } else if (experiment_artifact != "" && implement_artifact != "" && experiment_artifact != implement_artifact) {
        errors[++errn] = "Tasks \"" experiment_id "\" and \"" implement_id "\" must reference the same experiment artifact path"
      }

      if (cleanup_id == "") {
        errors[++errn] = "Task \"" experiment_id "\" requires cleanup task \"cleanup-experiment-artifacts-" suffix "\" before final regression gate"
      } else {
        cleanup_idx = task_id_to_index[cleanup_id]
        if (cleanup_idx > 0) {
          cleanup_deps = task_dependencies[cleanup_idx]
          if (!csv_has(cleanup_deps, experiment_id)) {
            errors[++errn] = "Task \"" cleanup_id "\" must depend on \"" experiment_id "\""
          }
          if (implement_id != "" && !csv_has(cleanup_deps, implement_id)) {
            errors[++errn] = "Task \"" cleanup_id "\" must depend on \"" implement_id "\""
          }
          if (experiment_artifact != "" && cleanup_artifact != "" && cleanup_artifact != experiment_artifact) {
            errors[++errn] = "Tasks \"" experiment_id "\" and \"" cleanup_id "\" must reference the same experiment artifact path"
          }
        }
      }
    }
  }

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

  if (enforce_layering == 1 && taskn > 0) {
    final_idx = taskn
    final_id = task_ids[final_idx]
    final_command = task_command_line[final_idx]

    if (task_has_command[final_idx] != 1) {
      errors[++errn] = "Task \"" final_id "\" must be a command task because implementation plans require a final pnpm run test:all regression gate"
    } else if (final_command != "pnpm run test:all") {
      errors[++errn] = "Task \"" final_id "\" must be the final regression gate and run exactly \"pnpm run test:all\""
    }

    split(task_dependencies[final_idx], final_dep_ids, /,/)
    delete final_dep_map
    for (fdidx in final_dep_ids) {
      dep_id = trim(final_dep_ids[fdidx])
      if (dep_id != "") {
        final_dep_map[dep_id] = 1
      }
    }

    for (idx = 1; idx < final_idx; idx++) {
      dep_id = task_ids[idx]
      if (final_dep_map[dep_id] != 1) {
        errors[++errn] = "Task \"" final_id "\" must depend on every earlier task; missing dependency on \"" dep_id "\""
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
