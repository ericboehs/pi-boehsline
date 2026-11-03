/**
 * The canvas page's embedding seam (extensions/canvas/README.md, "Embedding the
 * page"): canvasConfig / canvasUrls in nav.mjs, and page.mjs itself run in
 * jsdom with canned routes, under the daemon's defaults and under an embedding
 * host's <meta> tags (read-only, polled, its own API and asset bases).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import * as nav from "../extensions/canvas/nav.mjs";
import * as render from "../extensions/canvas/render.mjs";
import * as theme from "../extensions/canvas/theme.mjs";

const { canvasConfig, canvasUrls } = nav;
const metaOf = (tags) => (name) => tags[name] ?? "";
const SEC = { id: "notes", title: "Notes", kind: "markdown", file: "notes.md", at: "2026-10-28T14:00:00.000Z" };

// ── config and URL helpers ──

test("canvasConfig: no tags (the daemon's shell) is the daemon's routes", () => {
  const cfg = canvasConfig(metaOf({}), "/s/abc%20d");
  assert.deepEqual(cfg, { session: "abc d", api: "", assets: "/assets/", readonly: false, poll: 0, embed: false });
  assert.equal(canvasConfig(metaOf({}), "/").session, "", "the index");
  const u = canvasUrls(cfg);
  assert.equal(u.apiUrl("/api/s/s1"), "/api/s/s1");
  assert.equal(u.apiUrl("/api/events"), "/api/events");
  assert.equal(u.assetUrl("vendor/highlight.js"), "/assets/vendor/highlight.js");
  assert.equal(u.assetUrl("themes.json"), "/assets/themes.json");
  assert.equal(u.bodyUrl("s1", SEC), "/s/s1/f/notes.md?v=2026-10-28T14%3A00%3A00.000Z");
  assert.equal(u.bodyUrl("s1", SEC, false), "/s/s1/f/notes.md");
});

test("canvasConfig: an embedding host's tags rewrite the bases, session, liveness and mode", () => {
  const cfg = canvasConfig(metaOf({ "canvas-session": "s9", "canvas-api": "botsun://canvas/", "canvas-assets": "/bundle/canvas", "canvas-readonly": "1", "canvas-live": "poll:2000", "canvas-host": "embed" }), "/index.html");
  assert.deepEqual(cfg, { session: "s9", api: "botsun://canvas", assets: "/bundle/canvas/", readonly: true, poll: 2000, embed: true });
  const u = canvasUrls(cfg);
  assert.equal(u.apiUrl("/api/s/s9"), "botsun://canvas/api/s/s9");
  assert.equal(u.assetUrl("vendor/mermaid.js"), "/bundle/canvas/vendor/mermaid.js");
  assert.equal(u.bodyUrl("s9", SEC), "botsun://canvas/s/s9/f/notes.md?v=2026-10-28T14%3A00%3A00.000Z");
  assert.equal(canvasConfig(metaOf({ "canvas-live": "poll:5" })).poll, 250, "a poll floor");
  assert.equal(canvasConfig(metaOf({ "canvas-live": "nonsense" })).poll, 0, "anything else is the event stream");
  assert.equal(canvasConfig(metaOf({ "canvas-readonly": "true" })).readonly, false, "only 1 turns read-only on");
});

// ── page.mjs in jsdom ──

const pageSrc = readFileSync(fileURLToPath(new URL("../extensions/canvas/page.mjs", import.meta.url)), "utf8");
const windows = [];
after(() => windows.forEach((w) => w.close()));
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** The module's imports, as destructuring from the real modules (jsdom runs no ES modules). */
function asScript(src) {
  let n = 0;
  const out = src.replace(/^import \{([^}]*)\} from "\.\/(theme|nav|render)\.mjs";$/gm, (_, names, mod) => (n++, `const {${names.replace(/ as /g, ": ")}} = __mods.${mod};`));
  assert.equal(n, 3, "page.mjs imports theme, nav and render relative to itself");
  return `(() => { const __mods = window.__mods; ${out}\n})();`;
}

