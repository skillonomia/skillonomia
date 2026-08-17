# V1 P6 — the runbooks

Five procedures a person who was not here can follow: starting the system,
diagnosing it, migrating it, rolling back a revision, and rolling back the
application. Contract section 3.1 point 9 and `P6-FR-19`.

Each one is written as commands rather than as description, and each was
FOLLOWED rather than described: the transcript of the run is in the evidence
package for this phase, and it carries the same command strings that appear
below. Where a runbook is proved by a gate this repository already ships, the
runbook says which gate and the transcript shows it running.

Two conventions hold throughout:

- `DATA` is a data directory. A disposable one is `$(mktemp -d)`. An operator's
  real one is whatever `--data` names, and the procedures that WRITE are run on
  a copy of it first.
- the registry is driven by `node --experimental-strip-types --no-warnings
  src/cli.ts`, which is what `bin/skillonomia.js` re-execs. A packaged install
  runs the same subcommands as `skillonomia`.

---

## 1. Starting the system

```sh
cd <checkout>
export NPM_CONFIG_CACHE="$(mktemp -d)"      # a writable npm cache
npm ci                                       # once per checkout
npm run build:console                        # the console bundle the server serves

DATA="$(mktemp -d)"
PORT=8123                                    # any FREE port; see the note below
node --experimental-strip-types --no-warnings src/cli.ts serve --port "$PORT" --data "$DATA"
```

The server prints a bootstrap owner token on first start. Exchange it once for
the registry API key, which stays on the server side:

```sh
curl -sS -X POST "http://127.0.0.1:$PORT/v1/auth/bootstrap" \
  -H 'content-type: application/json' \
  -d '{"bootstrap_token":"<the token from the log>"}'
```

Then confirm that what answers is this checkout, not something else already
holding the port:

```sh
curl -sS "http://127.0.0.1:$PORT/health"
node -p "require('./package.json').version"
```

The two versions have to be the same string. A registry from another tree
answering the port is the failure this check exists for: it happened on this
host, on port 7431, and `v1/tools/p0-registry-smoke.sh` records it.

For an owner to sign in to the console, mint a one-time ticket on the server and
hand it over. The ticket opens one session, once, within five minutes; the API
key does not travel to the browser:

```sh
curl -sS -X POST "http://127.0.0.1:$PORT/v1/console/tickets" \
  -H "authorization: Bearer <the registry key>" -H 'content-type: application/json' -d '{}'
```

The dogfood deployment of this phase automates exactly these steps, and is the
worked example: `dogfood/up.sh` in the P6 work area picks a free port, refuses a
port that already answers, exchanges the bootstrap token and asserts the version
before it reports success.

## 2. Diagnosing it

In the order a first look should go:

```sh
curl -sS "http://127.0.0.1:$PORT/health"                       # is it this build
curl -sS "http://127.0.0.1:$PORT/v1/migrations" -H "authorization: Bearer $KEY"
node --experimental-strip-types --no-warnings v1/tools/p0-db-check.ts       # schema and integrity
bash v1/tools/p0-registry-smoke.sh                             # a real listener on a free port
```

`GET /v1/migrations` is the ADOPTION-migration counter of Appendix H: it answers
how many times each skill reached a recipient, out of the registry's own
INSERT-only journal. It says nothing about the schema. A sentence claiming
otherwise stood here until BUILD-4 followed this runbook and read what the
endpoint returned; `src/http.ts` dispatches it to `registry.migrationCounts`.

THE SCHEMA VERSION HAS NO READ SURFACE, so it is read where it lives:

```sh
DB="$DATA/skillonomia.db" node --experimental-strip-types --no-warnings -e '
  import("./src/db.ts").then(async ({ openDb }) => {
    const db = openDb(process.env.DB);
    console.log("user_version", db.prepare("PRAGMA user_version").get().user_version);
  });'
```

Starting the server migrates the data directory to the checkout's head, and
`src/db.ts` refuses exactly one state on the way — a database at `user_version`
10, which the withdrawn intermediate build left and which this build declines to
upgrade, with a message naming the state and the way out. `p0-db-check.ts` is
the schema and integrity harness, and it builds disposable databases of its own
rather than reading a deployment's.

For a question about a particular capability rather than the deployment, the
console is the surface: the capability screen shows desired beside observed with
each one's source, the outcome region shows what runs reported with the receipt
under each word, and the session region shows the stages one session passed
through — proposed, loaded, invoked — with the source, receipt and runtime
reference of each. An `unknown` there carries a reason code and a source; it is
never a failure to look, and it is never a success.

Logs: the server writes to stdout. The dogfood deployment keeps its own at
`dogfood/registry.log` in the P6 work area.

## 3. Migrating it

The upgrade is the shipped runner and no manual step. Run it on a COPY first:

```sh
cp -a "$DATA" "$DATA.copy"                                     # the disposable subject
node --experimental-strip-types --no-warnings src/cli.ts serve --port 0 --data "$DATA.copy" &
```

