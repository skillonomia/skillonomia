# Operating a Skillonomia instance

Everything below is about running the registry. For what it *is*, start with the
README; for exact request shapes, see `API.md`.

## Platform

**The compiled binary is Linux x86_64.** `build:binary` targets
`bun-linux-x64`; there is no macOS and no Windows binary.

**`@skillonomia/cli` is qualified on Ubuntu x86_64 and macOS arm64.** What is
qualified there is the user contract in `.github/workflows/platform.yml` — clean
install, `version`, `serve`, `/health`, `demo` to a terminal `adopted` receipt
inside the 600-second budget, a restart on the same SQLite file, and the §4.1b
archive vectors — and not the full suite, which stays a Linux regression gate
under Node and Bun on a clean Ubuntu x86_64 runner. On macOS the path is
ordinary Node and npm: a global install of the published package, and no
container. The one behaviour known to depend on the host filesystem is §4.1b's
DIRECTORY reader (see README → Supported platforms); the archive form of the
same rule holds everywhere.

**The container image is qualified on Ubuntu x86_64, and on no other operating
system.**

**Windows x86_64 is DEFERRED BY OWNER**, for both artifacts. `qualify-windows`
and `windows-security` are present in `platform.yml`, unchanged, and neither has
produced a result that is claimed here.

**What has been observed so far.** `ci/mvp-release.mjs platform` reached
`PLATFORM_QUALIFICATION_OK` on Linux from a checkout; the macOS job is the same
contract on `macos-14` and has yet to report, and the intended macOS evidence is
a global install of the published package on a real machine, from the public
registry and outside any checkout. The macOS row above is therefore the contract
this project commits to, and this paragraph is how far it has been exercised.

Of the three container jobs, ONE runs and TWO are deferred:

| Job | State |
|---|---|
| `qualify-docker-linux` | in force — pulls the one published digest on `ubuntu-latest` and drives the quickstart through it |
| `qualify-docker-macos` | **DEFERRED BY OWNER** — Docker Desktop is not being installed on the macOS host; the job stays in the tree and is not run, and no macOS container result exists |
| `qualify-docker-windows` | **DEFERRED BY OWNER** — same decision; the job stays in the tree and is not run, and no Windows container result exists |

All three take ONE published digest and need a REAL Docker runtime, which for
the two deferred ones would be Docker Desktop in LINUX-CONTAINER mode.
`ci/mvp-release.mjs ghcr --expect-host` refuses to run anywhere else, so a job
pointed at a runner without such a daemon fails rather than reporting a platform
it was not on. That mechanism is unchanged; what is deferred is the claim, not
the code.

This is separate from what a skill package declares in `runtime.os`. A package
may target `macos` or `windows` and be adopted from one; §4.2 compatibility is
evaluated against the adopter's declared environment, not against the machine
the registry runs on. On a Windows host the built-in seed package's
`os: [linux, macos]` would be genuinely unmet, `skillonomia demo` would report
the §4.2 `mismatch`, and at `risk_level: low` that is a warning and not a block —
written in the conditional because Windows is deferred and unobserved.

## The release binary

A release tagged after `v0.1.0` carries two files:
`skillonomia-linux-x86_64.tar.gz` and `SHA256SUMS`. Verify the archive before
unpacking it, and keep the runtime data with the executable:

```bash
sha256sum -c SHA256SUMS
mkdir -p /opt/skillonomia && tar -xzf skillonomia-linux-x86_64.tar.gz -C /opt/skillonomia
/opt/skillonomia/skillonomia version
SKILLONOMIA_DATA=/var/lib/skillonomia /opt/skillonomia/skillonomia serve
```

The archive holds `skillonomia`, `migrations/`, `schema/`, `seed/` and
`LICENSE`. The three data directories are the assets the server opens a database
and installs the seed package with; moving the executable away from them needs
`SKILLONOMIA_ASSETS` pointed at wherever they went, or the start fails loudly.
Nothing else is required — no checkout, no Node, no Bun: `ci/mvp-release.mjs`
unpacks the archive into a directory outside this repository and starts it
there, which is the whole of what a release asset has to do.

**Where the file comes from.** `.github/workflows/candidate.yml` packages the
same archive on a candidate commit and uploads it as a workflow artifact for
review; it publishes nothing. `.github/workflows/release.yml` is the only file
that publishes, it runs only on a new version tag, and it refuses `v0.1.0` —
that release went out as source and is not amended. After publishing it
downloads what it just published and runs it:

```bash
node ci/mvp-release.mjs binary --tag <tag>
```

which fetches the two assets from the release, verifies the checksum, unpacks
the archive outside any checkout and drives `version`, `serve` and `/health`
against what was unpacked. **Terminal state:** exit 0 with `RELEASE_BINARY_OK`
as the last line. The rehearsal before a tag exists is
`node ci/mvp-release.mjs binary --local`: the same packaging and the same smoke,
on the archive built here, printing `RELEASE_BINARY_STAGED_OK` instead —
a different marker because nothing was downloaded from a release.

## Layout of a deployment

One process, one SQLite file, one data directory:

```
<data>/skillonomia.db      the registry (WAL mode)
<data>/blobs/              package archives, addressed by content hash
<data>/secrets/            webhook signing secrets, one file per endpoint, 0600
<data>/bootstrap.json      sha256 of the outstanding §9.1 token, 0600; removed
                           when the token is exchanged. Never the token itself.
```

The code and its runtime assets (`migrations/`, `schema/`, `seed/`) are
read-only and live with the binary or the source tree. `SKILLONOMIA_ASSETS`
overrides where they are looked for; if it is set and wrong, startup fails
loudly rather than continuing with an empty registry.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SKILLONOMIA_DATA` | the platform default below | data directory (created if missing) |
| `SKILLONOMIA_PORT` | `7431` | listener port (`0` asks the OS for one) |
| `SKILLONOMIA_HOST` | `127.0.0.1` | bind address — see **The network boundary** |
| `SKILLONOMIA_WORKER_MS` | `1000` | delivery-worker interval; `0` disables it |
| `SKILLONOMIA_ASSETS` | — | explicit asset root |
| `SKILLONOMIA_ACTIVATION_ROOT` | — | where native activation may write — see **Native activation** |
| `SKILLONOMIA_ACTIVATION_TARGET` | — | which runtime layout to write under that root |
| `SKILLONOMIA_INVENTORY_ROOT` | — | where the fleet inventory may read — see **The fleet inventory** |
| `SKILLONOMIA_INVENTORY_RUNTIME` | — | which runtime layout to read under that root |

### The data directory, per platform

`SKILLONOMIA_DATA` beats every default, and `serve --data DIR` beats that. With
neither given, one definition (`src/platform.ts`) answers for every subcommand:

| Platform | Default |
|---|---|
| macOS | `~/Library/Application Support/Skillonomia` |
| Windows | `%LOCALAPPDATA%\Skillonomia` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/skillonomia` |
| In the container | `/data` — the image sets `SKILLONOMIA_DATA` itself |

Linux uses `XDG_STATE_HOME` rather than a cache or config location: a cache may
be deleted at any moment and this database may not. A host where no home
directory can be found is REFUSED with a message naming `SKILLONOMIA_DATA`
rather than served from a guessed path — the first start writes two one-time
credentials into that directory.

**On Windows the ACL is the protection.** The bootstrap file
(`bootstrap.json`) and the webhook secret store are written with POSIX mode
`0600`, which NTFS ignores; what actually keeps them private is the ACL they
inherit from `%LOCALAPPDATA%`, which grants the owning account and not the
`Users` group. `ci/windows-security.ps1` checks that live — it reads the ACL AND
tries the read as a second local account, and fails closed if either the ACL
names an all-users group or the probe could not be run at all. Moving the data
directory somewhere with a looser ACL (a shared drive, `C:\ProgramData`) moves
the secrets there too.

## Native activation

`assignment.activate` materializes a managed copy of a skill in a runtime's own
native location. **Both variables above are unset by default, and with either of
them unset the registry activates nothing**: an activation records `queued`,
writes no file anywhere, and says so in its answer. That is the shipped
behaviour and it is deliberate — writing into somebody's runtime directory is an
action on their machine, and it happens only because an operator wrote these two
variables down.

`SKILLONOMIA_ACTIVATION_ROOT` must be an ABSOLUTE path to an existing directory.
Nothing is expanded: there is no `~`, no `$HOME`, no relative form. The registry
writes only under that root — it resolves every component of a native location
through symbolic links and refuses the activation outright if any of them lands
outside — so the root is the whole of the blast radius, and pointing it at a
scratch directory first is how you see what it would do.

