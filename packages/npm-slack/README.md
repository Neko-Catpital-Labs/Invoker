# @neko-catpital-labs/invoker-slack

Installs the standalone `invoker-slack` binary from the matching GitHub Release and verifies it against `SHA256SUMS`.

The Slack manager is a separate always-on daemon (not part of the desktop app). It owns the Slack Socket Mode connection and drives Invoker over IPC.

```sh
npm install -g @neko-catpital-labs/invoker-slack
invoker-slack --version
```

Credentials live in `~/.invoker/.slack-owner.env` (see `invoker-cli setup slack` and `docs/slack-native-workflows.md`). Supervise with `packages/slack-manager/deploy/install.sh` or run `invoker-slack` under your own process manager.
