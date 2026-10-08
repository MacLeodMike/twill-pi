// Embedded-provider integration test (embed-provider Task 3, Review Focus
// #5) — the homelab one-install loop closed IN-PROCESS:
//
//   a REAL twill registry (store + createServer, ephemeral port)
// + a tmp git fixture (bare origin + seed commit)
// + a twill-pi config carrying a `provider` block (the real loadConfig
//   parse+validate path)
// + startEmbeddedProvider with the REAL startProvider (no injected fake)
// + a Workspace claim POSTed over HTTP through the substrate's own
//   RegistryClient (the envelope the `twill` CLI builds — claimedOn
//   derived from the parent document fetched over HTTP)
// → the provider fulfills (gitClone materializes on disk)
// → the child Workspace appears in the overlay (GET /Workspace/<child>)
// → ready:true on the status read surface
// → resolve(Workspace, <child>) returns the child route with the child path
//
// This proves what the unit tests cannot: the substrate, configured with a
// provider block, IS the registry client AND the provider in one install —
// no separate `twill provider` daemon.
//
// The registry harness mirrors the twill repo's own e2e harness
// (src/provider/e2e.test.ts): short poll interval (50 ms), generous
// timeouts (git is slow), commit signing disabled locally (this machine's
// global git config enforces it). The differences are the point: the
// provider runs in-process through the substrate seam, and the consumer
// side goes through the substrate's RegistryClient + consumerFromConfig —
// exactly the shape a kind package (twill-pi-workspace) drives.
//
// The registry imports reach through the `twill` file: dependency's
// symlinked path (node_modules/twill → the twill repo checkout) as direct
// file imports: the package's `exports` map exposes only `./provider`, and
// this test needs the registry's store + server too — real, in-process,
// the same modules a deployed registry runs.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import { start, type RegistryStore } from "../node_modules/twill/src/registry/store.js";
import { createServer } from "../node_modules/twill/src/registry/server.js";
import type { ProviderHandle } from "twill/provider";
import { consumerFromConfig, loadConfig } from "./config.js";
import { RegistryClient } from "./registry-client.js";
import { parseResolveResult } from "./resolve-types.js";
import { startEmbeddedProvider } from "./provider.js";

let server: Server;
let store: RegistryStore;
/** The tmp run root: documents/, the git fixture, the config file all live under it. */
let dir: string;
/** The registry's /twill/v1alpha1 base URL (ephemeral port). */
let registry: string;

/** The embedded provider's handle (stopped in afterAll; null until started). */
let provider: ProviderHandle | null = null;

/** The provider's lifecycle lines (onEvent → console.log, captured + silenced). */
let logLines: string[] = [];

/** Run git; reject (with stderr) on nonzero exit. */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", cwd, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(" ")}: ${stderr.trim() || error.message}`));
        return;
      }
      resolvePromise(stdout.toString());
    });
  });
}

/** A git fixture under `root`: bare origin + seed clone with one commit on main. */
async function gitFixture(root: string): Promise<string> {
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  await git(root, ["init", "--bare", origin]);
  await git(root, ["clone", "-q", origin, seed]);
  await git(seed, ["config", "user.email", "fixture@twill-pi"]);
  await git(seed, ["config", "user.name", "fixture"]);
  await git(seed, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(seed, "f.txt"), "v1\n");
  await git(seed, ["add", "."]);
  const when = new Date(1_700_000_000_000).toISOString();
  await git(seed, ["-c", `user.date=${when}`, "commit", "-qm", "c1"], { GIT_COMMITTER_DATE: when });
  await git(seed, ["push", "-q", "origin", "HEAD:main"]);
  return origin;
}

/** Poll `cond` until it holds or the deadline passes; true when it held. */
async function waitFor(
  cond: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await delay(intervalMs);
  }
  return false;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "twill-pi-embed-"));
  // An empty watched set is a valid document set (generation 1, current);
  // the parent lands in it from the test, then reload().
  const documentsDir = join(dir, "documents");
  mkdirSync(join(documentsDir, "Workspace"), { recursive: true });
  store = start(documentsDir);
  server = createServer(store);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  registry = `http://127.0.0.1:${port}/twill/v1alpha1`;

  // The provider's lifecycle events are captured via an injected onEvent
  // (the seam's default is a file logger — never stdout, which corrupts the
  // TUI). At a 50 ms poll this captures the fulfilled line without spamming.
  logLines = [];
}, 30_000);

