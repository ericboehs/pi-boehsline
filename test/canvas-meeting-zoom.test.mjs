/**
 * /meeting's slide zoom: ‹ › buttons and the arrow keys page through the
 * slides while it's open, and the panel behind follows. The page script runs
 * in jsdom with canned API answers (no browser, no network).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const windows = [];
after(() => windows.forEach((w) => w.close())); // the page's timers would hold the process open
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function runMeetingPage(api) {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { url: "http://127.0.0.1:8790/meeting", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  w.fetch = async (u) => ({ ok: true, json: async () => api(String(u)) });
  w.EventSource = class {
    addEventListener() {}
  };
  w.Element.prototype.scrollIntoView = function () {};
  // jsdom has no showModal: open/close with the attribute and fire "close" like a browser.
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
  w.eval(readFileSync(fileURLToPath(new URL("../extensions/canvas/meeting-page.mjs", import.meta.url)), "utf8"));
  await tick();
  return w;
}

const snap = () => ({
  id: "m1",
  state: { recording: true, app: "Teams", title: "Sync", startedAt: "2026-11-03T14:00:00Z" },
  entries: [1, 2, 3].map((n) => ({ type: "slide", n, reason: "change", ts: `2026-11-03T14:0${n}:00Z` })),
  total: 3,
  from: 0,
  slides: [1, 2, 3].map((n) => ({ n, at: `2026-11-03T14:0${n}:00Z`, file: `000${n}-140${n}00.jpg`, thumb: true, reason: "change" })),
  live: [],
  people: null,
  notes: null,
  summaries: { 2: { title: "Q3 roadmap", what: "Epics." } },
});

const slideOn = (doc) => doc.querySelector(".slide img").getAttribute("src").match(/slide\/(\d+)/)[1];

test("/meeting zoom: ‹ › and h/l/←/→ page through the slides, the panel follows; past the newest it follows the screen", async () => {
  // Slide 1 came back on screen after slide 3: following shows 1, and 3 is the newest.
  const base = snap();
  const data = { ...base, entries: [...base.entries, { type: "revisit", n: 1, reason: "revisit", ts: "2026-11-03T14:04:00Z" }], total: 4 };
  const w = await runMeetingPage(() => data);
  const doc = w.document;
  const dialog = doc.querySelector("dialog.zoom");
  const big = () => dialog.querySelector("img").getAttribute("src").match(/slide\/(\d+)/)[1];
  const cap = () => dialog.querySelector(".zcap").textContent;
  const key = (k) => doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true }));
  const prev = dialog.querySelector(".zprev");
  const next = dialog.querySelector(".znext");

  key("Enter");
  assert.equal(dialog.hasAttribute("open"), true, "Enter zooms the slide shown");
  assert.equal(big(), "1");
  assert.equal(cap(), "Slide 1 of 3 · following the screen");
  assert.deepEqual([prev.disabled, next.disabled], [true, false]);

  key("l");
  assert.deepEqual([big(), slideOn(doc)], ["2", "2"], "the panel behind follows");
  assert.equal(cap(), "Slide 2 of 3 · Q3 roadmap");
  next.click();
  assert.equal(dialog.hasAttribute("open"), true, "a button click doesn't close the zoom");
  assert.equal(big(), "3");
  assert.equal(next.disabled, false, "picked by hand: › can still go back to following");
  assert.match(next.title, /Follow the screen/);
  key("ArrowRight");
  assert.equal(big(), "1", "past the newest: back on the slide on screen");
  assert.equal(cap(), "Slide 1 of 3 · following the screen");
  key("h");
  assert.equal(big(), "1", "nothing before the first");

  key("q");
  assert.equal(dialog.hasAttribute("open"), false, "q closes");
  key(" ");
  assert.equal(dialog.hasAttribute("open"), true, "Space zooms too");
  dialog.click();
  assert.equal(dialog.hasAttribute("open"), false, "a click on the image closes");
});

test("/meeting keys: slides with h l 0 $, the newest then following; tabs; ? help; n only while filtering", async () => {
  const w = await runMeetingPage(() => snap());
  const doc = w.document;
  const key = (k, o = {}) => doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, ...o }));
  key("0");
  assert.equal(slideOn(doc), "1");
  assert.ok(doc.querySelector(".cap button"), "picked by hand: the Follow button shows");
  key("l");
  key("l");
  assert.equal(slideOn(doc), "3");
  assert.equal(doc.querySelector(".cap button"), null, "slide 3 is on screen: following again");
  key("h");
  assert.equal(slideOn(doc), "2");
  key("$");
  assert.equal(slideOn(doc), "3");
  key("0");
  key("$");
  key("l");
  assert.equal(doc.querySelector(".cap button"), null, "l past the newest follows the screen");
  // Ctrl with another letter is the browser's.
  key("0", { ctrlKey: true });
  assert.equal(slideOn(doc), "3");

  const help = doc.querySelector("dialog.keys");
  key("?");
  assert.equal(help.hasAttribute("open"), true);
  assert.match(help.textContent, /Keyboard shortcuts/);
  assert.match(help.textContent, /next \/ previous time your name was said/);
  key("h");
  assert.equal(slideOn(doc), "3", "keys don't reach the page under the help");
  key("q");
  assert.equal(help.hasAttribute("open"), false);

  key("1");
  assert.equal(doc.body.classList.contains("view-tx"), true);
  key("3");
  assert.equal(doc.body.classList.contains("view-notes"), false, "no notes: no Notes tab");
});
