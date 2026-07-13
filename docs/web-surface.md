# Web surface (browser mirror of the desktop app)

Watch and drive a workflow from a browser — the same React UI the Electron app
renders, served over HTTP by the owner process (the one that owns workflow
writes: the desktop app, or a headless `--headless run|resume|slack` /
`owner-serve` process). This is how you reach a headless orchestrator running on
a remote box (e.g. the DigitalOcean host) that has no desktop UI.

## Enable it

The surface is **off** until a token is set. Set a long random secret via either:

- env: `INVOKER_WEB_TOKEN=…`
- config (`~/.invoker/config.json`): `"webToken": "…"`

Env always wins over config. Two more optional knobs:

| Setting | Env | Config | Default |
| --- | --- | --- | --- |
| Bind host | `INVOKER_WEB_HOST` | `webHost` | `127.0.0.1` |
| Bind port | `INVOKER_WEB_PORT` | `webPort` | `4200` |

Localhost (desktop app already running):

```
INVOKER_WEB_TOKEN=secret ./run.sh
# open http://127.0.0.1:4200/?token=secret
```

Remote / headless host (e.g. the DO box):

```
INVOKER_WEB_TOKEN=secret INVOKER_WEB_HOST=0.0.0.0 INVOKER_WEB_PORT=4200 \
  INVOKER_HEADLESS_STANDALONE=1 ./run.sh --headless run plan.yaml
# from your laptop: open http://<do-ip>:4200/?token=secret
```

## How auth works

`GET /?token=<t>` checks the token (constant-time), sets an `HttpOnly`,
`SameSite=Strict` cookie, and redirects to `/` so the secret leaves the URL.
Page and asset requests then require that cookie; `POST /invoke` and
`GET /events` accept the cookie or an `x-invoker-token` header. It is a single
shared secret per instance — there is no user-account system. Put it behind a
reverse proxy / TLS for anything beyond a trusted network, and prefer a tunnel
over binding `0.0.0.0` on an untrusted network.

## What works

Everything the desktop UI does, except local-only features:

- Live task graph updates (pushed over Server-Sent Events).
- Full control: approve / reject / retry / recreate / cancel / provide input /
  edit, via the same `WorkflowMutationFacade` the REST API uses.
- **Terminals are not available** over HTTP — the "open terminal" action reports
  that it is unsupported instead of failing.

## Transport

Request/response is `POST /invoke` (`{ channel, args }` → `{ ok, result | error }`);
push is one `EventSource` at `/events`. No WebSocket dependency — proxy- and
tunnel-friendly. The browser talks to the backend through a generated
`window.invoker` shim, so `packages/ui` is unchanged from the Electron build.

## Slack live status card

When a workflow has a mapped Slack channel (the `workflow-<id>` channels created
by the Slack-native flow), Invoker posts **one** status card to that channel and
edits it in place as tasks move: per-task status rows, counts, percent complete,
and the PR/review link. Updates are debounced (~2.5s) and flushed immediately
when the workflow reaches a terminal state. `@Invoker status` re-renders the same
card. No new Slack scopes are required.
