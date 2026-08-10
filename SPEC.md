# Skillonomia — Verified Skill Package Specification

Version `0.1.0`. Licensed under Apache-2.0, together with the implementation in
this repository.

This release version has ONE source: the `version` field of `package.json`.
Every place that reports it — `GET /health`, MCP `initialize`'s
`serverInfo.version`, the CLI's `version` and `help`, the README's quickstart
transcript and this header — MUST derive from that field rather than restate it,
and a conforming build MUST report the same string on all of them.

This document specifies the **Verified Skill Package**: its layout, its archive
profile, its manifest schema, its canonicalisation and signing scheme, the
verification algorithm and its verdict vocabulary, the lifecycle and receipt
state machines, the deterministic gates a registry runs over a package, the
error model, and the API/MCP surface a conforming registry exposes.

**What this document is.** A format and protocol specification, written so that
an implementation independent of this one can produce and verify byte-identical
signatures, and can reproduce every verdict in the shipped test vectors. The
normative artefacts are embedded here verbatim and shipped in the repository:
the SQLite DDL (Appendix D, also `migrations/0001_init.sql`), the JSON Schemas
(Appendix E, also `schema/`), the executed signing vector (Appendix F), the API
contracts (Appendix H), and the test vectors under `vectors/`. Where this
document and those files disagree, that is a defect in this document.

**What this document is not.** It makes no claim that a package which verifies
is safe to run, that a package will work in an environment other than the one
it was authored in, or that the gates in §7 detect anything beyond the classes
they enumerate. `verified` is a statement about provenance, integrity and
recorded process — nothing else. See the README for the boundaries of the
implementation.

**Conformance language.** MUST / MUST NOT / SHOULD / MAY are to be read as in
RFC 2119. A rule is normative only where this document says so; the enumerated
lists in §4.1b, §4.4, §5 and §7 are exhaustive contracts, not floors.

---

## 1. Scope

**Skillonomia** is a registry for verified operational-skill packages: signed,
self-describing runbooks that an agent can adopt, together with server-written
receipts recording what happened when it did.

A **skill** is a named capability inside a workspace. A **skill version** is one
immutable, signed package of that skill. An **adoption** is one adopter taking
one version, and an **adoption receipt** is the append-only event chain that
records the outcome. A **workspace** is the tenancy boundary: every skill,
agent, key and receipt belongs to exactly one.

The unit this specification defines is the package. The registry is specified to
the extent that it is what binds a package to a timestamp, a reviewer and a
receipt — §5 through §9 and Appendix H.

**In scope:** the package format; canonicalisation and signing; verification;
the lifecycle, delivery and receipt state machines; the deterministic gates; the
human-approval matrix; the tenancy and access rules that govern visibility; the
error model; the REST and MCP surfaces.

**Out of scope:** sandbox enforcement at runtime (the format carries a declared
`sandbox_requirement`; enforcing it is the adopter's responsibility, and this
implementation does not do it for you); any cross-registry federation or
discovery; identity beyond self-attested workspace-scoped agents and the keys
they register; any economic layer.

---

## 2. Implementation profile

This section describes the profile the reference implementation in this
repository is built to. An independent implementation is conforming if it
matches §4 byte for byte and reproduces §4.4's verdicts; the choices below are
not themselves normative.

- **Language/runtime:** TypeScript, run on Node 22 or Bun. One codebase, one
  process.
- **Supported platform:** **Linux x86_64, and no other.** V1 is built and tested
  there only — the whole suite under both runtimes, the ≤600-second container
  quickstart and both packaging smokes run on a clean Ubuntu x86_64 runner, and
  the compiled binary targets `bun-linux-x64`. macOS and Windows are neither
  release artifacts nor tested hosts, so no conformance claim is made for them.

  One rule of §4.1b is the reason this is a substantive statement rather than a
  packaging note. The case-insensitive and NFC/NFD collision refusals are
  defined over the package's member names; when a package is read from a plain
  **directory**, those names come from the host filesystem, so a
  case-insensitive filesystem (default APFS/HFS+, NTFS) or a normalizing one
  cannot even hold the two members whose collision the rule refuses. Over a
  `.tar` the member names come from the archive and the rule is
  host-independent, which is why the archive form — the one the registry stores
  and serves — carries the normative behaviour. A conforming implementation on
  a case-insensitive host MUST still refuse the collision in archive form; its
  behaviour when reading such a package from a directory is unspecified.
- **Storage:** SQLite in WAL mode, one database file per instance. No external
  database.
- **Surfaces:** an MCP server (streamable HTTP) as the primary contract, a REST
  mirror of the same fourteen operations, and a local read-mostly dashboard —
  all served by the same process. Adapters carry no logic; both surfaces call
  one internal service layer, which is why they answer identically, including
  their errors.
- **Crypto:** Ed25519 (RFC 8032), SHA-256, and RFC 8785 JCS canonicalisation.
  No blockchain, no DID resolution.
- **Build inputs are content-addressed.** A registry that signs other people's
  packages has to be able to say what its own build contained. The container
  base image is referenced by digest, never by tag; the CI actions are pinned to
  commit SHAs (`ci/pin-actions.sh`), and any that are not yet pinned carry an
  explicit marker rather than passing for pinned; both lockfiles are enforced by
  the install (`npm ci`, `bun install --frozen-lockfile`) and re-checked for
  silent rewriting; and both build outputs — the plain-JS entry point and the
  compiled Linux binary — are byte-reproducible on one host, which CI asserts by
  building each twice and comparing hashes. `test/supply-chain.test.ts` holds
  the offline half of this and refuses a base image on a tag.
- **Distribution:** four packaging paths, all produced from a checkout of this
  repository — a container image built from the repository's `Dockerfile`, a
  Node ≥22.6 entry point (`npm start`, which is `src/cli.ts serve`), an npm
  tarball built by `npm pack` and installed **from the file**, and a compiled
  Linux x86_64 binary (`npm run build:binary`). **V1 publishes no
  artifact to a public registry**: there is no npm package and no container
  image under this project's name, and no documented command may depend on one
  existing. Packing a tarball locally and installing it from disk is not a
  publication and depends on no registry. The `npx` and `docker pull` forms
  become documentable when a release is actually published, and not before.
- **Command line:** ONE executable with subcommands, shared by every packaging
  path, so each path exposes all of them:
  - `serve [--port N] [--data DIR] [--host H]` — run the registry. A bare
    invocation with no subcommand serves, which is what the container image's
    default command relies on.
  - `verify <package> [<registry-db>] [--db PATH] [--json]` — the §4.4
    algorithm over a package directory, `.tar` or `.tar.gz`.
  - `verify-log [<registry-db>] [--db PATH] [--json]` — the §4.4 chain walk.
  - `version` — the release version. `help` — the subcommand list.

  The registry database of `verify` and `verify-log` comes from `--db`, from a
  trailing positional, or from `<SKILLONOMIA_DATA>/skillonomia.db` — the file
  `serve` opens, so `skillonomia verify ./pkg` checks against this deployment.
  Both print a human report by default and one line of JSON under `--json`; a
  failed check writes its report to stderr, a successful one to stdout. The
  `--json` line of `verify` is the verdict envelope of §4.4 verbatim —
  `{"verdict", "detail"?, "manifest_hash"?, "successor_version_id"?,
  "revocation_reason"?}` — and the `--json` line of `verify-log` is the chain
  walk's own outcome, `{"ok", "checked", "failed_seq"?, "reason"?}`, plus
  `"registry"` naming the database file that was walked, since the default is
  resolved from the environment and a report of an audit has to say what it
  audited.

  **Exit codes are three-valued and load-bearing.** `0` the check succeeded —
  which includes the §4.4.8 warning verdicts `valid_superseded`,
  `valid_deprecated` and `valid_but_key_since_revoked`, because those ARE
  verifications that succeeded and the caller reads the verdict to decide what
  to do about them. `1` the check failed, or the tool could not run it. `2` the
  invocation was wrong: an unknown subcommand or option, a missing value, a
  package or registry that is not there. A caller can therefore distinguish
  "this package does not verify" from "you called me wrong", which a single
  non-zero code cannot.

Two properties of the implementation are load-bearing for the specification and
are stated here because §4–§6 depend on them:

- **Server timing authority.** Every timestamp that feeds a trust decision is
  assigned by the server at registration time, in milliseconds, with a ULID
  tiebreak. Client-declared timestamps may be stored but are never trusted for
  ordering or for verdicts. §4.4 step 7 and §5.3 both rest on this.
- **Actor from authentication, never from payload.** The acting agent is derived
  exclusively from the authenticated context. An actor field in a request body
  cannot select a different agent.

---

## 3. Data model

**This section is an overview. The normative schema is the executable SQLite DDL
in Appendix D**, which is shipped as `migrations/0001_init.sql` and is asserted
byte-identical to Appendix D.1 by a test in this repository. It sets
`PRAGMA foreign_keys=ON` and carries explicit types, `NOT NULL`/`CHECK`
constraints and defaults, foreign keys with `ON DELETE`, unique constraints,
indexes, INSERT-only triggers, and tenancy-consistency triggers.

All `id` columns are ULIDs. All timestamps are server-assigned `*_at_ms`
integers (epoch milliseconds). The ordering key everywhere is
`(created_at_ms, id)` — never a seconds-precision time alone. Receipt-event
order uses `event_seq`, and only `event_seq` (§5.3).

The tables group as follows:

- **Identity and tenancy** — workspaces, agents, workspace memberships with a
  role, API keys stored as hashes, and signing keys bound to an agent by `kid`.
- **Skills and packages** — skills, immutable skill versions with their manifest
  hash, content hash, blob reference and detached signature, lint reports,
  reviews, attestations, approvals and grants.
- **Adoption delivery** — adoption requests, which are the one mutable machine
  in the model because the lease compare-and-swap of §5.2 requires `UPDATE`.
  One row is one queued notification, of the kind its `notification_kind` names
  (§5.2): an adoption notification, or a surface-11 revocation notice.
- **Receipts and transparency** — adoption receipts, receipt events and the
  hash-chained transparency log. These are INSERT-only, enforced by triggers:
  an `UPDATE` or `DELETE` against them raises, it does not silently succeed.
- **Operational** — webhooks and their delivery status, idempotency keys, and an
  activity log.

Appendix D.2 enumerates the negative probes that the constraints above are
expected to fail, and this repository executes every one of them as a test.

---

## 4. The Verified Skill Package

The package is a signed directory or archive whose ergonomics deliberately match
the Anthropic Skills folder format (`SKILL.md` at the root) so that existing
tooling can read it, while `skill.json` carries the verified metadata that
format does not have.

### 4.1 Package layout

```
<slug>/
  SKILL.md            # human/agent-readable runbook (Procedure group rendered)
  skill.json          # canonical manifest — the signed artifact
  fixtures/           # optional deterministic fixtures
  scripts/            # optional helper scripts (subject to shell lint)
  evidence/           # redacted receipts, test outputs (per redaction level)
  SIGNATURE.jws       # detached JWS (Ed25519) over JCS(skill.json) — see 4.3
```

### 4.1b Archive profile (normative)

A package archive takes one of three forms: a plain directory; a tar (POSIX
ustar/pax); or a gzip-compressed tar, carried as `.tar.gz` or `.tgz`. The
following rules are enforced by both the packer and the verifier. Every rule
below fails with `MALFORMED_ARCHIVE` except those under *Limits*, which fail
with `LIMIT_EXCEEDED`.

**Path rules.** Paths are relative, UTF-8, NFC-normalized, and use POSIX
separators. Forbidden: an empty path; a path whose bytes are not well-formed
UTF-8; a path carrying a control character (U+0000–U+001F or U+007F–U+009F); a
backslash; a leading `/`; a Windows drive-letter or device prefix, i.e. any path
matching `^[A-Za-z]:`; a `..` segment; a `.` segment; an empty segment, which is
a leading, doubled or trailing `/`; and a path that is not NFC.

**Entry rules.** Forbidden: symlinks; hardlinks between two members of the same
package, identified by `(device, inode)` in the directory form — a link count
above one is not itself a violation, because the other name may lie outside the
package; device, FIFO and socket entries; duplicate members; and
case-insensitive or NFC/NFD collisions between any two paths. Directory entries
take part in duplicate- and collision-accounting exactly as files do. Only
regular files are hashed into `integrity`; file mode bits are ignored for
hashing.

**Tar structural rules** (tar and gzipped-tar forms). A header is admitted only
if: its stored checksum equals the sum of its 512 bytes with the checksum field
read as eight spaces; its magic is exactly `ustar\0` and its version exactly
`00`; every numeric field is octal — `mode`, `size` and `checksum` non-empty,
`uid`, `gid`, `mtime`, `devmajor` and `devminor` optionally blank and then read
as zero; its `name`, `prefix`, `linkname`, `uname` and `gname` fields decode as
well-formed UTF-8; and `linkname` is empty on a regular-file or directory entry.
Only typeflag `0`/`\0` (regular file) and `5` (directory) carry a member;
typeflags `1`, `2`, `3`, `4`, `6` and `7` are the forbidden entry kinds above,
and the GNU extensions `L` (long name) and `K` (long link) are refused as
outside the POSIX profile. An entry whose declared size would run past the end
of the archive makes the archive truncated, and it is refused. A directory
header's `size` is an allocation hint and never advances the reader. The archive MUST end with the 1024-byte
end-of-archive marker — two consecutive all-zero 512-byte blocks — and after the
marker only zero padding may follow; a missing marker and any non-zero byte
after it are both refused.

**Pax rules.** A pax extended header (`x`) describes the file header
immediately following it: two extended headers in a row are refused, and an
extended header not followed by a file header is refused. Its payload MUST
carry at least one record, each of the form `<len> key=value\n` where `<len>` is
a decimal count of the record's own bytes, the record ends on that newline, and
a `=` is present. The recognized keys are `path`, `comment`, `mtime`, `atime`,
`ctime`, `uid`, `gid`, `uname`, `gname`, `charset` and `hdrcharset`, plus
`size`; any other key — `linkpath`, `GNU.sparse.*` and the rest — is refused
rather than ignored. `uid` and `gid` values MUST be decimal integers, `mtime`,
`atime` and `ctime` decimal numbers with an optional fractional part. An empty
value deletes the attribute. A `path` record replaces the entry's name and is
then subject to the path rules above in full. A `size` record is admitted only
when it equals the `size` of the ustar header it describes; a disagreeing
override is refused, because it is the one construct that makes two readers see
different bytes. A pax global header (`g`) may carry a non-empty value only for
`comment`, `mtime`, `atime`, `ctime`, `uid`, `gid`, `uname`, `gname` and
`charset` — keys that neither rename an entry nor change how its bytes are read;
any other key with a non-empty value is refused, while a record deleting a
recognized key is a no-op.

**Limits.** ≤ 512 files, ≤ 64 MiB uncompressed total, ≤ 4 MiB per file. For the
gzip-compressed form the decompressed output is capped at 65 MiB (the 64 MiB
total plus 1 MiB of headroom) and the decompression ratio — output bytes divided
by input bytes — at 100:1; exceeding either is `LIMIT_EXCEEDED`, while a gzip
stream that fails to decompress at all is `MALFORMED_ARCHIVE`.

Sort order of the `integrity` list is byte-wise ascending over UTF-8 path bytes.
The adversarial vectors TV-11a…f (§4.5) cover Zip-Slip (`../`), absolute paths,
symlinks, duplicate members, case collisions and a pax `path` override that
hides a traversal behind multi-byte records.

Two properties of this profile are worth stating explicitly, because they bound
what conformance means.

1. **The list above is exhaustive.** The rules a conforming implementation must
   enforce are exactly the ones enumerated in this subsection. Full POSIX
   ustar/pax conformance and full Unicode conformance beyond those rules are
   out of scope. Refusing input this subsection does not forbid is a defect of
   equal weight to accepting input it does forbid: the profile is a fixed
   contract, not a floor.

2. **Normalization and case folding are pinned to committed data.** The NFC
   requirement and the case-collision rule are evaluated against Unicode tables
   committed in this repository, never against the host runtime's tables.
   Runtimes ship different ICU versions — Node 22 carries Unicode 17, Bun 1.3
   carries Unicode 15.1 — and they disagree on both, which would otherwise make
   one package verify differently depending on where the verifier runs. **The
   pinned version is Unicode 14.0.0.** It is recorded as `UNICODE_VERSION` in
   the generated table `src/unicode-tables.ts`, which carries the canonical
   decompositions and the Unicode default full case foldings (Turkic-only
   mappings excluded) that the two rules are evaluated against, and it may be
   raised by regenerating that table (`tools/gen-unicode-tables.ts`). Code
   points outside the pinned repertoire are **not** rejected: they carry no
   canonical decomposition in that data, so they pass through both rules
   unchanged. A collision that
   only newer data would reveal is an accepted, documented limit of the pinned
   version — the profile trades that narrow miss for a verdict that is the same
   everywhere.

### 4.2 Manifest field groups (R = required, O = optional)

**The normative contract is the complete JSON Schema 2020-12 in Appendix E** —
exact property names, types, formats and bounds, with
`additionalProperties: false` at every level. The only extension point is the
designated `x_ext` object. This subsection is the field-group overview.

- **Identity:** R: `skill_id`, `semantic_version`, `title`,
  `capability_statement`, `owner`, `author_agent`, `created_at` (informational;
  server registration time governs), `license`, `access_policy`.
  O: `did_vc_binding` (reserved), `external_aliases`.
- **Scope:** R: `problem_class`, `non_goals`, `prerequisites`, `risk_level`
  (`low|medium|high`), `required_approvals`. O: `persona`, `maturity_tier`.
- **Runtime:** R: `model_compat`, `runtime_compat`, `tool_compat` — each a list
  of matchers `{id: string, range: range}` (e.g.
  `{"id":"claude-code","range":">=2.0.0"}`); `os[]`, `shell[]` (enum lists),
  `cloud_iam_assumptions`, `mcp_dependencies[]` (each an MCP registry ID plus a
  pinned exact version). O: `a2a_agent_card_refs`.
  - *Environment descriptor* (adopter side, same schema family):
    `{runtime:{id,version}, model:{id,version}, tools:[{id,version}], os, shell,
    sandbox_capable:bool}`.
  - *Match algorithm (normative):* `os`/`shell` are set membership;
    `runtime`/`model` require the adopter's `{id,version}` to satisfy at least
    one matcher's `id` and `range`; `tools` requires every entry of the
    Procedure group's `tools_used[]` to be satisfied by the adopter's `tools[]`
    (id match plus range). In every `id` comparison the literal `any` is a
    wildcard: a `model_compat`, `runtime_compat` or `tools_used[]` matcher whose
    `id` is `any` matches whichever actor the clause is evaluated against, and
    only its `range` still has to be satisfied. The result is one of exactly two
    outcomes, `match` when every clause is met and `mismatch` when any clause is
    unmet; a `mismatch` is returned as a warning at `risk_level: low` and blocks
    adoption when `risk_level` is medium or high. A mismatch names the unmet
    clauses in the fixed clause order `os`, `shell`, `runtime`, `model`,
    `tools` — the order this list evaluates them in, not the order of anything
    in the manifest.
  - *Range profile (normative).* "Semver range" is not a citation of any
    library: two implementations must agree, so the accepted grammar is exactly
    the following, and **a range outside it is UNMET, never a match** — the same
    deny-by-default posture §7.1 takes.

    | Form | Meaning |
    |---|---|
    | `*`, `x`, `any` | satisfied by any parseable version |
    | `1.2.3` or `=1.2.3` | exactly that version |
    | `>=1.2.3`, `>1.2.3`, `<=1.2.3`, `<1.2.3` | the stated comparison |
    | `^1.2.3` | not below `1.2.3`, and the same MAJOR — except when the bound's major is `0`, where the same major AND the same minor are required |
    | `~1.2.3` | not below `1.2.3`, and the same major AND minor |
    | a PARTIAL bound in any of the forms above | the missing components are `0`: `>=2` and `>=2.0` both mean `>=2.0.0` |

    A version is `MAJOR.MINOR.PATCH` with an optional `-prerelease` suffix. The
    adopter's declared version is an exact fact and MUST carry all three
    components. The BOUND of a comparator form may carry one, two or three: the
    missing ones are zero-filled, which is the universal semver reading of a
    partial bound. Zero-filling happens BEFORE the form's rule is applied and
    never after, so `~2` is `~2.0.0` and fixes major and minor both — narrower
    than the reading some libraries give `~<major>`, and `^2` is the form that
    means "the same major". A narrower range can only refuse an adoption, never
    admit one it should not, which is the direction this profile errs in
    throughout.

    Comparison is numeric over the three components only. **A prerelease suffix
    is accepted by the grammar and IGNORED in the comparison, and this DIVERGES
    from semver 2.0.0 precedence deliberately:** under this profile `1.0.0-rc1`
    and `1.0.0` compare equal, so `1.0.0-rc1` satisfies `>=1.0.0`, where semver
    orders the prerelease BELOW its release and would not. V1 keeps the simpler
    rule rather than half-implementing precedence; a package that must exclude
    prereleases pins an exact version. This is recorded as a known V1 divergence,
    not as an oversight.

    A compound or union range — `>=1.0.0 <2.0.0`, `1.0.0 || 2.0.0` — is not a
    form of this profile: it is unmet, and at `risk_level` medium or high it
    therefore BLOCKS. A declaration that wants an upper bound writes `^` or `~`,
    which carry one. Leading and trailing whitespace around a range is stripped
    and nothing else is. An unparseable VERSION on the adopter side is likewise
    unmet, and an empty matcher list is unmet: there is no matcher to satisfy.
- **Procedure:** R: `steps[]`, `expected_outputs`, `validation_gates`,
  `rollback`, `failure_modes[]`, `tools_used[]`. O: `scripts[]`,
  `deterministic_fixtures[]`.
- **Evidence (author-known part, signed):** R: `summary`, `test_results`,
  `redaction_level`. O: `signed_trace_hash`, `benchmark`,
  `third_party_attestation`.
