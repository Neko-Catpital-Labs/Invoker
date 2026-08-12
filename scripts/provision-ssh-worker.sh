#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
COMMAND="${1:-}"
shift || true

REPO_DIR="$(pwd -P)"
DRY_RUN=0
SKIP_SYSTEM_PACKAGES="${INVOKER_SKIP_SYSTEM_PACKAGES:-0}"
SKIP_AGENT_TOOLS="${INVOKER_SKIP_AGENT_TOOLS:-0}"
SKIP_SHELL_HOOKS="${INVOKER_SKIP_SHELL_HOOKS:-0}"
REPO_INSTALL_IGNORE_SCRIPTS="${INVOKER_REPO_INSTALL_IGNORE_SCRIPTS:-0}"
INVOKER_HOME="${INVOKER_HOME:-$HOME/.invoker}"
INVOKER_ENV_FILE="${INVOKER_ENV_FILE:-$INVOKER_HOME/env.sh}"
INVOKER_NODE_MAJOR="${INVOKER_NODE_MAJOR:-26}"
INVOKER_PNPM_VERSION="${INVOKER_PNPM_VERSION:-10.31.0}"
INVOKER_NODE_INSTALL_DIR="${INVOKER_NODE_INSTALL_DIR:-$HOME/.local/node-v$INVOKER_NODE_MAJOR}"
INVOKER_NPM_GLOBAL_PREFIX="${INVOKER_NPM_GLOBAL_PREFIX:-$HOME/.local/npm-global}"
INVOKER_AGENT_TOOLS="${INVOKER_AGENT_TOOLS:-codex,claude}"
INVOKER_GIT_USER_NAME="${INVOKER_GIT_USER_NAME:-Invoker}"
INVOKER_GIT_USER_EMAIL="${INVOKER_GIT_USER_EMAIL:-invoker@$(hostname -s 2>/dev/null || echo localhost)}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/provision-ssh-worker.sh bootstrap-host [options]
  bash scripts/provision-ssh-worker.sh ensure-repo-ready [options]
  bash scripts/provision-ssh-worker.sh print-provision-command

Commands:
  bootstrap-host         Install host tools, Node, pnpm, agent CLIs, git identity, and env hooks.
  ensure-repo-ready      Bootstrap the host if needed, then provision the current repo checkout.
  print-provision-command
                         Print the exact ~/.invoker/config.json provisionCommand snippet.

Options:
  --repo-dir <path>      Repo checkout to provision. Default: current directory.
  --dry-run              Print planned actions without mutating the machine.
  --skip-system-packages Skip apt/brew package installation.
  --skip-agent-tools     Skip codex/claude npm global installs.
  -h, --help             Show help.

Environment overrides:
  INVOKER_NODE_MAJOR            Node major version. Default: 26
  INVOKER_PNPM_VERSION         pnpm version. Default: 10.31.0
  INVOKER_AGENT_TOOLS          Comma-separated list. Default: codex,claude
  INVOKER_GIT_USER_NAME        Git committer name for managed worktrees.
  INVOKER_GIT_USER_EMAIL       Git committer email for managed worktrees.
  INVOKER_SKIP_SYSTEM_PACKAGES Skip apt/brew package installation when set to 1.
  INVOKER_SKIP_AGENT_TOOLS     Skip codex/claude npm global installs when set to 1.
  INVOKER_SKIP_SHELL_HOOKS     Skip login shell hook writes when set to 1.
  INVOKER_REPO_INSTALL_IGNORE_SCRIPTS
                                Run repo pnpm install with --ignore-scripts when set to 1.
  INVOKER_PROVISION_TRACE_FILE Optional file that receives one line per provision run.
EOF
}

trace_provision() {
  local trace_file="${INVOKER_PROVISION_TRACE_FILE:-}"
  [[ -n "$trace_file" ]] || return 0
  local line="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ append %q %q\n' "$trace_file" "$line"
    return 0
  fi
  mkdir -p "$(dirname "$trace_file")"
  printf '%s\n' "$line" >> "$trace_file"
}

log() {
  printf '[provision-ssh-worker] %s\n' "$*"
}

