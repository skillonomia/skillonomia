# API reference

REST under `/v1`; the same surfaces as MCP tools on the same listener at `/mcp`
(one JSON-RPC message per POST). Both adapters call one service layer, so a rule
proven on one holds on the other — the test suite asserts the parity.

## Conventions

- **AuthN**: `Authorization: Bearer <api_key>`. The acting agent is derived from
  the key; a body field naming a different agent is rejected.
- **AuthZ**: workspace roles `owner | admin | reviewer | member`, plus the
  skill's access policy `private | invite | workspace | public`. Deny is the
  default.
- **Errors**: `{"error":{"code","message","current_state"?}}` with codes
  `INVALID_SCHEMA | FORBIDDEN | NOT_FOUND | CONFLICT | PRECONDITION_FAILED |
  RATE_LIMITED | UNAUTHORIZED | UNKNOWN_KEY | BAD_SIGNATURE | TAMPERED_CONTENT |
  MALFORMED_ARCHIVE | LIMIT_EXCEEDED | NOT_IMPLEMENTED`. A conflicting or precondition-failed
  transition always returns the **current state**, so a caller can converge
  instead of looping.
- **Idempotency**: every mutating call accepts `idempotency_key` (≤128 chars).
  A duplicate replays the stored original response byte for byte with
  `Idempotency-Replayed: true`. The exceptions are the three calls that return
  a one-time secret — `POST /v1/webhooks`, `POST /v1/principals` and
  `POST /v1/principals/{id}/api-keys` — because a replay is served from the
  persisted response, and persisting a plaintext secret is exactly what those
  surfaces exist to avoid.
- **Pagination**: `?limit=` (1–100, default 20) and `?cursor=` (opaque);
  responses carry `next_cursor`.

## Auth

| Route | Notes |
|---|---|
| `POST /v1/auth/bootstrap` | one-time: `{"bootstrap_token"}` → `{"api_key","agent_id","role":"owner"}`. Invalidates the token. |
| `GET /health` | unauthenticated liveness: `{"status":"ok","service","version"}` |

## Getting from a fresh instance to a published package

First start prints `BOOTSTRAP_OWNER_TOKEN` once. Everything after it is API:

```bash
OWNER=$(curl -s -XPOST $B/v1/auth/bootstrap -d "{\"bootstrap_token\":\"$TOKEN\"}" | jq -r .api_key)

# the owner creates a principal; its API key comes back ONCE, right here
curl -s -XPOST $B/v1/principals -H "authorization: Bearer $OWNER" \
  -d '{"name":"publisher","type":"agent","role":"member"}'
# → {"principal_id":"01…","api_key":"sk_…", …}

# the principal registers ITS OWN signing key — nobody can do this for it
curl -s -XPOST $B/v1/signing-keys -H "authorization: Bearer $PUBLISHER" \
  -d '{"kid":"publisher-key-1","public_key_ed25519":"<43 chars, base64url raw 32B>"}'

# now sign a package whose manifest.author_agent is that principal_id, and run
# it through skill.create → lint → review → verify → publish.
```

`kid` → `manifest.author_agent` is what makes a package attributable, so a
package signed by a key the author never registered verifies as `UNKNOWN_KEY`,
not as a bad signature. See "Auxiliary endpoints" for the full provisioning set.

## The fifteen surfaces

### 1. `skill.create` — `POST /v1/skills`, `POST /v1/skills/{skill_id}/versions`

Body: `{"slug"?, "archive": "<base64 tar>", "idempotency_key"?}`. The archive
must contain `SKILL.md`, `skill.json` and `SIGNATURE.jws`; the manifest's
integrity list must match the bytes. Returns
`201 {"skill_id","skill_version_id","state":"draft"}`. Re-posting identical
content converges (`noop:true`); different content under the same
`semantic_version` is a `CONFLICT`.

### 2. `skill.lint` — `POST /v1/versions/{id}/lint`

Runs all eight gates in one invocation and stores one report per gate. Returns
`{"reports":[{gate,result,details}…],"state"}`. `draft → linted` iff no gate
FAILs; a WARN does not block.