- **Safety:** R: `forbidden_actions`, `secrets_policy`, `dependency_manifest`,
  `url_allowlist`, `sandbox_requirement`. O: `slsa_intoto_provenance`,
  `sigstore_signatures`.
- **Lifecycle (author-known part, signed):** R: `supersedes` (nullable).
  O: `dispute_state` intent note.

`failure_modes` is required, and a package declaring an empty one draws a lint
WARN. `tools_used[]` is required because it is the input to the tools clause of
the match algorithm above.

**Registry-side groups are not in the signed manifest** — they are served in API
responses only:

- *Lifecycle-registry:* `state`, `superseded_by`, `deprecation_date`,
  `revocation_reason`. These are unknowable at signing time and mutate after
  publication; putting them in `skill.json` would break the signature on every
  transition. Only the author-known `supersedes` is signed.
- *Evidence-registry:* `receipt_ids[]`, `reviewer_notes` (an array of strings,
  per Appendix E.2). Receipts are associated
  to a version by the registry after adoptions occur, and are never part of
  `manifest_hash`.
- *Reputation:* adopter ratings, outcome counts, observed failure modes. An
  author must not sign their own reputation.

### 4.3 Signing profile

Byte-precise. Two independent implementations MUST produce identical signatures;
every intermediate value of the executed vector is in Appendix F.

1. `M` = JCS bytes (RFC 8785, UTF-8) of `skill.json`. The file contains only the
   signed groups of §4.2; registry-side groups never appear in it.
2. `skill.json.integrity` = a list of `{path, sha256}` (lowercase hex) for all
   regular package files per §4.1b, **excluding `skill.json` itself and
   `SIGNATURE.jws`**, sorted byte-wise over UTF-8 path bytes. `content_hash`
   (a registry column) = lowercase-hex SHA-256 over the JCS bytes of that list.
   `manifest_hash` = **lowercase-hex SHA-256(M)**.
3. `D` = the raw 32-byte SHA-256(M).
4. Protected header bytes `P` = exactly the UTF-8 of
   `{"alg":"EdDSA","kid":"<kid>"}` — JCS order, no other members; `b64` is not
   present, so payload encoding is standard base64url; **unprotected headers are
   forbidden**.
5. The JWS signing input = ASCII( BASE64URL(P) + "." + BASE64URL(D) ).
   BASE64URL is always unpadded.
6. `SIGNATURE.jws` = **compact detached serialization**:
   `BASE64URL(P) + ".." + BASE64URL(sig)`, where `sig` is the Ed25519 signature
   over the signing input, made by the key registered under `kid`.
7. Key encoding: a signing key's `public_key_ed25519` is BASE64URL of the raw
   32-byte Ed25519 public key — 43 characters, unpadded.
8. **Key-to-author binding.** A `kid` is registered to exactly one agent in one
   workspace and is unique there. Verification resolves `kid` to the signing key
   of the manifest's `author_agent`; a `kid` that resolves to a different agent
   is not a valid signature for that manifest, it is `UNKNOWN_KEY`. A signature
   therefore binds the package to a registered author, not merely to a key.
9. The registry countersigns on publication: a transparency-log entry binds
   `manifest_hash` to server time. That entry, and not the author's `created_at`,
   is the trusted timestamp, and it is the reference point for key-revocation
   verdicts in §4.4 step 7.

### 4.4 Verification algorithm (normative)

Shipped as the `skillonomia verify <package>` subcommand (§2) and as the
stateless surface in Appendix H row 4.

1. Parse `skill.json`; validate against the JSON Schema
   (fail → `INVALID_SCHEMA`). A missing `skill.json`, a `skill.json` that is not
   strictly-decodable UTF-8 or not strict JSON, and a manifest that cannot be
   canonicalized per §4.3.1 all fail the same way.

   1b. Check that `SKILL.md` is present at the package root, as §4.1 requires
   (fail → `INVALID_SCHEMA`, detail `SKILL.md missing at package root`). This
   step runs after schema validation and before the integrity comparison; it is
   lettered, not numbered, so that the step numbers the rest of this document
   refers to stay fixed.
2. Recompute the file manifest with the exclusions of §4.3.2 and compare it to
   `integrity` (fail → `TAMPERED_CONTENT`).
3. Read `SIGNATURE.jws` and take `kid` from its protected header, then resolve
   that `kid` to a signing key of `author_agent` **regardless of revocation
   status** (unknown or foreign `kid` → `UNKNOWN_KEY`). Revocation is not
   evaluated here; it is a timing question, decided in step 7. A `SIGNATURE.jws`
   that is missing, or present but not parseable as the §4.3.6 compact detached
   form, fails as `BAD_SIGNATURE` and not as `INVALID_SCHEMA`: there is a
   signature slot and what is in it does not verify. This is the one part of
   §4.1's layout whose absence is a signature failure rather than a schema one.
4. Verify the JWS per §4.3 (fail → `BAD_SIGNATURE`).
5. Query the registry for the version state: `verified` or `published` →
   proceed; `revoked` → verdict `revoked`, with the reason; `superseded` →
   `valid_superseded` (warning class, successor id attached); `deprecated` →
   `valid_deprecated` (warning class); any other state → `not_verified`.
6. Check transparency-log inclusion of `manifest_hash` (fail → `NOT_LOGGED`).
   **Inclusion is a `countersign` entry and nothing else:** the entry MUST have
   `event_kind = countersign` AND `subject_id = manifest_hash`. Matching on
   `subject_id` alone is FORBIDDEN. `subject_id` is one column shared by three
   namespaces (a manifest hash, a `skill_version_id`, a `kid` — see the table
   below), so a row of any other kind that happens to carry this hash in that
   column proves nothing about whether the registry ever countersigned this
   package. The `kid` namespace in particular is caller-chosen, which is why
   §6.1 additionally forbids a `kid` of the manifest-hash shape: the two rules
   are independent, and either alone would still be a verdict resting on an
   attacker-writable row.
7. Decide key-revocation timing against the countersign entry from §4.3.9:
   key never revoked → `valid`; key revoked **strictly after** countersign time
   (`revoked_at_ms > server_at_ms`) → `valid_but_key_since_revoked`; key revoked
   **at or before** countersign time (`revoked_at_ms ≤ server_at_ms`) →
   `invalid_key_revoked_at_signing`; no server-registered countersign available
   → `unverifiable_timing`. The key is the one the principal registered for
   itself through §6.1, and `revoked_at_ms` is what §6.1's revocation stamps —
   which is why that time, once written, never moves: it would change verdicts
   already given.
8. **Verdict vocabulary — the complete set:** `valid` · `valid_superseded` ·
   `valid_deprecated` · `valid_but_key_since_revoked` · `unverifiable_timing` ·
   `not_verified` · `revoked` · `invalid_key_revoked_at_signing`, plus the
   failure codes raised by steps 1 through 6 and §4.1b: `INVALID_SCHEMA` ·
   `TAMPERED_CONTENT` · `UNKNOWN_KEY` · `BAD_SIGNATURE` · `NOT_LOGGED` ·
   `MALFORMED_ARCHIVE` · `LIMIT_EXCEEDED`.

`valid` means: the archive conformed, the manifest validated, the content hashes
matched, the signature verified under a key bound to the declared author, the
manifest hash was in the transparency log, and the key was not revoked at
countersign time. It does not mean the package is safe to execute.

**`CHAIN_BROKEN` is not one of the verdicts above.** It is the outcome of a
different check on a different subject — the registry's `transparency_log`, not
a package — and is shipped as the `skillonomia verify-log` subcommand (§2).
That check walks
every row in ascending `seq` and recomputes the chain:

- `prev_hash` of the first row is `GENESIS_PREV_HASH`, 64 `0` characters (32
  zero bytes); every later row's `prev_hash` MUST equal its predecessor's
  `this_hash`.
- `seq` MUST start at 1 and increase by exactly 1, with no gap.
- `payload_hash` = lowercase-hex SHA-256 over the JCS bytes of the entry's
  payload.
- `this_hash` = lowercase-hex SHA-256 over the concatenation of the raw 32
  bytes of `prev_hash` and the raw 32-byte SHA-256 of the UTF-8 JCS bytes of
  `{seq, event_kind, subject_id, payload_hash, server_at_ms}`. Each row's stored
  `this_hash` MUST equal that recomputation.

The two outcomes are an intact chain and `CHAIN_BROKEN`; the latter is reported
with the `seq` at which the walk failed and which of the three rules broke. A
verifier examining a package never emits `CHAIN_BROKEN`, and `verify-log` never
emits a package verdict.

**`verify-log` MUST open the database read-only.** It is an audit of an existing
deployment — often of a snapshot of one — and the subject of an audit must not
be modified by it. Concretely: the connection is opened with
`SQLITE_OPEN_READONLY`, no migration is run (the walk reports on the schema it
finds; a database older than the running build is a fact about the deployment,
not something a read-only command may change), and the ordinary serving pragma
`journal_mode=WAL` is NOT issued. That pragma is a header write; on a snapshot
taken with `sqlite3 .backup` — which lands in DELETE journal mode — issuing it
either fails outright on a read-only file or silently converts the artifact
under audit on a writable one. The refusal must come from the open flag rather
than from the caller's discipline, because on a database already in WAL mode the
same pragma is a silent no-op and no caller would ever be told it was writing.

One consequence belongs to SQLite and is not a defect: reading a WAL database
requires a shared-memory index, so the DIRECTORY holding a WAL snapshot must be
writable even when the database file is not. A snapshot in a wholly read-only
directory is copied somewhere writable first.

`event_kind` is not a closed set — the chain rules above are what the log
guarantees, and they hold for any kind. **The kinds V1 writes are exactly these
nine:**

| `event_kind` | Written by | `subject_id` |
|---|---|---|
| `countersign` | §4.3.9 publication (surface 12) — load-bearing for §4.4 step 7 | `manifest_hash` |
| `reviewer_attestation` | an `approve` verdict (surface 3) | `skill_version_id` |
| `version_verified` | the `verified` transition (surface 4) | `skill_version_id` |
| `approval_recorded` | the §7.3 approval recorder (`skill.approve`) | `skill_version_id` |
| `version_superseded` | surface 10 | `skill_version_id` |
| `version_deprecated` | surface 13 | `skill_version_id` |
| `version_revoked` | surface 11 | `skill_version_id` |
| `signing_key_registered` | §6.1 signing-key registration | `kid` |
| `signing_key_revoked` | §6.1 signing-key revocation | `kid` |

§4.4 step 6 tests INCLUSION of a `manifest_hash` **by the `countersign` kind**,
so entries whose subject is a version id or a kid neither satisfy nor disturb
it. That is a property of the step's predicate, not of the three namespaces
being naturally disjoint: `skill_version_id` is a ULID and can never collide
with a 64-hex hash, but `kid` is chosen by the principal registering it and
D.1's charset `[a-z0-9-]` contains `[0-9a-f]`. §6.1 therefore closes the kid
namespace against the manifest-hash shape as well. A registry that filtered on
`subject_id` alone would hand `valid` to any package for which an attacker had
registered a signing key named after its manifest hash.

Because step 6 demands the `countersign` entry, a package that reaches step 7
always has one. `unverifiable_timing` therefore stays in the §4.4.8 vocabulary —
that vocabulary is a closed contract consumers switch over, not an inventory of
reachable paths — while an implementation of step 7 keeps the branch as the
backstop that makes step 7 true on its own terms.

### 4.5 Test vectors

The vectors ship in this repository under `vectors/` and are executed from disk
by the suite, so an independent implementation can run against the same bytes.
Each vector directory carries its inputs — a `package/` directory or a
`package.tar`/`package.tar.gz` — plus an `expected.json` of the form
`{vector, description, expected_verdict}`, with an additional `registry` object
where the verdict depends on registry state (version state, revocation reason,
or whether the key was revoked before or after countersign). The intermediates
of the signing scheme — JCS bytes, digests, signing input, signature — are not
duplicated per vector: they are given normatively, once, in Appendix F, which is
TV-01 executed in full, and every other vector is built from that same
manifest.

TV-01 valid signed package → `valid` · TV-02 one byte changed in SKILL.md →
`TAMPERED_CONTENT` · TV-03 manifest fields reordered → `valid` (the JCS proof) ·
TV-04 key revoked after countersign → `valid_but_key_since_revoked` · TV-05 key
revoked before countersign → `invalid_key_revoked_at_signing` · TV-06 unknown
kid → `UNKNOWN_KEY` · TV-07 schema-invalid manifest → `INVALID_SCHEMA` ·
TV-08 revoked version → `revoked` · TV-09 superseded version →
`valid_superseded` · TV-10 hash-chain break → `CHAIN_BROKEN`, raised by
`verify-log` and not by the package verifier (§4.4) ·
TV-11a `../` path → `MALFORMED_ARCHIVE` · TV-11b absolute path →
`MALFORMED_ARCHIVE` · TV-11c symlink member → `MALFORMED_ARCHIVE` ·
TV-11d duplicate member → `MALFORMED_ARCHIVE` · TV-11e case-collision paths →
`MALFORMED_ARCHIVE` · TV-11f pax `path` override carrying a traversal behind
multi-byte records → `MALFORMED_ARCHIVE` · TV-12 decompression bomb →
`LIMIT_EXCEEDED`.

"All vectors green" means TV-01 through TV-12 inclusive, TV-11a through TV-11f
included.

---

## 5. Lifecycle, delivery and receipt state machines

### 5.1 Package lifecycle

The registry enforces a transition whitelist:

```
draft → linted → reviewed → verified → published
published → deprecated | superseded | revoked
verified|published → (new version) draft…            -- improvement loop
```

**The gate for `verified` is a conjunction of exactly four conditions**, enforced
by the tool and not by documentation:

1. **≥ 1 adoption receipt for this `skill_version_id`** whose terminal event is
   `adopted` and whose `evidence_json` validates against this version's
   declared `validation_gates` under the Appendix E.2 `evidence-v1` rule. A
   `failed` receipt, or a receipt that never reached a terminal event, does not
   count. The evidence is validated at append time (§5.3) AND re-validated
   here, against the same one implementation, so the two readings cannot drift.
2. **≥ 1 reviewer attestation** that CORRESPONDS to an approve verdict. Not
   merely an `attestations(kind='reviewer')` row: surface 3 writes the review
   and the attestation in one transaction and the attestation carries the
   `review_id` of the review it was written with, so this conjunct follows that
   pointer and requires all of — the named review exists, it is of THIS
   version, its `reviewer_agent_id` is the attester, its verdict is `approve`,
   and the attester is STILL an eligible reviewer of this version under §5.1's
   reviewer policy, re-evaluated now and not merely at submission. An
   attestation carrying no `review_id` — which is the shape anything other than
   surface 3 would write — satisfies nothing.
3. **Complete compatibility metadata** — the Runtime group of §4.2, where
   "complete" is stronger than the schema's "present": `model_compat`,
   `runtime_compat` and `tool_compat` MUST each be non-empty and every matcher
   in them MUST carry a non-empty `id` and a non-empty `range`, and `os` and
   `shell` MUST be non-empty. An empty matcher list matches nothing (§4.2), so
   a version carrying one would make every adopter a `mismatch`.
   `cloud_iam_assumptions` and `mcp_dependencies` are required Runtime fields
   too, but are legitimately empty for most packages — for those two,
   completeness means present, not non-empty.
4. **All safety gates passed** — a COMPLETE §7.1 run, all eight gates evaluated
   in this one invocation, with no FAIL among them. A partial run is not a run:
   a missing gate result fails this conjunct rather than being read as a pass,
   and no stored result from an earlier run is consulted.

`published` additionally requires human approval whenever the §7.3 matrix
demands it. Sharing beyond the rules below is impossible at the API level before
these gates pass.

**`verified → published` has exactly one entry point** — surface 12,
`skill.publish` / `POST /v1/versions/{id}/publish`. It performs the state change
and the §4.3.9 registry countersign in a single transaction, because a published
version with no countersign has no §4.4 step-7 revocation reference time. The
generic transition path MUST refuse `published` for the same reason. The surface
is normative in these respects:

- **Actor.** Workspace role **admin/owner** of the version's workspace, the same
  minimum Appendix H fixes for the `verified` transition and for the same
  reason: the registry, not the author, decides. The author, a plain member and
  a reviewer are `FORBIDDEN` even for their own version; a cross-workspace actor
  is refused as though the version did not exist (`NOT_FOUND`), since a
  `verified` version never crosses a workspace boundary.
- **§7.3.** If the publish column of the §7.3 matrix holds for this version and
  no `approved` `publish` approval from a `type=human` admin/owner of this
  workspace exists, the call returns `FORBIDDEN` with `current_state` and
  changes nothing — no state move, no countersign. The role that MAKES the call
  and the identity that SUPPLIES the approval are separate: a service identity
  holding role admin may call, and can never satisfy the human gate.
- **Wrong state.** From any state other than `verified`, `PRECONDITION_FAILED`
  with `current_state` — including the three retired tails `deprecated`,
  `superseded` and `revoked`, which are not special: a forbidden transition
  answers `PRECONDITION_FAILED` whatever else the registry knows about the
  version. From `published`, a convergent noop: the same success body with
  `noop:true`, and no second countersign.
- **Countersign conflict.** `CONFLICT` with `current_state` is reserved for the
  one case in which the transition itself IS legal — state `verified` — and a
  §4.3.9 countersign for this version's `manifest_hash` already exists.
  `manifest_hash` carries no `UNIQUE` constraint in Appendix D.1, so a second
  version row may share it with an already-published one; publishing under a
  countersign that was appended for a different publication decision would fix
  the §4.4 step-7 revocation reference clock for a decision never made about
  this version. Legality is therefore decided BEFORE the countersign row is
  consulted, and nothing is written either way.
- **Idempotency.** As every mutating surface: optional `idempotency_key`
  (string ≤128), replay returns the persisted original response with
  `Idempotency-Replayed: true`.

**Every state reachable after `published` MUST have its own public surface.**
The three tails are not interchangeable and none of them is reachable through a
generic transition endpoint — there is none, deliberately, for the same reason
`verified` and `published` have single entry points. Each tail writes registry
state that a bare state change would omit:

| Tail | Surface | What the surface writes besides the state |
|---|---|---|
| `deprecated` | 13 `skill.deprecate` | `deprecation_date` from the registry clock + a transparency-log entry |
| `superseded` | 10 `skill.supersede` | both versions' lifecycle links, atomically + a transparency-log entry |
| `revoked` | 11 `skill.revoke` | the mandatory `revocation_reason` + a transparency-log entry + a §5.2 revocation notice queued for every active adopter |

Deprecation is the mildest of the three: the version stays visible and stays
adoptable with a warning (see the state-visibility table below). Its actor set
is therefore the revoke row of the §6 matrix — author, skill owner, workspace
admin/owner — and NOT the supersede row: the extra actor supersede admits, the
reviewer, is admitted because naming a successor is a judgement about a
replacement package, and deprecation names none. The date is stamped once; a
repeated deprecation converges on the recorded date and MUST NOT move it
forward. All three tails are terminal: nothing follows them, including a return
to `published`.

**Trial-adoption lane.** The first version of a skill cannot cite receipts that
do not yet exist. Therefore a version in state `reviewed` MAY be adopted
**workspace-internally only** — a trial adoption, with the full receipt
machinery and the §7.3 matrix applying unchanged. Receipts generated by trial
adoptions satisfy conjunct 1. Receipts are associated to the version on the
registry side, so the signed manifest never changes as receipts accrue.

**State visibility.** `verified` is an internal state: it does not make a version
externally adoptable.

| Version state | Same-workspace search/adopt | Cross-workspace/public search/adopt |
|---|---|---|
| draft, linted | owner + admins only; no adoption | never |
| reviewed | visible to members; TRIAL adoption only | never |
| verified | visible to members; internal adoption | **never** — internal-only state |
| published | yes | yes, per `access_policy` + grants |
| deprecated/superseded | visible with warning; adoption warns | visible with warning if previously published |
| revoked | listed as revoked; adoption blocked | listed as revoked; adoption blocked |

External search results and `skill.request_adoption` accept **only `published`**
versions. Because `verified → published` passes the §7.3 human-approval matrix,
a high-risk skill cannot become externally adoptable without an approval.

**Access-policy precedence.** The "members" column applies **as capped by**
`access_policy`. For `private`, read "owner + explicit agent grantees" in every
row; for `invite`, read "grantees, agent- or workspace-level"; for `workspace`
and `public`, the table applies as written. `access_policy` restricts and never
expands state-based visibility: a `reviewed` or `verified` private skill remains
invisible to non-granted members.

**Reviewer policy.** A reviewer MUST be a member of the skill's workspace, with
role reviewer, admin or owner, and MUST NOT be the version's author **nor the
skill's owner** — both are self-review, and the second is refused for the same
reason as the first even when the owner did not write this version. The two
self-review refusals are evaluated BEFORE the role check, so an author who also
holds admin cannot review their own version. A review or attestation submitted
by a non-member is rejected `FORBIDDEN`.

A review verdict applies to a version in state `linted`, or to one already
`reviewed` (a second verdict is recorded and the state does not move); from any
other state the surface answers `PRECONDITION_FAILED` with `current_state`.
`{"action":"request"}` is the author's or the skill owner's call alone — a
workspace admin who is neither is `FORBIDDEN` — and it requires state `linted`,
converging with `noop:true` on a version already `reviewed`.

**Tenancy backstops.** `skills.owner_agent_id` and
`skill_versions.author_agent_id` must belong to the resource's workspace. This
is enforced by DDL triggers, not only by application code.

**Immutability.** A version's content and manifest are frozen once it leaves
`draft`. Any change is a new `semantic_version` starting at `draft`. This is
what makes stale lint impossible: lint and review results are permanently bound
to the immutable content they examined.

### 5.2 Adoption delivery machine

