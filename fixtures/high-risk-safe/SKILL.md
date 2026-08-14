# high-risk-safe

A package that declares `risk_level: high` and carries a payload with no blast
radius. It is the fixture of the high-risk operational exercise
(`ci/high-risk-exercise.mjs`): the registry refuses to hand it over until a
human admin/owner records an `adopt_high_risk` approval bound to the one
adoption request, and the adopter attests sandbox capability. What is then
handed over is one `echo`.

The two halves are deliberate. The lane under test is the refusal and the
approval; the payload is chosen so that a run of this package on a reviewer's
machine is uninteresting.

## Procedure

1. Run `fixtures/tv-high.sh`.
2. Compare its stdout with `skillonomia-high-risk-safe-ok`.

Gate `g1-stdout` passes when the two are equal.

## What a passing receipt does and does not prove

The receipt records that the adopter said the gate passed. The registry checks
that the reported gate ids are the ones this version declares and that each is
present with `pass: true`; it does not observe the run. That boundary is the
registry's, not this package's, and it is the same for every package here.