### 3. `skill.review.request` — `POST /v1/versions/{id}/reviews`

`{"action":"request"}` or
`{"action":"verdict","verdict":"approve|reject|conditional","note"?}`. The
author can never review their own version, and a reviewer must be a member of
the skill's workspace with role reviewer/admin/owner. An `approve` writes the
reviewer attestation in the same transaction and moves the version to
`reviewed`.

### 4. `skill.verify` — `POST /v1/versions/{id}/verify`, `POST /v1/verify`

With an id: re-runs the eight gates and checks the verified-gate conjunction —
a terminal `adopted` receipt for this version with evidence that validated at
append time, at least one reviewer attestation, and no FAIL in the current run.
On success the version becomes `verified` and the transition is written to the
transparency log; otherwise the response lists each conjunct and whether it is
satisfied. With an archive instead: the stateless verification algorithm over
uploaded bytes.

### 5. `skill.search` — `GET /v1/skills`

Filters, all combined with **AND**: `q` (slug/title/capability),
`capability`, `runtime`, `tool`, `risk`, `state`, `min_adopted`, `min_rating`,
plus `limit`/`cursor`. Results are filtered by state visibility × access policy
first, so no filter combination can widen what an actor may see. Each item
carries the registry view: lifecycle fields, receipt ids, reviewer notes and the
computed reputation
(`adoption_attempts`, `adopted_count`, `failed_count`, `rolled_back_count`,
`avg_rating`, `failure_modes_observed`).

### 6. `skill.request_adoption` — `POST /v1/adoptions/requests`

`{"skill_version_id","idempotency_key"?}` → `201 {"adoption_request_id","receipt_id","state"}`.
Cross-workspace adoption accepts only `published` versions. When the approval
matrix applies, the request is created in `approval_pending` and named in
`approval_required`; no worker may claim it and adoption is refused until a
human approval names that exact request.

### 7. `skill.adopt` — `POST /v1/adoptions/{request_id}/adopt`

`{"environment_descriptor", "idempotency_key"?}` — the descriptor declares
`runtime`, `model`, `tools`, `os`, `shell`, `sandbox_capable`. The registry
matches it against the package's declared compatibility and answers
`{"compat":{"result":"match|mismatch","unmet":[…]}}`. A mismatch **warns** at
low risk and **blocks** (`PRECONDITION_FAILED`) at medium or high. A high-risk
package is only handed to an adopter attesting sandbox capability. On success:
`{"receipt_event":"delivered","event_seq":2,"package":{…,"archive_base64"}}` — seq 1 is the `requested` event the registry wrote when the chain was opened.

Handover happens **once**. The declared descriptor is recorded on the
`delivered` receipt event this call writes, in the same transaction, and is
readable afterwards at `GET /v1/receipts/{receipt_id}` as
`events[].environment_descriptor` — an adopter can therefore check its own
declaration. A call against a request whose receipt chain has already begun is
`PRECONDITION_FAILED` with the current state and **no package**, the same answer
the receipt surface gives a late append. The one exception is a genuine repeat —
the SAME principal replaying the SAME `idempotency_key` — which returns the
original response byte for byte, `archive_base64` included, so a caller that
lost the response can still recover the package it already paid a request for.

### 8. `skill.validate_outcome` — `POST /v1/receipts/{receipt_id}/events`

`{"event":"attempted|adopted|failed|rolled_back", "evidence"?|"failure_report"?|"rollback_report"?, "idempotency_key"?}`.
Only the receipt's own adopter may append. The order is the receipt's own
counter, and each event kind occurs at most once per receipt; an illegal
transition returns `PRECONDITION_FAILED` with the current state rather than an
error loop. `adopted` requires evidence naming every declared validation gate
with `pass:true`; a `failed` before any `attempted` must be
`category:"pre_execution"`. At most one terminal event (`adopted`/`failed`) can
ever exist per receipt.

### 9. `skill.rate` — `POST /v1/versions/{id}/ratings`

`{"score":1-5,"note"?,"adoption_receipt_id","idempotency_key"?}`. The receipt
must be the rater's own and terminal `adopted`. One rating per (version, rater);
a second returns the recorded one.

