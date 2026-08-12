// D-2 — WHAT SUCCESS IS, AND WHO IS ALLOWED TO SAY IT HAPPENED.
//
// THE DEFECT THIS MODULE EXISTS TO REMOVE. The `outcome_contract` was signed
// correctly and never executed. §4's `outcome` column read `records[].result` —
// a field the REPORTING agent fills in — whenever a boolean said a contract
// existed somewhere. So a principal holding the §6.2 `report_outcome` grant
// declared its own success and the registry printed it, which is exactly what
// [M-6] exists to forbid: the end of a task is the end of its execution, not
// success on the merits.
//
// WHY THIS IS ITS OWN MODULE, and what it is allowed to import. `src/fleet.ts`
// holds a discipline — nothing in it may reach a filesystem, because a V-2
// addressee is an agent on somebody else's machine and there is no disk of
// theirs to open [M-7]. `src/manifest.ts` reads Appendix E's schema files off
// disk through `ajv`. Putting the contract's shape and its evaluator here lets
// both import them and keeps that discipline exactly where it was.
//
// The rule this module keeps is therefore stated as what it IS and not as a
// round number: NO MODULE OF THIS PROJECT is imported here, and nothing here
// reaches a filesystem, a database or a clock. One Node builtin is imported —
// `node:crypto`, for the digest a check compares against — and a digest is a
// pure function of its bytes. It used to say "no imports at all", which was
// true and is not any more, and a comment that keeps a number it has stopped
// earning is the class of defect this file is full of warnings about.
import { createHash } from "node:crypto";

export const OUTCOME_CHECK_KINDS: readonly string[] = ["exit_code", "stdout_match", "artifact_exists", "command"];

/**
 * THE PARAMETER EVERY KIND OF CHECK NEEDS TO BE EXECUTABLE, and what evidence
 * has to be produced for it to be executed.
 *
 * A `stdout_match` with no pattern, an `artifact_exists` with no path, a
 * `command` with no command and an `exit_code` with no code are not
 * definitions of success. They name a METHOD and withhold its subject, and a
 * registry that accepted one would be signing a document that says nothing
 * while looking as though it says something — which is precisely the class §3
 * calls the main defect.
 *
 * The table is here, in ONE place, because the schema and the reader must not
 * be able to disagree about what a whole contract is: `test/p14-r5-probes` asks
 * both the same question about the same four truncations.
 *
 * `observable` IS THE NARROWING, WRITTEN AS DATA. It says whether THIS REGISTRY
 * can produce this kind's evidence by looking at something of its own. Exactly
 * one kind can: `artifact_exists`, and only for an artifact its own activation
 * journal says it placed under a root it manages. An exit code, an output and a
 * command line are facts about a process on the addressee's machine; this
 * registry did not run it and cannot [M-7], so no amount of evidence about them
 * is its own to answer for. A kind added later is `observable: false` until
 * somebody writes down why it is not, which is the direction that fails safe.
 *
 * `digest_of` IS THE OTHER NARROWING, and it names a PARAMETER whose DIGEST is
 * compared — never the parameter itself. Two of the four kinds are defined
 * against a string the author wrote inside the signature: the `command` a run
 * must have executed, the `artifact_path` a run must have produced. Comparing a
 * PRESENTED string with a SIGNED one meant admitting that string as an evidence
 * value, and an author is a fleet agent too — it writes its transcript into
 * `check.command`, signs it, and echoes it back into the journal. So a run
 * presents the DIGEST of the parameter and this registry computes the digest of
 * the signed parameter itself: the comparison decides exactly what it decided
 * before, and no arrangement of author text is a value any more. `null` is for
 * the kinds that compare something else — an integer, and a digest the author
 * wrote as a digest.
 */
export const OUTCOME_CHECK_SHAPE: Readonly<
  Record<
    string,
    { parameter: string; evidence: string; reads: readonly string[]; observable: boolean; digest_of: string | null }
  >
> = {
  exit_code: { parameter: "exit_code", evidence: "exit_code", reads: ["exit_code"], observable: false, digest_of: null },
  stdout_match: { parameter: "stdout_match", evidence: "stdout_sha256", reads: ["stdout_sha256"], observable: false, digest_of: null },
  artifact_exists: { parameter: "artifact_path", evidence: "artifacts", reads: ["artifacts"], observable: true, digest_of: "artifact_path" },
  command: { parameter: "command", evidence: "exit_code", reads: ["command", "exit_code"], observable: false, digest_of: "command" },
};

/**
 * THE NAMED VALUES A CHECK OF THIS REGISTRY READS — every one of them, and no
 * other. `reads` above is the per-kind list; this is their union.
 *
 * It exists because [I-7]'s boundary needs a SET OF ADMISSIBLE NAMES and the
 * only honest source for one is the code that consumes them. Written out as a
 * literal at the boundary it would be a second list, free to disagree with
 * `executeCheck` the moment a kind is added; derived here it cannot. The probe
 * closes the remaining gap in the other direction: it executes all four checks
 * against a recording proxy and asserts the names they actually touch are
 * exactly this set, so a kind that starts reading a fifth value fails a test
 * rather than silently narrowing what a report may present.
 *
 * AND THIS SET IS THE WHOLE OF IT — round 9b's fix, stated where the set is
 * defined. It used to be a FLOOR that a version's signed `outcome_contract`
 * raised, and an author declaring a hex string as a name put that string in the
 * journal as a key. A form cannot separate a key from a secret written as one,
 * so the widening is gone rather than filtered: no route adds to this set, and
 * `outcome_contract.evidence` is NOT A SOURCE OF ADMISSIBLE NAMES.
 *
 * WHAT IS NOT HERE, deliberately: `stdout_match`, `artifact_path` and the
 * `exit_code` of a `check` are the CONTRACT's parameters — what the author
 * demanded — and not values a run produces. A report presents the second kind.
 */
export const EVIDENCE_NAMES: readonly string[] = [
  ...new Set(Object.values(OUTCOME_CHECK_SHAPE).flatMap((s) => s.reads)),
].sort();

// ===========================================================================
// WHAT A NAME MAY LOOK LIKE — the form of an AUTHOR'S DECLARATION.
// ===========================================================================