Delivery is the one mutable machine in the model. A worker identity is
`lease_owner = "worker:<host>:<pid>:<ulid>"`. Workers use an internal surface
(`delivery.poll` / `renew` / `complete` / `fail`), which is process-internal and
authenticated as the service itself; it is not one of the fourteen public
surfaces.

**Normative transition table:**

| From | Event | Guard | To |
|---|---|---|---|
| — | request created | at least one §7.3 condition holds for this version | approval_pending |
| — | request created | no §7.3 condition holds | pending |
| approval_pending | §7.3 decision `approved` | approval recorded by a human approver and bound to this exact request | pending |
| approval_pending | §7.3 decision `denied` | same | dead_letter (`reason: approval_denied`) |
| pending | claim | `next_attempt_at_ms ≤ now` | leased |
| leased | complete (webhook 2xx) | caller = `lease_owner`, lease unexpired | pushed |
| leased | fail (non-2xx/timeout) | caller = `lease_owner`; `attempt_count < 5` | pending (backoff: `next_attempt = now + min(2^attempt·1s, 60s)`) |
| leased | fail | caller = `lease_owner`; `attempt_count = 5` | dead_letter (`reason: max_attempts`) |
| leased | renew | caller = `lease_owner`, lease unexpired | leased (lease extended +10s) |
| leased | reclaim (sweeper) | `lease_expires_at_ms < now` | pending (attempt_count unchanged; lease cleared) |
| pending/leased | age-out (sweeper) | request age > 10 min with no push success | dead_letter (`reason: stale_lease`) |
| **pending/leased only** | webhook dead | `webhooks.status = dead` | dead_letter (`reason: endpoint_dead`) |
| leased | endpoint missing | caller = `lease_owner`, lease unexpired; the request carries no selected endpoint | dead_letter (`reason: endpoint_missing`) |

The states are exactly `approval_pending`, `pending`, `leased`, `pushed` and
`dead_letter`; the dead-letter reasons are exactly `max_attempts`,
`stale_lease`, `endpoint_dead`, `approval_denied` and `endpoint_missing`.

**`approval_pending` is a hold, not a delivery state.** A request that the §7.3
matrix holds is created there rather than being refused, which is what breaks
the circular dependency between an approval and the request it must name: the
approval binds one `adoption_request_id`, so the request has to exist first.
While a request is held: `delivery.poll` cannot see it, because the claim query
selects `pending` alone; all three sweeper passes — reclaim, age-out and
endpoint-dead — skip it, so a hold never ages out into a delivery failure; and
`skill.adopt` refuses it with `FORBIDDEN` plus the current state. The only exit
is the §7.3 decision, which is applied in the same transaction that records the
approval, so there is no window in which an approval exists and the request is
still held, or the reverse.

**`pushed` and `dead_letter` are strictly terminal:** no transition, sweeper or
webhook-status change ever leaves them — which is why the webhook-dead row
excludes `pushed` explicitly. Precedence: the max-attempts check runs before the
stale check, and a stale `complete` from an expired lease owner is rejected with
`PRECONDITION_FAILED`.

**Endpoint selection.** At creation the request snapshots the one endpoint it
will be pushed to, in `adoption_requests.webhook_id`: at most one endpoint per
adopter is selected, from that adopter's webhooks whose status is `active` or
`failing`. An adopter with no such endpoint is not a silent no-op — the claimed
job becomes `dead_letter(endpoint_missing)`. Like every other worker-caused
transition, that one carries the live-owner CAS predicate, so a worker whose
lease has already expired and been reclaimed cannot dead-letter a request
another worker now legitimately holds.

A dead letter for `approval_denied` is a decision and is final; the other four
reasons say only that the registry could not notify this adopter.

**Normative CAS SQL:**
```sql
-- claim
UPDATE adoption_requests SET state='leased', lease_owner=?w, lease_expires_at_ms=?now+10000,
       attempt_count=attempt_count+1
 WHERE id=?id AND state='pending' AND next_attempt_at_ms<=?now
   AND attempt_count=?observed_attempt_count;          -- CAS predicate; 0 rows = lost race
-- renew (long-running push)
UPDATE adoption_requests SET lease_expires_at_ms=?now+10000
 WHERE id=?id AND state='leased' AND lease_owner=?w AND lease_expires_at_ms>?now;
-- complete / fail
UPDATE adoption_requests SET ...                        -- state per transition table
 WHERE id=?id AND state='leased' AND lease_owner=?w AND lease_expires_at_ms>?now;
```
Zero rows changed means reject: the caller must re-poll.

**Two kinds of notification, one machine.** A queued row carries
`adoption_requests.notification_kind`:

- `adoption` — the notification of an adoption request the adopter made
  (surface 6). This is what every row was before the column existed, and the
  column's default, so nothing that already existed changed meaning.
- `revocation` — a notice the registry queued because a version this adopter is
  running was revoked (surface 11, below).

Both obey every rule of the table above without exception: the same claim,
lease, backoff, dead-letter, age-out and endpoint-health behaviour. They differ
only in what the pushed body says. A `revocation` row is NOT an adoption
request: it has no `adoption_receipts` row, and `skill.adopt` answers
`NOT_FOUND` for it, because nobody requested it.

**The push.** `POST` with `Content-Type: application/json` and a JSON body of
`{kind, adoption_request_id, receipt_id, skill_version_id, adopter_agent_id,
attempt, server_at_ms}`, plus `revocation_reason` when `kind` is `revocation`
(`receipt_id` is then `null`). It carries an HMAC-SHA256
`X-Webhook-Signature`: lowercase hex of `HMAC-SHA256(secret, exact body
bytes)`, which the receiver recomputes and compares in constant time. Dead
letters are loud, not silent, and the dead-letter view names the
`notification_kind` that failed to arrive — an operator has to know which
adopter was not told what.

**Endpoint health (normative).** `webhooks.status` moves on the outcome of each
push attempt against that endpoint, and `webhooks.failure_count` counts
CONSECUTIVE failures:

| Outcome | Effect |
|---|---|
| 2xx | `failure_count = 0`, `status = active`, `last_error` cleared |
| anything else (non-2xx, timeout, or a rule-1–6 refusal) | `failure_count += 1`, `last_error` recorded; `status = failing`, or `dead` once `failure_count` reaches **5** |

`dead` is terminal: no later outcome leaves it, so a 2xx that arrives after the
fifth consecutive failure — or after the endpoint was retired by a
re-registration — cannot resurrect it. That escalation is surfaced on the
dashboard. Rotation, fan-out and per-endpoint retry tuning are non-goals: V1
selects at most one endpoint per adopter (below).

**Outbound transport requirements (normative).** The registry connects to an
address the adopter chose, so the push is constrained as follows. A refusal
under any of these rules is an ordinary delivery failure: it feeds the health
rules and the backoff exactly like a 5xx, and it is never a silent skip.

1. **`https` only.** An `http://` endpoint is not delivered to. A deployment
   MAY opt into loopback destinations for local development; that is a
   deployment decision and MUST be off by default. Appendix D.1 permits
   REGISTERING an `http://localhost` endpoint — registering one and delivering
   to one are separate decisions.
2. **The URL MUST NOT carry credentials** (`https://user:pass@host/`).
3. **Redirects are not followed.** A 3xx is the answer; since it is not 2xx the
   delivery counts as failed. Following even one hop would mean connecting to
   an address the endpoint chose after the checks had passed.
4. **Every resolved address is checked, and the refusal is all-or-nothing.**
   The forbidden set is exactly the following, and an address outside it is
   permitted:

   | Family | Forbidden ranges |
   |---|---|
   | IPv4 | `0.0.0.0/8` (unspecified/this-network) · `10.0.0.0/8` · `127.0.0.0/8` (loopback) · `100.64.0.0/10` (carrier-grade NAT) · `169.254.0.0/16` (link-local, the cloud instance-metadata address) · `172.16.0.0/12` · `192.0.0.0/24` (IETF protocol assignments) · `192.0.2.0/24` (documentation) · `192.88.99.0/24` (6to4 relay anycast) · `192.168.0.0/16` · `198.18.0.0/15` (benchmarking) · `198.51.100.0/24` (documentation) · `203.0.113.0/24` (documentation) · `224.0.0.0/4` (multicast) · `240.0.0.0/4` (reserved, broadcast included) |
   | IPv6 | `::` (unspecified) · `::1` (loopback) · `fc00::/7` (unique local, the cloud metadata address `fd00:ec2::254` included) · `fe80::/10` (link-local) · `ff00::/8` (multicast) · `100::/64` (discard-only) · `2001:db8::/32` (documentation) |
   | IPv6 carrying an IPv4 destination | IPv4-mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` are each judged by the IPv4 address they embed, against the IPv4 rows above, and are otherwise unrestricted |

   An IPv6 zone identifier (`%eth0`) names an interface, never a different
   host, and is stripped before the address is judged. If a name resolves to
   several addresses and ANY of them is forbidden, the whole name is refused —
   accepting the permitted one would leave a round-robin resolver free to
   answer with the other on the next attempt. A name that resolves to no
   address at all is refused as well. Loopback is the one class a deployment
   that has opted in under rule 1 may reach.
5. **The connection MUST go to the address that was checked.** The vetted
   address is pinned into the connection and the name is resolved exactly once;
   TLS server-name indication and certificate validation stay on the NAME.
   Without pinning, the interval between checking a DNS answer and opening the
   socket is a rebinding window, and rules 4 and 5 together are what close it.
6. **Hard deadlines** on connection establishment and on the exchange as a
   whole, and a **cap on the response body**: an endpoint MUST NOT be able to
   hold a worker slot open or stream into the registry. Exceeding the cap fails
   the delivery even if the status was 2xx.
7. **The webhook secret is never handed to the transport.** The worker resolves
   it through `secret_ref`, signs the body and passes only the resulting
   signature, so no transport — including one a deployment substitutes — can
   leak the secret into a log or an error message.

**Registration applies rules 1 and 2 as well, by PARSING the URL.** The check
that admits an endpoint at `POST /v1/webhooks` MUST be a URL parse and MUST
apply the same scheme and credential rules as the transport, from the same
code. A prefix test over the string is not sufficient and MUST NOT be used:
`https://evil.com@internal.host/` addresses `internal.host` (everything before
the `@` is userinfo) and `http://localhost.attacker.com/` is a name the attacker
controls, and both satisfy a prefix test that means to admit `https://` and
`http://localhost`. The `http://` exception Appendix D.1 grants is to a host
that IS this machine — a loopback literal or the name `localhost` — and not to
a host whose name begins with those characters.

Registration MUST NOT resolve a name: registration happens once and delivery
happens later, so a name that passed here can answer differently there, and rule
4 is evaluated at the socket, every time. An IP LITERAL cannot change, so
registration judges it under rule 4 immediately.

Appendix D.1's `CHECK` on `webhooks.url` remains a second, coarser net over the
stored value. It is a prefix test and therefore admits both strings above; it is
not the filter, and an implementation MUST NOT rely on it as one. It does narrow
what can be stored — `http://[::1]/…` and `http://127.0.0.5/…` name this machine
and D.1 does not admit them — and a URL that the parse accepts but the schema
cannot store MUST be refused as `INVALID_SCHEMA` with a reason, never surfaced
as a constraint violation.

Two further registration rules complete the surface. A URL longer than **2000
characters** is `INVALID_SCHEMA`, so an endpoint cannot be used as unbounded
storage; the value is stored **as the caller wrote it**, never re-serialized
from the parse, because an operator reading the dashboard must see the string
their adopter sent. And because V1 selects at most one endpoint per adopter,
**registering an endpoint retires that adopter's existing ones**: every other
endpoint of the same agent whose status is not already `dead` is set to `dead`
in the same transaction as the insert. A registration therefore never fans out
and never leaves two live endpoints for one adopter.

**The naming is deliberate.** The terminal success state of this machine is
`pushed`, not `delivered`. A webhook 2xx proves the endpoint answered; it does
not prove the adopter's runtime has the package. The receipt event `delivered`
(§5.3) is written only on an adopter-authenticated confirmation — the
`skill.adopt` call. The two machines share no state names and are linked only by
`adoption_request_id`.

### 5.3 Adoption receipt machine

```
receipt_events.event: delivered → attempted → adopted | failed   [ → rolled_back ]
```

- `delivered` — the adopter's runtime confirmed receipt of the package via an
  authenticated `skill.adopt`, server-timestamped. A webhook push success is not
  this event. This row CARRIES the §4.2 environment descriptor the adopter
  declared on that call, written into it in the same transaction and never
  afterwards (see "The declared environment" below).
- `attempted` — the adopter began execution.
- `adopted` — requires `evidence_json`: validation-gate output produced in the
  **adopter's** environment, from the package's own declared `validation_gates`.
  The registry validates the evidence shape against those declared gates.
  `adopted` may not skip `attempted`.
- `failed` — requires `failure_report_json`. The report is delivered to the
  author through the author's webhook and surfaced on the dashboard, and is
  appended to the version's failure-mode candidates.
- `rolled_back` — the sole post-terminal event, allowed only after `adopted`;
  requires `rollback_report_json`.

**Normative transition table.** Derived state is the event kind of the row with
the highest `event_seq` (`none` if the chain is empty). Every append goes
through one transactional function,
`append_receipt_event(receipt_id, actor, event, payload, idem_key)`, which,
inside a single SQLite transaction: (1) replays `idempotency_key` duplicates as
`noop:true`; (2) checks that the actor is the receipt's adopter, or the registry
itself for synthesis; (3) reads the derived state and applies this table;
(4) assigns `event_seq = max+1` — **`event_seq` is the only normative order**;
ULID lexicographic order within one millisecond is relied upon nowhere;
(5) validates the payload schema for the event kind.

| Derived state | Event | Result |
|---|---|---|
| none | delivered | append (seq 1) |
| none | attempted | synthesize `delivered` (seq 1, `idempotency_key="synth-delivered:"+receipt_id`, `evidence_json={"synthesized":true}`, activity-logged) + append `attempted` (seq 2), same transaction |
| delivered | attempted | append |
| delivered | failed | append (failed-before-attempted IS legal: e.g. package rejected on receipt; `failure_report_json.category` must be `pre_execution`) |
| attempted | adopted | append (requires `evidence_json` matching declared validation gates) |
| attempted | failed | append (requires `failure_report_json`) |
| adopted | rolled_back | append (requires `rollback_report_json`) |
| any | same event again (new idem key) | `PRECONDITION_FAILED` + current state (`UNIQUE(receipt_id,event)` backstops in SQL) |
| adopted/failed | the other terminal | `PRECONDITION_FAILED` + current state; a partial unique index `WHERE event IN ('adopted','failed')` backstops even under concurrent appends |
| any | anything else | `PRECONDITION_FAILED` + current state |

**Payload rules are exclusive.** `delivered` and `attempted` carry NO payload:
an append of either that names `evidence`, `failure_report` or `rollback_report`
is `INVALID_SCHEMA`, not a silently discarded field, because the registry must
never store adopter-supplied material under an event kind whose contract does
not define it. Conversely `adopted`, `failed` and `rolled_back` each require
their own payload and reject the other two the same way. Payload validation runs
BEFORE any row is written, so a rejected payload consumes neither an `event_seq`
nor an `idempotency_key`. The surface-level `idempotency_key` is passed straight
through to this function rather than being replayed at two layers; when the
caller supplies none, the registry derives a deterministic one from the receipt
id and the event kind, so a retried append of the same event on the same receipt
replays instead of colliding.

**The synthesized marker.** The `evidence_json={"synthesized":true}` written on
the auto-acked `delivered` row is a REGISTRY MARKER, not adopter evidence: it
records that no adopter ever reported that `delivered`, so a reader of the chain
— and of the `GET /v1/receipts/{id}` payload, which serializes it — can tell an
auto-ack from a real acknowledgement. It MUST be persisted; a `delivered` row
with `evidence_json` NULL means the adopter reported it. Two consequences follow
and are normative:

- The marker is NOT validated against `evidence-v1` (Appendix E.2). Evidence
  validation applies to `adopted` only; `evidence-v1` requires `gate_results`,
  which a marker has none of. The `synthesized` property is declared in
  `evidence-v1` so the marker's shape has one definition, not so the marker can
  pose as evidence — `{"synthesized":true}` alone FAILS `evidence-v1`, which is
  precisely what stops an adopter sending it in place of gate results.
- The marker never satisfies the §5.1 evidence conjunct. That conjunct reads
  `adopted` rows only; a `delivered` row carrying `evidence_json` is not
  evidence of anything and MUST NOT be counted.

**The declared environment lives on the event, and this is a defence of the
release gate rather than a matter of tidy writing.** The release gate referred
to here is this project's own dogfood acceptance criterion — a count of skills
in the library and of adoptions between agents of different runtimes. It is a
condition on the build of this reference implementation, not a requirement of
this specification, and nothing in a conforming registry depends on it; what
follows is normative because a counter that a caller can rewrite is a defect of
the data model regardless of who reads it. The environment descriptor
an adopter declares to `skill.adopt` MUST be recorded on the `delivered` row
that call writes, inside the same transaction, and MUST NOT be the authority
anywhere else. `receipt_events` is INSERT-only: no update, no delete, ordered by
`event_seq`. Three properties follow, and they are the reason for the rule.

- **The figure that gate counts cannot be moved after the fact.** Its third
  conjunct — adoptions between agents of DIFFERENT runtimes — is counted from
  `environment_descriptor.runtime.id`, and it MUST be computed from these event
  rows. Computed from a mutable column it was a reading of whoever wrote last:
  on the release instance an ordinary `skill.adopt` carrying an invented runtime
  id, sent to requests whose chains were long closed, rewrote two stored
  descriptors and moved the counter from five distinct runtimes to six — with no
  event, no error and no trace, and monotonically upward. An audit could not
  catch it, because there was nothing left to compare against. A registry MUST
  NOT compute this conjunct from `adoption_requests.requester_context_json`,
  which survives only as a denormalized cache for queries over requests.
- **The environment and the receipt belong to the same caller.** One event, one
  writer, one transaction: the row that says an adopter received the package is
  the row that says what it received it into. Previously the descriptor was
  written unconditionally before the event was attempted, so a second caller
  could replace the first caller's declaration while the first caller kept the
  chain — the two halves of one adoption describing two different actors,
  silently.
- **The adopter can verify its own declaration.** The descriptor is served back
  on `GET /v1/receipts/{id}` as `events[].environment_descriptor`, so "confirm a
  write by reading the state back" has something to read. A field no one could
  read was a field no one could notice being wrong.

Rows written before this rule existed carry no descriptor, and a `delivered` row
synthesized by the auto-ack above carries none either — nobody declared one.
Both contribute NO runtime to the cross-runtime count: fail-closed, so an absent
history is recounted rather than assumed.

**Server-side timing authority.** Every `server_at_ms` is set by the registry
clock at append time. An adopter cannot backdate an event, cannot reorder a
chain, and cannot make a receipt appear to predate the countersign that §4.4
step 7 measures revocation against. A receipt chain with no terminal event after
a configurable staleness window (default 14 days) is reported as `stalled` in
queries — derived at read time, so the INSERT-only property is preserved. The
window is measured from the `server_at_ms` of the chain's most recent event, or,
on a chain with no events at all, from the receipt's own `created_at_ms`; a
chain whose derived state is `adopted`, `failed` or `rolled_back` is never
`stalled`, because it has arrived somewhere.

---

## 6. API and MCP contracts

MCP tools are the primary surface; REST mirrors them one-to-one
(`POST /v1/skills`, and so on). There is one internal service layer, and the
adapters contain no logic. The full request/response contracts are in
Appendix H.

| # | Surface | Contract essentials |
|---|---------|--------------------|
| 1 | `skill.create` | Input: manifest draft plus files. Creates the skill (idempotent on `(workspace, slug)`) and a version in `draft`. The actor is the authenticated agent; an `author_agent` payload field must match it or the call is rejected. |
| 2 | `skill.lint` | Runs all §7.1 gates, writes `lint_reports`, and transitions draft→linted iff there is no FAIL. Returns the full report. |
| 3 | `skill.review.request` | Notifies eligible reviewers — not the author; self-review is rejected. A reviewer verdict is recorded through the same surface. `reviewed` requires ≥ 1 approve. An `approve` verdict atomically inserts the corresponding `attestations(kind=reviewer)` row in the same transaction, so the §5.1 conjunction has exactly one source of reviewer truth. |
| 4 | `skill.verify` | Checks the §5.1 four-way conjunction; on success transitions and appends a transparency-log entry. Also exposed statelessly as the §4.4 algorithm over any package blob. |
| 5 | `skill.search` | Filters: capability text, environment/runtime compatibility, tools, risk level, trust threshold, state. Returns the registry-computed Reputation group. |
| 6 | `skill.request_adoption` | Creates an adoption request (§5.2) and a receipt shell. Enforces `access_policy`; when a §7.3 condition holds, the request is created in `approval_pending` and the response names the conditions — the refusal belongs to surface 7, not here (§5.2, "`approval_pending` is a hold"). |
| 7 | `skill.adopt` | Adopter-side: compatibility check of the declared Runtime group against the adopter's environment descriptor — mismatch produces a structured warning, or a block per `risk_level` — then package handover and the `delivered` event. |
| 8 | `skill.validate_outcome` | Appends `attempted`/`adopted`/`failed`/`rolled_back` events with their payloads, per §5.3. Only the receipt's own adopter may append to it. |
| 9 | `skill.rate` | Requires an `adoption_receipt_id` owned by the rater whose terminal event is `adopted`. Ratings come only from adopters who finished. |
| 10 | `skill.supersede` | The version's author, the skill's owner, a reviewer or a workspace admin/owner creates the successor link; both versions' Lifecycle fields update atomically; transparency-logged. |
| 11 | `skill.revoke` | The version's author, the skill's owner, or a workspace admin/owner; requires a reason; takes immediate effect on `skill.verify` verdicts and on search defaults; transparency-logged. **Active adopters are notified through the §5.2 delivery machine**: in the same transaction as the state change, one `notification_kind='revocation'` row is queued per adopter holding a receipt for this version whose chain carries no `failed` and no `rolled_back` event — one notice per adopter however many receipts it holds. From there the notices are ordinary jobs: claimed, leased, retried with backoff, and dead-lettered loudly (an adopter with no endpoint gets `endpoint_missing`). A convergent re-revoke queues nothing. |
| 12 | `skill.publish` | Workspace admin/owner moves a `verified` version to `published`. The §4.3.9 registry countersign is appended in the SAME transaction — this is publication's only entry point, and the generic transition refuses `published` for that reason. Refuses with `FORBIDDEN` + `current_state` while the §7.3 publish column demands a human approval this version does not have. Republishing is a convergent noop. |
| 13 | `skill.deprecate` | Author, skill owner or workspace admin retires a `published` version without naming a successor. The registry stamps `deprecation_date` from its own clock in the same transaction and transparency-logs the retirement. The version stays visible and adoptable with a warning (§5.1). Re-deprecating is a convergent noop that does not move the recorded date. |
| 14 | `skill.create_from_dir` | The author sends a SOURCE tree — `manifest.json`, `SKILL.md` and files — and receives a signed version. The registry mints the `skill_version_id`, derives the §5 arrival marker from it, writes that marker into `SKILL.md` and into the generated `scripts/skln-arrive.sh`, refuses to pack unless both agree with the marker the id derives, computes §4.3 `integrity` over the resulting bytes and signs with a system-held key it generates for the author on first use. The author enters no cryptographic material, and none is returned. The registry reads bytes the client sent, never a path the caller named. Convergence is judged on the SOURCE, because the marker makes every packing of one source byte-different. |

