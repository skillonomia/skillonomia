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

/** The generated `SKILL.md` region, marker delimiters included. */
export function renderArrivalBlock(skillVersionId: string): string {
  const marker = arrivalMarker(skillVersionId);
  return [
    ARRIVAL_BLOCK_BEGIN,
    "<!-- generated by the Skillonomia registry at packing time; edits are replaced -->",
    "",
    `1. **Run the arrival step first:** \`./${ARRIVAL_SCRIPT_PATH}\``,
    "",
    `   It prints this version's arrival marker \`${marker}\` and the skill`,
    `   version id \`${skillVersionId}\`. Nothing later in this procedure depends`,
    "   on it. It exists so that a run leaves a record: without one, SPEC §5",
    "   reports this version as **unknown**, and never as **not run**.",
    "",
    ARRIVAL_BLOCK_END,
  ].join("\n");
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
export function embedArrivalStep(skillMd: string, skillVersionId: string): string {
  const block = renderArrivalBlock(skillVersionId);
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
 * One record of a runtime transcript, reduced to the two things §5 needs of it.
 *
 * `role` distinguishes the record that ASKED for something from the record that
 * REPORTED what happened. [M-5] counts a version as invoked only on a PAIR, and
 * a shape that cannot tell a call from an output cannot express that rule.
 */
export interface ArrivalRecord {
  role: "call" | "output";
  /** the record's text, as a record — never a path to one */
  text: string;
}

/** [I-1]: three answers, and the third is the default. `"no"` is not a value
 *  this function can return, because nothing observable can establish it. */
export type ArrivalVerdict = "yes" | "unknown";

/**
 * [M-5]: `yes` iff SOME call record and SOME output record BOTH carry this
 * version's marker. Anything else — no records, only a call, only an output, a
 * marker belonging to a different version — is `unknown`.
 *
 * The asymmetry is the whole point. A call alone says an agent tried; an output
 * alone can be anything that quoted a marker. Only the pair says the step ran
 * and the runtime saw it finish, and only that pair is evidence.
 */
export function arrivalVerdict(records: Iterable<ArrivalRecord>, marker: string): ArrivalVerdict {
  if (!MARKER_RE.test(marker)) return "unknown";
  let call = false;
  let output = false;
  for (const record of records) {
    if (!record || typeof record.text !== "string") continue;
    if (!markersIn(record.text).includes(marker)) continue;
    if (record.role === "call") call = true;
    else if (record.role === "output") output = true;
    if (call && output) return "yes";
  }
  return "unknown";
}

// ------------------------------------------------------------------- guard

export interface ArrivalIdentity {
  ok: boolean;
  /** the marker `skill_version_id` derives — the value the other two must equal */
  expected: string;
  /** what `SKILL.md`'s generated block carries, or null when it has none */
  in_skill_md: string | null;
  /** what the generated script prints, or null when the file is absent */
  in_script: string | null;
  /** why the identity failed; null when it held */
  reason: string | null;
}

/**
 * D-1's PACKING GUARD: the identity of THREE values.
 *
 *   marker in SKILL.md  =  marker in scripts/skln-arrive.sh  =  marker derived
 *   from the skill version id
 *
 * Any disagreement — including an absent block or an absent script — is a
 * REFUSAL TO PACK, never a warning. The reason is the class of defect this
 * repository has paid for before: a guard that reports rather than refuses is a
 * guard whose finding ships. A package whose `SKILL.md` tells an agent to print
 * one marker while its script prints another is a package that produces
 * evidence for a version it is not.
 */
export function checkArrivalIdentity(files: PackageFiles, skillVersionId: string): ArrivalIdentity {
  const expected = arrivalMarker(skillVersionId);
  const skillMdBytes = files.get("SKILL.md");
  const scriptBytes = files.get(ARRIVAL_SCRIPT_PATH);
  const inSkillMd = skillMdBytes ? markerInSkillMd(skillMdBytes.toString("utf8")) : null;
  const inScript = scriptBytes ? markerInArrivalScript(scriptBytes.toString("utf8")) : null;

  const fail = (reason: string): ArrivalIdentity => ({
    ok: false,
    expected,
    in_skill_md: inSkillMd,
    in_script: inScript,
    reason,
  });

  if (!skillMdBytes) return fail("SKILL.md is missing from the package");
  if (!scriptBytes) return fail(`${ARRIVAL_SCRIPT_PATH} is missing from the package`);
  if (inSkillMd === null) {
    return fail("SKILL.md carries no generated arrival block with exactly one marker");
  }
  if (inScript === null) {
    return fail(`${ARRIVAL_SCRIPT_PATH} prints no arrival marker, or prints more than one`);
  }
  if (inSkillMd !== expected) {
    return fail(`SKILL.md's marker ${inSkillMd} is not the marker ${skillVersionId} derives`);
  }
  if (inScript !== expected) {
    return fail(`${ARRIVAL_SCRIPT_PATH}'s marker ${inScript} is not the marker ${skillVersionId} derives`);
  }
  // and the script must name the version it belongs to, or a reader holding
  // only the script cannot say WHICH version arrived
  if (!scriptBytes.toString("utf8").includes(skillVersionId)) {
    return fail(`${ARRIVAL_SCRIPT_PATH} does not print the skill version id it belongs to`);
  }
  return { ok: true, expected, in_skill_md: inSkillMd, in_script: inScript, reason: null };
}
