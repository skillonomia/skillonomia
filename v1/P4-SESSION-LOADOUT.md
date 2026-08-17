# P4 — Immutable session loadout and two native runtime adapters

Phase P4 of the contract *Skillonomia V1 → FINAL DONE*. This file records what
P4 built, where each binary requirement is met, what it deliberately did not
build, and what it does not claim.

P4 takes the approved revision P2 decided on and the assignment P3 controlled,
freezes what one runtime session was given, materialises it into that runtime's
own native mechanism, and writes back what the runtime actually did — through
the observed-state boundary P3 built, with no bypass added.

## 1. The three things that are never one thing

```
owner command ──▶ skill_assignment_events    DESIRED    (source: owner)
backend build ──▶ session_loadouts/entries   SNAPSHOT   (immutable, one per session)
runtime        ─▶ runtime_receipts           EVIDENCE   (source: backend|adapter|runtime)
                        └──▶ assignment_observations    OBSERVED
```

`INV-02` says an owner command changes desired state only. P4 could have broken
that in one line, because `P4-FR-09` requires a `proposed` observation the moment
a loadout is built, and the obvious place to build a loadout is a console button.

**So the session is opened by the ADAPTER and not by the owner.** `POST
/v1/sessions` and `POST /v1/sessions/{id}/receipts` are mounted on the
machine-to-machine surface behind the same registered evidence principal P3's
observation intake requires (`src/evidence-principal.ts`). An owner or admin
credential is `403` before the body is read; a console session never reaches the
prefix at all. The owner's access to all of it is one route, `GET
/v1/console/sessions/{id}`, and it is a `GET`: seeing what a session was given is
not the same act as claiming it was given.

That is the whole of `P4-FR-13`, and it is placement plus vocabulary plus
authorization rather than a rule somebody remembered to write:

* no `POST` exists under `/v1/console/sessions`;
* `agent_sessions.opened_by_source` and `runtime_receipts.source` have no `owner`
  member, in the type and in the CHECK;
* `Registry.assertMayWriteObservedState` runs in the transport before `parseBody`
  and again in the service, on both intakes;
* `test/v1p4-session-loadout.test.ts` drives the owner key, the admin key and a
  console session at both routes and counts the rows afterwards: zero.

| module | what it owns |
|---|---|
| `src/session-loadout.ts` | the snapshot, what enters it, the receipt rules, the stage chain |
| `src/runtime-adapter.ts` | the two runtime rows, the renderer, the safe materialisation |
| `src/adapter-cli.ts` | `skillonomia adapter open \| invoke \| cleanup` — the shipped launcher |
| `migrations/0016_session_loadout_and_runtime_receipts.sql` | four INSERT-only tables, five indexes, eight triggers |
| `migrations/down/0016_…down.sql` | the reversal the round-trip gate runs |

## 2. The surfaces

| route | what it is |
|---|---|
| `POST /v1/sessions` | open a session and FREEZE its loadout — evidence principal only |
| `GET /v1/sessions/{id}/loadout` | the frozen entries and the canonical content to render |
| `POST /v1/sessions/{id}/receipts` | the structured runtime receipt — the only writer of `loaded`/`invoked` |
| `GET /v1/console/sessions/{id}` | the owner's READ: the snapshot, the stage of each entry, the receipts |

`SPEC.md` Appendix D.1p carries the normative schema, Appendix H the rows, and
`docs/API.md` the operator's account.

## 3. Where each binary requirement is met

Proved by `test/v1p4-session-loadout.test.ts` unless another file is named. The
last three rows are proved by a REAL runtime, because contract section 9 says
outright that a mocked adapter test never substitutes for one.

| id | where | proved by |
|---|---|---|
| `P4-FR-01` | `loadoutCandidates` | an ACTIVE assignment and an `assigned` one are offered together; one enters, the other is reported excluded with `NOT_ACTIVE` |
| `P4-FR-02` | `openSessionInTx`, `0016` | every one of the ten named things is asserted present on the answer, and every one is a COLUMN |
| `P4-FR-03` | the INSERT-only triggers | five `UPDATE`/`DELETE` statements against the snapshot are refused BY THE DATABASE, and the read-back is byte-for-byte the answer |
| `P4-FR-04` | `loadoutCandidates` | paused, revoked and unapproved are each refused a place, and the console refuses to select an unapproved revision at all |
| `P4-FR-05` | `RUNTIMES.codex` | one revision renders into `<CODEX_HOME>/skills/<name>/SKILL.md`, and a real `codex exec` session reads it |
| `P4-FR-06` | `RUNTIMES.claude_code` | the same revision renders into `<CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md`; the two loadouts carry the same revision id and digest and the rendered BYTES are equal |
| `P4-FR-07` | `src/adapter-cli.ts` | the owner's whole vocabulary is P3's console; the adapter takes an agent id, a runtime kind and a version, and composes the rest from registry rows |
| `P4-FR-08` | `cleanupSession` | the session directory is removed, the canonical session still answers, still reports the stage the runtime confirmed, and the next session rebuilds the same bytes |
| `P4-FR-09` | `openSessionInTx`, `confirmFromReceiptInTx` | building writes exactly one `proposed` and zero receipts; `loaded` is written only after the adapter read the entry file BACK from the native location |
| `P4-FR-10` | `confirmFromReceiptInTx` | `invoked` needs a receipt naming the runtime's own session ref AND an `invocation_ref`, and a `loaded` receipt before it; each of the three refusals is asserted |
| `P4-FR-11` | `entryStages` | a proposed entry nobody confirmed is `unknown` — not `proposed`-as-success — carrying `reason_code`, `reason`, `source` and the time of the look |
| `P4-FR-12` | `entryStages` | every link of the chain carries `at_ms` and a source; the reporter's own clock is what a receipt stage carries, not the registry's |
| `P4-FR-13` | section 1 | the owner key, the admin key and a console session are refused at both intakes, and nothing is written by any of it |
| `P4-FR-14` | `nativeSkillName`, `sessionHome`, `src/activation.ts` | eight unsafe names refused; EVERY component of the session path — the session root itself, the runtime home subdirectory, the skills directory, the per-skill directory — is planted as an outward link in turn, for both runtimes, and each is refused before a byte exists outside the base, with the outside tree fingerprinted before and after; a link planted at the entry file's own name is unlinked rather than written through, and the target is unchanged; a base reached THROUGH a link and a link that stays inside the base both still materialize (see section 4.1) |
| `P4-FR-15` | `credentialShapeIn` | a rendered artifact carrying a credential shape is refused and NOT written; the runtime transcript is scanned on the same patterns before it is saved |
| `P4-FR-16` | `0016` + P3's `effective_from` | pause and revoke leave a running session's loadout byte-for-byte and empty the next one |
| `P4-FR-17` | `v1/tools/gates/runtime-codex.sh` | a real `codex exec` session against a session-scoped `CODEX_HOME` |
| `P4-FR-18` | `v1/tools/gates/runtime-claude-code.sh` | a real `claude -p … --output-format json` session against a session-scoped `CLAUDE_CONFIG_DIR` |
| `P4-FR-19` | the receipt marker | see section 4 |
| `P4-FR-20` | `entryStages`, `confirmFromReceiptInTx` | the chain is READ from the loadout row and the receipt rows; there is no branch that promotes a stage because a later one was seen and none that infers one from a client claim |

Invariants: `INV-01` — one canonical model, two projections; the adapters store
nothing and rebuild everything. `INV-02` — section 1. `INV-03` — every `unknown`
carries all four fields. `INV-05` — the receipt is columns, and `payload_json` is
a payload beside them. `INV-06` — every loadout entry and every receipt names an
exact revision and its content digest. `INV-07` — an owner command applies to the
next session; the snapshot of a running one is INSERT-only. `INV-08` — `0016` is
additive and reversible and every earlier surface answers as it did. `INV-09` —
section 5.

## 4. Why a receipt proves a REVISION and not a name

`P4-FR-19` exists because a skill NAME is exactly what an accident or an attacker
controls. Two files can carry one name, and a runtime reporting "I used
ship-the-thing" has said nothing about which bytes it read. P4 BUILD-1's
feasibility probe deliberately proved only a name and said so; this is the part
that closes it.

The materialised `SKILL.md` states its own provenance and instructs the runtime
to echo it:

```
SKLN-RECEIPT revision=<revision id> digest=sha256:<64 hex>
```

The adapter lifts that line out of the runtime's OWN output — `codex`'s final
message, or the `result` field of Claude Code's JSON — and files it with the
runtime's own session id. The registry then refuses the receipt unless the
revision is in THIS session's frozen loadout and the digest is the one that
loadout froze for it (`confirmFromReceiptInTx`). A runtime that invents a
plausible-looking line has to invent the sha256 of a canonical revision it never
read.

Both gates assert the echoed revision id equals the revision the owner approved
and the echoed digest equals the entry's, and both assert the negative: a receipt
naming the right revision with a wrong digest is `412`.

What this does NOT claim: that a runtime could not be made to print a digest it
was told by some other means. It claims that the digest came out of the runtime's
own session and matched the frozen snapshot, which is strictly more than a name
and is what the requirement asks for.

### 4.1. The containment boundary is the WHOLE session path (`P4-FR-14`, `T-04`)

P4 REVIEW-1 found `P4-R1-001`, and it was real: the boundary was measured from
the wrong root.

`sessionHome` resolved the base, JOINED the session id onto it and created the
result with a RECURSIVE mkdir. A recursive create walks straight through a
directory link already sitting at that name and says nothing, and everything
downstream then re-derived its root from that lexical path — so with
`<base>/<session_id>` planted as a link, the runtime home, the skills directory,
the per-skill directory and the entry file were all created, written and READ
BACK on the other side of the disk, and the `home` the function returns handed
the runtime an environment variable pointing there as well. Every per-component
containment check in `src/activation.ts` passed, because each one was asked about
a root that was already outside the base.

The fix is not a new mechanism. `mkdirWithinRoot` — the walk that creates one
component, resolves it through any link and refuses it if it is not physically
inside the root — already existed and is what makes the rest of the path safe; it
is now what creates the session root and the runtime home subdirectory too, and
it returns the RESOLVED directory so nothing downstream can re-derive another
one. There is no new abstraction, no path framework and no second implementation
of containment (contract section 8, point 10).

What the regression asserts, in `test/v1p4-session-loadout.test.ts`:

* each of the four components — session root, runtime home subdirectory, skills
  directory, per-skill directory — planted as an outward link in turn;
* the session root case for BOTH runtime kinds;
* the refusal is an `ActivationError` with reason `outside_root_refused`, raised
  at the earliest point that can see it (`sessionHome` for the two components it
  creates, the write for the two below them);
* the refusal happens BEFORE ANY WRITE — the outside tree is fingerprinted, paths
  and file digests, before the call and compared after it, so the claim is about
  the tree and not about one predicted filename;
* `cleanupSession` takes the planted link away and does not delete through it;
* and the legitimate arrangements still work: a base reached THROUGH a link, and a
  link that stays inside the base, both materialize as before. A containment check
  that refuses everything would prove nothing.

## 5. What the owner does, and does not, do (`INV-09`)

The owner captures, approves, assigns, activates. That is the whole vocabulary.
No manifest is written, no archive packed, no signature made, no runtime config
edited: `skillonomia adapter open` asks the registry for the frozen loadout,
renders it, writes it into a session-scoped runtime home and points the runtime
at that home through the runtime's own environment variable.

It is a PRODUCT command (`src/adapter-cli.ts`, dispatched by `src/cli.ts`) and
not a gate script, because `INV-09` is a claim about the product — a harness that
did the materialisation itself would prove it of the harness.

## 6. The layout table, and the one environment limitation

With a session root of `<base>/<session_id>`:

| runtime | home | entry file | launched with |
|---|---|---|---|
| codex | `<root>/.agents` | `<home>/skills/<name>/SKILL.md` | `CODEX_HOME=<home>` |
| claude_code | `<root>/.claude` | `<home>/skills/<name>/SKILL.md` | `CLAUDE_CONFIG_DIR=<home>` |

The path BELOW the home is the runtime's own rule and is the row's promise; the
home directory NAME is the adapter's choice. Both rows reuse the `TARGET_DIR`
table already in `src/activation.ts` rather than restating a runtime's layout in
a second place.

**Codex, in THIS container only.** `codex` ships its own bubblewrap sandbox and
reads `SKILL.md` through its shell tool. This container cannot nest that sandbox,
so skill loading fails until the sandbox is delegated to the container that
already is one, and the adapter passes
`--dangerously-bypass-approvals-and-sandbox`. That is an ENVIRONMENT LIMITATION
of this host, recorded in `src/adapter-cli.ts` where it is relied on and in the
gate header — not a security choice of the design. A host that can nest
bubblewrap should drop the flag.

**Claude Code, everywhere.** Without `--permission-mode bypassPermissions` the
Skill call is denied non-interactively and the run emits no JSON at all, so a
session that would have loaded the skill leaves no receipt to file.

**The runtime's own login is not the adapter's business.** A session-scoped home
is empty and an empty home is not logged in — which is the correct default and is
a usable negative control. The gate harness seeds the runtime credential from a
file the operator names (`SKLN_RUNTIME_AUTH_CODEX`, `SKLN_RUNTIME_AUTH_CLAUDE`)
into the session home, outside the evidence package. The adapter neither mints,
holds nor copies it.

## 7. What P4 did NOT build

A universal runtime plugin architecture, a second registry inside an adapter,
support for a third runtime, and termination of an already-running session — all
four are P4's own OUT list. Outcomes and the revision loop are P5.

## 8. Reversal

```
sqlite3 <copy-of-the-db> < migrations/down/0016_session_loadout_and_runtime_receipts.down.sql
skillonomia adapter cleanup --session <id> --base <materialization base>
```

Take a copy of the database file first. Reversal drops the four tables of `0016`,
which discards the sessions, their loadouts and the receipts; every skill,
revision, approval, assignment and lifecycle event of `0013`–`0015` is untouched.
`v1/tools/gates/reversible-migration.sh` runs the round trip on a throwaway
database.