Auxiliary surfaces (not numbered, fixed in Appendix H): the §7.3 approval
recorder `skill.approve` / `POST /v1/versions/{id}/approvals`, the
transparency-log read `tlog.read` — authenticated like every other call, but not
workspace-scoped, because a hash chain that only its own tenant may audit is not
a transparency log — the dashboard read `dashboard.view`, the
receipt read, the unauthenticated liveness probe, the one-time auth bootstrap
(§9.1), webhook management, and **provisioning** (§6.1). Three of those have no
MCP tool and are REST-only — the receipt read, webhook management and the
liveness probe — which is the one documented exception to the one-to-one mirror
above; every other surface, numbered or auxiliary, exists on both adapters.
§7.3 makes approval an API-level
enforcement point rather than a step of the skill lifecycle, which is why it is
auxiliary — but it IS an API path, because §6 makes "a service key passing a
human gate" a mandatory negative test on both adapters.

### 6.1 Provisioning (auxiliary, normative)

A deployment MUST be operable through its API alone. Everything §4 and §5
describe rests on three objects that no numbered surface creates: a
**principal**, its **API key**, and the **signing key** whose `kid` §4.4 step 3
resolves against `manifest.author_agent`. Without an API path to the third, a
registry can verify only the packages whose keys were installed out of band —
§4.3.8's author binding would be reachable only with database access.

Three operations close that, mirrored on MCP and REST exactly like the numbered
surfaces, and enforcing the same ACL on both.

| Operation | MCP tool | REST | Auth (min) |
|---|---|---|---|
| create a principal + issue its first API key | `principal.create` | `POST /v1/principals` | admin/owner |
| read the roster | `principal.list` | `GET /v1/principals` | member+ (own row); admin/owner (workspace) |
| issue a further API key | `principal.issue_api_key` | `POST /v1/principals/{id}/api-keys` | admin/owner |
| revoke an API key | `principal.revoke_api_key` | `POST /v1/principals/{id}/api-keys/{key_id}/revoke` | the key's principal, or admin/owner |
| register one's OWN signing key | `signing_key.register` | `POST /v1/signing-keys` | member+, self only |
| read signing keys | `signing_key.list` | `GET /v1/signing-keys` | member+ (own); admin/owner (workspace) |
| revoke a signing key | `signing_key.revoke` | `POST /v1/signing-keys/{kid}/revoke` | the key's principal, or admin/owner |

**Where the ACL comes from.** §6's matrix has no provisioning row, exactly as it
had none for `deprecate`. The nearest row is the last,
"manage grants/memberships/webhooks", which reads "own webhooks" for every
non-privileged column and "yes" for admin/owner. Creating a principal writes an
`agents` row AND its `workspace_memberships` row, so it IS membership
management and takes that row's admin/owner. Issuing and revoking that
principal's API key is the same row for the same reason: an API key is what a
membership is worth in practice. Two rules the row does not state are added
because §2's "actor from authentication, never from payload" and §4.3.8 require
them:

- **No escalation.** The created principal's role MUST NOT outrank its
  creator's, and an admin MUST NOT issue or revoke keys for an owner. Otherwise
  "admin" and "owner" are the same privilege one call apart.
- **A signing key is registered for the CALLER and for no one else** — at every
  role, including owner. This is the one place where that row's admin/owner
  "yes" is deliberately NOT followed. §4.3.8 binds a `kid` to exactly one agent
  and §4.4 step 3 resolves it against `manifest.author_agent`; a privileged
  actor who could register a key under another principal could sign packages
  that verify as authored by that principal, and the author binding — the thing
  that makes a Verified Skill Package attributable — would mean nothing. The
  surface therefore takes no principal parameter at all. **Revocation is not
  symmetric** and admin/owner do get the row's "yes": revoking a key removes
  capability and can never forge authorship, and a principal whose API key is
  compromised must be stoppable by someone other than whoever holds it.

**A secret is shown exactly once.** `principal.create` and
`principal.issue_api_key` return the plaintext API key in their response and
nowhere else, ever; the database stores only its SHA-256, as it already does
for the §9.1 bootstrap keys. Reissue exists so that a lost key does not brick a
principal — "issued once" governs DISPLAY, not the number of keys a principal
may ever hold; a reissued key is a new secret shown once as well, and the old
one is revoked separately. A revoked API key stops authenticating immediately
and cannot be distinguished by the caller from an unknown one (§6
Authentication).

**The §9.1 bootstrap token MUST outlive the process that printed it.** First
start commits the workspace, the owner principal and the demo adopter, so the
bootstrap never runs again and never re-issues; if the outstanding token lived
only in process memory, a restart between the first start and the exchange would
leave a deployment with no owner key and no way to mint one. An implementation
MUST therefore persist the OUTSTANDING state — the token's SHA-256 and the ids
the exchange needs, and nothing more — in the deployment's own storage, and MUST
drop it at the instant the token is consumed, before the owner key is minted, so
that a failure in between cannot resurrect a spent token. The plaintext token
MUST NOT be persisted anywhere and MUST NOT appear in any log line after the one
first-start line §9.1 requires; a restart MUST NOT reprint it, because only
the hash exists.

The reference implementation stores this as a 0600 file in the data directory
(`<data>/bootstrap.json`) rather than as a row: Appendix D.1 is byte-frozen and
the live schema is compared against it, and process state does not justify
changing a normative schema.

This deliberately provides no recovery for a token that is LOST rather than
merely outstanding. Only its hash exists, so it cannot be reprinted, and a
one-time credential that can be reissued is not one. `docs/OPERATIONS.md`
documents the two paths that remain (start over on a fresh deployment; use any
surviving owner/admin key to create a new owner principal on one that has data).

**These two calls take no `idempotency_key`,** which is the single documented
exception to Appendix H's rule that every mutating call accepts one. A replay
is served from the persisted original response; persisting the response of a
call that returns a plaintext key would write that key into
`idempotency_keys.response_json` and leave it there, defeating "stored only as
a hash". Webhook registration, which returns a one-time secret for the same
reason, is the existing precedent. The three provisioning calls that return no
secret — signing-key registration, signing-key revocation, API-key revocation —
do accept one.

**Signing keys.** `kid` MUST match `[a-z0-9-]{1,64}` and `public_key_ed25519`
MUST be unpadded base64url of the raw 32 bytes (§4.3; Appendix D.1's
`length(...)=43`); anything else is `INVALID_SCHEMA`.

**A registered `kid` MUST NOT be 64 lowercase hexadecimal characters**, and
registration MUST refuse one with `INVALID_SCHEMA`. That is the shape of a
`manifest_hash`, and `signing_key_registered` writes the `kid` into the same
`transparency_log.subject_id` column that `countersign` fills with a manifest
hash. Registering such a `kid` is one principal writing rows at another
namespace's addresses in the one log §4.4 reads for trust. The charset alone
does not prevent it — `[0-9a-f]` ⊂ `[a-z0-9-]` — so the rule is stated here and
enforced at registration. The restriction binds where a `kid` is MINTED and
nowhere else: revocation, listing and §4.4 step 3 resolution MUST continue to
accept a `kid` of that shape, because a deployment provisioned under an earlier
build may hold one and a credential that cannot be revoked is a worse outcome
than the collision. This rule and §4.4 step 6's `event_kind` filter are
independent defences against the same attack, and BOTH are required.

The API cannot judge
whether a well-formed key is really the caller's — Ed25519 admits any 32-byte
string as a public-key encoding — and does not pretend to: what protects the
binding is that only the principal registers for itself, and that a package
signed by a different key fails §4.4 step 4 with `BAD_SIGNATURE`. `kid` is
globally unique (Appendix D.1), so re-registering the IDENTICAL binding
converges (`noop:true`, original `created_at_ms`), and any other collision —
same kid with a different key, a kid held by another principal, or a kid that
has been revoked — is `CONFLICT` with `current_state` `active` or `revoked`.
The refusal names neither the other principal nor its key.

**What revocation of a signing key does, and does not do.** It stamps
`signing_keys.revoked_at_ms` and appends a `signing_key_revoked` entry to the
§4.4 transparency log; registration appends `signing_key_registered`
correspondingly. Both are logged because §4.4 steps 3 and 7 make the binding
and its revocation trust inputs, and a trust input that lives only in a mutable
table is what the log exists to prevent. Re-revoking converges on the ORIGINAL
time and writes no second entry, because that time is the step-7 comparison
point and moving it would change past verdicts.

Revocation changes FUTURE verification only:

- A version that already reached `verified` or `published` **keeps its state**.
  Lifecycle states move only through §5.1's own surfaces; revoking a key is not
  one of them, and there is no cascade. A registry that retired versions on key
  revocation would be rewriting decisions that were correct when they were
  made.
- Re-running §4.4 over a package signed by the revoked key compares
  `revoked_at_ms` against the §4.3.9 countersign time, exactly as step 7 has
  always specified: revoked AFTER the countersign →
  `valid_but_key_since_revoked` (the package verified, and the reader is told
  the key has since been retired); revoked AT OR BEFORE it →
  `invalid_key_revoked_at_signing`; countersigned never →
  `unverifiable_timing`.
- An operator who wants a package withdrawn as well as its key retired MUST
  also call surface 11 `skill.revoke`. The two are deliberately separate
  decisions: one is about a credential, the other about a package.

**Authentication.** A bearer API key resolves to an authenticated context of
`{agent_id, workspace_id, role, tool_profile}`, where the role comes from
`workspace_memberships`. All mutating calls accept an optional
`idempotency_key`, persisted with the original response; a duplicate replays it.
Rate limits are per key.

**Normative ACL matrix** — actor × operation × resource state × tenancy.
"Member+" means member, reviewer, admin or owner of the resource's workspace;
"X-ws" is a cross-workspace actor. **Deny is the default: anything not listed is
`FORBIDDEN`.**

| Operation / resource | Author/skill owner | Member+ (same ws) | Reviewer (same ws, ≠author) | Admin/Owner (same ws) | X-ws actor |
|---|---|---|---|---|---|
| create a NEW skill (its first version) | n/a — there is no author yet | yes, and the creator becomes the skill's owner | yes | yes | — |
| add a version to an EXISTING skill; lint a version; read own drafts | yes | — | — | yes | — |
| read manifest+blob, evidence | yes | per visibility table §5.1 | yes | yes | per visibility table §5.1: `published` and the states reached from it, capped by access_policy/grant |
| request review (`{"action":"request"}`) | yes | — | — | — | — |
| submit review verdict | never (self-review, author AND skill owner) | — | yes | yes (if neither author nor skill owner) | — |
| human approval (§7.3) | — | — | — | yes, `type=human` only | — |
| request_adoption / adopt / validate_outcome | for own adoptions | yes per §5.1 | yes | yes | only `published` + policy/grant |
| append to a receipt | — | only the receipt's adopter | — | read-only | only the receipt's adopter |
| rate | — | adopter with terminal `adopted` | — | same rule | same rule |
| publish (`verified → published`) | never | — | never | yes | — |
| deprecate | yes | — | — | yes | — |
| supersede | yes | — | yes | yes | — |
| revoke | yes | — | — | yes | — |
| manage grants/memberships/webhooks | own webhooks | own webhooks | own webhooks | yes | — |
| create principal; issue/revoke its API key (§6.1) | — | revoke own key | revoke own key | yes, not above own role | — |
| register own signing key (§6.1) | own only | own only | own only | own only — never for another principal | — |
| revoke a signing key (§6.1) | own only | own only | own only | yes, not above own role | — |
| delivery.poll/complete/fail (internal) | — | — | — | — | service only |

**Error model.** Errors are typed codes carried as
`{"error":{"code","message","current_state"?}}` — the envelope of Appendix H,
with those three members and no others; there is no `details` member. A
`PRECONDITION_FAILED` and a `CONFLICT` MUST carry `current_state`; every other
code MAY. **The code space is closed and has exactly twelve members:**

```
UNAUTHORIZED · FORBIDDEN · NOT_FOUND · CONFLICT · PRECONDITION_FAILED ·
INVALID_SCHEMA · RATE_LIMITED · UNKNOWN_KEY · BAD_SIGNATURE ·
TAMPERED_CONTENT · MALFORMED_ARCHIVE · LIMIT_EXCEEDED
```

Two boundaries around that list are normative, because both have been misread:

- **The §4.4 VERDICTS are not error codes.** `valid`, `valid_superseded`,
  `valid_deprecated`, `valid_but_key_since_revoked`, `unverifiable_timing`,
  `not_verified`, `revoked` and `invalid_key_revoked_at_signing` are values of
  the `verdict` field of a SUCCESSFUL verification response (§4.4.8, Appendix H
  row 4). A verification that reaches a verdict — any verdict — is a call that
  succeeded, and it never carries the error envelope.
- **`NOT_LOGGED` is likewise a verdict and not an error code.** It is what §4.4
  step 6 returns in `verdict`; it never appears in `error.code`. The five §4.4
  failure codes that ARE also error codes — `INVALID_SCHEMA`,
  `TAMPERED_CONTENT`, `UNKNOWN_KEY`, `BAD_SIGNATURE`, plus §4.1b's
  `MALFORMED_ARCHIVE` and `LIMIT_EXCEEDED` — are in the list above because
  other surfaces raise them as errors, not because a verification failure is
  an error.

`UNAUTHORIZED` covers AuthN failure — a missing, malformed, unknown or revoked
Bearer key, or a disabled principal — which is decided before any surface
contract applies, and is reported identically for all four so that a caller
cannot probe which one it hit.

