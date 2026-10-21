/**
 * Tests for extensions/canvas/render.mjs: the renderers the canvas page and
 * botsun's chat bubbles share. No browser and no network: jsdom stands in for
 * the page, and marked/DOMPurify/hljs are stubbed (the hosts supply the real
 * ones as globals).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import * as render from "../extensions/canvas/render.mjs";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter; // markRanges walks text nodes
// renderKanban asks whether text is selected before opening a card (a browser global).
globalThis.getSelection = () => "";
// renderTerminal scrolls a running body into view one frame later (a browser global).
globalThis.requestAnimationFrame = (fn) => fn();
// renderChart sizes itself from its container; jsdom never lays out, so it needs a stub.
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const tag = (el) => el.tagName.toLowerCase();
const text = (el) => el.textContent;

test("render.mjs exports the shared renderers, with no DOM at import time", () => {
  for (const name of [
    "h",
    "svg",
    "tip",
    "renderMarkdown",
    "renderTable",
    "renderChart",
    "sparkSvg",
    "niceScale",
    "fmtValue",
    "drawXY",
    "drawPie",
    "seriesColor",
    "textW",
    "clip",
    "renderStats",
    "renderSteps",
    "renderTimeline",
    "renderJson",
    "renderCode",
    "renderTree",
    "renderOptions",
    "renderKanban",
    "renderTracker",
    "renderTerminal",
    "renderDiff",
    "renderMermaid",
    "parsePatch",
    "diffBlock",
    "diffFileList",
    "langFor",
    "counts",
    "inline",
    "noteParas",
    "toneVar",
    "tilde",
    "clock",
    "dayLabel",
  ])
    assert.equal(typeof render[name], "function", name);
  assert.ok(render.NAMED.has("accent"), "named colours");
  assert.equal(render.TAG_TONE.length, 3, "tag tones");
  assert.equal(render.STATUS.added, "new", "diff statuses");
  assert.ok(render.BIG_FILE > 0, "the big-file cutoff");
});

test("h builds elements with attributes, listeners and children", () => {
  let clicked = 0;
  const el = render.h("div", { class: "x", title: "t", hidden: false, onclick: () => clicked++ }, "a", null, ["b", 1]);
  assert.equal(el.className, "x");
  assert.equal(el.getAttribute("title"), "t");
  assert.equal(el.hasAttribute("hidden"), false, "null and false are skipped");
  assert.equal(text(el), "ab1");
  el.dispatchEvent(new dom.window.Event("click"));
  assert.equal(clicked, 1);
});

test("fmtValue follows the axis: prefix, unit, compact numbers", () => {
  assert.equal(render.fmtValue(1234.567), "1,234.57");
  assert.equal(render.fmtValue(1234567, { prefix: "$" }), "$1.2M");
  assert.equal(render.fmtValue(42, { unit: "%" }), "42%");
  assert.equal(render.fmtValue(42, { unit: "rows" }, true), "42", "a long unit is dropped on ticks");
});

test("niceScale picks round steps that cover the range", () => {
  const s = render.niceScale(0, 97, 5);
  assert.ok(s.lo <= 0 && s.hi >= 97);
  assert.deepEqual(s.ticks, [0, 20, 40, 60, 80, 100]);
});

test("sparkSvg draws a line with a dot, and null for too few points", () => {
  assert.equal(render.sparkSvg([1]), null);
  const el = render.sparkSvg([1, null, 3, 2]);
  assert.equal(tag(el), "svg");
  assert.equal(el.getAttribute("class"), "spark");
  assert.equal(el.querySelectorAll("path").length, 1, "one path, broken at the gap");
  assert.equal(el.querySelectorAll("circle").length, 1);
});

test("drawXY draws gridlines, bars and their tooltips", () => {
  const el = render.drawXY({ type: "bar", labels: ["a", "b"], series: [{ name: "s", data: [3, 5] }], y: { label: "n" } }, 300);
  assert.equal(tag(el), "svg");
  assert.ok(el.querySelectorAll("rect.bar").length === 2);
  assert.match(text(el), /a · s: 3/, "the bar's title");
  const lines = render.drawXY({ type: "line", labels: ["a", "b", "c"], series: [{ data: [1, null, 3] }] }, 300);
  assert.equal(lines.querySelectorAll("path.line").length, 2, "a gap splits the line");
  const scatter = render.drawXY({ type: "scatter", series: [{ data: [[1, 2]] }] }, 300);
  assert.equal(scatter.querySelectorAll("circle.pt").length, 1);
});

test("drawPie slices the total, and a donut leaves a hole", () => {
  const pie = render.drawPie({ type: "pie", labels: ["a", "b"], series: [{ data: [1, 1] }] }, 240);
  assert.equal(pie.querySelectorAll("path.slice").length, 2);
  assert.match(text(pie), /a: /);
  const donut = render.drawPie({ type: "donut", labels: ["a", "b"], series: [{ data: [1, 1] }], y: { unit: "%" } }, 240);
  assert.match(text(donut), /total/);
});

test("renderChart wraps the plot in a figure with a legend and caption", () => {
  const el = render.renderChart({ type: "bar", labels: ["a"], series: [{ name: "one", data: [1] }, { name: "two", data: [2] }], caption: "cap" });
  assert.equal(tag(el), "figure");
  assert.ok(el.querySelector(".chart-plot"));
  assert.deepEqual([...el.querySelectorAll(".chart-legend span")].map(text), ["one", "two"]);
  assert.equal(text(el.querySelector("figcaption")), "cap");
  const pie = render.renderChart({ type: "pie", labels: ["a"], series: [{ data: [1] }] });
  assert.match(text(pie.querySelector(".chart-legend")), /100%/, "a pie's legend carries the share");
});

test("renderTable sorts, tones tags, bars numbers and pages long tables", () => {
  const el = render.renderTable({
    columns: ["name", { key: "state", type: "tag" }, { key: "n", type: "bar" }],
    rows: [
      ["a", "ok", 3],
      ["b", "failed", 9],
      ["c", "pending", 6],
    ],
    caption: "cap",
  });
  assert.equal(tag(el), "div");
  assert.equal(el.className, "tbl");
  assert.equal(el.querySelector("table").className, "ktable");
  assert.equal(el.querySelectorAll("tbody tr").length, 3);
  assert.deepEqual([...el.querySelectorAll(".ctag")].map((x) => x.className), ["ctag ok", "ctag bad", "ctag warn"]);
  assert.equal(el.querySelectorAll(".cbar i").length, 3, "a bar per row");
  assert.equal(text(el.querySelector("figcaption, .chart-cap")), "cap");
  // Clicking a header sorts it: numbers high-first, then A-Z, then off. The
  // header is redrawn on each click, so ask for the new button every time.
  const th = () => el.querySelectorAll("th button")[2];
  const names = () => [...el.querySelectorAll("tbody tr td:first-child")].map(text);
  th().dispatchEvent(new dom.window.Event("click"));
  assert.deepEqual(names(), ["b", "c", "a"]);
  assert.equal(el.querySelectorAll("th")[2].getAttribute("aria-sort"), "descending");
  th().dispatchEvent(new dom.window.Event("click"));
  assert.deepEqual(names(), ["a", "c", "b"]);
  th().dispatchEvent(new dom.window.Event("click"));
  assert.deepEqual(names(), ["a", "b", "c"], "off is the original order");
  assert.equal(el.querySelectorAll("th")[2].getAttribute("aria-sort"), "none");
});

test("renderTable guesses column types and filters rows", () => {
  const el = render.renderTable({ rows: [{ name: "alpha", n: 1 }, { name: "beta", n: 2 }] });
  assert.deepEqual([...el.querySelectorAll("thead th")].map(text), ["name↕", "n↕"]);
  assert.equal(el.querySelectorAll("td.num").length, 2, "a numbers column");
  const filter = el.querySelector(".tbl-filter");
  assert.equal(filter, null, "few rows, no filter");
  const big = render.renderTable({ columns: ["n"], rows: Array.from({ length: 9 }, (_, i) => [i]) });
  const f = big.querySelector(".tbl-filter");
  f.value = "7";
  f.dispatchEvent(new dom.window.Event("input"));
  assert.equal(big.querySelectorAll("tbody tr").length, 1);
  assert.equal(text(big.querySelector(".tbl-count")), "1 of 9 rows");
});

/**
 * A DOMPurify stand-in with the real one's outline: it drops <script>/<style>
 * outright, unwraps tags that are forbidden or outside ALLOWED_TAGS, strips on*=
 * and any forbidden attribute, and records every call so a test can see what it
 * was handed and in which order.
 */
