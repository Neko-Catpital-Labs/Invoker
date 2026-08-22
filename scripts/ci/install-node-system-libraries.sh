#!/usr/bin/env bash
# Shared capability-checked apt-get installer for CI jobs that need Node
# native build tooling or Electron GUI libraries. Each caller configures the
# package set, the presence probe, and its own error text via env vars so
# every job keeps its existing failure text and package contract while
# sharing one root/passwordless-sudo/fallback decision tree.
set -euo pipefail

: "${CI_INSTALL_PACKAGES:?CI_INSTALL_PACKAGES is required}"

probe_soname="${CI_INSTALL_PROBE_SONAME:-}"
fallback_package="${CI_INSTALL_FALLBACK_PACKAGE:-}"
IFS=' ' read -r -a probe_commands <<< "${CI_INSTALL_PROBE_COMMANDS:-}"

has_library() {
  if [ -z "$probe_soname" ]; then
    return 0
  fi
  if command -v ldconfig >/dev/null 2>&1; then
    ldconfig -p 2>/dev/null | grep -q "${probe_soname//./\\.}"
    return
  fi
  find /lib /usr/lib -name "${probe_soname}*" -print -quit 2>/dev/null | grep -q .
}

missing_commands=()
for tool in "${probe_commands[@]:-}"; do
  if [ -n "$tool" ] && ! command -v "$tool" >/dev/null 2>&1; then
    missing_commands+=("$tool")
  fi
done

if has_library && [ "${#missing_commands[@]}" -eq 0 ]; then
  exit 0
fi

if [ -n "${CI_INSTALL_NO_APT_ERROR:-}" ] && ! command -v apt-get >/dev/null 2>&1; then
  echo "::error::${CI_INSTALL_NO_APT_ERROR}"
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  apt-get update
  # shellcheck disable=SC2086
  apt-get install -y $CI_INSTALL_PACKAGES
  exit 0
fi

if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n apt-get update
  # shellcheck disable=SC2086
  sudo -n apt-get install -y $CI_INSTALL_PACKAGES
  exit 0
fi

if [ -n "$fallback_package" ] && [ "${#missing_commands[@]}" -eq 0 ]; then
  fallback_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/node-runtime-system-deps.XXXXXX")"
  mkdir -p "$fallback_dir/apt-state/lists/partial" "$fallback_dir/apt-cache/archives/partial"
  (
    cd "$fallback_dir"
    apt_options=(
      -o "Dir::State=$fallback_dir/apt-state"
      -o "Dir::State::status=/var/lib/dpkg/status"
      -o "Dir::Cache=$fallback_dir/apt-cache"
    )
    apt-get "${apt_options[@]}" update
    apt-get "${apt_options[@]}" download "$fallback_package"
    dpkg-deb -x ./*.deb root
  )
  fallback_file="$(find "$fallback_dir/root" -type f -name "${probe_soname}*" -print -quit)"
  if [ -z "$fallback_file" ]; then
    echo "::error::Downloaded ${fallback_package} package did not contain ${probe_soname}."
    exit 1
  fi
  fallback_path="${fallback_file%/*}"
  echo "LD_LIBRARY_PATH=$fallback_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" >> "$GITHUB_ENV"
  exit 0
fi

message="${CI_INSTALL_SUDO_UNAVAILABLE_ERROR:-}"
if [ -n "$message" ]; then
  message="${message//\{\{MISSING\}\}/${missing_commands[*]:-}}"
  echo "::error::${message}"
fi
exit 1