The HTTP status of each code is fixed, so a REST client can route on the status
alone: `UNAUTHORIZED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 · `CONFLICT` 409 ·
`PRECONDITION_FAILED` 412 · `LIMIT_EXCEEDED` 413 · `RATE_LIMITED` 429 ·
`INVALID_SCHEMA`, `UNKNOWN_KEY`, `BAD_SIGNATURE`, `TAMPERED_CONTENT` and
`MALFORMED_ARCHIVE` 400. Over MCP the same envelope is returned inside the tool
result with `isError: true`; the transport carries no status.

One rule governs every state machine in this specification: **a transition
conflict returns the current state.** Re-issuing a transition that has already
happened returns `noop:true` plus the current state; attempting a transition
that the machine forbids returns `PRECONDITION_FAILED` plus the current state.
A caller can therefore always converge without retry loops, and no surface
answers a terminal resource with a bare error.

---

## 7. Deterministic gates, sandbox declaration, and human approval

### 7.1 Automated gates

Eight gates, all deterministic. They run on `skill.lint` and are re-run on
`skill.verify`, so a package cannot be verified against a stale lint.

1. **Schema completeness** — all required fields present and non-trivial
   (minimum lengths, enum membership).
2. **Secret patterns** — the key-like patterns of **Appendix G.1** and the
   high-entropy heuristic of **Appendix G.2**, applied to the manifest,
   `SKILL.md`, `fixtures/` and `evidence/`. A structured redaction convention
   (`⟦REDACTED:type⟧`) is respected so that redacted evidence passes; raw
   JWT-shaped strings FAIL. Any hit is a FAIL.
3. **Dependency pinning** — every `mcp_dependencies` and `dependency_manifest`
   entry pinned to an exact version. Floating ranges FAIL.
4. **URL allow/deny** — all URLs in steps and scripts must be within
   `url_allowlist`; raw-IP hosts, the URL shorteners of **Appendix G.3** and
   non-TLS URLs FAIL.
5. **Shell-command lint** — scripts and inline commands are scanned for the
   classes of **Appendix G.4**, which is the severity table: it names every
   class, what the class catches, and whether it is FAIL or WARN.
6. **Injection patterns** — the prompt-injection patterns of **Appendix G.5**
   over `SKILL.md` and `steps[].instruction`/`steps[].expected`: imperatives
   addressed to the reading agent to exfiltrate data, to disable safety
   measures, or to contact endpoints outside the allowlist. FAIL.
7. **Staleness** — evaluated against the policy of **Appendix G.6**:
   dependencies older than the policy window, or referenced tool versions at end
   of life, WARN; a deprecated upstream FAILs.
8. **Compatibility mismatch** — internal inconsistency. Two rules, both FAIL:
   (a) PowerShell declared or used where `runtime.shell` does not include
   `powershell` — either `shell` names `powershell` while `os` excludes
   `windows`, or a script, a `steps[].command`, a `steps[].instruction` or a
   `steps[].expected` carries a PowerShell construct (`powershell`, `pwsh`, a
   `Get-`/`Set-`/`Invoke-` cmdlet, or a `.ps1` reference) while `shell` excludes
   `powershell`; and (b) at least one step carries a non-empty `command` while
   `runtime.shell` is exactly `["none"]`.

**Severity semantics.** Each gate yields FAIL, WARN or PASS, and results are
stored per gate in `lint_reports`. **A single FAIL blocks the state transition**
— draft→linted requires zero FAILs, and the §5.1 conjunct 4 requires the same at
verify time. A WARN never blocks; it is recorded, surfaced to reviewers, and
carried in the report. A package declaring zero failure modes draws a WARN
(§4.2).

**Deny-by-default posture, and its exact scope.** Gates 4 and 5 refuse anything
they cannot classify safely.

- **Gate 4 (URL).** Locate URL candidates in steps and scripts reliably; admit
  **only** HTTPS addresses drawn from `url_allowlist`. Before comparing,
  canonicalize the host: lowercase it and drop one trailing dot. FAIL any
  non-HTTPS URL, raw-IP host, URL shortener, URL carrying userinfo, or address
  outside the allowlist. Enumerating the hundreds of IANA schemes is not
  attempted — **a URL candidate that cannot be parsed safely is a FAIL.**
- **Gate 5 (shell).** Distinguish quoted from unquoted expansions correctly
  (`"$TARGET"` is not unquoted; `$TARGET` and `${TARGET}` are). Catch the
  classes of Appendix G.4, including `rm -rf` against a dangerous target — a
  variable, a root path or a glob — under the ordinary flag spellings `-r -f`,
  `-rf`, `-fr` and `--`, and including every command that raises privilege on
  the machine running the step, which is one class however it is spelled
  (`sudo`, `sudoedit`, `su`, `doas`, `runuser`, `pkexec`). Classify the command
  the shell actually runs, not the
  word that happens to come first: a `VAR=value` assignment, the reserved word
  `!`, a redirection and a wrapper command are prefixes the shell runs a command
  *behind*, and G.4 requires each of them to be transparent — `! eval "$X"` is
  the same finding as `eval "$X"`. A full shell interpreter is not built — **a
  command that cannot be classified safely is a FAIL**, which is what the four
  opacity classes of G.4 (`unparseable-command`, `unclassifiable-command-name`,
  `command-substitution`, `control-construct`) and the three indirection classes
  (`eval-or-source`, `interpreter-inline-code`, `piped-into-interpreter`)
  enforce.

The consequence is worth stating plainly: these gates close the classes they
enumerate, deterministically and identically on both runtimes. They are not a
general-purpose malicious-code detector, and a package passing all eight gates
has not been shown to be safe.

### 7.2 Sandbox declaration

`sandbox_requirement` is a required Safety field. A package with
`risk_level: high` MUST declare a sandbox profile, and `skill.adopt` refuses a
high-risk handover to an adopter that does not attest `sandbox_capable` in its
environment descriptor.

This is a declaration and a refusal at the handover point. **The registry does
not create, enter, or enforce a sandbox**, and nothing in this specification
verifies that an adopter's attestation is true.

### 7.3 Human-approval matrix

An approval is recorded in `approvals` and enforced at the API level.

| Condition (any) | Publish | Adoption |
|---|---|---|
| `risk_level: high` | human approval | human approval per adoption |
| Steps touch prod access / credentials / cloud-IAM | human approval | human approval |
| Destructive operations (data deletion, infra teardown) | human approval | human approval |
| Network exfiltration surface (posts data to external URLs) | human approval | human approval |
| Low evidence (<3 terminal `adopted` receipts) + large blast radius declared | human approval | human approval per adoption (applies to the trial-adoption lane too, where 0 receipts is the normal starting condition) |
| `risk_level: low\|medium`, all gates pass | auto | auto |

Auto-adoption of a high-risk package without a human is not supported: the
matrix is the enforcement.

**Normative predicates.** Each row above is a deterministic predicate over the
declared manifest plus one registry counter, so two implementations decide the
same way offline. `adoptedCount` is the number of terminal `adopted` receipt
events already recorded for the version. An absent field means the condition
does not hold; a manifest that cannot be read at all means every lane requires
approval (fail-closed).

| Condition id | Row | Predicate |
|---|---|---|
| `risk_high` | `risk_level: high` | `scope.risk_level == "high"` |
| `prod_credentials_iam` | prod access / credentials / cloud-IAM | `runtime.cloud_iam_assumptions` is a non-empty array |
| `destructive` | destructive operations | `x_ext.destructive === true` |
| `network_exfiltration` | network exfiltration surface | `safety.url_allowlist` is a non-empty array — gate 4 admits no URL outside that list, so an empty list means no external endpoint is reachable from the package at all |
| `low_evidence_large_blast_radius` | low evidence + large blast radius | `adoptedCount < 3` **and** `x_ext.blast_radius` ∈ {`large`, `fleet`, `org`} |

A manifest that cannot be read at all yields the single pseudo-condition
`unreadable_manifest` instead of evaluating the five above. It is not a row of
the matrix; it is the fail-closed outcome named as a condition id so that a
response listing the conditions in force can say WHY approval is required. It is
the sixth and last value that may appear in such a list.

The last table row (`risk_level: low\|medium`, all gates pass → auto) is the
residual: it applies exactly when none of the five predicates holds. The
predicate list is complete — in particular `scope.required_approvals`, which an
author declares, is deliberately **not** a condition: a low-risk package that
merely declares it is the automatic case, and treating the declaration as a
condition would keep it out of `published` in a scenario this matrix admits.

**Per-adoption binding.** An approval with scope `adopt_high_risk` is bound to
one specific `adoption_request_id` — `approvals.adoption_request_id` is
`NOT NULL` for that scope, with `UNIQUE(adoption_request_id, scope)` and a DDL
CHECK. It authorizes exactly that adoption and cannot be replayed for another
request. A `publish` approval binds to the version instead
(`adoption_request_id IS NULL`).

---

## 8. Threat Model — Top-10 Risks and V1 Controls

The table below is the threat model this design answers, and the control each
threat is answered by. It is a statement of what was designed for, not a claim
of coverage: a control listed here closes the mechanism named, within the scope
that §4.1b and §7.1 enumerate.

| # | Threat | Control |
|---|---|---|
| 1 | Malicious commands/dependencies in packages | Gates 3–5 + sandbox declaration + human approval matrix |
| 2 | Prompt injection in skill body | Gate 6 + adopter-side rendering guidance (runbook steps rendered as data, not instructions, until human/policy approval) |
| 3 | Secret leakage in logs/examples | Gate 2 + redaction levels + evidence redaction templates published |
| 4 | Stale/rotten procedures | Gate 7 + deprecation dates + supersession graph + staleness flags in search |
| 5 | Misleading benchmarks | Reputation computed only from server-validated receipts; benchmarks marked self-reported unless receipt-backed |
| 6 | Forged adoption receipts | Receipts writable only by authenticated adopter; server timing authority; evidence validated against declared gates; INSERT-only + transparency log |
| 7 | Review rings | Curated invite-only population + reviewer ≠ author + attestations logged |
| 8 | Unsafe permissions | Safety group required; approval matrix; tool_profile scoping of API keys |
| 9 | Data/privacy leakage via evidence | Redaction levels enforced at lint; workspace-scoped access_policy default-private |
| 10 | Supply-chain compromise of packages | Content hash + Ed25519 signatures + transparency log; SLSA/in-toto/Sigstore fields reserved and encouraged |

---

## 9. Deployment bootstrap

### 9.1 First start

§6.1 says a deployment MUST be operable through its API alone. That sentence
needs one credential to exist before any API call can be authenticated, and this
subsection is where it comes from. Everything here is normative for a
conforming registry; it is the only part of this document that describes a
process rather than a format.

**What first start creates.** A start that finds NO workspace in the database
creates, in one transaction: a workspace named `default`; one principal named
`owner` with `agents.type = 'human'` and workspace role `owner`; and one
principal named `demo-adopter` with `agents.type = 'agent'` and workspace role
`member`. A start that finds a workspace does none of this and MUST NOT re-issue
anything — bootstrap happens once in the life of a deployment.

**The two one-time credentials, printed exactly once.**

- `BOOTSTRAP_OWNER_TOKEN` is **not** an API key. It is a one-time token,
  exchangeable exactly once at `POST /v1/auth/bootstrap` for the owner
  principal's real API key. Only its SHA-256 is stored; the plaintext is
  printed on the one first-start line and exists nowhere afterwards.
- `DEMO_ADOPTER_TOKEN` is the demo adopter's real, minted API key — stored, like
  every API key, only as a SHA-256.

Both are written to the process's standard output at first start and never
again. A restart MUST NOT reprint either, because neither plaintext was kept.

**The exchange.** `POST /v1/auth/bootstrap` takes `{"bootstrap_token"}` and
answers `{"api_key","agent_id","role":"owner"}`. The token is invalidated
BEFORE the key is minted, and the durable copy of its hash is dropped at that
same instant, so a crash between the two cannot resurrect a spent token and a
second exchange — or a replay racing the first — is `UNAUTHORIZED`. The
comparison against the stored hash is constant-time. The route is
unauthenticated, because at that moment there is nothing to authenticate with.

**Survival across a restart.** §6.1 already requires the OUTSTANDING state — the
token's SHA-256 and the ids the exchange needs, and nothing more — to be durable
in the deployment's own storage rather than in process memory. A restart before
the exchange therefore finds the token still valid; it reprints nothing and says
so. This deliberately provides no recovery for a token that is LOST rather than
outstanding: only its hash exists.

**Single-user demo mode.** While the deployment holds **exactly one** principal
with `agents.type = 'human'`, it is in demo mode. Demo mode is a labelling and
review concession, not a permission change: the state is reported as
`demo_mode` on every dashboard payload (Appendix H) so a rendered page can show
it prominently, and it ends automatically — with no operator action and no
migration — the moment a second human principal exists. Nothing else in this
specification reads it.

**The seed package (optional).** A deployment MAY install one built-in signed
package at first start so that a fresh instance has something adoptable, and the
reference implementation does. If it does, the package MUST reach its state
through the ordinary surfaces (`skill.create` → `skill.lint` →
`skill.review.request`) rather than by writing a state directly, so a seed that
would not pass the §7.1 gates cannot appear as though it had. A seed is a
deployment convenience and not a conformance requirement; a registry that
installs none is conforming.

---

## Appendix D. NORMATIVE SQLite DDL

The normative schema is given in **five** migrations, applied in ascending file
order, and the live schema of a conforming registry is their sum. Each is
embedded below verbatim and is byte-identical to the file this repository ships;
a test asserts that for all five. Schema version is tracked in
`PRAGMA user_version` and nowhere else — there is no bookkeeping table, because
the live schema is compared object for object against D.1 plus the deltas below,
and a table this specification does not name would fail that comparison. A
migration and the `PRAGMA user_version=<n>` that records it are applied in one
transaction, so a half-migrated database is not reachable.

- **D.1 is the initial migration**, shipped as `migrations/0001_init.sql`.
  20 tables; six INSERT-only triggers; a partial unique terminal-event index;
  three tenancy triggers; one approval-consistency trigger
  (`tg_approval_version_match`). `PRAGMA user_version` = `1`.
- **D.1b is the second migration**, shipped as `migrations/0002_p5.sql`. It is
  additive and changes exactly five things: the state `approval_pending` in
  `adoption_requests.state`; the dead-letter reasons `approval_denied` and
  `endpoint_missing`; the column `adoption_requests.webhook_id`; and the column
  `webhooks.secret_ref`. Every other constraint of D.1 is carried over
  unchanged, no column is dropped and no row is lost. All five are the §5.2
  delivery machine and the §7.3 hold made storable. `PRAGMA user_version` = `2`.
- **D.1c is the third migration**, shipped as
  `migrations/0003_revocation_notice.sql`. It is additive and changes exactly
  one thing: the column `adoption_requests.notification_kind`, which is what
  lets one row of the §5.2 queue be either an adoption notification or a
  surface-11 revocation notice. `PRAGMA user_version` = `3`.
- **D.1d is the fourth migration**, shipped as
  `migrations/0004_declared_environment_on_the_event.sql`. It is additive and
  changes exactly one thing: the column `receipt_events.environment_json`, which
  is where the environment an adopter declares at handover is recorded — on the
  INSERT-only event rather than on the mutable request row, because the release
  gate's cross-runtime conjunct (§5.3) is counted from it.
  `PRAGMA user_version` = `4`.
- **D.1e is the fifth migration**, shipped as
  `migrations/0005_server_side_packing.sql`. It is additive and changes exactly
  two things: the column `signing_keys.secret_ref`, which REFERENCES a private
  half held outside SQLite in the deployment's secret store — the same
  indirection `webhooks.secret_ref` uses, for the same reason — and the column
  `skill_versions.source_hash`, which records the identity of the SOURCE a
  version was packed from. The second exists because server-side packing writes
  the §5 arrival marker into the package, so `manifest_hash` and `content_hash`
  can no longer answer "is this the same submission again?" — the answer is
  taken on the source, before the marker exists. `PRAGMA user_version` = `5`.
- **The live schema a fresh database reports is D.1 as edited by D.1b, D.1c,
  D.1d and D.1e**, and never D.1 alone. Object counts are unchanged at 20
  tables, 10 triggers and 9 indexes. After all five migrations
  `PRAGMA user_version` MUST report `5`. A test in this repository asserts the
  live schema equals D.1 plus exactly those nine edits — the five of D.1b, the
  one of D.1c, the one of D.1d and the two of D.1e — so any further divergence
  fails.

### D.1 NORMATIVE DDL (verbatim)


```sql
-- SKILLONOMIA V1 — NORMATIVE SQLite DDL
-- 20 tables. Triggers: 6 INSERT-only + 3 tenancy + 1 approval-consistency.
PRAGMA foreign_keys=ON;

CREATE TABLE workspaces(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);

CREATE TABLE agents(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  type TEXT NOT NULL CHECK(type IN ('human','agent','service')),
  tool_profile TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','merged')),
  merged_into_agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  passport_ref TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(workspace_id,name)
);

CREATE TABLE workspace_memberships(
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','reviewer','member')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  PRIMARY KEY(agent_id,workspace_id)
);

