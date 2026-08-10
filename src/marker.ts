// §5 ARRIVAL MARKER — the one thing a packaged skill leaves behind when an
// agent actually starts it.
//
// The problem it solves. §5 has to tell three answers apart: the skill RAN, the
// skill did NOT run, and NOTHING IS KNOWN. Nothing in a Codex-class runtime
// reports skill lifecycle, so the third answer is the honest default and the
// first has to be EARNED by a record the run itself produced. That record is
// this marker.
//
// [M-1] fixes where it comes from: the marker is derived DETERMINISTICALLY FROM
// THE SKILL VERSION ID, and the version id is minted by the registry. It is not
// derived from the package's content hash, and it must never be: the marker is
// written INTO the package, so a content-derived marker would change the very
// hash it was derived from. That circularity is why packing had to move to the
// server at all — a local packer has no version id to derive from.
//
// [M-2] fixes what it is worth: the marker is NOT a secret. It names a version,
// never a caller, and learning one tells you only that this version exists.
// Publishing it in `SKILL.md` in plain sight is therefore deliberate — a
// self-report an agent's owner cannot read is indistinguishable from
// surveillance, and in V-2 the reader is somebody else's fleet.
//
// [M-7] fixes the shape of the CONSUMING interface, and it is the reason the
// parsing half of this module takes strings:
//
//     every primitive below reads a RECORD, never a path.
//
// In V-2 the marker arrives as a self-report from an agent outside the owner's
// perimeter. There is no filesystem to open, no transcript file to stat — there
// is a line of text somebody sent. A primitive that took a path would have to
// be rewritten for that world; one that takes a record does not.
import { createHash } from "node:crypto";
import type { PackageFiles } from "./archive.ts";

/** Crockford base32 — the same alphabet ULIDs use (src/ulid.ts), so a marker
 *  and a version id are drawn from one character set and neither can carry a
 *  glyph the other cannot. I, L, O and U are excluded by construction. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `SKLN1` = Skillonomia arrival marker, format 1. The version digit is in the
 *  marker itself so a later format is distinguishable at a glance rather than
 *  by length. */
export const MARKER_PREFIX = "SKLN1-";

/** D-1: the first 16 base32 characters of SHA-256 over the version id — 80
 *  bits, which is not a security boundary (the marker is public) but is far
 *  past any accidental collision across a registry's versions. */
export const MARKER_BODY_LENGTH = 16;

/** Anchored form of one complete marker. */
export const MARKER_RE = new RegExp(`^${MARKER_PREFIX}[0-9A-HJKMNP-TV-Z]{${MARKER_BODY_LENGTH}}$`);

/** Unanchored, global — for finding markers inside an arbitrary record. The
 *  trailing boundary matters: `SKLN1-AAAA…AAAAX` must not be read as a valid
 *  marker with a stray suffix, or a corrupted record would parse as a good one. */
const MARKER_SCAN_RE = new RegExp(
  `${MARKER_PREFIX}[0-9A-HJKMNP-TV-Z]{${MARKER_BODY_LENGTH}}(?![0-9A-HJKMNP-TV-Z])`,
  "g",
);

/** Where the generated script lives inside every packed version. */
export const ARRIVAL_SCRIPT_PATH = "scripts/skln-arrive.sh";

/** The generated region of `SKILL.md`. Markers, not offsets: a human may edit
 *  the source `SKILL.md` freely, and the packer replaces exactly this region. */
export const ARRIVAL_BLOCK_BEGIN = "<!-- skln:arrival:begin -->";
export const ARRIVAL_BLOCK_END = "<!-- skln:arrival:end -->";

/** The two labels the script prints. They are also what a §6 scanner greps for,
 *  so they are constants rather than literals repeated in prose. */
export const ARRIVAL_MARKER_LABEL = "skln-arrival-marker";
export const ARRIVAL_VERSION_LABEL = "skln-skill-version-id";

function base32(bytes: Buffer): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * D-1: `SKLN1-<base32(sha256(skill_version_id))[:16]>`.
 *
 * The digest is taken over the version id's UTF-8 bytes — the id as it is
 * written everywhere else in this system, not a decoded form of it — so an
 * independent implementation needs only the string to reproduce the marker.
 */
