# Skillonomia public reference

The published reference for the shipped JSON schemas, the payloads a caller
sends, the decision surfaces an owner uses, the lifecycle a version moves
through, the webhook policy, the authoring CLI, and the REST and MCP spellings
of the same operations.

Everything printed here is checked by `test/v1p2-p2d-documentation.test.ts`
against the code that ships beside it. A payload in a fenced block is validated
against the shipped schema it names; a route is resolved against the router in
`src/http.ts`; a tool name is resolved against the adapter in `src/mcp.ts`; an
environment variable is resolved against the sources that read it; and a
vocabulary printed as a table is compared with the constant the server computes
from. A sentence here that stopped being true stops the build.

`SPEC.md` remains the normative document. This file is the reference a caller
reads; where the two differ, `SPEC.md` decides.

## Contents

- [Schema reference](#schema-reference)
- [Package payloads](#package-payloads)
- [Review request and verdict](#review-request-and-verdict)
- [Approval payloads](#approval-payloads)
- [Role and type matrix](#role-and-type-matrix)
- [Lifecycle](#lifecycle)
- [Webhooks](#webhooks)
- [The revocation boundary](#the-revocation-boundary)
- [CLI authoring journey](#cli-authoring-journey)
- [REST and MCP equivalents](#rest-and-mcp-equivalents)
- [Validation error categories](#validation-error-categories)

## Schema reference

Six JSON schemas ship in `schema/`. Each is JSON Schema 2020-12, and each is
compiled with the same Ajv configuration the registry uses in `src/manifest.ts`.

| Schema file | What it governs | Required members |
|---|---|---|
| `schema/skill-package-v1.schema.json` | the signed package manifest (`skill.json`) | `skill_id`, `semantic_version`, `title`, `capability_statement`, `owner`, `author_agent`, `created_at`, `license`, `access_policy`, `scope`, `runtime`, `procedure`, `evidence`, `safety`, `lifecycle`, `integrity` |
| `schema/evidence-v1.schema.json` | the gate results an adopter reports | `gate_results` |
| `schema/environment-descriptor-v1.schema.json` | the environment an adoption is requested for | `runtime`, `model`, `tools`, `os`, `shell`, `sandbox_capable` |
| `schema/failure-report-v1.schema.json` | a reported failure of an adopted package | `category`, `summary` |
| `schema/rollback-report-v1.schema.json` | a reported rollback of an adopted package | `reason`, `summary` |
| `schema/version-registry-view-v1.schema.json` | the registry's read view of one version | `state`, `superseded_by`, `deprecation_date`, `revocation_reason`, `receipt_ids`, `reviewer_notes`, `reputation` |

The required-member column above is read out of the schema files themselves by
the documentation test, so a member added to or dropped from a schema is a
failing run rather than a stale table.

An environment descriptor:

<!-- skln:example id=environment-descriptor check=schema:environment-descriptor-v1 -->
```json
{
  "runtime": {
    "id": "node",
    "version": "22.6.0"
  },
  "model": {
    "id": "claude-opus",
    "version": "5"
  },
  "tools": [
    {
      "id": "shell",
      "version": "5.2.15"
    }
  ],
  "os": "linux",
  "shell": "bash",
  "sandbox_capable": true
}
```

Evidence for one gate:

<!-- skln:example id=evidence check=schema:evidence-v1 -->
```json
{
  "gate_results": [
    {
      "gate_id": "g1",
      "pass": true,
      "observed": "stdout was skillonomia-tv01-ok"
    }
  ],
  "notes": "run on a clean checkout",
  "synthesized": false
}
```

A failure report:

<!-- skln:example id=failure-report check=schema:failure-report-v1 -->
```json
{
  "category": "gate_failed",
  "summary": "gate g1 expected skillonomia-tv01-ok on stdout and the fixture printed nothing.",
  "failed_gate_ids": [
    "g1"
  ]
}
```

A rollback report:

<!-- skln:example id=rollback-report check=schema:rollback-report-v1 -->
```json
{
  "reason": "regression",
  "summary": "the fixture began failing after the host shell was upgraded; reverted to the previous version.",
  "rolled_back_at_step": 1
}
```

The registry's read view of a published version:

<!-- skln:example id=version-registry-view check=schema:version-registry-view-v1 -->
```json
{
  "state": "published",
  "superseded_by": null,
  "deprecation_date": null,
  "revocation_reason": null,
  "receipt_ids": [
    "01TVRC0000000000000000000A"
  ],
  "reviewer_notes": [
    "fixture is deterministic"
  ],
  "reputation": {
    "adoption_attempts": 3,
    "adopted_count": 2,
    "failed_count": 1,
    "rolled_back_count": 0,
    "avg_rating": 4.5,
    "failure_modes_observed": [
      "shell-missing"
    ]
  }
}
```

## Package payloads

Two package manifests follow. The first carries the required members and
nothing else; the second adds the optional members `schema/skill-package-v1.schema.json`
defines. Both validate against that schema, and the documentation test proves
it rather than asserting it.

The minimal manifest:

<!-- skln:example id=package-minimal check=schema:skill-package-v1 -->
```json
{
  "skill_id": "01TVSK0000000000000000000A",
  "semantic_version": "1.0.0",
  "title": "TV-01 hello-skillonomia",
  "capability_statement": "Deterministic low-risk test-vector skill: run one fixture command and verify its output.",
  "owner": "tv-workspace",
  "author_agent": "01TVAG0000000000000000000A",
  "created_at": "2026-08-01T00:00:00Z",
  "license": "Apache-2.0",
  "access_policy": "workspace",
  "scope": {
    "non_goals": [
      "Any production use"
    ],
    "prerequisites": [],
    "problem_class": "Smoke-testing a Skillonomia deployment end to end.",
    "required_approvals": [],
    "risk_level": "low"
  },
  "runtime": {
    "cloud_iam_assumptions": [],
    "mcp_dependencies": [],
    "model_compat": [
      {
        "id": "any",
        "range": "*"
      }
    ],
    "os": [
      "linux",
      "macos"
    ],
    "runtime_compat": [
      {
        "id": "any",
        "range": "*"
      }
    ],
    "shell": [
      "bash",
      "sh"
    ],
    "tool_compat": [
      {
        "id": "shell",
        "range": "*"
      }
    ]
  },
  "procedure": {
    "expected_outputs": [
      "skillonomia-tv01-ok"
    ],
    "failure_modes": [
      {
        "mitigation": "install a POSIX shell",
        "mode": "shell-missing",
        "symptom": "sh not found"
      }
    ],
    "rollback": [
      "No changes made; nothing to roll back."
    ],
    "steps": [
      {
        "command": "sh fixtures/tv01.sh",
        "expected": "skillonomia-tv01-ok",
        "instruction": "Run the fixture script.",
        "n": 1
      }
    ],
    "tools_used": [
      {
        "id": "shell",
        "range": "*"
      }
    ],
    "validation_gates": [
      {
        "check": "stdout equals expected string",
        "gate_id": "g1",
        "pass_criteria": "stdout == 'skillonomia-tv01-ok'"
      }
    ]
  },
  "evidence": {
    "redaction_level": "none",
    "summary": "Deterministic fixture prints a fixed string; gate g1 compares stdout.",
    "test_results": "local: g1 pass"
  },
  "safety": {
    "dependency_manifest": [],
    "forbidden_actions": [
      "network access",
      "file writes outside workdir"
    ],
    "sandbox_requirement": "none",
    "secrets_policy": "No secrets used or accepted.",
    "url_allowlist": []
  },
  "lifecycle": {
    "supersedes": null
  },
  "integrity": [
    {
      "path": "SKILL.md",
      "sha256": "9aa9fcc8c19358ef683f752e3dc2f5462661f3e4770a80b484737d8528cafbbb"
    },
    {
      "path": "fixtures/tv01.sh",
      "sha256": "956e69331b9fb00e1d465eda3c6a8ed508163fe90428541e3b6d4c645529b360"
    }
  ]
}
```

The full manifest, with the optional members populated:

<!-- skln:example id=package-full check=schema:skill-package-v1 -->
```json
{
  "access_policy": "workspace",
  "author_agent": "01TVAG0000000000000000000A",
  "capability_statement": "Deterministic low-risk test-vector skill: run one fixture command and verify its output.",
  "created_at": "2026-08-01T00:00:00Z",
  "evidence": {
    "redaction_level": "none",
    "summary": "Deterministic fixture prints a fixed string; gate g1 compares stdout.",
    "test_results": "local: g1 pass",
    "benchmark": "one fixture, one gate, run locally",
    "signed_trace_hash": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "integrity": [
    {
      "path": "SKILL.md",
      "sha256": "9aa9fcc8c19358ef683f752e3dc2f5462661f3e4770a80b484737d8528cafbbb"
    },
    {
      "path": "fixtures/tv01.sh",
      "sha256": "956e69331b9fb00e1d465eda3c6a8ed508163fe90428541e3b6d4c645529b360"
    }
  ],
  "license": "Apache-2.0",
  "lifecycle": {
    "supersedes": null,
    "dispute_state": "none"
  },
  "owner": "tv-workspace",
  "procedure": {
    "expected_outputs": [
      "skillonomia-tv01-ok"
    ],
    "failure_modes": [
      {
        "mitigation": "install a POSIX shell",
        "mode": "shell-missing",
        "symptom": "sh not found"
      }
    ],
    "rollback": [
      "No changes made; nothing to roll back."
    ],
    "steps": [
      {
        "command": "sh fixtures/tv01.sh",
        "expected": "skillonomia-tv01-ok",
        "instruction": "Run the fixture script.",
        "n": 1
      }
    ],
    "tools_used": [
      {
        "id": "shell",
        "range": "*"
      }
    ],
    "validation_gates": [
      {
        "check": "stdout equals expected string",
        "gate_id": "g1",
        "pass_criteria": "stdout == 'skillonomia-tv01-ok'"
      }
    ],
    "scripts": [
      "fixtures/tv01.sh"
    ],
    "deterministic_fixtures": [
      "fixtures/tv01.sh"
    ]
  },
  "runtime": {
    "cloud_iam_assumptions": [],
    "mcp_dependencies": [],
    "model_compat": [
      {
        "id": "any",
        "range": "*"
      }
    ],
    "os": [
      "linux",
      "macos"
    ],
    "runtime_compat": [
      {
        "id": "any",
        "range": "*"
      }
    ],
    "shell": [
      "bash",
      "sh"
    ],
    "tool_compat": [
      {
        "id": "shell",
        "range": "*"
      }
    ],
    "a2a_agent_card_refs": []
  },
  "safety": {
    "dependency_manifest": [],
    "forbidden_actions": [
      "network access",
      "file writes outside workdir"
    ],
    "sandbox_requirement": "none",
    "secrets_policy": "No secrets used or accepted.",
    "url_allowlist": [],
    "slsa_intoto_provenance": "none",
    "sigstore_signatures": "none"
  },
  "scope": {
    "non_goals": [
      "Any production use"
    ],
    "prerequisites": [],
    "problem_class": "Smoke-testing a Skillonomia deployment end to end.",
    "required_approvals": [],
    "risk_level": "low",
    "persona": "platform engineer",
    "maturity_tier": "stable"
  },
  "semantic_version": "1.0.0",
  "skill_id": "01TVSK0000000000000000000A",
  "title": "TV-01 hello-skillonomia",
  "external_aliases": [
    "smoke-check"
  ],
  "did_vc_binding": "did:web:registry.example",
  "x_ext": {
    "example.org/team": "platform"
  },
  "outcome_contract": {
    "check": {
      "kind": "stdout_match",
      "stdout_match": "skillonomia-tv01-ok"
    },
    "evidence": [
      "g1"
    ],
    "unknown": "report_unknown"
  }
}
```

`skill_id`, `author_agent` and `integrity` deserve a note. `skill_id` is minted
once, on the author's machine, by `skillonomia init`; `author_agent` is the
authenticated principal the server resolves from the API key and is not a value
a caller chooses; `integrity` is computed over the packed bytes by the server.
A source directory that already carries the last two is refused with a pointer
naming the file — see [Validation error categories](#validation-error-categories).

The signing profile over these bytes — the JCS canonicalization, the SHA-256,
the protected header, the signing input and the detached JWS — has a
machine-readable conformance fixture in
`fixtures/signing-conformance/fixture.json`, with an independent validator in
`fixtures/signing-conformance/validate.py` that shares no code with the
registry.

## Review request and verdict

A review is requested against a version and answered by a principal who is not
its author. The request:

<!-- skln:example id=review-request check=route:POST /v1/versions/{version_id}/reviews -->
```json
{
  "verdict": "approve",
  "notes": "fixture is deterministic and the gate compares its exact output."
}
```

The verdict a reviewer records on the same surface:

<!-- skln:example id=review-verdict check=route:POST /v1/versions/{version_id}/reviews -->
```json
{
  "verdict": "request_changes",
  "notes": "step 1 names no expected output; add one before this can be verified."
}
```

The MCP spelling is `skill.review.request`. The reviewer's own console listing
of what is waiting is `GET /v1/console/approvals`, filtered by `kind=review`.

## Approval payloads

A human decision is recorded on `POST /v1/versions/{version_id}/approvals`. The
`scope` member says which decision is being made: `publish` for publication, and
`adopt_high_risk` for one high-risk adoption. The MCP spelling of both is
`skill.approve`.

Approving a high-risk adoption:

<!-- skln:example id=approval-adopt check=route:POST /v1/versions/{version_id}/approvals -->
```json
{
  "scope": "adopt_high_risk",
  "decision": "approve",
  "note": "reviewed the fixture and the sandbox requirement; approved for the platform workspace."
}
```

Approving publication:

<!-- skln:example id=approval-publish check=route:POST /v1/versions/{version_id}/approvals -->
```json
{
  "scope": "publish",
  "decision": "approve",
  "note": "gates pass on a clean checkout; publication approved."
}
```

Denying either is the same body with `decision` set to `deny`. A denial carries
its note for the same reason an approval does: the record is what a later reader
has.

In the Console these two decisions are the labelled controls
`Approve this adoption` / `Deny this adoption` and
`Approve publication` / `Deny publication`. A bare `Confirm`, `OK`, `Yes` or
`Submit` is not offered for them, which `test/v1p2-p2c-console.test.ts`
asserts by absence.

A high-risk skill is decided twice, not once: publication is one decision and
each adoption is another, which `test/high-risk-exercise.test.ts` exercises. `skillonomia init --risk high` says so on the way out,
naming both scopes.

## Role and type matrix

The workspace roles are `owner`, `admin`, `reviewer` and `member`, from
`src/auth.ts`. The approval kinds an inbox can hold are `review`, `publish` and
`adopt_high_risk`, from `src/console-v2.ts`. The matrix below is compared
against those two constants by the documentation test.

| Approval kind | owner | admin | reviewer | member |
|---|---|---|---|---|
| `review` | may decide | may decide | may decide | may not decide |
| `publish` | may decide | may not decide | may not decide | may not decide |
| `adopt_high_risk` | may decide | may not decide | may not decide | may not decide |

Three rules govern the table and are exercised in `test/p4-approvals.test.ts`
and `test/v1p2-p2c-console.test.ts`:

- A service or admin principal does not stand in for a human approval.
- An author does not review their own version.
- A Console session carries the role its principal already has; signing in
  through a browser widens nothing.

A principal who may not decide is told so by the server, in the server's own
words, as `{"allowed": false, "reason_code": "..."}`. The Console displays that
reason rather than composing one of its own, and offers no control that would
send the mutation anyway, which `test/v1p2-p2c-console.test.ts` asserts against
the stored row.

## Lifecycle

A version's state is one of `draft`, `linted`, `reviewed`, `verified`,
`published`, `deprecated`, `superseded` or `revoked`, from `src/transitions.ts`.
The transitions the registry admits:

| From | To | Surface |
|---|---|---|
| `draft` | `linted` | `POST /v1/versions/{version_id}/lint` |
| `linted` | `reviewed` | `POST /v1/versions/{version_id}/reviews` |
| `reviewed` | `verified` | `POST /v1/versions/{version_id}/verify` |
| `verified` | `published` | `POST /v1/versions/{version_id}/publish` |
| `published` | `deprecated` | `POST /v1/versions/{version_id}/deprecate` |
| `published` | `superseded` | `POST /v1/versions/{version_id}/supersede` |
| `published`, `deprecated`, `superseded` | `revoked` | `POST /v1/versions/{version_id}/revoke` |

Deprecating a version:

<!-- skln:example id=lifecycle-deprecate check=route:POST /v1/versions/{version_id}/deprecate -->
```json
{
  "reason": "replaced by a maintained fixture set"
}
```

Superseding one version with another:

<!-- skln:example id=lifecycle-supersede check=route:POST /v1/versions/{version_id}/supersede -->
```json
{
  "successor_version_id": "01TVVR0000000000000000000B"
}
```

Revoking, with a reason and without a successor:

<!-- skln:example id=lifecycle-revoke check=route:POST /v1/versions/{version_id}/revoke -->
```json
{
  "reason": "the fixture wrote outside its working directory"
}
```

Revoking and naming the replacement in the same call — revoke-with-successor:

<!-- skln:example id=lifecycle-revoke-successor check=route:POST /v1/versions/{version_id}/revoke -->
```json
{
  "reason": "the fixture wrote outside its working directory",
  "successor_version_id": "01TVVR0000000000000000000B"
}
```

A revoked version keeps `state` at `revoked` and records the replacement in a
column of its own. Disposition and replacement are separate facts, so naming a
successor does not soften the revocation, and a superseded version can still be
revoked later if its bytes turn out to be dangerous. The revoke path and the
notice it queues are one transaction.

## Webhooks

An endpoint is registered on `POST /v1/console/webhooks` and listed on
`GET /v1/console/webhooks`. Registration:

<!-- skln:example id=webhook-register check=route:POST /v1/console/webhooks -->
```json
{
  "url": "https://hooks.example/skillonomia",
  "events": [
    "version.revoked"
  ],
  "description": "platform on-call"
}
```

A registration is refused with `INVALID_SCHEMA` before a row or a secret is
written when the destination is one the delivery transport would refuse — a
loopback address, or a name in the reserved `.localhost` space such as
`foo.localhost`, `foo.localhost.` or `a.b.localhost`. Registration and delivery
read one rule, so an endpoint accepted at registration is an endpoint delivery
will attempt.

A test delivery is sent from `POST /v1/console/webhooks/{webhook_id}/test`
through the same SSRF-hardened transport a real delivery uses, with the same
connect timeout, total timeout and response-size bound. A queued notice is
labelled queued; it is described as delivered once the transport says so.

`GET /v1/console/webhooks` carries an `eligibility` of `{allowed, reason_code}`
per row: this deployment's verdict on whether it would send that test delivery
at all. The Console withholds the control where the verdict is `false` and shows
the reason code the registry gave. The verdict is judged by the same URL rules
registration applies, so it changes with the policy: an `http://127.0.0.1`
endpoint registered while `SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK` is set becomes
`{"allowed": false, "reason_code": "ENDPOINT_NOT_DELIVERABLE"}` after a restart
without it, because the row outlived the policy that admitted it. The endpoint's
`status` is not consulted: an endpoint marked `dead` by repeated delivery
failures stays testable, which is how an operator learns that a repaired
receiver is answering again.

Retries are bounded, and a delivery that exhausts them becomes a dead letter,
which is a recorded row rather than a discarded one. The dead-letter view is
reachable in the Console under the Proofline navigation.

The environment variables the transport reads:

| Variable | Effect |
|---|---|
| `SKILLONOMIA_WEBHOOK_ALLOW_LOOPBACK` | permits loopback and reserved-`.localhost` destinations, for local development |
| `SKILLONOMIA_WEBHOOK_CONNECT_TIMEOUT_MS` | the connect timeout for one delivery attempt |
| `SKILLONOMIA_WEBHOOK_TIMEOUT_MS` | the total timeout for one delivery attempt |
| `SKILLONOMIA_WEBHOOK_MAX_RESPONSE_BYTES` | the bound on how much of a response is read |

Those four names are resolved against the sources that read them by the
documentation test, so a renamed variable is a failing run.

A webhook secret is written once, at registration, and is not read back by any
listing surface. It does not appear in the Console HTML, in a URL, in browser
storage or in the CLI's output.

## The revocation boundary

Revocation is a fact this registry records. It is not digital rights
management, and the registry does not claim to reach bytes an adopter already
holds. Before a revocation is committed, the Console states these consequences:

- New adoptions of this version are blocked from the moment the registry records the revocation.
- Bytes already issued are not deleted. Every adopter that already holds this package still holds it, and this registry has no way to take it back.
- The offline signature over those bytes remains mathematically valid. Revocation is a fact this registry records, not a change to the package or to the mathematics of its signature.
- Notices to known adopters are queued, and a queued notice may end in a dead letter instead of arriving.

Those sentences are the ones in `src/console-surfaces.ts`, quoted here from the
constant the Console renders, and the documentation test compares them
character for character.

The pre-commit view also shows the exact version, its manifest hash, the reason
being recorded, the adopters known to be active, and the successor if one is
being named. The primary control reads `Revoke version` or
`Revoke and replace version`.

## CLI authoring journey

The authoring journey runs `skillonomia init`, then `skillonomia validate`,
then `skillonomia create` — from an empty directory to a signed version in the
registry.

<!-- skln:example id=cli-journey check=cli -->
```console
$ skillonomia init ./my-skill --slug my-skill --risk low
$ skillonomia validate ./my-skill
$ skillonomia create ./my-skill --slug my-skill --server https://registry.example --api-key-env SKILLONOMIA_API_KEY
```

Step by step:

- `skillonomia init` writes `manifest.json`, `SKILL.md` and a fixture, and mints
  one ULID `skill_id` locally. It creates and stores no private key, as `src/cli-authoring.ts` shows
  on the way out: the registry signs with its own system key. `--risk high` additionally reports
  that publication and adoption are two separate decisions.
- `skillonomia validate` reads the directory and writes nothing into it. It
  applies the `skill-source-v1` profile from `src/source-profile.ts` — the same
  function the server applies on arrival, so a green preflight and a rejected
  upload cannot disagree.
- `skillonomia create` packs the directory and posts it to the existing
  `POST /v1/skills/from-source` surface. The finished signed manifest carries
  the `skill_id` `init` minted, the authenticated author the server resolved,
  and an integrity computed over the packed bytes.

The API key is read from the environment variable named by `--api-key-env` and
from nowhere else. It does not appear in the process arguments, in the request
URL, in a configuration file, on standard output or on standard error, which
`test/v1p2-p2-authoring-cli.test.ts` asserts by scanning the captured streams.

On a failure of any kind — a validation refusal or a transport error — the
source directory is left byte-identical. That is asserted by hashing the tree
before and after rather than by inspection.

## REST and MCP equivalents

The same operations are reachable over both adapters. Each pair below is
resolved by the documentation test: the route against the router in
`src/http.ts`, the tool against `MCP_TOOLS` in `src/mcp.ts`.

| Operation | REST | MCP |
|---|---|---|
| create from a source directory | `POST /v1/skills/from-source` | `skill.create_from_dir` |
| create from a packed archive | `POST /v1/skills` | `skill.create` |
| lint a version | `POST /v1/versions/{version_id}/lint` | `skill.lint` |
| request or record a review | `POST /v1/versions/{version_id}/reviews` | `skill.review.request` |
| verify a version | `POST /v1/versions/{version_id}/verify` | `skill.verify` |
| publish a version | `POST /v1/versions/{version_id}/publish` | `skill.publish` |
| deprecate a version | `POST /v1/versions/{version_id}/deprecate` | `skill.deprecate` |
| supersede a version | `POST /v1/versions/{version_id}/supersede` | `skill.supersede` |
| revoke a version | `POST /v1/versions/{version_id}/revoke` | `skill.revoke` |
| record a human approval | `POST /v1/versions/{version_id}/approvals` | `skill.approve` |
| request an adoption | `POST /v1/adoptions/requests` | `skill.request_adoption` |
| adopt | `POST /v1/adoptions/{request_id}/adopt` | `skill.adopt` |
| report an outcome | `POST /v1/receipts/{receipt_id}/events` | `skill.validate_outcome` |
| rate a version | `POST /v1/versions/{version_id}/ratings` | `skill.rate` |
| read a dashboard view | `GET /v1/console/dashboard/{view}` | `dashboard.view` |
| verify a package archive without adopting it | `POST /v1/verify` | `skill.verify` |

Some surfaces exist on one adapter and not the other; `docs/API.md` is the
place where that asymmetry is listed in full.

## Validation error categories

`skillonomia validate` and the server's arrival check produce the same findings
from the same function in `src/source-profile.ts`. A finding carries an RFC 6901
JSON pointer into the manifest, a stable code, a severity, a detail and a
recovery hint, and it names a documentation anchor.

| Code | Anchor |
|---|---|
| `source_manifest_missing` | [SPEC.md#source-manifest-missing](../SPEC.md#source-manifest-missing) |
| `source_manifest_not_json` | [SPEC.md#source-manifest-not-json](../SPEC.md#source-manifest-not-json) |
| `source_skill_md_missing` | [SPEC.md#source-skill-md-missing](../SPEC.md#source-skill-md-missing) |
| `source_already_packed` | [SPEC.md#source-already-packed](../SPEC.md#source-already-packed) |
| `source_server_owned_member` | [SPEC.md#source-server-owned-member](../SPEC.md#source-server-owned-member) |
| `source_schema` | [SPEC.md#source-schema](../SPEC.md#source-schema) |
| `source_outcome_contract` | [SPEC.md#source-outcome-contract](../SPEC.md#source-outcome-contract) |
| `source_gate_evidence_unresolved` | [SPEC.md#source-gate-evidence-unresolved](../SPEC.md#source-gate-evidence-unresolved) |
| `source_gate_id_not_nameable` | [SPEC.md#source-gate-id-not-nameable](../SPEC.md#source-gate-id-not-nameable) |
| `source_safety_gate` | [SPEC.md#source-safety-gate](../SPEC.md#source-safety-gate) |

The table is walked in both directions by `test/v1p2-p2d-documentation.test.ts`:
a code with no row here fails, a row naming a code the profile no longer
produces fails, and an anchor `SPEC.md` does not carry fails. The anchor is derived from the code by
`anchorFor` in `src/source-profile.ts`, so the two cannot drift apart.

A finding as the CLI prints it:

<!-- skln:example id=finding check=derived:source-finding -->
```json
{
  "pointer": "/integrity",
  "code": "source_server_owned_member",
  "severity": "FAIL",
  "detail": "manifest.json carries `integrity`, which the registry computes over the packed bytes after arrival.",
  "recovery": "Remove `integrity` from manifest.json and let the registry compute it.",
  "anchor": "SPEC.md#source-server-owned-member"
}
```