/**
 * THE HISTORY OF THIS SECTION, kept because each correction is what made the
 * one before it true, and because the last of them is a correction OF A FIX.
 *
 * Round 6 closed the SET of admissible names: the names this registry's checks
 * read, plus the names the SIGNED `outcome_contract` declared. Round 8 closed
 * the VALUES to a boolean, a safe integer or a digest and removed the echo of
 * signed literals — both about what a name CARRIES, neither about what a name
 * IS. Round 9 closed the FORM: a declared name became an identifier, because
 * under D-21 the author of a skill is a fleet agent like any other and a
 * declared name was landing in `observed_records.evidence` as a JSON KEY, word
 * for word — 1600 characters of author text by the shipped route.
 *
 * ROUND 9b FOUND THAT A FORM IS NOT A SUBJECT. Every alphabet fit for readable
 * names is fit for part of the secrets: a reviewer declared
 * `a0123456789abcdef0123456789abcdef` — an ordinary hex string of 33
 * characters, inside this pattern without any effort being made to squeeze it
 * in — as an evidence NAME, and the material came back out of the column word
 * for word. No regular expression separates a key from a credential written as
 * one, so the CHANNEL was removed instead of narrowed again: the journal's
 * admissible names are `EVIDENCE_NAMES` and a signed declaration adds none.
 *
 * SO WHAT IS THIS FORM STILL FOR. It bounds the AUTHOR'S DECLARATION in the
 * SIGNED MANIFEST, which is a different object from the journal.
 * `outcome_contract.evidence` states what a run ought to present; it is
 * machine-readable content of a document, and a document whose field may be a
 * paragraph is not machine-readable. The form is enforced by the schema, so a
 * contract naming a sentence cannot be packed, and by `outcomeContractOf`, so a
 * contract signed elsewhere is not read as a definition of success — and in
 * neither place does it decide what the journal accepts. The field is NOT A
 * SOURCE OF ADMISSIBLE NAMES; [I-7] bounds the journal, not the manifest, and
 * an author's text under a signature never becomes a key of a record.
 *
 * WHY THE JOURNAL'S NAMES ARE NOT DIGESTS, since that is how the values were
 * closed. Because the journal is read by people: a value may become a digest
 * without loss — the reader wants to know that an output matched, not what it
 * was — but a NAME is what tells a reader WHICH quantity was presented, and a
 * column of digests would record evidence and show nobody what kind.
 *
 * WHAT NONE OF THIS CLAIMS, because a comment that claims an impossibility it
 * does not deliver is the class of defect this file carries warnings about.
 * `EVIDENCE_NAMES` is four names of this registry's own choosing, so no author
 * string is a key at all; but an author still chooses the strings inside its
 * own manifest, and a bounded alphabet — this one, like the flat list of
 * thirty-two integers a value may be — can be made to carry an ENCODING of
 * something by an author who sets out to build one. The achievable property is
 * the one enforced: this registry does not put text into the journal, and the
 * forms it accepts there are its own.
 */
export const EVIDENCE_NAME_MAX = 40;

/**
 * THE FORM, IN ONE PLACE, and derived from the bound above so the two cannot
 * drift. `schema/skill-package-v1.schema.json` carries this pattern as its
 * `outcome_contract.evidence` item pattern, and a probe compares the two
 * sources character for character: a rule written out twice is a rule that gets
 * widened in one copy.
 *
 * WHY 40 AND NOT 80, ARGUED RATHER THAN ROUNDED. The longest name this registry
 * itself reads is `stdout_sha256`, thirteen characters; the longest name an
 * author plausibly needs is a compound of three words —
 * `integration_suite_exit_code` is twenty-seven. Forty is comfortably above
 * both, and it is still short enough that a name fits a dashboard cell and
 * reads as a key rather than as a phrase.
 *
 * NEITHER THE NUMBER NOR THE ALPHABET CLOSES ANYTHING, and this paragraph used
 * to say that the alphabet did — three paragraphs after the same file records
 * that a bounded alphabet can be made to carry an encoding. What closed the
 * channel was the deletion of the WIDENING: a declared name is not a key of the
 * journal, so no bound on its form is protecting anything. The form is required
 * because a manifest has to stay machine-readable, and the length is set where
 * legitimate names live rather than at the smallest value the tests would pass.
 */
export const EVIDENCE_NAME = new RegExp(`^[a-z][a-z0-9_]{0,${EVIDENCE_NAME_MAX - 1}}$`);

/**
 * Whether ONE name may be declared and stored.
 *
 * ONE implementation, here, for the same reason `isAdmissibleEvidenceValue` is:
 * the packing schema refuses a contract that names a sentence, and this refuses
 * one that arrives at the report boundary by any other route. Two definitions
 * of "a name" would be two answers to the same question, which is exactly how
 * the name SET was widened in round 5.
 */
export function isEvidenceName(name: unknown): boolean {
  return typeof name === "string" && EVIDENCE_NAME.test(name);
}

export interface OutcomeCheck {
  kind: string;
  exit_code?: number;
  stdout_match?: string;
  artifact_path?: string;
  command?: string;
}

// ===========================================================================
// WHAT A NAMED VALUE MAY BE — the CHANNEL, closed the same way the names were.
// ===========================================================================