export function arrivalMarker(skillVersionId: string): string {
  if (typeof skillVersionId !== "string" || skillVersionId.length === 0) {
    throw new Error("arrivalMarker: a skill_version_id is required");
  }
  const digest = createHash("sha256").update(skillVersionId, "utf8").digest();
  return MARKER_PREFIX + base32(digest).slice(0, MARKER_BODY_LENGTH);
}

/** True when this marker is the one this version's id derives. */
export function markerMatchesVersion(marker: string, skillVersionId: string): boolean {
  return marker === arrivalMarker(skillVersionId);
}

// ------------------------------------------------------- D-6: does it run?

/**
 * D-6: does this manifest declare that NO shell is available to it?
 *
 * A package whose author wrote `runtime.shell: ["none"]` is a package that
 * says, in a signed document, that nothing in it is executed by a shell.
 * Shipping it a generated shell script anyway would make the package and its
 * own manifest disagree — the class of defect §3 puts first, a document
 * asserting something other than what is there. So the script is not shipped,
 * and the manifest is NOT quietly amended to say `["sh"]` either: an author's
 * declaration is the author's.
 *
 * The reading matches §7.1 gate 8's: a list is "no shell" only when every
 * entry in it is `none`. `["none","bash"]` HAS bash, and gets the script.
 *
 * Fail-closed on anything unreadable. A manifest with no `runtime.shell`, or
 * one whose value is not a non-empty array, is treated as HAVING a shell — so
 * an unreadable declaration produces MORE checking (three places, script
 * required), never less. The schema requires the field, so this branch is for
 * callers outside the packing path.
 */
export function declaresNoShell(manifest: unknown): boolean {
  const shell = (manifest as { runtime?: { shell?: unknown } } | null | undefined)?.runtime?.shell;
  if (!Array.isArray(shell) || shell.length === 0) return false;
  return shell.every((s) => s === "none");
}

/**
 * Whether a version ships the executable arrival step.
 *
 * One name for the fact, derived in one place, so that the packer, the packing
 * guard and the §5 assessment cannot disagree about it.
 */
export function shipsArrivalScript(manifest: unknown): boolean {
  return !declaresNoShell(manifest);
}

// --------------------------------------------------------------- generation

/**
 * `scripts/skln-arrive.sh` — the executable half of D-1.
 *
 * Deliberately the dullest shell in the repository: two `printf`s of
 * single-quoted literals. No variable, no expansion, no substitution, no
 * interpreter flag — nothing §7.1's gate 5 has to reason about, because a
 * marker that needed a gate relaxed to ship would be a marker that had defeated
 * the point of the gates. It passes them as written or it does not ship.
 *
 * The label/value separator is `: ` rather than `=` on purpose: a space breaks
 * the token run, so the printed line can never look like one long
 * high-entropy string to §7.1's gate 2 no matter which files that gate is later
 * pointed at.
 */
export function renderArrivalScript(skillVersionId: string): string {
  const marker = arrivalMarker(skillVersionId);
  return [
    "#!/bin/sh",
    "# Generated by the Skillonomia registry when this version was packed.",
    "# It prints this version's arrival marker and the version id it derives",
    "# from, and does nothing else. The marker is NOT a secret (SPEC §5): it",
    "# names a skill version, never a caller or a workspace.",
    `printf '%s\\n' '${ARRIVAL_MARKER_LABEL}: ${marker}'`,
    `printf '%s\\n' '${ARRIVAL_VERSION_LABEL}: ${skillVersionId}'`,
    "",
  ].join("\n");
}

/**
 * The generated `SKILL.md` region, marker delimiters included.
 *
 * D-6: the block is generated for EVERY version, the `["none"]` case included,
 * and always carries the marker the version id derives. What changes is what it
 * can honestly tell the reader to do. With a script it names the step to run.
 * Without one it says so — because an instruction to run a file that is not in
 * the package would be the same lie in the other direction, and because a reader
 * of a `["none"]` package is entitled to know why nothing will ever be recorded
 * about it.
 */