const stubDoc = dom.window.document.implementation.createHTMLDocument("purify");
const stubHost = ({ html, ignoreConfig = false } = {}) => {
  const calls = [];
  window.marked = { parse: (text, { gfm }) => (gfm ? html : `<p>${text}</p>`) };
  const purify = {
    // The real 3.x behaviour: once setConfig() has run, every later per-call
    // config is ignored. A host that calls it silently loses MD_CLEAN.
    configured: null,
    setConfigCalls: 0,
    setConfig(config) {
      purify.setConfigCalls++;
      purify.configured = config;
    },
    sanitize: (s, config = {}) => {
      // ignoreConfig models a DOMPurify that keeps its defaults (srcset, video,
      // picture, poster, background…), so only render.mjs's own filter can
      // remove those.
      const cfg = ignoreConfig ? {} : (purify.configured ?? config);
      calls.push({ input: s, config: cfg });
      // A document of its own: the stub's scratch element must not show up in a
      // test that watches every element the renderer builds.
      const box = stubDoc.createElement("div");
      box.innerHTML = s;
      for (const el of box.querySelectorAll("script, style")) el.remove();
      // Deepest first: a kept child is re-parented before its parent is unwrapped.
      for (const el of [...box.querySelectorAll("*")].reverse()) {
        if ((cfg.ALLOWED_TAGS && !cfg.ALLOWED_TAGS.includes(el.localName)) || cfg.FORBID_TAGS?.includes(el.localName)) {
          el.replaceWith(...el.childNodes);
          continue;
        }
        for (const { name } of [...el.attributes]) if (/^on/i.test(name) || cfg.FORBID_ATTR?.includes(name) || (cfg.ALLOWED_ATTR && !cfg.ALLOWED_ATTR.includes(name))) el.removeAttribute(name);
      }
      return box.innerHTML;
    },
  };
  window.DOMPurify = purify;
  return { marked: window.marked, calls, purify };
};

