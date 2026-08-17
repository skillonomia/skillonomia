#!/usr/bin/env node
// `P6-FR-17` — THE ABSENCE OF THE MANUAL STEPS, MEASURED.
//
//   node --experimental-strip-types --no-warnings v1/tools/p6-clean-room-check.ts <journal.jsonl>
//
// `v1/tools/e2e/clean-room-journey.mjs` writes one JSON object per line for every
// act of every actor in the clean-room journey: who acted, over what transport,
// on what surface, what they typed, what HTTP their client made, whether any of
// it carried a credential, and which server-confirmed identifier came back. This
// reads that journal and answers two questions, both of which have to be yes:
//
//   1. IS THE JOURNEY THERE, IN FULL AND IN ORDER? `P6-FR-10` … `P6-FR-16`. A
//      journal with no forbidden step in it proves nothing if it also has no
//      journey in it — an empty file would otherwise pass, which is the failure
//      mode this half exists to close. Every required owner act must be present,
//      in the contract's order, and must carry a server-confirmed identifier: an
//      act nobody's registry answered is a claim, not a step.
//
//   2. DID ANY FORBIDDEN STEP APPEAR? `INV-09` and `P6-FR-17`: no hand-written
//      manifest, no package, no JSON payload, no database row, no API key
//      handling by the owner, no signature, no unpacking, no runtime config
//      edit. Four independent detectors, because one is one bug away from
//      silence:
//
//        * TRANSPORT — an owner has exactly two, `agent_session_text` and
//          `browser_ui`. A terminal, an editor or a database client appearing
//          under `actor: owner` is a forbidden step whatever it typed.
//        * CREDENTIAL — no owner request may carry an `Authorization` header,
//          and the browser-wide scan must have found no key in storage or in a
//          readable cookie. The one credential an owner may hold is the one-time
//          console ticket, and only if the deployment minted it: the two records
//          carry the same digest, so a ticket the owner invented is not one.
//        * CONTENT — what the owner TYPED is searched for the artefacts INV-09
//          names: a JSON document, a manifest, PEM or signature material, an API
//          key, SQL or a sqlite invocation, an unpack command, a runtime config
//          path.
//        * FILESYSTEM — an owner act that wrote a file is a forbidden step. The
//          owner of this journey has a browser and a sentence; a file write is
//          somebody hand-making an artefact.
//
// WHAT IT DOES NOT CLAIM. It reads a journal a harness wrote, so it is exactly
// as good as that harness's honesty about its own acts — which is why the gate
// runs it against a `--manual-owner` journey whose owner DOES all three
// forbidden things, and requires this file to refuse that one. A checker nobody
// has seen refuse is a checker nobody has tested.
//
// AND THE PICTURES, WHICH ARE MANDATORY EVIDENCE AND NOT DECORATION. Contract
// section 10's P6 list names a clean-room walkthrough WITH SCREENSHOTS and
// correlating backend/runtime receipts; section 9 refuses screenshots no receipt
// corroborates and section 8.1 refuses prose in place of an absent mandatory
// artifact. So a third question is asked here, and a journal that answers the
// first two and not this one does not pass:
//
//   3. IS EVERY REQUIRED STATE PHOTOGRAPHED, AND DOES EACH IMAGE RESOLVE? The
//      six states are the ones the journey already asserts. For each, the
//      manifest must name an image that EXISTS and whose bytes hash to what it
//      claims, the rendered text of that same page, and the registry-issued
//      identifiers the state was built from — every one of which must be found
//      HERE, by this file, in that text or in nothing at all. The digests and
//      the text search are recomputed rather than believed: a manifest that
//      described a picture nobody took would otherwise pass.
//
//   AND NOTHING SENSITIVE IN THE FRAME. The image bytes and the rendered text
//   are swept for the credential shapes this system mints. The owner holds no
//   key and the console cookie is HttpOnly, so this is expected to be true —
//   which is exactly why it is measured instead of assumed.
//
// EXIT: 0 the journey is whole and clean · 1 it is not · 2 REFUSED (no journal).
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

const path = process.argv[2];
if (!path) {
  console.error("REFUSED: usage: p6-clean-room-check.ts <journal.jsonl> [screenshots.json]");
  process.exit(2);
}
let lines: string[];
try {
  lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
} catch (e) {
  console.error(`REFUSED: the journal ${path} could not be read: ${(e as Error).message}`);
  process.exit(2);
}
if (lines.length === 0) {
  console.error(`REFUSED: the journal ${path} is empty`);
  process.exit(2);
}