// A fresh section: an old one starts folded, and a folded one doesn't load its body.
const FRESH = { ...SEC, at: new Date().toISOString() };
const freshBody = (base) => `${base}/s/s1/f/notes.md?v=${encodeURIComponent(FRESH.at)}`;
const STATE = {
  meta: { id: "s1", name: "Demo", cwd: "/tmp/demo" },
  live: true,
  tmux: true,
  activity: "done",
  status: { goal: "Ship it", now: "Waiting", at: "2026-10-28T14:00:00.000Z" },
  reply: { text: "Done.", at: "2026-10-28T14:00:00.000Z", next: ["Run the tests"] },
  acks: [],
  sections: [FRESH],
  findings: [],
  watch: null,
  meeting: { kind: "list", id: "", recent: [], at: "2026-10-28T14:00:00.000Z" },
};

async function runPage({ url, metas = {}, bridge = false }) {
  const head = Object.entries(metas)
    .map(([k, v]) => `<meta name="${k}" content="${v}">`)
    .join("");
  const dom = new JSDOM(`<!doctype html><head>${head}</head><body><div id="app"></div></body>`, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  // render.mjs runs in this realm and reaches for document/window/Node.
  Object.assign(globalThis, { document: w.document, window: w, Node: w.Node });
  const fetches = [];
  w.fetch = async (u, opts = {}) => {
    fetches.push({ url: String(u), method: opts.method || "GET" });
    const path = String(u);
    const body = /\/api\/s\/[^/]+$/.test(path) ? STATE : /\/api\/sessions$/.test(path) ? [] : /themes\.json$/.test(path) ? { themes: {} } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === "object" ? "# Notes\n\nhello" : "") };
  };
  const streams = [];
  w.EventSource = class {
    constructor(u) {
      streams.push(String(u));
    }
    addEventListener() {}
  };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.ResizeObserver = class {
    observe() {}
  };
  w.Element.prototype.scrollIntoView = () => {};
  const intervals = [];
  const realInterval = w.setInterval.bind(w);
  w.setInterval = (fn, ms) => (intervals.push({ fn, ms }), realInterval(() => {}, 1e9));
  const sent = [];
  if (bridge) w.webkit = { messageHandlers: { canvasSend: { postMessage: (m) => sent.push(m) } } };
  w.__mods = { theme, nav, render };
  w.eval(asScript(pageSrc));
  await tick();
  return { w, doc: w.document, fetches, streams, intervals, sent };
}

test("page, default config: the daemon's routes, an event stream, the send box", async () => {
  const { doc, fetches, streams, intervals } = await runPage({ url: "http://127.0.0.1:8790/s/s1" });
  await tick(450); // the banner's session list is debounced 400 ms
  const urls = fetches.map((f) => f.url);
  assert.ok(urls.includes("/api/s/s1"), "the state route");
  assert.ok(urls.includes(freshBody("")), "the section body");
  assert.ok(urls.includes("/assets/themes.json") || !urls.some((u) => u.includes("themes.json")), "themes.json, if asked, from /assets/");
  assert.ok(urls.includes("/api/sessions"), "the session list for the banner");
  assert.deepEqual(streams, ["/api/events"]);
  assert.ok(intervals.some((i) => i.ms === 30_000), "the 30 s safety refresh beside the stream");
  assert.ok(doc.querySelector(".talk-in"), "the send box");
  assert.ok(doc.querySelector("button.next-btn"), "Next steps are buttons");
  assert.ok(doc.querySelector(".btn.clip"), "the clippy button");
  assert.ok(doc.querySelector("a.back"), "All sessions");
  assert.ok(doc.querySelector("h1 .name-btn"), "the info panel's button");
  assert.ok(doc.querySelector(".card[data-kind=meeting]"), "the meeting widget");
});

const EMBED = { "canvas-session": "s1", "canvas-api": "https://host.test/c", "canvas-assets": "https://host.test/a/", "canvas-readonly": "1", "canvas-live": "poll:1500", "canvas-host": "embed" };