### 10. `skill.supersede` — `POST /v1/versions/{id}/supersede`

`{"successor_version_id"}`. The successor must itself have reached `verified` or
`published`. Both versions move atomically and the link is transparency-logged.

### 11. `skill.revoke` — `POST /v1/versions/{id}/revoke`

`{"reason"}`. Immediate effect on verification verdicts, search and adoption;
transparency-logged.

### 12. `skill.publish` — `POST /v1/versions/{id}/publish`

`{}`. Moves `verified → published` and appends the registry countersign in the
same transaction — publication has exactly one entry point, because a published
version with no countersign has no revocation reference time. Requires workspace
role admin/owner: publication is the registry's decision, not the author's, so
the author, a plain member and a reviewer are all `FORBIDDEN`. While the
approval matrix demands a human `publish` approval this version does not have,
the call is `FORBIDDEN` with `current_state` and changes nothing. Returns
`{"skill_version_id","state":"published","manifest_hash","countersign_seq"}`;
republishing converges (`noop:true`) without a second countersign.

### 13. `skill.deprecate` — `POST /v1/versions/{id}/deprecate`

`{}`. Retires a `published` version without naming a successor: it stays visible
and stays adoptable with a warning. The registry stamps `deprecation_date` from
its own clock and transparency-logs the retirement, both in the same
transaction. Author, skill owner or workspace admin/owner — not a reviewer, who
is admitted to `supersede` only because naming a successor judges a replacement
package. Returns
`{"skill_version_id","state":"deprecated","deprecation_date","tlog_seq"}`;
re-deprecating converges (`noop:true`) and does not move the recorded date.

### 14. `skill.create_from_dir` — `POST /v1/skills/from-source`, `POST /v1/skills/{skill_id}/versions/from-source`

Body: `{"slug"?, "source": "<base64 tar of the SOURCE tree>", "idempotency_key"?}`
(over MCP the field is `source_base64`). The source tree is what you keep in
version control — `manifest.json`, `SKILL.md`, `scripts/`, fixtures — and it must
NOT contain `skill.json` or `SIGNATURE.jws`: those are produced here, and a
source carrying them is `INVALID_SCHEMA` pointing you at surface 1.

Your manifest MUST carry an `outcome_contract` — `check`, `evidence`, `unknown`
— stating what SUCCESS is for this skill. Without it the dashboard's `outcome`
column can say nothing about the skill, and a task that FINISHED would be read
as a task that SUCCEEDED. A source without a contract, or with a truncated one,
is `INVALID_SCHEMA` before anything is written: no version, no key, no
transparency-log row. Truncated means what it says: a `stdout_match` with no
pattern, an `artifact_exists` with no path, a `command` with no command and an
`exit_code` with no code each name a method and withhold its subject, and none
of them can be executed. THE NAMES IN `evidence` ARE IDENTIFIERS: a lowercase
letter, then lowercase letters, digits and underscores, at most 40 characters
(`^[a-z][a-z0-9_]{0,39}$`). `exit_code` and `suite_digest` are names; a sentence
is not one, and a contract declaring one is `INVALID_SCHEMA` here and declares
nothing if it reaches the report path from somewhere else. The reason is not
tidiness: a declared name is stored in the observation journal as a KEY, word
for word, so a name that may be prose is a text channel into that journal — and
a name is kept readable rather than hashed because whoever reads a record has to
see WHICH quantity a run presented. The contract is inside the manifest that gets signed, so
redefining what success means requires issuing a new version — a receipt cannot
come to certify something other than what it certified when it was approved.
Surface 1 does not require a contract: it accepts packages signed elsewhere, and
one without a contract reports `outcome` as `unknown` with the reason
`no_outcome_contract`, never as `no`.

