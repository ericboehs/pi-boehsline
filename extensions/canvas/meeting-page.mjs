// The live meeting page (/meeting): meeting-capture's transcript as it is
// written, with the shared screen's slides. The daemon (meeting-feed.mjs)
// tails the files; this page asks /api/meeting for what's new on each
// "meeting" event and appends it. Nothing here loads from the network.
//
// Beside the transcript sits the copilot's Notes panel (alerts, your action
// items, decisions, topics, slides, questions, a suggested reply), from the notes file
// the daemon merges into /api/meeting. Under the shown slide a summary panel (title,
// what it shows, why it matters to you, key points, numbers) comes from the same
// notes (/api/meeting's `summaries`, by slide number); a past meeting shows its archived ones. From 1400 px it is a third column; below
// that a Transcript / Chat / Notes switch at the top of the column swaps them.
//
// Meeting chat messages (entries of type "chat") are kept out of the spoken transcript and shown
// in a Chat box: on top of the third column (about 40 % of its height, its own scroll) from 1400 px,
// a tab of its own (with an unread count) below that. Links in chat text are real links (http/https only).
//
// /meeting follows the live meeting. /meeting?id=<id> shows one from the history
// (/meetings), whole and ended; #e<n> scrolls to transcript entry n and flashes it.

const CSS = `
:root { color-scheme: light dark; --bg:#f7f5f0; --card:#fff; --ink:#1c1b19; --dim:#8a8578; --line:#e6e1d6; --soft:#f0ece3; --accent:#b4541f; --ok:#1f7a52; --warn:#a86a00; --bad:#c0392b; --c1:#3b7dd8; --c2:#e0703a; --c3:#2f9e72; --c4:#c4475b; --c5:#8a63c9; --c6:#b8901c; --c7:#2e9bb0; --c8:#8c8577; }
@media (prefers-color-scheme: dark) { :root { --bg:#1f1e1c; --card:#282725; --ink:#ecebe7; --dim:#9a958a; --line:#3a3834; --soft:#312f2c; --accent:#e08a5a; --ok:#5cc495; --warn:#e2b257; --bad:#ef6f5e; --c1:#6ea3ec; --c2:#f08f5c; --c3:#4fc493; --c4:#e36a7c; --c5:#a888e0; --c6:#e0bd4a; --c7:#5cc3d3; --c8:#a8a194; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
#app { height: 100%; display: flex; flex-direction: column; }
header { flex: none; display: flex; align-items: center; gap: 12px; padding: 10px 18px; border-bottom: 1px solid var(--line); background: var(--card); }
header .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--dim); }
header .dot.rec { background: var(--ok); animation: rec 1.6s infinite; }
@keyframes rec { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent); } 70%, 100% { box-shadow: 0 0 0 8px transparent; } }
header .who { min-width: 0; flex: 1; }
header h1 { margin: 0; font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
header .meta { color: var(--dim); font-size: 12.5px; display: flex; gap: 10px; flex-wrap: wrap; }
header .meta b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
header .meta .state.rec { color: var(--ok); font-weight: 600; }
header input { font: inherit; font-size: 13px; padding: 5px 9px; width: 200px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
header a.back { color: var(--dim); font-size: 12.5px; text-decoration: none; }
header a.back:hover { color: var(--accent); }
header .links { flex: none; display: flex; gap: 12px; }
main { flex: 1; min-height: 0; display: flex; }
.stage { flex: 3 1 0; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); }
body:not(.has-slides) .stage { display: none; }
.slide { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px 16px 8px; gap: 6px; }
.slide .frame { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
.slide img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 6px; box-shadow: 0 1px 4px rgb(0 0 0 / .18); background: var(--card); cursor: zoom-in; }
.slide .cap { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--dim); }
.slide .cap b { color: var(--ink); }
.slide .cap button, .jump, .strip-h button { font: 500 12px/1 -apple-system, BlinkMacSystemFont, sans-serif; padding: 5px 9px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
.slide .cap .grow { flex: 1; }
.sum { flex: none; max-height: 30vh; overflow-y: auto; padding: 2px 18px 6px; font-size: 13px; line-height: 1.45; }
.sum .st { font-weight: 600; font-size: 14px; }
.sum p { margin: 3px 0; }
.sum .why { color: var(--ink); }
.sum .why b { color: var(--accent); font-weight: 600; }
.sum ul { margin: 3px 0; padding-left: 18px; }
.sum li { margin: 1px 0; }
.sum .nums { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sum .nums span { font-size: 11.5px; padding: 1px 8px; border-radius: 10px; background: var(--soft); color: var(--dim); }
.sum .pending { color: var(--dim); font-style: italic; }
.strip { flex: none; display: flex; gap: 8px; overflow-x: auto; padding: 8px 16px 14px; scroll-behavior: smooth; }
.strip button { flex: none; padding: 0; border: 2px solid transparent; border-radius: 6px; background: none; cursor: pointer; position: relative; }
.strip button.on { border-color: var(--accent); }
.strip img { display: block; height: 72px; width: auto; border-radius: 4px; background: var(--soft); }
.strip i { position: absolute; right: 4px; top: 3px; font: 600 10.5px/1 -apple-system, sans-serif; font-style: normal; color: #fff; background: rgb(0 0 0 / .55); padding: 2px 4px; border-radius: 3px; }
.strip span { position: absolute; left: 4px; bottom: 3px; font: 600 10.5px/1 ui-monospace, Menlo, monospace; color: #fff; background: rgb(0 0 0 / .55); padding: 2px 4px; border-radius: 3px; }
.tx { flex: 2 1 0; min-width: 360px; position: relative; display: flex; flex-direction: column; }
body:not(.has-slides) .tx { max-width: 920px; margin: 0 auto; width: 100%; }
.scroll { flex: 1; overflow-y: auto; padding: 12px 18px 18px; }
.row { display: grid; grid-template-columns: 62px 1fr; gap: 0 10px; padding: 2px 6px; border-radius: 5px; }
.row time { color: var(--dim); font: 11.5px/1.9 ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
.row .sp { font-weight: 600; margin-right: 6px; }
.row.cont time { visibility: hidden; }
.row.first { margin-top: 8px; }
.row.chat .body { overflow-wrap: anywhere; }
.row.chat .body a { color: var(--accent); }
.row.note .body { color: var(--dim); font-size: 12.5px; }
.row.slide-mark { margin: 8px 0; cursor: pointer; }
.row.slide-mark .body { display: flex; align-items: center; gap: 10px; color: var(--dim); font-size: 12.5px; }
.row.slide-mark img { height: 48px; border-radius: 4px; background: var(--soft); }
.row.slide-mark:hover { background: var(--soft); }
.row.flash { animation: flash 1.6s; }
@keyframes flash { from { background: color-mix(in srgb, var(--accent) 22%, transparent); } to { background: transparent; } }
.live .row { color: var(--dim); font-style: italic; }
.live .row .sp { font-style: normal; opacity: .75; }
.cursor { display: inline-block; width: .55em; margin-left: 2px; animation: blink 1s steps(2) infinite; font-style: normal; }
@keyframes blink { to { opacity: 0; } }
.jump { position: absolute; left: 50%; transform: translateX(-50%); bottom: 14px; box-shadow: 0 2px 8px rgb(0 0 0 / .18); }
.empty { margin: auto; text-align: center; color: var(--dim); max-width: 440px; padding: 40px 20px; }
.empty h2 { color: var(--ink); font-size: 17px; font-weight: 600; margin: 0 0 6px; }
.waiting { color: var(--dim); font-style: italic; padding: 16px 6px; }
.row.me { background: color-mix(in srgb, var(--warn) 11%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--warn) 70%, transparent); }
.tabs { flex: none; display: none; gap: 6px; padding: 8px 18px 0; }
.tabs button { font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, sans-serif; padding: 6px 11px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--dim); cursor: pointer; }
.tabs button.on { color: var(--ink); border-color: var(--accent); }
.tabs i { font-style: normal; font-weight: 600; margin-left: 5px; color: var(--warn); }
.side { flex: none; width: 340px; min-height: 0; display: none; flex-direction: column; border-left: 1px solid var(--line); background: var(--card); }
body.has-side .side { display: flex; }
body.has-side:not(.has-slides) .tx { max-width: none; margin: 0; }
.chat { flex: 0 1 auto; max-height: 40%; min-height: 0; display: flex; flex-direction: column; } /* as tall as its messages, at most 40%: notes get the rest */
body:not(.has-notes) .chat { flex: 1 1 0; max-height: none; }
body:not(.has-chat) .chat { flex: none; }
.chat-h { flex: none; display: flex; align-items: baseline; gap: 8px; padding: 8px 16px 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); }
.chat-h small { font: 12px/1.3 -apple-system, BlinkMacSystemFont, sans-serif; text-transform: none; letter-spacing: 0; font-style: italic; font-weight: 400; }
.cscroll { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 10px 8px; font-size: 13.5px; line-height: 1.4; }
.cscroll .row.first { margin-top: 4px; }
.notes { flex: 1 1 0; min-height: 0; display: none; flex-direction: column; border-top: 1px solid var(--line); }
body.has-notes .notes { display: flex; }
.nbody { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 16px 18px; }
.nbody h3 { margin: 16px 0 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); }
.nbody ul { margin: 0; padding-left: 18px; }
.nbody li { margin: 3px 0; line-height: 1.4; }
.nbody li small { color: var(--dim); }
.nbody .none { color: var(--dim); font-style: italic; font-size: 13px; }
.nbody .alerts { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border-radius: 6px; background: color-mix(in srgb, var(--warn) 14%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); }
.nbody .alert { line-height: 1.4; }
.nbody .alert time { color: var(--dim); font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; margin-right: 6px; }
.nbody .topic { cursor: pointer; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
.nbody .topic.full { display: list-item; -webkit-line-clamp: unset; line-clamp: none; overflow: visible; }
.nbody .topics { list-style: none; padding-left: 0; }
.nbody .topics .topic { margin: 6px 0; }
.nbody .topic b { font-weight: 600; }
.nbody .alerts ul { list-style: none; padding-left: 0; margin: 0; display: flex; flex-direction: column; gap: 5px; }
.nbody .more { all: unset; cursor: pointer; display: inline-block; margin-top: 4px; font-size: 12px; color: var(--accent); }
.nbody .more:hover { text-decoration: underline; }
.nbody li.fresh { animation: fresh 2.4s ease-out; border-radius: 4px; }
@keyframes fresh { from { background: color-mix(in srgb, var(--accent) 28%, transparent); } to { background: transparent; } }
.nbody .slidelist { list-style: none; padding-left: 0; }
.nbody .slidelist button { all: unset; cursor: pointer; line-height: 1.4; }
.nbody .slidelist button:hover { color: var(--accent); text-decoration: underline; }
.nbody .reply { padding: 8px 10px; border-radius: 6px; background: var(--soft); border-left: 3px solid var(--ok); line-height: 1.45; }
.nbody .reply small { display: block; color: var(--dim); margin-bottom: 2px; }
.nbody .foot { margin-top: 18px; color: var(--dim); font-size: 12px; }
dialog { border: 0; padding: 0; background: transparent; max-width: 96vw; max-height: 96vh; }
dialog::backdrop { background: rgb(0 0 0 / .8); }
dialog img { display: block; max-width: 96vw; max-height: 96vh; }
@media (max-width: 1399px) {
  .side { width: auto; flex: 2 1 0; border-left: 0; }
  body.has-side .side { display: none; }
  body.has-side.view-chat .side, body.has-side.view-notes .side { display: flex; }
  body.has-side.view-chat .tx, body.has-side.view-notes .tx { display: none; }
  body.has-side .tabs { display: flex; }
  .chat, body:not(.has-notes) .chat, body:not(.has-chat) .chat { flex: 1 1 0; max-height: none; }
  .chat-h { display: none; }
  .notes { border-top: 0; }
  body.view-notes .chat, body.view-chat .notes { display: none; }
}
@media (max-width: 900px) {
  main { flex-direction: column; }
  .stage { flex: none; max-height: 48vh; border-right: 0; border-bottom: 1px solid var(--line); }
  .sum { max-height: 16vh; }
  .tx { min-width: 0; flex: 1; min-height: 0; }
  header input { width: 130px; }
}
`;

