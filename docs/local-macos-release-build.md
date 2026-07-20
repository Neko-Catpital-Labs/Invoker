# Local macOS Release Build

Use this when you want a fresh local desktop + Slack-manager build from `master`
before a tagged GitHub Release exists. This is mainly for maintainer testing and
handoff builds.

These commands assume Apple Silicon. For Intel Macs, pass `--arch x64`.

## Prerequisites

Install Xcode command line tools, Homebrew, Git, Node 26, and pnpm:

```bash
xcode-select --install

/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

brew update
brew install git node@26

echo 'export PATH="/opt/homebrew/opt/node@26/bin:$PATH"' >> ~/.zshrc
export PATH="/opt/homebrew/opt/node@26/bin:$PATH"

npm install -g pnpm@10.31.0 --prefix /opt/homebrew
pnpm --version
```

## One-shot cut (recommended)

From a clone of this repo:

```bash
bash scripts/local-macos-release-build.sh
# or, if master is already up to date:
bash scripts/local-macos-release-build.sh --skip-pull
```

That script:

1. Fast-forwards local `master` to `upstream/master` (or `origin/master`)
2. Runs `pnpm install --frozen-lockfile`
3. Builds the desktop DMG/zip (`dist:desktop:mac:arm64`)
4. Builds the standalone Slack SEA binary + tarball (`dist:slack`)
5. Copies commit-named artifacts into `local-builds/<short-sha>/` and prints checksums

## Manual steps (equivalent)

```bash
git checkout master
git pull --ff-only upstream master   # or origin

pnpm install
pnpm run dist:desktop:mac:arm64
pnpm run dist:slack
```

The build writes:

```text
release/Invoker-<version>-arm64.dmg
release/Invoker-<version>-arm64.zip
release/invoker-slack-<version>-darwin-arm64
release/invoker-slack-<version>-darwin-arm64.tar.gz
```

## Install A Local Unsigned Desktop Build

Local builds are not Apple-notarized. Remove quarantine attributes before opening the DMG:

```bash
SHA="$(git rev-parse --short HEAD)"
xattr -cr "local-builds/$SHA/Invoker-master-${SHA}-arm64.dmg"
open "local-builds/$SHA/Invoker-master-${SHA}-arm64.dmg"
```

Drag `Invoker.app` into `/Applications`, then remove quarantine attributes from the installed app:

```bash
xattr -cr /Applications/Invoker.app
open /Applications/Invoker.app
```

## Slack manager

Slack is a **separate** binary, not embedded in the desktop app.

Local cut:

```bash
SHA="$(git rev-parse --short HEAD)"
./local-builds/$SHA/invoker-slack-master-${SHA}-darwin-arm64 --version
```

Published (after a tagged GitHub Release):

```bash
npm install -g @neko-catpital-labs/invoker-slack
invoker-slack --version
```

Credentials: `~/.invoker/.slack-owner.env` (see `invoker-cli setup slack` and
[slack-native-workflows.md](slack-native-workflows.md)). Supervise with
`packages/slack-manager/deploy/install.sh`.

For a public release, prefer the tagged GitHub Release workflow so users get the standard release assets and checksums.