warn() {
  printf '[provision-ssh-worker] WARN: %s\n' "$*" >&2
}

die() {
  printf '[provision-ssh-worker] ERROR: %s\n' "$*" >&2
  exit 1
}

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

run_shell() {
  local command="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ bash -lc %q\n' "$command"
    return 0
  fi
  bash -lc "$command"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  command_exists "$1" || die "Missing required command: $1"
}

platform() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    *) die "Unsupported OS: $(uname -s)" ;;
  esac
}

machine_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) die "Unsupported architecture: $(uname -m)" ;;
  esac
}

sudo_prefix() {
  if [[ "$(id -u)" == "0" ]]; then
    return 0
  fi
  if ! command_exists sudo; then
    die "System package install needs sudo, but sudo is not installed."
  fi
  if ! sudo -n true >/dev/null 2>&1; then
    die "System package install needs passwordless sudo. Run bootstrap-host manually with sudo first."
  fi
  printf 'sudo -n '
}

write_file() {
  local path="$1"
  local content="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ write %q <<EOF\n%s\nEOF\n' "$path" "$content"
    return 0
  fi
  mkdir -p "$(dirname "$path")"
  printf '%s' "$content" > "$path"
}

append_once() {
  local file="$1"
  local marker="$2"
  local block="$3"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ ensure block %q in %q\n' "$marker" "$file"
    return 0
  fi
  mkdir -p "$(dirname "$file")"
  touch "$file"
  if grep -Fq "$marker" "$file"; then
    return 0
  fi
  printf '\n%s\n' "$block" >> "$file"
}

ensure_invoker_dirs() {
  run_cmd mkdir -p \
    "$INVOKER_HOME" \
    "$INVOKER_HOME/bin" \
    "$INVOKER_HOME/cache" \
    "$INVOKER_HOME/worktrees" \
    "$HOME/.local/bin" \
    "$INVOKER_NPM_GLOBAL_PREFIX/bin"
}

write_env_file() {
  local content
  content=$(cat <<EOF
export PATH="$INVOKER_NODE_INSTALL_DIR/bin:$INVOKER_NPM_GLOBAL_PREFIX/bin:$HOME/.local/bin:\$PATH"
export npm_config_prefix="$INVOKER_NPM_GLOBAL_PREFIX"
EOF
)
  write_file "$INVOKER_ENV_FILE" "$content"
  if [[ "$DRY_RUN" != "1" ]]; then
    chmod 600 "$INVOKER_ENV_FILE"
  fi
}

ensure_shell_hooks() {
  if [[ "$SKIP_SHELL_HOOKS" == "1" ]]; then
    log "Skipping shell hook installation."
    return 0
  fi
  local marker="# >>> invoker ssh worker env >>>"
  local block
  block=$(cat <<EOF
$marker
[ -f "$INVOKER_ENV_FILE" ] && . "$INVOKER_ENV_FILE"
# <<< invoker ssh worker env <<<
EOF
)
  append_once "$HOME/.bash_profile" "$marker" "$block"
  append_once "$HOME/.bash_login" "$marker" "$block"
  append_once "$HOME/.profile" "$marker" "$block"
  append_once "$HOME/.bashrc" "$marker" "$block"
}

source_env_file_now() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would source $INVOKER_ENV_FILE into the current shell."
    return 0
  fi
  # shellcheck disable=SC1090
  . "$INVOKER_ENV_FILE"
  export PATH
  export npm_config_prefix
}

install_linux_packages() {
  local sudo_cmd
  sudo_cmd="$(sudo_prefix)"
  local required=(ca-certificates curl git jq python3 make g++ unzip xz-utils openssh-client)
  run_shell "$sudo_cmd apt-get update"
  run_shell "$sudo_cmd apt-get install -y --no-install-recommends ${required[*]}"
  if ! command_exists gh; then
    if ! run_shell "$sudo_cmd apt-get install -y --no-install-recommends gh"; then
      warn "Failed to install gh via apt-get. Install it manually if tasks need GitHub CLI."
    fi
  fi
}

install_darwin_packages() {
  command_exists brew || die "Homebrew is required on macOS remote hosts."
  run_cmd brew install git jq python gh
}