test("page, embedded read-only and polled: host URLs, no POST, no send box, setInterval not EventSource", async () => {
  const { w, doc, fetches, streams, intervals } = await runPage({ url: "https://host.test/index.html", metas: EMBED });
  await tick(450); // past the banner's debounce: it must not ask for the session list
  const urls = fetches.map((f) => f.url);
  assert.ok(urls.includes("https://host.test/c/api/s/s1"), "the state route under the API base");
  assert.ok(urls.includes(freshBody("https://host.test/c")), "the body under the API base");
  for (const u of urls) assert.match(u, /^https:\/\/host\.test\/(c|a)\//, `${u}: every request goes to the host's bases`);
  assert.ok(!urls.some((u) => /\/api\/(sessions|peers|meeting|system-theme)|\/info$/.test(u)), "no daemon-only routes");
  assert.deepEqual(streams, [], "no EventSource");
  assert.ok(!intervals.some((i) => i.ms === 30_000), "the poll replaces the stream's 30 s safety refresh");
  const poll = intervals.find((i) => i.ms === 1500);
  assert.ok(poll, "the state route on a 1500 ms timer");
  const before = fetches.length;
  poll.fn();
  await tick();
  assert.ok(fetches.slice(before).some((f) => f.url === "https://host.test/c/api/s/s1"), "each tick re-reads the state");

  assert.equal(doc.querySelector(".talk-in"), null, "no send box");
  assert.equal(doc.querySelector("button.next-btn"), null, "Next steps are text");
  assert.ok(doc.querySelector(".next-btn"), "but still shown");
  assert.equal(doc.querySelector(".btn.clip"), null, "no clippy");
  assert.equal(doc.querySelector(".btn.follow"), null, "no follow tmux");
  assert.equal(doc.querySelector("a.back"), null, "no session list link");
  assert.equal(doc.querySelector(".name-btn"), null, "no info panel");
  assert.equal(doc.querySelector(".card[data-kind=meeting]"), null, "no meeting widget");
  assert.ok(w.document.documentElement.classList.contains("canvas-ro"), "the review gutter is off");
  assert.ok(doc.querySelector("#sec-notes"), "the section itself shows");
  assert.ok(fetches.every((f) => f.method === "GET"), "never a POST");
});

test("page, read-only with a host bridge: Next steps post {text} to it, still no POST", async () => {
  const { doc, fetches, sent } = await runPage({ url: "https://host.test/index.html", metas: EMBED, bridge: true });
  const b = doc.querySelector("button.next-btn");
  assert.ok(b, "a Send button again");
  assert.equal(doc.querySelector(".talk-in"), null, "but still no send box");
  b.click();
  await new Promise((r) => setTimeout(r, 3200)); // the undo window
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ text: "Run the tests" }]);
  assert.ok(fetches.every((f) => f.method === "GET"), "never a POST");
});

test("page, image popup: every screenshot on the page, ‹ › and h/l step, a counter, ? lists the keys, q closes", async () => {
  const { w, doc } = await runPage({ url: "http://127.0.0.1:8790/s/s1" });
  // jsdom has no showModal: open/close with the attribute and fire "close" like a browser.
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
  for (const n of [1, 2, 3]) doc.body.append(Object.assign(doc.createElement("img"), { className: "shot", src: `/s/s1/f/shot-${n}.png`, alt: `Shot ${n}` }));
  const key = (k) => doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true }));
  doc.querySelectorAll("img.shot")[1].dispatchEvent(new w.MouseEvent("click", { bubbles: true, button: 0 }));
  const d = doc.querySelector("dialog.modal");
  const pos = () => d.querySelector(".pos").textContent;
  const title = () => d.querySelector("header .title").textContent;
  assert.equal(d.hasAttribute("open"), true);
  assert.deepEqual([title(), pos()], ["Shot 2", "2 / 3"]);
  assert.equal(d.querySelectorAll(".mstep").length, 2, "‹ › at the image's edges");
  d.querySelector(".mstep.next").click();
  assert.deepEqual([title(), pos()], ["Shot 3", "3 / 3"]);
  key("l");
  assert.equal(pos(), "1 / 3", "wraps around");
  key("h");
  key("ArrowLeft");
  assert.equal(pos(), "2 / 3");
  key("?");
  assert.match(d.querySelector(".mhelp")?.textContent ?? "", /previous \/ next/);
  key("q");
  assert.equal(d.querySelector(".mhelp"), null, "q closes the key list first");
  assert.equal(d.hasAttribute("open"), true);
  key("q");
  assert.equal(d.hasAttribute("open"), false, "then the popup");
});