`SKILLONOMIA_ACTIVATION_TARGET` picks the layout written under the root:

| Value | Written at |
|---|---|
| `claude_code_personal` | `<root>/.claude/skills/<name>/` — point the root at the user's home |
| `claude_code_project` | `<root>/.claude/skills/<name>/` — point the root at the project |
| `claude_code_plugin` | `<root>/skills/<name>/` — point the root at the plugin |
| `codex` | `<root>/.agents/skills/<name>/` |

The two Claude Code scopes have the same layout and differ only in which
directory you make the root.

**What activation does not do.** Recording `active` means the registry wrote the
copy and read it back from the native location. It is Skillonomia's intent and is
labelled as one; it is not a report that any agent ran anything. Every row shows
the observed arrival in a separate column, and that column stays `unknown` until
a runtime record carrying the version's arrival marker exists. Likewise
`assignment.revoke` removes the file and no more: an agent that has already
loaded the skill keeps those instructions until its session ends, and the answer
says so.

## The fleet inventory

`agent.capabilities` and `capability.get` walk an agent's own directories to
answer which skills, plugins and MCP servers are REGISTERED there. **Both
variables above are unset by default, and with either of them unset the registry
walks nothing**: every inventory number comes back `unknown` with the reason
`no_inventory_root_configured` — never a count of zero, because a directory
nobody looked at and a directory with nothing in it are different facts.

`SKILLONOMIA_INVENTORY_ROOT` must be an ABSOLUTE path to an existing directory,
and nothing is expanded — no `~`, no `$HOME`, no relative form. Reading is a
smaller act than writing and it is still an act on somebody else's machine, so
it happens only because an operator wrote these two variables down.

`SKILLONOMIA_INVENTORY_RUNTIME` picks the layout read under the root:

| Value | Read at |
|---|---|
| `claude_code` | `<root>/.claude/skills/<name>/SKILL.md`, `<root>/.claude/plugins/<name>/`, and `mcpServers` declared in `<root>/.mcp.json` or `<root>/.claude/settings.json` |
| `codex` | `<root>/.agents/skills/<name>/SKILL.md` |

**The walk FOLLOWS SYMBOLIC LINKS.** Handing a fleet one shared skill library by
linking a directory at it is the ordinary arrangement, and a walk that stopped at
the link would report a systematically low number with nothing to show that it
had. Cycles end the walk rather than the process.

**What the inventory does not do.** It counts what is THERE, not what this
registry put there, and only for the kinds a directory listing can establish. MCP
*tools* are what a server offers once something connects to it, and connectors
are not a filesystem concept at all: both come back `unknown` with their own
reason, and no amount of walking turns either into a zero. What is registered is
also not what has RUN — the arrival columns beside it stay `unknown` until a
runtime record carrying a version's arrival marker exists.

## The network boundary

**The listener MUST NOT be reached over plain HTTP from another host.** This is
a boundary of the deployment, not a recommendation: the registry serves HTTP
and terminates no TLS, and the traffic crossing it is credential traffic. The
§9.1 `BOOTSTRAP_OWNER_TOKEN` is exchanged over it — whoever presents that token
receives the owner's API key — and every authenticated call afterwards carries
an API key in a `Bearer` header. On the wire, in the clear, both are simply
readable. Neither may be carried by plain HTTP over a network.

Consequently:

- The default bind address is `127.0.0.1`. A bare `skillonomia serve` is
  reachable from this host and from nowhere else.
- The default never widens by itself. An external bind happens only when an
  operator writes it down — `--host <addr>` on the command line, or
  `SKILLONOMIA_HOST=<addr>` in the environment — so the decision is visible in
  the unit file, the compose file or the shell history that a reviewer reads.
- The supported way to serve another host is a **TLS-terminating reverse
  proxy** (nginx, Caddy, a cloud load balancer) in front of the registry, with
  the registry itself still on the loopback or on an interface only the proxy
  can reach. The proxy holds the certificate; the registry holds none.
- `SKILLONOMIA_HOST=0.0.0.0` with no such proxy in front is not a supported
  deployment. It publishes the bootstrap token and every API key to whatever
  network the host is attached to.

If the bootstrap token or an API key has crossed a network in the clear, treat
it as disclosed: revoke the key (§6.1) and, for the bootstrap token, follow
**First start** below.

### The container: two decisions, and only one of them is the image's

