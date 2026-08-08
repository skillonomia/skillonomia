# hello-skillonomia

The built-in seed package of a fresh Skillonomia instance (SPEC §9.1). It exists
so a new deployment has one adoptable, deterministic, low-risk package before
anything has been published.

## Procedure

1. Run `fixtures/tv01.sh`.
2. Compare its stdout with the expected string `skillonomia-tv01-ok`.

Gate `g1` passes when the two are equal. A real deployment removes this
package: see "Remove the seed" in the README.
