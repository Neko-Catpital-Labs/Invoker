# Botvillage

Live MOBA-style map of Invoker workers. Each worker kind is a hero; parallel jobs are illusions walking source → destination. Inspect-only (no start/stop from the map).

## Village tab (Invoker app)

1. Open Invoker.
2. Sidebar → **Village** (next to Workers).
3. Click a hero/illusion for a slim card (name, title, goal word, status chip).

The Workers list tab is unchanged. Map data comes from `getWorkers()` — the renderer never opens SQLite.

## Go island (Tailscale / laptop)

```bash
cd packages/botvillage
go test ./...
go run . --demo
# open http://localhost:8040
```

Live against your Invoker DB (read-only):

```bash
INVOKER_DB=$HOME/.invoker/invoker.db go run . --listen :8040
# optional: --remotes=mac-mini,gpu-box
```

Listens on `0.0.0.0:8040` so Tailscale peers can reach it. HTTP only.

### Tailscale

Reuse the existing node (`tailscale status`). After the server is up:

- `http://<hostname>.<tailnet>.ts.net:8040`
- `http://<100.x.x.x>:8040`

Mute with `M`. Preview night with `?hour=22`. Sound starts on first click.

## Behavior

| Signal | Map |
| --- | --- |
| Active worker action | Illusion walks source → dest |
| Several actions for one kind | N illusions |
| Quiet / long idle | Sit / Zzz (still visible) |
| Click | Slim overlay card |

Shopkeep player nametag `you` sits mid; not in the roster; not click-to-prompt.
