// THE WORDS THE DECISION SURFACES PUT ON THE PAGE — SHARED BY THE BUNDLE AND THE GATES.
//
// WHAT THIS FILE IS. `src/console-proofline.ts` holds the vocabulary of the
// READ surface. This file holds the vocabulary of the three surfaces where an
// owner DECIDES something: the Approval Inbox, the revocation flow and the
// webhook flow (SPEC.md section 6.4, SPEC.md section 6.5).
//
// WHY THE WORDS ARE CONSTANTS. The same reason `PROOFLINE_TEXT` gives, with one
// addition that matters more here: on a decision surface the words ARE the
// product. A button that says `Confirm` and a button that says
// `Revoke and replace version` start the same request and are not the same
// offer, because only one of them tells the person pressing it what object is
// affected, how far the effect reaches and what it costs. So the labels are
// declared once, here, and a gate compares the bytes on the page against these
// bytes rather than against a sentence somebody typed into a test.
//
// WHAT IT IS NOT. It decides nothing. Whether a control is offered at all is
// `eligibility.allowed`, computed by the server and rendered by the browser
// (INV-01, INV-02). This file supplies only the nouns.
//
// WHY THIS FILE HAS NO IMPORTS. It is bundled into the browser, exactly as
// `src/console-proofline.ts` is, and a `node:` import anywhere in its transitive
// graph would end up in a browser build or fail it.

// ===========================================================================
// The four exact human-decision labels (SPEC.md section 6.4)
// ===========================================================================

/**
 * THE FOUR LABELS, VERBATIM, KEYED BY THE TWO SERVER FIELDS THAT SELECT ONE.
 *
 * A TABLE AND NOT A BRANCH. The kind and the decision are values the server
 * sent; a chain of comparisons in the renderer would be the browser deciding
 * which act it is about, and this console does not decide (`INV-02`). A lookup
 * that misses yields `undefined`, and the renderer offers no control at all
 * rather than inventing a label for an act it does not recognise — a wrong
 * label on a consequential button is worse than a missing button, because the
 * missing button is visible.
 *
 * `review` is deliberately ABSENT from this table. A review verdict and a human
 * approval are different types and SPEC.md section 6.4 fixes these four words
 * for the human half only; the review words are `REVIEW_ACTION_LABELS` below and
 * they are not interchangeable with these.
 */
export const HUMAN_DECISION_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  adopt_high_risk: {
    approved: "Approve this adoption",
    denied: "Deny this adoption",
  },
  publish: {
    approved: "Approve publication",
    denied: "Deny publication",
  },
};

/** The same four, flat, so a gate can assert every one of them reached a page
 *  without walking the table and reproducing its shape in the assertion. */
export const HUMAN_DECISION_LABEL_LIST: readonly string[] = [
  "Approve this adoption",
  "Deny this adoption",
  "Approve publication",
  "Deny publication",
];

/**
 * THE LABELS THAT MAY NOT BE THE PRIMARY CONTROL OF A CONSEQUENTIAL ACTION.
 *
 * SPEC.md section 6.4 forbids them and the reason is not style. `Confirm` names
 * no object, no scope and no consequence: it is a button whose meaning is
 * whatever the sentence above it happened to say, which makes the offer depend
 * on a sentence the reader may not have read and on a layout that may have
 * moved it. Every label in this build's decision surfaces names what is acted
 * on and what follows.
 *
 * The gate asserts their ABSENCE as a primary control, which is a different and
 * stronger claim than the presence of the right ones: a page can carry
 * `Approve publication` and a bare `Confirm` beside it, and only the absence
 * check sees the second one.
 */
export const FORBIDDEN_PRIMARY_LABELS: readonly string[] = ["Confirm", "OK", "Yes", "Submit"];

/**
 * The review half, which is a technical verdict on a package and not a human
 * approval. Named for the same property the four above have — object, scope,
 * consequence — because SPEC.md section 6.4's last rule is about consequential
 * actions and not about approvals specifically.
 */
