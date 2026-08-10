// The runnable single-binary deployment (P7): `skillonomia serve`.
//
// One process, modular internals (§2): the SQLite file, the migration runner,
// the §9.1 first-start bootstrap (owner + demo adopter + the seed package), the
// REST listener with `/mcp` mounted on it, and the §5.2 delivery worker on a
// timer. Everything it composes is already reviewed — this module adds no
// registry logic, only process wiring.
//
// It is the entry point of all three release packaging paths: the Docker image,
// a checkout run with Node, and the compiled Linux x86_64 binary.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { openMigrated, type Db } from "./db.ts";
import { Registry, FsBlobStore } from "./service.ts";
import { FsBootstrapStore } from "./auth.ts";
import { startServer } from "./http.ts";
import { FsSecretStore, runWorkerOnce, type WebhookTransport } from "./webhooks.ts";
import { defaultTransport } from "./transport.ts";
import { sweep, workerId } from "./delivery.ts";
import { installSeed, seedNotice, demoMode, type SeedResult } from "./seed.ts";
import { ACTIVATION_TARGETS, FixedActivationRoots, isActivationTarget, type ActivationRoots } from "./activation.ts";
import { FLEET_RUNTIMES, isFleetRuntime } from "./fleet.ts";
import { FixedInventoryRoots, type InventoryRoots } from "./fleet-scan.ts";

export { VERSION } from "./version.ts";
import { VERSION } from "./version.ts";
export const DEFAULT_PORT = 7431;

export interface ServeOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  /** ms between delivery-worker ticks; 0 disables the worker (tests) */
  workerIntervalMs?: number;
  transport?: WebhookTransport;
  /** where the seed package is read from (defaults to the shipped `seed/` dir) */
  seedDir?: string;
  /** false skips installing the §9.1 seed — a real deployment's choice */
  installSeedPackage?: boolean;
  /**
   * §6: where the fleet inventory may READ. Same rule as `activation` below and
   * for the same reason: reading a fleet member's own directory is an act on
   * somebody else's machine, so there is no default and nothing is derived.
   */
  inventory?: InventoryRoots;
  /**
   * §5.5: where native activation may write. Supplying this here OVERRIDES the
   * environment, which is what an embedding caller (and the test suite) wants;
   * leaving it out and setting neither variable means nothing is activated
   * anywhere, which is the shipped default.
   */
  activation?: ActivationRoots;
  log?: (line: string) => void;
}

