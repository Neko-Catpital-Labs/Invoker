# Local vs remote Invoker MCP

Harnesses talk to Invoker over **stdio MCP** (`invoker-cli mcp`). There is no HTTP MCP listener in this flow.

## Default

Leave the harness `invoker` MCP server as local:

```json
{ "type": "stdio", "command": "invoker-cli", "args": ["mcp"] }
```

(Codex uses the equivalent TOML `mcp_servers.invoker` entry.)

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
- Retarget only from an explicit host/IP/alias in the current turn — not from ambient config alone.