/**
 * THE DEFECT THIS SECTION EXISTS TO REMOVE, and it is the previous round's fix
 * looked at from one step further back.
 *
 * Round 6 closed the set of evidence NAMES: a report may only present names the
 * signed contract asked for. It left the VALUES open — any string, of any
 * content, up to the size bound. A reviewer put `sk-live-…` through the shipped
 * `/v1/observations` surface under the contract's own output channel — then
 * called `stdout`, and renamed for what it can actually hold once this section
 * existed — and it was stored, word for word, in an INSERT-only journal. A whole transcript goes the
 * same way. A closed set of names over an open set of values is not a closed
 * channel: it is a key-value store with a vocabulary.
 *
 * SO A VALUE IS ONE OF THREE THINGS, and never "a string":
 *
 *   * a BOOLEAN — one bit, nothing can be hidden in it;
 *   * a SAFE INTEGER — an exit code, a count, a duration;
 *   * a DIGEST OF FIXED FORM — `sha256:` and sixty-four lowercase hex digits,
 *     and nothing else may wear that shape. A digest carries no text: it is the
 *     way to present "the output was exactly this" without presenting output.
 *
 * …or a FLAT LIST of those. Everything else is refused at the boundary and never
 * reaches the database.
 *
 * THERE WAS A FOURTH, AND IT WAS A CHANNEL. A value used to be allowed to be a
 * LITERAL THE SIGNED CONTRACT NAMED — the `command` it demands, the
 * `artifact_path` it demands — on the reasoning that an enumeration fixed at
 * signing time is not a channel because a reporter can only echo the author's
 * own words. THE AUTHOR IS A FLEET AGENT TOO. It put its transcript in
 * `check.command`, signed it, and echoed it back: 201, stored word for word.
 * The enumeration is gone, and with it the function that computed one — a
 * permitting set nobody consults is a hole that has merely not been walked
 * through yet. What replaces it is `digest_of` in the check table above: a run
 * presents the DIGEST of the parameter and the registry compares it against the
 * digest of the signed parameter. The check decides what it always decided.
 *
 * AND THE LIST IS FLAT, WHICH IS THE OTHER HALF. The rule used to be written
 * recursively, so `EVIDENCE_LIST_MAX` bounded each LEVEL of a tree and nothing
 * bounded the tree: a reviewer put a whole transcript through the shipped
 * `/v1/observations` surface as NESTED ARRAYS OF BYTES under the base name
 * `exit_code` — 201, stored, recoverable byte for byte, and the only ceiling
 * was 4000 bytes of JSON. A list is now a list of SCALARS, at no depth, and the
 * bound is therefore on the whole value rather than on one level of it.
 *
 * WHAT THIS COSTS, STATED. Free text can no longer be presented under ANY name,
 * including a name the contract declared. An author who wants a run's output
 * evaluated presents its digest, and the contract states the digest it expects.
 * A `stdout_match` that names a SUBSTRING is therefore no longer executable by
 * this registry — see `checkParameterIsReadable` below, which says so in a
 * reason rather than answering `no` to a run that may well have printed the
 * pattern. THE PATTERN ITSELF MAY STILL BE A SUBSTRING: it is author content
 * inside a signature, and [I-7] is about what a run writes into this journal,
 * not about what an author writes into a manifest.
 *
 * AND THE CHANNEL IS NAMED FOR WHAT IT HOLDS. It used to be called `stdout`,
 * which promised the output of a process; it can hold only a digest, so it is
 * `stdout_sha256`. A field whose name asserts more than the code delivers is
 * the same class of defect as a comment that does, one level further in.
 */
export const EVIDENCE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** How many SCALARS a list-valued evidence may carry — and, because a list may
 *  not hold a list, how many the whole value may carry. A list is a value, not
 *  a place to put a transcript one element at a time, and not a place to put
 *  one thirty-two elements at a time either. */
export const EVIDENCE_LIST_MAX = 32;

/**
 * THE DIGEST OF A SIGNED PARAMETER — the one arithmetic this module performs.
 *
 * `sha256:` and the SHA-256 of the parameter's UTF-8 bytes, which is exactly
 * `EVIDENCE_DIGEST`'s shape, so what a check compares against is a value the
 * grammar already admits and no special case is needed anywhere for it.
 *
 * It is exported because `registryObservedEvidence` (`src/activation.ts`) must
 * produce the SAME form when it reports what it found under an activation root.
 * Two implementations of "the digest of a path" would be a registry whose own
 * evidence its own boundary refuses — which is what round 8 found it to be.
 */