An executed contract is not the same thing as a VERIFIED one, and the `outcome`
column says which it is holding. This registry does not run processes on the
addressee's machine and does not assume it can read that machine's disk [M-7],
so an `exit_code`, a `stdout_sha256` or a `command` that reaches it is something
a principal REPORTED. The contract is still executed against that report, and what
the report amounts to is published — as a claim, under its own name, beside the
principal's type and the words "not verified by the registry". The verdict
itself stays `unknown`. A `yes` or a `no` in this column means the registry read
the thing itself, which today means one thing: whether an artifact the contract
names is present under the activation root this deployment configured, AND this
registry's own activation journal records that it wrote that very copy there. Finishing is not succeeding, and neither is being told that
you succeeded.

You supply no cryptographic material. There is no `--seed-hex`, no `kid`, no
hand-written `integrity` list and no packing step. The registry:

1. mints the `skill_version_id`;
2. derives this version's §5 arrival marker from that id;
3. writes the marker into a generated block at the head of `SKILL.md`'s
   procedure — for EVERY version — and, when your manifest declares a shell,
   into a generated `scripts/skln-arrive.sh` (a RESERVED path: whatever you ship
   under that name is replaced, or removed);
4. refuses to pack unless EVERY place that carries a marker holds the same value
   as the one the id derives — a disagreement is a refusal, never a warning;
5. computes `integrity` over the resulting bytes, so the signature covers the
   marker;
6. signs with a system-held Ed25519 key it generates for you on first use.

That key's private half lives in the deployment's secret store, never in SQLite,
and never crosses the API in either direction — it is not an input, not an
output, not a log line and not part of an error message.

**If your manifest declares `runtime.shell: ["none"]`** you get the `SKILL.md`
block and no script. Your declaration is NOT amended to say `["sh"]`: a manifest
that demanded an interpreter you never asked for would assert something other
than what is there, and that is the defect this registry exists to catch. Step 4
then compares two places instead of three — fewer places, the same bar, and a
script found where you declared none is itself a refusal.

The consequence is stated rather than hidden: such a version ships nothing that
can print its marker, so a run of it can leave no record, so §5 reports it as
`unknown` **for want of an executable step** — a different answer from `unknown`
because nothing was found yet, and never `no`. Declare a shell if you want runs
to be recorded.

Returns `201 {"skill_id","skill_version_id","state":"draft","arrival_marker",`
`"kid","manifest_hash","content_hash"}`. Re-posting an UNCHANGED source
converges on the version already packed from it (`noop:true`), reporting that
version's marker; a different source under an existing `semantic_version` is a
`CONFLICT`. Convergence is judged on the source rather than on the packed bytes,
because the marker makes every packing of one source byte-different.

### 15. `skill.transfer` — `POST /v1/versions/{id}/transfers`

Send a version to a recipient you NAME. The body is
`{"recipient":{"kind":"local_agent|remote_fleet","ref":"<recipient id>"},`
`"idempotency_key"?}`, and `recipient` has no default: a transfer that does not
name one is `INVALID_SCHEMA`. There is deliberately no form of this call that
moves a version to whoever happens to be asking.

The sender must hold an `assign` grant scoped to that recipient kind
(`POST /v1/transfer-grants`, below). `local_agent` names an active principal of
your own workspace; `remote_fleet` is declared by the specification and **is not
implemented in V1** — it is refused with `NOT_IMPLEMENTED` (501) after the grant
is checked and found satisfied, and nothing is recorded. That order is the
point: a missing permission and a missing implementation are different answers.

Returns `201` with the whole signature of the operation — the version, the
sender with its principal type and role, the typed recipient, the permission it
ran under with the type and role of the principal that issued it, the arrival
marker, and the receipt plus the `transferred` event it wrote. It also opens the
recipient's adoption request, held in `approval_pending` when the human-approval
matrix applies, so a transfer cannot route around an approval.

**A transfer is an intent, and the answer says so twice.** Beside `intent` the
body carries `observed_state:"unknown"`: nothing has been observed at the
recipient. A transfer never reports that a package arrived, that it was
installed, or that anything is running. The recipient still fetches the package
through surface 7 and still reports its own outcome through surface 8, and only
that terminal `adopted` makes the movement a counted migration.

## Auxiliary endpoints