// ── tiny DOM helper ──
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

const pad = (n) => String(n).padStart(2, "0");
const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const span = (ms) => {
  if (!(ms >= 0)) return "";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
// A speaker keeps one colour all meeting: a hash of the name onto --c1..--c7.
const colorOf = (name) => {
  let x = 0;
  for (const ch of String(name)) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return `var(--c${(x % 7) + 1})`;
};

// ── state ──
let id = "";
let state = null;
let entries = [];
let slides = [];
let live = [];
let people = null;
let pinned = null; // a slide n picked by hand; null follows the one on screen
let onScreen = null; // the newest slide or revisit event's n
const shownAgain = new Map(); // slide n → times it came back (revisits)
let stick = true; // the transcript follows the bottom until you scroll up
let lastSpeaker = null;
let cstick = true; // the chat follows its bottom until you scroll up
let chatCount = 0;
let filter = "";
let notes = null; // the copilot's notes, when it has some for this meeting
let summaries = {}; // the copilot's slide summaries by slide number: { title, what, why, points, numbers }
const wanted = new URLSearchParams(location.search).get("id") || ""; // a past meeting's id; empty follows the live one
let jumpTo = /^#e(\d{1,7})$/.exec(location.hash)?.[1] ?? null; // the entry to scroll to once it is loaded
let notFound = false;

// ── transcript / chat / notes switch (below 1400 px; the CSS hides it above) ──
const bars = [];
let view = "tx";
let unread = 0; // chat messages that came in while the Chat tab was not shown
function tabsBar() {
  const mk = (v, label) => h("button", { type: "button", "data-v": v, onclick: () => showView(v) }, label, h("i", { hidden: true }));
  const bar = h("div", { class: "tabs" }, mk("tx", "Transcript"), mk("chat", "Chat"), mk("notes", "Notes"));
  bars.push(bar);
  return bar;
}
function showView(v) {
  view = v;
  if (v === "chat") unread = 0;
  for (const x of ["tx", "chat", "notes"]) document.body.classList.toggle(`view-${x}`, x === v);
  for (const bar of bars) for (const b of bar.children) b.classList.toggle("on", b.dataset.v === v);
  if (v === "chat") followChat();
  badge();
}
/** Is the Chat box on screen? Always from 1400 px; below that only on its tab. */
function chatShown() {
  return view === "chat" || Boolean(window.matchMedia?.("(min-width: 1400px)").matches);
}
// Widening the window shows the Chat box, so whatever piled up while narrow has been seen.
window.matchMedia?.("(min-width: 1400px)").addEventListener?.("change", (ev) => {
  if (!ev.matches) return;
  unread = 0;
  badge();
});
function badge() {
  const n = notes?.alerts?.length || 0;
  const hasChat = chatCount > 0;
  for (const bar of bars) {
    const i = bar.querySelector('[data-v="notes"] i');
    i.hidden = !n;
    i.textContent = n;
    const c = bar.querySelector('[data-v="chat"] i');
    c.hidden = !unread;
    c.textContent = unread;
    bar.querySelector('[data-v="chat"]').hidden = !hasChat;
    bar.querySelector('[data-v="notes"]').hidden = !notes;
  }
}

// ── layout ──
const style = document.createElement("style");
style.textContent = CSS;
document.head.append(style);

const $app = document.getElementById("app");
const ui = {
  dot: h("span", { class: "dot" }),
  title: h("h1", {}, "Meeting"),
  meta: h("div", { class: "meta" }),
  search: h("input", { type: "search", placeholder: "Filter transcript and chat  /", "aria-label": "Filter transcript and chat" }),
  img: h("img", { alt: "" }),
  cap: h("div", { class: "cap" }),
  strip: h("div", { class: "strip" }),
  sum: h("div", { class: "sum", hidden: true }),
  scroll: h("div", { class: "scroll" }),
  rows: h("div", { class: "rows" }),
  live: h("div", { class: "live" }),
  jump: h("button", { class: "jump", type: "button", hidden: true }, "↓ Jump to live"),
  cscroll: h("div", { class: "cscroll" }),
  chatRows: h("div", { class: "rows" }),
  chatNone: h("small", {}, "No chat yet"),
  nbody: h("div", { class: "nbody" }),
  empty: h("div", { class: "empty", hidden: true }),
  dialog: h("dialog", {}, h("img", { alt: "" })),
};
ui.scroll.append(ui.rows, ui.live);
ui.cscroll.append(ui.chatRows);
$app.append(
  h("header", {}, ui.dot, h("div", { class: "who" }, ui.title, ui.meta), ui.search, h("div", { class: "links" }, h("a", { class: "back", href: "/meetings" }, "All meetings"), h("a", { class: "back", href: "/" }, "Canvas"))),
  h(
    "main",
    {},
    h("section", { class: "stage" }, h("div", { class: "slide" }, h("div", { class: "frame" }, ui.img), ui.cap), ui.sum, ui.strip),
    h("section", { class: "tx" }, tabsBar(), ui.scroll, ui.jump),
    h("div", { class: "side" }, h("section", { class: "chat" }, tabsBar(), h("div", { class: "chat-h" }, "Chat", ui.chatNone), ui.cscroll), h("section", { class: "notes" }, tabsBar(), ui.nbody)),
    ui.empty,
  ),
  ui.dialog,
);

const slideUrl = (n, thumb) => `/meeting/${encodeURIComponent(id)}/slide/${n}${thumb ? ".thumb" : ""}.jpg`;
const slideOf = (n) => slides.find((s) => s.n === n);

// ── header ──
function renderHeader() {
  const st = state;
  ui.dot.className = `dot${st?.recording ? " rec" : ""}`;
  ui.jump.textContent = st && !st.recording ? "↓ Jump to end" : "↓ Jump to live";
  ui.title.textContent = st ? st.title || st.app || "Meeting" : "Meeting";
  document.title = st ? `${st.recording ? "● " : ""}${st.title || "Meeting"}` : "Meeting";
  const bits = [];
  if (!st) bits.push(h("span", {}, "No meeting"));
  else {
    bits.push(h("span", { class: `state${st.recording ? " rec" : ""}` }, st.recording ? "Live" : `${st.crashed ? "Stopped unexpectedly" : "Ended"}${dayOf(st.startedAt) ? ` · ${dayOf(st.startedAt)}` : ""}`));
    if (st.app) bits.push(h("span", {}, st.app));
    bits.push(h("span", {}, h("b", { class: "elapsed" }, elapsed())));
    if (people) bits.push(h("span", { title: people.people.join("\n") }, h("b", {}, people.count), people.count === 1 ? " person" : " people"));
    if (slides.length) bits.push(h("span", {}, h("b", {}, slides.length), slides.length === 1 ? " slide" : " slides"));
    if (st.startedAt) bits.push(h("span", {}, `started ${clock(st.startedAt)}`));
  }
  ui.meta.replaceChildren(...bits);
}
/** "Tue Oct 28" for a start time ("" when it won't parse). */
const dayOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "" : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${d.getDate()}`;
};
function elapsed() {
  const st = state;
  if (!st) return "";
  if (st.ended && st.duration) return st.duration;
  const end = st.ended ? Date.parse(st.endedAt) : Date.now();
  return span(end - Date.parse(st.startedAt));
}
setInterval(() => {
  const el = ui.meta.querySelector(".elapsed");
  if (el && state?.recording) el.textContent = elapsed();
}, 1000);

// ── empty states ──
function renderEmpty() {
  const none = !state;
  ui.empty.hidden = !none;
  document.querySelector("main .tx").hidden = none;
  if (none) {
    document.body.classList.remove("has-notes", "has-chat", "has-side");
    if (view !== "tx") showView("tx");
  }
  document.body.classList.toggle("has-slides", !none && slides.length > 0);
  if (none) {
    ui.empty.replaceChildren(
      h("h2", {}, notFound ? "Meeting not found" : "No meeting"),
      h("div", {}, notFound ? "There is no saved meeting with that id." : "This page fills in by itself when meeting-capture starts a meeting."),
      h("div", {}, h("a", { class: "back", href: "/meetings" }, "All meetings →")),
    );
  }
}

// ── slides ──
function renderSlides() {
  document.body.classList.toggle("has-slides", Boolean(state) && slides.length > 0);
  if (!slides.length) return;
  const have = new Set([...ui.strip.children].map((b) => Number(b.dataset.n)));
  for (const s of slides) {
    if (have.has(s.n)) continue;
    ui.strip.append(
      h("button", { type: "button", "data-n": s.n, title: `Slide ${s.n} · ${clock(s.at)}`, onclick: () => pickSlide(s.n, true) }, h("img", { src: slideUrl(s.n, s.thumb), alt: `Slide ${s.n}`, loading: "lazy" }), h("span", {}, s.n), h("i", { hidden: true })),
    );
  }
  markRevisits();
  showSlide();
}
/** A thumbnail shown more than once gets ↺ and how many times it came back. */
function markRevisits() {
  for (const b of ui.strip.children) {
    const k = shownAgain.get(Number(b.dataset.n)) || 0;
    const i = b.querySelector("i");
    if (!i) continue;
    i.hidden = !k;
    i.textContent = k > 1 ? `↺${k}` : "↺";
    const t = summaries[b.dataset.n]?.title || "";
    b.title = `Slide ${b.dataset.n}${t ? ` · ${t}` : ""}${k ? ` · shown again ${k === 1 ? "once" : `${k} times`}` : ""}`;
    const img = b.querySelector("img");
    if (img) img.alt = t ? `Slide ${b.dataset.n}: ${t}` : `Slide ${b.dataset.n}`;
  }
}
/** The slide rows in the transcript say "▣ Slide 3 · <title>" once the slide has a summary (they are built before it arrives). */
function labelSlideRows() {
  for (const row of ui.rows.querySelectorAll(".row.slide-mark.slide")) {
    const lbl = row.querySelector(".lbl");
    const t = summaries[row.dataset.slide]?.title || "";
    if (lbl) lbl.textContent = `▣ Slide ${row.dataset.slide}${t ? ` · ${t}` : ""}`;
  }
}
/** The summary panel under the stage image: for the shown slide, or "Summarizing…" while the live meeting's newest slide has none yet. */
function renderSummary(n) {
  const sum = n != null ? summaries[n] : null;
  // Only while the copilot is summarizing slides for this meeting (slidesOn) and has not given up on this one (or hit its cap).
  const pending = !sum && n != null && Boolean(state?.recording && notes?.slidesOn) && !(notes.slidesFailed || []).includes(n) && n === slides[slides.length - 1]?.n;
  ui.sum.hidden = !sum && !pending;
  if (!sum) return void ui.sum.replaceChildren(...(pending ? [h("div", { class: "pending" }, "Summarizing…")] : []));
  ui.sum.replaceChildren(
    ...[
      sum.title ? h("div", { class: "st" }, sum.title) : null,
      sum.what ? h("p", {}, sum.what) : null,
      sum.why ? h("p", { class: "why" }, h("b", {}, "Why it matters: "), sum.why) : null,
      sum.points?.length ? h("ul", {}, sum.points.map((x) => h("li", {}, x))) : null,
      sum.numbers?.length ? h("div", { class: "nums" }, sum.numbers.map((x) => h("span", {}, x))) : null,
    ].filter(Boolean),
  );
}
function showSlide() {
  const n = pinned ?? (slideOf(onScreen) ? onScreen : slides[slides.length - 1]?.n);
  const s = slideOf(n);
  if (!s) return void renderSummary(null);
  renderSummary(s.n);
  const src = slideUrl(s.n, false);
  if (ui.img.getAttribute("src") !== src) (ui.img.src = src), (ui.img.alt = `Slide ${s.n}`);
  for (const b of ui.strip.children) b.classList.toggle("on", Number(b.dataset.n) === s.n);
  const on = ui.strip.querySelector("button.on");
  if (on && pinned == null) on.scrollIntoView({ block: "nearest", inline: "end" });
  ui.cap.replaceChildren(
    h("b", {}, `Slide ${s.n}`),
    h("span", {}, clock(s.at)),
    s.reason ? h("span", {}, s.reason) : null,
    h("span", { class: "grow" }),
    pinned != null ? h("button", { type: "button", onclick: () => pickSlide(null) }, "Follow the screen  f") : h("span", {}, state?.recording ? "following the screen" : ""),
  );
}
/** Pick a slide (null: follow the newest); jump: scroll the transcript to where it appeared. */
function pickSlide(n, jump = false) {
  pinned = n != null && n === onScreen && state?.recording ? null : n;
  showSlide();
  if (!jump || n == null) return;
  // Where it was last on screen: its newest marker (a revisit, or where it first appeared).
  const marks = ui.rows.querySelectorAll(`.row[data-slide="${n}"]`);
  const row = marks[marks.length - 1];
  if (row) {
    stick = false;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
  }
}
ui.img.addEventListener("click", () => {
  const big = ui.dialog.querySelector("img");
  big.src = ui.img.src;
  ui.dialog.showModal();
});
ui.dialog.addEventListener("click", () => ui.dialog.close());

// ── your name in the transcript ──
// Same rule as the copilot's: someone other than you says one of your name tokens as a whole word.
const nameParts = (name) => new Set(String(name).replace(/\(.*?\)/g, " ").split(/[^\p{L}'-]+/u).map((x) => x.toLowerCase()).filter((x) => x.length >= 3));
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A token another participant shares ("Eric" with an "Eric Smith" in the call) can't be you alone.
let nameKey = "";
let nameRes = [];
function setNames() {
  const me = notes?.me || [];
  const others = (people?.people || []).map(nameParts).filter((sp) => !me.length || !me.every((t) => sp.has(t)));
  const key = JSON.stringify([me, others.map((sp) => [...sp])]);
  if (key === nameKey) return false;
  nameKey = key;
  nameRes = me.filter((t) => !others.some((sp) => sp.has(t))).map((t) => new RegExp(`(^|[^\\p{L}])${escapeRe(t)}($|[^\\p{L}])`, "iu"));
  return true;
}
function saysMyName(speaker, text) {
  if (!nameRes.length) return false;
  const me = notes?.me || [];
  const sp = nameParts(speaker);
  if (me.every((t) => sp.has(t))) return false;
  return nameRes.some((re) => re.test(text));
}
// Rows are marked once per name key: a new row when it arrives, every row only when who "me" is changes.
function markMentions() {
  const all = setNames();
  for (const row of [...ui.rows.children, ...ui.chatRows.children]) {
    if (row.dataset.sp == null || (!all && row.dataset.mk === "1")) continue;
    row.dataset.mk = "1";
    row.classList.toggle("me", saysMyName(row.dataset.sp, row.dataset.tx || ""));
  }
}

// ── chat ──
/** text as nodes, with each http(s) URL in it a link; no markup is ever built from the text. */
function linkify(text) {
  const s = String(text);
  const out = [];
  // Not mid-word, and never across invisible format characters (bidi controls, zero-width): what you see is where it goes.
  const re = /(?<![\p{L}\p{N}])https?:\/\/[^\s<>"'\p{Cf}]+/giu;
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const count = (str, ch) => str.split(ch).length - 1;
  let at = 0;
  for (let m; (m = re.exec(s)); ) {
    let url = m[0];
    const joined = url.search(/,(?=https?:\/\/)/i); // "https://a.com,https://b.com" is two URLs
    if (joined > 0) {
      url = url.slice(0, joined);
      re.lastIndex = m.index + joined; // scan on from the comma, so the second URL is found too
    }
    for (;;) {
      const last = url.at(-1);
      if (last && ".,;:!?".includes(last)) url = url.slice(0, -1);
      else if (last && pairs[last] && count(url, last) > count(url, pairs[last])) url = url.slice(0, -1); // a closer only if it has no opener in the URL
      else break;
    }
    let ok = false;
    try {
      ok = /^https?:$/.test(new URL(url).protocol);
    } catch {}
    if (!ok) continue;
    if (m.index > at) out.push(s.slice(at, m.index));
    out.push(h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url));
    at = m.index + url.length;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}
function chatRow(e) {
  return h("div", { class: "row chat first" }, h("time", { datetime: e.ts }, clock(e.ts)), h("div", { class: "body" }, e.speaker ? h("span", { class: "sp", style: `color:${colorOf(e.speaker)}` }, e.speaker) : null, linkify(String(e.text ?? ""))));
}
function followChat() {
  if (cstick) ui.cscroll.scrollTop = ui.cscroll.scrollHeight;
}
ui.cscroll.addEventListener("scroll", () => {
  cstick = ui.cscroll.scrollHeight - ui.cscroll.scrollTop - ui.cscroll.clientHeight < 40;
});
/** The third column, the Chat tab and the "No chat yet" line follow what exists. */
function renderSide() {
  const has = Boolean(state);
  const chat = has && chatCount > 0;
  const notesOn = has && Boolean(notes);
  document.body.classList.toggle("has-chat", chat);
  document.body.classList.toggle("has-notes", notesOn);
  document.body.classList.toggle("has-side", chat || notesOn);
  ui.chatNone.hidden = chat;
  ui.cscroll.hidden = !chat;
  if ((view === "chat" && !chat) || (view === "notes" && !notesOn)) showView("tx");
  badge();
}

// ── transcript ──
function rowFor(e) {
  if (e.type === "chat") return chatRow(e);
  const t = h("time", { datetime: e.ts }, clock(e.ts));
  if (e.type === "caption") {
    const cont = e.speaker && e.speaker === lastSpeaker;
    lastSpeaker = e.speaker;
    return h("div", { class: `row caption ${cont ? "cont" : "first"}` }, t, h("div", { class: "body" }, !cont && e.speaker ? h("span", { class: "sp", style: `color:${colorOf(e.speaker)}` }, e.speaker) : null, e.text));
  }
  lastSpeaker = null;
  if (e.type === "slide" || e.type === "revisit") {
    const s = slideOf(e.n);
    return h(
      "div",
      { class: `row slide-mark ${e.type}`, "data-slide": e.n, title: "Show this slide", onclick: () => pickSlide(e.n) },
      t,
      h("div", { class: "body" }, s ? h("img", { src: slideUrl(e.n, s.thumb), alt: "", loading: "lazy" }) : null, h("span", { class: "lbl" }, e.type === "revisit" ? `↺ Back to slide ${e.n}` : `▣ Slide ${e.n}${summaries[e.n]?.title ? ` · ${summaries[e.n].title}` : ""}`)),
    );
  }
  if (e.type === "people") return h("div", { class: "row note" }, t, h("div", { class: "body", title: e.people.join("\n") }, `👥 ${e.count} in the meeting`));
  if (e.type === "stopped") return h("div", { class: "row note first" }, t, h("div", { class: "body" }, `■ Meeting ended${e.duration ? ` · ${e.duration}` : ""}`));
  return null;
}
const rowText = (e) => `${e.speaker || ""} ${e.text || ""} ${e.type === "slide" || e.type === "revisit" ? `slide ${e.n}` : ""}`.toLowerCase();

function appendEntries(list, base = 0) {
  const frag = document.createDocumentFragment();
  const cfrag = document.createDocumentFragment();
  for (const [k, e] of list.entries()) {
    if (e.type === "slide" || e.type === "revisit") onScreen = e.n;
    if (e.type === "revisit") shownAgain.set(e.n, (shownAgain.get(e.n) || 0) + 1);
    const row = rowFor(e);
    if (!row) continue;
    row.dataset.q = rowText(e);
    row.dataset.i = base + k;
    if (e.type === "caption" || e.type === "chat") {
      row.dataset.sp = e.speaker || "";
      row.dataset.tx = e.text || "";
      if (saysMyName(e.speaker || "", e.text || "")) row.classList.add("me");
    }
    if (filter && !row.dataset.q.includes(filter)) row.hidden = true;
    if (e.type === "chat") {
      cfrag.append(row);
      chatCount++;
      if (base > 0 && !chatShown() && !row.hidden) unread++;
    } else frag.append(row);
  }
  ui.rows.querySelector(".waiting")?.remove();
  ui.rows.append(frag);
  ui.chatRows.append(cfrag);
}
function renderLive() {
  ui.live.replaceChildren(
    ...live.map((l, i) =>
      h("div", { class: "row" }, h("time", {}, clock(l.ts)), h("div", { class: "body" }, l.speaker ? h("span", { class: "sp", style: `color:${colorOf(l.speaker)}` }, l.speaker) : null, l.text, i === live.length - 1 ? h("span", { class: "cursor" }, "▍") : null)),
    ),
  );
}
function resetTranscript() {
  entries = [];
  lastSpeaker = null;
  onScreen = null;
  shownAgain.clear();
  ui.rows.replaceChildren();
  ui.chatRows.replaceChildren();
  chatCount = 0;
  unread = 0;
  cstick = true;
  ui.strip.replaceChildren();
  ui.img.removeAttribute("src");
  pinned = null;
  stick = true;
}
function followBottom() {
  if (stick) ui.scroll.scrollTop = ui.scroll.scrollHeight;
  ui.jump.hidden = stick || !state;
}
ui.scroll.addEventListener("scroll", () => {
  stick = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 60;
  ui.jump.hidden = stick;
});
ui.jump.addEventListener("click", () => {
  stick = true;
  followBottom();
});

ui.search.addEventListener("input", () => {
  filter = ui.search.value.trim().toLowerCase();
  for (const row of [...ui.rows.children, ...ui.chatRows.children]) if (row.dataset.q != null) row.hidden = Boolean(filter) && !row.dataset.q.includes(filter);
  ui.live.hidden = Boolean(filter);
  if (!filter) followBottom();
});

// ── notes panel ──
const fmtAt = (iso) => (iso ? clock(iso).slice(0, 5) : "");
const section = (title, ...kids) => [h("h3", {}, title), ...kids];
// Long lists show the newest few first; "Show all" opens the rest. Open lists and expanded topics survive re-renders.
const NOTES_CAP = 3;
const openLists = new Set();
const openTopics = new Set();
// Items seen in an earlier render: a new one flashes once. The first render marks everything seen, without a flash.
const seenNotes = new Set();
let notesPrimed = false;
function newestList(key, items, item, empty, cls) {
  if (!items.length) return [h("div", { class: "none" }, empty)];
  const all = openLists.has(key);
  const shown = all ? items : items.slice(0, NOTES_CAP);
  const keyOf = (x) => `${key}\u0000${JSON.stringify(x)}`;
  const out = [h("ul", cls ? { class: cls } : {}, shown.map((x) => {
    const li = item(x);
    if (notesPrimed && !seenNotes.has(keyOf(x))) li.classList.add("fresh");
    return li;
  }))];
  for (const x of items) seenNotes.add(keyOf(x));
  if (items.length > NOTES_CAP) out.push(h("button", { type: "button", class: "more", onclick: () => { all ? openLists.delete(key) : openLists.add(key); renderNotes(); } }, all ? "Show fewer" : `Show all ${items.length}`));
  return out;
}
const topicItem = (t) => {
  const li = h("li", { class: `topic${openTopics.has(t.title) ? " full" : ""}`, title: openTopics.has(t.title) ? "Shorten" : "Show the whole summary" }, h("b", {}, t.title), t.summary ? ` ${t.summary}` : "");
  li.addEventListener("click", () => { openTopics.has(t.title) ? openTopics.delete(t.title) : openTopics.add(t.title); renderNotes(); });
  return li;
};
function renderNotes() {
  const n = notes;
  // The panel (below the Chat box in the third column, or a tab) is there only when a copilot is writing notes.
  const has = Boolean(state && n);
  renderSide();
  if (!has) {
    seenNotes.clear();
    notesPrimed = false;
    return void ui.nbody.replaceChildren();
  }
  const alerts = [...n.alerts].reverse();
  const mine = n.actions.filter((a) => a.mine).reverse();
  const count = (title, xs) => `${title}${xs.length ? ` · ${xs.length}` : ""}`;
  const out = [];
  out.push(...section(count("Alerts", alerts), ...(alerts.length ? [h("div", { class: "alerts" }, newestList("alerts", alerts, (a) => h("li", { class: "alert" }, a.at ? h("time", {}, fmtAt(a.at)) : null, h("b", {}, a.kind === "action" ? "✅" : "🔔", a.who ? ` ${a.who}: ` : " "), a.text), ""))] : [h("div", { class: "none" }, "Nothing yet. A name said, or a new action on you.")])));
  out.push(...section(count("Your action items", mine), ...newestList("mine", mine, (a) => h("li", {}, a.what, a.at ? h("small", {}, ` · ${fmtAt(a.at)}`) : null), "None")));
  out.push(...section(count("Decisions", n.decisions), ...newestList("decisions", [...n.decisions].reverse(), (d) => h("li", {}, d.text, d.at ? h("small", {}, ` · ${fmtAt(d.at)}`) : null), "None yet")));
  out.push(...section(count("Topics", n.topics), ...newestList("topics", [...n.topics].reverse(), topicItem, "None yet", "topics")));
  const sums = Object.keys(summaries).map(Number).sort((a, b) => a - b);
  if (sums.length) out.push(...section("Slides", h("ul", { class: "slidelist" }, sums.map((k) => h("li", {}, h("button", { type: "button", title: "Show this slide", onclick: () => pickSlide(k) }, `${k}. ${summaries[k].title || summaries[k].what}`))))));
  if (n.questions.length) out.push(...section("Questions worth asking", ...newestList("questions", [...n.questions].reverse(), (q) => h("li", {}, q.q, q.why ? h("small", {}, ` — ${q.why}`) : null), "")));
  out.push(...section("Suggested reply", n.reply ? h("div", { class: "reply" }, h("small", {}, `${n.reply.to ? `${n.reply.to} is waiting on you` : "Someone is waiting on you"}${n.reply.at ? ` · ${fmtAt(n.reply.at)}` : ""}`), n.reply.text) : h("div", { class: "none" }, "Nobody is waiting on you.")));
  out.push(h("div", { class: "foot" }, `${n.ended ? "Final notes" : "Updated"} ${fmtAt(n.at)}${n.session ? ` · from the “${n.session}” session` : ""}`));
  ui.nbody.replaceChildren(...out);
  notesPrimed = true;
}
showView("tx");

// ── data ──
function apply(d) {
  if (d.id !== id || d.from !== entries.length) {
    resetTranscript();
    id = d.id;
    if (wanted && d.state && !d.state.recording) stick = cstick = false; // a past meeting opens at the top
    if (d.from !== 0) return void (id = ""), pull(); // out of step: start over
  }
  notFound = Boolean(d.notFound);
  state = d.state;
  slides = d.slides || [];
  people = d.people;
  notes = d.notes || null;
  summaries = d.summaries && typeof d.summaries === "object" ? d.summaries : {};
  live = state?.recording ? d.live || [] : [];
  renderEmpty();
  renderSlides();
  if (d.entries.length) {
    const base = entries.length;
    entries.push(...d.entries);
    appendEntries(d.entries, base);
    markRevisits();
    showSlide();
  }
  if (state && !entries.length && !ui.rows.querySelector(".waiting")) ui.rows.append(h("div", { class: "waiting" }, state.recording ? "Waiting for the first caption…" : "No transcript was written."));
  labelSlideRows();
  renderLive();
  renderHeader();
  renderNotes();
  markMentions();
  if (!jumpToEntry()) followBottom();
  followChat();
}

/** #e<n>: scroll that transcript or chat entry into view and flash it, once, as soon as it is loaded. */
function jumpToEntry() {
  if (jumpTo == null) return false;
  const q = `.row[data-i="${jumpTo}"]`;
  const row = ui.rows.querySelector(q) || ui.chatRows.querySelector(q);
  if (!row) return false;
  jumpTo = null;
  if (row.hidden) return false;
  if (row.classList.contains("chat")) {
    cstick = false;
    showView("chat"); // below 1400 px the Chat tab comes up
  } else {
    stick = false;
    ui.jump.hidden = false;
  }
  row.scrollIntoView({ block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth;
  row.classList.add("flash");
  return true;
}

let inflight = false;
let again = false;
async function pull() {
  if (inflight) return void (again = true);
  inflight = true;
  try {
    const r = await fetch(`/api/meeting?since=${entries.length}&id=${encodeURIComponent(wanted)}&cur=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (r.ok) apply(await r.json());
  } catch {}
  inflight = false;
  if (again) (again = false), pull();
}

// ── keys ──
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target === ui.search) {
    if (e.key === "Escape") (ui.search.value = ""), ui.search.dispatchEvent(new Event("input")), ui.search.blur();
    return;
  }
  if (e.key === "/") (e.preventDefault(), ui.search.focus());
  else if (e.key === "f") pickSlide(null);
  else if (e.key === "End" || e.key === "G") (stick = true), followBottom();
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && slides.length) {
    const cur = slides.findIndex((s) => s.n === (pinned ?? slides[slides.length - 1].n));
    const next = slides[Math.max(0, Math.min(slides.length - 1, cur + (e.key === "ArrowLeft" ? -1 : 1)))];
    if (next) pickSlide(next.n, true);
  }
});

// One stream (the daemon's), a "meeting" event per change; hello after a daemon restart.
const es = new EventSource("/api/events");
es.addEventListener("meeting", pull);
es.addEventListener("hello", pull);
setInterval(pull, 5000);
pull();
