# Local vs remote Invoker MCP

Harnesses talk to Invoker over **stdio MCP** (`invoker-cli mcp`). There is no HTTP MCP listener in this flow.

## Default

Leave the harness `invoker` MCP server as local:

```json
{ "type": "stdio", "command": "invoker-cli", "args": ["mcp"] }
```

(Codex uses the equivalent TOML `mcp_servers.invoker` entry.)

## Ask where it runs

Before the first prepare or submit in a session, ask which owner should run the work, unless the user already chose.

1. Read `remoteTargets` in `~/.invoker/config.json`. Each key that has a `host` is one remote owner. Use that key as the option label, and that entry's `user` and `host` as the SSH spec. Do not invent a host that is not in the file.
2. Ask one question with the harness question tool. Options are `Local (this machine)`, then one option per remote target. Do not mark more than one option recommended. Wait for the answer. Do not probe, rewrite MCP, or submit before it.
3. Local leaves the harness entry as local `invoker-cli mcp`.
4. A remote target follows Conversational remote below, using that entry's SSH spec.
5. Skip the question when the current turn names a host, IP, or SSH alias, or says local / this machine. Reuse that choice for later submits in the same session.
6. A self-triggered `auto_submit` with no named host stays on the local owner. Do not block that path on this question.

## Conversational remote

When the **current user turn** names a host, IP, or SSH alias as the Invoker owner:

1. Probe (must exit 0):

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 <spec> 'command -v invoker-cli'
```

2. On success only, rewrite the harness `invoker` MCP entry to:

```json
{
  "command": "ssh",
  "args": ["-o", "BatchMode=yes", "<spec>", "invoker-cli", "mcp"]
}
```

Paths: `~/.cursor/mcp.json`, `~/.claude.json` (`mcpServers`), `~/.omp/agent/mcp.json`, or `~/.codex/config.toml`.

3. On probe failure: **do not** change the local entry; report the SSH error and continue with local MCP or ask for another host.

4. “Local” / “this machine” restores the default local `invoker-cli mcp` entry.

## Hard rules

- Never invent HTTP/SSE MCP URLs for this path.
- Never clobber a working local MCP entry after a failed probe.
- Retarget only after the user picks a remote owner, or names a host, IP, or SSH alias in the current turn. Ambient config is not a choice.
