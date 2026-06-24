# Local macOS Release Build

Use this when you want a fresh local desktop build from `master` before a tagged GitHub Release exists. This is mainly for maintainer testing and handoff builds.

These commands assume Apple Silicon. For Intel Macs, replace `arm64` with `x64`.

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

## Build From Current Master

```bash
mkdir -p ~/src
cd ~/src
git clone https://github.com/Neko-Catpital-Labs/Invoker.git
cd Invoker

git checkout master
git pull --ff-only origin master

pnpm install
pnpm run dist:desktop:mac:arm64
```

The build writes:

```text
release/Invoker-<version>-arm64.dmg
release/Invoker-<version>-arm64.zip
```

## Preserve A Commit-Named Copy

The package version may stay the same across several commits on `master`, so the generated filename can repeat. Preserve local builds under the commit SHA:

```bash
SHA="$(git rev-parse --short HEAD)"
VERSION="$(node -p "require('./packages/app/package.json').version")"
mkdir -p "local-builds/$SHA"

cp "release/Invoker-${VERSION}-arm64.dmg" "local-builds/$SHA/Invoker-master-${SHA}-arm64.dmg"
cp "release/Invoker-${VERSION}-arm64.zip" "local-builds/$SHA/Invoker-master-${SHA}-arm64.zip"
shasum -a 256 "local-builds/$SHA"/*
```

## Install A Local Unsigned Build

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

For a public release, prefer the tagged GitHub Release workflow so users get the standard release assets and checksums.