export const REVIEW_ACTION_LABELS: Readonly<Record<string, string>> = {
  request: "Request a review of this version",
  approve: "Record an approve verdict for this version",
  reject: "Record a reject verdict for this version",
  conditional: "Record a conditional verdict for this version",
};

// ===========================================================================
// The Approval Inbox's own chrome
// ===========================================================================

export const APPROVALS_TEXT = {
  /** the region's heading */
  heading: "Approval inbox",
  /** the label of the status filter */
  status_label: "Status",
  /** the label of the kind filter */
  kind_label: "Kind",
  /** the label of the operator's note field */
  note_label: "Note (recorded with the decision)",
  /** shown while the first response is outstanding */
  loading: "Loading the approval inbox — no item below has been read yet.",
  /** shown while a decision is in flight */
  deciding: "Recording this decision. The controls are held until the server answers.",
  /** zero items and no filter: the inbox has never had one */
  empty: "No approval has ever been asked for in this workspace. When a high-risk adoption or a publication needs a decision, it appears here.",
  /** the first valid action on an empty inbox */
  empty_action: "Reload the approval inbox",
  /** zero items because a filter selected none */
  filtered_to_zero:
    "No item matches these filters. The items are still there; the filters selected none of them. Clearing them shows them again.",
  clear_filter: "Clear both filters and show every item",
  /** the refusal the server returned, shown as the server's own */
  forbidden_heading: "The server refused this inbox",
  /** a transport or server failure, with a bounded recovery */
  error_heading: "The approval inbox could not be read",
  retry: "Retry loading the approval inbox",
  /** the heading over the server's reason for offering no control */
  disabled_heading: "This item offers no decision",
  /** the heading over a typed schema refusal */
  invalid_heading: "The server refused this decision as malformed",
  /** what is promised about the note when a decision is refused */
  note_preserved: "The note above was not sent anywhere and has not been cleared.",
  /** the heading over a stale or concurrent decision */
  stale_heading: "This item was decided or changed by another session",
  stale_refresh: "Reload this item and show the decision that was recorded",
  /** the badge a replayed idempotent decision carries */
  replay_badge: "Replayed: this exact decision was already recorded and no second one was written.",
  /** the legend over the conditions a decision answers */
  conditions_label: "why a decision is being asked for",
  /** the legend over the consequence of deciding */
  consequence_label: "what deciding this affects",
  /** the legend over the bounded decision history */
  history_label: "every decision recorded on this item, oldest first",
} as const;

/** The refusal's body: the server's own code and message and nothing inferred
 *  from them. Identical in shape to `refusalDetail` in
 *  `src/console-proofline.ts`, and deliberately a second function rather than a
 *  cross-import, because that file is the READ surface's vocabulary. */
export function decisionRefusalDetail(code: string, message: string): string {
  return `${code}: ${message}`;
}

/**
 * Why no control is offered, in the server's own vocabulary.
 *
 * The `reason_code` is NOT translated into friendlier words. A table that
 * renamed `NOT_HUMAN_APPROVER` into "you cannot do this" would be the browser
 * restating a server decision in words the server never checked, and the next
 * reason code added server-side would fall through it into silence.
 */
export function disabledDetail(reasonCode: string): string {
  return `The server offers no decision on this item and gives the reason ${reasonCode}. No decision was sent.`;
}

// ===========================================================================
// The revocation flow (SPEC.md section 6.4, SPEC.md section 5.1b)
// ===========================================================================

/**
 * THE FOUR THINGS A REVOCATION DOES AND DOES NOT DO, STATED BEFORE COMMIT.
 *
 * This is the honesty property the whole flow exists for. A registry that
 * revokes a version has NOT recalled the bytes anybody already holds and has
 * NOT invalidated the signature over them — the signature is a mathematical
 * fact about bytes and a database row cannot change it. An owner who presses a
 * button believing otherwise has been misled by the button.
 *
 * They are declared as a LIST with codes rather than one paragraph so a gate
 * can assert each is on the page independently, and so a future edit that
 * quietly drops one is a failing count rather than a shorter sentence nobody
 * diffed.
 */