afterAll(async () => {
  provider?.stop();
  server.closeIdleConnections();
  await new Promise<void>((done) => server.close(() => done()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

describe("startEmbeddedProvider — in-process end-to-end claim fulfillment (Review Focus #5)", () => {
  it(
    "claim over HTTP → embedded provider fulfills → child appears ready → resolve returns the child route",
    async () => {
      const parent = "embed-e2e-parent";
      const worktreeName = "wt-embed";
      const childName = `${parent}-${worktreeName}`;
      const claimName = "claim-embed-e2e";

      // The git fixture the claim's gitClone precondition materializes from.
      const origin = await gitFixture(dir);

      // The parent: a cold local workspace (nothing materialized yet) whose
      // route carries a gitClone precondition. ONE route object is the
      // single source shared by the parent document, the provider block,
      // and the claim — the provider's exact-match binding needs them
      // deep-equal, and JSON.stringify (JSON is YAML's strict subset)
      // round-trips it byte-identically into the parent document.
      const rootPath = join(dir, "root");
      const childPath = join(rootPath, ".twill", parent, worktreeName);
      const route = {
        match: { agentLocation: "workstation" },
        type: "local",
        path: rootPath,
        precondition: { steps: [{ type: "gitClone", url: origin, ref: "main" }] },
      };
      const parentDoc = {
        apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
        kind: "Workspace",
        metadata: { name: parent, labels: { "twill/workspace-class": "git" } },
        spec: {
          owner: "user:embed-e2e",
          routes: [route],
          workspace: {
            storageBacked: true,
            accessMode: "RWO",
            storage: { id: "ws_01J8Z4-embed-e2e", fingerprint: "vol-embed-e2e-01" },
            hostname: "workstation",
          },
        },
        status: {},
      };
      writeFileSync(join(dir, "documents", "Workspace", `${parent}.yaml`), JSON.stringify(parentDoc));
      store.reload();

      // The substrate config: a real loadConfig over a twill-pi.json
      // carrying the provider block (the real parse+validate path). The env
      // source is empty so the TWILL_REGISTRY override cannot redirect the
      // provider away from the ephemeral registry.
      const configPath = join(dir, "twill-pi.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          registry,
          agentLocation: "workstation",
          provider: { parents: [parent], routes: [route], pollIntervalMs: 50 },
        }),
      );
      const config = loadConfig({ configPath, env: {} });
      const client = new RegistryClient(config.registry);
      const consumer = consumerFromConfig(config);

      // The embedded provider: the REAL startProvider (the seam's default
      // start) with an injected onEvent capturing the lifecycle lines.
      provider = startEmbeddedProvider(config, undefined, (line) => {
        logLines.push(line);
      });
      expect(provider).not.toBeNull();

      // The claim, over HTTP through the substrate's own client: the full
      // envelope the `twill` CLI builds, with claimedOn (§8.4) derived from
      // the parent document fetched over HTTP — a consumer's real path.
      const fetched = (await client.getDoc("Workspace", parent)) as {
        spec?: { workspace?: { storage?: { id?: string; fingerprint?: string } } };
      };
      const storage = fetched.spec?.workspace?.storage ?? {};
      expect(storage.id).toBe("ws_01J8Z4-embed-e2e");
      const claimDoc = {
        apiVersion: "twill.bitwiseoperations.ca/v1alpha1",
        kind: "Claim",
        metadata: { name: claimName },
        spec: {
          owner: consumer.principal,
          routes: [],
          claim: {
            storageBacked: false,
            id: `cl_${Math.floor(Date.now() / 1000)}`,
            principal: consumer.principal,
            route,
            parameters: { worktreeName },
            claimedOn: { fingerprint: storage.fingerprint, durable_id: storage.id },
            released: false,
          },
          parent: { kind: "Workspace", name: parent },
        },
        status: {},
      };
      const created = (await client.createClaim(claimName, claimDoc)) as { metadata?: { name?: string } };
      expect(created.metadata?.name).toBe(claimName);

      // The provider fulfills: the child Workspace appears in the overlay.
      expect(
        await waitFor(async () => {
          try {
            await client.getDoc("Workspace", childName);
            return true;
          } catch {
            return false;
          }
        }, 30_000),
      ).toBe(true);

      // The child document's shape (the deterministic §5.3 rules): name and
      // storage id derive from (parent, worktreeName); the route is the
      // claim's route with the child path and NO precondition (already
      // materialized).
      const child = (await client.getDoc("Workspace", childName)) as {
        metadata?: { name?: string };
        spec?: {
          parent?: { kind?: string; name?: string };
          routes?: Array<Record<string, unknown>>;
          workspace?: { storage?: { id?: string; fingerprint?: string } };
        };
      };
      expect(child.metadata?.name).toBe(childName);
      expect(child.spec?.parent).toEqual({ kind: "Workspace", name: parent });
      expect(child.spec?.workspace?.storage?.id).toBe(`ws_01J8Z4-embed-e2e-${worktreeName}`);
      expect(child.spec?.workspace?.storage?.fingerprint).toBe("vol-embed-e2e-01");
      const childRoute = child.spec?.routes?.[0];
      expect(childRoute?.["type"]).toBe("local");
      expect(childRoute?.["match"]).toEqual({ agentLocation: "workstation" });
      expect(childRoute?.["path"]).toBe(childPath);
      expect(childRoute?.["precondition"]).toBeUndefined();

      // The materialization is real: the seed commit's file is on disk.
      expect(readFileSync(join(childPath, "f.txt"), "utf8")).toBe("v1\n");

      // ready:true lands on the status read surface — resolve through the
      // substrate's client + parser, with the substrate's consumer tuple.
      expect(
        await waitFor(async () => {
          const result = parseResolveResult(await client.resolve("Workspace", childName, consumer));
          return result.result === "Attached" && result.descriptor.status.ready;
        }, 30_000),
      ).toBe(true);

      // The loop closes: resolve(Workspace, <child>) returns the child
      // route — the materialized child path, precondition dropped.
      const resolved = parseResolveResult(await client.resolve("Workspace", childName, consumer));
      if (resolved.result !== "Attached") {
        throw new Error(`expected Attached, got ${resolved.result}`);
      }
      expect(resolved.descriptor.route["type"]).toBe("local");
      expect(resolved.descriptor.route["path"]).toBe(childPath);
      expect(resolved.descriptor.route["precondition"]).toBeUndefined();
      expect(resolved.descriptor.status.ready).toBe(true);

      // The provider reported the fulfillment through its lifecycle
      // observer (the seam wires onEvent → console.log).
      expect(
        logLines.some((line) =>
          line.includes(`claim ${claimName} fulfilled: child ${childName} ready at ${childPath}`),
        ),
      ).toBe(true);
    },
    90_000,
  );
});
