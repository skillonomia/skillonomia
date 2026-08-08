# `skills/` — real skill packages

Not test vectors. `vectors/` holds deterministic packages pre-signed against a
fixed author id so they stay byte-reproducible, and they exist to pin the format
and the verification algorithm. What lives here is the other thing: packages
meant to be adopted and actually run.

A real package cannot be committed pre-signed. §4.4 step 3 resolves `kid`
against `manifest.author_agent`, and `principal.create` mints a ULID nobody
chooses, so the author id — and with it the signature — belongs to the
deployment the package is published to, not to this tree. So each directory here
is **source**:

```
<skill>/
  SKILL.md         the runbook a reading agent follows
  manifest.json    everything except `author_agent` and `integrity`
  scripts/         the commands the runbook names
```

and the signed package is produced per deployment:

```bash
npm run pack-skill -- skills/<skill> \
  --author <principal_id> --seed-hex <64 hex> --kid <kid> \
  --out /tmp/out --name <skill> --lint
```

`--lint` runs the same eight §7.1 gates the registry runs on `skill.lint`.
Running it before `skill.create` is the difference between finding out here and
finding out from a `FAIL` on a draft.

## Writing the scripts

Gate 5 admits only shell it can read statically (Appendix G.4). Twelve classes
are refused, and the four that bite hardest when writing an honest runbook are
command substitution, `eval`/`source`, inline interpreter code, and **every**
control construct — `if`, `for`, `while`, `case`, subshells, brace groups.

That is narrower than it first looks, and mostly for the better. The usual

```sh
ACTUAL=$(sha256sum "$FILE")          # command-substitution  FAIL
if [ "$ACTUAL" = "$WANT" ]; then …   # control-construct     FAIL
```

becomes

```sh
printf '%s  %s\n' "$WANT" "$FILE" > "$W/expected.sha256"
sha256sum --check --strict --status "$W/expected.sha256"
```

which is shorter, has no parsing of another command's output in it, and fails
closed under `set -e`. The pattern generalises: let the tool make the
comparison and signal by exit status, instead of capturing its output and
branching on it.

What the subset genuinely cannot express is a **conditional** step. A runbook
step that should only run when an optional input is present has to become either
a mandatory step or a separate version; there is no third option inside the
gate. `skills/git-bundle-verify` took the first — step 4 always runs and the
reference tree is a required input.

The same subset also rules out the obvious way to write a precondition, and the
way round it is worth knowing: a check that must REFUSE is written as a command
that fails, not as a test that branches. "The work directory must be empty"
becomes `rmdir` — it succeeds on an empty directory and fails on a populated
one. "git must be at least 2.30" becomes `sort --check --version-sort` over the
pair [required, actual]. "This list must be empty" becomes `cmp` against an
empty file. Each one fails closed under `set -e`, prints its own diagnostic,
and is readable by gate 5.

## Negative vectors belong INSIDE the package

A skill that claims to refuse bad input has to be checkable on that claim by
whoever received it. Verifying the refusals somewhere else and writing the
result into `evidence` makes them the author's word: an adopter holding the
package cannot re-run them, and `evidence` is exactly the field an author would
get wrong.

So `skills/git-bundle-verify` ships `vectors/`: four classes of defective bundle
(damaged, truncated, incremental, foreign), a positive control, the digest each
is to be offered with, and the step that must refuse it — in `MATRIX.tsv`, one
row per case. The runbook's own step 5 is to run them. Keep such vectors small
and cut from a throwaway repository; the whole set here is under 2 KB, and
`tools/gen-bundle-vectors.sh` regenerates it byte for byte.

The positive control is not optional. A runbook that refuses everything passes
a matrix of refusals perfectly.

## `skills/git-bundle-verify`

Check a git bundle before trusting it: digest, complete history, clone, and
byte equality with a reference checkout. Read-only, offline, no privileges,
`risk_level: low`. See its `SKILL.md`.