export function renderArrivalBlock(skillVersionId: string, opts: { executableStep: boolean }): string {
  const marker = arrivalMarker(skillVersionId);
  const head = [
    ARRIVAL_BLOCK_BEGIN,
    "<!-- generated by the Skillonomia registry at packing time; edits are replaced -->",
    "",
  ];
  const body = opts.executableStep
    ? [
        `1. **Run the arrival step first:** \`./${ARRIVAL_SCRIPT_PATH}\``,
        "",
        `   It prints this version's arrival marker \`${marker}\` and the skill`,
        `   version id \`${skillVersionId}\`. Nothing later in this procedure depends`,
        "   on it. It exists so that a run leaves a record: without one, SPEC §5",
        "   reports this version as **unknown**, and never as **not run**.",
      ]
    : [
        "**Arrival step: none.**",
        "",
        `This version's arrival marker is \`${marker}\` and its skill version id is`,
        `\`${skillVersionId}\`. There is no \`${ARRIVAL_SCRIPT_PATH}\` to run,`,
        "because the manifest declares `runtime.shell: [\"none\"]` and a package",
        "that says it needs no shell will not be handed one.",
        "",
        "So arrival is not demonstrable for this version at all: SPEC §5 reports",
        "it as **unknown** for want of an executable step, and never as **not",
        "run**. An author who wants a run to be recorded declares a shell.",
      ];
  return [...head, ...body, "", ARRIVAL_BLOCK_END].join("\n");
}

const BLOCK_REGION_RE = new RegExp(
  `${ARRIVAL_BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}[\\s\\S]*?${ARRIVAL_BLOCK_END.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}`,
);

/** A markdown ATX heading whose text begins "procedure". */
const PROCEDURE_HEADING_RE = /^#{1,6}[ \t]+procedure\b.*$/im;
const ANY_HEADING_RE = /^#{1,6}[ \t]+\S.*$/m;

/**
 * Put the generated block into `SKILL.md` as the FIRST STEP OF THE PROCEDURE.
 *
 * "First step of the procedure" is located, not assumed: a `## Procedure`
 * heading if the document has one, otherwise straight after the document's
 * first heading, otherwise at the very top. A source document that already
 * carries a block has that block REPLACED rather than a second one appended, so
 * packing the same source twice cannot stack blocks.
 */
export function embedArrivalStep(
  skillMd: string,
  skillVersionId: string,
  opts: { executableStep: boolean },
): string {
  const block = renderArrivalBlock(skillVersionId, opts);
  if (BLOCK_REGION_RE.test(skillMd)) return skillMd.replace(BLOCK_REGION_RE, block);

  const heading = PROCEDURE_HEADING_RE.exec(skillMd) ?? ANY_HEADING_RE.exec(skillMd);
  if (!heading) return `${block}\n\n${skillMd}`;
  const at = heading.index + heading[0].length;
  return `${skillMd.slice(0, at)}\n\n${block}\n${skillMd.slice(at)}`;
}

// ------------------------------------------------------------------ parsing
//
// [M-7]: every function below takes a RECORD. None takes a path, opens a file,
// or knows that a filesystem exists.

/** Every complete marker occurring in one record, in order, deduplicated. */
export function markersIn(record: string): string[] {
  if (typeof record !== "string") return [];
  return [...new Set(record.match(MARKER_SCAN_RE) ?? [])];
}

/** The marker inside the generated `SKILL.md` block, or null. A marker written
 *  OUTSIDE the block does not count: the block is what the packer generates and
 *  therefore the only region whose content it can vouch for. */
export function markerInSkillMd(skillMd: string): string | null {
  const region = BLOCK_REGION_RE.exec(skillMd);
  if (!region) return null;
  const found = markersIn(region[0]);
  return found.length === 1 ? found[0]! : null;
}

/** The marker printed by a generated arrival script, or null. */
export function markerInArrivalScript(script: string): string | null {
  const found = markersIn(script);
  return found.length === 1 ? found[0]! : null;
}

/**
 * One record of a runtime transcript, reduced to the three things §5 needs.
 *
 * `role` distinguishes the record that ASKED for something from the record that
 * REPORTED what happened. [M-5] counts a version as invoked only on a PAIR, and
 * a shape that cannot tell a call from an output cannot express that rule.
 *
 * `call_id` IS THE OTHER HALF OF THAT RULE, and it is required rather than
 * optional. A pair is not "some call and some output that both mention a
 * marker" — it is the call and the output THE RUNTIME ITSELF BOUND, and the id
 * it bound them with is the only thing that says so. A shape that let a
 * producer omit the field would let a producer decide, silently, that this rule
 * did not apply to its records; that is precisely how `recordsFor` came to drop
 * it and how one set of records came to be a pair on one surface and not on
 * another. `null` is a runtime that gave no id, and a null can never pair.
 */