| Route | Notes |
|---|---|
| `POST /v1/versions/{id}/approvals` | record a human approval: `{"scope":"publish\|adopt_high_risk","decision":"approved\|denied","adoption_request_id"?,"note"?}`. Requires a human principal with role admin/owner — a service key can never satisfy it. `adopt_high_risk` binds exactly one adoption request and cannot be replayed elsewhere. |
| `GET /v1/receipts/{id}` | the full chain in order, with the derived state, for the adopter, the skill owner or a workspace admin |
| `GET /v1/tlog?cursor=&limit=` | public read of the hash-chained transparency log |
| `POST /v1/webhooks` | `{"url"}` → `{"webhook_id","url","secret"}` — the secret is returned exactly once. `https://` only (or `http://` to this machine for local development), no credentials in the URL, at most 2000 characters, stored exactly as you wrote it. At most one active endpoint per adopter; registering a new one retires the previous. |
| `POST /v1/principals` | `{"name","type":"human\|agent\|service","role":"owner\|admin\|reviewer\|member","tool_profile"?}` → `{"principal_id",…,"api_key_id","api_key"}`. Admin/owner, and the new role may not outrank yours. **The `api_key` is shown once and never again.** Takes no `idempotency_key` — a replay would have to persist that secret. |
| `GET /v1/principals` | the workspace roster for an admin/owner; a member sees exactly its own row, which is how it learns the `principal_id` to put in `manifest.author_agent` |
| `POST /v1/principals/{id}/api-keys` | issue a further key — how a lost key is recovered. Shown once, same rules |
| `POST /v1/principals/{id}/api-keys/{key_id}/revoke` | your own key, or any in the workspace as admin/owner. Effective immediately; re-revoking converges on the original time |
| `POST /v1/signing-keys` | `{"kid","public_key_ed25519"}` → the key is bound to **you**, always. There is no parameter for registering on another principal's behalf: `kid` → author is what makes a package attributable (§4.4 step 3). `kid` matches `[a-z0-9-]{1,64}`, the key is unpadded base64url of the raw 32 bytes |
| `GET /v1/signing-keys` | your keys with `revoked_at_ms`; admin/owner see the workspace's |
| `POST /v1/signing-keys/{kid}/revoke` | your own key, or any in the workspace as admin/owner. Changes FUTURE `skill.verify` verdicts only — a version already `verified`/`published` keeps its state; use `skill.revoke` if you also want the package withdrawn |
| `GET /v1/webhooks` | your endpoints with `status` and `failure_count` |
| `DELETE /v1/webhooks/{id}` | your endpoints only |
| `POST /v1/transfer-grants` | `{"agent_id","action":"receive\|assign\|activate\|revoke\|report_outcome","recipient_scope":"local_agent\|remote_fleet"}` — one step of the transfer loop, towards one KIND of recipient (`transfer_grant.create`). Admin/owner of the grantee's workspace. It adds no workspace role: the roles and principal types are unchanged and approvals still stand on them. Re-issuing the same triple converges on the recorded grant. |
| `GET /v1/transfer-grants` | your grants, or the workspace's as admin/owner (`transfer_grant.list`). Each row names the issuing principal WITH its type and role as recorded, so "granted by the owner in person" and "granted by an agent holding an administrative role" never read the same. |
| `POST /v1/assignments/{id}/activate` | put the managed copy into the runtime's NATIVE location (`assignment.activate`). Needs an `activate` grant for the assignment's recipient kind. **The activation root is deployment configuration and is never a request field** — a caller that could name the directory could choose which runtime this registry writes into. With no root configured it writes nothing and records `queued`. With one configured it writes under `<root>/<native location>`, reads the entry file back from there, and only then records `active` — which means *Skillonomia believes it activated this*, and is labelled `intent` on the row. The observation beside it stays `unknown` until a runtime record carries the version's arrival marker. |
| `POST /v1/assignments/{id}/pause` | take the managed copy out and keep the assignment, so it can be activated again (`assignment.pause`). Needs a `revoke` grant. |
| `POST /v1/assignments/{id}/revoke` | take the managed copy out and end the assignment (`assignment.revoke`); terminal. Needs a `revoke` grant. Both withdrawals report which of `removed`, `absent` or `retained` happened, and both say a new session is required: taking a file away does not reach into a session that has already loaded the skill. |
| `GET /v1/assignments` | your deployments, or the workspace's as admin/owner (`assignment.list`). Every row carries two columns that are never merged: `intent_state` (what Skillonomia decided, from the append-only assignment journal) and `observed_arrival` (what a runtime record showed — `yes` or `unknown`, never `no`). Each names its own source and window, and `native_inventory` counts entry files under the configured roots with symbolic links followed. Strictly reading. |
| `GET /v1/fleet` | the fleet inventory (`fleet.list`): one row per principal you may read, with the runtime it was OBSERVED on, its model, whether a session is live, when it was last active, and a synchronisation status. Every field is three-valued — `unknown` is a value and is never rendered as `no`. The answer publishes the state × runtime matrix itself, and that matrix is ASYMMETRIC: Claude Code splits `proposed` into `proposed_now` and `proposed_historical`, Codex has one `proposed` that is `unknown` always, and `loaded` is an explicit column on neither. Strictly reading. |
| `GET /v1/fleet/{agent_id}/capabilities` | one agent's skills, plugins, MCP servers, MCP tools and connectors (`agent.capabilities`), each with the six states as separate columns and the column set its OWN runtime publishes. Every cell and every number carries three attributes: which state, which source (`filesystem`/`registry`/`runtime`/`transcript`) and which window (`live_session`/`period`/`all_time`). `assigned` is the intent column and is labelled `intent`; the rest are observations. A count that could not be taken is `unknown` with a reason, never a silent `0`, and the walk follows symbolic links. Carries the intent-versus-fact gap and the DEAD WEIGHT slice: registered, and never once demonstrated to run. Strictly reading. |
| `GET /v1/fleet/{agent_id}/capabilities/{name}` | one capability (`capability.get`) with its runtime's matrix row and the scanner's tuples — version, agent, runtime, time, `call_id`, result. A tuple exists only where a PAIRED call/output record sharing one `call_id` carried THAT version's arrival marker: a lone call, a lone output, or another version's marker produces nothing, and no tuple means `unknown`, never `no`. Strictly reading. |
| `POST /v1/observations` | file what was observed at one agent's runtime (`observation.report`). **This writes**, although it reads as a reporting surface: telling the registry something is storing it, and the call appends to two append-only tables. Needs a `report_outcome` grant. `window` and `window_detail` are required — a report that does not say what it looked at is a number with no method. The records' text is reduced to arrival markers at the boundary and is not stored, logged or returned. A report can establish that a version RAN; it can never establish that one did not. A record may state a `result`, and a stated `success` or `failure` requires `evidence` — the named values the version's signed `outcome_contract` demands. The registry executes that contract's own `check` against the evidence and never takes the verdict from the word, so a principal holding this grant states what it observed and never what the outcome was. |
| `GET /v1/dashboard` | the list of views |
| `GET /v1/dashboard/{view}` | one of `library`, `evidence`, `receipts`, `approvals`, `dead_letters`, `migrations`, `fleet`, `agent`, `skill_approval`, `capability`, `outcomes` — eleven in all; `?format=json` (default) or `?format=html`. Any other value is `INVALID_SCHEMA` on both adapters. Each section declares the API fields it renders; rows are scoped by the same rules as the underlying read. `demo_mode` is on the payload. On every view a cell carries an answer AND its method: `unknown` is the word and never a blank or a dash [I-1], and every number states its measurement state, source and selection window [I-3]. |
| `GET /v1/migrations` | the migration counter (`migration.count`): one row per skill you can see, with `migrations`, `distinct_recipients`, `distinct_runtimes`, the runtime list and `runtimes_unknown`. Counted from the append-only receipt journal — a terminal `adopted` event with server-validated evidence — and never from `adoption_requests.requester_context_json` or from the receipt shell. The recipient of a counted migration is read from the `transferred` event of a chain a sender opened and from the `requested` event of a chain the recipient opened for itself; a chain naming no recipient on the journal contributes nothing and is reported in `recipients_unattributed`. Optional `since_ms`/`until_ms` bound the window; a non-integer bound, or a pair in the wrong order, is `INVALID_SCHEMA`. Every row restates its `source`, its `window` and its `measurement_state`, and a skill that never migrated is a row of zeroes rather than a missing row. Strictly reading. |