test("renderMarkdown parses GFM, opens links away and wraps each fence with a copy button", async () => {
  stubHost({ html: '<p>hi <a href="https://x.test/">x</a></p><pre><code class="language-js">let a = 1;\n</code></pre><pre><code>plain\n</code></pre>' });
  const seen = [];
  window.hljs = {
    getLanguage: (lang) => lang === "js",
    highlight: (code, { language }) => (seen.push([language, code]), { value: `<span class="hljs-kw">${code}</span>` }),
    highlightAuto: (code) => (seen.push(["auto", code]), { value: code }),
  };
  const copied = [];
  const el = render.renderMarkdown("x", { onCopy: (t) => copied.push(t) });
  assert.equal(tag(el), "div");
  assert.equal(el.className, "md");
  assert.equal(el.querySelector("a").target, "_blank");
  assert.equal(el.querySelectorAll(".code-wrap").length, 2, "both fences wrapped");
  assert.equal(text(el.querySelector(".lang")), "js", "the fence's language");
  assert.deepEqual(seen, [["js", "let a = 1;\n"], ["auto", "plain\n"]], "labelled by fence, guessed otherwise");
  el.querySelectorAll("button.copy")[0].dispatchEvent(new dom.window.Event("click"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(copied, ["let a = 1;"], "the trailing newline is trimmed");
  delete window.hljs;
});

test("renderMarkdown sanitises marked's output before it reaches the DOM", () => {
  const html = '<p>hi</p><script>bad()</script><img src="https://track.test/p.gif" onerror="bad()"><img src="data:image/png;base64,AA"><form><input name="q"></form><p style="position:fixed">over</p>';
  const { calls } = stubHost({ html });
  const el = render.renderMarkdown("# md");
  assert.equal(calls.length, 1, "sanitised once");
  assert.equal(calls[0].input, html, "handed marked's own output, not the source text");
  assert.deepEqual(calls[0].config.FORBID_TAGS, ["style", "form", "input", "button", "textarea", "select", "video", "audio", "source", "picture", "track"]);
  assert.deepEqual(calls[0].config.FORBID_ATTR, ["style", "srcset", "background", "poster"]);
  assert.equal(el.querySelector("script"), null, "no script survives");
  assert.equal(el.querySelector("form, input"), null, "no form controls");
  assert.equal(el.querySelector("[onerror]"), null, "no handlers");
  assert.equal(el.querySelector("[style]"), null, "no inline styles");
  assert.equal(el.querySelectorAll("img").length, 1, "only the data: image is left");
  assert.match(el.querySelector("img").getAttribute("src"), /^data:/);
  assert.equal(el.querySelector("p").textContent, "hi");
  assert.equal(el.querySelectorAll("p")[1].textContent, "over", "a styled paragraph keeps its text");
});

test("renderMarkdown drops the fetches DOMPurify's defaults keep", () => {
  const html = [
    '<img src="/track.gif" srcset="/x.png 2x"><img src="data:image/png;base64,AA">',
    '<picture><source srcset="/x.webp"><img src="/p.png"></picture>',
    '<video src="/v.mp4" poster="/p.png"><source src="/s.mp4"><track src="/t.vtt"></video>',
    '<audio src="/a.mp3"></audio>',
    '<table><tr><td background="/bg.png">cell</td></tr></table>',
    "<p>ok</p>",
  ].join("");
  // A lenient sanitizer: everything DOMPurify's own defaults allow survives its
  // call, so anything gone below was removed by render.mjs's template filter.
  stubHost({ html, ignoreConfig: true });
  const el = render.renderMarkdown("# md");
  for (const sel of ["srcset", "background", "poster"]) assert.equal(el.querySelector(`[${sel}]`), null, `no ${sel}= survives`);
  for (const t of ["video", "audio", "source", "picture", "track"]) assert.equal(el.querySelector(t), null, `no <${t}> survives`);
  assert.equal(el.querySelectorAll("img").length, 1, "only the data: image is left");
  assert.match(el.querySelector("img").getAttribute("src"), /^data:/);
  assert.equal(text(el), "cellok", "the cell's text survives; the tagged image did not");
});

test("renderMarkdown parses the sanitised string into an inert <template>", () => {
  stubHost({ html: "<p>hi</p><img src=\"/track.gif\">" });
  const writes = [];
  const proto = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, "innerHTML");
  const create = document.createElement.bind(document);
  // Watch every element render.mjs builds: untrusted markup must only ever be
  // handed to a <template> (inert), never to a div the live document owns — an
  // innerHTML there starts an <img> fetch before any filtering can remove it.
  document.createElement = (name, ...rest) => {
    const el = create(name, ...rest);
    Object.defineProperty(el, "innerHTML", {
      configurable: true,
      get: () => proto.get.call(el),
      set: (v) => (writes.push([name, String(v)]), proto.set.call(el, v)),
    });
    return el;
  };
  try {
    assert.equal(text(render.renderMarkdown("# md")), "hi");
  } finally {
    document.createElement = create;
  }
  const untrusted = writes.filter(([, v]) => /track\.gif|<p>hi<\/p>/.test(v));
  assert.ok(untrusted.length, "the sanitised markdown was written somewhere");
  assert.deepEqual([...new Set(untrusted.map(([n]) => n))], ["template"], "and only into a template");
});

test("renderMarkdown's config survives a host that never calls DOMPurify.setConfig", () => {
  const { calls, purify } = stubHost({ html: '<p style="position:fixed;inset:0">over</p><img src="data:image/png;base64,AA" srcset="/x.png">' });
  const el = render.renderMarkdown("# md");
  assert.equal(purify.setConfigCalls, 0, "render.mjs never sets a global config");
  assert.deepEqual(calls[0].config.FORBID_ATTR, ["style", "srcset", "background", "poster"], "MD_CLEAN reaches DOMPurify");
  assert.equal(el.querySelector("[style]"), null, "style= is stripped with no host setup at all");
  assert.equal(el.querySelector("[srcset]"), null);
  // The caveat in render.mjs's header, made concrete: a global setConfig makes
  // DOMPurify ignore MD_CLEAN, so a bubble host must not call it (addHook is the
  // way to tweak things globally).
  window.DOMPurify.setConfig({ FORBID_ATTR: [] });
  assert.ok(render.renderMarkdown("# md").querySelector("[style]"), "a global config would win over MD_CLEAN");
});

test("a chart redraws on width changes only, one frame later", () => {
  const observers = [];
  const ro = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(cb) {
      observers.push(cb);
    }
    observe() {}
    disconnect() {}
  };
  const frames = [];
  window.requestAnimationFrame = (fn) => frames.push(fn);
  try {
    const el = render.renderChart({ type: "bar", labels: ["a"], series: [{ data: [1] }] });
    const plot = el.querySelector(".chart-plot");
    let w = 0;
    Object.defineProperty(plot, "clientWidth", { get: () => w });
    const cb = observers.at(-1);
    w = 300;
    cb([{ contentRect: { width: 300 } }]);
    assert.equal(frames.length, 1, "deferred out of the observer's callback");
    cb([{ contentRect: { width: 300 } }]);
    assert.equal(frames.length, 1, "one frame queued at a time");
    assert.equal(plot.querySelector("svg"), null, "nothing drawn yet");
    frames.shift()();
    assert.equal(plot.querySelector("svg").getAttribute("width"), "300");
    cb([{ contentRect: { width: 300, height: 999 } }]);
    assert.equal(frames.length, 0, "a height-only change does not redraw");
    w = 420;
    cb([{ contentRect: { width: 420 } }]);
    assert.equal(frames.length, 1, "a width change does");
    frames.shift()();
    assert.equal(plot.querySelector("svg").getAttribute("width"), "420");
  } finally {
    globalThis.ResizeObserver = ro;
    delete window.requestAnimationFrame;
  }
});