export function evidenceDigestOf(text: string): string {
  assertWellFormedText(text, "the string to be digested");
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * WHAT THIS REGISTRY REFUSES TO HASH, AND WHY THE REFUSAL IS IN THE PRIMITIVE.
 *
 * A JavaScript string is a sequence of UTF-16 code units, and JavaScript admits
 * sequences that are not text: a surrogate with no partner. `update(text,
 * "utf8")` replaces EVERY such code unit with U+FFFD before it hashes, so
 *
 *     "\ud800" !== "\ud801"                    — two strings
 *     digest("\ud800") === digest("\ud801")    — ONE digest
 *
 * and a column reduced to a digest on the promise that "equality survives a
 * hash exactly" (`src/journal.ts`) stops separating two values it exists to
 * separate. EQUALITY survives; INEQUALITY does not. A reviewer drove it through
 * the shipped `/v1/observations`: a `call` with `call_id: "\ud800"` and an
 * `output` with `call_id: "\ud801"` — ids that do not match — were stored as
 * one digest, read as a pair, and published as `observed_arrival: yes` [M-5].
 *
 * THE FORMULA DOES NOT MOVE, and that is the reason this is a refusal rather
 * than a better encoding. `utf16le` tells those two strings apart and is not
 * available: the digests of `observed_records.call_id` and
 * `receipt_events.idempotency_key` are already written, the originals are gone,
 * and no migration can recompute them. Changing the encoding would invalidate
 * every digest this registry has ever stored — a reader hashing the id it holds
 * would stop finding its own row. So the arithmetic stays and what changes is
 * WHAT IS ADMITTED INTO IT.
 *
 * AND THE REFUSAL IS HERE, at the one line every caller passes through, rather
 * than at the surfaces that read a string from a request. A rule stated at the
 * four places that take an id today is a rule the fifth place forgets tomorrow;
 * this is the same shape as B-2's minting rule, which made a violation
 * unexpressible at the point everything goes through instead of checking for it
 * at every point of entry. A BOUNDARY TRANSLATES this refusal into
 * `INVALID_SCHEMA` with a reason — it does not restate the rule, because two
 * statements of one rule are how they come apart (round 5, round 9b, D-12).
 *
 * `isWellFormed` is ES2024, and `test/p14-r13-probes` asks each runtime it runs
 * on whether it has it and whether it agrees. There is no hand-written
 * fallback: a second definition of "well-formed UTF-16" is precisely what this
 * comment says not to write, and on a runtime without the method the call
 * throws a TypeError — which is this function's answer for such a string
 * anyway.
 */
/**
 * A STRING THIS REGISTRY REFUSES TO CARRY — the kind of refusal, not the reason.
 *
 * There are two reasons and they are different facts about Unicode, so each has
 * its own subclass and its own sentence. What they share is what a caller can do
 * about it and what an adapter must do with it: the request is refused with
 * `INVALID_SCHEMA`, never answered with a 500 and never stored. `errors.ts` maps
 * THIS class, so a reason added later is mapped the day it is added instead of
 * escaping as an untyped exception through whichever surface forgot it — which
 * is exactly how `src/jcs.ts`'s bare `Error` reached a client as 500 INTERNAL.
 */
export class RefusedText extends Error {}

export class NotWellFormedText extends RefusedText {
  constructor(what: string) {
    super(
      `${what} is not well-formed UTF-16: it holds an unpaired surrogate, which has no UTF-8 encoding of its own. ` +
        `Encoding it replaces that code unit with U+FFFD, so its digest is shared with other strings and two values ` +
        `this registry must tell apart would become one`,
    );
    this.name = "NotWellFormedText";
  }
}

/**
 * THE SECOND REASON, and it is not a variant of the first: `"a\u0000b"` IS
 * well-formed UTF-16, and its UTF-8 encoding is faithful, so nothing above
 * refuses it. What it does not survive is SQLITE. `length()` counts to the NUL
 * and stops, so a name of one such character measures 0 and fails a CHECK the
 * request satisfied; and node's `node:sqlite` decodes the column up to the NUL,
 * so `"a\u0000b"` and `"a\u0000c"` — two rows of a UNIQUE column — are read back
 * as one name. bun keeps both, which is worse rather than better: the same
 * request means different things on the two runtimes this project ships on.
 */
export class NulInText extends RefusedText {
  constructor(what: string) {
    super(
      `${what} holds U+0000, which SQLite treats as the end of a TEXT value: its length is measured up to that point ` +
        `and node reads the column back truncated there, so two values this registry must tell apart would be read ` +
        `as one`,
    );
    this.name = "NulInText";
  }
}

/** Whether a failure is one of these — for the adapters, which map it, and for
 *  a boundary that translates it rather than restating the condition. */
export function isRefusedText(e: unknown): e is RefusedText {
  return e instanceof RefusedText;
}

/**
 * THE ONE DEFINITION of what this registry may reduce to bytes.
 *
 * `evidenceDigestOf` calls it, so no digest is computed without it. It is also
 * exported, because a column that stores a caller's string VERBATIM and
 * compares it later — `idempotency_keys.key` — asks the very same question and
 * must not answer it for itself: node folds an unpaired surrogate to U+FFFD on
 * the way into SQLite (two keys become one) and bun stores its raw bytes and
 * reads them back as the empty string. Both are a string this registry cannot
 * key by, and one function decides that for every asker.
 */
export function assertWellFormedText(text: string, what: string): string {
  if (!text.isWellFormed()) throw new NotWellFormedText(what);
  return text;
}

/**
 * THE ONE DEFINITION of what may go into a column that CARRIES IDENTITY —
 * a primary key, a member of a UNIQUE key, or a column the code finds a row by.
 * `src/identity.ts` names every one of them, out of the schema.
 *
 * IT IS A ROUND-TRIP RULE AND NOT A LIST OF TWO CHARACTERS. Two different
 * strings of a caller may not become one, and they become one whenever what
 * SQLite gives back is not what it was given. So this admits exactly the strings
 * that survive being stored and read again, on both runtimes — which
 * `test/p14-r14-probes` [14.7] establishes by SWEEPING the whole BMP and every
 * astral plane and comparing what survives against what this function refuses,
 * rather than by taking anybody's word for the set. Today that is U+0000 and the
 * surrogate range and nothing else: emoji, correct surrogate pairs, CJK, RTL
 * marks, NFC and NFD, ZWJ sequences and combining marks all pass, and the same
 * probe is what stops this rule from being widened into them.
 *
 * IT IS BUILT ON `assertWellFormedText` RATHER THAN REPEATING IT. One of the two
 * reasons is round 13's rule exactly, and asking it twice in two spellings is
 * how the two would come apart.
 */
export function assertIdentityText(text: string, what: string): string {
  assertWellFormedText(text, what);
  if (text.includes("\u0000")) throw new NulInText(what);
  return text;
}

/**
 * Whether ONE value may be carried. A value and nothing else: there is no
 * enumeration to pass, because there is no enumeration.
 *
 * ONE implementation, here, because the boundary that refuses a report and the
 * checks that read a value must not be able to disagree about what a value is —
 * that disagreement is how the name rule was widened in round 5 and how the
 * value rule would be widened next.
 *
 * IT DOES NOT CALL ITSELF, AND THAT IS THE WHOLE OF THE SECOND FIX. A recursive
 * grammar applies its bound at every level and therefore to no value: thirty-two
 * lists of thirty-two lists is a tree with a million leaves and each level is
 * within the limit. A scalar, or a flat list of scalars — the bound counts the
 * leaves because the leaves are all there is.
 */
export function isAdmissibleEvidenceValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length <= EVIDENCE_LIST_MAX && value.every(isAdmissibleEvidenceScalar);
  return isAdmissibleEvidenceScalar(value);
}

/** The three things a leaf may be. Not exported: a caller that wanted only this
 *  would be a caller admitting a value the boundary never saw. */
function isAdmissibleEvidenceScalar(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value === "string") return EVIDENCE_DIGEST.test(value);
  return false;
}

export interface OutcomeContract {
  check: OutcomeCheck;
  /**
   * THE AUTHOR'S DECLARATION of the values a run of this skill OUGHT to present.
   *
   * It is not a precondition of anything. Round 9 removed the loop that required
   * every declared name to be present before a verdict could be reached, and
   * round 9b removed the widening that made a declared name a key of the
   * observation journal at all. A check is executed against the values this
   * registry's own four names carry; this field says what the author expected a
   * run to produce, and reads like the substring form of a `stdout_match` — text
   * under a signature, with no standing in the journal [I-7].
   */
  evidence: string[];
  /** what the absence of evidence means; never "a failure" */
  unknown: string;
}

/** The three answers §4 allows. Repeated here rather than imported, so this
 *  module keeps its promise of having no imports; `src/fleet.ts` declares the
 *  same union and a test asserts the two agree. */