interface Act {
  seq: number;
  actor: string;
  act: string;
  transport: string;
  surface?: string;
  description?: string;
  typed_text?: string;
  file_write?: string;
  credential_class?: string;
  ticket_sha256?: string;
  backend?: Record<string, unknown>;
  http?: { method: string; path: string; status: number; authorization?: boolean }[];
  authorization_headers?: number;
  credential_in_browser?: boolean;
  cookies?: string[];
  [k: string]: unknown;
}

const acts: Act[] = [];
for (const [i, line] of lines.entries()) {
  try {
    acts.push(JSON.parse(line) as Act);
  } catch {
    console.error(`REFUSED: line ${i + 1} of the journal is not JSON`);
    process.exit(2);
  }
}

const failures: string[] = [];
const notes: string[] = [];
function fail(what: string): void {
  failures.push(what);
  console.log(`FAIL  ${what}`);
}
function pass(what: string, detail = ""): void {
  console.log(`ok    ${what}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------- 1. the journey
//
// The order is the contract's: `P6-FR-10` through `P6-FR-16` in the sequence
// section 10 writes them, plus the sign-in that has to happen before an owner
// can see anything.

const REQUIRED: { act: string; requirement: string; needsBackend: boolean }[] = [
  { act: "natural_instruction", requirement: "P6-FR-10", needsBackend: false },
  { act: "sign_in", requirement: "P6-FR-11", needsBackend: true },
  { act: "read_draft_preview", requirement: "P6-FR-11", needsBackend: true },
  { act: "edit_procedure", requirement: "P6-FR-12", needsBackend: true },
  { act: "approve_revision", requirement: "P6-FR-12", needsBackend: true },
  { act: "assign_revision", requirement: "P6-FR-13", needsBackend: true },
  { act: "activate_assignment", requirement: "P6-FR-13", needsBackend: true },
  { act: "read_session_stages", requirement: "P6-FR-14", needsBackend: true },
  { act: "create_new_revision", requirement: "P6-FR-15", needsBackend: true },
  { act: "approve_new_revision", requirement: "P6-FR-15", needsBackend: true },
  { act: "apply_new_revision", requirement: "P6-FR-15", needsBackend: true },
  { act: "read_new_session_stages", requirement: "P6-FR-15", needsBackend: true },
  { act: "prepare_rollback", requirement: "P6-FR-16", needsBackend: true },
  { act: "confirm_rollback", requirement: "P6-FR-16", needsBackend: true },
  { act: "read_rollback_session", requirement: "P6-FR-16", needsBackend: true },
];

const ownerActs = acts.filter((a) => a.actor === "owner");
let cursor = -1;
for (const step of REQUIRED) {
  const at = ownerActs.findIndex((a, i) => i > cursor && a.act === step.act);
  if (at < 0) {
    fail(`${step.requirement}: the owner act \`${step.act}\` is not in the journal after the step before it`);
    continue;
  }
  cursor = at;
  const act = ownerActs[at]!;
  if (step.needsBackend && (!act.backend || Object.keys(act.backend).length === 0)) {
    fail(`${step.requirement}: the owner act \`${step.act}\` carries no server-confirmed identifier`);
  }
}
if (failures.length === 0) pass(`the whole journey is in the journal, in order — ${REQUIRED.length} owner acts`);

// The journey must also have ENDED. A run killed halfway would otherwise leave a
// journal whose every present act is clean.
if (!acts.some((a) => a.act === "journey_ends")) fail("the journal does not record the journey ending; it is a partial run");
if (!acts.some((a) => a.act === "journey_begins")) fail("the journal does not record the journey beginning");

// ---------------------------------------------------------------- 2. transports

const OWNER_TRANSPORTS = new Set(["agent_session_text", "browser_ui"]);
for (const act of ownerActs) {
  if (!OWNER_TRANSPORTS.has(act.transport)) {
    fail(
      `P6-FR-17 / INV-09: the owner act \`${act.act}\` (seq ${act.seq}) used the transport \`${act.transport}\` ` +
        `on \`${act.surface ?? "—"}\`; an owner has only a browser and a sentence`,
    );
  }
}
if (!failures.some((f) => f.includes("the transport"))) pass(`every owner act used a browser or a sentence — ${ownerActs.length} acts`);

// ---------------------------------------------------------------- 3. credentials

let authorizedRequests = 0;
for (const act of ownerActs) {
  for (const ex of act.http ?? []) {
    if (ex.authorization) {
      authorizedRequests += 1;
      fail(
        `P6-FR-17 / INV-04: the owner act \`${act.act}\` (seq ${act.seq}) sent ${ex.method} ${ex.path} ` +
          `with a credential of its own`,
      );
    }
  }
}
if (authorizedRequests === 0) pass("no request an owner act made carried a credential");