Inside a container, *where the process listens* and *where the port is
published* are two different questions. Answering them as one is how a loopback
default gets undone by a copy-pasted command: the software binds safely, the
`docker run` line publishes it to the world, and the two facts never meet on the
same page.

**Inside the container — the image's decision.** The image sets
`SKILLONOMIA_HOST=0.0.0.0` because a process bound to the container's loopback
is unreachable through any publish and through any proxy, including the proxy
this page requires. Say it plainly: that bind is **not a TLS boundary and not a
permission boundary**. It decides which interfaces of a network namespace
holding one process a socket answers on. It grants nothing, encrypts nothing and
authenticates nothing. The image's `HEALTHCHECK` still probes `127.0.0.1` from
*inside* the container, because liveness needs no network at all.

**Out of the container — the operator's decision, and the actual boundary.**
Exactly two shapes are supported:

| Purpose | Shape | Reachable from |
|---|---|---|
| local trial, image built here | `docker run -p 127.0.0.1:7431:7431 -v skillonomia-data:/data skillonomia:local` | this host, over the loopback |
| local trial, published image | `docker run -p 127.0.0.1:7431:7431 -v skillonomia-data:/data ghcr.io/skillonomia/skillonomia@sha256:<digest>` | this host, over the loopback |
| serving another host | the registry publishes **no** port; a **TLS-terminating** reverse proxy publishes `443` and reaches the registry over a network they share | anywhere, over TLS, through the proxy |

A `docker run` that publishes the registry port **without a host address** —
the form that maps a container port onto every interface the host has — is
**not supported for external access**, and no command in this repository is
written that way. It would put the §9.1 bootstrap token and every `Bearer` API
key on whatever network the host is attached to, which is precisely what the
first paragraph of this section forbids. A firewall in front of such a publish
is not the boundary either: it is a second system that has to be right forever,
in place of a port that was never opened.

The minimal external topology, stated so it can be checked rather than believed:

1. The registry container publishes **no** port to the host — or, if the proxy
   runs on the host rather than in the compose project, publishes one bound to
   `127.0.0.1`.
2. The proxy holds the certificate, terminates TLS, and is the only process with
   a listening port on a public interface.
3. The proxy reaches the registry over a shared network: a compose network, a
   user-defined bridge, or that loopback publish.
4. Check it from another machine: `curl https://<name>/health` answers, and a
   plain-HTTP request to the registry port on the host's external address
   connects to nothing. If it answers, the deployment is misconfigured, and the
   credentials that have crossed it are disclosed.

`ci/quickstart-docker.sh` — the timed release gate — publishes on the loopback
for the same reason: a CI runner is a host on a network like any other. It
builds the image from this repository's `Dockerfile` and pulls nothing; it is
the product quickstart, not the acceptance check for a published image.

**The published image, and the digest that is not there yet.**
No digest has been published for `ghcr.io/skillonomia/skillonomia`: the registry
holds nothing under that name, and the row
above is the shape the command will have, not a pull that works today. The
publishing path exists and is armed — `.github/workflows/candidate.yml` builds
`linux/amd64` and `linux/arm64` on every push and pushes neither (two Linux
architectures, not two operating systems: the image is qualified on Linux and
the other two container jobs are deferred by the owner);
`.github/workflows/release.yml` pushes on a version tag out of the protected
`release` environment, then resolves the manifest back from the registry and
smokes it. The acceptance check is:

```bash
docker buildx imagetools inspect ghcr.io/skillonomia/skillonomia@sha256:<digest>
node ci/mvp-release.mjs ghcr --digest ghcr.io/skillonomia/skillonomia@sha256:<digest>
```

which pulls that exact digest, confirms the local daemon reports it as a
`RepoDigest`, runs the container loopback-only, drives `skillonomia demo` to a
terminal `adopted` receipt, restarts on the same volume — no second set of
credentials — and reads the receipt back. **Terminal state:** exit 0 with
`GHCR_SMOKE_OK` as the last line, and a machine-readable record naming the host,
the daemon, the digest and the receipt state. A tag is refused: an image is
pinned by digest, because a tag can be moved after it was smoked.

## The npm CLI

`@skillonomia/cli` installs the `skillonomia` executable on **Node ≥22.6** and
needs no Bun, no `bash`, no `curl` and no `tar`:

```bash
npm install -g @skillonomia/cli
skillonomia serve --port 7431
skillonomia demo                       # the §9.1 quickstart, end to end
```

**On macOS this is the path.** A global install of the published package, from
the public registry, outside any checkout — the container is qualified on Linux
alone and Docker Desktop on macOS is deferred by the owner, so the CLI is what a
macOS operator runs.

Bun is the maintainer's build runtime — `prepack` runs `bun build` to produce
the plain-JS entry point the installed package runs — and npm runs `prepack`
when a tarball is PACKED, never when one is installed. There is no `install`,
`postinstall` or `prepare` script in this package.

**Nothing has been published to npm yet.** The unscoped name `skillonomia` on
the public registry is an unrelated third-party placeholder; do not install it.
Until a version of `@skillonomia/cli` exists, the path is exercised from a file:

```bash
npm pack
node ci/mvp-release.mjs npm --package ./skillonomia-cli-<version>.tgz
```

which installs into a clean npm prefix **with every directory holding a `bun`
executable removed from PATH** (and refuses to continue if `bun` still
resolves), then runs `version`, `serve`, `/health`, `demo`, a restart on the same
SQLite file and a receipt read-back. **Terminal state:** `NPM_CLI_STAGED_OK`
from a file, and `NPM_CLI_OK` only when the package came from the registry —
different markers, because only one of them exercised the registry.

## The command line

One executable, six subcommands — the same set on all four packaging paths
(the container image, a checkout run with Node ≥22.6, the `@skillonomia/cli`
tarball, the compiled binary). Only the binary is a published artifact today:
the image and the npm package have a publishing path that is armed and has not
run, so both are used from this repository until then.

```
skillonomia serve [--port N] [--data DIR] [--host H]
skillonomia verify <package> [<registry-db>] [--db PATH] [--json]
skillonomia verify-log [<registry-db>] [--db PATH] [--json]
skillonomia demo [--base-url URL] [--data DIR] [--json]
skillonomia version
skillonomia help
```

`demo` runs the §9.1 quickstart in Node, with no `bash`, `curl` or `tar`: the
bootstrap exchange, the seed package, an adoption, the package's own declared
step, the terminal `adopted` receipt and a read-back from the server. With
`--base-url` it drives a deployment that is already running and reads
`SKILLONOMIA_BOOTSTRAP_TOKEN` and `SKILLONOMIA_ADOPTER_TOKEN` from the
environment — never from the command line, where `ps` would show them to every
other user of the machine. With no arguments it starts a clean deployment of its
own in a temporary directory, so it cannot spend a real deployment's one-time
credentials by accident. The single program it spawns is the interpreter the
delivered package declares for its own step; where that interpreter is missing
it refuses, rather than reporting a gate result that no run produced.

A bare `skillonomia` serves — that is what the image's default command relies
on. `verify` and `verify-log` default to `<SKILLONOMIA_DATA>/skillonomia.db`,
the file `serve` opens, so on a running deployment

```bash
skillonomia verify ./some-package        # §4.4, against this registry
skillonomia verify-log                   # §4.4 chain walk, against this registry
```

need no path at all. Exit codes: **0** the check succeeded (§4.4.8 warning
verdicts included — the package verified, read the verdict before adopting),
**1** the check failed, **2** the invocation was wrong. Scripts should test for
`2` separately: it means the command line was wrong, not that anything is
untrustworthy. `--json` prints the outcome envelope on one line for a machine.

## First start

First start is the only moment credentials are issued:

- `BOOTSTRAP_OWNER_TOKEN` — not an API key. Exchange it once at
  `POST /v1/auth/bootstrap`; the exchange mints the owner's real key and
  invalidates the token. A second exchange fails.
- `DEMO_ADOPTER_TOKEN` — the demo adopter's API key, usable immediately.

Both are printed to stdout exactly once and never stored in retrievable form.

**A restart before the exchange is survivable.** The outstanding bootstrap
token's SHA-256 lives in `<data>/bootstrap.json` (mode 0600), so a restart
between the first start and the exchange leaves the token you already have
valid: exchange it whenever you get to it. The startup log says so, and it does
**not** reprint the token, because only its hash was ever stored. The file
disappears the moment the token is exchanged, before the owner's key is minted,
so a crash in the middle cannot resurrect a spent token.

Restarting an existing deployment prints no credentials and installs no second
seed package.

