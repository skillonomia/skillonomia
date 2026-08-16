// V1 P1 — THE SKILLABILITY CLASSIFIER: what KIND of thing did somebody capture?
//
// The loop starts with an owner or an agent saying "make this a skill", and
// most of what gets said that about is not one. It is a fact to remember, a
// standing rule, a job that should run on a schedule, a credential binding to
// some external service, a set of skills to load together, or a thing that was
// only ever going to be done once. V1 carries exactly one of those seven kinds
// — a REUSABLE PROCEDURE — and the contract is explicit that the other six must
// not be dressed up as skills.
//
// So this module answers with a CATEGORY, a boolean and a REASON CODE, all
// machine-readable, plus the signals it fired on so that a person can see why.
// It is a rule table and not a model: every decision here is reproducible from
// the text and the table below, which is what lets the same capture classify
// the same way tomorrow and what makes a wrong answer a fixable rule rather
// than a retraining job.
//
// WHAT IT DOES NOT CLAIM. It is not a general intent classifier and cannot be:
// English has more ways to describe a scheduled job than any marker table
// enumerates. What it delivers is narrower and checkable — a capture that
// carries the markers of one kind is routed to that kind, a capture that
// carries the markers of two is `ambiguous` rather than a guess between them,
// and a capture with no procedure in it never becomes a draft. `ambiguous` is a
// real answer with its own reason code, not a failure to have one.
export const SKILL_CATEGORIES = [
  "reusable_procedure",
  "memory",
  "rule",
  "automation",
  "connector",
  "loadout",
  "one_off",
  "ambiguous",
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** The categories a marker table can vote for. `ambiguous` is what the count
 *  produces, never what a marker asserts. */
export const CLASSIFIED_CATEGORIES = SKILL_CATEGORIES.filter((c) => c !== "ambiguous");

export const CLASSIFIER_VERSION = "skln-classify-1";

export interface ClassifierSignal {
  category: SkillCategory;
  /** the marker's id — a name from the table below, never matched text */
  marker: string;
  /** 1-based line of the redacted source the marker fired on */
  line: number;
}

export interface Classification {
  category: SkillCategory;
  skillable: boolean;
  reason_code: string;
  reason: string;
  /** why this capture is not carried as a skill, when it is not. Never a
   *  destination: V1 has no memory store, rule store or automation store to
   *  route to, and naming one would be an invention. */
  routing_reason: string | null;
  signals: ClassifierSignal[];
  scores: Record<string, number>;
  step_count: number;
  classifier_version: string;
}

interface Marker {
  id: string;
  category: Exclude<SkillCategory, "ambiguous">;
  re: RegExp;
}

/**
 * THE MARKER TABLE. One row per recognisable phrase-class, and the id is what a
 * signal reports, so a reader of a refusal sees which words produced it.
 *
 * The procedure rows are markers of REUSE — a document that lists steps is not
 * yet a skill, and the gate on step count below is what separates the two.
 */
const MARKERS: readonly Marker[] = [
  // --- reusable procedure
  { id: "procedure_heading", category: "reusable_procedure", re: /^#{1,6}\s*(?:procedure|steps|how to|instructions|workflow)\b/im },
  { id: "reuse_phrase", category: "reusable_procedure", re: /\b(?:whenever|every time|each time|any time you|next time)\b/i },
  { id: "repeatable_phrase", category: "reusable_procedure", re: /\b(?:reusable|repeatable|runbook|checklist|standard procedure|standard operating)\b/i },
  { id: "inputs_heading", category: "reusable_procedure", re: /^#{1,6}\s*(?:inputs?|parameters?|arguments?)\b/im },
  { id: "outputs_heading", category: "reusable_procedure", re: /^#{1,6}\s*(?:outputs?|result|deliverable)\b/im },
  { id: "failure_heading", category: "reusable_procedure", re: /^#{1,6}\s*(?:failure modes?|failures?|troubleshooting|when it fails)\b/im },
  // --- memory: a fact to hold, with nothing to do
  { id: "remember_phrase", category: "memory", re: /\b(?:remember that|remember this|keep in mind that|note that|for future reference|don't forget that)\b/i },
  { id: "preference_phrase", category: "memory", re: /\b(?:my|our|the owner's|the team's)\s+(?:preference|preferred|favourite|favorite|timezone|email|handle|address)\b/i },
  { id: "fact_statement", category: "memory", re: /^\s*(?:fact|context|background|note)\s*:/im },
  { id: "identity_statement", category: "memory", re: /\b(?:i am|we are|the project is|the stack is|the repo is)\b[^.\n]{0,80}\b(?:called|named|at)\b/i },
  // --- rule: a constraint on behaviour, not a sequence of actions
  { id: "prohibition_phrase", category: "rule", re: /\b(?:never|do not ever|must not|are forbidden|is forbidden|under no circumstances)\b/i },
  { id: "obligation_phrase", category: "rule", re: /\b(?:always|must always|is required to|shall always)\b/i },
  { id: "policy_word", category: "rule", re: /\b(?:policy|convention|guideline|house style|coding standard|ground rule)\b/i },
  { id: "rule_heading", category: "rule", re: /^#{1,6}\s*(?:rules?|policy|policies|conventions?)\b/im },
  // --- automation: something that should run without being asked
  { id: "schedule_phrase", category: "automation", re: /\b(?:every (?:day|morning|night|hour|week|monday|friday)|daily at|nightly|hourly|weekly at|at \d{1,2}(?::\d{2})?\s*(?:am|pm)\b)/i },
  { id: "cron_expression", category: "automation", re: /\b(?:cron|crontab)\b|^\s*[*\d/,-]+\s+[*\d/,-]+\s+[*\d/,-]+\s+[*\d/,-]+\s+[*\d/,-]+\s*$/im },
  { id: "trigger_phrase", category: "automation", re: /\b(?:trigger(?:ed)? (?:when|on)|on every (?:push|commit|merge|deploy)|whenever a (?:webhook|event) (?:arrives|fires)|automatically run)\b/i },
  { id: "automation_word", category: "automation", re: /\b(?:scheduled job|background job|automation|watcher|poller)\b/i },
  // --- connector: a binding to an external system and its credentials
  { id: "credential_binding", category: "connector", re: /\b(?:api key|access token|oauth|client id|client secret|service account|personal access token)\b/i },
  { id: "connect_phrase", category: "connector", re: /\b(?:connect (?:to|our|the)|integrate with|set up (?:access|an integration)|authenticate (?:to|with|against))\b/i },
  { id: "endpoint_word", category: "connector", re: /\b(?:base url|endpoint|webhook url|api host|tenant id)\b/i },
  { id: "connector_heading", category: "connector", re: /^#{1,6}\s*(?:connection|credentials?|integration|connector)\b/im },
  // --- loadout: which capabilities a session should carry
  { id: "loadout_phrase", category: "loadout", re: /\b(?:load (?:these|the following) skills|session preset|skill set|toolset|enable (?:these|the following) (?:skills|tools))\b/i },
  { id: "bundle_phrase", category: "loadout", re: /\b(?:bundle (?:of|these) (?:skills|capabilities)|profile of skills|always load)\b/i },
  { id: "loadout_heading", category: "loadout", re: /^#{1,6}\s*(?:loadout|preset|session profile)\b/im },
  // --- one-off: bounded to a single occasion
  { id: "one_off_phrase", category: "one_off", re: /\b(?:one[- ]off|just this once|only this time|ad hoc|throwaway|quick and dirty)\b/i },
  { id: "single_occasion", category: "one_off", re: /\b(?:for (?:today|this ticket|this incident|this release|this PR)|before the demo tomorrow)\b/i },
  { id: "incident_reference", category: "one_off", re: /\b(?:incident|ticket|issue)\s*#?\s*[A-Z]{0,6}-?\d{2,}\b/ },
];

/** A step: a numbered line, or a bulleted line that begins with a verb. The
 *  bulleted form is deliberately narrow — a bullet list of nouns is not a
 *  procedure, and treating it as one is how a memory becomes a "skill". */
const NUMBERED_STEP = /^\s*(?:\d+[.)]|step\s+\d+\s*[:.)])\s+\S/i;
const BULLET_STEP = /^\s*[-*+]\s+(?:[a-z]+)\b/i;
const IMPERATIVE = /^(?:run|open|read|write|check|verify|copy|create|delete|remove|install|build|deploy|commit|push|pull|start|stop|restart|set|export|call|send|apply|update|record|collect|compare|export|extract|clone|fetch|merge|rename|replace|scan|search|split|store|tag|test|walk|wait|add|append|assert|attach|close|configure|confirm|connect|convert|download|edit|enable|ensure|execute|generate|grant|list|load|log|make|move|note|paste|prepare|print|publish|reset|resolve|restore|review|revoke|save|select|show|sign|sort|submit|switch|sync|take|trim|unpack|upload|use|validate)\b/i;

/** Every line the source presents as a step, in document order. */
export function stepLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    if (NUMBERED_STEP.test(line)) {
      out.push({ line: i + 1, text: line.replace(/^\s*(?:\d+[.)]|step\s+\d+\s*[:.)])\s+/i, "").trim() });
      return;
    }
    if (BULLET_STEP.test(line)) {
      const body = line.replace(/^\s*[-*+]\s+/, "").trim();
      if (IMPERATIVE.test(body)) out.push({ line: i + 1, text: body });
    }
  });
  return out;
}

function signalsOf(text: string): ClassifierSignal[] {
  const lines = text.split("\n");
  const found: ClassifierSignal[] = [];
  for (const marker of MARKERS) {
    // the whole-document match decides IF the marker fired; the line is found
    // by re-testing each line, so a signal always names a place
    const whole = new RegExp(marker.re.source, marker.re.flags.replace("m", ""));
    if (!marker.re.test(text)) continue;
    let at = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (whole.test(lines[i]!)) {
        at = i + 1;
        break;
      }
    }
    found.push({ category: marker.category, marker: marker.id, line: at });
  }
  return found;
}

const NOT_A_PROCEDURE: Readonly<Record<string, string>> = {
  memory: "NOT_A_PROCEDURE_MEMORY",
  rule: "NOT_A_PROCEDURE_RULE",
  automation: "NOT_A_PROCEDURE_AUTOMATION",
  connector: "NOT_A_PROCEDURE_CONNECTOR",
  loadout: "NOT_A_PROCEDURE_LOADOUT",
  one_off: "NOT_A_PROCEDURE_ONE_OFF",
};

const ROUTING: Readonly<Record<string, string>> = {
  memory: "this is a fact to hold, not a procedure to repeat: V1 carries reusable procedures only and has no memory store to route it to",
  rule: "this is a standing constraint on behaviour rather than a sequence of actions: V1 carries reusable procedures only and has no rule store to route it to",
  automation: "this describes work that should run on a schedule or a trigger: V1 carries reusable procedures only and has no automation store to route it to",
  connector: "this binds an external system and its credentials: V1 carries reusable procedures only and has no connector store to route it to",
  loadout: "this selects which capabilities a session should carry, which is an assignment decision and not a skill: V1 carries reusable procedures only",
  one_off: "this is bounded to a single occasion, so there is nothing to reuse: V1 carries reusable procedures only",
};

/** The minimum a procedure is: two steps. One step is an instruction. */
export const MINIMUM_STEPS = 2;

/**
 * Classify one redacted capture.
 *
 * The rule, in full:
 *
 *   * each category scores the number of DISTINCT markers of its own that
 *     fired — occurrences do not accumulate, so a document repeating one phrase
 *     six times does not outvote one carrying six different markers;
 *   * `reusable_procedure` scores zero unless the source presents at least
 *     `MINIMUM_STEPS` steps. A document about repetition with nothing to repeat
 *     is not a procedure;
 *   * the winner is the STRICT maximum. A tie is `ambiguous`, with both
 *     candidates in the signals, because choosing between two equally supported
 *     readings is guessing;
 *   * no signal at all is `ambiguous` too, with its own reason code: an empty
 *     answer and a contested one are different states and are reported as such.
 */
export function classify(text: string): Classification {
  const signals = signalsOf(text);
  const steps = stepLines(text);
  const scores: Record<string, number> = {};
  for (const category of CLASSIFIED_CATEGORIES) {
    scores[category] = signals.filter((s) => s.category === category).length;
  }
  if (steps.length < MINIMUM_STEPS) scores.reusable_procedure = 0;

  const ranked = [...CLASSIFIED_CATEGORIES].sort((a, b) => scores[b]! - scores[a]!);
  const top = ranked[0]!;
  const best = scores[top]!;
  const contenders = CLASSIFIED_CATEGORIES.filter((c) => scores[c] === best);

  const base = {
    signals,
    scores,
    step_count: steps.length,
    classifier_version: CLASSIFIER_VERSION,
  };

  if (text.trim().length === 0) {
    return {
      ...base,
      category: "ambiguous",
      skillable: false,
      reason_code: "EMPTY_SOURCE",
      reason: "the capture carried no text to classify",
      routing_reason: "there is nothing here to route",
    };
  }
  if (best === 0) {
    return {
      ...base,
      category: "ambiguous",
      skillable: false,
      reason_code: "NO_SIGNALS",
      reason:
        "nothing in this capture identifies it as a procedure, a fact, a rule, a scheduled job, a connection or a session loadout",
      routing_reason: "the kind of thing this is could not be established, so it is not carried as a skill",
    };
  }
  if (contenders.length > 1) {
    return {
      ...base,
      category: "ambiguous",
      skillable: false,
      reason_code: "AMBIGUOUS_SIGNALS",
      reason: `this capture carries equally strong markers of ${contenders.join(" and ")}, and choosing between them would be a guess`,
      routing_reason: "an ambiguous capture is refused rather than filed under one of the readings",
    };
  }
  if (top === "reusable_procedure") {
    return {
      ...base,
      category: "reusable_procedure",
      skillable: true,
      reason_code: "REUSABLE_PROCEDURE",
      reason: `the source presents ${steps.length} steps and the markers of a procedure meant to be run again`,
      routing_reason: null,
    };
  }
  return {
    ...base,
    category: top,
    skillable: false,
    reason_code: NOT_A_PROCEDURE[top]!,
    reason: `the markers of a ${top.replace("_", " ")} outweigh those of a reusable procedure`,
    routing_reason: ROUTING[top]!,
  };
}
