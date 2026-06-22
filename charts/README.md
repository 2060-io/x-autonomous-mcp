# x-autonomous-mcp Helm Chart

Deploys x-autonomous-mcp as an HTTP MCP server (via supergateway) on Kubernetes.

## Usage

```bash
helm install x-mcp ./charts \
  --set secret.X_API_KEY=your-key \
  --set secret.X_API_SECRET=your-secret \
  --set secret.X_ACCESS_TOKEN=your-token \
  --set secret.X_ACCESS_TOKEN_SECRET=your-token-secret \
  --set secret.X_BEARER_TOKEN=your-bearer-token
```

## State persistence

The server's safety rails — daily budget counters, engagement dedup history,
in-flight workflows, and the human-in-the-loop queue — are stored in a single
JSON state file. By default the chart provisions a `PersistentVolumeClaim` and
points `X_MCP_STATE_FILE` at it, so this state survives pod restarts.

Without persistence, a restart wipes the file and budgets reset to `0` (an agent
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

State is a per-pod file with no shared locking, so the chart supports a single
replica only. When persistence is enabled the Deployment uses the `Recreate`
strategy so a rolling update never runs two pods against the same RWO volume.

## From the agent

The MCP server is reachable at:

```
http://<release-name>-x-mcp:8000/sse        # SSE subscribe
http://<release-name>-x-mcp:8000/message     # POST messages
http://<release-name>-x-mcp:8000/healthz     # Health check
```