const scan = acts.find((a) => a.act === "credential_scan");
if (!scan) {
  fail("INV-04: the journal carries no credential scan of the browser the owner used");
} else {
  if (scan.credential_in_browser === true) fail("INV-04: a key reached the browser's storage or a readable cookie");
  if ((scan.authorization_headers ?? 0) > 0) {
    fail(`INV-04: ${scan.authorization_headers} requests from the owner's browser carried an Authorization header`);
  }
  if (scan.credential_in_browser === false && (scan.authorization_headers ?? 0) === 0) {
    pass("the browser-wide scan found no credential in storage, in a cookie or on the wire", (scan.cookies ?? []).join(", "));
  }
}

// The one credential an owner may hold: a one-time console ticket the DEPLOYMENT
// minted. Same digest in both records, or it is not the one they were handed.
const signIn = ownerActs.find((a) => a.act === "sign_in");
if (signIn) {
  if (signIn.credential_class !== "one_time_console_ticket") {
    fail(`P6-FR-17: the owner signed in with \`${signIn.credential_class ?? "an unnamed credential"}\``);
  } else {
    const minted = acts.find((a) => a.actor === "deployment" && a.act === "console_ticket_minted");
    if (!minted) fail("P6-FR-17: no deployment act minted the ticket the owner signed in with");
    else if (minted.ticket_sha256 !== signIn.ticket_sha256) {
      fail("P6-FR-17: the ticket the owner used is not the ticket the deployment minted");
    } else pass("the owner's only credential is the one-time ticket the deployment minted and handed them");
  }
}

// ---------------------------------------------------------------- 4. content

