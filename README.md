# Skillonomia

## Read this first — what this does not do

Source-only release under Apache-2.0. There is no hosted service, no published
build artifact, no support commitment and no external pilot. You run it
yourself, from this repository, or you do not run it. The registry provisions
its own principals and keys through its own API (§6.1) and the quickstart below
really does work on a clean machine — that is a self-service path, not an
offer of one.

The boundaries come before the description, because every one of them is a way
this software can be misread. Read them first; what it *is* follows in "What
this is".

- **`verified` does not mean safe.** It means: the archive conformed to the
  profile, the manifest validated, the content hashes matched, the signature
  verified under a key bound to the declared author, a reviewer who was not the
  author approved it, the compatibility metadata is complete, all eight gates
  passed on that one invocation, and at least one adopter reached a terminal
  `adopted` receipt whose evidence validated against the package's own declared
  gates. It is a statement about provenance, integrity and recorded process. It
  is not a judgement about what the procedure does when you run it.
- **There is no runtime sandbox enforcement.** `sandbox_requirement` is a
  declared manifest field, and `skill.adopt` refuses to hand a high-risk package
  to an adopter that does not attest `sandbox_capable`. That is a declaration
  and a refusal at the handover point. This software does not create, enter or
  enforce a sandbox, and it cannot check whether the adopter's attestation is
  true. Running an adopted skill safely is your responsibility.