**If the token itself is lost** — the terminal scrollback is gone, or the
container's stdout was not captured — there is no recovery, by design: a
one-time credential that can be reissued is not one, and only its hash exists
here. Your options are

- **the deployment is fresh** (nothing has been published or adopted): stop the
  service, delete the data directory, start again. This is the quickstart case
  and is what §9.1 assumes.
- **the deployment has data you must keep**: the token only ever minted the
  *first* owner key. If any owner or admin API key still exists, use it —
  `POST /v1/principals` creates a new owner principal and returns its key once.
  If no such key exists either, the deployment has no administrative access and
  the only path is a new instance plus a data migration; nothing in the registry
  can mint an owner key without an existing one, which is the property that
  makes the key meaningful.

Capture the two lines. `docker run … | tee first-start.log` costs nothing.

## Health and liveness

`GET /health` is unauthenticated and answers `{"status":"ok",…}` as soon as the
listener is up. It carries no instance data — it is a liveness probe, not an
information endpoint. The container image declares it as its `HEALTHCHECK`.

Everything else requires `Authorization: Bearer <api_key>`.

## The delivery worker

The worker claims due jobs with a lease, POSTs them to the adopter's endpoint,
signs the body with HMAC-SHA256, and applies the health rules. It carries two
kinds of message, distinguished by `kind` in the body:

- `adoption` — an adoption request this adopter made;
- `revocation` — a version this adopter is running was revoked. The body
  carries `revocation_reason`, and `receipt_id` is `null`, because nobody
  requested it. `skill.adopt` refuses such a row: it is a notice, not a request.

The health rules:

- a non-2xx or a timeout increments `failure_count` and marks the endpoint
  `failing`; a 2xx resets it to `active`; the fifth consecutive failure marks it
  `dead`;
- five delivery attempts with exponential backoff, then
  `dead_letter(max_attempts)`;
- an adopter with no registered endpoint gets `dead_letter(endpoint_missing)`.

A dead-lettered *notification* never blocks adoption: the adopter still pulls
the package with `skill.adopt`, which is what writes the `delivered` receipt
event. Only a denied §7.3 approval (`dead_letter(approval_denied)`) refuses
adoption outright.

Watch the dead-letter dashboard view — it carries the dead letters (with the
`notification_kind` that failed to arrive, so you can see which adopter was not
told what) and endpoint health.

## Where the registry is allowed to connect

The webhook push is the only outbound connection this service makes, and the
destination is chosen by whoever registered the endpoint. It is constrained:

- **https only.** An `http://` endpoint is not delivered to.
- **No redirects.** A 3xx is the answer, and since it is not 2xx it counts as a
  failed delivery.
- **Address filtering, all-or-nothing.** Loopback, private (`10/8`,
  `172.16/12`, `192.168/16`, `fc00::/7`), carrier-grade NAT, link-local
  (`169.254/16` — the cloud metadata address — and `fe80::/10`), multicast,
  reserved and documentation ranges are refused, as are the IPv6 wrappers that
  carry an IPv4 destination (`::ffff:`, `64:ff9b::/96`, `2002::/16`). If a name
  resolves to several addresses and any one of them is forbidden, the whole
  name is refused.
- **No DNS rebinding.** The name is resolved once and the connection is pinned
  to the address that passed the checks; TLS validation stays on the name.
- **Deadlines and a response cap** — an endpoint cannot hold a worker slot open
  or stream into the registry.

A refusal is an ordinary delivery failure: it feeds the backoff and the health
rules, and after five of them the endpoint is `dead`. If your endpoint stops
receiving, check the dead-letter view's `last_error` — a refusal says which
rule refused it.

| Variable | Default | Meaning |
|---|---|---|
| `SKILLONOMIA_WEBHOOK_TIMEOUT_MS` | `10000` | budget for the whole exchange |
| `SKILLONOMIA_WEBHOOK_CONNECT_TIMEOUT_MS` | `5000` | budget for connecting, and socket inactivity |
| `SKILLONOMIA_WEBHOOK_MAX_RESPONSE_BYTES` | `65536` | response body accepted before the delivery is failed |
| `SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK` | off | **local development only**: permit `http://` and loopback destinations |

Registering an `http://localhost` endpoint is allowed (it is useful while
writing a receiver); DELIVERING to one needs
`SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK=1`. Those are deliberately two decisions:
the first is an adopter's, the second is yours.

