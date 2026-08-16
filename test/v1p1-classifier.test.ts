// V1 P1 — THE SKILLABILITY CLASSIFIER, ONE ROW PER CATEGORY.
//
// The contract's requirement is table-driven tests for EVERY category, and the
// table below is that: seven kinds a capture can be, plus the two states the
// counter itself produces — a contested answer and an empty one. A category
// with no row here is a category nothing exercises.
//
// What each row asserts is the whole answer, not merely the label: the
// machine-readable `category`, the boolean `skillable`, the structured
// `reason_code`, and — for everything that is not a procedure — a
// `routing_reason` that says why V1 does not carry it. `P1-FR-02` asks for the
// first three; `P1-FR-04` asks that the other six are not dressed up as skills,
// which is what the boolean and the code together deliver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASSIFIED_CATEGORIES, MINIMUM_STEPS, SKILL_CATEGORIES, classify, stepLines } from "../src/skillability.ts";

interface Row {
  what: string;
  text: string;
  category: string;
  skillable: boolean;
  reason_code: string;
}

const PROCEDURE = [
  "# Rotate the demo signing key",
  "",
  "## Procedure",
  "1. List the signing keys and note the active kid.",
  "2. Register the replacement key under a new kid.",
  "3. Revoke the retired kid once the replacement answers.",
  "",
  "Whenever the demo key is older than ninety days, run this.",
].join("\n");

const TABLE: readonly Row[] = [
  {
    what: "a reusable procedure — steps plus a statement that it recurs",
    text: PROCEDURE,
    category: "reusable_procedure",
    skillable: true,
    reason_code: "REUSABLE_PROCEDURE",
  },
  {
    what: "a memory — a fact to hold, with nothing to do",
    text: "Remember that the owner's preferred timezone is Europe/Berlin, and that the project is called Skillonomia.",
    category: "memory",
    skillable: false,
    reason_code: "NOT_A_PROCEDURE_MEMORY",
  },
  {
    what: "a rule — a standing constraint on behaviour",
    text: "Policy: never force-push to main. Always open a pull request, and follow the house style for commit messages.",
    category: "rule",
    skillable: false,
    reason_code: "NOT_A_PROCEDURE_RULE",
  },
  {
    what: "an automation — work that should run without being asked",
    text: "Every morning at 7am, cron should collect the overnight build logs and post the summary. Trigger when a deploy finishes.",
    category: "automation",
    skillable: false,
    reason_code: "NOT_A_PROCEDURE_AUTOMATION",
  },
  {
    what: "a connector — a binding to an external system",
    text: "Connect to the billing API: the base url is on the wiki, authenticate with an api key from the vault, using a service account and its client secret.",
    category: "connector",
    skillable: false,
    reason_code: "NOT_A_PROCEDURE_CONNECTOR",
  },
  {
    what: "a loadout — which capabilities a session should carry",
    text: "## Loadout\nLoad these skills for review sessions: the diff reader and the changelog writer. Always load that bundle of skills.",
    category: "loadout",
    skillable: false,
    reason_code: "NOT_A_PROCEDURE_LOADOUT",
  },
  {
    what: "a one-off — bounded to a single occasion",
    text: "One-off for this ticket: patch the config by hand for incident INC-4471, quick and dirty, before the demo tomorrow.",
    category: "one_off",
    skillable: false,
    reason_code: "NOT_A_PROCEDURE_ONE_OFF",
  },
  {
    what: "an empty capture",
    text: "   \n  \n",
    category: "ambiguous",
    skillable: false,
    reason_code: "EMPTY_SOURCE",
  },
  {
    what: "a capture with no marker of any kind",
    text: "the quick brown fox jumped over the lazy dog, and then sat down again",
    category: "ambiguous",
    skillable: false,
    reason_code: "NO_SIGNALS",
  },
  {
    what: "a capture carrying two readings equally strongly",
    text: [
      "Remember that the owner's preferred timezone is Europe/Berlin.",
      "Never deploy on a Friday, and always ask before a release.",
    ].join("\n"),
    category: "ambiguous",
    skillable: false,
    reason_code: "AMBIGUOUS_SIGNALS",
  },
];