export type OutcomeTrivalent = "yes" | "no" | "unknown";

// ===========================================================================
// WHOSE VALUES THESE ARE — the mark, set at intake, carried to publication.
// ===========================================================================

/**
 * THE DEFECT THIS SECTION EXISTS TO REMOVE, and it is worth stating exactly,
 * because the fix is a change of SHAPE and not a change of behaviour.
 *
 * `assessOutcome` used to read:
 *
 *     const claimed = evaluateOutcome(input.contract, input.claimed);
 *     if (claimed.value === "unknown") return registry(claimed);
 *
 * The values came from a PRINCIPAL. The verdict was `unknown`. And the answer
 * went out with `assessed_by: registry`, `basis: registry_observation` —
 * because `registry(…)` was a helper any branch could wrap any verdict in, and
 * this branch happened to be written that way. THE PROVENANCE WAS INFERRED
 * FROM WHICH BRANCH OF THE CODE RAN, not from whose data was read.
 *
 * That is the same class of defect `as Cell` was in round 5, and it takes the
 * same kind of answer. Not a check that the two agree — a CONSTRUCTION in which
 * they cannot disagree:
 *
 *   * values are MARKED WHEN THEY ARE ACCEPTED, before anything evaluates
 *     them: `selfReported` where an agent presented them, `registryObserved`
 *     where this registry produced them by looking at something it manages;
 *   * the mark is membership in a `WeakMap` held in this module's closure, so
 *     it is carried BY IDENTITY. A cast changes a type and changes no object;
 *     a literal of the same shape is a different object; `JSON.parse` of a
 *     marked object's own bytes, a `structuredClone` and a spread copy are all
 *     different objects, and none of them can be made a member without calling
 *     a constructor — which is the thing that was wanted;
 *   * `assessed_by` is not a parameter of anything, and it is not a literal
 *     anywhere in the executable part of this module. There is ONE function
 *     that builds a published verdict, it computes the verdict ITSELF from the
 *     marked values it was handed, and it reads the attribution off that same
 *     object. So no branch of the assessor can pair one party's data with the
 *     other's authority: `registry(claimed)` is not refused here, it is not
 *     expressible here.
 *
 * WHAT THIS DOES NOT CLAIM — and the limit is stated because a comment claiming
 * the stronger thing would be the very defect this round is about.
 *
 *   Membership proves an object came from a constructor. It does NOT prove the
 *   CALLER of `registryObserved` was entitled to call it: a new module could
 *   call it on values an agent sent, and nothing in this file would notice.
 *   That is a separate property and it is kept separately — there is exactly
 *   one caller in `src/`, and a probe reads the source DIRECTORY and asserts
 *   which file it is, so a second caller is a failing test. It is a guard, not
 *   an impossibility, and it is described here as a guard.
 */
export type EvidenceOrigin = "registry" | "principal";

declare const EVIDENCE_MARK: unique symbol;

/**
 * Named values that KNOW where they came from.
 *
 * At runtime this is exactly the object of named values — the wire shape does
 * not change and neither does what `JSON.stringify` produces. The brand is a
 * type-level declaration only, and it is the WEAKER of the two layers: `as
 * Evidence` defeats it, which is precisely why the answer that matters is the
 * `WeakMap` below.
 */
export type Evidence = Readonly<Record<string, unknown>> & { readonly [EVIDENCE_MARK]: EvidenceOrigin };

/** The mark. A `WeakMap` because it must not keep a report alive, and because
 *  the whole of the answer is one word about one object. */
const MARKED = new WeakMap<object, EvidenceOrigin>();

/**
 * The refusal raised when values of unknown provenance reach the assessor. Its
 * own class, so it cannot be swallowed by a `catch` written for something else,
 * and so a caller can tell it from any other failure.
 */
export class ForeignEvidence extends Error {}

/**
 * THE VALUES A PRINCIPAL PRESENTED — marked here, at the point of acceptance.
 *
 * `null` in, `null` out: a report that presented nothing is not a report of
 * nothing, and both are `unknown` downstream, never `no`.
 */
export function selfReported(values: Record<string, unknown> | null | undefined): Evidence | null {
  return mark(values ?? null, "principal");
}

/**
 * THE VALUES THIS REGISTRY PRODUCED BY LOOKING AT SOMETHING IT MANAGES.
 *
 * There is exactly ONE caller of this function in `src/` —
 * `registryObservedEvidence` in `src/activation.ts`, which reads an artifact
 * under an activation root against this registry's own journal entry saying it
 * put the artifact there. A probe reads the source directory and asserts that,
 * so a second caller is a failing test rather than a widened authority.
 */
export function registryObserved(values: Record<string, unknown>): Evidence {
  return mark(values, "registry") as Evidence;
}

function mark(values: Record<string, unknown> | null, origin: EvidenceOrigin): Evidence | null {
  if (values === null) return null;
  const frozen = Object.freeze({ ...values });
  MARKED.set(frozen, origin);
  return frozen as Evidence;
}

/** Whether this exact object is one a constructor above marked. */
export function isEvidence(value: unknown): value is Evidence {
  return typeof value === "object" && value !== null && MARKED.has(value as object);
}

/**
 * WHOSE VALUES THESE ARE, or a REFUSAL.
 *
 * Every published verdict's attribution comes through here, which is what makes
 * "the answer stands on the authority of whoever produced the data" a property
 * of the code rather than a sentence about it.
 */
export function originOf(value: unknown): EvidenceOrigin {
  const origin = typeof value === "object" && value !== null ? MARKED.get(value as object) : undefined;
  if (origin === undefined) {
    throw new ForeignEvidence(
      "refused: named values that no evidence constructor marked reached the assessor " +
        `(${describeEvidence(value)}). Provenance is admitted by IDENTITY — the object is one \`selfReported\` or ` +
        "`registryObserved` returned — so a cast, a literal of the same shape, a `JSON.parse` of marked bytes and a " +
        "clone of one are all refused here.",
    );
  }
  return origin;
}

/** What a refused object IS, without printing what it says: a rejected value
 *  may be the very material [I-7] keeps out of this process's output. */