export interface ArrivalRecord {
  role: "call" | "output";
  /** what binds a call to ITS output. `null` — no id — never forms a pair. */
  call_id: string | null;
  /** the record's text, as a record — never a path to one */
  text: string;
}

/**
 * How one record of ANY shape looks to the pairing rule below.
 *
 * It exists so that the rule can be written ONCE and read by every §5 and §6
 * surface, whatever the records happen to be: `ArrivalRecord`s carrying text,
 * `ObservedRecord`s already reduced to a marker, or whatever V-2's self-report
 * turns out to be. The alternative — each surface implementing "a pair" for
 * itself — is what this repository has just paid for.
 */
export interface ArrivalPairView {
  role: string;
  /** the id the runtime bound a call to its output with, if it gave one */
  call_id: string | null | undefined;
  /** the complete §5 markers this record carries */
  markers: readonly string[];
  /**
   * Everything BEYOND (`call_id`, marker) that two records must share to be one
   * pair — the agent and the runtime, where the caller knows them. It is a
   * NARROWING and never a widening: a caller that supplies no scope gets the
   * rule applied within whatever window it handed over.
   */
  scope?: readonly string[];
}

/** One demonstrated invocation: the two records, and what bound them. */
export interface ArrivalPair<T> {
  marker: string;
  /** never null and never empty: without one there is no pair [M-5] */
  call_id: string;
  call: T;
  output: T;
}

/**
 * [M-5], IN ONE PLACE, FOR EVERY SURFACE.
 *
 * A pair exists when, and only when:
 *
 *   * a `call` record and an `output` record carry the SAME complete marker,
 *   * both carry the SAME non-empty `call_id` — the id the runtime used to
 *     bind them, never one this code invented, and
 *   * both agree on whatever else the caller put in `scope` (the agent and the
 *     runtime, wherever those are known).
 *
 * Anything short of the full conjunction yields NO PAIR, and no pair means
 * `unknown` — never `no` [I-1], [A-0]. A lone call says an agent tried. A lone
 * output says something quoted a marker. A call of one invocation and an
 * output of a different one are two facts about two invocations, and reading
 * them as one is how a surface comes to report an arrival nobody demonstrated.
 *
 * At most one pair per (scope, call_id, marker): a runtime that repeated an
 * output does not thereby produce two invocations.
 */
export function matchArrivalPairs<T>(
  records: Iterable<T>,
  viewOf: (record: T) => ArrivalPairView | null,
): Array<ArrivalPair<T>> {
  const keysOf = (view: ArrivalPairView): Array<{ key: string; marker: string; call_id: string }> => {
    const callId = typeof view.call_id === "string" && view.call_id.length > 0 ? view.call_id : null;
    // a record the runtime bound to nothing cannot be half of a pair
    if (callId === null) return [];
    const scope = view.scope ?? [];
    const out: Array<{ key: string; marker: string; call_id: string }> = [];
    for (const marker of new Set(view.markers)) {
      if (typeof marker !== "string" || !MARKER_RE.test(marker)) continue;
      // built through JSON so that no value can be forged into another by
      // containing the separator: a `call_id` holding the delimiter must not be
      // able to look like a different pair
      out.push({ key: JSON.stringify([...scope, callId, marker]), marker, call_id: callId });
    }
    return out;
  };

  const calls = new Map<string, T>();
  const outputs: Array<{ record: T; at: { key: string; marker: string; call_id: string } }> = [];
  for (const record of records) {
    if (record === null || record === undefined) continue;
    const view = viewOf(record);
    if (view === null) continue;
    if (view.role !== "call" && view.role !== "output") continue;
    for (const at of keysOf(view)) {
      if (view.role === "call") calls.set(at.key, record);
      else outputs.push({ record, at });
    }
  }

  const pairs: Array<ArrivalPair<T>> = [];
  const seen = new Set<string>();
  for (const { record, at } of outputs) {
    const call = calls.get(at.key);
    if (call === undefined) continue;
    if (seen.has(at.key)) continue;
    seen.add(at.key);
    pairs.push({ marker: at.marker, call_id: at.call_id, call, output: record });
  }
  return pairs;
}

/** The `ArrivalPairView` of one `ArrivalRecord` — the marker set is read out of
 *  the record's own text, and the text goes no further. */