export const REVOCATION_CONSEQUENCES: ReadonlyArray<{ code: string; text: string }> = [
  {
    code: "new_adoptions_blocked",
    text: "New adoptions of this version are blocked from the moment the registry records the revocation.",
  },
  {
    code: "issued_bytes_not_deleted",
    text: "Bytes already issued are not deleted. Every adopter that already holds this package still holds it, and this registry has no way to take it back.",
  },
  {
    code: "signature_still_valid",
    text: "The offline signature over those bytes remains mathematically valid. Revocation is a fact this registry records, not a change to the package or to the mathematics of its signature.",
  },
  {
    code: "delivery_may_dead_letter",
    text: "Notices to known adopters are queued, and a queued notice may end in a dead letter instead of arriving.",
  },
];

export const REVOCATION_TEXT = {
  heading: "Revoke a version",
  /** the label of the version field */
  version_label: "Skill version id",
  /** the action that loads the pre-commit facts */
  load: "Show what revoking this version would do",
  /** the label of the reason field */
  reason_label: "Reason (recorded permanently and never rewritten)",
  /** the label of the successor selector */
  successor_label: "Replacement version (optional)",
  /** the option that selects no successor */
  successor_none: "No replacement — revoke without naming one",
  /** shown while the pre-commit read is outstanding */
  loading: "Reading what revoking this version would do — nothing has been decided yet.",
  /** shown while the revocation itself is in flight */
  committing: "Recording this revocation. The controls are held until the server answers.",
  /** the heading over the pre-commit facts */
  precommit_heading: "Before you revoke",
  /** the heading over the consequence list */
  consequence_heading: "What this does, and what it does not do",
  /** the heading over the known active adopters */
  adopters_heading: "Adopters that already hold this version",
  /** what is said when nobody holds it */
  adopters_none: "No adopter currently holds this version, so no revocation notice will be queued.",
  /** the heading over the committed result */
  committed_heading: "The registry recorded this revocation",
  /** the counts, each named for exactly what it counts */
  count_queued_label: "Notices queued",
  count_delivered_label: "Notices the endpoint accepted",
  count_failed_label: "Notices that ended in a dead letter",
  /** INV-07, said in words on the page and not only enforced in a test */
  queued_is_not_delivered:
    "A queued notice is queued. It has not been delivered, nothing on this page says it was, and it may still end in a dead letter.",
  /** the link into the dead-letter view */
  dead_letter_link: "Open the dead-letter view",
  /** the refusal the server returned */
  forbidden_heading: "The server refused this revocation surface",
  /** a transport or server failure */
  error_heading: "This version's revocation facts could not be read",
  retry: "Retry reading this version",
  /** the heading over the server's reason for offering no revocation */
  disabled_heading: "This version cannot be revoked",
  /** the heading over a typed schema refusal */
  invalid_heading: "The server refused this revocation as malformed",
  /** what is promised about the reason when a revocation is refused */
  reason_preserved: "The reason above was not recorded anywhere and has not been cleared.",
  /** the heading over a stale or concurrent revocation */
  stale_heading: "This version was changed by another session",
  stale_refresh: "Reload this version and show the state that was recorded",
  /** the badge a replayed idempotent revocation carries */
  replay_badge: "Replayed: this exact revocation was already recorded and no second one was written.",
} as const;

/**
 * The two primary labels, keyed by whether a successor was chosen.
 *
 * A TABLE, for the reason `HUMAN_DECISION_LABELS` is a table: the choice is a
 * fact about the form the operator filled in, and the label must move with it
 * so a person who picked a replacement is never offered a button that does not
 * mention one.
 */
export const REVOKE_PRIMARY_LABELS: Readonly<Record<string, string>> = {
  without_successor: "Revoke version",
  with_successor: "Revoke and replace version",
};

/** Which of the two the form is currently offering. A KEY, not a decision: it
 *  reports the state of a `<select>` this browser owns, and nothing about the
 *  registry. */
export function revokePrimaryKey(successorChosen: boolean): string {
  return successorChosen ? "with_successor" : "without_successor";
}

/** The exact subject line of a pre-commit panel: which bytes, by hash. */
export function revocationSubject(versionId: string, manifestHash: string): string {
  return `${versionId} · manifest hash: ${manifestHash}`;
}

