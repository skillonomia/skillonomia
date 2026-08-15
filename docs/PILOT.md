# Running an external pilot

One pilot is one host, one official path and one low-risk package, driven end to
end by `ci/run-pilot.mjs` and recorded by it. The MVP cut asks for two: an
external macOS user or agent, and an external Windows user or agent.

```text
install → start → create → review → adopt → adopter claim → receipt read-back
```

The artifact comes from where a user gets it — the npm registry, or a container
registry by immutable digest — and never from a checkout of this repository,
which `ci/run-pilot.mjs` does not consult for it. The
package that is created, reviewed and adopted travels inside `ci/run-pilot.mjs`
as a source tree, so a pilot host needs neither a fixture directory nor a
signing key: the registry packs and signs it, and `risk_level` is `low`.

## Before you start

- Node `>=22.6` on the host. It runs `ci/run-pilot.mjs`, and on the npm path it
  is also the runtime of the thing being piloted.
- On the container path, a Docker daemon running Linux containers, and the
  immutable digest of the image. This repository has published no such digest
  yet, so `ci/run-pilot.mjs` refuses a tag and a pilot on that path waits for a
  digest to exist.
- A loopback port, and a way for the owner to reach it — the deployment stays up
  for a read-only receipt read-back until acceptance, so the URL named as
  `--verification-base-url` has to answer after the run ends.
- A path for the token file, outside this checkout.

## The run

```bash
node ci/run-pilot.mjs run \
  --path npm \
  --artifact @skillonomia/cli@<version> \
  --candidate-sha <the 40-hex commit the artifact was built from> \
  --port 7431 \
  --verification-base-url "https://<the host the owner can reach>" \
  --record evidence/pilots/macos.json \
  --transcript evidence/pilots/macos-transcript.json \
  --token-file "${MACOS_PILOT_TOKEN_FILE}"
```

The container path is the same line with `--path docker` and an
`--artifact <registry>/<image>@sha256:<digest>`.

It prints nine steps, writes three files and leaves the deployment listening on
the loopback. `PILOT_RUN_OK` is a completed pilot; `PILOT_RUN_STAGED_OK` is the
same run where the verification URL was this machine's own loopback, so nothing
external was exercised; `PILOT_RUN_BLOCKED` is a run that reproduced a blocker,
wrote its record and exited non-zero.

## What the record carries, and what it does not

The record is produced by the run that observed it, and its shape is
`evidence/pilots/PILOT_TEMPLATE.json`: the platform and the path, the artifact
checksum or digest, the candidate SHA, the verification base URL, the `/health`
hash, the timestamps, the terminal receipt with its state and its read-back
hash, the transcript hash, the time to the first `adopted`, and the blockers the
run reproduced. Filling a terminal field in by hand is not a supported way to
produce one: `ci/run-pilot.mjs` is the only writer, and `verify` re-derives what
it can from somewhere other than the record.

The record and the transcript `ci/run-pilot.mjs` writes carry no token, no API
key, no user name and no machine path. It searches both for its own credentials, for this
machine's home directory and user name, and for the shapes a credential is
written in, and it stops the run rather than write a file that carries one. The
credential the owner needs for the read-back goes to the file `ci/run-pilot.mjs`
was given as `--token-file`, which is its only copy; it reaches neither the
record, nor the transcript, nor the terminal.

## Blockers

A blocker enters a record when this run observed the condition and then
re-executed the probe that observes it, with the same answer. There is no
option for adding one to a record by hand, and `ci/run-pilot.mjs` offers none:
an adoption blocker that nobody reproduced is a report, and the pilot exists to
produce the other kind.

## The verification

```bash
node ci/run-pilot.mjs verify --online \
  --macos-record evidence/pilots/macos.json \
  --macos-token-file "${MACOS_PILOT_TOKEN_FILE}" \
  --windows-record evidence/pilots/windows.json \
  --windows-token-file "${WINDOWS_PILOT_TOKEN_FILE}"
```

`verify` reads each record against its schema, re-hashes the transcript lying
beside it, asks the artifact's own registry what it holds, waits for `/health`
at the verification URL and reads the receipt back from there with the
credential out of the token file. A record whose deployment cannot be reached,
whose hashes disagree with the files they name, or whose fields were retyped is
refused, and `ci/run-pilot.mjs` exits non-zero naming every check that refused
it. `PILOTS_OK 2/2` needs two live read-backs, one record from macOS and one
from Windows, and one candidate SHA between them.

## What a pilot proves

That an owner-controlled harness ran these steps against this artifact on this
host, and that the server reads the receipt back as `adopted` at a URL the owner
can reach. The receipt is the server's record of the adopter's claim, and
`observed` is the adopter's: the registry checks that the gate ids reported are
the ones the version declares, and it does not witness the run. Skillonomia
claims no cryptographic proof that the text in `observed` came from an
execution, and `ci/run-pilot.mjs` records the boundary in every transcript it
writes rather than leaving a reader to assume the stronger thing.