test("renderMarkdown skips long fences, plain languages and bad language names", () => {
  // 16 KB is the cap; a plain-text alias and a name that isn't a language are skipped too.
  stubHost({ html: `<pre><code class="language-json">${"x".repeat(16_001)}</code></pre><pre><code class="language-text">t</code></pre><pre><code class="language-nope!">n</code></pre><pre><code class="language-js">js</code></pre>` });
  const seen = [];
  window.hljs = {
    getLanguage: () => true,
    highlight: (code, { language }) => (seen.push(language), { value: `<span class="hljs-kw" onclick="bad()">${code}</span>` }),
  };
  const el = render.renderMarkdown("x");
  assert.deepEqual(seen, ["js"], "only the small fence with a real language name");
  assert.equal(el.querySelectorAll("pre > code.hljs").length, 1);
  assert.equal(el.querySelector(".hljs-kw").getAttribute("onclick"), null, "highlighter output is cut to <span class>");
  assert.equal(el.querySelector(".hljs-kw").className, "hljs-kw", "its classes stay");
  delete window.hljs;
});

test("renderMarkdown leaves a big unlabelled fence unguessed and falls back without marked", () => {
  stubHost({ html: `<pre><code>${"x".repeat(20_001)}</code></pre>` });
  const seen = [];
  window.hljs = { getLanguage: () => undefined, highlightAuto: (code) => (seen.push(code), { value: code }) };
  render.renderMarkdown("x");
  assert.deepEqual(seen, [], "over 20 KB is not auto-detected");
  delete window.hljs;
  window.marked = undefined;
  const plain = render.renderMarkdown("# raw & *text*");
  assert.equal(tag(plain.firstChild), "pre");
  assert.equal(text(plain), "# raw & *text*");
  stubHost();
});

// ── the rest of the shared renderers ─────────────────────────────────────────

test("toneVar, inline and noteParas are the page's little helpers, shared", () => {
  assert.equal(render.toneVar("ok"), "var(--ok)");
  assert.equal(render.toneVar("c7"), "var(--c7)");
  assert.equal(render.toneVar("evil"), "");
  const line = render.h("div", {}, ...render.inline("a `b` **c** [d](https://x.test/) e"));
  assert.equal(text(line), "a b c d e");
  assert.equal(line.querySelector("code").textContent, "b");
  assert.equal(line.querySelector("a").getAttribute("href"), "https://x.test/");
  const bare = render.h("div", {}, ...render.inline("`x` [y](https://x.test/)", false));
  assert.equal(bare.querySelector("a"), null, "links become text inside a link");
  assert.equal(text(bare), "x y");
  const paras = render.noteParas("one\n\ntwo", render.h("span", { class: "at" }, "L1"));
  assert.equal(paras.length, 2);
  assert.equal(paras[0].firstChild.className, "at", "the lead sits in the first paragraph only");
  assert.equal(render.tilde("/Users/me/Code/x"), "~/Code/x");
});

test("renderTracker puts the id, state tone, title link and note in one card", () => {
  const el = render.renderTracker({ id: "4", state: "Merged", title: "PR #4", href: "https://x.test/4", note: "n" });
  assert.equal(el.className, "tracker");
  assert.equal(text(el.querySelector(".tk-id")), "#4");
  assert.equal(el.querySelector(".tk-state").className, "tk-state ok", "merged reads as done");
  assert.equal(el.querySelector(".tk-title a").getAttribute("href"), "https://x.test/4");
  assert.equal(text(el.querySelector(".tk-note")), "n");
  assert.equal(render.renderTracker({ title: "plain" }).querySelector(".tk-line"), null);
  assert.equal(render.renderTracker({ title: "x", href: "javascript:alert(1)" }).querySelector(".tk-title a"), null, "only http(s) links");
});

test("renderStats formats values, tones deltas and draws sparks", () => {
  const el = render.renderStats({
    items: [
      { label: "Users", value: 1234, spark: [1, 2, 3], note: "n" },
      { label: "Down", value: 5, delta: -2, good: "down", color: "ok" },
      { label: "Up", value: "3", unit: "ms", prefix: "~" },
    ],
  });
  assert.equal(el.className, "stats");
  const [a, b, c] = el.querySelectorAll(".stat");
  assert.equal(text(a.querySelector(".stat-value")), "1,234");
  assert.ok(a.querySelector("svg.spark"), "a sparkline");
  assert.equal(text(a.querySelector(".stat-note")), "n");
  assert.equal(b.querySelector(".stat-value").getAttribute("style"), "color:var(--ok)", "a named colour");
  assert.equal(b.querySelector(".stat-delta").className, "stat-delta ok", "down is good here");
  assert.equal(text(c.querySelector(".stat-value")), "~3\u2009ms", "prefix and unit for a string value");
  assert.equal(c.querySelector(".stat-delta"), null);
});