// ===========================================================================
// The webhook flow (SPEC.md section 6.5)
// ===========================================================================

export const WEBHOOK_TEXT = {
  heading: "Webhook endpoints",
  /** the label of the registration field */
  url_label: "Endpoint URL",
  /** the action that registers one */
  register: "Register this endpoint",
  /** the action that sends one test delivery */
  send_test: "Send one test delivery to this endpoint",
  /** shown while the list is outstanding */
  loading: "Loading webhook endpoints — no endpoint below has been read yet.",
  /** shown while a test delivery is in flight */
  testing: "Sending one test delivery. The controls are held until the server answers.",
  /** zero endpoints and none ever registered */
  empty: "No webhook endpoint is registered in this workspace. Register one to receive adoption and revocation notices.",
  /** the heading over the test result */
  result_heading: "Test delivery result",
  /**
   * WHAT A TEST RESULT IS NOT. SPEC.md section 6.5 requires the test route to
   * leave `failure_count`, `status` and the production queue untouched, and the
   * server does leave them untouched. This sentence is the browser's half of the
   * same statement: a page that showed a test result under the endpoint's health
   * would be presenting a probe as production evidence even though no counter
   * moved.
   */
  result_not_health:
    "This is the result of one test delivery, not the endpoint's production health. It moved no failure count, changed no endpoint status and queued nothing.",
  /** the heading over the endpoint's actual production health */
  health_heading: "Production health, as the registry records it",
  /** the field labels of a test result, each naming exactly its field */
  field_delivered: "delivered",
  field_http_status: "http_status",
  field_latency_ms: "latency_ms",
  field_error_code: "error_code",
  field_error_detail: "error_detail",
  /** what is said where a field has no value */
  field_absent: "not reported",
  /** the bound on what is shown, stated on the page */
  detail_bounded:
    "The detail above is a bounded, sanitized line from the transport. The endpoint's own response body is never read back here.",
  /** the refusal the server returned */
  forbidden_heading: "The server refused this webhook surface",
  /** a transport or server failure */
  error_heading: "The webhook endpoints could not be read",
  retry: "Retry loading the webhook endpoints",
  /** the heading over the server's reason for offering no test */
  disabled_heading: "This endpoint offers no test delivery",
  /** the heading over a typed schema refusal */
  invalid_heading: "The server refused this endpoint as malformed",
  /** what is promised about the URL when a registration is refused */
  url_preserved: "The URL above was not registered and has not been cleared.",
  /** the heading over a stale or concurrent change */
  stale_heading: "This endpoint was changed or removed by another session",
  stale_refresh: "Reload the endpoints and show what is registered now",
  /** the badge a replayed idempotent registration carries */
  replay_badge: "Replayed: this exact endpoint registration was already recorded and no second one was written.",
} as const;

// ===========================================================================
// Shared: the states these three regions report, and the codes that reach them
// ===========================================================================

/**
 * The typed codes that mean "somebody else got there first".
 *
 * SPEC.md section 6.4's state matrix names exactly these three for the
 * stale/concurrent row, and `decided while open in another session` is that row
 * rather than a class of its own. The set is declared so the renderer can ask
 * `has`, which is a membership test on a closed set the specification fixed and
 * not a verdict this browser computed.
 */
export const STALE_CODES: readonly string[] = ["PRECONDITION_FAILED", "CONFLICT", "NOT_FOUND"];

/** The typed code that means the body was malformed. */
export const INVALID_CODE = "INVALID_SCHEMA";

/** The typed code that means the actor may not. */
export const FORBIDDEN_CODE = "FORBIDDEN";

/**
 * The response header the registry sets on an idempotent replay, and the value
 * that means one happened.
 *
 * Read from the HEADER and not inferred from the body, because the body of a
 * replay is byte-identical to the body of the original — that is what replay
 * means — so a browser that tried to tell them apart from the payload would be
 * guessing. `src/http.ts` sets it; this is the same string.
 */
export const REPLAY_HEADER = "Idempotency-Replayed";
export const REPLAY_HEADER_TRUE = "true";