ensure_system_packages() {
  if [[ "$SKIP_SYSTEM_PACKAGES" == "1" ]]; then
    log "Skipping system package installation."
    return 0
  fi
  if command_exists curl \
    && command_exists git \
    && command_exists jq \
    && command_exists python3 \
    && command_exists make \
    && command_exists g++ \
    && command_exists unzip \
    && command_exists ssh
  then
    return 0
  fi
  case "$(platform)" in
    linux) install_linux_packages ;;
    darwin) install_darwin_packages ;;
  esac
}

node_tarball_name() {
  local os arch
  os="$(platform)"
  arch="$(machine_arch)"
  local suffix
  case "$os" in
    linux) suffix="linux-$arch" ;;
    darwin) suffix="darwin-$arch" ;;
    *) die "Unsupported Node platform: $os" ;;
  esac
  local listing
  listing="$(curl -fsSL "https://nodejs.org/dist/latest-v${INVOKER_NODE_MAJOR}.x/SHASUMS256.txt")"
  local tarball
  tarball="$(printf '%s\n' "$listing" | awk '/node-v.*-'"$suffix"'\.tar\.xz$/ { print $2; exit }')"
  [[ -n "$tarball" ]] || die "Could not resolve latest Node ${INVOKER_NODE_MAJOR}.x tarball for $suffix."
  printf '%s' "$tarball"
}

node_major_matches() {
  if ! command_exists node; then
    return 1
  fi
  [[ "$(node -p 'process.versions.node.split(".")[0]')" == "$INVOKER_NODE_MAJOR" ]]
}

ensure_node() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would install or verify Node ${INVOKER_NODE_MAJOR}.x in $INVOKER_NODE_INSTALL_DIR."
    return 0
  fi
  if [[ -x "$INVOKER_NODE_INSTALL_DIR/bin/node" ]]; then
    PATH="$INVOKER_NODE_INSTALL_DIR/bin:$PATH"
    if node_major_matches; then
      log "Node already provisioned at $INVOKER_NODE_INSTALL_DIR."
      return 0
    fi
  fi
  require_command curl
  require_command tar
  local tarball url tmp_dir cleanup_cmd
  tarball="$(node_tarball_name)"
  url="https://nodejs.org/dist/latest-v${INVOKER_NODE_MAJOR}.x/$tarball"
  tmp_dir="$(mktemp -d)"
  printf -v cleanup_cmd 'rm -rf %q' "$tmp_dir"
  trap "$cleanup_cmd" RETURN
  log "Installing $tarball into $INVOKER_NODE_INSTALL_DIR"
  curl -fsSL "$url" -o "$tmp_dir/$tarball"
  rm -rf "$tmp_dir/node"
  mkdir -p "$tmp_dir/node"
  tar -xJf "$tmp_dir/$tarball" -C "$tmp_dir/node" --strip-components=1
  rm -rf "$INVOKER_NODE_INSTALL_DIR"
  mkdir -p "$(dirname "$INVOKER_NODE_INSTALL_DIR")"
  mv "$tmp_dir/node" "$INVOKER_NODE_INSTALL_DIR"
  PATH="$INVOKER_NODE_INSTALL_DIR/bin:$PATH"
}

ensure_pnpm() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would install pnpm@$INVOKER_PNPM_VERSION globally under $INVOKER_NPM_GLOBAL_PREFIX."
    return 0
  fi
  if command_exists pnpm && [[ "$(pnpm --version)" == "$INVOKER_PNPM_VERSION" ]]; then
    log "pnpm $INVOKER_PNPM_VERSION already installed."
    return 0
  fi
  npm install -g "pnpm@$INVOKER_PNPM_VERSION"
}

agent_package_for() {
  case "$1" in
    codex) printf '@openai/codex' ;;
    claude) printf '@anthropic-ai/claude-code' ;;
    cursor) die "Cursor CLI is not auto-installable here. Install Cursor, then enable the agent CLI." ;;
    omp) die "OMP CLI is not auto-installable here. Install omp manually on the host." ;;
    '') return 0 ;;
    *) die "Unsupported agent tool: $1" ;;
  esac
}