test("renderSteps counts, bars and marks each step's state", () => {
  const el = render.renderSteps({
    title: "Plan",
    steps: [
      { label: "one", status: "done" },
      { label: "two", status: "active", note: "n", detail: "d" },
      { label: "three", status: "failed" },
      { label: "four", status: "skipped" },
    ],
  });
  assert.equal(text(el.querySelector(".steps-count")), "1 of 3 done · 1 failed · 1 skipped", "skipped steps don't count");
  assert.equal(el.querySelector(".steps-bar i").getAttribute("style"), "width:33.3%");
  assert.equal(el.querySelectorAll("li.step").length, 4);
  assert.deepEqual([...el.querySelectorAll(".smark")].map(text), ["✓", "", "✕", "–"]);
  assert.equal(el.querySelector("li.s-active .snote").textContent, "n");
  assert.equal(el.querySelector("li.s-active .sdetail").textContent, "d");
});

test("renderTimeline sorts by time, groups by day and shows the gaps", () => {
  const at = (h) => `2026-01-0${h < 24 ? 2 : 3}T${String(h % 24).padStart(2, "0")}:00:00Z`;
  const el = render.renderTimeline({
    events: [
      { at: at(25), title: "later" },
      { at: at(1), title: "first", tone: "ok", tag: "ok", note: "n" },
    ],
    caption: "cap",
  });
  const titles = [...el.querySelectorAll(".ttitle")].map((t) => t.textContent);
  assert.match(titles[0], /^first/, "sorted by time");
  assert.equal(el.querySelectorAll(".tday").length, 2, "a day heading per day");
  assert.equal(el.querySelector(".ctag").className, "ctag ok");
  assert.match(text(el.querySelector(".tgap")), /^\+1d/, "the gap since the previous event");
  assert.match(text(el.querySelector(".chart-cap")), /^cap · 2 events over 1d/);
  const given = render.renderTimeline({ events: [{ at: "midnight", title: "a" }, { at: "nothing", title: "b" }] });
  assert.deepEqual([...given.querySelectorAll(".ttitle")].map(text), ["a", "b"], "undated events keep their order as written");
  assert.equal(given.querySelector(".tday"), null);
});

