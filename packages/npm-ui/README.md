# @neko-catpital-labs/invoker-ui

Installs a launcher for the Invoker desktop UI from the matching GitHub Release, plus the
standalone `invoker-cli` command (via a version-pinned dependency on
`@neko-catpital-labs/invoker-cli`).

```sh
npm install -g @neko-catpital-labs/invoker-ui
invoker-ui
invoker-cli --version
```

Note: `@neko-catpital-labs/invoker-cli` also exposes an `invoker-cli` bin. If you install both
packages globally, the bin names collide; that is harmless — both run the same version-pinned
binary.
