# x-autonomous-mcp Helm Chart

Deploys x-autonomous-mcp as a streamable HTTP MCP server on Kubernetes.

## Usage

One X account, from the credentials in the chart's Secret (the default):

```bash
helm install x-mcp ./charts \
  --set secret.X_API_KEY=your-key \
  --set secret.X_API_SECRET=your-secret \
  --set secret.X_ACCESS_TOKEN=your-token \
  --set secret.X_ACCESS_TOKEN_SECRET=your-token-secret \
  --set secret.X_BEARER_TOKEN=your-bearer-token
```

Many X accounts, one per MCP session, from the `X-Account` request header:

```bash
helm install x-mcp ./charts \
  --set accounts.fromHeader=true \
  --set networkPolicy.enabled=true \
  --set-string 'networkPolicy.ingressFrom.podSelector.matchLabels.app\.kubernetes\.io/name=ayni-agent'
```

In this mode each MCP client sends
`X-Account: <api_key>:<api_secret>:<access_token>:<access_token_secret>` on
every request of its session, and the server checks the keys with X when the
session opens. Leave `secret` empty: the server ignores the `X_API_*`
variables in this mode. See the main README, "Multi-account mode", for the
header format and the session rules.

## Values

| Value | Default | What it does |
|-------|---------|--------------|
| `accounts.fromHeader` | `false` | `true` sets `X_MCP_ACCOUNTS=header`: one X account per MCP session, from the `X-Account` header. `false` keeps one account from `secret`. |
| `accounts.sessionIdleSeconds` | `1800` | Header mode: close a session after this many seconds without a request, and drop its account's client with its last session. `0` = never. Sets `X_MCP_SESSION_IDLE_SECONDS`. |
| `networkPolicy.enabled` | `false` | Create a NetworkPolicy for the MCP pod (ingress only). |
| `networkPolicy.ingressFrom.podSelector` | `{}` | Label selector of the pods allowed to reach the MCP port, for example `{ matchLabels: { app.kubernetes.io/name: ayni-agent } }`. Empty: no pod may connect. |
| `networkPolicy.ingressFrom.namespaceSelector` | `{}` | Label selector of the namespaces those pods may be in. Empty: the release namespace only. |
| `persistence.enabled` | `true` | Keep state on a PersistentVolumeClaim (see below). |
| `persistence.mountPath` | `/data` | Where the volume is mounted. |
| `persistence.accessMode` | `ReadWriteOnce` | Access mode of the claim. |
| `persistence.size` | `1Gi` | Size of the claim. |
| `persistence.storageClass` | `""` | StorageClass; empty = cluster default. |
| `secret` | `{}` | Single-account credentials (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_BEARER_TOKEN`), stored in a Secret the chart manages. |
| `env` | budgets, TOON, compact, dedup | Extra environment variables. Budget limits, protected accounts, compact, dedup and TOON are global: the same for every account. |
| `image.repository` / `image.tag` | `io2060/x-autonomous-mcp` / chart version | Image. |
| `service.port` | `8000` | Port of the ClusterIP Service and the container. |

## Network access

The chart creates no Ingress: the Service is `ClusterIP`, reachable inside the
cluster only. With `networkPolicy.enabled`, the NetworkPolicy narrows that to
the pods matching `networkPolicy.ingressFrom.podSelector` (in the release
namespace, or in the namespaces matching `namespaceSelector`), on the MCP port
only. With no `podSelector` it admits nothing: an empty selector is never read
as "all pods". Egress is not restricted (the server needs DNS and `api.x.com`).
Kubelet health probes are not affected on most network plugins.

## State persistence

The server's safety rails — daily budget counters, engagement dedup history,
in-flight workflows, and the human-in-the-loop queue — are stored as JSON
state. By default the chart provisions a `PersistentVolumeClaim` so this state
survives pod restarts:

- single-account mode: one file, `X_MCP_STATE_FILE=<mountPath>/x-mcp-state.json`, as before;
- header mode: one file per X account, `<mountPath>/accounts/<user id>.json`
  (`X_MCP_STATE_DIR=<mountPath>`), each with its own budgets, dedup, workflows
  and queue.

Without persistence, a restart wipes the state and budgets reset to `0` (an agent
could exceed its daily limits) and dedup history is lost (re-engaging the same
tweets). Keep it enabled for any unattended deployment.

```yaml
persistence:
  enabled: true        # set false only for ephemeral/testing installs
  mountPath: /data
  accessMode: ReadWriteOnce
  size: 1Gi
  storageClass: ""    # empty = cluster default StorageClass
```

State is a per-pod file with no shared locking, and header-mode sessions live
in the pod's memory, so the chart supports a single replica only. When
persistence is enabled the Deployment uses the `Recreate` strategy so a rolling
update never runs two pods against the same RWO volume.

## From the agent

The MCP server is reachable at (the Service is named after `nameOverride`,
`x-mcp` by default):

```
http://x-mcp.<namespace>:8000/mcp        # streamable HTTP MCP endpoint
http://x-mcp.<namespace>:8000/healthz    # Health check
```