test("renderJson folds lazily, filters and copies a path", async () => {
  const copied = [];
  const el = render.renderJson(JSON.stringify({ a: 1, b: [true, null, "s"], c: { d: 2 } }), { copyText: (t) => (copied.push(t), Promise.resolve()) });
  assert.ok(el.querySelector(".jt"));
  const rows = () => [...el.querySelectorAll(".jrow")];
  assert.equal(rows().length, 3, "the root and its two levels");
  assert.equal(el.querySelector(".j-string").textContent, '"s"', "a string keeps its quotes");
  const rootWrap = el.querySelector(".jt > .jn");
  assert.ok(rootWrap.classList.contains("open"), "the root starts open");
  rows()[0].dispatchEvent(new dom.window.Event("click"));
  assert.equal(rootWrap.classList.contains("open"), false, "a click folds the root");
  rows()[0].dispatchEvent(new dom.window.Event("click"));
  assert.ok(rootWrap.classList.contains("open"));
  el.querySelector(".jk").dispatchEvent(new dom.window.Event("click"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(copied, [".a"], "a key copies its jq path");
  const filter = el.querySelector(".tbl-filter");
  filter.value = "true";
  filter.dispatchEvent(new dom.window.Event("input"));
  assert.equal(text(el.querySelector(".tbl-count")), "1 match");
  filter.value = "zzz";
  filter.dispatchEvent(new dom.window.Event("input"));
  assert.equal(text(el.querySelector(".term-none")), "Nothing matches");
  assert.equal(render.renderJson("{oops").className, "err");
});

test("renderJson and renderTerminal use the host's copy buttons", () => {
  const seen = [];
  const copyButton = (getText, label) => {
    const b = render.h("button", { class: "host-copy" }, label);
    b.addEventListener("click", () => seen.push([label, getText()]));
    return b;
  };
  const json = render.renderJson('{"a":1}', { copyButton });
  assert.equal(json.querySelector(".host-copy").textContent, "Copy JSON");
  const term = render.renderTerminal({ output: "a\nb\n" }, { copyButton });
  assert.equal(term.querySelector(".host-copy").textContent, "Copy output");
  term.querySelector(".host-copy").dispatchEvent(new dom.window.Event("click"));
  assert.deepEqual(seen.at(-1), ["Copy output", "a\nb"], "the plain text of every line");
});

test("renderTerminal keeps ANSI colours, tints by line and filters", () => {
  const el = render.renderTerminal({ command: "ls", cwd: "/Users/me/x", exit: 0, duration: 1.5, output: "\u001b[32mok\u001b[0m done\nwarning: thing\nerror: bad\n" });
  assert.equal(text(el.querySelector(".term-cmd")), "$ ls");
  assert.match(text(el.querySelector(".term-meta")), /^~\/x[\s\S]*exit 0[\s\S]*3 lines/);
  assert.equal(el.querySelector(".term-exit").className, "term-exit ok");
  assert.equal(el.querySelector(".term-copy, .copy").textContent, "Copy", "the host's copy button, via the page's real one");
  const spans = [...el.querySelectorAll(".tl .tx span")];
  assert.equal(spans[0].getAttribute("style"), "color:var(--t2)", "ANSI 32 is --t2");
  assert.deepEqual([...el.querySelectorAll(".tl")].map((l) => l.className), ["tl", "tl", "tl"], "colours, so no line tint");
  const plain = render.renderTerminal({ output: "ok\nwarning: x\nerror: y\n" });
  assert.deepEqual([...plain.querySelectorAll(".tl")].map((l) => l.className), ["tl ok", "tl warn", "tl bad"]);
  const long = render.renderTerminal({ output: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") });
  assert.equal(long.querySelectorAll(".tl").length, 70, "head and tail while it is long");
  const fold = long.querySelector(".term-fold");
  assert.match(text(fold), /^Show 130 more lines$/);
  fold.dispatchEvent(new dom.window.Event("click"));
  assert.equal(long.querySelectorAll(".tl").length, 200);
  const filt = render.renderTerminal({ output: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") });
  const f = filt.querySelector(".term-filter");
  f.value = "line 3";
  f.dispatchEvent(new dom.window.Event("input"));
  assert.equal(text(filt.querySelector(".term-count")), "11 of 40");
  assert.ok(filt.querySelector(".tl mark"), "matches are marked");
});

test("renderCode numbers the lines, marks ranges and notes, and highlights via the host", async () => {
  stubHost({ html: "" });
  const loads = [];
  const el = render.renderCode(
    { path: "a.ts", lang: "typescript", start: 40, total: 3, code: "const a = 1;\nconst b = 2;\nconst c = 3;", highlight: [[41, 41]], notes: [{ from: 42, to: 42, text: "note **here**", tone: "warn" }], caption: "cap" },
    {
      loadHighlight: () => {
        loads.push(1);
        // One span per line, as the real highlighter returns for this input.
        return Promise.resolve({ getLanguage: () => true, highlight: (code) => ({ value: code.split("\n").map((l) => `<span class="hljs-keyword">${l.slice(0, 5)}</span>${l.slice(5)}`).join("\n") }) });
      },
    },
  );
  assert.equal(el.className, "code");
  assert.equal(el.querySelectorAll(".cl").length, 3);
  assert.deepEqual([...el.querySelectorAll(".cl .ln")].map(text), ["40", "41", "42"]);
  assert.equal(el.querySelector(".cl.hl"), el.querySelectorAll(".cl")[1], "the highlighted band");
  const note = el.querySelector(".code-note");
  assert.equal(note.querySelector(".at").textContent, "L42");
  assert.equal(note.querySelector("b").textContent, "here");
  assert.equal(note.getAttribute("style"), "--tone:var(--warn)");
  assert.equal(el.querySelector(".code-head .path").textContent, "a.ts");
  assert.equal(el.querySelector(".ctag").textContent, "typescript");
  assert.equal(text(el.querySelector(".code-cap")), "cap");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loads.length, 1, "the host's loader");
  assert.equal(el.querySelectorAll(".lc .hljs-keyword").length, 3, "each line gets its own spans");
});

test("renderCode accepts a text body (a bubble's file text) and normalises it", () => {
  const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
  const el = render.renderCode({ path: "a.js", text: body, lines: "2-3", highlight: ["3"], notes: [{ lines: "3", text: "here" }] });
  assert.deepEqual([...el.querySelectorAll(".cl .ln")].map(text), ["2", "3"]);
  assert.equal(el.querySelectorAll(".cl.hl").length, 1, "the highlighted line");
  assert.equal(el.querySelector(".code-note .at").textContent, "L3");
  assert.equal(el.querySelector(".ctag").textContent, "javascript", "lang from the path");
  assert.match(text(el.querySelectorAll(".code-head span")[1]), /lines 2–3 of 12/);
  const empty = render.renderCode({ text: "" });
  assert.equal(empty.querySelector(".code-body .cl .ln").textContent, "1");
  assert.match(text(empty.querySelectorAll(".code-head span")[1]), /1 line/);
});

test("renderTree folds by path through the host's store, and counts tags", () => {
  const store = {};
  const writes = [];
  const opts = { foldKey: (p) => `s1/tree/${p}`, folds: { read: () => store, write: (v) => (writes.push(v), Object.assign(store, v)) } };
  const el = render.renderTree({ root: "src", entries: [{ path: "a/b.ts", tag: "changed", note: "note" }, { path: "c.ts" }], caption: "cap" }, opts);
  assert.equal(text(el.querySelector(".tree-root")), "src/");
  assert.equal(el.querySelector(".tr .ttag").textContent, "changed");
  assert.match(text(el.querySelector(".tr.t-changed .nm")), /b\.ts$/);
  assert.equal(el.querySelector(".tr .note").textContent, "note");
  assert.equal(text(el.querySelector(".tr .sum")), "1 changed", "a folder sums the tags below it");
  const dir = el.querySelector(".tr.dir");
  const sub = dir.closest("li").querySelector("ul");
  assert.equal(sub.hidden, false, "a small tree starts open");
  dir.dispatchEvent(new dom.window.Event("click"));
  assert.equal(sub.hidden, true);
  assert.equal(store["s1/tree/a"], false, "the host's store learns the fold");
  assert.equal(writes.length, 1);
  const shut = render.renderTree({ entries: [{ path: "x/" }] }, { foldKey: (p) => p, folds: { read: () => ({ x: false }), write: () => {} } });
  assert.equal(shut.querySelector("li ul").hidden, true, "a saved fold wins");
});

test("renderOptions sends a Pick to the host, or copies it with no host", async () => {
  const sent = [];
  const spec = { question: "Which?", options: [{ label: "A", recommended: true, pros: ["p"], cons: ["c"], scores: { speed: 4 } }, { label: "B", cost: "$" }] };
  const el = render.renderOptions(spec, { onSend: (prompt, e) => sent.push([prompt, e.type]) });
  assert.equal(el.querySelectorAll(".opt").length, 2);
  assert.equal(el.querySelector(".opt.rec .opt-badge").textContent, "Recommended");
  assert.equal(el.querySelector(".opt-scores .cbar i").getAttribute("style"), "width:80%");
  const pick = el.querySelectorAll(".opt .btn")[1];
  assert.match(pick.getAttribute("title"), /Send this choice to pi/);
  pick.dispatchEvent(new dom.window.Event("click"));
  assert.deepEqual(sent, [['Go with option B: B (for "Which?")', "click"]]);
  const copied = [];
  const bare = render.renderOptions(spec, { onCopy: (t) => copied.push(t) });
  assert.equal(bare.querySelector(".opt .btn").getAttribute("title"), "Copy this choice");
  bare.querySelector(".opt .btn").dispatchEvent(new dom.window.Event("click"));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(copied, ['Go with option A: A (for "Which?")'], "a bubble copies the prompt instead");
});

test("renderKanban draws columns, moved marks, owner chips and the details hook", () => {
  const opened = [];
  const spec = {
    title: "Board",
    columns: [
      { label: "Open", tone: "ok", cards: [{ id: "#1", title: "a `code` card", note: "n", tag: "ok", tone: "ok", owner: "pi-abcd" }, { title: "b", href: "https://x.test/" }] },
      { label: "Doing", cards: [], limit: 2 },
      { label: "Done", compact: true, cards: [{ title: "c" }] },
    ],
    progress: true,
    caption: "cap",
  };
  const el = render.renderKanban(spec, {
    section: "board",
    moves: { "id:#1": "new", "t:b": "Doing" },
    ownerChip: (name) => render.h("a", { class: "kb-owner", "data-owner": name }, `@${name}`),
    onCard: (k, c) => opened.push([k.title, c.label]),
  });
  assert.equal(el.className, "kanban");
  assert.equal(text(el.querySelector(".kb-head b")), "Board");
  assert.equal(el.querySelectorAll(".kb-col").length, 3);
  assert.equal(el.querySelectorAll(".kb-card").length, 3);
  assert.equal(text(el.querySelector(".kb-moved")), "new");
  assert.equal(text(el.querySelectorAll(".kb-moved")[1]), "→ Doing");
  assert.equal(el.querySelector(".kb-owner").getAttribute("data-owner"), "pi-abcd", "the host's chip");
  assert.equal(el.querySelector(".kb-card").getAttribute("aria-haspopup"), "dialog");
  el.querySelector(".kb-card").dispatchEvent(new dom.window.Event("click"));
  assert.deepEqual(opened, [["a `code` card", "Open"]]);
  el.querySelectorAll(".kb-card")[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(opened.length, 2, "Enter opens it too");
  el.querySelector(".kb-card a").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.equal(opened.length, 2, "a link inside the card keeps its own click");
  const folded = () => el.querySelectorAll(".kb-col")[2].className;
  assert.doesNotMatch(folded(), /folded/, "a busy board keeps its Done column open");
  el.querySelector(".kb-fold").dispatchEvent(new dom.window.Event("click"));
  assert.match(folded(), /folded/, "the fold button still closes it");
});

test("renderKanban remembers folds through the host and gives a bubble a Send button", () => {
  const store = {};
  const spec = { columns: [{ label: "Open", cards: [{ id: "#4", title: "card" }] }, { label: "Done", compact: true, cards: [{ title: "x" }] }] };
  const el = render.renderKanban(spec, { section: "auto-tasks", folds: { read: () => store, write: (v) => Object.assign(store, v) }, foldKey: (l) => `s1/${l}` });
  el.querySelector(".kb-fold").dispatchEvent(new dom.window.Event("click"));
  assert.equal(store["s1/Done"], true, "the host's store remembers it");
  // No modal: the card carries the prompt itself, in the todo tool's own words.
  const sent = [];
  const bubble = render.renderKanban(spec, { section: "auto-tasks", onSend: (p) => sent.push(p) });
  assert.equal(bubble.querySelector(".kb-card").getAttribute("aria-haspopup"), null);
  const send = bubble.querySelector(".kb-meta .btn");
  assert.equal(send.textContent, "Send to pi");
  send.dispatchEvent(new dom.window.Event("click"));
  assert.deepEqual(sent, ["Claim todo #4 (card) and start on it."]);
  const plain = render.renderKanban({ columns: [{ label: "Open", cards: [{ title: "t", owner: "sam" }] }] });
  assert.equal(text(plain.querySelector(".kb-owner")), "@sam", "a bare @name with no host chip");
  // The page passes both onCard and onSend: the modal means no per-card Send.
  const page = render.renderKanban({ columns: [{ label: "Open", cards: [{ title: "t", tag: "ok" }] }] }, { onSend: () => {}, onCard: () => {} });
  assert.ok(page.querySelector(".kb-meta"), "the card's meta row");
  assert.equal(page.querySelector(".kb-meta .btn"), null, "no Send button where a modal exists");
  assert.equal(render.renderKanban({ columns: [{ label: "Open", cards: [{ title: "x", href: "javascript:alert(1)" }] }] }).querySelector(".kb-card a"), null, "only http(s) links");
  const more = render.renderKanban({ columns: [{ label: "A", cards: [], more: "1;background:red" }] });
  assert.equal(more.querySelector(".kb-cols").getAttribute("style"), "--kb-tpl:36px", "a string `more` stays out of CSS");
});

test("renderKanban and renderTree never need localStorage without a host", () => {
  const saved = Object.getOwnPropertyDescriptor(dom.window, "localStorage");
  Object.defineProperty(dom.window, "localStorage", { configurable: true, get() { throw new Error("no storage here"); } });
  try {
    assert.doesNotThrow(() => render.renderKanban({ columns: [{ label: "Open", cards: [{ title: "t" }] }, { label: "Done", compact: true, cards: [{ title: "x" }] }] }));
    assert.doesNotThrow(() => render.renderTree({ root: "src", entries: [{ path: "a/b.ts" }] }));
  } finally {
    if (saved) Object.defineProperty(dom.window, "localStorage", saved);
    else delete dom.window.localStorage;
  }
});

test("parsePatch and langFor read a patch into files, hunks and rows", () => {
  const files = render.parsePatch(
    "diff --git a/a.rb b/a.rb\n--- a/a.rb\n+++ b/a.rb\n@@ -1,2 +1,2 @@\n-old line\n+new line\n same\ndiff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+hi\n",
  );
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "a.rb");
  assert.equal(files[0].adds, 1);
  assert.equal(files[0].dels, 1);
  assert.deepEqual(files[0].hunks[0].rows.map((r) => [r.t, r.a, r.b]), [["del", 1, undefined], ["add", undefined, 1], ["ctx", 2, 2]]);
  assert.equal(files[1].status, "added");
  assert.equal(render.langFor("a/b.rb"), "ruby");
  assert.equal(render.langFor("Gemfile"), "ruby");
  assert.equal(render.langFor("x.unknown"), "");
});

test("renderDiff draws each file, marks the changed words and lists the files", () => {
  stubHost({ html: "" });
  const patch = "diff --git a/a.rb b/a.rb\n--- a/a.rb\n+++ b/a.rb\n@@ -1,2 +1,2 @@\n-let a = 1\n+let a = 2\n keep\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n";
  const el = render.renderDiff(patch);
  assert.equal(el.className, "diffview");
  assert.equal(el.querySelectorAll(".dv-file").length, 2);
  assert.equal(el.querySelectorAll(".dv-files li").length, 2, "a file list for several files");
  assert.equal(el.querySelector(".dv-file table.diff").className, "diff", "unified");
  assert.match(text(el.querySelector(".dv-files")), /a\.rb/);
  const marks = [...el.querySelectorAll("tr.del mark, tr.add mark")].map(text);
  assert.deepEqual(marks, ["1", "2"], "the changed words, not the whole line");
  const one = render.renderDiff("diff --git a/a.rb b/a.rb\n--- a/a.rb\n+++ b/a.rb\n@@ -1 +1 @@\n-a\n+b\n");
  assert.equal(one.querySelector(".dv-files"), null, "one file needs no list");
  const split = render.renderDiff(patch, { split: true });
  assert.match(split.querySelector("table.diff").className, /split/);
  assert.equal(render.renderDiff("").textContent, "No changes in this patch.");
});

test("diffBlock re-runs onBody after a redraw, so the page can repaint comments", async () => {
  stubHost({ html: "" });
  const [f] = render.parsePatch("diff --git a/a.rb b/a.rb\n--- a/a.rb\n+++ b/a.rb\n@@ -1 +1 @@\n-a\n+b\n");
  const seen = [];
  render.diffBlock(f, { onBody: (b) => seen.push(b.querySelectorAll("tr").length) });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.length, 1, "once after the first fill");
  assert.ok(seen[0] >= 2, "with the changed rows in place");
  assert.equal(render.diffFileList([f], [render.diffBlock(f, {})]), null, "no list for a single file");
});

test("a running terminal's timer stops on dispose, and when its body never attaches", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const timers = new Set();
  const set = globalThis.setInterval;
  const clear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => (timers.add(set(fn, ms)), [...timers].at(-1));
  globalThis.clearInterval = (id) => (timers.delete(id), clear(id));
  try {
    const el = render.renderTerminal({ output: "hi\n", running: true, started: new Date(0).toISOString() });
    document.body.append(el);
    const label = el.querySelector(".term-running span:last-child");
    t.mock.timers.tick(1000);
    assert.equal(label.textContent, "running 1s");
    assert.equal(timers.size, 1, "one clock");
    assert.equal(typeof el.dispose, "function", "a host can stop the clock itself");
    el.dispose();
    assert.equal(timers.size, 0, "stopped");
    t.mock.timers.tick(30_000);
    assert.equal(label.textContent, "running 1s", "and it stays stopped");
    el.remove();
    // A body rendered but never attached has no one watching it: it stops on its own.
    render.renderTerminal({ output: "hi\n", running: true, started: new Date(0).toISOString() });
    assert.equal(timers.size, 1, "one clock");
    t.mock.timers.tick(11_000);
    assert.equal(timers.size, 0, "dropped after a few idle ticks");
  } finally {
    globalThis.setInterval = set;
    globalThis.clearInterval = clear;
  }
});

test("renderMermaid asks the host for mermaid and draws, or reports the failure", async () => {
  let loaded = 0;
  const el = render.h("div");
  await render.renderMermaid(el, "graph TD; A-->B;", {
    loadMermaid: () => {
      loaded++;
      return Promise.resolve({ render: async (id, src) => ({ svg: `<svg id="${id}" data-src="${src}"></svg>` }) });
    },
  });
  assert.equal(loaded, 1);
  assert.ok(el.classList.contains("mmd"));
  assert.equal(el._src, "graph TD; A-->B;", "kept so a theme change can draw it again");
  assert.equal(el.querySelector("svg").getAttribute("data-src"), "graph TD; A-->B;");
  assert.match(el.querySelector("svg").id, /^mmd-/);
  const remote = render.h("div");
  await render.renderMermaid(remote, "graph TD; A-->B;", {
    loadMermaid: () =>
      Promise.resolve({
        render: async () => ({
          svg: '<svg><image href="https://evil.test/a.png" xlink:href="data:image/png;base64,AA"></image><image href="data:image/png;base64,BB"></image></svg><img src="https://evil.test/b.png">',
        }),
      }),
  });
  const [img, kept] = remote.querySelectorAll("image");
  assert.equal(img.getAttribute("href"), null, "a remote image loses its href");
  assert.equal(img.getAttribute("xlink:href"), "data:image/png;base64,AA", "a data: image stays");
  assert.equal(remote.querySelector("img").getAttribute("src"), null, "so does an HTML img's src");
  assert.equal(kept.getAttribute("href"), "data:image/png;base64,BB", "a data: image stays");
  const bad = render.h("div");
  await render.renderMermaid(bad, "nope", { loadMermaid: () => Promise.reject(new Error("no script")) });
  assert.equal(text(bad.querySelector(".err")), "mermaid: no script");
  assert.equal(bad.querySelector("pre").textContent, "nope");
});
