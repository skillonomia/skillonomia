# P0 — standing residual audit limitations

What P0 cannot prove, stated once, here, so it is carried forward rather than
rediscovered. Contract section 12 point 11 requires the final report to list actual
non-blocking residual risks; these are P0's contributions to that list, and they do
not expire when the phase passes.

Nothing here is a blocker under contract section 11. Each is a limit on what P0's
evidence can support, disclosed so that no later phase and no final report cites P0
for more than it can carry.

---

## L-P0-01 — BUILD-1's artifacts are gone, and cannot be re-established

**What happened.** P0 FIX-1's gate runner wrote its logs to the filenames P0 BUILD-1
had used, overwriting ten of them. There was no backup; the content is
unrecoverable.

```
npm-ci.log  typecheck.log  npm-test.log  bun-test.log  bun-typecheck.log
build-js.log  build-binary.log  db-migration-check.log  registry-smoke.log
traceability-check.log
```

**What survives.** BUILD-1's eleven records survive byte-identical in
evidence/P0/runs-build1-superseded.jsonl — exit codes, toolchain versions,
timestamps, SHAs and the artifact paths they pointed at. BUILD-1's narrative summary
survives in evidence/P0/07-gate-summary.md. What is lost is the captured output, not
the ledger.

**Why it is not a blocker.** It concerns the superseded SHA
`3927571a8349e215aff096ee3ac58135435f4b51`, which REVIEW-1 has already reviewed.
Every one of those ten commands was re-run at the FIX-1 SHA
`202764e4e9f4b2542ff60c98a915a3f5e07e7c4a` with a complete record and a fresh
artifact, and again at the FIX-2 SHA. P0 REVIEW-2 examined this and ruled it
explicitly non-blocking: accurately disclosed, superseded SHA, every affected command
re-run at the reviewed SHA.

**The residual limitation, stated exactly.** For the SHA
`3927571a8349e215aff096ee3ac58135435f4b51` there is no independent artifact backing
for those ten gate results — only BUILD-1's own records and prose. Anyone auditing
P0 later should treat BUILD-1's gate results as **attested but not artifact-backed**,
and rely on the FIX-1 and FIX-2 SHAs, which are both fully backed. This limitation
can never be closed: the bytes are gone.

**What stops it recurring.** Evidence artifacts are written to new filenames, never
to one that exists. `v1/tools/p0-evidence-check.ts` enforces one artifact to one
record in both directions, so a phase that overwrites an artifact loses the
correspondence and fails rather than silently succeeding. FIX-2's own logs are
suffixed `-fix2` for this reason.

---

## L-P0-02 — a well-shaped session id is not proof that the session ran the command

`v1/tools/p0-evidence-check.ts` now refuses a `session_id` that is not shaped like a
provider session id, and refuses a role declaring anything but the model contract
contract section 7 fixes. That closes `P0-R2-001`, and it is worth being precise
about what it does not close: nothing running locally, after the fact, can prove that
the UUID in a record is the session that issued the command. The binding between a
record and a real session rests on the record being written from the provider's own
task ledger at the time, and on `evidence/SESSIONS.md` carrying those authoritative
values.

So the checker establishes a necessary condition, not a sufficient one: a badly
shaped id proves the record is wrong, a well-shaped one does not prove it is right.
Later phases should keep writing identifiers from the task ledger rather than from
memory, and should keep the ledger current in the same commit.

---

## L-P0-03 — the recorded exit code is the record's claim; the artifact is the evidence

Unchanged from the frozen format, restated here because it is a standing limitation
rather than a P0 event: no local check can verify after the fact that a recorded exit
code is the one the command returned. That is why an output reference is a required
field and why long output goes to an artifact. A reviewer who doubts a row reads the
artifact, or re-runs the command — both are available, at every SHA except the one
L-P0-01 describes.