agent_command_for() {
  case "$1" in
    codex|claude|cursor|omp) printf '%s' "$1" ;;
    *) die "Unsupported agent tool: $1" ;;
  esac
}

ensure_agent_tools() {
  if [[ "$SKIP_AGENT_TOOLS" == "1" ]]; then
    log "Skipping agent CLI installation."
    return 0
  fi
  local tool trimmed package command
  IFS=',' read -r -a tool_list <<< "$INVOKER_AGENT_TOOLS"
  for tool in "${tool_list[@]}"; do
    trimmed="$(printf '%s' "$tool" | xargs)"
    [[ -n "$trimmed" ]] || continue
    package="$(agent_package_for "$trimmed")"
    command="$(agent_command_for "$trimmed")"
    if command_exists "$command"; then
      continue
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
      log "Would install $package for $command."
      continue
    fi
    npm install -g "$package"
  done
}

ensure_git_identity() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would ensure git identity $INVOKER_GIT_USER_NAME <$INVOKER_GIT_USER_EMAIL>."
    return 0
  fi
  if [[ -z "$(git config --global user.name 2>/dev/null || true)" ]]; then
    git config --global user.name "$INVOKER_GIT_USER_NAME"
  fi
  if [[ -z "$(git config --global user.email 2>/dev/null || true)" ]]; then
    git config --global user.email "$INVOKER_GIT_USER_EMAIL"
  fi
}

host_stamp_path() {
  printf '%s' "$INVOKER_HOME/host-provision-stamp"
}

host_stamp_value() {
  local script_hash
  script_hash="$(sha256_file "$REPO_DIR/scripts/provision-ssh-worker.sh")"
  printf 'node_major=%s\npnpm=%s\nagents=%s\nscript=%s\n' \
    "$INVOKER_NODE_MAJOR" \
    "$INVOKER_PNPM_VERSION" \
    "$INVOKER_AGENT_TOOLS" \
    "$script_hash"
}

host_has_required_commands() {
  command_exists git \
    && command_exists curl \
    && command_exists python3 \
    && command_exists jq \
    && command_exists make \
    && command_exists g++ \
    && command_exists unzip \
    && command_exists ssh \
    && command_exists pnpm \
    && command_exists node
}

host_has_required_agents() {
  local tool trimmed
  IFS=',' read -r -a tool_list <<< "$INVOKER_AGENT_TOOLS"
  for tool in "${tool_list[@]}"; do
    trimmed="$(printf '%s' "$tool" | xargs)"
    [[ -n "$trimmed" ]] || continue
    command_exists "$trimmed" || return 1
  done
  return 0
}

host_ready() {
  local stamp_path desired_stamp current_stamp=""
  stamp_path="$(host_stamp_path)"
  desired_stamp="$(host_stamp_value)"
  if [[ -f "$stamp_path" ]]; then
    current_stamp="$(cat "$stamp_path")"
  fi
  [[ "$current_stamp" == "$desired_stamp" ]] \
    && host_has_required_commands \
    && node_major_matches \
    && [[ "$(pnpm --version 2>/dev/null || true)" == "$INVOKER_PNPM_VERSION" ]] \
    && host_has_required_agents
}

write_host_stamp() {
  local stamp_path
  stamp_path="$(host_stamp_path)"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would update host provision stamp at $stamp_path."
    return 0
  fi
  mkdir -p "$(dirname "$stamp_path")"
  printf '%s' "$(host_stamp_value)" > "$stamp_path"
}

sha256_file() {
  python3 - "$1" <<'PY'
import hashlib, pathlib, sys
path = pathlib.Path(sys.argv[1])
print(hashlib.sha256(path.read_bytes()).hexdigest())
PY
}

repo_stamp_path() {
  printf '%s' "$REPO_DIR/node_modules/.invoker-ssh-provision-stamp"
}

