// §4.2 compatibility match algorithm, and its V1 outcome set.
//
// §4.2, verbatim: the match has "two outcomes, `match` when every clause is met
// and `mismatch` when any clause is unmet; a `mismatch` is returned as a
// warning at `risk_level: low` and blocks adoption when `risk_level` is medium
// or high." Two outcomes, not three: there is no `partial`, here or in any API
// contract — Appendix H surface 7 answers `"result":"match"|"mismatch"` and
// nothing else.
//
// The §4.2 algorithm itself: `os`/`shell` = set membership; `runtime`/`model` =
// the adopter's {id,version} must satisfy at least one matcher's id+range;
// `tools` = every entry of Procedure `tools_used[]` must be satisfied by the
// adopter's `tools[]` (id match + range).
//
// Range syntax is the deterministic V1 subset — `*`/`x`/`any`, an exact
// version, and the comparator forms `>=` `>` `<=` `<` `=` plus `^`/`~`, whose
// bound may be partial and is zero-filled (`>=2.0` is `>=2.0.0`). A range this
// module cannot parse is treated as UNMET (deny-by-default, the same posture
// §7.1's gates take), never as a silent match — which is why a partial bound
// had to become parseable rather than stay a silent block.

export type CompatResult = "match" | "mismatch";

export interface CompatClause {
  clause: "os" | "shell" | "runtime" | "model" | "tools";
  met: boolean;
  detail: string;
}

export interface CompatOutcome {
  result: CompatResult;
  clauses: CompatClause[];
  /** the unmet clauses, in declaration order — empty iff result is `match` */
  unmet: string[];
}

interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(v: unknown): Version | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * The BOUND of a comparator form. Unlike the adopter's declared version — an
 * exact fact, and still required to carry all three components — a bound may be
 * written with one, two or three, and the missing ones are ZERO-FILLED: `>=2`
 * and `>=2.0` both mean `>=2.0.0`.
 *
 * This is the universal semver reading of a partial bound, and until it was
 * implemented a perfectly ordinary declaration turned into a BLOCK: an
 * unparseable range is unmet by §4.2's deny-by-default rule, and an unmet
 * clause blocks adoption at `risk_level` medium or high. The specification's
 * own example carried such a bound.
 *
 * The zero-fill happens BEFORE the form's rule, never after, so `~2` is `~2.0.0`
 * and fixes major and minor both. That is narrower than node-semver's reading of
 * `~2` and is stated in §4.2; a narrower range can only ever refuse an
 * adoption, never admit one it should not, which is the direction this profile
 * errs in everywhere else.
 */
export function parseBound(v: string): Version | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}

/** The §4.2 range grammar, as one regex: an optional operator and a bound. */
const RANGE_RE = /^(>=|<=|>|<|=|\^|~)?\s*(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * Is `range` a form of the §4.2 profile at all? A form outside the profile is
 * UNMET for every version, so "unmet" alone cannot tell an unsatisfied range
 * from an unreadable one — and the specification's own examples have to be
 * checkable against the grammar rather than against a lucky comparison.
 */
export function isRange(range: unknown): boolean {
  if (typeof range !== "string") return false;
  const r = range.trim();
  return r === "*" || r === "x" || r === "any" || RANGE_RE.test(r);
}

function cmp(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Does `version` satisfy `range`? Unparseable input on either side is `false`
 * — an unreadable constraint is not a satisfied one.
 */
export function satisfies(version: unknown, range: unknown): boolean {
  if (typeof range !== "string") return false;
  const r = range.trim();
  if (r === "*" || r === "x" || r === "any") return true;
  const v = parseVersion(version);
  if (!v) return false;

  const m = RANGE_RE.exec(r);
  if (!m) return false; // an unsupported range form is UNMET, never a match
  const bound = parseBound(m[2])!;
  switch (m[1] ?? "=") {
    case "=":
      return cmp(v, bound) === 0;
    case ">=":
      return cmp(v, bound) >= 0;
    case ">":
      return cmp(v, bound) > 0;
    case "<=":
      return cmp(v, bound) <= 0;
    case "<":
      return cmp(v, bound) < 0;
    case "^":
      // caret: same major (and, below 1.0.0, same minor), not below the bound
      if (cmp(v, bound) < 0) return false;
      if (bound.major > 0) return v.major === bound.major;
      return v.major === 0 && v.minor === bound.minor;
    case "~":
      return cmp(v, bound) >= 0 && v.major === bound.major && v.minor === bound.minor;
    default:
      return false;
  }
}

function matcherSatisfied(matchers: unknown, actor: { id?: unknown; version?: unknown } | undefined): boolean {
  if (!Array.isArray(matchers) || matchers.length === 0) return false;
  if (!actor || typeof actor.id !== "string") return false;
  return matchers.some(
    (m: any) => (m?.id === actor.id || m?.id === "any") && satisfies(actor.version, m?.range),
  );
}

/**
 * §4.2 match, evaluated clause by clause so a `mismatch` can name exactly which
 * clause was unmet — the adopter-facing warning and the medium/high block both
 * need that, and a bare boolean would make the block unexplainable.
 */
export function checkCompatibility(manifest: any, descriptor: any): CompatOutcome {
  const rt = manifest?.runtime ?? {};
  const clauses: CompatClause[] = [];

  const osList: unknown[] = Array.isArray(rt.os) ? rt.os : [];
  clauses.push({
    clause: "os",
    met: typeof descriptor?.os === "string" && osList.includes(descriptor.os),
    detail: `declared os [${osList.join(", ")}] vs adopter ${String(descriptor?.os)}`,
  });

  const shellList: unknown[] = Array.isArray(rt.shell) ? rt.shell : [];
  clauses.push({
    clause: "shell",
    met: typeof descriptor?.shell === "string" && shellList.includes(descriptor.shell),
    detail: `declared shell [${shellList.join(", ")}] vs adopter ${String(descriptor?.shell)}`,
  });

  clauses.push({
    clause: "runtime",
    met: matcherSatisfied(rt.runtime_compat, descriptor?.runtime),
    detail: `runtime_compat vs adopter ${String(descriptor?.runtime?.id)}@${String(descriptor?.runtime?.version)}`,
  });

  clauses.push({
    clause: "model",
    met: matcherSatisfied(rt.model_compat, descriptor?.model),
    detail: `model_compat vs adopter ${String(descriptor?.model?.id)}@${String(descriptor?.model?.version)}`,
  });

  // tools: EVERY declared `tools_used[]` entry must be satisfied by the
  // adopter's tools — this is the direction §4.2 fixes, and reversing it would
  // let an adopter with no tools at all adopt a tool-dependent package.
  const used: any[] = Array.isArray(manifest?.procedure?.tools_used) ? manifest.procedure.tools_used : [];
  const adopterTools: any[] = Array.isArray(descriptor?.tools) ? descriptor.tools : [];
  const missing = used.filter(
    (t) => !adopterTools.some((a) => (a?.id === t?.id || t?.id === "any") && satisfies(a?.version, t?.range)),
  );
  clauses.push({
    clause: "tools",
    met: missing.length === 0,
    detail: missing.length === 0 ? "every declared tool is present" : `unsatisfied tools: ${missing.map((t) => String(t?.id)).join(", ")}`,
  });

  const unmet = clauses.filter((c) => !c.met).map((c) => c.clause);
  return { result: unmet.length === 0 ? "match" : "mismatch", clauses, unmet };
}

/** §4.2: a mismatch blocks adoption at medium/high risk, warns at low. */
export function mismatchBlocks(riskLevel: unknown): boolean {
  return riskLevel === "medium" || riskLevel === "high";
}
