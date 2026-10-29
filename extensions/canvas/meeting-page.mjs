// The live meeting page (/meeting): meeting-capture's transcript as it is
// written, with the shared screen's slides. The daemon (meeting-feed.mjs)
// tails the files; this page asks /api/meeting for what's new on each
// "meeting" event and appends it. Nothing here loads from the network.

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
.row.chat .body { background: var(--soft); border-radius: 6px; padding: 2px 8px; }
.row.chat .tag { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--dim); margin-right: 6px; }
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
dialog { border: 0; padding: 0; background: transparent; max-width: 96vw; max-height: 96vh; }
dialog::backdrop { background: rgb(0 0 0 / .8); }
dialog img { display: block; max-width: 96vw; max-height: 96vh; }
@media (max-width: 900px) {
  main { flex-direction: column; }
  .stage { flex: none; max-height: 48vh; border-right: 0; border-bottom: 1px solid var(--line); }
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
let filter = "";

// ── layout ──
const style = document.createElement("style");
style.textContent = CSS;
document.head.append(style);

const $app = document.getElementById("app");
const ui = {
  dot: h("span", { class: "dot" }),
  title: h("h1", {}, "Meeting"),
  meta: h("div", { class: "meta" }),
  search: h("input", { type: "search", placeholder: "Filter transcript  /", "aria-label": "Filter transcript" }),
  img: h("img", { alt: "" }),
  cap: h("div", { class: "cap" }),
  strip: h("div", { class: "strip" }),
  scroll: h("div", { class: "scroll" }),
  rows: h("div", { class: "rows" }),
  live: h("div", { class: "live" }),
  jump: h("button", { class: "jump", type: "button", hidden: true }, "↓ Jump to live"),
  empty: h("div", { class: "empty", hidden: true }),
  dialog: h("dialog", {}, h("img", { alt: "" })),
};
ui.scroll.append(ui.rows, ui.live);
$app.append(
  h("header", {}, ui.dot, h("div", { class: "who" }, ui.title, ui.meta), ui.search, h("a", { class: "back", href: "/" }, "Canvas")),
  h(
    "main",
    {},
    h("section", { class: "stage" }, h("div", { class: "slide" }, h("div", { class: "frame" }, ui.img), ui.cap), ui.strip),
    h("section", { class: "tx" }, ui.scroll, ui.jump),
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
  ui.title.textContent = st ? st.title || st.app || "Meeting" : "Meeting";
  document.title = st ? `${st.recording ? "● " : ""}${st.title || "Meeting"}` : "Meeting";
  const bits = [];
  if (!st) bits.push(h("span", {}, "No meeting"));
  else {
    bits.push(h("span", { class: `state${st.recording ? " rec" : ""}` }, st.recording ? "Live" : st.crashed ? "Stopped unexpectedly" : "Ended"));
    if (st.app) bits.push(h("span", {}, st.app));
    bits.push(h("span", {}, h("b", { class: "elapsed" }, elapsed())));
    if (people) bits.push(h("span", { title: people.people.join("\n") }, h("b", {}, people.count), people.count === 1 ? " person" : " people"));
    if (slides.length) bits.push(h("span", {}, h("b", {}, slides.length), slides.length === 1 ? " slide" : " slides"));
    if (st.startedAt) bits.push(h("span", {}, `started ${clock(st.startedAt)}`));
  }
  ui.meta.replaceChildren(...bits);
}
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
  document.body.classList.toggle("has-slides", !none && slides.length > 0);
  if (none) ui.empty.replaceChildren(h("h2", {}, "No meeting"), h("div", {}, "This page fills in by itself when meeting-capture starts a meeting."));
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
    b.title = `Slide ${b.dataset.n}${k ? ` · shown again ${k === 1 ? "once" : `${k} times`}` : ""}`;
  }
}
function showSlide() {
  const n = pinned ?? (slideOf(onScreen) ? onScreen : slides[slides.length - 1]?.n);
  const s = slideOf(n);
  if (!s) return;
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

// ── transcript ──
function rowFor(e) {
  const t = h("time", { datetime: e.ts }, clock(e.ts));
  if (e.type === "caption") {
    const cont = e.speaker && e.speaker === lastSpeaker;
    lastSpeaker = e.speaker;
    return h("div", { class: `row caption ${cont ? "cont" : "first"}` }, t, h("div", { class: "body" }, !cont && e.speaker ? h("span", { class: "sp", style: `color:${colorOf(e.speaker)}` }, e.speaker) : null, e.text));
  }
  lastSpeaker = null;
  if (e.type === "chat") return h("div", { class: "row chat first" }, t, h("div", { class: "body" }, h("span", { class: "tag" }, "chat"), e.speaker ? h("span", { class: "sp", style: `color:${colorOf(e.speaker)}` }, e.speaker) : null, e.text));
  if (e.type === "slide" || e.type === "revisit") {
    const s = slideOf(e.n);
    return h(
      "div",
      { class: `row slide-mark ${e.type}`, "data-slide": e.n, title: "Show this slide", onclick: () => pickSlide(e.n) },
      t,
      h("div", { class: "body" }, s ? h("img", { src: slideUrl(e.n, s.thumb), alt: "", loading: "lazy" }) : null, h("span", {}, e.type === "revisit" ? `↺ Back to slide ${e.n}` : `▣ Slide ${e.n}`)),
    );
  }
  if (e.type === "people") return h("div", { class: "row note" }, t, h("div", { class: "body", title: e.people.join("\n") }, `👥 ${e.count} in the meeting`));
  if (e.type === "stopped") return h("div", { class: "row note first" }, t, h("div", { class: "body" }, `■ Meeting ended${e.duration ? ` · ${e.duration}` : ""}`));
  return null;
}
const rowText = (e) => `${e.speaker || ""} ${e.text || ""} ${e.type === "slide" || e.type === "revisit" ? `slide ${e.n}` : ""}`.toLowerCase();

function appendEntries(list) {
  const frag = document.createDocumentFragment();
  for (const e of list) {
    if (e.type === "slide" || e.type === "revisit") onScreen = e.n;
    if (e.type === "revisit") shownAgain.set(e.n, (shownAgain.get(e.n) || 0) + 1);
    const row = rowFor(e);
    if (!row) continue;
    row.dataset.q = rowText(e);
    if (filter && !row.dataset.q.includes(filter)) row.hidden = true;
    frag.append(row);
  }
  ui.rows.querySelector(".waiting")?.remove();
  ui.rows.append(frag);
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
  for (const row of ui.rows.children) if (row.dataset.q != null) row.hidden = Boolean(filter) && !row.dataset.q.includes(filter);
  ui.live.hidden = Boolean(filter);
  if (!filter) followBottom();
});

// ── data ──
function apply(d) {
  if (d.id !== id || d.from !== entries.length) {
    resetTranscript();
    id = d.id;
    if (d.from !== 0) return void (id = ""), pull(); // out of step: start over
  }
  state = d.state;
  slides = d.slides || [];
  people = d.people;
  live = state?.recording ? d.live || [] : [];
  renderEmpty();
  renderSlides();
  if (d.entries.length) {
    entries.push(...d.entries);
    appendEntries(d.entries);
    markRevisits();
    showSlide();
  }
  if (state && !entries.length && !ui.rows.querySelector(".waiting")) ui.rows.append(h("div", { class: "waiting" }, state.recording ? "Waiting for the first caption…" : "No transcript was written."));
  renderLive();
  renderHeader();
  followBottom();
}

let inflight = false;
let again = false;
async function pull() {
  if (inflight) return void (again = true);
  inflight = true;
  try {
    const r = await fetch(`/api/meeting?since=${entries.length}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
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