repo_stamp_value() {
  local lock_hash script_hash node_version pnpm_version
  lock_hash="$(sha256_file "$REPO_DIR/pnpm-lock.yaml")"
  script_hash="$(sha256_file "$REPO_DIR/scripts/provision-ssh-worker.sh")"
  node_version="$(node --version)"
  pnpm_version="$(pnpm --version)"
  printf 'node=%s\npnpm=%s\nlock=%s\nscript=%s\nignore_scripts=%s\n' \
    "$node_version" \
    "$pnpm_version" \
    "$lock_hash" \
    "$script_hash" \
    "$REPO_INSTALL_IGNORE_SCRIPTS"
}

repo_install() {
  local args=(install --frozen-lockfile)
  if [[ "$REPO_INSTALL_IGNORE_SCRIPTS" == "1" ]]; then
    args+=(--ignore-scripts)
  fi
  (cd "$REPO_DIR" && pnpm "${args[@]}")
}

verify_repo_binaries() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would verify repo-local binaries after provisioning."
    return 0
  fi
  if [[ -d "$REPO_DIR/packages/ui" ]]; then
    pnpm --dir "$REPO_DIR/packages/ui" exec vite --version >/dev/null
  fi
  if [[ -d "$REPO_DIR/packages/app" ]]; then
    pnpm --dir "$REPO_DIR/packages/app" exec vitest --version >/dev/null
    if [[ "$REPO_INSTALL_IGNORE_SCRIPTS" != "1" ]]; then
      [[ -x "$REPO_DIR/packages/app/node_modules/.bin/electron" ]] || die "Electron binary missing after provisioning: packages/app/node_modules/.bin/electron"
    fi
  fi
}

ensure_repo_install() {
  [[ -f "$REPO_DIR/package.json" ]] || die "No package.json found at $REPO_DIR"
  [[ -f "$REPO_DIR/pnpm-lock.yaml" ]] || die "No pnpm-lock.yaml found at $REPO_DIR"
  local stamp_path desired_stamp current_stamp=""
  stamp_path="$(repo_stamp_path)"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would provision repo checkout at $REPO_DIR."
    return 0
  fi
  desired_stamp="$(repo_stamp_value)"
  if [[ -f "$stamp_path" ]]; then
    current_stamp="$(cat "$stamp_path")"
  fi
  if [[ ! -d "$REPO_DIR/node_modules" || "$current_stamp" != "$desired_stamp" ]]; then
    log "Installing repo dependencies in $REPO_DIR"
    repo_install
  fi
  verify_repo_binaries || {
    log "Repo verification failed; reinstalling dependencies."
    repo_install
    verify_repo_binaries
  }
  mkdir -p "$(dirname "$stamp_path")"
  printf '%s' "$desired_stamp" > "$stamp_path"
}

bootstrap_host() {
  ensure_invoker_dirs
  write_env_file
  ensure_shell_hooks
  source_env_file_now
  ensure_system_packages
  ensure_node
  source_env_file_now
  ensure_pnpm
  ensure_agent_tools
  ensure_git_identity
  write_host_stamp
}

ensure_host_ready() {
  ensure_invoker_dirs
  write_env_file
  ensure_shell_hooks
  source_env_file_now
  if [[ "$DRY_RUN" == "1" ]] || ! host_ready; then
    bootstrap_host
  fi
}

ensure_repo_ready() {
  ensure_host_ready
  source_env_file_now
  trace_provision "ensure-repo-ready repo=$REPO_DIR pwd=$(pwd -P)"
  ensure_repo_install
}

print_provision_command() {
  printf 'bash scripts/provision-ssh-worker.sh ensure-repo-ready && . "${INVOKER_ENV_FILE:-$HOME/.invoker/env.sh}"\n'
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --repo-dir)
      REPO_DIR="${2:?missing repo dir}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-system-packages)
      SKIP_SYSTEM_PACKAGES=1
      shift
      ;;
    --skip-agent-tools)
      SKIP_AGENT_TOOLS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown arg: $1"
      ;;
  esac
done

case "$COMMAND" in
  bootstrap-host)
    bootstrap_host
    ;;
  ensure-repo-ready)
    ensure_repo_ready
    ;;
  print-provision-command)
    print_provision_command
    ;;
  ''|-h|--help)
    usage
    ;;
  *)
    die "Unknown command: $COMMAND"
    ;;
esac