test("the classifier answers every category with a machine-readable category, a boolean and a reason code", () => {
  for (const row of TABLE) {
    const out = classify(row.text);
    assert.equal(out.category, row.category, `${row.what}: category`);
    assert.equal(out.skillable, row.skillable, `${row.what}: skillable`);
    assert.equal(out.reason_code, row.reason_code, `${row.what}: reason_code`);
    assert.ok(out.reason.length > 0, `${row.what}: a reason a person can read`);
    assert.ok(
      (SKILL_CATEGORIES as readonly string[]).includes(out.category),
      `${row.what}: the category is one of the published set`,
    );
    assert.equal(typeof out.classifier_version, "string");
    if (row.skillable) {
      assert.equal(out.routing_reason, null, `${row.what}: a skill is routed nowhere else`);
    } else {
      assert.ok(
        typeof out.routing_reason === "string" && out.routing_reason.length > 0,
        `${row.what}: a refusal states why V1 does not carry it (P1-FR-04)`,
      );
    }
  }
});

test("every category of the published set is exercised by the table above", () => {
  const covered = new Set(TABLE.map((r) => r.category));
  assert.deepEqual(
    [...SKILL_CATEGORIES].filter((c) => !covered.has(c)),
    [],
    "a category with no row is a category nothing exercises",
  );
  // …and `ambiguous` is exercised in all three of its states, which is the one
  // that would otherwise be covered by a single row and look complete
  const ambiguous = TABLE.filter((r) => r.category === "ambiguous").map((r) => r.reason_code).sort();
  assert.deepEqual(ambiguous, ["AMBIGUOUS_SIGNALS", "EMPTY_SOURCE", "NO_SIGNALS"]);
});

test("no non-procedure category is ever `skillable`, and the six carry a routing reason each", () => {
  const nonProcedure = CLASSIFIED_CATEGORIES.filter((c) => c !== "reusable_procedure");
  assert.equal(nonProcedure.length, 6, "memory, rule, automation, connector, loadout and one-off");
  for (const category of nonProcedure) {
    const row = TABLE.find((r) => r.category === category);
    assert.ok(row, `${category} has a row`);
    const out = classify(row.text);
    assert.equal(out.skillable, false);
    assert.match(out.routing_reason ?? "", /V1 carries reusable procedures only/);
  }
});

test("a document about repetition with nothing to repeat is not a procedure", () => {
  // the reuse markers of the procedure row, with the steps removed
  const noSteps = "Whenever the demo key is older than ninety days, this runbook is the reusable procedure to follow.";
  assert.ok(stepLines(noSteps).length < MINIMUM_STEPS, "the fixture really has no steps");
  const out = classify(noSteps);
  assert.notEqual(out.category, "reusable_procedure", "markers of reuse are not a procedure on their own");
  assert.equal(out.skillable, false);
  assert.equal(out.scores.reusable_procedure, 0, "the step gate zeroes the procedure score outright");
});

test("one step is an instruction: the minimum is two", () => {
  const one = "## Procedure\n1. Run the build.\n\nWhenever the build is broken.";
  assert.equal(stepLines(one).length, 1);
  assert.equal(classify(one).skillable, false);

  const two = "## Procedure\n1. Run the build.\n2. Read the failing test.\n\nWhenever the build is broken.";
  assert.equal(stepLines(two).length, 2);
  assert.equal(classify(two).skillable, true);
});

test("the answer is deterministic: the same text classifies the same way every time", () => {
  for (const row of TABLE) {
    const first = classify(row.text);
    const second = classify(row.text);
    assert.deepEqual(second, first, `${row.what}: two calls, one answer`);
  }
});

test("a signal names the marker that fired and the line it fired on — never the matched text", () => {
  const out = classify(TABLE[1]!.text);
  assert.ok(out.signals.length > 0, "a refusal that fired on nothing would be unexplainable");
  for (const signal of out.signals) {
    assert.match(signal.marker, /^[a-z][a-z0-9_]*$/, "a marker id, not a phrase from the capture");
    assert.ok(Number.isInteger(signal.line) && signal.line >= 0);
    assert.ok(
      (SKILL_CATEGORIES as readonly string[]).includes(signal.category),
      "every signal votes for a published category",
    );
  }
});

test("a bulleted list of nouns is not a procedure, and a bulleted list of actions can be", () => {
  const nouns = "## Procedure\n- the build log\n- the changelog\n\nWhenever a release goes out.";
  assert.equal(stepLines(nouns).length, 0, "nouns are not steps");
  assert.equal(classify(nouns).skillable, false);

  const actions = "## Procedure\n- read the build log\n- update the changelog\n\nWhenever a release goes out.";
  assert.equal(stepLines(actions).length, 2);
  assert.equal(classify(actions).skillable, true);
});
