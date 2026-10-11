# Invoker CLI

Standalone headless Invoker runner.

```bash
invoker-cli run plans/fixtures/hello-world.yaml --db-dir /tmp/invoker-cli-smoke-db
```

`invoker-cli --help` prints grouped commands (execution, queries, management, workers, install/setup) and scoped options. Use `invoker-cli <command> --help` for command-specific flags; `invoker-cli uninstall --help` also documents exit codes and coverage.

The v1 archive distribution requires Node 26.
