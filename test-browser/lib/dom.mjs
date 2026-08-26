// READING THE PAGE BACK, AS A PERSON'S BROWSER HOLDS IT.
//
// Every function here runs INSIDE the page and returns plain data. Nothing in
// this file looks at a screenshot, a colour or a layout box: a browser gate that
// concluded "the page looked right" would be the screenshot-as-evidence failure
// P3-FR-03 forbids and the P2 gate manifest names as this phase's likeliest one.
//
// The central function is `readCells`. It reassembles each rendered cell from
// the DOM nodes the renderer created — the answer span and every entry of the
// method list — and returns the reassembled string. A gate compares that string
// to the bytes the server sent. If the renderer dropped a `source:`, shortened a
// `boundary:` or summarised a `why:`, the two strings differ and the gate fails;
// there is no way for the page to look right and this to pass.

/** Every rendered Proofline cell, reassembled from the DOM. */
export async function readCells(page) {
  return page.evaluate(
    ({ sep, keySep }) => {
      const out = [];
      const box = document.getElementById("proofline");
      if (box === null) return out;
      for (const section of box.querySelectorAll("section[data-section-key]")) {
        const rows = section.querySelectorAll("tbody tr");
        for (let r = 0; r < rows.length; r += 1) {
          for (const td of rows[r].querySelectorAll("td[data-field]")) {
            const value = td.querySelector(".cell-value");
            const parts = [];
            for (const entry of td.querySelectorAll(".cell-method > div")) {
              const dt = entry.querySelector("dt");
              const dd = entry.querySelector("dd");
              const text = dd === null ? "" : dd.textContent;
              parts.push(dt === null ? text : `${dt.textContent}${keySep}${text}`);
            }
            out.push({
              section: section.dataset.sectionKey,
              row: r,
              field: td.dataset.field,
              // what the page SAYS, reassembled: the answer plus every part of
              // its method, in the order they were rendered
              rendered: [value === null ? "" : value.textContent, ...parts].join(sep),
              value: value === null ? null : value.textContent,
              answerClass: [...td.classList].filter((c) => c.startsWith("answer-")),
            });
          }
        }
      }
      return out;
    },
    { sep: " · ", keySep: ": " },
  );
}

/** Every section the page drew, with its heading, its row count and its state. */
export async function readSections(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("#proofline section[data-section-key]")].map((s) => ({
      key: s.dataset.sectionKey,
      rows: s.dataset.rows,
      heading: s.querySelector("h3")?.textContent ?? null,
      text: s.textContent ?? "",
      actions: [...s.querySelectorAll("button[data-action]")].map((b) => ({
        action: b.dataset.action,
        label: b.textContent,
      })),
    })),
  );
}

/** The notices, as rendered. */
export async function readNotices(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("#proofline .notice")].map((n) => ({
      kind: n.dataset.noticeKind,
      heading: n.querySelector("h3")?.textContent ?? null,
      detail: n.querySelector("p")?.textContent ?? null,
    })),
  );
}

/** The partial banner, or null. */
export async function readPartial(page) {
  return page.evaluate(() => {
    const p = document.querySelector("#proofline .partial");
    if (p === null) return null;
    return {
      unknown: Number(p.dataset.unknownCells),
      total: Number(p.dataset.totalCells),
      heading: p.querySelector("h3")?.textContent ?? null,
      detail: p.querySelector("p")?.textContent ?? null,
    };
  });
}

/** The navigation, as the browser holds it: what a person can click. */
export async function readNav(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("#proofline-nav a[data-view]")].map((a) => ({
      view: a.dataset.view,
      href: a.getAttribute("href"),
      label: a.textContent,
      current: a.getAttribute("aria-current"),
    })),
  );
}

/**
 * EVERY STRING THE PROOFLINE REGION PUTS IN FRONT OF A READER, as text nodes.
 *
 * A gate uses this to assert that the Console adds NO SENTENCE OF ITS OWN: each
 * text node is either something the server sent in this payload or one of the
 * constants declared in `src/console-proofline.ts`. That is how `INV-07` is
 * checked without guessing — the Console cannot be labelling a queued
 * notification `delivered` if every word on the page came from one of two
 * enumerable sets.
 */
export async function readTextNodes(page, selector = "#proofline") {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (root === null) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out = [];
    while (walker.nextNode()) {
      const t = walker.currentNode.textContent;
      if (t !== null && t.trim().length > 0) out.push(t);
    }
    return out;
  }, selector);
}

/** The four INV-03 marks, read off the stylesheet the server shipped rather
 *  than off a picture of the page. */
export async function readAnswerMarks(page, answers) {
  return page.evaluate((list) => {
    const probe = document.createElement("table");
    const tbody = document.createElement("tbody");
    const tr = document.createElement("tr");
    const marks = {};
    for (const answer of list) {
      const td = document.createElement("td");
      td.className = `answer-${answer}`;
      const span = document.createElement("span");
      span.className = "cell-value";
      span.textContent = answer;
      td.appendChild(span);
      tr.appendChild(td);
      marks[answer] = span;
    }
    tbody.appendChild(tr);
    probe.appendChild(tbody);
    // Appended so the shipped stylesheet applies to it, read, and removed.
    document.body.appendChild(probe);
    const out = {};
    for (const answer of list) {
      out[answer] = window.getComputedStyle(marks[answer], "::before").content;
    }
    document.body.removeChild(probe);
    return out;
  }, answers);
}

/** What the browser's own stores hold. `INV-04` is asserted against this. */
export async function readBrowserStores(page) {
  return page.evaluate(() => ({
    localStorage: Object.fromEntries(Object.entries(localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
    cookie: document.cookie,
    url: window.location.href,
    html: document.documentElement.outerHTML,
  }));
}