function viewOfArrivalRecord(record: ArrivalRecord): ArrivalPairView | null {
  if (!record || typeof record.text !== "string") return null;
  return { role: record.role, call_id: record.call_id, markers: markersIn(record.text) };
}

/** [I-1]: three answers, and the third is the default. `"no"` is not a value
 *  this function can return, because nothing observable can establish it. */
export type ArrivalVerdict = "yes" | "unknown";

/**
 * D-6: WHY the answer is `unknown` — as a value, not as prose.
 *
 * A dashboard column and a scanner both have to distinguish two situations that
 * look identical from the outside and are not the same thing at all:
 *
 *   `no_paired_record`     — this version CAN be demonstrated. It ships the
 *                            arrival step; the records were searched; no
 *                            call/output pair carried its marker. Looking at
 *                            more records could still turn this into `yes`.
 *   `no_executable_step`   — this version CANNOT be demonstrated, by anything,
 *                            ever. It declares `runtime.shell: ["none"]`, so it
 *                            ships no arrival step, so no run of it can produce
 *                            a record. More records will never change this.
 *
 * Collapsing them would report a structural impossibility as a search that came
 * up empty, and invite someone to go looking for evidence that cannot exist.
 * Neither is `"no"` [I-1], [A-0]: not being able to prove a run is not the same
 * as knowing there was none.
 */
export type ArrivalUnknownReason = "no_paired_record" | "no_executable_step";

export interface ArrivalAssessment {
  verdict: ArrivalVerdict;
  /** null EXACTLY when the verdict is `yes`; never an empty string [I-1] */
  reason: ArrivalUnknownReason | null;
}

/** What a caller must know about the version before records mean anything. */
export interface ArrivalSubject {
  /** the marker this version's id derives */
  marker: string;
  /**
   * false when the version ships no `scripts/skln-arrive.sh` — D-6's
   * `["none"]` case. Derive it with `shipsArrivalScript(manifest)` rather than
   * by guessing, so the packer and the reader agree.
   */
  has_executable_step: boolean;
}

/**
 * [M-5] + D-6: the full §5 answer for one version against one set of records.
 *
 * `yes` iff a call record and an output record carrying this version's marker
 * SHARE ONE NON-EMPTY `call_id` — the id the runtime itself bound them with.
 * The rule is `matchArrivalPairs`'s, called and not restated, because the one
 * defect this whole module exists to prevent is two surfaces disagreeing about
 * what a pair is while both claiming to implement [M-5].
 *
 * It used to be looser here — some call, some output, no shared id — and the
 * looseness was not a simplification. It made ONE set of records a pair on the
 * assignments surface and not a pair on the capability surface, so the same
 * database answered `observed_arrival: yes` and `invoked: unknown` at the same
 * moment, and each surface could cite [M-5] for its answer.
 *
 * A version with no executable step short-circuits to `unknown` BEFORE the
 * records are read, and deliberately: it ships nothing that prints its marker,
 * so a pair carrying that marker cannot have come from running it, and treating
 * such a pair as evidence would be reading a coincidence as a fact.
 */
export function assessArrival(records: Iterable<ArrivalRecord>, subject: ArrivalSubject): ArrivalAssessment {
  if (!subject.has_executable_step) return { verdict: "unknown", reason: "no_executable_step" };
  if (!MARKER_RE.test(subject.marker)) return { verdict: "unknown", reason: "no_paired_record" };
  for (const pair of matchArrivalPairs(records, viewOfArrivalRecord)) {
    if (pair.marker === subject.marker) return { verdict: "yes", reason: null };
  }
  return { verdict: "unknown", reason: "no_paired_record" };
}

/** The verdict alone, for a version that DOES ship the arrival step. Callers
 *  that need to tell the two `unknown`s apart want `assessArrival`. */
export function arrivalVerdict(records: Iterable<ArrivalRecord>, marker: string): ArrivalVerdict {
  return assessArrival(records, { marker, has_executable_step: true }).verdict;
}

// ------------------------------------------------------------------- guard