Registration runs the same scheme and credential rules as delivery, from the
same code, by parsing the URL. In particular `https://evil.com@internal.host/`
is refused (the host is `internal.host`; the part before the `@` is userinfo)
and `http://localhost.attacker.com/` is refused (a name that merely begins with
`localhost` is not this machine). A literal address is judged against the same
forbidden ranges at registration, since it cannot change later; a NAME is not
resolved at registration, because the answer it gives then is not the answer
delivery will get.

Two further registration rules are worth knowing when a receiver is rejected
with a 400: an endpoint URL longer than 2000 characters is refused, and the URL
is stored exactly as you wrote it rather than re-serialized, so what the
dashboard shows is the string your adopter sent.

## Webhook secrets

Registration returns the plaintext secret exactly once. The database stores a
hash (a verifier) plus a reference into the deployment-local secret store; the
worker resolves the secret through that reference when it signs. Nothing in the
API can return the secret, its hash or its reference afterwards — the dashboard
is tested for exactly that.

To rotate: register a new endpoint (V1 keeps at most one active endpoint per
adopter, so the previous one is retired) and update your receiver.

Verify a delivery on your side by recomputing
`HMAC-SHA256(secret, exact request body bytes)` and comparing with the
`X-Webhook-Signature` header in constant time.

## Backup and restore

Stop the service (or take a consistent snapshot with `sqlite3 .backup`) and copy
the whole data directory: the database alone is not enough, because package
blobs and webhook secrets live beside it. Restore is the reverse; the migration
runner brings an older database forward on the next start.

The transparency log is INSERT-only and hash-chained. After any restore, run

```bash
skillonomia verify-log --db <data>/skillonomia.db     # or, from a checkout:
npm run verify-log -- --db <data>/skillonomia.db
```

which walks the whole chain and recomputes every link. A non-zero exit means the
history was altered — including by an attacker who dropped the triggers, because
the chain covers the semantic fields as well.

`verify-log` opens the database **read-only** and runs no migration, so it is
safe to point at a snapshot, at a file you have made mode `0444`, or at the live
database of a running service: it cannot change what it is auditing, and the
refusal comes from SQLite rather than from the command being careful. One
caveat is SQLite's own: reading a database in WAL mode needs a shared-memory
index beside it, so the *directory* must be writable even when the file is not.
Auditing a snapshot on a read-only mount means copying it somewhere writable
first.

## Upgrades

Migrations are applied automatically at start, tracked with
`PRAGMA user_version`, and are additive by policy. Take a backup first, start
the new version, and confirm `GET /health` reports the version you expect.

**One version is refused.** A database at `PRAGMA user_version` **10** will not
be upgraded: the start fails with a message naming the version, and nothing in
the database is touched. Version 10 is the one state whose stored repeat-keys
may already have been transformed, it cannot be told apart from a version-10
database whose keys were not, and the migration that transforms them does so
unconditionally. It was an intermediate development commit and was never
released, so no deployed database is at it. If you reach 10 because an upgrade
from 9 or below was interrupted after that migration committed, this build
cannot tell that apart either — restore the backup you took and start again.
Every other version, 9 and below or 11 and above, upgrades normally; see
`docs/API.md`, **Upgrading an existing database**.

## Removing the built-in seed package

See the README. In short: delete the seed skill, its versions and the seed
signing key, or start with `serve({ installSeedPackage: false })`.

## The high-risk adoption exercise

```bash
node ci/high-risk-exercise.mjs --clean --transcript evidence/high-risk-exercise.json
```

One clean instance, driven through the §7.3 lane: a start on an occupied port
that refuses fail-closed, `fixtures/high-risk-safe/` loaded and reviewed, an
adoption request held at `approval_pending`, the typed `FORBIDDEN` refusal, a
human `adopt_high_risk` approval bound to that one request, the safe fixture
run, and the receipt read back from the server.

**Terminal state:** exit 0, with `HIGH_RISK_EXERCISE_OK` as the last line and
the redacted transcript written at the `--transcript` path, its
`terminal_read_back.derived_state` reading `adopted`. A step that behaves
otherwise ends the run with exit 1 and names the step; the transcript is then
absent, because it is written after the last step it records.

The receipt is a server-recorded adopter claim. The registry compares the
reported gate ids with the ones `fixtures/high-risk-safe/manifest.json`
declares and requires a pass on the declared set; it does not witness the run.