function describeEvidence(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return `a ${typeof value}`;
  return `an object with keys [${Object.keys(value as object).join(", ")}]`;
}

/**
 * THE EVALUATOR. Deterministic, total, and it never reads what anybody claimed.
 *
 * Its inputs are the SIGNED contract and the EVIDENCE a run produced. It
 * answers `yes` only where the contract's own `check` was executed and
 * satisfied, `no` only where it was executed and not satisfied, and `unknown`
 * — with a reason naming what was missing — everywhere else. There is no path
 * through it that reaches `yes` or `no` without running the check, which is
 * what makes "a principal cannot declare its own success" a property of the
 * code instead of a sentence about it.
 *
 * WHAT "EXECUTES" MEANS HERE, precisely, because the word could be read as
 * running a shell and this registry runs nothing. The check is executed AGAINST
 * THE EVIDENCE: `exit_code` compares the code the run reported to the code the
 * contract requires; `stdout_match` compares the digest the run presented with
 * the digest the contract requires; `artifact_exists` looks for the DIGEST of
 * the contract's path in the digests of the artifacts the run presented;
 * `command` requires the evidence to carry the DIGEST of the very command the
 * contract names and that command to have exited 0. The
 * registry never opens a path a caller named and never spawns anything [M-7] —
 * a V-2 addressee is on somebody else's machine and there is nothing to spawn.
 * What it does is decide, deterministically, from values it was given, and
 * refuse to decide when it was not given them.
 */
export interface OutcomeVerdict {
  value: OutcomeTrivalent;
  reason: string;
}

/**
 * The three principal types `0001_init.sql` allows. Repeated rather than
 * imported, so this module keeps its promise of having none; a test asserts the
 * two agree.
 */
export type PrincipalType = "human" | "agent" | "service";

/**
 * A VERDICT WITH ITS PROVENANCE — [I-3] applied to the one number that shipped
 * without any.
 *
 * §4's `outcome` was the last value in this product published as a bare answer.
 * Every other number here carries its state, its source and its boundary; this
 * one said `yes` and left a reader to assume the registry had checked.
 *
 * D-18 settled what it must say instead, and the three attributes are its three
 * sentences:
 *
 *   * `assessed_by` — WHOSE values decided it. `registry` where the deciding
 *     evidence is something this registry observed itself; `principal` where it
 *     is what an agent reported about its own machine.
 *   * `principal_type` — WHICH KIND of principal reported, out of the three
 *     `agents.type` allows [I-5]. `null` where nothing was reported.
 *   * `basis` — whether this is a SELF-REPORT or an OBSERVATION. It is the same
 *     fact as `assessed_by` under the name a reader needs, and the two cannot
 *     disagree because one is computed from the other, four lines below. Both
 *     are published because D-18 requires both to be printed and because the
 *     panel colours one and reads the other.
 *
 * And one more, which is not provenance but its consequence:
 *
 *   * `claim` — WHAT THE SELF-REPORT AMOUNTS TO, if it were believed. This is
 *     how a self-report is published LOUDLY rather than swallowed: the reader
 *     sees `unknown`, sees that a principal claimed `yes`, and sees that the
 *     registry did not check it. `null` where there is no claim to speak of.
 */
export interface OutcomeAssessment extends OutcomeVerdict {
  assessed_by: "registry" | "principal";
  principal_type: PrincipalType | null;
  basis: "registry_observation" | "self_report";
  claim: OutcomeTrivalent | null;
}

/** The one place `basis` comes from, so the two names are one fact. */
function basisOf(assessedBy: OutcomeAssessment["assessed_by"]): OutcomeAssessment["basis"] {
  return assessedBy === "registry" ? "registry_observation" : "self_report";
}

export interface OutcomeInputs {
  contract: unknown;
  /** the named values a PRINCIPAL presented about its own machine, marked as
   *  such by `selfReported` AT THE POINT THEY WERE ACCEPTED */
  claimed: Evidence | null;
  /** the named values THIS REGISTRY produced by looking at something it
   *  manages, marked by `registryObserved`, or `null` where it looked at
   *  nothing. `null` is not "the artifact is absent" */
  observed: Evidence | null;
  /** the principal that reported, for its type [I-5]. `null` where none did */
  principal: { type: PrincipalType } | null;
}

/**
 * THE PUBLISHED VERDICT — what §4's column says, and on whose authority.
 *
 * WHY THIS IS A SECOND FUNCTION AND NOT A CHANGE TO `evaluateOutcome`. The two
 * answer different questions. `evaluateOutcome` answers "does this evidence
 * satisfy this contract" — a pure, total function of two documents, and the
 * thing D-14 asked for. This one answers "what may the registry PUBLISH", which
 * needs one fact `evaluateOutcome` has no business knowing: WHERE THE EVIDENCE
 * CAME FROM.
 *
 * D-18 IS THE REQUIREMENT CHANGE THIS IMPLEMENTS, and it is worth stating why
 * the requirement moved rather than the code. D-14 said the evaluator EXECUTES
 * the `check`. [M-7] says this registry does not assume access to the
 * addressee's machine. For a remote addressee those two are not both
 * satisfiable: `exit_code`, `stdout_sha256` and `command` are facts about a process on
 * somebody else's computer, and nothing this registry can do will make them its
 * own observations. The registry not running processes on other people's
 * machines is a PROPERTY OF THE PRODUCT.
 *
 * So the split is by WHAT THE REGISTRY CAN CONFIRM:
 *
 *   * evidence the registry produced itself — today, exactly one thing: whether
 *     an artifact is present under the activation root THIS REGISTRY writes to
 *     and can read back (work 5, D-7) — decides a real `yes` or `no`, attributed
 *     to the registry.
 *
 *   * evidence a principal presented is a SELF-REPORT. The contract is still
 *     executed against it, because what the self-report AMOUNTS TO is worth
 *     publishing, but the published verdict is `unknown` with a reason that says
 *     it was not verified here, and the claim rides beside it under its own
 *     name. `{"command":"false","exit_code":0}` is the case that makes this
 *     obvious: `false` exits 1 on every machine there is, the report says 0, and
 *     a registry that answered `yes` to that would be certifying a lie it has no
 *     way to detect. [M-6] is kept whole — a task that finished is not a task
 *     that succeeded, and neither is a task whose runner says it succeeded.
 *
 *   * `unknown` with a reason stays for everything else: no contract, no
 *     evidence, evidence of a shape the check cannot read.
 *
 * [I-1] IS NOT WEAKENED. The verdict is still one of three values. Provenance is
 * attributes BESIDE it, exactly as it is for every counted number in this
 * product, and never a fourth answer.
 */