export interface ArrivalIdentity {
  ok: boolean;
  /**
   * D-6: how many values the identity was taken over — 3 for a version that
   * ships the script, 2 for a `["none"]` version that cannot.
   *
   * It is REPORTED rather than inferred so that a caller, and a test, can see
   * which comparison actually ran. "Adaptive" must mean a different NUMBER OF
   * PLACES and never a lower bar: a guard that quietly compared two values for a
   * package holding three would be a weakening wearing the word.
   */
  places: 2 | 3;
  /** the marker `skill_version_id` derives — the value the others must equal */
  expected: string;
  /** what `SKILL.md`'s generated block carries, or null when it has none */
  in_skill_md: string | null;
  /** what the generated script prints, or null when the file is absent */
  in_script: string | null;
  /** why the identity failed; null when it held */
  reason: string | null;
}

/**
 * D-1's PACKING GUARD, as amended by D-6: the identity of THREE values, or of
 * TWO when there is no third place for one to live.
 *
 *   marker in SKILL.md  =  marker in scripts/skln-arrive.sh  =  marker derived
 *   from the skill version id                          (a version with a shell)
 *
 *   marker in SKILL.md  =  marker derived from the skill version id
 *                                            (a version declaring `["none"]`)
 *
 * Any disagreement — including an absent block, or a script that is absent when
 * it is expected, or PRESENT when it is not — is a REFUSAL TO PACK, never a
 * warning. The reason is the class of defect this repository has paid for
 * before: a guard that reports rather than refuses is a guard whose finding
 * ships. A package whose `SKILL.md` tells an agent to print one marker while its
 * script prints another is a package that produces evidence for a version it is
 * not.
 *
 * WHICH SHAPE IS EXPECTED IS AN INPUT, NOT AN OBSERVATION. `executableStep`
 * comes from the manifest, through `shipsArrivalScript`, and the guard then
 * checks that what is in the package MATCHES it. Deciding the shape by looking
 * at whether the file happens to be there would make the guard agree with
 * whatever it found: a script that failed to be generated would silently demote
 * a three-place check to a two-place one, and the missing script — the whole
 * failure — would be the thing that excused not looking for it.
 */
export function checkArrivalIdentity(
  files: PackageFiles,
  skillVersionId: string,
  opts: { executableStep: boolean },
): ArrivalIdentity {
  const expected = arrivalMarker(skillVersionId);
  const places: 2 | 3 = opts.executableStep ? 3 : 2;
  const skillMdBytes = files.get("SKILL.md");
  const scriptBytes = files.get(ARRIVAL_SCRIPT_PATH);
  const inSkillMd = skillMdBytes ? markerInSkillMd(skillMdBytes.toString("utf8")) : null;
  const inScript = scriptBytes ? markerInArrivalScript(scriptBytes.toString("utf8")) : null;

  const fail = (reason: string): ArrivalIdentity => ({
    ok: false,
    places,
    expected,
    in_skill_md: inSkillMd,
    in_script: inScript,
    reason,
  });

  // ---- place 1: SKILL.md, which every version has, `["none"]` included
  if (!skillMdBytes) return fail("SKILL.md is missing from the package");
  if (inSkillMd === null) {
    return fail("SKILL.md carries no generated arrival block with exactly one marker");
  }
  if (inSkillMd !== expected) {
    return fail(`SKILL.md's marker ${inSkillMd} is not the marker ${skillVersionId} derives`);
  }

  // ---- the package must have the shape the manifest declared
  if (!opts.executableStep) {
    if (scriptBytes) {
      return fail(
        `${ARRIVAL_SCRIPT_PATH} is present although the manifest declares runtime.shell ["none"] — a package that says it needs no shell is not handed one`,
      );
    }
    return { ok: true, places, expected, in_skill_md: inSkillMd, in_script: null, reason: null };
  }
  if (!scriptBytes) return fail(`${ARRIVAL_SCRIPT_PATH} is missing from the package`);

  // ---- place 3: the script, for every version that declares a shell
  if (inScript === null) {
    return fail(`${ARRIVAL_SCRIPT_PATH} prints no arrival marker, or prints more than one`);
  }
  if (inScript !== expected) {
    return fail(`${ARRIVAL_SCRIPT_PATH}'s marker ${inScript} is not the marker ${skillVersionId} derives`);
  }
  // and the script must name the version it belongs to, or a reader holding
  // only the script cannot say WHICH version arrived
  if (!scriptBytes.toString("utf8").includes(skillVersionId)) {
    return fail(`${ARRIVAL_SCRIPT_PATH} does not print the skill version id it belongs to`);
  }
  return { ok: true, places, expected, in_skill_md: inSkillMd, in_script: inScript, reason: null };
}
