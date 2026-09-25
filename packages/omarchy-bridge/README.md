# @agent-fold/bridge

Localhost HTTP bridge that surfaces pending coding-agent questions and permissions
to the agent-fold Omarchy plugin.

This package embeds a thin slice of the T3 Code orchestration layer. It is *not* a
client of a separately running T3 Code server; it is the server.

## API

```ts
import { startBridgeServer } from "@agent-fold/bridge";

await startBridgeServer({
  dataDir: "/home/me/.local/share/agent-fold",
  port: 0, // 0 = pick a free port; written to dataDir/port.json
});
```

The server binds to `127.0.0.1` only. Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/pending` | Pending questions + permissions across all threads, grouped by thread. |
| `GET` | `/v1/stream` | SSE: emits deltas as the projection changes. |
| `POST` | `/v1/respond` | Dispatch a user response to an open question or permission request. |
| `GET` | `/healthz` | Liveness probe. |

The HTTP surface is the contract with the QML plugin; do not break it without a
versioned path (`/v2/...`).

## Status

v0 scaffold. The HTTP routes return `501 Not Implemented` and the package builds
but does not yet embed the projection pipeline.

See `docs/plan.md` in the repo root for the extraction plan.