const FORBIDDEN_CONTENT: { name: string; requirement: string; test: (t: string) => boolean }[] = [
  {
    name: "a hand-written JSON payload",
    requirement: "INV-09 (JSON payload)",
    test: (t) => {
      const s = t.trim();
      if (!(s.startsWith("{") || s.startsWith("["))) return false;
      try {
        JSON.parse(s);
        return true;
      } catch {
        return false;
      }
    },
  },
  {
    name: "a manifest",
    requirement: "INV-09 (manifest)",
    test: (t) => /"?manifest_version"?\s*[:=]/i.test(t) || /"entries"\s*:\s*\[/.test(t),
  },
  {
    name: "signing material or a signature",
    requirement: "INV-09 (signing material)",
    test: (t) => /-----BEGIN [A-Z ]+-----/.test(t) || /\b(signature|signed_payload|private_key)\b\s*[:=]/i.test(t),
  },
  {
    name: "an API key",
    requirement: "INV-09 (API key)",
    test: (t) => /\b(api[_-]?key|bearer|authorization)\b\s*[:=]/i.test(t) || /\bskln_[A-Za-z0-9_-]{16,}/.test(t),
  },
  {
    name: "a database row written by hand",
    requirement: "INV-09 (SQLite rows)",
    test: (t) => /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(t) || /\bsqlite3?\b/i.test(t),
  },
  {
    name: "unpacking a package",
    requirement: "INV-09 (package / unpacking)",
    test: (t) => /\b(tar\s+-?[xz]|unzip|gunzip)\b/i.test(t) || /\.(tar|tgz|tar\.gz|zip)\b/i.test(t),
  },
  {
    name: "a runtime configuration edit",
    requirement: "INV-09 (runtime config)",
    test: (t) =>
      /\.codex\/|\.claude\/|codex\/config\.toml|claude_desktop_config|settings\.json/.test(t) ||
      /^\s*\[skills\]/m.test(t),
  },
];

let typedActs = 0;
for (const act of ownerActs) {
  const typed = typeof act.typed_text === "string" ? act.typed_text : null;
  if (typed === null) continue;
  typedActs += 1;
  for (const rule of FORBIDDEN_CONTENT) {
    if (rule.test(typed)) {
      fail(
        `P6-FR-17 / ${rule.requirement}: the owner act \`${act.act}\` (seq ${act.seq}) typed ${rule.name}: ` +
          `${JSON.stringify(typed.slice(0, 120))}`,
      );
    }
  }
}
if (!failures.some((f) => f.includes("typed"))) pass(`nothing the owner typed is a technical artefact — ${typedActs} typed acts read`);

// ---------------------------------------------------------------- 5. filesystem

let writes = 0;
for (const act of ownerActs) {
  if (typeof act.file_write === "string" && act.file_write.length > 0) {
    writes += 1;
    fail(`P6-FR-17 / INV-09: the owner act \`${act.act}\` (seq ${act.seq}) wrote the file ${act.file_write}`);
  }
}
if (writes === 0) pass("no owner act wrote a file");

// ---------------------------------------------------------------- 6. the screenshots
//
// The six states contract section 10's P6 evidence list requires to have been
// SEEN, keyed by the owner act that produced each one.

const REQUIRED_SHOTS: { act: string; requirement: string; must_show: string[] }[] = [
  { act: "read_draft_preview", requirement: "P6-FR-11", must_show: ["draft_id", "revision_id"] },
  { act: "approve_revision", requirement: "P6-FR-12", must_show: ["approved_revision_id"] },
  { act: "activate_assignment", requirement: "P6-FR-13", must_show: ["assignment_id", "desired_revision_id"] },
  {
    act: "read_session_stages",
    requirement: "P6-FR-14",
    must_show: ["session_id", "revision_id", "loaded_receipt_id", "invoked_receipt_id", "outcome_id"],
  },
  {
    act: "read_new_session_stages",
    requirement: "P6-FR-15",
    must_show: ["session_id", "revision_id", "invoked_receipt_id", "outcome_id"],
  },
  {
    act: "read_rollback_session",
    requirement: "P6-FR-16",
    must_show: ["session_id", "rolled_back_to_revision_id", "invoked_receipt_id"],
  },
];

/** The shapes `v1/tools/p0-secret-scan.sh` sweeps evidence for, applied here to
 *  the pixels and to the text they render — a scan of the package skips a PNG
 *  because it is binary, so the one place a credential in a frame can be caught
 *  is the place that made the frame. */
const CREDENTIAL_SHAPES: [string, RegExp][] = [
  ["a registry API key", /sk_[A-Za-z0-9_-]{16,}/],
  ["a bootstrap token", /bt_[A-Za-z0-9_-]{16,}/],
  ["an Authorization: Bearer header", /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i],
  ["a PEM private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

interface ShotEntry {
  image?: string;
  image_sha256?: string;
  rendered_text?: string;
  rendered_text_sha256?: string;
  act?: string;
  requirement?: string;
  identifiers?: { kind: string; value: string; where: string }[];
}

const manifestArg = process.argv[3];
const MANIFEST = manifestArg
  ? resolve(manifestArg)
  : join(dirname(resolve(path)), "screenshots", "screenshots.json");

// THE IMAGES ARE RESOLVED AGAINST THE MANIFEST'S OWN DIRECTORY, ALWAYS. The
// manifest records the absolute directory the run wrote to, and that value is
// kept because it says where the pictures were made — but it is NOT what is
// read. A package that has been preserved into an evidence directory would
// otherwise send this checker back to the run's temporary work area to verify
// itself, and the copy nobody read would be the copy the reviewer has.
let shots: ShotEntry[] = [];
const shotDir = dirname(MANIFEST);
if (!existsSync(MANIFEST)) {
  fail(
    `P6 mandatory evidence: no screenshot manifest at ${MANIFEST}. Contract section 10's P6 list requires a ` +
      "clean-room walkthrough WITH screenshots and correlating receipts, and section 8.1 forbids replacing an " +
      "absent mandatory artifact with prose about it.",
  );
} else {
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST, "utf8")) as { screenshots?: ShotEntry[]; directory?: string };
    shots = Array.isArray(parsed.screenshots) ? parsed.screenshots : [];
    if (parsed.directory && isAbsolute(parsed.directory) && parsed.directory !== shotDir) {
      notes.push(`the manifest was written by a run in ${parsed.directory}; it is being read where it now sits, ${shotDir}`);
    }
  } catch (e) {
    fail(`P6 mandatory evidence: the screenshot manifest ${MANIFEST} is not readable JSON — ${(e as Error).message}`);
  }
}

/** The journal must agree that these pictures were taken, or the manifest is a
 *  file somebody put beside a journal rather than a record of that run. */