CREATE TABLE api_keys(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL CHECK(length(key_hash)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  revoked_at_ms INTEGER
);
CREATE INDEX idx_api_keys_agent ON api_keys(agent_id);

CREATE TABLE signing_keys(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  kid TEXT NOT NULL UNIQUE CHECK(kid NOT GLOB '*[^a-z0-9-]*' AND length(kid) BETWEEN 1 AND 64),
  public_key_ed25519 TEXT NOT NULL CHECK(length(public_key_ed25519)=43),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  revoked_at_ms INTEGER
);

CREATE TABLE skills(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK(slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 3 AND 64),
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  access_policy TEXT NOT NULL DEFAULT 'private' CHECK(access_policy IN ('private','invite','workspace','public')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(workspace_id,slug)
);

CREATE TABLE skill_access_grants(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  grantee_workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  grantee_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  granted_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  CHECK((grantee_workspace_id IS NULL) <> (grantee_agent_id IS NULL))
);
CREATE INDEX idx_grants_skill ON skill_access_grants(skill_id);

CREATE TABLE skill_versions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  semantic_version TEXT NOT NULL CHECK(length(semantic_version) BETWEEN 5 AND 32),
  author_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  package_blob_ref TEXT NOT NULL,
  signature_jws TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','linted','reviewed','verified','published','deprecated','superseded','revoked')),
  supersedes_version_id TEXT REFERENCES skill_versions(id) ON DELETE RESTRICT,
  superseded_by_version_id TEXT REFERENCES skill_versions(id) ON DELETE RESTRICT,
  revocation_reason TEXT,
  deprecation_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(skill_id,semantic_version)
);
CREATE INDEX idx_versions_skill_state ON skill_versions(skill_id,state);

CREATE TABLE lint_reports(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  gate TEXT NOT NULL CHECK(gate IN ('schema','secrets','pinning','urls','shell','injection','staleness','compat')),
  result TEXT NOT NULL CHECK(result IN ('pass','fail','warn')),
  details_json TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_lint_version ON lint_reports(skill_version_id);

CREATE TABLE reviews(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  reviewer_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  verdict TEXT NOT NULL CHECK(verdict IN ('approve','reject','conditional')),
  note TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_reviews_version ON reviews(skill_version_id);

CREATE TABLE attestations(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  attester_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 40),
  payload_json TEXT,
  signature_jws TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_attest_version ON attestations(skill_version_id);

CREATE TABLE adoption_requests(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adopter_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  requester_context_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','pushed','dead_letter')),
  dead_letter_reason TEXT CHECK(dead_letter_reason IS NULL OR dead_letter_reason IN ('max_attempts','stale_lease','endpoint_dead')),
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_req_due ON adoption_requests(state,next_attempt_at_ms);

CREATE TABLE adoption_receipts(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  adoption_request_id TEXT NOT NULL UNIQUE REFERENCES adoption_requests(id) ON DELETE RESTRICT,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adopter_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);

CREATE TABLE receipt_events(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  adoption_receipt_id TEXT NOT NULL REFERENCES adoption_receipts(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('delivered','attempted','adopted','failed','rolled_back')),
  event_seq INTEGER NOT NULL CHECK(event_seq>=1),
  evidence_json TEXT,
  failure_report_json TEXT,
  rollback_report_json TEXT,
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  idempotency_key TEXT NOT NULL,
  UNIQUE(adoption_receipt_id,idempotency_key),
  UNIQUE(adoption_receipt_id,event_seq),
  UNIQUE(adoption_receipt_id,event)
);
CREATE UNIQUE INDEX uq_receipt_terminal ON receipt_events(adoption_receipt_id) WHERE event IN ('adopted','failed');

CREATE TABLE approvals(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adoption_request_id TEXT REFERENCES adoption_requests(id) ON DELETE RESTRICT,
  approver_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK(scope IN ('publish','adopt_high_risk')),
  decision TEXT NOT NULL CHECK(decision IN ('approved','denied')),
  note TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  -- per-adoption approval MUST bind the exact adoption_request; publish approval binds the version only
  CHECK((scope='adopt_high_risk' AND adoption_request_id IS NOT NULL)
     OR (scope='publish' AND adoption_request_id IS NULL)),
  UNIQUE(adoption_request_id,scope)
);

CREATE TABLE ratings(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  rater_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  adoption_receipt_id TEXT NOT NULL REFERENCES adoption_receipts(id) ON DELETE RESTRICT,
  score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  note TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(skill_version_id,rater_agent_id)
);

CREATE TABLE transparency_log(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_kind TEXT NOT NULL CHECK(length(event_kind) BETWEEN 1 AND 60),
  subject_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  prev_hash TEXT NOT NULL CHECK(length(prev_hash)=64),
  this_hash TEXT NOT NULL CHECK(length(this_hash)=64),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);

CREATE TABLE activity_log(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  subject_id TEXT,
  details_json TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_activity_ws ON activity_log(workspace_id,created_at_ms);

CREATE TABLE webhooks(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK(url LIKE 'https://%' OR url LIKE 'http://localhost%' OR url LIKE 'http://127.0.0.1%'),
  secret_hash TEXT NOT NULL CHECK(length(secret_hash)=64),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','failing','dead')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>0)
);

CREATE TABLE idempotency_keys(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(actor_agent_id,surface,key)
);

-- ============ INSERT-only enforcement ============
CREATE TRIGGER tg_receipts_no_upd BEFORE UPDATE ON adoption_receipts BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_receipts_no_del BEFORE DELETE ON adoption_receipts BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revents_no_upd  BEFORE UPDATE ON receipt_events   BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revents_no_del  BEFORE DELETE ON receipt_events   BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_tlog_no_upd     BEFORE UPDATE ON transparency_log BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_tlog_no_del     BEFORE DELETE ON transparency_log BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;

-- ============ Tenancy consistency ============
CREATE TRIGGER tg_skill_owner_ws BEFORE INSERT ON skills
BEGIN
  SELECT CASE WHEN (SELECT workspace_id FROM agents WHERE id=NEW.owner_agent_id) <> NEW.workspace_id
    THEN RAISE(ABORT,'TENANCY_OWNER_NOT_IN_WS') END;
END;

CREATE TRIGGER tg_version_author_ws BEFORE INSERT ON skill_versions
BEGIN
  SELECT CASE WHEN (SELECT workspace_id FROM agents WHERE id=NEW.author_agent_id)
       <> (SELECT workspace_id FROM skills WHERE id=NEW.skill_id)
    THEN RAISE(ABORT,'TENANCY_AUTHOR_NOT_IN_WS') END;
END;

CREATE TRIGGER tg_receipt_tenancy BEFORE INSERT ON adoption_receipts
BEGIN
  SELECT CASE WHEN (SELECT adopter_agent_id FROM adoption_requests WHERE id=NEW.adoption_request_id) <> NEW.adopter_agent_id
    THEN RAISE(ABORT,'TENANCY_ADOPTER_MISMATCH') END;
  SELECT CASE WHEN (SELECT skill_version_id FROM adoption_requests WHERE id=NEW.adoption_request_id) <> NEW.skill_version_id
    THEN RAISE(ABORT,'TENANCY_VERSION_MISMATCH') END;
  SELECT CASE WHEN
      (SELECT s.workspace_id FROM skills s JOIN skill_versions v ON v.skill_id=s.id WHERE v.id=NEW.skill_version_id)
      <> (SELECT workspace_id FROM agents WHERE id=NEW.adopter_agent_id)
    AND (SELECT state FROM skill_versions WHERE id=NEW.skill_version_id) <> 'published'
    THEN RAISE(ABORT,'TENANCY_CROSS_WS_REQUIRES_PUBLISHED') END;
END;

-- Per-adoption approval must reference the SAME version as its adoption_request
-- (blocks security-invalid approval: skill_version_id=V2 with a request belonging to V1).
CREATE TRIGGER tg_approval_version_match BEFORE INSERT ON approvals
WHEN NEW.scope='adopt_high_risk'
BEGIN
  SELECT CASE WHEN (SELECT skill_version_id FROM adoption_requests WHERE id=NEW.adoption_request_id)
       <> NEW.skill_version_id
    THEN RAISE(ABORT,'APPROVAL_VERSION_MISMATCH') END;
END;
```

### D.1b NORMATIVE DELTA — second migration (verbatim)


```sql
-- SKILLONOMIA P5 migration — the SOLE authorized exception to the P0 schema
-- freeze. It adds what §5.2 needs to be storable: the `approval_pending` hold
-- and the `approval_denied` reason, which break the approval↔request circular
-- dependency, plus the endpoint snapshot and the secret indirection.
--
-- migrations/0001_init.sql stays byte-identical to Appendix D.1 and is not
-- touched. Everything below is additive to the DATA MODEL: no column is
-- dropped, no row is lost, and every pre-existing constraint is carried over
-- verbatim.
--
-- SQLite cannot alter a CHECK constraint, so `adoption_requests` is rebuilt in
-- place. `defer_foreign_keys` postpones FK enforcement to COMMIT (the children
-- resolve again after the rename), and `legacy_alter_table` keeps the rename
-- from re-parsing tg_receipt_tenancy while the old table is momentarily absent.
PRAGMA defer_foreign_keys=ON;
PRAGMA legacy_alter_table=ON;

CREATE TABLE adoption_requests_p5(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adopter_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  requester_context_json TEXT,
  -- §5.2: `approval_pending` added; a request awaiting a §7.3 human approval
  -- is not claimable and cannot be adopted.
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','pushed','dead_letter','approval_pending')),
  -- §5.2 adds `approval_denied` (a decision) and `endpoint_missing` (no
  -- endpoint was selectable for this adopter).
  dead_letter_reason TEXT CHECK(dead_letter_reason IS NULL OR dead_letter_reason IN ('max_attempts','stale_lease','endpoint_dead','approval_denied','endpoint_missing')),
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  -- §5.2: the ONE endpoint selected for this request, snapshotted at creation
  webhook_id TEXT REFERENCES webhooks(id) ON DELETE SET NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);

INSERT INTO adoption_requests_p5(id, skill_version_id, adopter_agent_id, requester_context_json,
       state, dead_letter_reason, lease_owner, lease_expires_at_ms, attempt_count,
       next_attempt_at_ms, webhook_id, created_at_ms)
  SELECT id, skill_version_id, adopter_agent_id, requester_context_json,
         state, dead_letter_reason, lease_owner, lease_expires_at_ms, attempt_count,
         next_attempt_at_ms, NULL, created_at_ms
    FROM adoption_requests;

DROP TABLE adoption_requests;
ALTER TABLE adoption_requests_p5 RENAME TO adoption_requests;
PRAGMA legacy_alter_table=OFF;

-- identical to D.1's index on the rebuilt table
CREATE INDEX idx_req_due ON adoption_requests(state,next_attempt_at_ms);

-- §5.2: the plaintext webhook secret is NEVER stored in SQLite and is shown
-- exactly once, at registration. `secret_hash` (D.1) remains a verifier only;
-- the worker resolves the signing secret through this deployment-local ref.
ALTER TABLE webhooks ADD COLUMN secret_ref TEXT;
```

### D.1c NORMATIVE DELTA — third migration (verbatim)

§6 surface 11 and §5.1's tail table both require that revoking a version
notifies its active adopters through the §5.2 delivery machine. That machine
drives `adoption_requests`, and every row in it described exactly one thing: an
adoption request. A revocation notice is a different message to the same
endpoint, so the row has to say which it is — otherwise an adopter cannot tell
"here is the package you asked for" from "the package you are running has been
revoked", and `skill.adopt` cannot refuse a row that was never a request.

Strictly additive, and the narrowest form that carries the distinction: ONE
column, whose default makes every pre-existing row exactly what it already was.
No table is rebuilt, no constraint is relaxed, no data moves, and Appendix D.1's
twenty-table shape is unchanged.

```sql
-- SKILLONOMIA — revocation notices on the §5.2 delivery machine.
--
-- §6 surface 11 and §5.1's tail table both promise that revoking a version
-- notifies its active adopters "through the delivery machine". The machine
-- (queue, lease, backoff, sweeper, dead letters, endpoint health) drives
-- `adoption_requests`, and every row in it described one thing: an adoption
-- request. A revocation notice is a different message to the same endpoint, so
-- the row has to say which it is — otherwise an adopter cannot tell "here is a
-- package you asked for" from "the package you are running has been revoked",
-- and `skill.adopt` cannot refuse a row that was never a request.
--
-- Strictly additive: one column, with a default that makes every existing row
-- exactly what it already was. No table is rebuilt, no constraint is relaxed,
-- and the 20-table shape of Appendix D.1 is unchanged.
ALTER TABLE adoption_requests ADD COLUMN notification_kind TEXT NOT NULL DEFAULT 'adoption'
  CHECK(notification_kind IN ('adoption','revocation'));
```

### D.1d NORMATIVE DELTA — fourth migration (verbatim)

The release gate's conjunct "adoptions between agents of DIFFERENT runtimes" was
counted from `adoption_requests.requester_context_json`. That column is MUTABLE
and keeps no history, so the figure was a reading of whoever wrote last: any
holder of an adopter key could raise it after the fact, with no event, no error
and no trace, and the release run demonstrated exactly that. A gate that grows
when it is tampered with is not a gate.

The declared environment therefore moves onto `receipt_events` — the one
INSERT-only table of this schema, with `event_seq` for order and
`tg_revents_no_upd`/`tg_revents_no_del` refusing every update and delete — and is
written in the SAME transaction as the `delivered` event it belongs to (§5.3).
The counter becomes a query over the journal rather than a reading of current
state, and every adopter can read back its own declaration in its own event.

Strictly additive: ONE nullable column on ONE table. No table is rebuilt, no
constraint is relaxed, no row is touched, and Appendix D.1's twenty-table shape
is unchanged. Rows written before this migration carry NULL and contribute NO
runtime to that count: the counters are fail-closed, so a history that was never
recorded cannot be reconstructed — only recounted on a fresh instance.
`requester_context_json` remains as a denormalized cache for queries over
requests, and MUST NOT be the input to any gate.

```sql
-- SKILLONOMIA — the declared environment belongs to the receipt event.
--
-- The release gate's conjunct "adoptions between agents of DIFFERENT runtimes"
-- was counted from `adoption_requests.requester_context_json`: a MUTABLE column
-- on the request row, written by `skill.adopt` with no history and no event.
-- Anything counted from it is counted from the last writer, so the acceptance
-- figure could be raised after the fact by anyone holding an adopter key,
-- without an event, without an error, and monotonically upward — a release gate
-- that grows when it is tampered with. It was also how one caller's declared
-- environment came to sit next to another caller's receipt chain.
--
-- The declared environment therefore moves onto `receipt_events`, which is the
-- one INSERT-only part of this system: `tg_revents_no_upd`/`tg_revents_no_del`
-- refuse to update or delete a row, `event_seq` fixes the order, and the row is
-- written in the same transaction as the event it describes. A snapshot per
-- event, immutable, attributable — and the count becomes a query over the
-- journal rather than a reading of current state.
--
-- Strictly additive: one nullable column on one table. No table is rebuilt, no
-- constraint is relaxed, no row is touched, and the 20-table shape of Appendix
-- D.1 is unchanged. Rows written before this migration carry NULL, which
-- contributes NO runtime to that count — the counters are fail-closed, so
-- history that was never recorded cannot be inferred, only recounted on a fresh
-- instance.
ALTER TABLE receipt_events ADD COLUMN environment_json TEXT;
```

### D.1e NORMATIVE DELTA — fifth migration (verbatim)

Server-side packing (`skill.create_from_dir`, Appendix H surface 14) needs two
facts recorded that D.1 had nowhere to put, and the shape of both is decided by
[I-7] and by §5's arrival marker rather than by convenience.

`signing_keys.secret_ref`. Every row of `signing_keys` used to describe a key
whose private half the registry had never seen. Surface 14 inverts that: the
system generates the key and signs on the caller's behalf, so a private half now
exists that belongs to the deployment. It does NOT go in this column and does not
go in SQLite at all — the column holds a REFERENCE into the deployment's secret
store, exactly as `webhooks.secret_ref` does for the §5.2 signing secret, so that
a database dump, a backup or a read-only audit connection is never a way to
obtain signing capability. The column is also what distinguishes the two kinds of
key: NULL means the registry can only verify against it, non-NULL means it can
also sign with it. Nothing infers that from a naming convention, because a naming
convention is something a caller can imitate.

`skill_versions.source_hash`. The §5 arrival marker is derived from the skill
version id and written INTO the package, so two versions packed from one
identical source are byte-different by construction. `manifest_hash` and
`content_hash` therefore stop being able to answer "is this the same submission
again?": they answer it, always with "no", and a resubmitted source would mint a
new version silently and for ever. The convergence check moves to the SOURCE,
computed before the marker exists, and this column is where that identity is
kept.

Strictly additive: two nullable columns on two tables. No table is rebuilt, no
constraint is relaxed, no row is touched, and Appendix D.1's twenty-table shape
is unchanged. Rows written before this migration carry NULL in both, and NULL
never equals a computed source hash — history packed elsewhere converges with
nothing, rather than converging by accident with the first submission that
arrives.

```sql
-- SKILLONOMIA — the registry packs, and the registry signs.
--
-- Two columns, both nullable, both additive. They exist because packing moved
-- from the author's shell to the server, and that move needs exactly two facts
-- recorded that the schema had nowhere to put.
--
-- `signing_keys.secret_ref` — WHERE THE PRIVATE HALF IS NOT.
--
-- Until now every row of `signing_keys` described a key whose private half the
-- registry had never seen: an author signed locally and registered the public
-- half. `skill.create_from_dir` inverts that — the system generates the key and
-- signs on the caller's behalf, so a private half now exists that belongs to
-- this deployment. It does NOT go in this column, and it does not go in SQLite
-- at all: the column holds a REFERENCE into the deployment's secret store, the
-- same indirection `webhooks.secret_ref` already uses for the §5.2 signing
-- secret, for the same reason [I-7] gives — a database dump, a backup or a
-- read-only audit connection must not be a way to obtain signing capability.
--
-- The column is also what tells the two kinds of key apart. A row with a NULL
-- `secret_ref` is a key the registry can only VERIFY against; a row with one is
-- a key it can also SIGN with. Nothing infers that distinction from a naming
-- convention, because a naming convention is something a caller can imitate.
--
-- `skill_versions.source_hash` — WHAT THE VERSION WAS PACKED FROM.
--
-- Server-side packing writes the §5 arrival marker INTO the package, and the
-- marker is derived from the version id, so two versions packed from one
-- identical source are byte-different by construction. `manifest_hash` and
-- `content_hash` therefore stop being able to answer "is this the same
-- submission again?" — they answer it, but always with "no", and a resubmission
-- would silently mint a new version instead of converging.
--
-- So the convergence check moves to the SOURCE, before the marker exists, and
-- this column is where that identity is kept. Rows written before this
-- migration carry NULL, which never equals a computed source hash: history that
-- was packed elsewhere converges with nothing, rather than converging by
-- accident with the first submission that arrives.
--
-- Strictly additive. No table is rebuilt, no constraint is relaxed, no row is
-- touched, and the 20-table shape of Appendix D.1 is unchanged.
ALTER TABLE signing_keys ADD COLUMN secret_ref TEXT;
ALTER TABLE skill_versions ADD COLUMN source_hash TEXT;
```

### D.2 SQL negative probes

Every probe below is executed as a test in this repository; each names the
constraint that must reject the write.

T-1 invalid enum event → CHECK reject · T-2 second terminal event (`failed` after `adopted`) → partial-unique reject · T-3 UPDATE receipt_events → INSERT_ONLY · T-4 DELETE adoption_receipts → INSERT_ONLY · T-5 UPDATE transparency_log → INSERT_ONLY · T-6 duplicate kid → UNIQUE reject · T-7 second receipt per request → UNIQUE reject · T-8 orphan receipt_event → FK reject · T-9 cross-workspace adoption of non-published version → tenancy-trigger reject · T-10 attempt_count>5 → CHECK reject · T-11 duplicate event kind per receipt → UNIQUE reject · T-12 skill owner from another workspace → TENANCY_OWNER_NOT_IN_WS · T-13 version author from another workspace → TENANCY_AUTHOR_NOT_IN_WS · T-14 `adopt_high_risk` approval without `adoption_request_id` → CHECK reject · T-15 kid with forbidden charset → CHECK reject · T-16 `adopt_high_risk` approval whose `skill_version_id` (V2) differs from its adoption_request's version (V1) → APPROVAL_VERSION_MISMATCH.

---

## Appendix E. NORMATIVE JSON Schema (Verified Skill Package manifest, 2020-12)

Ships in the public schema repo as `skill-package-v1.schema.json`. `additionalProperties: false` at every object level; the ONLY extension point is `x_ext`, a free-form object. Two of its members carry normative meaning and are read by the §7.3 human-approval matrix: `x_ext.destructive`, a boolean, where the value `true` and no other declares destructive operations; and `x_ext.blast_radius`, a string, where the values `large`, `fleet` and `org` declare a large blast radius and any other value or absence does not. Neither is required, and neither is constrained by the schema beyond `x_ext` being an object; the schema does not enforce their types, so a `destructive` that is not exactly `true` and a `blast_radius` outside those three strings simply fail to hold their §7.3 condition. All other content of `x_ext` is ignored by verifier and linter except the secret scan of gate 2, which covers the whole manifest. Sub-schemas for adopter-side payloads (`environment_descriptor`, `failure_report`, `rollback_report`, `evidence`) are separate documents in the same repo with the same strictness.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://skillonomia.dev/schema/skill-package-v1.schema.json",
  "type": "object", "additionalProperties": false,
  "required": ["skill_id","semantic_version","title","capability_statement","owner",
               "author_agent","created_at","license","access_policy",
               "scope","runtime","procedure","evidence","safety","lifecycle","integrity"],
  "properties": {
    "skill_id": {"$ref": "#/$defs/ulid"},
    "semantic_version": {"type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$"},
    "title": {"type": "string", "minLength": 3, "maxLength": 120},
    "capability_statement": {"type": "string", "minLength": 20, "maxLength": 1000},
    "owner": {"type": "string", "minLength": 1, "maxLength": 120},
    "author_agent": {"$ref": "#/$defs/ulid"},
    "created_at": {"type": "string", "format": "date-time"},
    "license": {"type": "string", "minLength": 3, "maxLength": 64},
    "access_policy": {"enum": ["private","invite","workspace","public"]},
    "did_vc_binding": {"type": "string"},
    "external_aliases": {"type": "array", "items": {"type": "string"}, "maxItems": 16},
    "scope": {"type": "object", "additionalProperties": false,
      "required": ["problem_class","non_goals","prerequisites","risk_level","required_approvals"],
      "properties": {
        "problem_class": {"type": "string", "minLength": 10, "maxLength": 500},
        "non_goals": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "prerequisites": {"type": "array", "items": {"type": "string"}},
        "risk_level": {"enum": ["low","medium","high"]},
        "required_approvals": {"type": "array", "items": {"enum": ["publish","adopt_high_risk"]}},
        "persona": {"type": "string"}, "maturity_tier": {"enum": ["experimental","stable","hardened"]}}},
    "runtime": {"type": "object", "additionalProperties": false,
      "required": ["model_compat","runtime_compat","tool_compat","os","shell",
                   "cloud_iam_assumptions","mcp_dependencies"],
      "properties": {
        "model_compat": {"$ref": "#/$defs/matcherList"},
        "runtime_compat": {"$ref": "#/$defs/matcherList"},
        "tool_compat": {"$ref": "#/$defs/matcherList"},
        "os": {"type": "array", "items": {"enum": ["linux","macos","windows"]}, "minItems": 1},
        "shell": {"type": "array", "items": {"enum": ["bash","zsh","sh","powershell","none"]}, "minItems": 1},
        "cloud_iam_assumptions": {"type": "array", "items": {"type": "string"}},
        "mcp_dependencies": {"type": "array", "items": {"type": "object", "additionalProperties": false,
          "required": ["registry_id","version"],
          "properties": {"registry_id": {"type": "string"}, "version": {"$ref": "#/$defs/exactVersion"}}}},
        "a2a_agent_card_refs": {"type": "array", "items": {"type": "string"}}}},
    "procedure": {"type": "object", "additionalProperties": false,
      "required": ["steps","expected_outputs","validation_gates","rollback","failure_modes","tools_used"],
      "properties": {
        "steps": {"type": "array", "minItems": 1, "items": {"type": "object", "additionalProperties": false,
          "required": ["n","instruction"], "properties": {
            "n": {"type": "integer", "minimum": 1}, "instruction": {"type": "string", "minLength": 5},
            "command": {"type": "string"}, "expected": {"type": "string"}}}},
        "expected_outputs": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "validation_gates": {"type": "array", "minItems": 1, "items": {"type": "object",
          "additionalProperties": false, "required": ["gate_id","check","pass_criteria"],
          "properties": {"gate_id": {"type": "string"}, "check": {"type": "string"},
                          "pass_criteria": {"type": "string"}}}},
        "rollback": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        "failure_modes": {"type": "array", "items": {"type": "object", "additionalProperties": false,
          "required": ["mode","symptom","mitigation"], "properties": {
            "mode": {"type": "string"}, "symptom": {"type": "string"}, "mitigation": {"type": "string"}}}},
        "tools_used": {"$ref": "#/$defs/matcherList"},
        "scripts": {"type": "array", "items": {"type": "string"}},
        "deterministic_fixtures": {"type": "array", "items": {"type": "string"}}}},
    "evidence": {"type": "object", "additionalProperties": false,
      "required": ["summary","test_results","redaction_level"],
      "properties": {
        "summary": {"type": "string", "minLength": 20},
        "test_results": {"type": "string"},
        "redaction_level": {"enum": ["none","standard","strict"]},
        "signed_trace_hash": {"$ref": "#/$defs/hex64"},
        "benchmark": {"type": "string"}, "third_party_attestation": {"type": "string"}}},
    "safety": {"type": "object", "additionalProperties": false,
      "required": ["forbidden_actions","secrets_policy","dependency_manifest",
                   "url_allowlist","sandbox_requirement"],
      "properties": {
        "forbidden_actions": {"type": "array", "items": {"type": "string"}},
        "secrets_policy": {"type": "string", "minLength": 10},
        "dependency_manifest": {"type": "array", "items": {"type": "object", "additionalProperties": false,
          "required": ["name","version"], "properties": {
            "name": {"type": "string"}, "version": {"$ref": "#/$defs/exactVersion"},
            "ecosystem": {"type": "string"}}}},
        "url_allowlist": {"type": "array", "items": {"type": "string", "format": "uri"}},
        "sandbox_requirement": {"enum": ["none","recommended","required"]},
        "slsa_intoto_provenance": {"type": "string"}, "sigstore_signatures": {"type": "string"}}},
    "lifecycle": {"type": "object", "additionalProperties": false, "required": ["supersedes"],
      "properties": {"supersedes": {"oneOf": [{"$ref": "#/$defs/ulid"}, {"type": "null"}]},
                      "dispute_state": {"type": "string"}}},
    "integrity": {"type": "array", "items": {"type": "object", "additionalProperties": false,
      "required": ["path","sha256"], "properties": {
        "path": {"type": "string", "pattern": "^(?!/)(?!.*\\.\\.)[^\\\\]+$"},
        "sha256": {"$ref": "#/$defs/hex64"}}}},
    "x_ext": {"type": "object"}
  },
  "$defs": {
    "ulid": {"type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"},
    "hex64": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
    "exactVersion": {"type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$"},
    "matcherList": {"type": "array", "items": {"type": "object", "additionalProperties": false,
      "required": ["id","range"], "properties": {
        "id": {"type": "string", "minLength": 1, "maxLength": 80},
        "range": {"type": "string", "minLength": 1, "maxLength": 40}}}}
  }
}
```

Constraint notes: `risk_level: high` ⇒ `sandbox_requirement` MUST be `required` (cross-field rule enforced by linter gate 1, not expressible cleanly in-schema); `high` also forces `required_approvals ⊇ [publish, adopt_high_risk]`. Registry-side groups never appear in this manifest; their schemas are in E.2.

### E.2 NORMATIVE sub-schemas (adopter payloads & registry responses)

All draft 2020-12, `additionalProperties: false`. **Each schema block below is fully self-contained: every `$ref` resolves to a LOCAL `$defs` inside the same block — no external file needed.** These are actual normative contracts, not placeholders.

**`environment-descriptor-v1.schema.json`** (input to `skill.adopt`; compat match §4.2):
```json
{"type":"object","additionalProperties":false,
 "required":["runtime","model","tools","os","shell","sandbox_capable"],
 "properties":{
   "runtime":{"type":"object","additionalProperties":false,"required":["id","version"],
     "properties":{"id":{"type":"string","maxLength":80},"version":{"$ref":"#/$defs/exactVersion"}}},
   "model":{"type":"object","additionalProperties":false,"required":["id","version"],
     "properties":{"id":{"type":"string","maxLength":80},"version":{"$ref":"#/$defs/modelIdentifier"}}},
   "tools":{"type":"array","items":{"type":"object","additionalProperties":false,
     "required":["id","version"],"properties":{"id":{"type":"string","maxLength":80},
     "version":{"$ref":"#/$defs/exactVersion"}}}},
   "os":{"enum":["linux","macos","windows"]},
   "shell":{"enum":["bash","zsh","sh","powershell","none"]},
   "sandbox_capable":{"type":"boolean"}},
 "$defs":{
   "exactVersion":{"type":"string","pattern":"^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$"},
   "modelIdentifier":{"type":"string","minLength":1,"maxLength":80}}}
```

**Why `model.version` is not `exactVersion`, and why `runtime.version` still is
(normative, and deliberately asymmetric).** The two fields look alike and are
not alike. A runtime — `node`, `bun`, `claude-code` — publishes a version that
is genuinely a semantic version: it is ordered, comparable, and §4.2's
`runtime_compat` ranges decide compatibility by comparing against it, so
`exactVersion` is the right type and MUST stay. A model has no version separate
from its identity: `claude-opus-5` **is** the identifier and the version at
once, and there is no `5.0.0` to report. Requiring `exactVersion` there did not
make the field precise; it made it FALSE — an adopter reporting its environment
truthfully was refused with `INVALID_SCHEMA`, and the only way through was to
invent a number. A registry whose purpose is to record the environment a package
was actually adopted in cannot compel fiction in the one field that describes the
model. Hence `modelIdentifier`: a non-empty string of at most 80 characters,
which is what a model identity is.

The relaxation is therefore about the SUBJECT, not about strictness, and the
type names say so. There is no `versionLoose`/`versionStrict` pair here and MUST
NOT be one: such names describe how hard a check is rather than what it checks,
and invite a later reader to pick the lenient one for the quiet life. An
implementation MUST NOT relax `exactVersion` itself — `runtime.version` and
`tools[].version` share it, and both are compared as ordered versions.

One consequence follows and is stated rather than left to be discovered: because
a model identifier is not an ordered version, a `model_compat` matcher whose
`range` is a comparator (`>=…`, `^…`, an exact version) can never be satisfied by
a truthful model identifier, and the clause is UNMET under §4.2's deny-by-default
rule. A matcher that means "any model" writes `*`; matching a NAMED model in V1
is done by the matcher's `id`, whose comparison is equality. V1 adds no
identifier-comparison form to the range grammar of §4.2.

**`evidence-v1.schema.json`** (payload of receipt event `adopted`; registry validates `gate_results[].gate_id` ⊆ the version's declared `validation_gates` and requires every declared gate present with `pass:true`. A version declaring NO `validation_gates`, or declaring two gates with the same `gate_id`, or one whose `gate_id` is not a string, admits no valid evidence at all — there is nothing well-defined for evidence to be checked against, and the refusal is on the version, not on the adopter. `synthesized` declares the shape of the §5.3 auto-ack marker written on `delivered`; that marker is not validated against this schema and, lacking `gate_results`, never validates as `adopted` evidence):
```json
{"type":"object","additionalProperties":false,"required":["gate_results"],
 "properties":{
   "gate_results":{"type":"array","minItems":1,"items":{"type":"object","additionalProperties":false,
     "required":["gate_id","pass","observed"],"properties":{
       "gate_id":{"type":"string"},"pass":{"type":"boolean"},
       "observed":{"type":"string","maxLength":4000}}}},
   "notes":{"type":"string","maxLength":2000},
   "synthesized":{"type":"boolean"}}}
```

**`failure-report-v1.schema.json`** (payload of `failed`):
```json
{"type":"object","additionalProperties":false,"required":["category","summary"],
 "properties":{
   "category":{"enum":["pre_execution","compatibility","gate_failed","environment","other"]},
   "summary":{"type":"string","minLength":10,"maxLength":4000},
   "failed_gate_ids":{"type":"array","items":{"type":"string"}},
   "logs_excerpt":{"type":"string","maxLength":8000}}}
```
Rule: `failed` from derived state `delivered` (before `attempted`) REQUIRES `category:"pre_execution"` (§5.3).

**`rollback-report-v1.schema.json`** (payload of `rolled_back`):
```json
{"type":"object","additionalProperties":false,"required":["reason","summary"],
 "properties":{
   "reason":{"enum":["regression","incident","policy","superseded"]},
   "summary":{"type":"string","minLength":10,"maxLength":4000},
   "rolled_back_at_step":{"type":"integer","minimum":1}}}
```

**`version-registry-view-v1.schema.json`** (registry-side groups in every version response):
```json
{"type":"object","additionalProperties":false,
 "required":["state","superseded_by","deprecation_date","revocation_reason",
             "receipt_ids","reviewer_notes","reputation"],
 "properties":{
   "state":{"enum":["draft","linted","reviewed","verified","published","deprecated","superseded","revoked"]},
   "superseded_by":{"oneOf":[{"$ref":"#/$defs/ulid"},{"type":"null"}]},
   "deprecation_date":{"oneOf":[{"type":"string","format":"date-time"},{"type":"null"}]},
   "revocation_reason":{"oneOf":[{"type":"string"},{"type":"null"}]},
   "receipt_ids":{"type":"array","items":{"$ref":"#/$defs/ulid"}},
   "reviewer_notes":{"type":"array","items":{"type":"string"}},
   "reputation":{"type":"object","additionalProperties":false,
     "required":["adoption_attempts","adopted_count","failed_count","rolled_back_count",
                 "avg_rating","failure_modes_observed"],
     "properties":{
       "adoption_attempts":{"type":"integer","minimum":0},
       "adopted_count":{"type":"integer","minimum":0},
       "failed_count":{"type":"integer","minimum":0},
       "rolled_back_count":{"type":"integer","minimum":0},
       "avg_rating":{"oneOf":[{"type":"number","minimum":1,"maximum":5},{"type":"null"}]},
       "failure_modes_observed":{"type":"array","items":{"type":"string"}}}}},
 "$defs":{
   "ulid":{"type":"string","pattern":"^[0-9A-HJKMNP-TV-Z]{26}$"}}}
```

---

## Appendix F. Executed byte-level signing vector TV-01 (full manifest, Appendix E-valid)

TV-01 is the seed package `hello-skillonomia`, shipped under `seed/`. The manifest below validates against Appendix E with **0 errors**, then is signed per §4.3. All intermediates are complete — no elisions. Any conforming implementation MUST reproduce every value byte-for-byte.

Package files:
- `SKILL.md` = `# hello-skillonomia (TV-01)\nRun the fixture and report its output.\n` → sha256 `9aa9fcc8c19358ef683f752e3dc2f5462661f3e4770a80b484737d8528cafbbb`
- `fixtures/tv01.sh` = `echo skillonomia-tv01-ok\n` → sha256 `956e69331b9fb00e1d465eda3c6a8ed508163fe90428541e3b6d4c645529b360`

Deterministic key: seed (hex) `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`; public key (b64url raw 32B) `A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg`; `kid` = `tv-key-1` (conforms to `[a-z0-9-]{1,64}`).

JCS(M), 1889 bytes, exact:

```
{"access_policy":"workspace","author_agent":"01TVAG0000000000000000000A","capability_statement":"Deterministic low-risk test-vector skill: run one fixture command and verify its output.","created_at":"2026-08-01T00:00:00Z","evidence":{"redaction_level":"none","summary":"Deterministic fixture prints a fixed string; gate g1 compares stdout.","test_results":"local: g1 pass"},"integrity":[{"path":"SKILL.md","sha256":"9aa9fcc8c19358ef683f752e3dc2f5462661f3e4770a80b484737d8528cafbbb"},{"path":"fixtures/tv01.sh","sha256":"956e69331b9fb00e1d465eda3c6a8ed508163fe90428541e3b6d4c645529b360"}],"license":"Apache-2.0","lifecycle":{"supersedes":null},"owner":"tv-workspace","procedure":{"expected_outputs":["skillonomia-tv01-ok"],"failure_modes":[{"mitigation":"install a POSIX shell","mode":"shell-missing","symptom":"sh not found"}],"rollback":["No changes made; nothing to roll back."],"steps":[{"command":"sh fixtures/tv01.sh","expected":"skillonomia-tv01-ok","instruction":"Run the fixture script.","n":1}],"tools_used":[{"id":"shell","range":"*"}],"validation_gates":[{"check":"stdout equals expected string","gate_id":"g1","pass_criteria":"stdout == 'skillonomia-tv01-ok'"}]},"runtime":{"cloud_iam_assumptions":[],"mcp_dependencies":[],"model_compat":[{"id":"any","range":"*"}],"os":["linux","macos"],"runtime_compat":[{"id":"any","range":"*"}],"shell":["bash","sh"],"tool_compat":[{"id":"shell","range":"*"}]},"safety":{"dependency_manifest":[],"forbidden_actions":["network access","file writes outside workdir"],"sandbox_requirement":"none","secrets_policy":"No secrets used or accepted.","url_allowlist":[]},"scope":{"non_goals":["Any production use"],"prerequisites":[],"problem_class":"Smoke-testing a Skillonomia deployment end to end.","required_approvals":[],"risk_level":"low"},"semantic_version":"1.0.0","skill_id":"01TVSK0000000000000000000A","title":"TV-01 hello-skillonomia"}
```

- Schema validation (Draft202012Validator, Appendix E): **PASS, 0 errors**
- `manifest_hash` (lowercase hex): `5498c4f560409b1dbdf78794d5072a36672e54c825dbad6d0f1b89ea5fd794d0`
- `D` b64url: `VJjE9WBAmx2994eU1QcqNmcuVMgl261tDxuJ6l_XlNA`

The following three values are COMPLETE byte strings with **zero elisions**. Note on punctuation, to preclude misreading: the single `.` inside the signing input is the JWS component separator, and the double `..` inside the compact serialization is the RFC 7515 section 7.1 empty-payload slot of the DETACHED form (`BASE64URL(P) + ".." + BASE64URL(sig)`, §4.3.6) — neither is an ellipsis; no `...` (three-dot) sequence appears in any value.

- Protected header `P` (exact 32 bytes, ASCII): `{"alg":"EdDSA","kid":"tv-key-1"}`
- `BASE64URL(P)` (43 chars, complete): `eyJhbGciOiJFZERTQSIsImtpZCI6InR2LWtleS0xIn0`
- Signing input (87 chars, complete): `eyJhbGciOiJFZERTQSIsImtpZCI6InR2LWtleS0xIn0.VJjE9WBAmx2994eU1QcqNmcuVMgl261tDxuJ6l_XlNA`
- Signature `BASE64URL(sig)` (86 chars, complete): `pOKoUX1sVgwSe65Ml1MpF9VKil_SVUb9D5Y38LkMDNKCfbcZJE1j8zigg7LGiVo7wZgTyHEa2DIgy8BTM3FCAg`
- `SIGNATURE.jws` compact detached (131 chars, complete): `eyJhbGciOiJFZERTQSIsImtpZCI6InR2LWtleS0xIn0..pOKoUX1sVgwSe65Ml1MpF9VKil_SVUb9D5Y38LkMDNKCfbcZJE1j8zigg7LGiVo7wZgTyHEa2DIgy8BTM3FCAg`
- Executed verification result: SHA-256(JCS(M)) recomputed = `5498c4f560409b1dbdf78794d5072a36672e54c825dbad6d0f1b89ea5fd794d0` (matches `manifest_hash`); Ed25519 verify of `sig` over the signing input with public key `A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg`: **VALID** (roundtrip executed)

---

## Appendix G. NORMATIVE gate data tables (§7.1)

The gates of §7.1 are declared deterministic and their enumerations are
exhaustive contracts (§ Conformance language). The data those enumerations rest
on is therefore given here in full, so that two implementations reach the same
verdict on the same package without reading each other's source. Patterns are
written as ECMAScript regular-expression source text; where a pattern is
case-insensitive this is stated, and no other flag changes a verdict.

Two of these data sets — G.3's shortener host set and the whole of G.6 — are
**deployment configuration**: they describe a world that moves (which hosts
shorten URLs, which upstreams are deprecated, when a version shipped) rather
than a property of the package format, and a deployment MAY extend them. The
values below are the shipped defaults, and they are the values a conformance run
of §4.5 and §7.1 is judged against. Everything else in this appendix is fixed
contract.

### G.1 Gate 2 — key-like secret patterns

A match of any pattern, in any scan target, is a FAIL. Scan targets are the
serialized manifest, `SKILL.md`, every file under `fixtures/` and every file
under `evidence/`.

Patterns are given verbatim, one `id` and one pattern per line, so that the
source text is unambiguous:

```
jwt              \beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b
aws-access-key   \bAKIA[0-9A-Z]{16}\b
pem-private-key  -----BEGIN [A-Z ]*PRIVATE KEY-----
github-token     \bghp_[A-Za-z0-9]{36}\b
slack-token      \bxox[baprs]-[A-Za-z0-9-]{10,}\b
google-api-key   \bAIza[0-9A-Za-z_-]{35}\b
```

**The redaction convention, normatively.** A redaction token matches
`⟦REDACTED:[a-z0-9_-]{1,32}⟧`. Every scan target is scanned in **both**
readings: once with each token replaced by a single space (the token as a
separator, its normal use), and once with each token deleted (its neighbours
concatenated). A hit in either reading is a finding; a genuine redaction hits in
neither. Scanning only the separator reading would let raw secret material be
split by a token — `AKIA⟦REDACTED:x⟧IOSFODNN7EXAMPLE` — and hidden from every
pattern. The token itself is never a finding.

### G.2 Gate 2 — high-entropy heuristic

Candidate tokens are the maximal runs matching `[A-Za-z0-9+/=_-]{40,}`. A
candidate is a FAIL finding iff **all** of the following hold:

1. its length is ≥ 40 characters;
2. it is **not** entirely hexadecimal (`^[0-9a-fA-F]+$` disqualifies it —
   integrity digests and trace hashes are legitimate manifest content);
3. at least 3 of these 4 character classes occur in it: `[a-z]`, `[A-Z]`,
   `[0-9]`, `[+/=_-]`;
4. its Shannon entropy is ≥ 4.5 bits per character, computed over the
   frequencies of the token's own characters: `H = −Σ p·log₂ p`, where `p` is
   each distinct character's count divided by the token length.

Random base64 material sits well above the threshold; prose and identifiers sit
well below.

### G.3 Gate 4 — URL denylist

Independently of `url_allowlist`, and after canonicalizing the host (lowercase,
drop one trailing dot), gate 4 FAILs a URL whose scheme is not exactly `https:`,
whose host matches the raw-IP pattern
`^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:]+\])$`, whose host is empty, which
carries userinfo, or whose canonicalized host is one of the shortener hosts
below. Allowlist matching itself is origin-based: scheme, canonicalized host and
port must match an entry exactly, and an entry with a path constrains the URL's
path at a segment boundary.

**Shortener hosts** (configurable; shipped default): `bit.ly` · `tinyurl.com` ·
`t.co` · `goo.gl` · `is.gd` · `ow.ly` · `buff.ly` · `rb.gy`.

### G.4 Gate 5 — shell severity table

This is the severity table §7.1 gate 5 refers to. Detection is **structural**,
decided from a parse that tracks quoting per character, separates operators, and
follows a segment's **command chain** — every command the segment runs,
outermost first — so that no prefix can hide a class behind itself. The ways a
class can be spelled are unbounded, the class is not. A path-qualified
invocation is the same command (`/bin/rm` is `rm`).

**What is not a command word.** A prefix the shell runs a command *behind* is
transparent to the chain: the command carrying it classifies exactly as the same
command without it. Three kinds, and the difference between them is the
difference between a rule and a list:

- a leading `VAR=value` **assignment**;
- the reserved word **`!`**, which negates a pipeline's exit status. Only the
  bare unquoted word is the reserved word — `'!'` and `\!` name a program;
- a **redirection**, which POSIX permits anywhere in a simple command including
  before the command word (`>log eval "$X"` runs `eval`). An optional fd number
  or `&`, then an unquoted `>`, `>>`, `>&`, `>|`, `<`, `<&`, `<>` or `<<`; the
  target is part of the same word when it is written against the operator
  (`>log`) and the next word when it is not (`> log`). The operator must be
  unquoted: `'>'x` is an ordinary word.

The first three are **syntax**, decided from the parse, and need no list. The
fourth kind is a **name table** and therefore cannot be complete:

**Wrapper commands** (name table; shipped default): `env` · `sudo` · `doas` ·
`nohup` · `setsid` · `time` · `command` · `exec` · `nice` · `ionice` ·
`builtin` · `coproc` · `timeout` · `stdbuf` · `chroot` · `taskset` · `setarch` ·
`unshare` · `nsenter` · `flock` · `xargs` · `runuser` · `strace` · `ltrace` ·
`proxychains` · `torify` · `pkexec`.

For a wrapper whose command argument can sit behind **positional operands**
(`timeout 5 CMD`, `flock FILE CMD`, `chroot DIR CMD`, `taskset MASK CMD`,
`setarch ARCH CMD`, `runuser USER CMD`), and for any wrapper carrying a flag,
which operand is the command is per-wrapper knowledge this gate does not model:
every following word becomes a command candidate instead — conservative, and the
reason a trailing unreadable word such as `"$X"` then reports as
`unclassifiable-command-name` rather than as the named class behind it.

**A prefix wrapper nobody listed still hides what it runs.** That is a limit of
the table, not of the parse, and it is stated here rather than left to be
discovered: gate 5 closes the classes it enumerates, and this list is one of the
enumerations §7.1 warns about.

**Privilege-escalating commands** (name table; shipped default): `sudo` ·
`sudoedit` · `su` · `doas` · `runuser` · `pkexec`. Any of them anywhere in a
segment's command chain is the `sudo` class below, which is named after its most
common member and not limited to it: they do one thing, which is to run the rest
of the command as another user, and a package that takes root through `su` takes
it exactly as one that takes it through `sudo`.

Two of them — `su` and `runuser` — take their payload as an inline code
**string** (`su root -c '…'`), which they hand to the target user's login shell
exactly as `sh -c` does. Such a line reports **both** `sudo` and
`interpreter-inline-code`, and nothing else: the escalation is a fact about the
command word and the opacity is a fact about its argument, and dropping either
would misdescribe the line. The payload itself is not read — reading it could
not make a FAIL more failing, and the class already denies.

The line is drawn at **local** execution, deliberately. `ssh host …` and
`docker run img …` also run a command as another user somewhere, and neither is
this class: what they run does not execute on the machine running the step, so
this gate is not the thing that decides it. Their command argument is likewise
not followed — `ssh host rm -rf /` and `docker run img rm -rf /` are PASS, by
design and not by omission. This is one more of the enumerations §7.1 warns
about, and the table is no more complete than the wrapper one above.

Scan targets: every file under `scripts/`, every entry of
`procedure.scripts[]`, and every `steps[].command`. Each target is first
stripped of comments — an unquoted `#` at the start of a word runs to the end of
its line — then split into **logical** lines: a physical newline does not end a
command when the stripped line ends in `|`, `&&`, `||`, `;` or a backslash, or
when it ends inside an open quote. Each logical line is classified on its own.

| Class | What it catches | Severity |
|---|---|---|
| `curl-pipe-shell` | a fetcher (`curl`, `wget`, `fetch`) whose output is piped into a shell interpreter (`sh`, `bash`, `zsh`, `dash`, `ksh`, `csh`, `ash`, `busybox`) | FAIL |
| `sudo` | a privilege-escalating command — `sudo`, `sudoedit`, `su`, `doas`, `runuser`, `pkexec` — anywhere in a segment's command chain, so a prefix cannot hide it: `! sudo …`, `>log sudo …`, `timeout 5 sudo …` and `su root -c '…'` are all this class | FAIL |
| `rm-rf-variable-or-root` | `rm` carrying both `r` and `f` among the flags that precede its operands, with at least one operand a dangerous target: a word carrying an expansion or command substitution, the filesystem root (`/`, `//`, …), or an ACTIVE — unquoted, unescaped — glob character `*`, `?` or `[` | FAIL |
| `background-daemon` | an unquoted `&` used as a separator (not `&&`, not part of a redirect), or a daemonizer in the command chain: `nohup`, `setsid`, `daemonize`, `disown`, `coproc` | WARN |
| `unquoted-expansion` | a word carrying `$NAME` or `${NAME}` outside quotes (`"$TARGET"` is not this class) | WARN |
| `unparseable-command` | the line ends inside an open quote and cannot be parsed | FAIL |
| `unclassifiable-command-name` | the command NAME is not statically readable — an expansion or substitution in the name part of the command word (`"$CMD"`, `/usr/bin/$TOOL`). An expansion only in the directory part (`$PREFIX/bin/rm`) leaves the name readable and is NOT this class | FAIL |
| `command-substitution` | any word containing `$(…)` or a backtick substitution, in any position | FAIL |
| `eval-or-source` | `eval`, `source` or `.` in a command chain — they execute text the gate never sees | FAIL |
| `interpreter-inline-code` | a shell interpreter invoked with an inline-code flag of its own: any `-…c…` letter combination, or `--command` | FAIL |
| `piped-into-interpreter` | a shell interpreter reading its code from a pipe whose producer is not a fetcher (a fetcher producer reports as `curl-pipe-shell` instead) | FAIL |
| `control-construct` | a subshell, a brace group, a function definition, or a shell control keyword: `if`, `then`, `elif`, `else`, `fi`, `for`, `while`, `until`, `do`, `done`, `case`, `esac`, `select`, `function` | FAIL |

The four opacity classes (`unparseable-command`, `unclassifiable-command-name`,
`command-substitution`, `control-construct`) and the three indirection classes
(`eval-or-source`, `interpreter-inline-code`, `piped-into-interpreter`) are the
deny-by-default posture of §7.1 made concrete: what the gate cannot read
statically is a FAIL, because the command that actually runs is only decided at
run time. Any of these seven classifies the logical line on its own and
preempts the remaining classes for that line — with the one paired exception
named above, `su`/`runuser` carrying `-c`, which reports `sudo` alongside
`interpreter-inline-code` and still preempts everything else. This changes which
findings are reported, never the gate's FAIL/WARN/PASS result, which is the
worst severity over all findings.

### G.5 Gate 6 — prompt-injection patterns

Scan targets: `SKILL.md`, and every `steps[].instruction` and
`steps[].expected`. Every pattern below is **case-insensitive**; a match is a
FAIL.

Verbatim, one `id` and one pattern per line:

```
ignore-instructions  \bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|rules|guidance)\b
disregard-safety     \bdisregard\s+(your|the|all)\s+(instructions|guidelines|safety|policies)\b
disable-safety       \bdisable\s+(the\s+)?(safety|guardrails?|checks|filters)\b
exfiltrate           \bexfiltrat
leak-secrets         \b(send|post|upload|forward)\s+(the\s+|your\s+|all\s+)?(credentials?|secrets?|api[_ ]?keys?|tokens?|\.env)\b
hide-from-owner      \bdo\s+not\s+(tell|inform|reveal\s+to|mention\s+to)\s+the\s+(user|owner|human)\b
persona-override     \byou\s+are\s+now\s+(in\s+)?(developer\s+mode|dan|jailbreak)\b
```

Gate 6 carries one further rule, the "contact an endpoint outside the
allowlist" clause: within a single line of a scan target, a match of the
case-insensitive verb pattern
`\b(curl|wget|fetch|post|send|upload|open|visit|call)\b`, together with a URL
on that same line that is not admitted by `url_allowlist` (origin-based, per
G.3), is a FAIL.

### G.6 Gate 7 — staleness policy

Configurable; the values below are the shipped defaults. The gate logic is
fixed contract, the table content is not.

**Entries examined.** Every `runtime.mcp_dependencies` entry as
`(registry_id, version)`; every `safety.dependency_manifest` entry as
`(name, version)`; and every matcher of `procedure.tools_used`,
`runtime.runtime_compat`, `runtime.tool_compat` and `runtime.model_compat` as
`(id, v)` where `v` is the first substring of the matcher's `range` matching
`(\d+\.\d+(\.\d+)?)` — a matcher whose range carries no such substring
contributes no entry.

**Decision, per entry, first rule that applies wins:**

1. the id is in the deprecated list, and either that row carries no `before` or
   the entry's version is lower than it → **FAIL**;
2. the id is in the EOL list and the entry's version is lower than that row's
   `before` → **WARN**;
3. the pair `id@version` has a known release date and
   `now − released > policy window` → **WARN**;
4. otherwise the entry contributes nothing.

Version comparison is numeric over the first three components, obtained by
splitting on `.` or `-` and reading each component as a decimal integer, absent
or non-numeric components counting as 0.

**Policy window:** 730 days (`730 × 24 × 3600 × 1000` ms).

**Deprecated upstreams → FAIL, any version:** `request` · `left-pad` ·
`node-uuid`.

**End-of-life lines → WARN below the given version:**

| id | below |
|---|---|
| `node` | `18.0.0` |
| `python` | `3.8.0` |
| `ubuntu` | `20.04.0` |

**Known release dates, for the policy-window rule** (UTC; lines that are also
EOL-listed never reach this rule, so the table carries only window-old ones):

| pin | released |
|---|---|
| `terraform@1.0.0` | 2021-06-08 |
| `kubectl@1.21.0` | 2021-04-08 |
| `node@14.0.0` | 2020-04-21 |
| `python@3.6.0` | 2016-12-23 |

---

## Appendix H. NORMATIVE API / MCP contracts (14 surfaces + auxiliaries + auth + internal worker API)

Conventions binding for every surface: REST base `/v1`; MCP tool names as listed, served as streamable HTTP at `POST /mcp` on the same listener — one JSON-RPC 2.0 message per request, methods `initialize`, `tools/list` and `tools/call`, with a surface failure returned as the §6 error envelope inside a tool result carrying `isError: true`. AuthN: `Authorization: Bearer <api_key>`. AuthZ: role requirements per the §6 ACL matrix — enforced identically on REST and MCP. Errors: JSON `{"error":{"code","message","current_state"?}}` with the twelve codes §6 closes over — `UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | PRECONDITION_FAILED | INVALID_SCHEMA | RATE_LIMITED | UNKNOWN_KEY | BAD_SIGNATURE | TAMPERED_CONTENT | MALFORMED_ARCHIVE | LIMIT_EXCEEDED` — and their fixed HTTP statuses; `PRECONDITION_FAILED`/`CONFLICT` MUST include `current_state` (converging-conflict rule, §6). The §4.4 verdicts, `NOT_LOGGED` included, are NEVER error codes: they are values of a successful response's `verdict` field. Idempotency: every mutating call takes optional `idempotency_key` (string ≤128); replay returns the persisted original response with header `Idempotency-Replayed: true` and identical body — and the same HTTP status as the original, so a replay is indistinguishable from the first call except by the header. **Convergent noops carry `"noop": true` in the success body**, in addition to the fields the row below lists, whenever a mutation found the resource already in the state it asks for; the row says which fields such a body repeats. Pagination (search/list): `?limit=` (1–100, default 20) + `?cursor=` (opaque); response `{"items":[...],"next_cursor":null|string}`. Search filters: the declared filter set of surface 5 is exactly `q`, `capability`, `runtime`, `tool`, `risk`, `state`, `min_adopted` and `min_rating`, and they combine with AND; `limit` and `cursor` are pagination controls, not filters. The two trust-threshold filters read only the registry-computed Reputation group, never an author-declared field: `min_adopted` admits a version whose `reputation.adopted_count` is ≥ the given value, and `min_rating` admits a version whose `reputation.avg_rating` is non-null and ≥ the given value — a version with no rating yet fails a `min_rating` threshold rather than passing it by default. Request/response bodies validate against Appendix E schemas; body fields never override AuthContext identity.

| # | MCP tool | REST | Auth (min role) | Request body (normative fields) | Success response |
|---|---|---|---|---|---|
| 1 | `skill.create` | `POST /v1/skills` (new skill) · `POST /v1/skills/{skill_id}/versions` (new version) | member (author) | `{"slug"?,"archive":"<base64 §4.1b archive>","idempotency_key"?}`; the new-version form takes `skill_id` from the path (MCP: from the arguments object) | `201 {"skill_id","skill_version_id","state":"draft"}`. Re-posting an archive whose `manifest_hash` AND `content_hash` both equal an existing version of the same `semantic_version` converges: the same three fields, that version's CURRENT state rather than `draft`, plus `"noop":true`. Different content under a `semantic_version` that already exists → `CONFLICT{current_state}` |
| 2 | `skill.lint` | `POST /v1/versions/{id}/lint` | member (author/owner) | `{"idempotency_key"?}` | `200 {"reports":[{"gate","result","details"}×8],"state"}` — one entry per §7.1 gate, in §7.1 order, `gate` ∈ the `lint_reports.gate` enum, `result` ∈ `pass|fail|warn`, `details` a string or `null`. From `draft`, `state` is `linted` when no gate FAILed and stays `draft` when one did. Linting a version already past `draft` runs and stores the gates, changes no state, and adds `"noop":true` |
| 3 | `skill.review.request` | `POST /v1/versions/{id}/reviews` | request: author/skill owner; verdict: reviewer/admin/owner, neither author nor skill owner | `{"action":"request"}` or `{"action":"verdict","verdict":"approve\|reject\|conditional","note"?}`, plus `idempotency_key`? | `200 {"action","review_id","state"}` where `review_id` is `null` for `action:"request"` and a ULID for a verdict. `request` adds `"notified":[<agent_id>…]` (the eligible reviewers of §5.1, ordered by id) and, on an already-`reviewed` version, `"noop":true`. A verdict adds `"verdict"` and `"attestation_id"` — the ULID of the `attestations(kind='reviewer')` row inserted in the SAME transaction on `approve`, and `null` on `reject`/`conditional` |
| 4 | `skill.verify` | `POST /v1/versions/{id}/verify` (transition) · `POST /v1/verify` (stateless §4.4 over uploaded package) | admin/owner; stateless: any authenticated | transition: `{"idempotency_key"?}`; stateless: `{"archive":"<base64>"}`. Over MCP one tool carries both forms and naming `skill_version_id` and `archive_base64` together is `INVALID_SCHEMA` — never a silent choice | transition: `200 {"verdict","state","checks":[{"id","satisfied","detail"}×4],"reports":[{"gate","result","details"}×8]}`, where `id` ∈ `evidence_receipt \| reviewer_attestation \| compatibility_metadata \| safety_gates` — every conjunct is reported whether or not it holds, so a refusal names the missing one. On success it adds `"tlog_seq"` (the `version_verified` entry); any call that changed nothing adds `"noop":true`; `verdict:"revoked"` adds `"revocation_reason"` and `verdict:"valid_superseded"` adds `"successor_version_id"`. Stateless: `200 {"verdict"}` per §4.4.8, plus `"detail"?`, `"manifest_hash"?`, `"successor_version_id"?` and `"revocation_reason"?`. Both forms answer in the §4.4.8 vocabulary and NEITHER returns an error envelope for a verdict |
| 5 | `skill.search` | `GET /v1/skills?q=&capability=&runtime=&tool=&risk=&state=&min_adopted=&min_rating=&limit=&cursor=` | any authenticated (results filtered by §5.1 visibility × access policy) | — | `200 {"items":[…],"next_cursor":null\|string}`. Each item is `{"skill_id","slug","skill_version_id","semantic_version","state","access_policy","registry"}` plus `"title"?`, `"capability_statement"?` and `"risk_level"?` — present exactly when the stored manifest carries them as strings — plus `"warning":"deprecated"\|"superseded"` on those two states. `registry` is the `version-registry-view-v1` object of E.2, in full. Items are ordered by `(created_at_ms, id)` descending, which is also what `cursor` encodes |
| 6 | `skill.request_adoption` | `POST /v1/adoptions/requests` | member or X-ws (published only) | `{"skill_version_id","idempotency_key"?}` | `201 {"adoption_request_id","receipt_id","state":"pending"\|"approval_pending"}`, plus `"approval_required":[<§7.3 condition id>…]` exactly when the state is `approval_pending`, and `"webhook_id":null` exactly when the adopter has no selectable endpoint. A §7.3 condition does NOT refuse the call here — it creates the hold (§5.2); surface 7 is what refuses. A revoked version → `PRECONDITION_FAILED{current_state}`; a same-workspace version in `draft`/`linted` → `PRECONDITION_FAILED{current_state}`; a cross-workspace version that is visible but not `published` → `FORBIDDEN{current_state}` |
| 7 | `skill.adopt` | `POST /v1/adoptions/{request_id}/adopt` | the request's adopter only | `{"environment_descriptor" per E.2,"idempotency_key"?}` | `200 {"receipt_event":"delivered","event_seq","receipt_id","compat":{"result":"match\|mismatch","unmet":[<clause>…]},"package":{"skill_version_id","semantic_version","manifest_hash","content_hash","archive_base64"}}`, plus `"warning"` when a mismatch was accepted (`risk_level: low`). The declared `environment_descriptor` is RECORDED on the `delivered` event this call writes, in the same transaction (§5.3), and is readable afterwards through `GET /v1/receipts/{id}`. A request whose receipt chain has already begun → `PRECONDITION_FAILED{current_state}` and NO package, exactly as the receipt surface answers a late append: handover happens once, and the response carries no `noop` member. The one caller entitled to a repeat is the SAME principal replaying the SAME `idempotency_key`, which `withIdempotency` serves from the stored response of the original call — byte for byte, `archive_base64` included, because a repeat is a match of (principal, key) and never a match of state. Mismatch + risk medium/high → `PRECONDITION_FAILED{current_state}`; a `risk_level: high` package to an adopter not attesting `sandbox_capable` → `FORBIDDEN` (§7.2); a request still in `approval_pending` → `FORBIDDEN{current_state}`; a request dead-lettered `approval_denied` → `PRECONDITION_FAILED{current_state}` — the other four dead-letter reasons are notification failures and do NOT refuse handover; a `notification_kind:"revocation"` queue row → `NOT_FOUND` |
| 8 | `skill.validate_outcome` | `POST /v1/receipts/{receipt_id}/events` | the receipt's adopter only | `{"event":"attempted\|adopted\|failed\|rolled_back", "evidence"?\|"failure_report"?\|"rollback_report"? per E.2,"idempotency_key"?}` | `200 {"receipt_event","event_seq"}`, plus `"noop":true` on an idempotency replay and `"synthesized":{"receipt_event":"delivered","event_seq":1}` when the §5.3 table auto-acked a `delivered` in the same transaction. Illegal transition → `PRECONDITION_FAILED{current_state}` per the §5.3 table |
| 9 | `skill.rate` | `POST /v1/versions/{id}/ratings` | adopter with terminal `adopted` receipt | `{"score":1-5,"note"?,"adoption_receipt_id","idempotency_key"?}` | `201 {"rating_id","score"}`; a second rating by the same rater for the same version converges on the recorded one — the same two fields plus `"noop":true`. A receipt that is not the caller's → `NOT_FOUND`; a receipt of a different version → `PRECONDITION_FAILED{current_state}` naming that version; a chain whose derived state is not `adopted` → `PRECONDITION_FAILED{current_state}` naming the derived state |
| 10 | `skill.supersede` | `POST /v1/versions/{id}/supersede` | author/skill owner/reviewer/admin/owner | `{"successor_version_id","idempotency_key"?}` | `200 {"skill_version_id","state":"superseded","superseded_by","successor":{"skill_version_id","state"},"tlog_seq"}` — both versions' lifecycle links written atomically with the `version_superseded` entry. Already superseded → the same body minus `tlog_seq`, plus `"noop":true` and the RECORDED `superseded_by`. A successor that is not itself `verified`/`published` → `PRECONDITION_FAILED{current_state}`; a successor whose signed `lifecycle.supersedes` names a different version, or which already supersedes another → `CONFLICT{current_state}`; a successor of a different skill, or equal to the subject → `INVALID_SCHEMA`; a subject not `published` → `PRECONDITION_FAILED{current_state}` |
| 11 | `skill.revoke` | `POST /v1/versions/{id}/revoke` | author/skill owner/admin/owner | `{"reason","idempotency_key"?}` — `reason` a non-empty string of ≤2000 characters, or `INVALID_SCHEMA` | `200 {"skill_version_id","state":"revoked","reason","tlog_seq","notified_adopters"}` — `notified_adopters` is the count of §5.2 revocation notices queued in the same transaction (§6 surface 11); already revoked → the same body plus `"noop":true`, the ORIGINAL reason, and no second tlog row or notice |
| 12 | `skill.publish` | `POST /v1/versions/{id}/publish` | admin/owner | `{"idempotency_key"?}` | `200 {"skill_version_id","state":"published","manifest_hash","countersign_seq"}`; already published → the same body plus `"noop":true`; §7.3 approval missing → `FORBIDDEN{current_state}`; state ≠ `verified` → `PRECONDITION_FAILED{current_state}`, retired tails (`deprecated`/`superseded`/`revoked`) included; `CONFLICT{current_state}` only when the transition is legal (state `verified`) and a §4.3.9 countersign for this `manifest_hash` already exists |
| 13 | `skill.deprecate` | `POST /v1/versions/{id}/deprecate` | author/skill owner/admin/owner | `{"idempotency_key"?}` | `200 {"skill_version_id","state":"deprecated","deprecation_date","tlog_seq"}`; already deprecated → the same body plus `"noop":true` and the ORIGINAL `deprecation_date`, no second tlog row; state ≠ `published` → `PRECONDITION_FAILED{current_state}` |
| 14 | `skill.create_from_dir` | `POST /v1/skills/from-source` (new skill) · `POST /v1/skills/{skill_id}/versions/from-source` (new version) | member (author) | `{"slug"?,"source":"<base64 §4.1b archive of the SOURCE tree>","idempotency_key"?}`; the new-version form takes `skill_id` from the path (MCP: from the arguments object, and the upload field is `source_base64`). The source tree carries `manifest.json` and `SKILL.md` and MUST NOT carry `skill.json` or `SIGNATURE.jws` — those are produced here, and a source carrying them is `INVALID_SCHEMA` naming surface 1. The caller supplies NO cryptographic material: no seed, no `kid`, no `integrity`. `scripts/skln-arrive.sh` is a RESERVED path, generated here and overwritten if present | `201 {"skill_id","skill_version_id","state":"draft","arrival_marker","kid","manifest_hash","content_hash"}`. The registry mints `skill_version_id`, derives the §5 arrival marker from it, writes that marker into `SKILL.md`'s generated block AND into `scripts/skln-arrive.sh`, refuses to pack unless those two and the marker the id derives are the SAME value, computes §4.3 `integrity` over the resulting bytes and signs with a system-held key it generates for the caller on first use. The private half never crosses this boundary, in any direction: it is not an input, not an output, not a log line and not part of an error message [I-7]. Re-posting an unchanged SOURCE converges on the version already packed from it — the same fields, that version's CURRENT state, the marker THAT version derives, plus `"noop":true`. A different source under a `semantic_version` that already exists → `CONFLICT{current_state}` |

Provisioning auxiliaries (§6.1, normative there; request/response shapes fixed here):

| MCP tool | REST | Auth (min role) | Request body | Success response |
|---|---|---|---|---|
| `principal.create` | `POST /v1/principals` | admin/owner, not above own role | `{"name","type":"human\|agent\|service","role":"owner\|admin\|reviewer\|member","tool_profile"?}` — NO `idempotency_key` (§6.1) | `201 {"principal_id","workspace_id","name","type","role","tool_profile","status","created_at_ms","api_key_id","api_key"}`; `api_key` is shown ONCE. Duplicate name → `CONFLICT{current_state}` |
| `principal.list` | `GET /v1/principals` | member+ | — | `200 {"items":[{"principal_id","name","type","role","status","tool_profile","created_at_ms","active_api_keys","active_signing_keys"}]}` — own row for member/reviewer, the workspace for admin/owner |
| `principal.issue_api_key` | `POST /v1/principals/{id}/api-keys` | admin/owner, not above own role | `{}` — NO `idempotency_key` | `201 {"principal_id","api_key_id","created_at_ms","api_key"}`; non-active principal → `PRECONDITION_FAILED{current_state}` |
| `principal.revoke_api_key` | `POST /v1/principals/{id}/api-keys/{key_id}/revoke` | the key's principal, or admin/owner | `{"idempotency_key"?}` | `200 {"principal_id","api_key_id","revoked_at_ms"}`; already revoked → the same body plus `"noop":true` and the ORIGINAL time |
| `signing_key.register` | `POST /v1/signing-keys` | member+, binds the CALLER | `{"kid","public_key_ed25519","idempotency_key"?}` | `201 {"principal_id","kid","public_key_ed25519","created_at_ms","tlog_seq"}`; identical re-registration → the same body plus `"noop":true` and no second tlog row; any other kid collision → `CONFLICT{current_state}` |
| `signing_key.list` | `GET /v1/signing-keys` | member+ | — | `200 {"items":[{"principal_id","kid","public_key_ed25519","created_at_ms","revoked_at_ms"}]}` — own keys, or the workspace's for admin/owner |
| `signing_key.revoke` | `POST /v1/signing-keys/{kid}/revoke` | the key's principal, or admin/owner | `{"idempotency_key"?}` | `200 {"principal_id","kid","revoked_at_ms","tlog_seq"}`; already revoked → the same body plus `"noop":true`, the ORIGINAL time and no second tlog row |

Internal worker surface (NOT public, service-authenticated, single-binary in-process): `delivery.poll` (claim batch, CAS §5.2), `delivery.renew`, `delivery.complete`, `delivery.fail`.

**Auxiliary public surfaces** (non-numbered; the contracts below are as normative as the fourteen above). Where the MCP column is `—` the surface is REST-only, which §6 names as the one exception to the one-to-one mirror.

| MCP tool | REST | Auth (min role) | Request | Success response |
|---|---|---|---|---|
| — | `GET /health` | **none** — this route MUST answer before any credential exists | — | `200 {"status":"ok","service":"skillonomia","version"}`, where `version` is the single-source release version of the preamble. It carries no instance data beyond liveness |
| — | `POST /v1/auth/bootstrap` | **none** — one-time (§9.1) | `{"bootstrap_token"}` | `200 {"api_key","agent_id","role":"owner"}`. A second exchange, a wrong token or no outstanding token → `UNAUTHORIZED`; a non-string token → `INVALID_SCHEMA` |
| `skill.approve` | `POST /v1/versions/{id}/approvals` | admin/owner AND `agents.type='human'` | `{"scope":"publish\|adopt_high_risk","decision":"approved\|denied","adoption_request_id"?,"note"?,"idempotency_key"?}` | `201 {"approval_id","skill_version_id","adoption_request_id","scope","decision","conditions","tlog_seq"}` — `adoption_request_id` is `null` for a `publish` approval, `conditions` is the §7.3 condition-id list in force for this version, and `tlog_seq` is the `approval_recorded` entry. An `adopt_high_risk` approval MUST name its `adoption_request_id` and a `publish` approval MUST NOT; the same decision recorded twice converges with `"noop":true`. A non-human identity, or one without admin/owner, is `FORBIDDEN` before anything else is read |
| — | `GET /v1/receipts/{id}` | the adopter, the skill's owner, or an admin/owner of the version's workspace | — | `200 {"receipt_id","adoption_request_id","skill_version_id","adopter_agent_id","derived_state","stalled","events":[{"event","event_seq","server_at_ms","evidence","failure_report","rollback_report","environment_descriptor"}…]}` — events in ascending `event_seq`, the payload members `null` where the event carries none, `derived_state` per §5.3 (`none` on an empty chain) and `stalled` derived at read time. `environment_descriptor` is the environment declared at handover: non-null on `delivered` rows written by surface 7, `null` on every other row and on a synthesized `delivered`. It is served so an adopter can read back its OWN declaration in its OWN event — the read half of §5.3's rule that a write is confirmed by reading the state back. Anyone else → `NOT_FOUND` |
| `tlog.read` | `GET /v1/tlog?cursor=&limit=` | any authenticated | `cursor` = the `seq` to read AFTER (decimal, ≥0); `limit` 1–100, default 20 | `200 {"items":[{"seq","event_kind","subject_id","payload_hash","prev_hash","this_hash","server_at_ms"}…],"next_cursor":null\|string}` — ascending `seq`, every column of `transparency_log`, so the §4.4 chain walk can be reproduced from the API alone. A malformed cursor → `INVALID_SCHEMA` |
| — | `POST /v1/webhooks` | member+, own endpoint only | `{"url"}` — NO `idempotency_key`, for the reason §6.1 gives for the two secret-returning provisioning calls | `201 {"webhook_id","url","secret"}`; `secret` is shown ONCE and the URL is echoed exactly as written (§5.2). A URL the §5.2 registration rules refuse, or one longer than 2000 characters, or one Appendix D.1's `CHECK` cannot store → `INVALID_SCHEMA` with the reason |
| — | `GET /v1/webhooks` | member+, own endpoints only | — | `200 {"items":[{"webhook_id","url","status","failure_count"}…]}` — never the secret, never its reference |
| — | `DELETE /v1/webhooks/{id}` | the endpoint's own agent | — | `200 {"deleted":true}`; another agent's endpoint → `NOT_FOUND` |
| `migration.count` | `GET /v1/migrations?since_ms=&until_ms=&q=&capability=&runtime=&tool=&risk=&state=&min_adopted=&min_rating=&limit=&cursor=` | any authenticated; the counted skills are exactly those surface 5 makes visible to the caller | the surface-5 filters and pagination controls, plus an optional selection window: `since_ms`/`until_ms`, integer milliseconds, applied to the `server_at_ms` of the terminal event. A bound that is not an integer, or a pair in the wrong order, is `INVALID_SCHEMA` on BOTH adapters | `200 {"source","window","window_since_ms","window_until_ms","next_cursor","items":[{"skill_id","slug","migrations","distinct_recipients","distinct_runtimes","runtimes","runtimes_unknown","measurement_state","source","window"}…]}` — one row per visible SKILL. `migrations` counts DISTINCT (version, recipient) pairs whose receipt carries a terminal `adopted` event with server-validated evidence (§5.3); repeating a pair does not raise it. `distinct_recipients` counts the recipient agents among them and `distinct_runtimes` the DIFFERENT declared `environment_descriptor.runtime.id` values, read from the `delivered` events of those receipts. Every count MUST be computed from `receipt_events` and MUST NOT be computed from `adoption_requests.requester_context_json` (§5.3). Fail-closed: a migration whose declared runtime cannot be read contributes no runtime id at all and is reported in `runtimes_unknown`, which is therefore never interchangeable with `distinct_runtimes: 0`. A visible skill with no qualifying receipt is a row of zeroes with `measurement_state:"not_migrated"`, never an absent row, and every row restates its `source` and its `window` so no number is published without its method. This surface is strictly reading: it appends nothing, transitions nothing and takes no `idempotency_key` |
| `dashboard.view` | `GET /v1/dashboard/{view}?format=json\|html` · `GET /v1/dashboard` (the view list) | any authenticated; every row is scoped by the SAME ACL as the surface it is read from | `view` ∈ `library \| evidence \| receipts \| approvals \| dead_letters \| migrations`; `format` defaults to `json`, and any other value of either is `INVALID_SCHEMA` on BOTH adapters. The surface-5 filters and pagination controls are accepted by the views that page over versions | `200 {"view","title","views":[the six names],"sections":[{"key","title","fields":[…],"rows":[…],"empty","next_cursor"?}],"demo_mode"}`. `fields` names, in column order, the API fields of the numbered surfaces that the section's `rows` carry — the dashboard computes nothing of its own and is a rendering, never a second source of truth, which is why the CHOICE of sections is presentation and is not fixed here while the envelope, the six view names, the ACL scoping and `demo_mode` (§9.1) are. `format=html` renders that same payload: over REST as `text/html`, over MCP as `{"view","html"}`. `GET /v1/dashboard` answers `200 {"views":[the six names]}`. The `migrations` view renders `migration.count` over all time |

A principal, an API key or a signing key belonging to another workspace is `NOT_FOUND`, never `FORBIDDEN`: cross-workspace existence is not disclosed. The same rule governs every auxiliary above: a resource the caller may not see is absent, not forbidden.
