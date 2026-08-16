# P2 — Draft Inbox and semantic review in the Owner Console

Phase P2 of the contract *Skillonomia V1 → FINAL DONE*. This file records what
P2 built, where each binary requirement is met, what the phase deliberately did
not build, and what it does not claim.

P2 adds a protected browser surface on top of the capture/draft path P1 left. It
adds no second registry, no second classifier and no second permission model: the
console reaches the same service layer an API key reaches, and the only thing
that is new about it is the CHANNEL (`INV-01`).

## 1. The channel, end to end

```
owner ──(API key, server side)──▶ POST /v1/console/tickets ──▶ ticket
ticket ──(POST body, in the browser)──▶ POST /v1/console/session ──▶ HttpOnly cookie
cookie + CSRF token ──▶ /v1/console/... ──▶ the same service methods /v1/drafts uses
```

The login runs backwards from the usual shape, and that is the whole of `INV-04`.
An owner does not type a credential into a page: a machine-to-machine call the
owner makes with the Registry API key mints a one-time TICKET, and the browser
trades that ticket for a session. The key never crosses into the browser, so
there is no storage to keep it out of.

| module | what it owns |
|---|---|
| `src/console-session.ts` | the ticket, the session, the cookie, the CSRF check and the Origin check |
| `src/draft-decision.ts` | approve and reject, and the eligibility rule both the console and the server read |
| `src/console-view.ts` | the three versioned read contracts: inbox, detail, audit |
| `src/console-page.ts` | the two fixed page shells, which carry no draft content |
| `console/app.ts` | the browser client, built by `npm run build:console` |
| `migrations/0014_owner_console_sessions_and_decisions.sql` | five INSERT-only tables, two indexes, ten triggers |
| `migrations/down/0014_owner_console_sessions_and_decisions.down.sql` | the reversal the round-trip gate runs |

### What it reuses rather than restates

* `src/auth.ts` — `sha256Hex` is what hashes the session token and the ticket, so
  a stored console credential reads exactly as a stored API key does: as a hash.
* `src/errors.ts` — the console's refusals are the registry's own codes, and the
  converging-conflict rule (`current_state` on every `CONFLICT` and
  `PRECONDITION_FAILED`) is what lets the page refetch instead of guessing.
* `src/redaction.ts` — an owner's rejection reason is prose on its way to a row
  and an audit, so it goes through the same function a capture body does.
* `src/capture.ts` — `listDrafts`, `getDraft`, `reviseDraft` and `draftAudit` are
  the reads and the edit. The console adds fields beside them and re-shapes none.
* `src/journal.ts` and `src/identity.ts` — every new column is classified in the
  tables those modules own, which is why a column added here cannot be filed
  quietly.

## 2. The surfaces

| route | what it is |
|---|---|
| `GET /console/login` | the sign-in shell, unauthenticated |
| `GET /console/app.js` | the built bundle, unauthenticated, the same bytes for everyone |
| `GET /console` | the console shell; `401` and the sign-in shell without a session |
| `POST /v1/console/tickets` | Bearer, owner/admin: mints the one-time ticket |
| `POST /v1/console/session` | ticket in the body, `Set-Cookie` out |
| `GET /v1/console/session` | the session, and the CSRF token a reload reads back |
| `POST /v1/console/logout` | the server-side end of the session |
| `GET /v1/console/drafts` | the Inbox |
| `GET /v1/console/drafts/{id}` | the detail, with the server's eligibility verdict |
| `GET /v1/console/drafts/{id}/audit` | P1's events and P2's decision, in one field set |
| `POST /v1/console/drafts/{id}/revisions` | an edit, as a new revision |
| `POST /v1/console/drafts/{id}/approve` | approve |
| `POST /v1/console/drafts/{id}/reject` | reject |

`SPEC.md` Appendix H carries the normative rows and `docs/API.md` the operator's
account of them.

## 3. Where each binary requirement is met

