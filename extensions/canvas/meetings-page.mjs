// The meetings browser (/meetings): every meeting meeting-capture has saved,
// newest first and grouped by day, with the live one pinned on top, and a search
// across titles, people, the copilot's notes and the transcripts themselves.
// The daemon (meeting-feed.mjs) lists and searches; each row opens /meeting?id=,
// a search line opens it at that line (#e<index>). Nothing loads from the network,
// and every piece of text from the data goes in as a text node.

const CSS = `
:root { color-scheme: light dark; --bg:#f7f5f0; --card:#fff; --ink:#1c1b19; --dim:#8a8578; --line:#e6e1d6; --soft:#f0ece3; --accent:#b4541f; --ok:#1f7a52; --warn:#a86a00; --bad:#c0392b; }
@media (prefers-color-scheme: dark) { :root { --bg:#1f1e1c; --card:#282725; --ink:#ecebe7; --dim:#9a958a; --line:#3a3834; --soft:#312f2c; --accent:#e08a5a; --ok:#5cc495; --warn:#e2b257; --bad:#ef6f5e; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
#app { height: 100%; display: flex; flex-direction: column; }
header { flex: none; display: flex; align-items: center; gap: 12px; padding: 10px 18px; border-bottom: 1px solid var(--line); background: var(--card); }
header h1 { margin: 0; font-size: 16px; font-weight: 600; flex: 1; }
header input { font: inherit; font-size: 13px; padding: 5px 9px; width: min(320px, 50vw); border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
header a.back { color: var(--dim); font-size: 12.5px; text-decoration: none; }
header a.back:hover { color: var(--accent); }
main { flex: 1; min-height: 0; overflow-y: auto; }
.col { max-width: 860px; margin: 0 auto; padding: 14px 18px 40px; }
.day { margin: 22px 0 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); }
.day:first-child { margin-top: 4px; }
.item { margin: 0 0 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); overflow: hidden; }
.item:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); }
.mrow { display: flex; gap: 12px; padding: 10px 12px; color: inherit; text-decoration: none; align-items: flex-start; }
.mrow .thumb { flex: none; width: 96px; height: 60px; border-radius: 5px; background: var(--soft); object-fit: cover; }
.mrow .nothumb { flex: none; width: 96px; height: 60px; border-radius: 5px; background: var(--soft); display: flex; align-items: center; justify-content: center; color: var(--dim); font-size: 20px; }
.mrow .info { min-width: 0; flex: 1; }
.mrow .t { font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.mrow .sub { color: var(--dim); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 0 6px; }
.mrow .star { color: var(--warn); font-weight: 600; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.tags span { font-size: 11.5px; padding: 1px 7px; border-radius: 10px; background: var(--soft); color: var(--dim); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live { border-color: color-mix(in srgb, var(--ok) 55%, var(--line)); margin-bottom: 4px; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--ok); margin-right: 6px; vertical-align: 1px; animation: rec 1.6s infinite; }
@keyframes rec { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent); } 70%, 100% { box-shadow: 0 0 0 7px transparent; } }
.livebar { color: var(--ok); font-weight: 600; font-size: 12.5px; }
.livebar b { font-variant-numeric: tabular-nums; }
.hits { border-top: 1px solid var(--line); padding: 4px 12px 8px; background: color-mix(in srgb, var(--soft) 55%, transparent); }
.hit { display: grid; grid-template-columns: 52px 1fr; gap: 0 10px; padding: 3px 6px; margin: 1px -6px; border-radius: 5px; color: inherit; text-decoration: none; font-size: 13px; }
.hit:hover { background: var(--soft); }
.hit time { color: var(--dim); font: 11.5px/1.9 ui-monospace, SFMono-Regular, Menlo, monospace; }
.hit .sp { font-weight: 600; margin-right: 6px; }
.hit .tag { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--dim); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; margin-right: 6px; }
.hits .more { color: var(--dim); font-size: 12px; padding: 2px 0 0 62px; }
mark { background: color-mix(in srgb, var(--warn) 32%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }
.fields { color: var(--dim); font-size: 11.5px; }
.msg { color: var(--dim); text-align: center; padding: 48px 12px; }
.msg h2 { color: var(--ink); font-size: 17px; font-weight: 600; margin: 0 0 6px; }
button.more-btn { display: block; margin: 14px auto 0; font: 500 13px/1 -apple-system, BlinkMacSystemFont, sans-serif; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
button.more-btn:hover { border-color: var(--accent); }
.sum { color: var(--dim); font-size: 12.5px; margin: 2px 0 10px; }
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
const hm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const hms = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Tue Oct 28" (the same in every locale). */
const dayName = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
/** "Today", "Yesterday", else "Tue Oct 28". */
function dayLabel(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "Earlier";
  if (dayKey(d) === dayKey(now)) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return "Yesterday";
  return dayName(d);
}
/** "1:02:03" → "1h 02m", "0:32:10" → "32m", under a minute "<1m". */
function dur(s) {
  const m = /^(\d+):(\d\d):(\d\d)$/.exec(String(s || ""));
  if (!m) return "";
  const hrs = Number(m[1]);
  const min = Number(m[2]);
  if (hrs) return `${hrs}h ${pad(min)}m`;
  return min ? `${min}m` : "<1m";
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const elapsed = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return "";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** text with the query's terms wrapped in <mark>, all as nodes. */
function highlight(text, terms) {
  if (!terms.length) return [String(text)];
  const re = new RegExp(`(${terms.map(escapeRe).join("|")})`, "gi");
  const out = [];
  String(text)
    .split(re)
    .forEach((part, i) => {
      if (!part) return;
      out.push(i % 2 ? h("mark", {}, part) : part);
    });
  return out;
}
const termsOf = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const href = (id, hash = "") => `/meeting?id=${encodeURIComponent(id)}${hash}`;
const thumbUrl = (id) => `/meeting/${encodeURIComponent(id)}/slide/1.thumb.jpg`;

// ── layout ──
const style = document.createElement("style");
style.textContent = CSS;
document.head.append(style);
document.title = "Meetings";

const ui = {
  search: h("input", { type: "search", placeholder: "Search meetings  /", "aria-label": "Search meetings", autocomplete: "off" }),
  col: h("div", { class: "col" }),
};
document.getElementById("app").append(h("header", {}, h("h1", {}, "Meetings"), ui.search, h("a", { class: "back", href: "/" }, "Canvas")), h("main", {}, ui.col));

// ── state ──
let meetings = [];
let liveId = null;
let more = false;
let loaded = false;
let partial = false; // the daemon is still reading older meetings
let partialTimer = 0;
let searchNote = ""; // "Showing results from the newest N meetings." when a search stopped early
let query = "";
let results = null; // search results, or null
let seq = 0; // a newer request wins

// ── rows ──
function metaLine(m) {
  const bits = [];
  if (m.app) bits.push(m.app);
  bits.push(hm(m.started_at));
  const d = dur(m.duration);
  if (d) bits.push(d);
  if (m.people) bits.push(plural(m.people, "person", "people"));
  if (m.slides) bits.push(plural(m.slides, "slide"));
  const out = bits.filter(Boolean).map((b, i) => h("span", {}, i ? `· ${b}` : b));
  if (m.notes?.mine) out.push(h("span", { class: "star", title: "Action items for you" }, `★ ${m.notes.mine}`));
  return h("div", { class: "sub" }, out);
}
function rowFor(m) {
  const topics = m.notes?.topics || [];
  return h(
    "a",
    { class: "mrow", href: href(m.id) },
    m.thumb ? h("img", { class: "thumb", src: thumbUrl(m.id), alt: "", loading: "lazy" }) : h("div", { class: "nothumb" }, "▤"),
    h("div", { class: "info" }, h("div", { class: "t" }, m.title || m.app || "Meeting"), metaLine(m), topics.length ? h("div", { class: "tags" }, topics.slice(0, 4).map((t) => h("span", { title: t }, t))) : null),
  );
}
function liveBox(m) {
  return h(
    "div",
    { class: "item live" },
    h(
      "a",
      { class: "mrow", href: "/meeting" },
      m.thumb ? h("img", { class: "thumb", src: thumbUrl(m.id), alt: "", loading: "lazy" }) : h("div", { class: "nothumb" }, "▤"),
      h(
        "div",
        { class: "info" },
        h("div", { class: "livebar" }, h("span", { class: "dot" }), "Live ", h("b", { class: "elapsed", "data-start": m.started_at }, elapsed(m.started_at))),
        h("div", { class: "t" }, m.title || m.app || "Meeting"),
        h("div", { class: "sub" }, [m.app, m.people ? plural(m.people, "person", "people") : ""].filter(Boolean).map((b, i) => h("span", {}, i ? `· ${b}` : b))),
      ),
    ),
  );
}
function resultFor(r, terms) {
  const lines = r.lines || [];
  return h(
    "div",
    { class: "item" },
    rowFor(r),
    lines.length || r.fields?.some((f) => f !== "transcript" && f !== "chat")
      ? h(
          "div",
          { class: "hits" },
          r.fields?.some((f) => f !== "transcript" && f !== "chat") ? h("div", { class: "fields" }, `Matches ${r.fields.filter((f) => f !== "transcript" && f !== "chat").join(", ")}`) : null,
          lines.map((l) =>
            h("a", { class: "hit", href: href(r.id, `#e${l.i}`) }, h("time", {}, hms(l.ts)), h("div", {}, l.type === "chat" ? h("span", { class: "tag" }, "chat") : null, l.speaker ? h("span", { class: "sp" }, l.speaker) : null, highlight(l.text, terms))),
          ),
          r.hits > lines.length ? h("div", { class: "more" }, `+${r.hits - lines.length} more`) : null,
        )
      : null,
  );
}