## MCP

`POST /mcp` speaks JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`. The
advertised tools are the fifteen surface names above, plus `skill.approve`,
`transfer_grant.create`, `transfer_grant.list`, `principal.create`,
`principal.list`, `principal.issue_api_key`, `principal.revoke_api_key`,
`signing_key.register`, `signing_key.list`, `signing_key.revoke`, `tlog.read`,
`migration.count`, `dashboard.view`, `assignment.activate`, `assignment.pause`,
`assignment.revoke`, `assignment.list`, `fleet.list`, `agent.capabilities`,
`capability.get` and `observation.report` — thirty-six tools in all.
The reading tools and the writing ones are separate names — `migration.count`
carries `readOnlyHint`, and there is no general-purpose tool that could stand in
for either kind. Every annotation is a statement about behaviour and is checked
against it — against the WHOLE environment a call can move, which is the rows
of the registry's database and the filesystem a tool is configured to reach,
because "destructive updates to its environment" is what the protocol's own
wording says and a directory removed with `rm -rf` is destroyed whatever the
tables did. So: `readOnlyHint` against whether the call moved a row or a
watched path; `destructiveHint` against whether it changed or removed a row
that already existed, removed a path that existed, or replaced the bytes of
one; `idempotentHint` against whether calling twice with the same arguments
moved either half a second time; and `openWorldHint` against whether the call
asked the deployment where a foreign root is — corroborated, where the tool's
behaviour allows it, by having moved something under one or by answering
differently once that root was taken away.
`assignment.activate`, `assignment.pause` and `assignment.revoke` carry
`destructiveHint: true`: the first unlinks and rewrites a drifted copy in a
runtime's own directory, and the other two remove the copy's directory and
everything under it. `assignment.list`, `fleet.list`, `agent.capabilities`,
`capability.get` and `dashboard.view` carry `openWorldHint: true` while
remaining `readOnlyHint: true` — they walk a fleet member's directory and
change nothing in it. `skill.transfer`, `skill.lint`, `skill.review.request`,
`skill.approve`, `skill.request_adoption`, `observation.report` and
`principal.issue_api_key` carry `idempotentHint: false`, because a second call
without an `idempotency_key` really does record a second fact. Arguments are the REST
body fields with the path parameter folded in (`skill_version_id`,
`adoption_request_id`, `receipt_id`, `principal_id`, `api_key_id`, `kid`,
`view`). Errors come back as a tool result with `isError: true` carrying the
same envelope REST returns.

Three REST surfaces have **no** MCP tool and are REST-only: `GET /health`,
`GET /v1/receipts/{id}` and webhook management. `POST /v1/auth/bootstrap` is
REST-only as well, and unauthenticated, because at that moment there is nothing
to authenticate with.

## Webhook deliveries

The registry POSTs `application/json`:

```json
{"kind":"adoption","adoption_request_id":"01…","receipt_id":"01…",
 "skill_version_id":"01…","adopter_agent_id":"01…","attempt":1,
 "server_at_ms":1754100000000}
```

```
X-Webhook-Signature: <hex HMAC-SHA256 of the exact body bytes>
```

Verify it in constant time. A 2xx marks the endpoint healthy; anything else —
including a 3xx, because redirects are not followed — counts as a failure under
the health rules in `OPERATIONS.md`.

`kind` is `adoption` for a request you made, or `revocation` when a version you
are running has been revoked. A revocation notice adds `revocation_reason` and
has `receipt_id: null`; its `adoption_request_id` is a queue row, not something
you can `skill.adopt` (that call answers `NOT_FOUND` for it).

The registry only connects to `https` endpoints on public addresses, follows no
redirects, resolves your hostname once and pins the connection to the address it
checked, and enforces connect/total deadlines and a response-size cap.
`OPERATIONS.md` has the full list and the knobs.
