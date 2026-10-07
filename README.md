# twill-pi

The pi adapter for the [twill](https://github.com/example/twill) workspace fabric — a pi extension that resolves workspaces through a twill registry, attaches them as path-scoped capabilities, and claims cold workspaces through the claim-and-poll loop.

The extension is a pure HTTP consumer of the twill registry's v1alpha1 API (the same contract the `twill` CLI exercises); it imports nothing from the twill repo.

## Status

Under construction (T2b plan, task-by-task). The full README — install, config file shape, the three tools, the write guard's contract, the cold-workspace claim flow — lands with Task 5.

## Develop

```sh
npm install
npm test          # vitest, run outside pi against a canned registry
npx tsc --noEmit  # typecheck
```

## Config

`~/.pi/agent/twill-pi.json` (optional; missing file = defaults):

```json
{
  "registry": "http://localhost:8080/twill/v1alpha1",
  "agentLocation": "workstation",
  "claimTimeoutMs": 600000,
  "pollIntervalMs": 7000
}
```

`TWILL_REGISTRY` overrides the `registry` key (env wins).
