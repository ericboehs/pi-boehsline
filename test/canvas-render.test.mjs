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
// renderChart sizes itself from its container; jsdom never lays out, so it needs a stub.
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const tag = (el) => el.tagName.toLowerCase();
const text = (el) => el.textContent;

test("render.mjs exports the shared renderers, with no DOM at import time", () => {
  for (const name of ["h", "svg", "tip", "renderMarkdown", "renderTable", "renderChart", "sparkSvg", "niceScale", "fmtValue", "drawXY", "drawPie", "seriesColor", "textW", "clip"]) assert.equal(typeof render[name], "function", name);
  assert.ok(render.NAMED.has("accent"), "named colours");
  assert.equal(render.TAG_TONE.length, 3, "tag tones");
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