- **It terminates no TLS, and nothing here is a way to serve another host.**
  The listener speaks plain HTTP, and the traffic crossing it is credential
  traffic — the one-time bootstrap token, and an API key in a `Bearer` header
  on every call afterwards. Every runnable command in this repository is
  therefore local: the bind address defaults to the loopback, and the container
  trial publishes to the loopback by address. Reaching a deployment from
  another host is a different topology, not a flag — a **TLS-terminating**
  reverse proxy in front, with the registry port not published at all. See
  [Serving another host](#serving-another-host-a-tls-terminating-proxy-and-nothing-else)
  and [The network boundary](#the-network-boundary); both are conditions of
  running this software, not advice.
- **The eight gates close the classes they enumerate, and nothing else.** They
  are deterministic and deny-by-default within their scope — a URL or a shell
  command that cannot be classified safely is a FAIL. They are not a
  general-purpose malicious-code detector. A package that passes all eight has
  not been shown to be safe.
- **Portability is not proven.** The core product problem — that a runbook
  written for one environment works in another — is exactly what adoption
  receipts are built to *measure*, not something this release has demonstrated.
  Compatibility matching compares declared metadata against a declared
  environment descriptor. Neither side is verified against reality.
- **Nothing here prevents a package from being copied out of the channel.**
  Access policies, grants and the visibility table govern what this registry
  serves to whom. Once a package has been handed to an adopter, it is bytes on
  their machine. There is no DRM and no watermarking. Revoking a version
  changes what the registry answers and pushes a revocation notice to the
  adopters it knows about; it does not reach what someone already holds.
- **The registry makes outbound HTTP requests, and the constraint on them is a
  filter, not a proof.** Webhook delivery POSTs to endpoints an operator
  registers. `src/transport.ts` is https-only, follows no redirect, checks
  every address a name resolves to, refuses the whole name if any of them is
  loopback, link-local, private or otherwise reserved, and connects to the
  address it checked so the DNS answer cannot change underneath it. It is a
  denylist of address ranges in one process, not a network policy. Put the
  process where its egress is governed by something you trust.
- **Internal validation does not establish readiness for an external beta.**
  The project has been exercised against its own instance. That is a
  development signal about this codebase, and it says nothing about anyone
  else's fleet, data or risk tolerance.

## Validation

The suite in `test/` runs on Node 22 and on Bun 1.3, covering the
package format, the signing and verification vectors, the state machines, the
gates, the access rules, the CLI, provisioning, the outbound transport, the
transparency-log namespace, the bind address, the network boundary of every
shipped instruction, the ten threat-model rows, and the parity between `SPEC.md`
and the code. The quickstart transcript in this file is executed as part of
that suite. Beyond it, the registry has been exercised on a local instance
through the ordinary lifecycle — create, lint, review, verify, adopt, report
outcome — with low-risk packages only. **The §7.3 high-risk path
was not executed in that run**: no package in it carried `risk_level: high`, so
the human-approval-per-adoption branch has test coverage but no operational
exercise. There has been no external pilot and no third-party review of the
running system.

---

## What this is

A self-hosted registry of **Verified Skill Packages**: signed, linted, reviewed
procedures that one agent can hand to another together with the evidence that
they actually worked — subject to every limit stated above.

A skill package is a signed directory (`SKILL.md` at the root, so existing
Anthropic-Skills tooling can read it, plus a `skill.json` carrying the verified
metadata that format lacks). The registry adds what a folder cannot: a
lifecycle, eight deterministic safety gates, human review, an approval matrix,
adoption receipts written only by the adopter, and a reputation computed from
those receipts alone.

Everything runs in one process against one SQLite file. There is no build step:
Bun 1.3 runs the TypeScript sources directly, and Node 22.6+ is a first-class
fallback — CI runs the whole suite on both.

`SPEC.md` is the normative specification.

---

## Availability of prebuilt artifacts

**This project publishes source only.** A tagged release carries the source
and a git bundle you can verify yourself; nothing in this document asks you to
download a prebuilt artifact:

- There is **no `skillonomia` package published by this project** on the public
  npm registry. The name is currently occupied by an unrelated third-party
  placeholder — `npx skillonomia` would install *that*, not this software. Do
  not run it.
- There is **no `skillonomia/skillonomia` container image** in any registry.
- The Linux x86_64 binary is produced by `npm run build:binary` from a
  checkout; no release of this project ships one.

Every path below starts from a checkout of this
repository, and the Docker path builds the image locally from the `Dockerfile`
in it. When artifacts are published, the commands that consume them will be
added here — not before.

## Quickstart from source (≤10 minutes on a clean machine)

Clone this repository and `cd` into it. You need **Node ≥22.6** (or Bun ≥1.3),
plus `curl`, `python3` and `tar` for the transcript below. Then:

<!-- doc-test: serve -->
```bash
npm ci
npm start -- --port 7431 --data ./skillonomia-data
```

First start prints **two one-time credentials** and installs one built-in signed
seed package (`hello-skillonomia`) at state `reviewed`:

```
BOOTSTRAP_OWNER_TOKEN=bt_…
DEMO_ADOPTER_TOKEN=sk_…
```

Check it is alive (this is also the whole smoke test for the binary packaging
path):

<!-- doc-test: health -->
```bash
curl -s localhost:7431/health
# → {"status":"ok","service":"skillonomia","version":"0.1.0"}
```

In a second terminal, export the two credentials the first start printed — this
is the only step that is not copy-paste, because the values are freshly
generated:

```bash
export BOOTSTRAP_OWNER_TOKEN=bt_…      # from the server's output, above
export DEMO_ADOPTER_TOKEN=sk_…         # from the server's output, above
```

Everything from here is literal. It takes a fresh instance to a terminal
`adopted` receipt — the whole point of the registry. Each `# →` line is the
exact output of the command above it; `…` stands for a value that differs on
every run (an id, a key, an archive).

<!-- doc-test: quickstart -->
```bash
BASE=${BASE:-http://localhost:7431}
H='Content-Type: application/json'
WORK=$(mktemp -d)
show()  { python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps($1,separators=(',',':')))"; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

# 1. exchange the bootstrap token for the owner's real API key (one time only)
OWNER=$(curl -sS -X POST "$BASE/v1/auth/bootstrap" -H "$H" \
  -d "{\"bootstrap_token\":\"$BOOTSTRAP_OWNER_TOKEN\"}")
printf '%s' "$OWNER" | show "d"
# → {"api_key":"…","agent_id":"…","role":"owner"}
OWNER_KEY=$(printf '%s' "$OWNER" | field "d['api_key']")

# 2. find the built-in seed package
FOUND=$(curl -sS "$BASE/v1/skills?q=hello-skillonomia" -H "Authorization: Bearer $OWNER_KEY")
printf '%s' "$FOUND" | show "{k:d['items'][0][k] for k in ('slug','state','risk_level')}"
# → {"slug":"hello-skillonomia","state":"reviewed","risk_level":"low"}
VERSION_ID=$(printf '%s' "$FOUND" | field "d['items'][0]['skill_version_id']")

# 3. request adoption (as the demo adopter)
REQ=$(curl -sS -X POST "$BASE/v1/adoptions/requests" -H "$H" \
  -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN" \
  -d "{\"skill_version_id\":\"$VERSION_ID\",\"idempotency_key\":\"qs-1\"}")
printf '%s' "$REQ" | show "d"
# → {"adoption_request_id":"…","receipt_id":"…","state":"pending","webhook_id":null}
REQUEST_ID=$(printf '%s' "$REQ" | field "d['adoption_request_id']")
RECEIPT_ID=$(printf '%s' "$REQ" | field "d['receipt_id']")

# 4. adopt = confirm delivery; the package archive comes back base64-encoded
ADOPT=$(curl -sS -X POST "$BASE/v1/adoptions/$REQUEST_ID/adopt" -H "$H" \
  -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN" \
  -d '{"environment_descriptor":{"runtime":{"id":"any","version":"1.0.0"},
       "model":{"id":"any","version":"1.0.0"},"tools":[{"id":"shell","version":"1.0.0"}],
       "os":"linux","shell":"bash","sandbox_capable":false},"idempotency_key":"qs-2"}')
printf '%s' "$ADOPT" | show "{'receipt_event':d['receipt_event'],'event_seq':d['event_seq'],'compat':d['compat'],'package':sorted(d['package'])}"
# → {"receipt_event":"delivered","event_seq":2,"compat":{"result":"match","unmet":[]},"package":["archive_base64","content_hash","manifest_hash","semantic_version","skill_version_id"]}

# 5. unpack what was delivered and run its fixture
printf '%s' "$ADOPT" | python3 -c "import base64,json,sys; open('$WORK/package.tar','wb').write(base64.b64decode(json.load(sys.stdin)['package']['archive_base64']))"
tar -xf "$WORK/package.tar" -C "$WORK"
OUT=$(sh "$WORK/fixtures/tv01.sh"); printf '{"stdout":"%s"}\n' "$OUT"
# → {"stdout":"skillonomia-tv01-ok"}

# 6. report the outcome; the evidence is what makes the receipt terminal
curl -sS -X POST "$BASE/v1/receipts/$RECEIPT_ID/events" -H "$H" \
  -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN" \
  -d '{"event":"attempted","idempotency_key":"qs-3"}' | show "d"
# → {"receipt_event":"attempted","event_seq":3}
curl -sS -X POST "$BASE/v1/receipts/$RECEIPT_ID/events" -H "$H" \
  -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN" \
  -d "{\"event\":\"adopted\",\"evidence\":{\"gate_results\":[{\"gate_id\":\"g1\",\"pass\":true,\"observed\":\"$OUT\"}]},\"idempotency_key\":\"qs-4\"}" | show "d"
# → {"receipt_event":"adopted","event_seq":4}

# 7. read the receipt back: the chain is terminal
curl -sS "$BASE/v1/receipts/$RECEIPT_ID" -H "Authorization: Bearer $DEMO_ADOPTER_TOKEN" \
  | show "{'derived_state':d['derived_state'],'events':[e['event'] for e in d['events']]}"
# → {"derived_state":"adopted","events":["requested","delivered","attempted","adopted"]}
```

That block is **executed on every test run**, against a server started from
these sources, by `test/readme-quickstart.test.ts`: the commands are extracted
from this file and run, and each `# →` line is compared with what the command
actually printed. The README cannot drift from the software silently in either
direction.

The same scenario also runs unattended as `ci/quickstart.sh` (against a running
instance) and `ci/quickstart-docker.sh` (against a locally built container
image, with a 600-second budget measured from container start).

### The same thing in Docker — a local trial, on the loopback

The image is built from this repository; no image is pulled. The published port
carries a **host address on purpose**: `127.0.0.1:7431:7431` reaches the
container from this machine and from nowhere else. This is a local trial of the
container path. **It is not a way to serve another host** — dropping the address
from the `-p` would map the registry onto every interface this host has, and the
bootstrap token and every `Bearer` API key cross that listener in the clear. For
another host there is exactly one supported shape — a **TLS-terminating**
reverse proxy in front, with this port not published at all — and it is the next
section.

<!-- doc-test: docker -->
```bash
docker build -t skillonomia:local .
docker run -p 127.0.0.1:7431:7431 -v skillonomia-data:/data skillonomia:local
```

The container prints the same two credentials on its stdout (`docker logs`),
and the transcript above works unchanged against it.

### Serving another host: a TLS-terminating proxy, and nothing else

The registry port is not published to a network — not on a spare port, not
behind a firewall rule, not "just for a minute". A proxy holds the certificate
and terminates TLS, it is the only container with a port on a public interface,
and it reaches the registry over a network the two of them share.

```yaml
# compose.yaml — the registry publishes NO port; the proxy publishes 443, and
# what arrives there is TLS
services:
  registry:
    image: skillonomia:local
    expose: ["7431"]          # visible on the compose network, not on the host
    volumes: ["skillonomia-data:/data"]
  proxy:
    image: caddy:2
    ports: ["443:443"]        # the only published port, and it terminates TLS
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data"]
volumes:
  skillonomia-data: {}
  caddy-data: {}
```

```caddyfile
registry.example.com {
	reverse_proxy registry:7431
}
```

The registry is then reachable at `https://registry.example.com` and at nothing
else: there is no plain-HTTP port on any interface of the host for anyone to
find. `docs/OPERATIONS.md` → **The network boundary** carries the same topology
for a non-compose deployment, and says what the container's own bind address
does and does not mean.

### Demo mode, and removing the seed

While the instance has exactly **one human principal** it is in demo mode: that
principal may review the built-in seed package, and every dashboard view is
labelled `DEMO MODE`. Creating a second human principal ends it automatically.

The seed exists so a fresh instance has something adoptable. A real deployment
removes it — either by starting the server from your own entry point with
`serve({ installSeedPackage: false })`, or afterwards:

```sql
-- against /data/skillonomia.db, with the service stopped
DELETE FROM skill_versions WHERE skill_id = '01SEEDPACKAGE0000000000000';
DELETE FROM skills         WHERE id       = '01SEEDPACKAGE0000000000000';
DELETE FROM signing_keys   WHERE agent_id = '01SEED00000000000000000000';
```

The seed's signing key is a demo key: it signs that one public fixture package
and nothing else, and its public half is shipped in `seed/` so the package
verifies out of the box on every packaging path.

---

## What the registry enforces

| Stage | What has to be true |
|---|---|
| `draft` | the package parses, matches the manifest schema, and its integrity list matches its bytes |
| `linted` | all **eight** safety gates ran in one invocation and none FAILed (schema, secrets, dependency pinning, URLs, shell safety, prompt injection, staleness, compatibility) |
| `reviewed` | at least one `approve` verdict from an eligible reviewer — same workspace, role reviewer/admin/owner, never the author; the approve writes the reviewer attestation in the same transaction |
| `verified` | **a real adoption receipt**: a terminal `adopted` event for THIS version whose evidence validated against the version's own declared gates, plus the reviewer attestation, plus a clean current gate run |
| `published` | the human-approval matrix where it applies; publication countersigns into the transparency log |
| `deprecated` / `superseded` / `revoked` | terminal lifecycle states; revocation takes effect immediately for search, verification and adoption |

Two rules do most of the work:

- **The actor comes from the API key, never from the payload.** A body field
  claiming to be someone else is rejected, on REST and MCP alike.
- **Reputation is computed only from server-validated receipts.** Outcome counts
  come from receipt events, ratings only from adopters holding a terminal
  `adopted` receipt, and observed failure modes from schema-validated failure
  reports. Nothing an author signs can move any of them.

## Interfaces

Nearly every surface exists twice — REST under `/v1` and MCP tools on the same
listener at `/mcp` — over one service layer, so the two cannot diverge. The
exceptions are named in [`docs/API.md`](docs/API.md): `GET /health`,
`POST /v1/auth/bootstrap`, `GET /v1/receipts/{id}` and webhook management are
REST-only, and the table below ends with them.

| MCP tool | REST |
|---|---|
| `skill.create` | `POST /v1/skills`, `POST /v1/skills/{id}/versions` |
| `skill.create_from_dir` | `POST /v1/skills/from-source`, `POST /v1/skills/{id}/versions/from-source` |
| `skill.lint` | `POST /v1/versions/{id}/lint` |
| `skill.review.request` | `POST /v1/versions/{id}/reviews` |
| `skill.verify` | `POST /v1/versions/{id}/verify`, `POST /v1/verify` |
| `skill.search` | `GET /v1/skills?q=&capability=&runtime=&tool=&risk=&state=&min_adopted=&min_rating=&limit=&cursor=` |
| `skill.request_adoption` | `POST /v1/adoptions/requests` |
| `skill.adopt` | `POST /v1/adoptions/{id}/adopt` |
| `skill.validate_outcome` | `POST /v1/receipts/{id}/events` |
| `skill.rate` | `POST /v1/versions/{id}/ratings` |
| `skill.supersede` | `POST /v1/versions/{id}/supersede` |
| `skill.revoke` | `POST /v1/versions/{id}/revoke` |
| `skill.publish` | `POST /v1/versions/{id}/publish` |
| `skill.deprecate` | `POST /v1/versions/{id}/deprecate` |
| `skill.transfer` | `POST /v1/versions/{id}/transfers` |
| `skill.approve` | `POST /v1/versions/{id}/approvals` |
| `transfer_grant.create` | `POST /v1/transfer-grants` |
| `transfer_grant.list` | `GET /v1/transfer-grants` |
| `assignment.activate` | `POST /v1/assignments/{id}/activate` |
| `assignment.pause` | `POST /v1/assignments/{id}/pause` |
| `assignment.revoke` | `POST /v1/assignments/{id}/revoke` |
| `assignment.list` | `GET /v1/assignments` |
| `fleet.list` | `GET /v1/fleet` |
| `agent.capabilities` | `GET /v1/fleet/{agent_id}/capabilities` |
| `capability.get` | `GET /v1/fleet/{agent_id}/capabilities/{name}` |
| `observation.report` | `POST /v1/observations` |
| `dashboard.view` | `GET /v1/dashboard/{view}` (`?format=html`) |
| `migration.count` | `GET /v1/migrations?since_ms=&until_ms=` |
| `tlog.read` | `GET /v1/tlog?cursor=` |
| `principal.create` | `POST /v1/principals` |
| `principal.list` | `GET /v1/principals` |
| `principal.issue_api_key` | `POST /v1/principals/{id}/api-keys` |
| `principal.revoke_api_key` | `POST /v1/principals/{id}/api-keys/{key_id}/revoke` |
| `signing_key.register` | `POST /v1/signing-keys` |
| `signing_key.list` | `GET /v1/signing-keys` |
| `signing_key.revoke` | `POST /v1/signing-keys/{kid}/revoke` |
| — (REST only) | `GET /health`, `POST /v1/auth/bootstrap`, `GET /v1/receipts/{id}`, `POST`/`GET`/`DELETE /v1/webhooks` |

Provisioning is API-only and needs no database access: an owner creates a
principal and receives its API key **once**, and the principal registers its
**own** Ed25519 signing key — never anyone else's, at any role, because `kid` →
`manifest.author_agent` is what makes a signed package attributable.

The dashboard has eleven read-only views — **library, evidence, receipts,
approvals, dead letters, migrations**, and §9's five screens **fleet, agent,
skill_approval, capability, outcomes** — each a rendering of the same API
fields, scoped by the same access rules as the underlying read. Webhook health
(`active` → `failing` → `dead`) sits on the dead-letter view, because
undeliverability is meant to be loud. On every one of the eleven, a cell carries
an answer *and* its method: `unknown` is written as the word and never as a
blank or a dash, and every number states which state was counted, from which
source, over which selection window.

The migrations view, and `migration.count` behind it, answer the question the
registry exists for: how often each skill actually moved to an agent that ran
it. Per skill it counts the migrations, the distinct recipients and the distinct
declared runtimes, so the figure cannot be raised after the fact. The qualifying
event is always the append-only receipt journal, and so is the recipient: from
the `transferred` event of a chain a sender opened, and from the `requested`
event of a chain the recipient opened for itself. Both rows are written by the
registry in the transaction that opens the chain, and neither is read from
anywhere else — a chain whose opening event is missing or unreadable contributes
nothing at all and is reported as `recipients_unattributed`. Each row names the
opening events its own numbers came from. A skill that never migrated is a row of zeroes rather than a missing row,
a runtime that could not be read is reported as unknown rather than silently
dropped to zero, and every row states its source and the window it was counted
over.

See `docs/API.md` for the full request and response shapes, and
`docs/OPERATIONS.md` for running one.

## Packaging

Four paths, all of them built from this checkout. None of them downloads a
published artifact, because there is none yet (see
[Availability of prebuilt artifacts](#availability-of-prebuilt-artifacts)).

| Path | Command | Notes |
|---|---|---|
| Docker | `docker build -t skillonomia:local .` → `docker run -p 127.0.0.1:7431:7431 -v skillonomia-data:/data skillonomia:local` | the normative quickstart target; the publish is loopback-only |
| Node | `npm ci` → `npm start -- --port 7431 --data ./skillonomia-data` | needs Node ≥22.6 |
| npm tarball | `npm pack` → `npm install -g ./skillonomia-0.1.0.tgz` → `skillonomia serve` | packed here and installed **from the file**, never from a registry; `prepack` builds the plain-JS entry point the installed package runs |
| Linux x86_64 binary | `npm run build:binary` → `dist/skillonomia serve` | ships `migrations/`, `schema/` and `seed/` next to the executable |

All four rows are **local**: each one puts a plain-HTTP listener on the
loopback and on nothing else. Serving another host is not a flag on any of
them, it is a different topology — a **TLS-terminating** reverse proxy in front,
with the registry port not published at all (see
[The network boundary](#the-network-boundary)).

This release is source only: no image and no npm package is published by this
project, so the corresponding `docker run <registry>/<image>:<tag>` and `npx
skillonomia` forms do not exist and are deliberately not written here. If they
are ever published, they will be added to this table then, and not before.

### Supported platforms

**V1 supports Linux x86_64, and claims nothing else.** That is not a preference,
it is the exact extent of what is tested:

- CI runs the full suite (Node and Bun), the container quickstart and both
  packaging smokes on `ubuntu-latest` x86_64, and on no other runner.
- `npm run build:binary` compiles `--target=bun-linux-x64`. There is no macOS
  and no Windows binary; neither is a V1 release artifact.
- Part of §4.1b is filesystem-dependent. When a package is read from a plain
  **directory** rather than a `.tar`, the case-insensitive and NFC/NFD
  collision rules assume a case-sensitive, byte-preserving filesystem. On a
  case-insensitive one (default APFS/HFS+, NTFS) or a normalizing one, the two
  colliding members cannot coexist on disk at all, so the rule cannot be
  exercised and this implementation's behaviour there is unspecified. The
  archive (`.tar`) path has no such dependency and behaves identically
  everywhere. `test/platform.test.ts` runs the directory check on Linux and
  skips it, naming this reason, anywhere else.

The registry may well run on macOS today. It is not tested there, so it is not
claimed there. This is a different question from a skill package's
`runtime.os`, which may name `macos` or `windows`: that says where the
**package's procedure** runs, and §4.2 compatibility honours it whatever the
registry itself is hosted on.

Configuration is environment-first: `SKILLONOMIA_DATA` (default `/data`),
`SKILLONOMIA_PORT` (7431), `SKILLONOMIA_HOST` (`127.0.0.1`),
`SKILLONOMIA_WORKER_MS` (delivery-worker interval), `SKILLONOMIA_ASSETS` (where
`migrations/`, `schema/` and `seed/` live — an explicit value must be correct;
there is no silent fallback).

### The network boundary

**The listener MUST NOT be reached over plain HTTP from another host.** This
process serves HTTP and terminates no TLS, and two kinds of credential cross
that listener in the clear: the one-time `BOOTSTRAP_OWNER_TOKEN` above, which
mints the owner's API key for whoever presents it, and every API key
afterwards, sent as a `Bearer` header on every single call. Exposing that to a
network is exposing the credentials themselves.

So the default bind address is `127.0.0.1`, and it is a default that does not
quietly become something else: a wider bind happens only when an operator asks
for it by name, with `--host` or `SKILLONOMIA_HOST`. The one supported way to
reach a deployment from another host is a **TLS-terminating reverse proxy** in
front of it, with the registry itself still bound to the loopback (or to an
interface only that proxy can reach). `SKILLONOMIA_HOST=0.0.0.0` without such a
proxy is not a deployment this project supports.

**In a container these are two questions, not one.** Where the process listens
is set by the image: it sets `SKILLONOMIA_HOST=0.0.0.0` so the listener answers
on the container's own network, because a bind to the container's loopback is
unreachable through any publish or any proxy. That bind is **not a boundary** —
it is not TLS and it is not a permission check; it says which interfaces of a
namespace holding one process the socket answers on, and nothing more. The
boundary is the second question, and it belongs to the operator: whether, and
onto what, the port is published on the host. Two shapes are supported, the
loopback publish above for a local trial, and a TLS-terminating proxy with the
registry port not published at all for everything else. A `-p` that names no
host address maps the registry onto every interface the host has; it is not a
supported way to reach this registry from another machine, and no command in
this repository is written that way.

The data directory holds the SQLite database, the package blobs and the webhook
secret store. **Webhook signing secrets are never stored in SQLite and never
returned twice**: registration returns the plaintext once, and the database
keeps only a hash plus a reference into the deployment-local store.

## Development

```bash
npm ci
npm run typecheck     # tsc --noEmit, strict
npm test              # Node 22
npm run test:bun      # Bun 1.3.14 (canonical runtime)
npm start             # a local instance on :7431
npm run gen-seed      # regenerate the built-in seed package
npm run verify -- <pkg> <db>     # §4.4 over a package, against a registry
npm run verify-log -- <db>       # walk and recompute the transparency-log chain
```

`verify` and `verify-log` are subcommands of the one executable
(`src/cli.ts`), so the same five commands exist on every packaging path — from a
checkout as `node --experimental-strip-types --no-warnings src/cli.ts …` (the
`npm run …` lines above are aliases for three of the five, and `package.json`
defines no script for `version` or `help`), inside the container as
`docker exec <container> bun run /app/src/cli.ts …`, from an installed tarball
as `skillonomia …`, and from the compiled binary as `./dist/skillonomia …`:

```bash
skillonomia verify <package> [--db PATH] [--json]     # 0 verified, 1 not, 2 usage
skillonomia verify-log [--db PATH] [--json]           # 0 intact, 1 broken
skillonomia serve | version | help
```

The registry defaults to `<SKILLONOMIA_DATA>/skillonomia.db` — the file `serve`
opens — so on a running deployment neither needs a path.

| Path | What |
|---|---|
| `SPEC.md` | the normative specification: package format, signing, verification, state machines, gates, error model, API contracts |
| `migrations/` | the normative DDL, byte-checked against `SPEC.md` Appendix D.1 |
| `schema/` | the manifest and payload JSON Schemas, byte-checked against Appendix E |
| `src/archive.ts`, `src/signing.ts`, `src/verify.ts` | package format, detached JWS signing, the verification algorithm |
| `src/gates.ts` | the eight safety gates and their severity tables |
| `src/service.ts` | the one logic layer behind both adapters |
| `src/receipts.ts`, `src/delivery.ts`, `src/webhooks.ts`, `src/transport.ts` | receipts, the delivery machine, webhook push, and the SSRF-constrained outbound transport |
| `src/dashboard.ts` | the dashboard's view list, payload shape and renderer |
| `src/server.ts`, `src/cli-commands.ts`, `bin/`, `Dockerfile` | the runnable deployment and its command line |
| `vectors/`, `seed/` | published test vectors and the built-in seed package |
| `docs/` | operations and API reference |

## Security model in one paragraph

Packages are signed with a detached Ed25519 JWS over a canonicalized manifest,
and publication countersigns the manifest hash into a hash-chained transparency
log you can verify offline (`npm run verify-log`). Receipts are INSERT-only and
writable only by the adopter they belong to, with the server as the sole timing
authority. High-risk packages need a human approval bound to one exact adoption
request, and a service key can never satisfy that gate. The threat model and the
ten red-team tests that cover it live in `SPEC.md` §8 and
`test/p7-threats.test.ts`. Read the boundaries at the top of this file before
relying on any of it — see also `SECURITY.md`.

## Specification

`SPEC.md` in this repository is the normative specification. The schemas and the
migrations are asserted byte-identical to its appendices by the test suite,
`test/spec-parity.test.ts` derives its checks from the code, and
`test/spec-references.test.ts` derives the set of citable sections from the
document itself — so neither the document nor the software can drift away from
the other silently.

## Contributing

This repository is a read-only mirror for now. See `CONTRIBUTING.md`.

## License

Apache-2.0.