// ── render ──
function render() {
  if (results) {
    const terms = termsOf(query);
    if (!results.length) return ui.col.replaceChildren(h("div", { class: "msg" }, h("h2", {}, "No meetings match"), `Nothing for “${query}”.`, searchNote ? h("div", {}, searchNote) : null));
    return ui.col.replaceChildren(h("div", { class: "sum" }, `${plural(results.length, "meeting")} match`), searchNote ? h("div", { class: "sum" }, searchNote) : null, ...results.map((r) => resultFor(r, terms)));
  }
  if (!loaded) return ui.col.replaceChildren(h("div", { class: "msg" }, "Loading…"));
  if (!meetings.length) return ui.col.replaceChildren(h("div", { class: "msg" }, h("h2", {}, "No meetings yet"), "They show up here once meeting-capture has saved one."));
  const out = [];
  const live = liveId ? meetings.find((m) => m.id === liveId) : null;
  if (live) out.push(liveBox(live));
  let day = "";
  for (const m of meetings) {
    if (live && m.id === live.id) continue;
    const label = dayLabel(m.started_at);
    if (label !== day) {
      day = label;
      out.push(h("div", { class: "day" }, label));
    }
    out.push(h("div", { class: "item" }, rowFor(m)));
  }
  if (partial) out.push(h("div", { class: "sum" }, "Still reading older meetings…"));
  if (more) out.push(h("button", { class: "more-btn", type: "button", onclick: () => load(true) }, "Load more"));
  ui.col.replaceChildren(...out);
}
setInterval(() => {
  for (const el of document.querySelectorAll(".elapsed[data-start]")) el.textContent = elapsed(el.dataset.start);
}, 1000);