Starting the server against a data directory migrates it to the checkout's head.
Two gates in this repository run the same thing without a listener and check
what an operator wants checked:

```sh
bash v1/tools/gates/upgrade-from-v016.sh        # a database at the release base, upgraded
bash v1/tools/gates/reversible-migration.sh     # up, down and up again, with the digests compared
```

The first builds a database at the release base's migration set (`PRAGMA
user_version=12`, which is what `v0.1.6` shipped), populates it through the seed
graph, records twelve read surfaces and the row count of every table, runs the
upgrade, and refuses if any surface answers differently, if any row count moved,
or if a table added by the upgrade arrived non-empty. The second takes the head
migration down again and compares the schema digest with the one before the
upgrade.

An upgrade that fails leaves the copy, not the original. That is the whole
reason the copy is step one.

## 4. Rolling back a revision

This is a product operation, not an operations one, and it is done in the
console. It changes what the NEXT session loads; it does not rewrite the session
that is running.

1. Open the capability. The assignment shows the revision it is on and the
   approved revisions available to it.
2. Under `Rollback`, choose the earlier approved revision and press
   `Prepare rollback`. The page reads back the target before anything changes,
   and says that it takes effect in the next session and is confirmed by a
   session rather than by the click.
3. Press `Confirm rollback`. The registry records the selection; the newer
   revision stays approved and stays in the lineage.
4. Wait for the next session of that agent to open. When it carries the target
   revision, the rollback is confirmed — the session region shows which revision
   the session was handed and which stages it reached.

Nothing is deleted by a rollback, and nothing is edited in place: `INV-06`. The
outcome that led to the rollback is still there afterwards, unchanged.

The clean-room journey of this phase does exactly this, in a browser, and the
gate that runs it is `v1/tools/gates/clean-room-journey.sh`.

## 5. Rolling back the application

An application rollback is two moves in this order: put the previous code back,
then take the schema back to what that code expects. The order matters — code
that is one migration behind its database is the state this reverses.

```sh
# 1. the code
git -C <checkout> checkout <the previous commit or tag>

# 2. the database, on a COPY, and only if the previous code is behind the schema
cp -a "$DATA" "$DATA.rollback"
node --experimental-strip-types --no-warnings -e '
  import("./src/db.ts").then(async ({ openDb }) => {
    const { readFileSync } = await import("node:fs");
    const db = openDb(process.env.DB);
    db.exec(readFileSync(process.env.DOWN, "utf8"));
    console.log("user_version", db.prepare("PRAGMA user_version").get().user_version);
  });
'
```

with `DB="$DATA.rollback/skillonomia.db"` and `DOWN` naming the reversal of the
head migration under `migrations/down/`. Each migration ships its own reversal
there; the head one of this tree is
`migrations/down/0017_outcomes_and_the_revision_loop.down.sql`.

3. Start the previous code against the rolled-back copy and check three things:
   `/health` for the version it is, `PRAGMA user_version` for the schema it is
   on, and one authenticated read surface for whether it serves.
4. Only when the copy answers correctly does the copy replace the original.

WHAT WILL NOT TELL YOU THAT THE ORDER WAS WRONG, and the reason step 2 is not
optional. `migrate()` skips every migration numbered at or below the database's
own `user_version`, so the previous code started against a database AHEAD of it
serves rather than refuses: the tables that build has no knowledge of sit there
untouched, and `/health` answers `ok`. BUILD-4 ran that counter-case on a
disposable copy and the previous code said nothing at all about the mismatch.
Reading the version is the operator's job here, not the server's.

WHAT THIS TOUCHES. The reversal drops the tables the head migration added and
nothing else. In this tree those hold V1-only data — captures, drafts, revisions,
assignments, loadouts, receipts, outcomes — which exists nowhere else, so a
reversal that is not preceded by a copy loses it. The rows of the release base
are not read or written by the reversal, which is what
`v1/tools/gates/reversible-migration.sh` compares before and after.

---

## What was run, and what was not

The migrate and application-rollback runbooks above were followed on a
disposable database, and the transcript is in the P6 evidence package as
`17-runbook-migrate-and-rollback.txt`. That run reached step 2 of runbook 5 —
the copy and the schema reversal — and stopped there, which BUILD-3 declared.
BUILD-4 performed step 3: the previous application, extracted at the commit
whose head migration is `0016`, started against the rolled-back copy, answering
`/health` at its own version, reporting `user_version` 16 and serving an
authenticated read surface. Its transcript is
`27-runbook5-application-rollback.txt`, and it carries the counter-case above.
The revision-rollback runbook is the path the clean-room journey drives in a
browser, and its transcript is `18-clean-room-journey.txt`.

The starting and diagnosing runbooks are the commands the dogfood deployment and
the gate battery of this phase run; the parts of them a session executed appear
in those transcripts rather than in a separate one of their own.
