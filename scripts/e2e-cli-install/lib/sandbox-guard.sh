#!/usr/bin/env bash

invoker_sandbox_guard_fail() {
  echo "SANDBOX GUARD: $1" >&2
  echo "  refusing to run invoker-cli install; it would write to the real machine." >&2
  exit 78
}

invoker_sandbox_abs() {
  local raw="$1"
  [ -n "$raw" ] || return 1
  case "$raw" in
    /*) : ;;
    *) raw="$PWD/$raw" ;;
  esac
  if [ -d "$raw" ]; then
    (cd "$raw" 2>/dev/null && pwd) || return 1
    return 0
  fi
  local dir="$raw" tail="" base anchor
  while [ ! -d "$dir" ]; do
    base="$(basename "$dir")"
    tail="$base${tail:+/$tail}"
    local parent
    parent="$(dirname "$dir")"
    [ "$parent" != "$dir" ] || return 1
    dir="$parent"
  done
  anchor="$(cd "$dir" 2>/dev/null && pwd)" || return 1
  printf '%s/%s' "${anchor%/}" "$tail"
}

invoker_sandbox_assert_inside() {
  local label="$1" value="$2" root="$3" abs
  if [ -z "$value" ]; then
    invoker_sandbox_guard_fail "$label is unset — UNCHECKED, cannot prove it is redirected"
  fi
  if ! abs="$(invoker_sandbox_abs "$value")"; then
    invoker_sandbox_guard_fail "$label ($value) could not be resolved to an absolute path — UNCHECKED"
  fi
  case "$abs/" in
    "$root"/*) : ;;
    *) invoker_sandbox_guard_fail "$label resolves to $abs, which is outside the sandbox root $root" ;;
  esac
}

invoker_sandbox_assert_safe() {
  local sandbox_root real_home abs_home abs_real_home forbidden effective_prefix
  if ! sandbox_root="$(invoker_sandbox_abs "${1:-}")"; then
    invoker_sandbox_guard_fail "sandbox root '${1:-}' does not resolve — UNCHECKED"
  fi
  sandbox_root="${sandbox_root%/}"
  [ -d "$sandbox_root" ] || invoker_sandbox_guard_fail "sandbox root $sandbox_root is not a directory"

  real_home="${2:-}"
  [ -n "$real_home" ] || invoker_sandbox_guard_fail "real HOME was not captured — UNCHECKED"

  invoker_sandbox_assert_inside "HOME" "${HOME:-}" "$sandbox_root"
  invoker_sandbox_assert_inside "npm_config_prefix" "${npm_config_prefix:-}" "$sandbox_root"
  invoker_sandbox_assert_inside "INVOKER_DB_DIR" "${INVOKER_DB_DIR:-}" "$sandbox_root"
  invoker_sandbox_assert_inside "INVOKER_REPO_CONFIG_PATH" "${INVOKER_REPO_CONFIG_PATH:-}" "$sandbox_root"

  abs_home="$(invoker_sandbox_abs "$HOME")" || invoker_sandbox_guard_fail "HOME does not resolve — UNCHECKED"
  abs_real_home="$(invoker_sandbox_abs "$real_home" || printf '%s' "$real_home")"
  if [ "${abs_home%/}" = "${abs_real_home%/}" ]; then
    invoker_sandbox_guard_fail "HOME is still the real home directory ($abs_home)"
  fi

  local resolved
  for forbidden in brew apt-get sudo; do
    if resolved="$(command -v "$forbidden" 2>/dev/null)"; then
      invoker_sandbox_assert_inside "system package manager \`$forbidden\`" "$resolved" "$sandbox_root"
    fi
  done

  [ -n "${INVOKER_E2E_TRIPWIRE_LOG:-}" ] \
    || invoker_sandbox_guard_fail "INVOKER_E2E_TRIPWIRE_LOG is unset, so package-manager attempts would be UNCHECKED"
  invoker_sandbox_assert_inside "INVOKER_E2E_TRIPWIRE_LOG" "$INVOKER_E2E_TRIPWIRE_LOG" "$sandbox_root"

  if ! command -v npm >/dev/null 2>&1; then
    invoker_sandbox_guard_fail "npm is not on PATH, so the effective global prefix is UNCHECKED"
  fi
  if ! effective_prefix="$(npm prefix -g 2>/dev/null)" || [ -z "$effective_prefix" ]; then
    invoker_sandbox_guard_fail "\`npm prefix -g\` produced no output; effective global prefix is UNCHECKED"
  fi
  invoker_sandbox_assert_inside "effective npm global prefix" "$effective_prefix" "$sandbox_root"

  echo "==> sandbox guard: ok (root=$sandbox_root, npm -g prefix=$effective_prefix)"
}