// ── data ──
// Refreshing re-reads as many rows as are on screen (in pages of 100); Load more appends the next 50.
async function load(append = false) {
  const my = ++seq;
  let d = null;
  const got = [];
  try {
    const want = append ? 50 : Math.max(50, meetings.length);
    const start = append ? meetings.length : 0;
    do {
      const r = await fetch(`/api/meetings?offset=${start + got.length}&limit=${Math.min(100, want - got.length)}`, { cache: "no-store" });
      if (!r.ok || my !== seq) return;
      d = await r.json();
      got.push(...d.meetings);
    } while (d.more && d.meetings.length && got.length < want);
    // A new meeting shifts the list under an offset: rows seen twice are dropped.
    const base = append ? meetings : [];
    const seen = new Set(base.map((m) => m.id));
    meetings = [...base, ...got.filter((m) => !seen.has(m.id) && seen.add(m.id))];
    liveId = d.live || null;
    more = Boolean(d.more);
    partial = Boolean(d.partial);
    loaded = true;
  } catch {}
  // A big archive is read a bit at a time: ask again until the daemon has it all.
  if (partial && my === seq && !partialTimer) partialTimer = setTimeout(() => ((partialTimer = 0), results ? null : load()), 1000);
  if (my === seq && !results) render();
}
async function runSearch() {
  const q = ui.search.value.trim().slice(0, 200); // the daemon cuts the query at 200 and echoes that
  query = q;
  if (q.length < 2) {
    seq++;
    results = null;
    searchNote = "";
    render();
    if (partial) load(); // the re-poll was skipped while results showed: go on reading the archive
    return;
  }
  const my = ++seq;
  try {
    const r = await fetch(`/api/meetings/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
    if (!r.ok || my !== seq) return;
    const d = await r.json();
    if (d.q !== q) return;
    results = d.results || [];
    searchNote = d.partial ? `Showing results from the newest ${plural(Number(d.searched) || 0, "meeting")}.` : "";
  } catch {
    return;
  }
  render();
}
let timer = 0;
ui.search.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(runSearch, 200);
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target === ui.search) {
    if (e.key === "Escape") {
      ui.search.value = "";
      clearTimeout(timer);
      void runSearch();
      ui.search.blur();
    }
    return;
  }
  if (e.key === "/") (e.preventDefault(), ui.search.focus());
});

// A new or ended meeting is a "final" meeting event; refresh the list (not while searching).
const es = new EventSource("/api/events");
let refresh = 0;
es.addEventListener("meeting", (e) => {
  let d = {};
  try {
    d = JSON.parse(e.data);
  } catch {}
  if (!d.final || refresh) return;
  refresh = setTimeout(() => ((refresh = 0), results ? null : load()), 2000);
});
es.addEventListener("hello", () => {
  if (!results) load();
});
render();
load();