const journalShots = new Map<string, Act>();
for (const a of acts) {
  if (a.act !== "screenshot_captured") continue;
  const s = (a.screenshot ?? {}) as { image?: string; act?: string };
  if (typeof s.image === "string") journalShots.set(s.image, a);
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
let verifiedShots = 0;
if (shots.length > 0) {
  for (const need of REQUIRED_SHOTS) {
    const entry = shots.find((s) => s.act === need.act);
    if (!entry) {
      fail(`${need.requirement}: no screenshot of the state the owner act \`${need.act}\` left on the screen`);
      continue;
    }
    const image = typeof entry.image === "string" ? entry.image : "";
    const imagePath = join(shotDir, image);
    if (!image || !existsSync(imagePath) || !statSync(imagePath).isFile()) {
      fail(`${need.requirement}: the manifest names the image "${image}" for \`${need.act}\` and no such file is there`);
      continue;
    }
    const bytes = readFileSync(imagePath);
    if (sha256(bytes) !== entry.image_sha256) {
      fail(`${need.requirement}: ${image} does not hash to the sha256 the manifest records for it`);
      continue;
    }
    if (bytes.length < 1024 || bytes.subarray(0, 8).toString("latin1") !== "\x89PNG\r\n\x1a\n") {
      fail(`${need.requirement}: ${image} is not a PNG of a rendered page (${bytes.length} bytes)`);
      continue;
    }
    const textName = typeof entry.rendered_text === "string" ? entry.rendered_text : "";
    const textPath = join(shotDir, textName);
    if (!textName || !existsSync(textPath)) {
      fail(`${need.requirement}: ${image} carries no rendered text beside it, so what it shows cannot be read back`);
      continue;
    }
    const text = readFileSync(textPath, "utf8");
    if (sha256(text) !== entry.rendered_text_sha256) {
      fail(`${need.requirement}: ${textName} does not hash to the sha256 the manifest records for it`);
      continue;
    }
    if (!journalShots.has(image)) {
      fail(`${need.requirement}: ${image} is in the manifest and the journal does not record it being taken`);
      continue;
    }

    // the correlation, recomputed: every identifier the manifest says is on the
    // screen must be IN THE TEXT THIS FILE JUST READ, and the identifiers the
    // requirement names must be among them.
    const declared = new Map<string, { value: string; where: string }>();
    for (const id of entry.identifiers ?? []) declared.set(id.kind, { value: id.value, where: id.where });
    let broken = 0;
    for (const [kind, { value, where }] of declared) {
      if (where === "visible_text" && !text.includes(value)) {
        fail(`${need.requirement}: ${image} claims ${kind}=${value} is on the screen and its rendered text does not contain it`);
        broken += 1;
      }
      if (where === "absent") {
        fail(`${need.requirement}: ${image} carries ${kind}=${value} nowhere on the page it photographs`);
        broken += 1;
      }
    }
    for (const kind of need.must_show) {
      if (!declared.has(kind)) {
        fail(`${need.requirement}: ${image} maps to no ${kind}; an image nobody can resolve against a receipt is a caption`);
        broken += 1;
      }
    }
    if ([...declared.values()].every((d) => d.where !== "visible_text")) {
      fail(`${need.requirement}: ${image} shows none of its identifiers as text a reader of the picture could check`);
      broken += 1;
    }

    // and nothing sensitive in the frame
    const haystack = `${bytes.toString("latin1")}\n${text}`;
    for (const [what, shape] of CREDENTIAL_SHAPES) {
      if (shape.test(haystack)) {
        fail(`${need.requirement}: ${image} or its rendered text carries ${what}`);
        broken += 1;
      }
    }
    if (broken === 0) verifiedShots += 1;
  }
  if (verifiedShots === REQUIRED_SHOTS.length) {
    pass(
      `all ${verifiedShots} required states are photographed, each image hashes as recorded, resolves against the ` +
        "registry's own identifiers and carries no credential",
    );
  }
  notes.push(`screenshots: ${shots.length} in ${shotDir}, manifest ${MANIFEST}`);
  for (const s of shots) {
    const shown = (s.identifiers ?? []).map((i) => `${i.kind}(${i.where})`).join(" ");
    notes.push(`  ${s.image} — ${s.requirement} ${s.act}: ${shown}`);
  }
}

// ---------------------------------------------------------------- 7. the boundary
//
// Not a refusal — a statement, so a reader of the evidence sees where the line
// between the owner and the deployment was drawn rather than having to infer it.

const byActor = new Map<string, number>();
for (const act of acts) byActor.set(act.actor, (byActor.get(act.actor) ?? 0) + 1);
notes.push(`acts by actor: ${[...byActor].map(([a, n]) => `${a}=${n}`).join(", ")}`);
for (const act of acts.filter((a) => a.actor === "deployment")) {
  notes.push(`deployment: ${act.act} — ${act.description ?? ""}`);
}

console.log();
for (const n of notes) console.log(`note  ${n}`);
console.log();
console.log(`journal: ${path}   lines: ${acts.length}   owner acts: ${ownerActs.length}   failures: ${failures.length}`);
if (failures.length > 0) {
  console.log();
  console.log("FAIL  the clean-room owner journey did not hold on this journal.");
  process.exit(1);
}
console.log();
console.log(
  "PASS  the whole journey is present, every owner act went through a browser or a sentence, " +
    "no owner act held a credential, typed a technical artefact or wrote a file.",
);
process.exit(0);