export interface Instance {
  db: Db;
  registry: Registry;
  server: Server;
  port: number;
  /** present only on FIRST start — §9.1 prints them exactly once */
  credentials: ReturnType<Registry["bootstrap"]>;
  seed: SeedResult | null;
  /** run one delivery-worker tick by hand (the CI smoke and tests use this) */
  tick: (nowMs?: number) => Promise<void>;
  close: () => void;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** The SQLite file inside a data directory. One name, used by `serve` and by
 *  the `verify` / `verify-log` subcommands, so they cannot disagree about
 *  which database a deployment is. */
export const DB_FILENAME = "skillonomia.db";

/** §9.1: the outstanding bootstrap token's HASH — never the token itself. */
export const BOOTSTRAP_FILENAME = "bootstrap.json";

/** The data directory a bare invocation operates on: `SKILLONOMIA_DATA`, or
 *  `/data` (the volume the container image declares). */
export function defaultDataDir(): string {
  return env("SKILLONOMIA_DATA") ?? "/data";
}

/** The registry database a bare invocation operates on. */
export function defaultDbPath(): string {
  return join(defaultDataDir(), DB_FILENAME);
}

/** Open (or create) a deployment at `dataDir` and start serving. */
export function serve(opts: ServeOptions = {}): Instance {
  const log = opts.log ?? ((line: string) => console.log(line));
  const dataDir = opts.dataDir ?? defaultDataDir();
  const port = opts.port ?? Number(env("SKILLONOMIA_PORT") ?? DEFAULT_PORT);
  // The default is the LOOPBACK, and an external bind is an explicit decision.
  //
  // This process speaks plain HTTP and terminates no TLS. Two kinds of
  // credential cross that listener in the clear: the §9.1 bootstrap token,
  // printed once and exchangeable by whoever presents it, and every API key
  // afterwards, sent as a Bearer header on every call. A default of `0.0.0.0`
  // put that on every interface of the host for an operator who typed nothing
  // but `serve`. Widening the bind must be something somebody wrote down — the
  // `--host` flag or `SKILLONOMIA_HOST` — so it is visible in the command line
  // or the unit file that a reviewer reads. The container image sets the
  // variable itself (see the Dockerfile): inside a container the outward bind
  // is the point, and there it IS written down.
  const host = opts.host ?? env("SKILLONOMIA_HOST") ?? "127.0.0.1";
  // 0 means "ask the OS for an ephemeral port" — how the test suite binds
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port ${port}`);

  // §5.5: WHERE native activation may write, and the answer is NOWHERE unless an
  // operator wrote it down. Both variables must be set: a root with no target,
  // or a target with no root, activates nothing. Nothing is expanded — no `~`,
  // no `$HOME`, no relative form — because a root this process DERIVED would be
  // a place the operator did not choose, and writing into a runtime's own
  // directory is an action on somebody's machine.
  const activationRoot = opts.activation ? null : env("SKILLONOMIA_ACTIVATION_ROOT");
  const activationTarget = env("SKILLONOMIA_ACTIVATION_TARGET");
  let activation = opts.activation;
  if (activationRoot !== null && activationRoot !== undefined) {
    if (!isActivationTarget(activationTarget)) {
      throw new Error(
        `SKILLONOMIA_ACTIVATION_ROOT is set, so SKILLONOMIA_ACTIVATION_TARGET must be one of ${ACTIVATION_TARGETS.join("|")}`,
      );
    }
    activation = new FixedActivationRoots(activationRoot, activationTarget);
  } else if (activationTarget !== undefined && opts.activation === undefined) {
    throw new Error("SKILLONOMIA_ACTIVATION_TARGET is set without SKILLONOMIA_ACTIVATION_ROOT — a target names a layout, not a place");
  }

  // §6: WHERE the inventory may READ, and the answer is NOWHERE unless an
  // operator wrote it down. The pair behaves exactly like the activation pair
  // above — both set, or neither — because a root with no layout is a place
  // this process would have to guess the shape of, and a layout with no place
  // is a shape with nowhere to apply it.
  const inventoryRoot = opts.inventory ? null : env("SKILLONOMIA_INVENTORY_ROOT");
  const inventoryRuntime = env("SKILLONOMIA_INVENTORY_RUNTIME");
  let inventory = opts.inventory;
  if (inventoryRoot !== null && inventoryRoot !== undefined) {
    if (!isFleetRuntime(inventoryRuntime)) {
      throw new Error(
        `SKILLONOMIA_INVENTORY_ROOT is set, so SKILLONOMIA_INVENTORY_RUNTIME must be one of ${FLEET_RUNTIMES.join("|")}`,
      );
    }
    inventory = new FixedInventoryRoots(inventoryRoot, inventoryRuntime);
  } else if (inventoryRuntime !== undefined && opts.inventory === undefined) {
    throw new Error("SKILLONOMIA_INVENTORY_RUNTIME is set without SKILLONOMIA_INVENTORY_ROOT — a runtime names a layout, not a place");
  }

  mkdirSync(dataDir, { recursive: true });
  const db = openMigrated(join(dataDir, DB_FILENAME));
  const secrets = new FsSecretStore(join(dataDir, "secrets"));
  const registry = new Registry(db, {
    activation,
    inventory,
    blobs: new FsBlobStore(join(dataDir, "blobs")),
    secrets,
    // §9.1: the outstanding token's HASH, in the data directory. Without this a
    // restart between the first start and the exchange stranded the deployment
    // — the two principals were committed, so the token was never re-issued,
    // and nothing could mint the owner's key again.
    bootstrap: new FsBootstrapStore(join(dataDir, BOOTSTRAP_FILENAME)),
  });

  // §9.1: first start bootstraps and prints two one-time credentials. A
  // restart returns null and prints nothing — credentials are never re-issued.
  const credentials = registry.bootstrap();
  let seed: SeedResult | null = null;
  if (credentials && opts.installSeedPackage !== false) {
    seed = installSeed(registry, db, {
      workspaceId: credentials.workspace_id,
      ownerAgentId: credentials.owner_agent_id,
      nowMs: Date.now(),
      dir: opts.seedDir,
    });
  }

  const server = startServer(registry, port, host);
  // The real outbound transport, with the §5.2 address/redirect/timeout rules
  // (src/transport.ts). A deployment may supply its own; passing NullTransport
  // switches push delivery off, which is a choice, not a default.
  const transport = opts.transport ?? defaultTransport();
  const worker = workerId(Date.now());
  const tick = async (nowMs: number = Date.now()): Promise<void> => {
    sweep(db, nowMs);
    await runWorkerOnce(db, secrets, transport, worker, nowMs);
  };
  const intervalMs = opts.workerIntervalMs ?? Number(env("SKILLONOMIA_WORKER_MS") ?? 1000);
  // one tick at a time: the network makes a tick outlast its interval, and two
  // overlapping ticks would be two workers under one identity
  let ticking = false;
  const timer =
    intervalMs > 0
      ? setInterval(() => {
          if (ticking) return;
          ticking = true;
          tick()
            .catch((e) => log(`delivery worker tick failed: ${String((e as Error).message ?? e)}`))
            .finally(() => {
              ticking = false;
            });
        }, intervalMs)
      : null;
  timer?.unref?.();

  log(`skillonomia ${VERSION} listening on http://${host}:${port}  (data: ${dataDir})`);
  log(`health           : GET /health   (unauthenticated)`);
  // The one setting that lets this process write outside its own data
  // directory is printed on every start, set or not: an operator has to be able
  // to see it without reading the unit file.
  log(
    activation
      ? `native activation: ON — ${activationTarget ?? "configured by the embedding caller"} under the configured root. ` +
        `\`assignment.activate\` writes managed copies there and NOWHERE else.`
      : "native activation: off — no SKILLONOMIA_ACTIVATION_ROOT. Activations record `queued` and write no file.",
  );
  // The other setting that reaches outside this process's own data directory.
  // Reading is a smaller act than writing and it is still an act on somebody
  // else's machine, so it is printed on every start, set or not.
  log(
    inventory
      ? `fleet inventory  : ON — ${inventoryRuntime ?? "configured by the embedding caller"} layout under the configured root. ` +
        `\`agent.capabilities\` READS there and NOWHERE else, following symbolic links.`
      : "fleet inventory  : off — no SKILLONOMIA_INVENTORY_ROOT. Every inventory number is `unknown`, never zero.",
  );
  if (credentials) {
    log("");
    log("first start — these two one-time credentials are printed ONCE (SPEC §9.1):");
    log(`BOOTSTRAP_OWNER_TOKEN=${credentials.bootstrap_owner_token}`);
    log(`DEMO_ADOPTER_TOKEN=${credentials.demo_adopter_token}`);
    log("");
    if (seed) log(seedNotice(seed));
    if (demoMode(db)) {
      log("demo mode        : ON — one human principal (SPEC §9.1). It ends automatically");
      log("                   when a second human principal is created.");
    }
  } else if (registry.bootstrapOutstanding()) {
    // A restart before the exchange. The token is NOT reprinted — only its hash
    // was ever stored — but silence here would read as "you have missed your
    // chance", which was true before and is not any more.
    log("");
    log("BOOTSTRAP_OWNER_TOKEN is still outstanding: the token printed at first start");
    log("is still valid. Exchange it at POST /v1/auth/bootstrap. It cannot be reprinted —");
    log(`only its hash is stored (${join(dataDir, BOOTSTRAP_FILENAME)}); if it is lost, see`);
    log("docs/OPERATIONS.md > First start.");
  }

  return {
    db,
    registry,
    server,
    port,
    credentials,
    seed,
    tick,
    close: () => {
      if (timer) clearInterval(timer);
      server.close();
      db.close();
    },
  };
}

// The command line lives in src/cli-commands.ts: `serve` is one subcommand of
// several, and this module has no business knowing about `verify`.