| id | where | proved by |
|---|---|---|
| `P2-FR-01` | the session gate in `src/http.ts` | `test/v1p2-console.test.ts` — nine protected routes, each answering `401`; the browser gate, on the page and on the API |
| `P2-FR-02` | `sessionCookie`, `resolveConsoleSession`, `revokeConsoleSession` | `test/v1p2-console.test.ts` — the attributes, the cap in two places, logout and a clock-driven expiry; the browser gate watches a real cookie expire |
| `P2-FR-03` | there is no code path that puts a key in a response | the browser gate inspects every request and response of the run for the key and counts the sightings |
| `P2-FR-04` | `consoleInbox` over `listDrafts` | `test/v1p2-console.test.ts` — an empty deployment has an empty inbox; the browser gate counts the rows against the captures it made |
| `P2-FR-05` | `consoleDraft` | `test/v1p2-console.test.ts` — every section, both previews; the browser gate reads the panels off the page |
| `P2-FR-06` | `console/app.ts` writes `textContent` and creates elements | the browser gate plants a `<script>` title and an `onerror` step and asserts neither ran and no element was created; `test/v1p2-console.test.ts` asserts the property over the source |
| `P2-FR-07` | `reviseDraft`, reached through the console route | `test/v1p2-console.test.ts` — new id, new digest, parent untouched, both previews re-run; the browser gate edits through the page |
| `P2-FR-08` | `decideDraftInTx` | `test/v1p2-console.test.ts` — revision, digest, actor, role and clock; the browser gate reads them back out of the audit |
| `P2-FR-09` | `approvalEligibility`, called by the renderer AND before the write | `test/v1p2-console.test.ts` — the verdict is a field and the write is refused `412` when the control is bypassed |
| `P2-FR-10` | the reason column, its CHECK, and `redact` | `test/v1p2-console.test.ts` — no reason and a blank reason refused, a planted credential redacted, the revision preserved |
| `P2-FR-11` | the server computes the verdict; the page renders it | `test/v1p2-console.test.ts` and the browser gate — the disabled control and the `412` are the same rule |
| `P2-FR-12` | the three contracts carry a `contract` field and structured columns | `test/v1p2-console.test.ts` — the audit's field set; the client refuses a payload of another contract version |
| `P2-FR-13` | `checkOrigin`, `checkCsrf`, `UNIQUE(draft_id)` and the existing idempotency | `test/v1p2-console.test.ts` — five refusals and one acceptance; the browser gate submits from a real second origin |
| `P2-FR-14` | nothing is written to any browser store | the browser gate dumps `localStorage`, `sessionStorage`, `document.cookie`, the Cache API and IndexedDB after the whole workflow |
| `P2-FR-15` | the console is a second channel, not a change to the first | `test/v1p2-console.test.ts` — every P1 draft surface with a key; the browser gate calls the M2M surface while a session is live |

Invariants: `INV-01` — one registry, one service layer, reached two ways.
`INV-04` — above. `INV-05` — the three contracts are versioned and columnar, and
the audit is the union of two tables over one field set. `INV-06` — an edit
appends and a decision names an exact revision and digest. `INV-08` — the
migration is additive and reversible and the existing surfaces answer as they
did.

## 4. The eligibility rule, stated exactly

What is delivered: a draft whose STORED semantic or security review carries a
non-zero `blocking_count` cannot be approved, and the refusal is the server's,
not the page's. The counts are the ones P1's compiler computed when the revision
was made and stored beside it — this phase adds no second opinion about what is
blocking.

What is not promised: that the compiler's idea of blocking is complete. A finding
the P1 compiler does not raise is a finding this gate does not stop, and that
limit belongs to `v1/P1-CAPTURE-DRAFT.md` where the compiler is described. What
P2 adds is that the answer it does have cannot be walked around.

The rule's order is part of it: a decided draft reports `ALREADY_DECIDED`
whatever its findings say, and a revision that is not the head reports
`NOT_LATEST_REVISION` — so an owner who read revision 2, edited to revision 3 and
then approved a stale tab is refused rather than approving content nobody
reviewed.

## 5. The session, stated exactly

What is delivered: a session is a row; validity is the row, its absolute expiry
and the absence of a revocation row; the cookie is `HttpOnly`, `SameSite=Strict`,
`Path=/`, `Secure` outside localhost and carries a `Max-Age` no greater than the
hour; logout and expiry are both server-side; the CSRF token is delivered in a
response body and never in a cookie; a mutation needs this origin and this
session's token.

What is not promised: channel binding. A session is bound to no IP, no user agent
and no TLS channel, so somebody who can read the cookie can use the cookie. The
mitigations are the attributes above and the short lifetime. Contract section 6.2
puts provider-infrastructure compromise outside the V1 threat model, and nothing
here claims otherwise.

Also not promised: that `Secure` is set on every deployment. It follows the
request's `Host`, because a `Secure` cookie on `http://127.0.0.1` is discarded by
the browser and the console could not be run or tested at all. A deployment
reachable at any other host gets the flag, and there is no switch to turn it off.

## 6. What P2 did NOT build

No public site, no multi-user accounts, no role model beyond the owner/admin pair
the workspace already had, no assignment (P3), no runtime launch (P4), no
marketing UI and no second registry for the frontend. The console has one screen
with three regions.

One thing an owner may reasonably expect and does not get: a CLI subcommand that
mints a login ticket. The ticket is minted with `POST /v1/console/tickets` and the
owner's API key, which is a machine-to-machine call on the server side, and the
sign-in page says so. Adding a subcommand touches the CLI's own documented
surface and its counts, which is a change to a shipped contract for a convenience
— so it is recorded here as backlog rather than done quietly.

## 7. Running it

```
npm run build:console                 # the bundle the server serves
npm start -- --port 7487              # a deployment
curl -s -X POST localhost:7487/v1/console/tickets \
  -H "Authorization: Bearer $OWNER_KEY" -H 'Content-Type: application/json' -d '{}'
# open http://localhost:7487/console/login and paste the ticket
```

`SKILLONOMIA_CONSOLE_SESSION_MS` shortens the session lifetime; a value above the
hour is refused at startup rather than clamped.

## 8. Reversal

```
sqlite3 <copy-of-the-db> < migrations/down/0014_owner_console_sessions_and_decisions.down.sql
```

Take a copy of the database file first. Reversal drops the five tables of `0014`,
which discards live sessions, outstanding tickets and the owner's decisions; the
captures, revisions and audit of `0013` and every table of the released base are
untouched. `v1/tools/gates/reversible-migration.sh` runs the round trip on a
throwaway database.