export function assessOutcome(input: OutcomeInputs): OutcomeAssessment {
  const principalType = input.principal?.type ?? null;

  if (input.contract === null || input.contract === undefined) {
    return publish(null, null, principalType);
  }

  // WHAT THE REGISTRY SAW ITSELF, FIRST. The one place it has standing to answer
  // is a thing its own journal says it put there, and `registryObservedEvidence`
  // is the only producer of values marked that way. Where its own reading is
  // `unknown` it does not pretend otherwise — it falls through to the report.
  if (input.observed !== null && input.observed !== undefined) {
    const own = publish(input.observed, input.contract, principalType);
    if (own.value !== "unknown") return own;
  }

  return publish(input.claimed ?? null, input.contract, principalType);
}

/**
 * THE ONE EXPRESSION THAT PUBLISHES A VERDICT, and the whole of 2.1's fix.
 *
 * It takes the MARKED VALUES and the CONTRACT — never a verdict somebody else
 * computed. That is the load-bearing detail: because it evaluates the contract
 * against the very object it read the attribution off, there is no way to hand
 * it an answer derived from one party's data and an authority belonging to the
 * other. `registry(claimed)` is not something this module refuses; it is
 * something no caller can spell.
 *
 * AND THE NARROWING LIVES HERE TOO. Values a PRINCIPAL presented never become
 * the published verdict, whatever the contract says about them: the column
 * reads `unknown`, the reason says it was not verified here, and what the
 * self-report AMOUNTS TO rides beside it as `claim`. A self-report that fails
 * to satisfy its contract is published the same way — `claim: "no"` — because
 * "this registry did not check it" is equally true of a claimed failure, and a
 * `no` printed on the registry's authority for a process on somebody else's
 * machine is the same lie in the other direction [M-6], [M-7].
 */
function publish(evidence: Evidence | null, contract: unknown, principalType: PrincipalType | null): OutcomeAssessment {
  // THE ATTRIBUTION, READ OFF THE DATA. `null` is the one case with no data to
  // read: no contract, or no evidence from anybody. The statement then made is
  // about this registry's OWN state of knowledge — "no contract was carried",
  // "no run presented evidence" — and it is the registry's to make. It is
  // always `unknown`; nothing here can turn an absence into an answer.
  const assessed_by: EvidenceOrigin = evidence === null ? "registry" : originOf(evidence);
  const verdict = evaluateOutcome(contract, evidence);
  const decided = verdict.value !== "unknown";

  // THE NARROWING, ENFORCED WHERE THE ANSWER IS PUBLISHED AND NOT ONLY WHERE THE
  // EVIDENCE IS PRODUCED. `registryObservedEvidence` yields values for
  // `artifact_exists` alone, so today no other kind can reach this function with
  // the registry's mark — and "cannot happen today" is exactly the sort of
  // guarantee that stops holding when somebody writes a second producer. The
  // rule is therefore stated against the check table, which is where
  // `observable` is decided and where a new kind will be added.
  const observable = OUTCOME_CHECK_SHAPE[(contract as OutcomeContract | null)?.check?.kind as string]?.observable === true;

  // A DECISION STANDS ON THIS REGISTRY'S AUTHORITY only where this registry's
  // OWN values decided it AND the kind is one it can observe. Everything else
  // is `unknown` — with the principal's conclusion published beside it where
  // there was one to publish.
  const stands = assessed_by === "registry" && decided && observable;

  // ONE CONSTRUCTION, and `assessed_by` is not a literal in it. There is no
  // expression here that CHOOSES an authority: the field is the origin read off
  // the data, `basis` is computed from that same value, and a caller that wants
  // a different attribution has no argument to pass and no branch to take.
  return {
    value: stands ? verdict.value : "unknown",
    reason: stands || !decided
      ? verdict.reason
      : assessed_by === "principal"
        ? "self_reported_not_verified_by_the_registry"
        : "check_kind_is_not_one_this_registry_can_observe",
    assessed_by,
    principal_type: principalType,
    basis: basisOf(assessed_by),
    claim: assessed_by === "principal" && decided ? verdict.value : null,
  };
}

export function evaluateOutcome(contract: unknown, evidence: unknown): OutcomeVerdict {
  if (contract === null || contract === undefined) return { value: "unknown", reason: "no_outcome_contract" };
  const c = contract as OutcomeContract;
  const shape = OUTCOME_CHECK_SHAPE[c?.check?.kind as string];
  if (!shape) return { value: "unknown", reason: "outcome_contract_names_no_deterministic_check" };
  // THE CONTRACT'S OWN PARAMETER MAY BE UNREADABLE, and that is a fact about
  // the CONTRACT and not about the run. `stdout_sha256` is carried as a digest,
  // and a substring cannot be tested against a digest — so a `stdout_match`
  // whose pattern is a substring is not executable by this registry, and it
  // says so rather than answering `no` to a run that may well have printed the
  // pattern. Blaming the evidence for the contract's shape would be a reason
  // that names the wrong party.
  if (!checkParameterIsReadable(c.check)) {
    return { value: "unknown", reason: "contract_check_parameter_is_not_one_this_registry_can_read" };
  }
  if (evidence === null || evidence === undefined || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { value: "unknown", reason: "no_evidence_so_the_check_was_never_executed" };
  }
  const values = evidence as Record<string, unknown>;

  // THE ONE VALUE THIS CHECK CANNOT PROCEED WITHOUT — and nothing else is
  // required, which is a change of requirement and not a relaxation of one.
  //
  // WHAT WAS HERE AND WHY IT HAD TO GO. A loop demanded the PRESENCE of every
  // name `outcome_contract.evidence` declared. That was coherent only while a
  // declaration WIDENED what a report could present; round 9b removed that
  // widening — the journal's names are `EVIDENCE_NAMES` and a declaration adds
  // none — so a contract naming a quantity of its own would have become
  // unevaluable for ever: the name cannot be presented, the boundary refuses
  // it, and its absence read `unknown evidence_missing:<name>` for the life of
  // the version. A dead branch and a reason that blames the run for the
  // author's document.
  //
  // AND IT IS NOT NARROWED TO THE DERIVED SET EITHER. The line below already
  // requires exactly what the check reads; a loop restricted to the base set
  // would be a SECOND statement of the same rule, and two statements of one
  // rule is the mechanism by which they come apart — the reasoning that put the
  // value grammar and the form of a name in one place each.
  //
  // `outcome_contract.evidence` remains what D-2 made it: the AUTHOR's
  // declaration of what a run ought to present, inside the signature, on the
  // same footing as the substring form of `stdout_match`. It is NOT A SOURCE OF
  // ADMISSIBLE NAMES for the journal and it is not read by this evaluator; [I-7]
  // bounds the journal, not the signed document.
  if (!(shape.evidence in values)) {
    return { value: "unknown", reason: `evidence_missing:${shape.evidence}_so_the_check_was_never_executed` };
  }

  const satisfied = executeCheck(c.check, values);
  if (satisfied === null) return { value: "unknown", reason: "evidence_is_not_of_the_shape_the_check_reads" };
  return satisfied
    ? { value: "yes", reason: "contract_satisfied" }
    : { value: "no", reason: "contract_not_satisfied" };
}

