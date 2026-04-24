#!/usr/bin/env bash
set -euo pipefail

REPO="${INVOKER_RELEASE_REPO:-Neko-Catpital-Labs/Invoker}"
VERSION="latest"
METHOD="auto"
DEST_DIR=""

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://raw.githubusercontent.com/<repo>/master/scripts/install.sh | bash
       bash scripts/install.sh [--version <tag>] [--method auto|deb|appimage|dmg] [--dest <dir>] [--repo <owner/repo>]
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:?missing version}"
      shift 2
      ;;
    --method)
      METHOD="${2:?missing method}"
      shift 2
      ;;
    --dest)
      DEST_DIR="${2:?missing destination}"
      shift 2
      ;;
    --repo)
      REPO="${2:?missing repo}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd curl
need_cmd python3

OS="$(uname -s)"
ARCH="$(uname -m)"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

case "$OS" in
  Linux) PLATFORM="linux" ;;
  Darwin) PLATFORM="macos" ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

api_url="https://api.github.com/repos/$REPO/releases"
if [ "$VERSION" = "latest" ]; then
  api_url="$api_url/latest"
else
  api_url="$api_url/tags/$VERSION"
fi

release_json="$TMP_DIR/release.json"
curl -fsSL "$api_url" -o "$release_json"

case "$PLATFORM:$METHOD" in
  linux:auto)
    if command -v dpkg >/dev/null 2>&1; then
      selector=".deb"
      METHOD="deb"
    else
      selector=".AppImage"
      METHOD="appimage"
    fi
    ;;
  linux:deb) selector=".deb" ;;
  linux:appimage) selector=".AppImage" ;;
  macos:auto|macos:dmg)
    selector=".dmg"
    METHOD="dmg"
    ;;
  *)
    echo "Unsupported method '$METHOD' for $PLATFORM" >&2
    exit 64
    ;;
esac

asset_url="$(
  python3 - "$release_json" "$selector" "$ARCH" <<'PY'
import json, sys
path, ext, arch = sys.argv[1:]
assets = json.load(open(path)).get("assets", [])
arch_tokens = {
    "x86_64": ["x64", "amd64", "x86_64"],
    "aarch64": ["arm64", "aarch64"],
    "arm64": ["arm64", "aarch64"],
}.get(arch, [arch])

matches = []
for asset in assets:
    name = asset.get("name", "")
    if not name.endswith(ext):
        continue
    score = 0
    lower = name.lower()
    for token in arch_tokens:
      if token.lower() in lower:
        score += 2
    if ext == ".dmg":
      score += 1
    matches.append((score, asset.get("browser_download_url", "")))

matches.sort(reverse=True)
if not matches:
    raise SystemExit(1)
print(matches[0][1])
PY
)" || {
  echo "Could not find a release asset ending in $selector for $PLATFORM" >&2
  exit 1
}

asset_file="$TMP_DIR/$(basename "$asset_url")"
curl -fL "$asset_url" -o "$asset_file"

sha_url="$(
  python3 - "$release_json" <<'PY'
import json, sys
for asset in json.load(open(sys.argv[1])).get("assets", []):
    if asset.get("name") == "SHA256SUMS":
        print(asset.get("browser_download_url", ""))
        break
PY
)"

if [ -n "$sha_url" ]; then
  sha_file="$TMP_DIR/SHA256SUMS"
  curl -fsSL "$sha_url" -o "$sha_file"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$TMP_DIR" && sha256sum -c --ignore-missing "$sha_file")
  elif command -v shasum >/dev/null 2>&1; then
    expected="$(grep " $(basename "$asset_file")\$" "$sha_file" | awk '{print $1}')"
    actual="$(shasum -a 256 "$asset_file" | awk '{print $1}')"
    [ "$expected" = "$actual" ] || {
      echo "Checksum mismatch for $(basename "$asset_file")" >&2
      exit 1
    }
  fi
fi

case "$PLATFORM:$METHOD" in
  linux:deb)
    need_cmd sudo
    sudo dpkg -i "$asset_file" || sudo apt-get install -f -y
    echo "Installed Invoker from $(basename "$asset_file")"
    ;;
  linux:appimage)
    install_root="${DEST_DIR:-$HOME/.local/opt/invoker}"
    mkdir -p "$install_root" "$HOME/.local/bin"
    target="$install_root/Invoker.AppImage"
    cp "$asset_file" "$target"
    chmod +x "$target"
    cat > "$HOME/.local/bin/invoker" <<EOF
#!/usr/bin/env bash
exec "$target" "\$@"
EOF
    chmod +x "$HOME/.local/bin/invoker"
    echo "Installed Invoker AppImage to $target"
    echo "Launch with: $HOME/.local/bin/invoker"
    ;;
  macos:dmg)
    mount_dir="$TMP_DIR/mount"
    mkdir -p "$mount_dir"
    hdiutil attach "$asset_file" -mountpoint "$mount_dir" -nobrowse >/dev/null
    app_path="$(find "$mount_dir" -maxdepth 1 -type d -name '*.app' | head -1)"
    if [ -z "$app_path" ]; then
      echo "No .app found inside DMG" >&2
      hdiutil detach "$mount_dir" >/dev/null || true
      exit 1
    fi
    dest_root="${DEST_DIR:-/Applications}"
    cp -R "$app_path" "$dest_root/"
    hdiutil detach "$mount_dir" >/dev/null
    echo "Installed $(basename "$app_path") to $dest_root"
    ;;
esac