/**
 * Whether the SIGNED contract's own parameter is something this registry can
 * read, given what a run is now allowed to present.
 *
 * Only `stdout_match` has a constraint, and it is a consequence of 2.3 rather
 * than a new rule: the pattern is compared against `stdout_sha256`, which is a
 * digest, so a pattern that is not a digest of the same form names a
 * comparison nothing can perform. The other three compare against an integer
 * and against DIGESTS THIS REGISTRY COMPUTES ITSELF from the signed
 * `artifact_path` and the signed `command` — every one of which a run may
 * present under the value grammar, whatever the author wrote.
 */
function checkParameterIsReadable(check: OutcomeContract["check"]): boolean {
  // A PARAMETER THIS REGISTRY CANNOT DIGEST IS ONE IT CANNOT READ, and the
  // question is put to the function that decides it rather than answered again
  // here. `comparedDigest` below hashes this same literal; without this line a
  // signed contract naming a string that is not well-formed UTF-16 would reach
  // that hash and the refusal would leave the evaluator by way of an exception,
  // where the honest answer is `unknown` with a reason — a contract nobody can
  // execute is not a run that failed [I-1], [A-0].
  const field = OUTCOME_CHECK_SHAPE[check.kind]?.digest_of;
  if (typeof field === "string") {
    const literal = (check as unknown as Record<string, unknown>)[field];
    if (typeof literal === "string" && !isWellFormedText(literal)) return false;
  }
  if (check.kind !== "stdout_match") return true;
  return typeof check.stdout_match === "string" && EVIDENCE_DIGEST.test(check.stdout_match);
}

/** The refusal above, asked as a question. The rule is `assertWellFormedText`
 *  and lives in one place; this only chooses between throwing and answering. */
function isWellFormedText(text: string): boolean {
  try {
    assertWellFormedText(text, "a signed check parameter");
    return true;
  } catch (e) {
    if (e instanceof NotWellFormedText) return false;
    throw e;
  }
}

/**
 * The digest THIS KIND compares a presented value against, or `null` where the
 * kind compares something that is not a digest of a signed string.
 *
 * The parameter is read off `digest_of` in the check table, so the comparison
 * and the table cannot drift: a kind that starts comparing an author's string
 * declares it there or it is not compared at all.
 */
function comparedDigest(check: OutcomeContract["check"]): string | null {
  const field = OUTCOME_CHECK_SHAPE[check.kind]?.digest_of;
  if (typeof field !== "string") return null;
  const literal = (check as unknown as Record<string, unknown>)[field];
  if (typeof literal !== "string" || literal.length === 0) return null;
  return evidenceDigestOf(literal);
}

/** The four checks, executed against evidence. `null` = the evidence is not of
 *  a shape this check can read, which is not a failure of the run. */
function executeCheck(check: OutcomeContract["check"], values: Record<string, unknown>): boolean | null {
  switch (check.kind) {
    case "exit_code": {
      const observed = values.exit_code;
      if (!Number.isInteger(observed)) return null;
      return observed === check.exit_code;
    }
    case "stdout_match": {
      // AN EQUALITY OF DIGESTS, and no longer a substring test. `stdout_sha256`
      // is a digest of fixed form (2.3) because a channel that takes arbitrary
      // text is a transcript however the field is named, and `checkParameterIsReadable`
      // has already refused a contract whose pattern is not a digest, so both
      // sides of this comparison are digests or this line is not reached.
      const observed = values.stdout_sha256;
      if (typeof observed !== "string" || !EVIDENCE_DIGEST.test(observed)) return null;
      return observed === check.stdout_match;
    }
    case "artifact_exists": {
      // THE PATH THE CONTRACT NAMES, AS A DIGEST. A run presents the digest of
      // each artifact path it produced; the registry compares the digest of the
      // path the SIGNED contract demands. Comparing the paths themselves would
      // require admitting an author-written string as an evidence value, and an
      // author is a fleet agent — that string is its text channel.
      const want = comparedDigest(check);
      if (want === null) return null;
      const observed = values.artifacts;
      if (!Array.isArray(observed) || !observed.every((a) => typeof a === "string" && EVIDENCE_DIGEST.test(a))) return null;
      return (observed as string[]).includes(want);
    }
    case "command": {
      // THE COMMAND THE CONTRACT NAMES, AND NO OTHER — and as a digest, for the
      // same reason. Accepting an exit code without checking WHICH command
      // produced it would let a run present the status of something else
      // entirely; accepting the command as TEXT would let the author present
      // anything at all under the name of a check.
      const want = comparedDigest(check);
      if (want === null) return null;
      if (values.command !== want) return null;
      const observed = values.exit_code;
      if (!Number.isInteger(observed)) return null;
      return observed === 0;
    }
    default:
      return null;
  }
}
