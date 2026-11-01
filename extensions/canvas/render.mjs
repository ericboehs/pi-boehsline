// Rendering shared by the canvas page (served as /assets/render.mjs, with its
// styles in render.css) and botsun's chat bubbles (render/bubble.html): markdown,
// tables, charts, stats, steps, timeline, JSON, code, tree, options, kanban,
// tracker, terminal, pipeline, background jobs, diff and mermaid.
// Plain DOM nodes with CSS-variable colours, so a host stylesheet themes them;
// nothing here reads the page's state, storage or session globals. Where a
// renderer needs page behaviour (clipboard buttons, highlight.js loading, the
// kanban modal, owner links, remembered folds, talk-back) the page passes it in
// through that renderer's opts instead.
//
// A host that supplies window.mermaid itself must initialize it first
// ({ securityLevel: "strict", startOnLoad: false }); see the mermaid section.
//
// A host must NOT call DOMPurify.setConfig(): in DOMPurify 3.x a global config
// wins over every later per-call config, which would quietly drop MD_CLEAN's
// FORBID_ATTR: ["style"] (a bot could then overlay the bubble) and the image
// rules below. Want a global tweak? Use DOMPurify.addHook(). This module passes
// its own allow-lists on every call, and the sanitised markdown is parsed into
// an inert <template> and filtered there before any of it is appended.
//
// The canvas page and bubbles share renderMarkdown and its one sanitize policy
// (MD_CLEAN). The page passes its look in through opts (wrapCode: its
// .codeblock DOM; highlight: its lazily loaded highlight.js; mermaid; imgSrc:
// its own files as well as data: images).
//
// The DOM a host page styles (bubble.css):
//   .md                 markdown root
//   .md .code-wrap      a fenced block: scrolls sideways, never wraps
//     .md .code-head    its bar: .lang (the fence's language, if any) + button.copy
//     .md pre           the code; a highlighted one is pre > code.hljs
//   .md table           GFM/pipe tables
//   .chart, .tbl        renderChart / renderTable (see below)
//   .stats, .steps, .tlw, .jsonv, .code, .tree, .opts, .kanban, .tracker,
//   .term, .pipe, .jobs, .diffview, .mmd   the rest; their rules are in render.css

import { buildTree, cardKey, cardPrompt, codeFromText, codeLayout, inlineTokens, lineLabel, optionLetter, optionPrompt, pipeRows, trackerTone, wrapLabel } from "./nav.mjs";

export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
};

// ── markdown ───────────────────────────────────────────────────────────────────
// GFM via marked, sanitised by DOMPurify, fenced code coloured by highlight.js
// when the host loads it. Code scrolls sideways rather than wrapping, and every
// fence gets a copy button; opts.onCopy hands the text to the host app (botsun's
// chat WebView) instead of the clipboard.

/** What a highlighter's output may keep: <span class> and nothing else. */
export const HL_CLEAN = { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false };
const PLAIN = new Set(["text", "txt", "plain", "plaintext", "output", "console", "log"]);

/** A fence's language, if it is one: lowercase, short, and not a plain-text alias. */
function langName(lang) {
  const name = String(lang || "").trim().split(/\s/, 1)[0].toLowerCase();
  return name && !PLAIN.has(name) && /^[a-z0-9_+#.-]{1,40}$/.test(name) ? name : null;
}

/**
 * Colour a fence in place. Only a named language (no guessing), only blocks up
 * to 16 KB, and the result is cut down to <span class> before use. `hljs`: a
 * host that loads highlight.js lazily passes it once loaded.
 */
export function highlightInto(code, lang, hljs = window.hljs) {
  const name = langName(lang);
  const text = code.textContent;
  // A huge fence would block a bubble's main thread; leave the big ones plain.
  if (!name || text.length > 16000 || !window.DOMPurify || !hljs?.getLanguage?.(name)) return;
  try {
    const html = hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
    if (code.textContent !== text) return; // the host changed it meanwhile
    code.innerHTML = window.DOMPurify.sanitize(html, HL_CLEAN);
    code.classList.add("hljs");
  } catch {
    // an older highlight.js, or a language this build dropped: leave it plain
  }
}

/** A fence with no language: guess, but only for blocks small enough to be quick. */
function highlightGuess(code) {
  const hljs = window.hljs;
  const text = code.textContent;
  if (!hljs?.highlightAuto || !window.DOMPurify || text.length > 20_000) return;
  try {
    const html = hljs.highlightAuto(text).value;
    if (code.textContent !== text) return;
    code.innerHTML = window.DOMPurify.sanitize(html, HL_CLEAN);
    code.classList.add("hljs");
  } catch {}
}

// What a bubble's markdown may keep: no <style>/<form> and no style= (a section
// could restyle or overlay the bubble), no media that fetches on its own, and
// images only as data: (no tracking pixels from a bot's markdown). DOMPurify's
// defaults keep video/audio/source/picture/track and srcset/background/poster,
// and some engines fetch those, so they are named here and filtered again in
// renderMarkdown.
const MD_CLEAN = {
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "video", "audio", "source", "picture", "track"],
  FORBID_ATTR: ["style", "srcset", "background", "poster"],
};
const DATA_IMG = /^data:/i;

// GFM task items: marked writes a disabled checkbox, which MD_CLEAN's no-<input>
// rule would drop with its meaning. A span with a box character keeps it, inert.
const TASK_BOX = /<input (checked="" )?disabled="" type="checkbox"\s*\/?>/g;
const taskBoxes = (html) => html.replace(TASK_BOX, (_m, on) => `<span class="task-box${on ? " done" : ""}">${on ? "\u2611" : "\u2610"}</span>`);

/**
 * Put text on the clipboard: opts.onCopy first (the host app's own pasteboard),
 * else the async Clipboard API. Throws when neither works, so the button can
 * say so.
 */
async function copyText(text, opts) {
  if (typeof opts?.onCopy === "function") return opts.onCopy(text);
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  throw new Error("no clipboard");
}

/** A copy button that confirms, then goes back to "Copy". */
function copyButton(getText, opts) {
  const b = h("button", { class: "copy", type: "button", title: "Copy", "aria-label": "Copy code" }, "Copy");
  let timer;
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    clearTimeout(timer);
    try {
      await copyText(getText(), opts);
      b.textContent = "Copied";
      b.classList.add("ok");
    } catch {
      b.textContent = "Failed";
      b.classList.add("bad");
    }
    timer = setTimeout(() => ((b.textContent = "Copy"), b.classList.remove("ok", "bad")), 1400);
  });
  return b;
}

/**
 * Markdown as a detached div.md. GFM (tables, strikethrough, autolinks) comes
 * from marked; DOMPurify decides what survives, so a bot's HTML can't script
 * the host page.
 *
 * opts (all optional): onCopy (see copyButton); imgSrc, a RegExp an <img src>
 * must match (default data: only); mermaid(box, source), drawing ```mermaid
 * fences into an empty div instead of showing their source; highlight(code,
 * lang), instead of highlightInto/highlightGuess; wrapCode(pre, code, lang),
 * putting each fence in the host's own wrapper instead of .code-wrap.
 */
export function renderMarkdown(text, opts = {}) {
  const el = h("div", { class: "md" });
  if (!window.marked || !window.DOMPurify) {
    el.append(h("pre", {}, text));
    return el;
  }
  // Parse into a <template>: its contents are inert, so nothing the bot wrote
  // is fetched or run while it is being filtered (an el.innerHTML on a div the
  // live document owns would already start an <img> fetch). What survives is
  // appended to the detached div this returns.
  const tpl = document.createElement("template");
  tpl.innerHTML = window.DOMPurify.sanitize(taskBoxes(window.marked.parse(text, { gfm: true })), MD_CLEAN);
  for (const bad of tpl.content.querySelectorAll("picture, source, video, audio, track")) bad.remove();
  // Dropping the attribute is what stops the fetch; the element (and its text)
  // stays, so <td background> keeps its cell.
  for (const el of tpl.content.querySelectorAll("[srcset], [background], [poster]")) for (const attr of ["srcset", "background", "poster"]) el.removeAttribute(attr);
  const imgOk = opts.imgSrc instanceof RegExp ? opts.imgSrc : DATA_IMG;
  for (const img of tpl.content.querySelectorAll("img")) if (!imgOk.test(img.getAttribute("src") || "")) img.remove();
  el.append(tpl.content);
  // A bubble is its own page: links leave for the real browser.
  for (const a of el.querySelectorAll("a[href]")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  if (typeof opts.mermaid === "function") {
    for (const code of el.querySelectorAll("pre > code.language-mermaid")) {
      const box = h("div");
      code.parentElement.replaceWith(box);
      opts.mermaid(box, code.textContent);
    }
  }
  for (const pre of el.querySelectorAll("pre")) {
    const code = pre.querySelector("code") || pre;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9);
    if (typeof opts.highlight === "function") opts.highlight(code, lang);
    else if (lang) highlightInto(code, lang);
    else highlightGuess(code);
    if (typeof opts.wrapCode === "function") {
      opts.wrapCode(pre, code, lang);
      continue;
    }
    // The empty span keeps the bar's layout when the fence has no language.
    const head = h("div", { class: "code-head" }, lang ? h("span", { class: "lang" }, lang) : h("span"), copyButton(() => code.textContent.replace(/\n$/, ""), opts));
    const wrap = h("div", { class: "code-wrap" });
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
  return el;
}

// ── charts ─────────────────────────────────────────────────────────────────────
// A chart section is a small JSON spec drawn here as SVG. Colours are CSS
// variables (--c1…--c8 and the status colours), so light and dark need no
// redraw. It redraws on width changes so text stays its real size.
// { type: bar|line|area|scatter|pie|donut, labels, series: [{ name, data, color }],
//   stacked, horizontal, x: { label }, y: { label, unit, prefix, min, max }, height, caption }

const SVG_NS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k != null && k !== false) el.append(typeof k === "string" || typeof k === "number" ? String(k) : k);
  return el;
}
export const tip = (text) => svg("title", {}, text);
export const NAMED = new Set(["accent", "ok", "warn", "bad", "ink", "dim"]);
export const seriesColor = (s, i) => (/^c[1-8]$/.test(s?.color) || NAMED.has(s?.color) ? `var(--${s.color})` : `var(--c${(i % 8) + 1})`);
export const textW = (s) => String(s).length * 6.4;
export const clip = (s, n = 18) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export function niceScale(lo, hi, count) {
  if (!(hi > lo)) [lo, hi] = lo === 0 ? [0, 1] : [Math.min(lo, 0), Math.max(hi, 0) || Math.abs(lo)];
  const raw = (hi - lo) / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const a = Math.floor(lo / step + 1e-9) * step;
  const b = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { lo: a, hi: b, ticks };
}

export function fmtValue(v, axis = {}, tick = false) {
  const abs = Math.abs(v);
  const opts = abs >= 1e5 ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: abs > 0 && abs < 1 ? 3 : 2 };
  const unit = axis.unit ? (axis.unit === "%" ? "%" : tick && axis.unit.length > 3 ? "" : `\u2009${axis.unit}`) : "";
  return `${axis.prefix ?? ""}${new Intl.NumberFormat(undefined, opts).format(v)}${unit}`;
}

export function renderChart(spec) {
  const pie = spec.type === "pie" || spec.type === "donut";
  const series = spec.series || [];
  const legend = pie
    ? (() => {
        const data = series[0]?.data || [];
        const total = data.reduce((a, b) => a + (b || 0), 0) || 1;
        return (spec.labels || []).map((l, i) => [l, `var(--c${(i % 8) + 1})`, ` ${fmtValue(data[i] ?? 0, spec.y)} · ${Math.round(((data[i] || 0) / total) * 100)}%`]);
      })()
    : series.length > 1
      ? series.map((s, i) => [s.name || `Series ${i + 1}`, seriesColor(s, i), ""])
      : [];
  const plot = h("div", { class: "chart-plot" });
  const wrap = h(
    "figure",
    { class: "chart" },
    legend.length ? h("div", { class: "chart-legend" }, legend.map(([name, color, extra]) => h("span", {}, h("i", { style: `background:${color}` }), name, extra ? h("em", {}, extra) : null))) : null,
    plot,
    spec.caption ? h("figcaption", { class: "chart-cap" }, spec.caption) : null,
  );
  let lastW = 0;
  let raf = 0;
  const draw = () => {
    raf = 0;
    const w = Math.floor(plot.clientWidth);
    if (!w || Math.abs(w - lastW) < 2) return;
    lastW = w;
    try {
      plot.replaceChildren(pie ? drawPie(spec, w) : drawXY(spec, w));
    } catch (e) {
      plot.replaceChildren(h("div", { class: "err" }, `chart: ${e.message}`));
    }
  };
  // Only a width change needs a redraw, and it happens one frame later: the new
  // plot changes the element's height, and resizing inside the observer's own
  // callback is what makes browsers report "ResizeObserver loop completed with
  // undelivered notifications".
  new ResizeObserver((entries) => {
    if (raf || entries.every((e) => Math.floor(e.contentRect.width) === lastW)) return;
    raf = window.requestAnimationFrame(draw);
  }).observe(plot);
  return wrap;
}

export function drawXY(spec, W) {
  const type = spec.type;
  const series = spec.series;
  const scatter = type === "scatter";
  const horiz = type === "bar" && !!spec.horizontal;
  const stacked = !!spec.stacked && (type === "bar" || type === "area");
  const labels = scatter ? [] : (spec.labels || []).map(String);
  const n = labels.length;
  const ya = spec.y || {};
  const xa = spec.x || {};
  const pts = (s) => s.data.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1], label: p[2] } : p)).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));

  // Value domain, with stacks summed and bars and areas reaching zero.
  let vals = [];
  if (scatter) vals = series.flatMap((s) => pts(s).map((p) => p.y));
  else if (stacked)
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      for (const s of series) (s.data[i] ?? 0) >= 0 ? (pos += s.data[i] ?? 0) : (neg += s.data[i]);
      vals.push(pos, neg);
    }
  else vals = series.flatMap((s) => s.data.filter((v) => Number.isFinite(v)));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (type === "bar" || type === "area") (lo = Math.min(0, lo)), (hi = Math.max(0, hi));
  const H = Math.min(Math.max(spec.height || (horiz ? n * (series.length > 1 && !stacked ? series.length * 13 + 12 : 28) + 44 : 280), 120), 900);
  const vs = niceScale(ya.min ?? lo, ya.max ?? hi, horiz ? Math.max(2, Math.floor(W / 120)) : Math.max(2, Math.floor(H / 56)));
  if (ya.min != null) (vs.lo = ya.min), (vs.ticks = vs.ticks.filter((t) => t >= ya.min));
  if (ya.max != null) (vs.hi = ya.max), (vs.ticks = vs.ticks.filter((t) => t <= ya.max));

  const tickLabels = vs.ticks.map((t) => fmtValue(t, ya, true));
  const top = 8;
  const right = 14;
  let left;
  let bottom = 22 + (horiz ? (ya.label ? 16 : 0) : xa.label ? 16 : 0);
  if (horiz) left = Math.min(Math.max(...labels.map((l) => textW(clip(l, 24)))) + 12, W * 0.4);
  else left = Math.max(...tickLabels.map(textW)) + 10 + (ya.label ? 16 : 0);
  const pw = Math.max(W - left - right, 40);
  const ph = Math.max(H - top - bottom, 40);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  const grid = svg("g", { class: "grid" });
  const axis = svg("g", { class: "axis" });
  const marks = svg("g", { class: "marks" });
  root.append(grid, marks, axis);
  const span = vs.hi - vs.lo || 1;
  const vpos = horiz ? (v) => left + ((v - vs.lo) / span) * pw : (v) => top + (1 - (v - vs.lo) / span) * ph;
  const zero = vpos(Math.min(Math.max(0, vs.lo), vs.hi));

  // Value gridlines and their labels.
  vs.ticks.forEach((t, i) => {
    const p = vpos(t);
    const cls = t === 0 ? "zero" : null;
    if (horiz) {
      grid.append(svg("line", { x1: p, x2: p, y1: top, y2: top + ph, class: cls }));
      axis.append(svg("text", { x: p, y: top + ph + 15, "text-anchor": "middle" }, tickLabels[i]));
    } else {
      grid.append(svg("line", { x1: left, x2: left + pw, y1: p, y2: p, class: cls }));
      axis.append(svg("text", { x: left - 6, y: p + 3.5, "text-anchor": "end" }, tickLabels[i]));
    }
  });
  const valueLabel = ya.label;
  if (valueLabel && horiz) axis.append(svg("text", { class: "al", x: left + pw / 2, y: H - 4, "text-anchor": "middle" }, valueLabel));
  if (valueLabel && !horiz) axis.append(svg("text", { class: "al", transform: `translate(11 ${top + ph / 2}) rotate(-90)`, "text-anchor": "middle" }, valueLabel));
  if (xa.label && !horiz) axis.append(svg("text", { class: "al", x: left + pw / 2, y: H - 4, "text-anchor": "middle" }, xa.label));

  if (scatter) {
    const xs = series.flatMap((s) => pts(s).map((p) => p.x));
    const xsc = niceScale(xa.min ?? Math.min(...xs), xa.max ?? Math.max(...xs), Math.max(2, Math.floor(pw / 90)));
    const xspan = xsc.hi - xsc.lo || 1;
    const xpos = (v) => left + ((v - xsc.lo) / xspan) * pw;
    for (const t of xsc.ticks) {
      grid.append(svg("line", { x1: xpos(t), x2: xpos(t), y1: top, y2: top + ph, class: "minor" }));
      axis.append(svg("text", { x: xpos(t), y: top + ph + 15, "text-anchor": "middle" }, fmtValue(t, xa, true)));
    }
    series.forEach((s, si) => {
      const color = seriesColor(s, si);
      for (const p of pts(s)) marks.append(svg("circle", { class: "pt", cx: xpos(p.x), cy: vpos(p.y), r: 4, style: `fill:${color}` }, tip(`${p.label ? `${p.label}: ` : ""}${s.name ? `${s.name} · ` : ""}${fmtValue(p.x, xa)}, ${fmtValue(p.y, ya)}`)));
    });
    return root;
  }

  // Categories: one band each, labels thinned to fit.
  const band = (horiz ? ph : pw) / Math.max(n, 1);
  const cpos = (i) => (horiz ? top : left) + (i + 0.5) * band;
  if (horiz) {
    labels.forEach((l, i) => axis.append(svg("text", { x: left - 6, y: cpos(i) + 3.5, "text-anchor": "end" }, clip(l, 24), l.length > 24 ? tip(l) : null)));
  } else {
    const every = Math.max(1, Math.ceil((Math.max(...labels.map((l) => textW(clip(l)))) + 10) / band));
    labels.forEach((l, i) => i % every === 0 && axis.append(svg("text", { x: cpos(i), y: top + ph + 15, "text-anchor": "middle" }, clip(l), l.length > 18 ? tip(l) : null)));
  }

  if (type === "bar") {
    const group = band * (n > 1 ? 0.74 : 0.5);
    const bw = stacked ? group : group / series.length;
    const pos = new Array(n).fill(0);
    const neg = new Array(n).fill(0);
    series.forEach((s, si) => {
      const color = seriesColor(s, si);
      s.data.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        let a = 0;
        if (stacked) v >= 0 ? ((a = pos[i]), (pos[i] += v)) : ((a = neg[i]), (neg[i] += v));
        const p0 = vpos(a);
        const p1 = vpos(a + v);
        const off = cpos(i) - group / 2 + (stacked ? 0 : si * bw);
        const thick = Math.max(bw - (stacked || series.length === 1 ? 0 : 1.5), 1);
        const rect = horiz
          ? { x: Math.min(p0, p1), y: off, width: Math.max(Math.abs(p1 - p0), 0.5), height: thick }
          : { x: off, y: Math.min(p0, p1), width: thick, height: Math.max(Math.abs(p1 - p0), 0.5) };
        marks.append(svg("rect", { class: "bar", ...rect, rx: Math.min(2.5, thick / 4), style: `fill:${color}` }, tip(`${labels[i]}${s.name ? ` · ${s.name}` : ""}: ${fmtValue(v, ya)}`)));
      });
    });
    return root;
  }

  // Lines and areas: points at band centres, a gap for each null.
  const base = new Array(n).fill(0);
  series.forEach((s, si) => {
    const color = seriesColor(s, si);
    const tops = s.data.map((v, i) => (Number.isFinite(v) ? (stacked ? base[i] + v : v) : null));
    const runs = [];
    let run = [];
    tops.forEach((v, i) => (v == null ? (run.length && runs.push(run), (run = [])) : run.push(i)));
    if (run.length) runs.push(run);
    for (const r of runs) {
      const line = r.map((i, k) => `${k ? "L" : "M"}${cpos(i).toFixed(1)},${vpos(tops[i]).toFixed(1)}`).join("");
      if (type === "area") {
        const back = r
          .slice()
          .reverse()
          .map((i) => `L${cpos(i).toFixed(1)},${(stacked ? vpos(base[i]) : zero).toFixed(1)}`)
          .join("");
        marks.append(svg("path", { class: "area", d: `${line}${back}Z`, style: `fill:${color}` }));
      }
      marks.append(svg("path", { class: "line", d: line, style: `stroke:${color}` }));
    }
    if (n <= 80)
      s.data.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        marks.append(svg("circle", { class: "pt", cx: cpos(i), cy: vpos(tops[i]), r: n <= 24 ? 3.2 : 2.2, style: `fill:${color}` }, tip(`${labels[i]}${s.name ? ` · ${s.name}` : ""}: ${fmtValue(v, ya)}`)));
      });
    if (stacked) tops.forEach((v, i) => v != null && (base[i] = v));
  });
  return root;
}

export function drawPie(spec, W) {
  const data = (spec.series[0]?.data || []).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const labels = (spec.labels || []).map(String);
  const total = data.reduce((a, b) => a + b, 0);
  const H = Math.min(Math.max(spec.height || 240, 120), 900);
  const r = Math.min(H / 2 - 6, W / 2 - 6);
  const inner = spec.type === "donut" ? r * 0.6 : 0;
  const cx = W / 2;
  const cy = H / 2;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  if (!total) return root;
  const at = (a, rad) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
  let a0 = 0;
  data.forEach((v, i) => {
    if (!v) return;
    const a1 = a0 + (v / total) * Math.PI * 2;
    const color = `var(--c${(i % 8) + 1})`;
    const label = `${labels[i] ?? ""}: ${fmtValue(v, spec.y)} (${Math.round((v / total) * 100)}%)`;
    if (v === total) {
      marks(svg("circle", { class: "slice", cx, cy, r, style: `fill:${color}` }, tip(label)));
    } else {
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const [x0, y0] = at(a0, r);
      const [x1, y1] = at(a1, r);
      let d = `M${cx},${cy}L${x0},${y0}A${r},${r} 0 ${big} 1 ${x1},${y1}Z`;
      if (inner) {
        const [ix0, iy0] = at(a0, inner);
        const [ix1, iy1] = at(a1, inner);
        d = `M${ix0},${iy0}L${x0},${y0}A${r},${r} 0 ${big} 1 ${x1},${y1}L${ix1},${iy1}A${inner},${inner} 0 ${big} 0 ${ix0},${iy0}Z`;
      }
      marks(svg("path", { class: "slice", d, style: `fill:${color}` }, tip(label)));
    }
    a0 = a1;
  });
  if (inner) {
    if (data.filter(Boolean).length === 1) root.append(svg("circle", { cx, cy, r: inner, class: "hole" }));
    root.append(svg("text", { class: "total", x: cx, y: cy + 2, "text-anchor": "middle" }, fmtValue(total, spec.y)), svg("text", { x: cx, y: cy + 18, "text-anchor": "middle" }, "total"));
  }
  return root;
  function marks(el) {
    root.append(el);
  }
}

/** A small line of numbers with a dot on the last one; null leaves a gap. */
export function sparkSvg(data, w = 90, hgt = 26, color = "var(--accent)") {
  const vals = (data || []).filter(Number.isFinite);
  if (vals.length < 2) return null;
  const lo = Math.min(...vals);
  const span = Math.max(...vals) - lo || 1;
  const x = (i) => 2 + (i / (data.length - 1)) * (w - 4);
  const y = (v) => 3 + (1 - (v - lo) / span) * (hgt - 6);
  let d = "";
  let pen = false;
  data.forEach((v, i) => {
    if (!Number.isFinite(v)) return void (pen = false);
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  let li = data.length - 1;
  while (li > 0 && !Number.isFinite(data[li])) li--;
  return svg("svg", { class: "spark", viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, "aria-hidden": "true" }, svg("path", { d, style: `stroke:${color}` }), svg("circle", { cx: x(li), cy: y(data[li]), r: 2.2, style: `fill:${color}` }));
}

// ── table ──────────────────────────────────────────────────────────────────────────
// Rows from JSON or CSV: click a header to sort (asc, desc, off), type to
// filter, typed cells (number, bar, spark, tag, link, code), 500 rows at a time.

export const TAG_TONE = [
  [/^(ok|pass(ed|ing)?|success(ful)?|succeeded|done|yes|up|green|healthy|merged|open|active)$/i, "ok"],
  [/^(fail(ed|ing|ure)?|error|errored|broken|no|down|red|critical|high|blocked)$/i, "bad"],
  [/^(warn(ing)?|pending|queued|running|medium|yellow|slow|draft|skipped|flaky)$/i, "warn"],
];

export function renderTable(spec) {
  const rows = spec.rows || [];
  let cols = spec.columns;
  if (!cols) cols = Array.isArray(rows[0]) ? rows[0].map((_, i) => `Column ${i + 1}`) : [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))];
  cols = cols.map((c, i) => (typeof c === "string" ? { label: c, key: c } : { ...c, label: c.label ?? c.key, key: c.key ?? c.label ?? String(i) }));
  const data = rows.map((r) => cols.map((c, i) => (Array.isArray(r) ? r[i] : r?.[c.key])));
  for (const [i, c] of cols.entries()) {
    if (c.type) continue;
    const vals = data.map((r) => r[i]).filter((v) => v != null && v !== "");
    c.type = !vals.length ? "text" : vals.every((v) => typeof v === "number") ? "number" : vals.every((v) => Array.isArray(v) && v.every((x) => x === null || typeof x === "number")) ? "spark" : "text";
  }
  const max = cols.map((c, i) => (c.type === "bar" ? Math.max(0, ...data.map((r) => (Number.isFinite(r[i]) ? Math.abs(r[i]) : 0))) : 0));
  const text = (v) => (v == null ? "" : Array.isArray(v) ? "" : typeof v === "object" ? String(v.text ?? v.href ?? "") : String(v));
  const haystack = data.map((r) => r.map(text).join(" \u0001 ").toLowerCase());
  const sortKey = (v, c) => (c.type === "spark" ? (Array.isArray(v) ? v.filter(Number.isFinite).at(-1) : null) : c.type === "number" || c.type === "bar" ? (Number.isFinite(v) ? v : null) : text(v) || null);

  const cell = (v, c, i) => {
    if (v == null || v === "") return h("td", { class: "nil" }, "–");
    switch (c.type) {
      case "number":
        return h("td", { class: "num" }, typeof v === "number" ? fmtValue(v, c) : String(v));
      case "bar": {
        const pct = max[i] && Number.isFinite(v) ? (Math.abs(v) / max[i]) * 100 : 0;
        return h("td", { class: "barc" }, h("div", {}, h("span", { class: "cbar" }, h("i", { style: `width:${pct.toFixed(1)}%` })), h("span", { class: "num" }, Number.isFinite(v) ? fmtValue(v, c) : String(v))));
      }
      case "spark":
        return h("td", { class: "sparkc" }, Array.isArray(v) ? sparkSvg(v, 84, 20) || "–" : String(v));
      case "tag": {
        const tone = TAG_TONE.find(([re]) => re.test(String(v).trim()))?.[1];
        return h("td", {}, h("span", { class: `ctag${tone ? ` ${tone}` : ""}` }, String(v)));
      }
      case "link": {
        const href = typeof v === "object" ? v.href : v;
        const label = typeof v === "object" ? v.text ?? v.href : v;
        return h("td", {}, /^https?:\/\//i.test(String(href)) ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, String(label)) : String(label));
      }
      case "code":
        return h("td", {}, h("code", {}, String(v)));
      default:
        return h("td", {}, text(v));
    }
  };

  const startCol = spec.sort ? cols.findIndex((c, i) => c.key === spec.sort.column || c.label === spec.sort.column || i === spec.sort.column) : -1;
  const sort = { col: startCol, desc: !!spec.sort?.desc };
  let limit = 500;
  const filter = rows.length > 8 ? h("input", { class: "tbl-filter", type: "search", placeholder: `Filter ${rows.length.toLocaleString()} rows`, "aria-label": "Filter rows" }) : null;
  const count = h("span", { class: "tbl-count" });
  const thead = h("thead");
  const tbody = h("tbody");
  const more = h("div", { class: "tbl-more" });
  const draw = () => {
    const q = filter?.value.trim().toLowerCase() || "";
    let order = data.map((_, i) => i);
    if (q) order = order.filter((i) => haystack[i].includes(q));
    if (sort.col >= 0) {
      const c = cols[sort.col];
      const keys = data.map((r) => sortKey(r[sort.col], c));
      order.sort((a, b) => {
        const x = keys[a];
        const y = keys[b];
        if (x == null || y == null) return x == null ? (y == null ? a - b : 1) : -1; // empties last
        const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
        return (sort.desc ? -d : d) || a - b;
      });
    }
    thead.replaceChildren(
      h(
        "tr",
        {},
        cols.map((c, i) => {
          const on = sort.col === i;
          const right = c.type === "number" || c.align === "right";
          return h(
            "th",
            { class: right ? "num" : null, "aria-sort": on ? (sort.desc ? "descending" : "ascending") : "none" },
            h(
              "button",
              {
                type: "button",
                class: `tbl-sort${on ? " on" : ""}`,
                title: "Sort",
                onclick: () => {
                  // Numbers start high-first, text A-Z; a third click turns sorting off.
                  const firstDesc = c.type === "number" || c.type === "bar" || c.type === "spark";
                  if (!on) Object.assign(sort, { col: i, desc: firstDesc });
                  else if (sort.desc === firstDesc) sort.desc = !sort.desc;
                  else sort.col = -1;
                  draw();
                },
              },
              c.label,
              h("span", { class: "arrow" }, on ? (sort.desc ? "▼" : "▲") : "↕"),
            ),
          );
        }),
      ),
    );
    tbody.replaceChildren(...order.slice(0, limit).map((ri) => h("tr", {}, cols.map((c, i) => cell(data[ri][i], c, i)))));
    if (!order.length) tbody.append(h("tr", {}, h("td", { class: "nil", colspan: cols.length }, "No rows match")));
    count.textContent = q ? `${order.length.toLocaleString()} of ${rows.length.toLocaleString()} rows` : `${rows.length.toLocaleString()} rows`;
    more.replaceChildren(
      order.length > limit ? h("button", { class: "term-fold", type: "button", onclick: () => ((limit += 1000), draw()) }, `Show ${Math.min(1000, order.length - limit).toLocaleString()} more of ${(order.length - limit).toLocaleString()}`) : "",
    );
  };
  filter?.addEventListener("input", () => ((limit = 500), draw()));
  draw();
  return h(
    "div",
    { class: "tbl" },
    h("div", { class: "tbl-tools" }, filter, count),
    h("div", { class: "tbl-scroll" }, h("table", { class: "ktable" }, thead, tbody)),
    more,
    spec.caption ? h("div", { class: "chart-cap" }, spec.caption) : null,
  );
}

// ── hosts ──────────────────────────────────────────────────────────────────────
// The page passes its own copy button (⌥-click quotes, ⇧-click plain text) and
// its own clipboard (with an execCommand fallback); a bubble host gets ours.

/** The copy button a host wants, or this module's own. */
const copyButtonFor = (opts) => opts?.copyButton ?? ((getText, _label, _ico, o) => copyButton(getText, { ...opts, ...o }));
const copyTextFor = (opts) => opts?.copyText ?? ((text) => copyText(text, opts));

/** ~/Code/x for /Users/me/Code/x, as the page writes paths. */
export const tilde = (p) => String(p || "").replace(/^\/(?:Users|home)\/[^/]+/, "~");

/** "3:42 PM" in the reader's locale. */
export const clock = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Today, Yesterday, or the date, for a timeline's day headings. */
export function dayLabel(d) {
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** A colour name a spec may use for a tone; anything else gets no inline style. */
export const toneVar = (t) => (/^(ok|warn|bad|accent|dim|c[1-8])$/.test(t || "") ? `var(--${t})` : "");

/** Inline `code`, **bold** and links as DOM; links become text inside a card that is itself a link. */
export const inline = (text, links = true) =>
  inlineTokens(text).map((t) => (t.t === "code" ? h("code", {}, t.v) : t.t === "b" ? h("b", {}, t.v) : t.t === "a" && links ? h("a", { href: t.href, target: "_blank", rel: "noopener noreferrer" }, t.v) : t.v));

/** An href safe to put in a link: http(s) only, else null. */
const httpHref = (u) => (/^https?:\/\//i.test(String(u ?? "")) ? String(u) : null);

/** Note text: paragraphs split on blank lines, with inline `code`, **bold** and links. */
export const noteParas = (text, lead = null) => String(text).split(/\n\s*\n/).map((p, i) => h("p", {}, i ? null : lead, inline(p)));

// ── tracker ────────────────────────────────────────────────────────────────────
// One line of card state above the board or the title: id, state, title, note.

export function renderTracker(spec) {
  const href = httpHref(spec.href);
  const title = href ? h("a", { href, target: "_blank", rel: "noopener" }, spec.title) : spec.title;
  return h(
    "div",
    { class: "tracker" },
    spec.id || spec.state ? h("div", { class: "tk-line" }, spec.id ? h("span", { class: "tk-id" }, `#${spec.id}`) : null, spec.state ? h("span", { class: `tk-state ${trackerTone(spec.state)}` }, spec.state) : null) : null,
    h("div", { class: "tk-title" }, title),
    spec.note ? h("div", { class: "tk-note" }, spec.note) : null,
  );
}

// ── stats ──────────────────────────────────────────────────────────────────────
// A row of big numbers, each with an optional delta, sparkline and note.

export function renderStats(spec) {
  const items = spec.items || [];
  return h(
    "div",
    { class: "stats" },
    items.map((it) => {
      const color = /^c[1-8]$/.test(it.color) || NAMED.has(it.color) ? `var(--${it.color})` : "var(--accent)";
      const value = typeof it.value === "number" ? fmtValue(it.value, it) : `${it.prefix ?? ""}${it.value}${it.unit ? `\u2009${it.unit}` : ""}`;
      let delta = null;
      if (it.delta != null && it.delta !== "") {
        const dir = typeof it.delta === "number" ? Math.sign(it.delta) : /^\s*-/.test(it.delta) ? -1 : /^\s*\+/.test(it.delta) ? 1 : 0;
        const text = typeof it.delta === "number" ? fmtValue(Math.abs(it.delta), { unit: it.unit === "%" ? "%" : "" }) : String(it.delta).replace(/^\s*[+-]\s*/, "");
        const good = it.good || "up";
        const cls = !dir || good === "none" ? "flat" : (dir > 0) === (good === "up") ? "ok" : "bad";
        delta = h("span", { class: `stat-delta ${cls}` }, `${dir > 0 ? "↑" : dir < 0 ? "↓" : "→"} ${text}`);
      }
      return h(
        "div",
        { class: "stat" },
        h("div", { class: "stat-label" }, it.label),
        h("div", { class: "stat-row" }, h("b", { class: "stat-value", style: it.color ? `color:${color}` : null }, value), delta),
        it.spark ? sparkSvg(it.spark, 120, 28, color) : null,
        it.note ? h("div", { class: "stat-note" }, it.note) : null,
      );
    }),
  );
}

// ── steps ──────────────────────────────────────────────────────────────────────
// A checklist with a progress bar; the agent replaces the section as steps move.

const STEP_ICON = { done: "✓", active: "", failed: "✕", skipped: "–", blocked: "!", todo: "" };

export function renderSteps(spec) {
  const steps = spec.steps || [];
  const n = (s) => steps.filter((x) => x.status === s).length;
  const counted = steps.length - n("skipped");
  const pct = counted ? (n("done") / counted) * 100 : 100;
  const extra = [n("failed") && h("span", { class: "bad" }, `${n("failed")} failed`), n("blocked") && h("span", { class: "warn" }, `${n("blocked")} blocked`), n("skipped") && h("span", {}, `${n("skipped")} skipped`)].filter(Boolean);
  return h(
    "div",
    { class: "steps" },
    h(
      "div",
      { class: "steps-head" },
      spec.title ? h("b", {}, spec.title) : null,
      h("span", { class: "steps-count" }, `${n("done")} of ${counted} done`, extra.flatMap((e) => [" · ", e])),
      h("span", { class: `steps-bar${n("failed") ? " bad" : ""}`, role: "progressbar", "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: `width:${pct.toFixed(1)}%` })),
    ),
    h(
      "ol",
      { class: "steps-list" },
      steps.map((s) =>
        h(
          "li",
          { class: `step s-${s.status}` },
          h("span", { class: "smark", title: s.status }, STEP_ICON[s.status] ?? ""),
          h("div", { class: "sbody" }, h("div", { class: "slabel" }, s.label), s.note ? h("div", { class: "snote" }, s.note) : null, s.detail ? h("pre", { class: "sdetail" }, s.detail) : null),
        ),
      ),
    ),
  );
}

// ── pipeline ──────────────────────────────────────────────────────────────────────────
// A live metro map of a multi-stage workflow: stages left to right, each a
// single node, a row of steps, or parallel lanes, with an optional loop arc
// ("revise"). Lines are blue where work has reached, nodes coloured by status.
// Text is drawn at its real size, so a wide pipeline scrolls sideways; a card
// too narrow for one row wraps it into snaking rows. The page adds its own
// wide-screen strip (pipelineNow/pipelineChips) and narrow-screen rules.

export const PIPE_LABEL = { todo: "to do", active: "in progress", done: "approved", back: "sent back", failed: "failed", skipped: "skipped" };
const PIPE_DONE = new Set(["done", "skipped"]);

/** A stage's status: its own, else what its steps add up to. */
export function stageStatus(g) {
  if (g.status) return g.status;
  const all = (g.lanes || []).flatMap((l) => l.steps.map((s) => s.status));
  if (!all.length) return "todo";
  for (const s of ["failed", "back", "active"]) if (all.includes(s)) return s;
  if (all.every((s) => PIPE_DONE.has(s))) return all.every((s) => s === "skipped") ? "skipped" : "done";
  return all.some((s) => s === "done") ? "active" : "todo";
}
export const pipelineRunning = (spec) => !(spec.stages || []).every((g) => PIPE_DONE.has(stageStatus(g)));

const PIPE_MARK = { todo: "○", active: "●", done: "✓", back: "↩", failed: "✗", skipped: "–" };

/** Text width in px for a CSS font, from an offscreen canvas (a rough guess without one). */
let measureCtx;
function textWidth(text, font) {
  if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d") ?? null; // null: asked once, no canvas
  if (!measureCtx) return String(text).length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(String(text)).width;
}
/** Text cut with … to fit max px. */
function fitText(text, max, font) {
  text = String(text ?? "");
  if (!(max < Infinity) || textWidth(text, font) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(text.slice(0, mid).trimEnd() + "…", font) <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + "…";
}
/** One line per stage for narrow screens: "Build: Package 1 › Implementer ✓ · critic ✓ · …". */
function stageSummary(g) {
  const lanes = g.lanes || [];
  const st = stageStatus(g);
  if (!lanes.length) return `${g.label}: ${PIPE_LABEL[st]}${g.note ? ` · ${g.note}` : ""}`;
  const steps = lanes.flatMap((ln, i) => ln.steps.map((s, j) => `${j === 0 && ln.label && lanes[i - 1]?.label !== ln.label ? `${ln.label} › ` : ""}${s.label} ${PIPE_MARK[s.status]}`));
  return `${g.label}: ${steps.join(" · ")}${g.loop ? ` (${g.loop.label}${g.loop.note ? `, ${g.loop.note}` : ""})` : ""}`;
}

/** Where the work is: the stage index and a line like "Build › Package 2 › critic: sent back". */
export function pipelineNow(spec) {
  const stages = spec.stages || [];
  for (const want of ["failed", "back", "active"]) {
    for (let i = 0; i < stages.length; i++) {
      const g = stages[i];
      for (const ln of g.lanes || []) {
        const st = ln.steps.find((s) => s.status === want);
        if (st) return { stage: i, status: want, text: [g.label, ln.label, st.label].filter(Boolean).join(" › ") + (want === "active" ? "" : `: ${PIPE_LABEL[want]}`) };
      }
      if (!(g.lanes || []).length && stageStatus(g) === want) return { stage: i, status: want, text: g.label + (want === "active" ? "" : `: ${PIPE_LABEL[want]}`) };
    }
  }
  const next = stages.findIndex((g) => !PIPE_DONE.has(stageStatus(g)));
  if (next < 0) return { stage: stages.length - 1, status: "done", text: "All stages done" };
  return { stage: next, status: "todo", text: `Next: ${stages[next].label}` };
}

/** The stage chips: a numbered pill per stage, coloured by status. */
export function pipelineChips(spec, onPick, current = -1) {
  return h(
    "div",
    { class: "pipe-chips" },
    (spec.stages || []).map((g, i) => {
      const st = stageStatus(g);
      const chip = h("button", { class: `pipe-chip p-${st}${i === current ? " now" : ""}`, type: "button", title: `${g.label}: ${PIPE_LABEL[st]}` }, h("span", { class: "num" }, PIPE_DONE.has(st) && st === "done" ? "✓" : String(i + 1)), g.label);
      chip.addEventListener("click", () => onPick(i));
      return chip;
    }),
  );
}

/** Wrapped pipelines lay out again when their card changes width; one observer serves them all. */
const pipeWraps = new Set();
const pipeRO = typeof ResizeObserver === "function" ? new ResizeObserver((es) => es.forEach((e) => e.target.relayout?.())) : null;
function pipeObserve(wrap) {
  for (const w of pipeWraps) if (w.seen && !w.isConnected) (pipeRO?.unobserve(w), pipeWraps.delete(w));
  pipeWraps.add(wrap);
  pipeRO?.observe(wrap);
}

export function renderPipeline(spec) {
  const stages = spec.stages || [];
  const GAP = 64;
  const labelledLanes = stages.some((g) => (g.lanes || []).some((l) => l.label));
  const PAD = 40;
  // Wrapped rows: the line U-turns TURN px in from the card's edge.
  const WPAD = 52;
  const TURN = WPAD - GAP / 2;
  const LH = 15; // a label's second line
  // Each stage's columns are as wide as its widest text (within limits); longer text is cut with … and shown whole on hover.
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const F = { pl: `600 12.5px ${FONT}`, pn: `11px ${FONT}`, pb: "600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace" };
  const COL_MIN = 128;
  const COL_MAX = 210;
  const colOf = (g) => {
    const items = g.lanes?.length ? g.lanes.flatMap((l) => l.steps.flatMap((s) => [[s.label, F.pl], [s.note, F.pn]])) : [[g.label, F.pl], [g.note, F.pn]];
    return Math.min(COL_MAX, Math.max(COL_MIN, ...items.filter(([t]) => t).map(([t, f]) => textWidth(t, f) + 18)));
  };
  // split: one lane and no loop, so a row may break between its steps.
  const sizes = stages.map((g) => ({ cols: Math.max(1, ...(g.lanes || []).map((l) => l.steps.length)), lanes: Math.max(1, (g.lanes || []).length), col: colOf(g), split: (g.lanes || []).length === 1 && !g.loop }));
  // Step and stage labels take up to two lines; a row with any makes room for it.
  const plWidth = (t) => textWidth(t, F.pl);
  const twoOf = stages.map((g, k) => (g.lanes?.length ? g.lanes.flatMap((l) => l.steps.map((s) => s.label)) : [g.label]).some((t) => wrapLabel(t, sizes[k].col - 12, plWidth).length > 1));
  const n = stages.length;
  // Lane spacing: labelled lanes each get a box, which grows with two-line step labels; keep a gap between boxes.
  const LANE = labelledLanes ? 100 + (twoOf.some(Boolean) ? LH : 0) : 86;
  /** A row's height and line: room above the top lane and below the bottom one for what is drawn there. */
  const geomOf = (units) => {
    const two = units.some((u) => twoOf[u.k]) ? LH : 0;
    const maxLanes = Math.max(...units.map((u) => sizes[u.k].lanes));
    const steps = units.flatMap(({ k, a, b }) => (stages[k].lanes || []).flatMap((l, i) => l.steps.slice(a, b).map((s) => ({ s, looped: stages[k].loop && i === 0 }))));
    const single = units.filter((u) => !stages[u.k].lanes?.length);
    const ends = single.filter((u) => u.k === 0 || u.k === n - 1).map((u) => stages[u.k]);
    const mids = single.filter((u) => u.k > 0 && u.k < n - 1).map((u) => stages[u.k]);
    const above = two + Math.max(36, steps.length || mids.length ? 40 : 0, steps.some(({ s, looped }) => s.badge && !looped) ? 52 : 0);
    const below = two + Math.max(
      44,
      ends.length ? 46 : 0,
      ends.some((g) => g.note) ? 60 : 0,
      steps.some(({ s, looped }) => s.note && !looped) || mids.some((g) => g.note) ? 42 : 0,
      steps.some(({ looped }) => looped) ? 38 : 0,
      steps.some(({ s, looped }) => s.note && looped) ? 52 : 0,
    );
    const labelled = units.some((u) => (stages[u.k].lanes || []).some((l) => l.label));
    const top = Math.max(above + (units.some((u) => stages[u.k].loop) ? 58 : 0), labelled ? 64 + two : 0);
    const mainY = top + ((maxLanes - 1) * LANE) / 2;
    return { two, mainY, H: mainY + ((maxLanes - 1) * LANE) / 2 + below };
  };
  const color = (st) => ({ done: "var(--ok)", active: "var(--c1)", back: "var(--warn)", failed: "var(--bad)" })[st] || "var(--dim)";
  const reached = (st) => st !== "todo" && st !== "skipped";
  const unitW = (u) => (u.b - u.a) * sizes[u.k].col;
  const rowW = (row) => row.reduce((s, u, i) => s + unitW(u) + (i ? GAP : 0), 0);
  const whole = sizes.map((s, k) => ({ k, a: 0, b: s.cols }));
  const naturalW = rowW(whole) + 2 * PAD;
  const firstStatus = ({ k, a }) => ((stages[k].lanes || []).length === 1 ? (stages[k].lanes[0].steps[a]?.status ?? stageStatus(stages[k])) : stageStatus(stages[k]));

  /**
   * The map for a card A px wide (0: not known yet). It stays one row while it
   * fits at 85% scale; past that it wraps into rows that snake: odd rows run
   * right to left (every x mirrored), joined by a U-turn at the edge.
   */
  function build(A) {
    const wrapped = A > 0 && naturalW * 0.85 > A;
    const pad = wrapped ? WPAD : PAD;
    const rows = wrapped ? pipeRows(sizes, A - 2 * pad, GAP) : [whole];
    const W = wrapped ? Math.max(A, ...rows.map((r) => rowW(r) + 2 * pad)) : naturalW;
    const geoms = rows.map(geomOf);
    const offs = geoms.map((_, r) => geoms.slice(0, r).reduce((s, g) => s + g.H, 0));
    const bands = svg("g", { class: "pipe-bands" });
    const edges = svg("g", { class: "pipe-edges" });
    const loops = svg("g", { class: "pipe-loops" });
    const nodes = svg("g", { class: "pipe-nodes" });
    const edge = (d, on) => edges.append(svg("path", { d, class: on ? "on" : "" }));

    rows.forEach((row, r) => {
      const dir = r % 2 ? -1 : 1;
      const { two, mainY, H } = geoms[r];
      const laneY = (i, m) => mainY + (i - (m - 1) / 2) * LANE;
      const X = (x) => (dir > 0 ? x : W - x);
      const Y = (y) => offs[r] + y;
      const P = (x, y) => `${X(x)},${Y(y)}`;
      const rect = (x, y, w, hh, attrs) => svg("rect", { x: dir > 0 ? x : W - x - w, y: Y(y), width: w, height: hh, ...attrs });
      const anc = (a) => (dir > 0 || a === "middle" ? a : a === "end" ? "start" : "end");
      // stack: 0 one line; -1 two lines growing up (above a node); 1 growing down. .extra is the px it grew.
      const label = (cx, y, text, cls, anchor = "middle", max = Infinity, stack = 0) => {
        const ls = stack ? wrapLabel(text, max, (t) => textWidth(t, F[cls])) : [fitText(text, max, F[cls])];
        const t = svg("text", { x: X(cx), y: Y(stack < 0 ? y - LH * (ls.length - 1) : y), class: cls, "text-anchor": anc(anchor) }, ls[0]);
        if (ls[1]) t.append(svg("tspan", { x: X(cx), dy: LH }, ls[1]));
        if (ls.length > 1 || ls[0] !== text) t.append(tip(text));
        t.extra = (ls.length - 1) * LH;
        return t;
      };
      const node = (cx, cy, st, title) => {
        const g = svg("g", { class: `pnode p-${st}` }, tip(`${title}: ${PIPE_LABEL[st]}`));
        if (st === "active") g.append(svg("circle", { cx: X(cx), cy: Y(cy), r: 9, class: "pulse-ring", style: `stroke:${color(st)}` }));
        g.append(svg("circle", { cx: X(cx), cy: Y(cy), r: 8.5, class: "ring", style: `stroke:${color(st)}` }));
        if (reached(st)) g.append(svg("circle", { cx: X(cx), cy: Y(cy), r: 3.8, style: `fill:${color(st)}` }));
        return g;
      };

      // One stage, or the steps a..b-1 of one split across rows; gIn/gOut: the gaps either side.
      const drawUnit = ({ k, a, b }, x0, gIn, gOut) => {
        const g = stages[k];
        const st = stageStatus(g);
        const COL = sizes[k].col;
        const fit = COL - 12;
        const w = (b - a) * COL;
        const jIn = x0 - gIn / 2;
        const jOut = x0 + w + gOut / 2;
        const lanes = g.lanes || [];
        const more = lanes.length === 1 && b < lanes[0].steps.length; // the stage goes on in the next row
        const hasIn = k > 0 || a > 0;
        const hasOut = k + 1 < n || more;
        // A stretch of line is blue when the node it leads to has been reached (the next stage's first step, not its status).
        const nextOn = more ? reached(lanes[0].steps[b].status) : k + 1 < n && reached(firstStatus({ k: k + 1, a: 0 }));
        bands.append(rect(x0 - GAP / 4, 4, w + GAP / 2, H - 8, { rx: 10, class: "band", "data-stage": k }));
        if (!lanes.length) {
          // A single node: a bar at either end of the line, a pill in between.
          const cx = x0 + w / 2;
          const end = k === 0 || k === n - 1;
          const box = svg("g", { class: `pnode p-${st}` }, tip(`${g.label}: ${PIPE_LABEL[st]}`));
          if (end) box.append(rect(cx - 3.5, mainY - 18, 7, 36, { rx: 2, style: `fill:${reached(st) ? color(st) : "var(--dim)"}` }));
          else {
            if (st === "active") box.append(rect(cx - 30, mainY - 14, 60, 28, { rx: 14, class: "pulse-ring", style: `stroke:${color(st)}` }));
            box.append(rect(cx - 30, mainY - 14, 60, 28, { rx: 14, class: "ring", style: `stroke:${color(st)}` }));
            if (reached(st)) [-10, 0, 10].forEach((d) => box.append(svg("circle", { cx: X(cx + d), cy: Y(mainY), r: 2.6, style: `fill:${color(st)}` })));
          }
          nodes.append(box);
          const l = label(cx, end ? mainY + 34 : mainY - 24, g.label, "pl", "middle", fit, end ? 1 : -1);
          nodes.append(l);
          if (g.note) nodes.append(label(cx, end ? mainY + 49 + l.extra : mainY + 30, g.note, "pn", "middle", fit));
          const half = end ? 4 : 30;
          if (hasIn) edge(`M${P(jIn, mainY)}L${P(cx - half, mainY)}`, reached(st));
          if (hasOut) edge(`M${P(cx + half, mainY)}L${P(jOut, mainY)}`, nextOn);
          return;
        }
        lanes.forEach((ln, i) => {
          const y = laneY(i, lanes.length);
          const part = ln.steps.slice(a, b);
          if (!part.length) return;
          const cxs = part.map((_, j) => x0 + j * COL + COL / 2);
          // Lanes in a row with the same label share one box (a package of work).
          if (ln.label && lanes[i - 1]?.label !== ln.label) {
            let last = i;
            while (lanes[last + 1]?.label === ln.label) last++;
            const yEnd = laneY(last, lanes.length);
            bands.append(rect(x0 + 6, y - 58 - two, w - 12, yEnd - y + 92 + two, { rx: 8, class: "lane-box" }));
            bands.append(label(x0 + w - 14, y - 44 - two, ln.label.toUpperCase(), "lane-l", "end"));
          }
          // In from the junction, step to step, out to the next junction. Boxed (labelled) lanes run straight to
          // their box's edge and bend only in the gap outside it, clear of the lane labels.
          const boxed = lanes.some((l) => l.label);
          if (hasIn) {
            const a0 = boxed ? x0 + 6 : cxs[0];
            const mx = (jIn + a0) / 2;
            edge(y === mainY ? `M${P(jIn, mainY)}L${P(cxs[0], y)}` : `M${P(jIn, mainY)}C${P(mx, mainY)} ${P(mx, y)} ${P(a0, y)}L${P(cxs[0], y)}`, reached(part[0].status));
          }
          for (let j = 1; j < cxs.length; j++) edge(`M${P(cxs[j - 1], y)}L${P(cxs[j], y)}`, reached(part[j].status));
          if (hasOut) {
            const last = boxed ? x0 + w - 6 : x0 + w - COL / 2;
            const lx = cxs[cxs.length - 1];
            const mx = (last + jOut) / 2;
            edge(`M${P(lx, y)}L${P(last, y)}` + (y === mainY ? `L${P(jOut, mainY)}` : `C${P(mx, y)} ${P(mx, mainY)} ${P(jOut, mainY)}`), nextOn);
          }
          // Under a loop arc, labels go below the node and badges out to the side, clear of the arc.
          const looped = g.loop && i === 0;
          part.forEach((s, j) => {
            nodes.append(node(cxs[j], y, s.status, s.label));
            const l = label(cxs[j], looped ? y + 26 : y - 17, s.label, "pl", "middle", fit, looped ? 1 : -1);
            nodes.append(l);
            if (s.badge) {
              const bl = looped ? label(cxs[j] + (j === 0 ? -14 : 14), y - 12, s.badge, "pb", j === 0 ? "end" : "start") : label(cxs[j], y - 33 - l.extra, s.badge, "pb");
              bl.style.fill = s.status === "todo" ? "var(--dim)" : color(s.status);
              nodes.append(bl);
            }
            if (s.note) nodes.append(label(cxs[j], looped ? y + 41 + l.extra : y + 25, s.note, "pn", "middle", fit));
          });
        });
        if (g.loop) {
          // From the last step of the top lane back to its first (a looping stage never splits).
          const ln = lanes[0];
          const y = laneY(0, lanes.length);
          const x1 = x0 + COL / 2;
          const x2 = x0 + (ln.steps.length - 1) * COL + COL / 2;
          const lift = 62;
          loops.append(svg("path", { d: `M${P(x2, y - 9)}C${P(x2, y - lift)} ${P(x1, y - lift)} ${P(x1, y - 9)}`, class: "loop" }));
          const mx = (x1 + x2) / 2;
          loops.append(label(mx, y - lift + 2, g.loop.label, "loop-l"));
          if (g.loop.note) {
            const t = label(mx, y - lift - 15, g.loop.note, "loop-n");
            const wNote = g.loop.note.length * 6.2 + 16;
            loops.append(rect(mx - wNote / 2, y - lift - 27, wNote, 18, { rx: 9, class: "loop-pill" }), t);
          }
        }
      };

      // Every row but the last spreads its stages over the full width.
      const spare = W - 2 * pad - rowW(row);
      const gap = r < rows.length - 1 && row.length > 1 ? GAP + Math.min(spare / (row.length - 1), GAP * 2) : GAP;
      let x = pad;
      // Into and out of a turn, the line meets the curve (TURN + 18 from the edge) rather than running under it.
      const EDGE = 2 * (pad - TURN - 18);
      row.forEach((u, i) => {
        drawUnit(u, x, i ? gap : wrapped ? EDGE : GAP, i < row.length - 1 ? gap : wrapped ? EDGE : GAP);
        x += unitW(u) + gap;
      });
      if (r < rows.length - 1) {
        // Out to the edge, down, and into the next row going the other way.
        const xt = X(W - TURN);
        const y1 = Y(mainY);
        const y2 = offs[r + 1] + geoms[r + 1].mainY;
        const c = 18 * dir;
        edge(`M${X(x - gap + EDGE / 2)},${y1}L${xt - c},${y1}Q${xt},${y1} ${xt},${y1 + 18}L${xt},${y2 - 18}Q${xt},${y2} ${xt - c},${y2}`, reached(firstStatus(rows[r + 1][0])));
      }
    });

    // One row may draw up to 15% narrower before it scrolls; wrapped rows are drawn at the card's width.
    const style = wrapped ? `width:${W}px;max-width:none;height:auto` : `width:100%;max-width:${W}px;min-width:${Math.round(W * 0.85)}px;height:auto`;
    const map = svg("svg", { class: "pipe-svg", viewBox: `0 0 ${W} ${offs[rows.length - 1] + geoms[rows.length - 1].H}`, style, role: "img", "aria-label": spec.title || "Pipeline" }, bands, edges, loops, nodes);
    return { map, W, key: wrapped ? `w${W}` : "one" };
  }

  let built = build(0);
  const wrap = h("div", { class: "pipe-wrap" }, built.map);
  wrap.relayout = () => {
    wrap.seen = true;
    const A = Math.floor(wrap.clientWidth);
    if (A < 160) return; // hidden (narrow screens show the chips alone)
    const next = build(A);
    if (next.key === built.key) return;
    built.map.replaceWith(next.map);
    built = next;
  };
  pipeObserve(wrap);
  // Narrow screens hide the map; a chip then spells out its stage here instead.
  const detail = h("div", { class: "pipe-detail", "aria-live": "polite" });
  const now = pipelineNow(spec);
  const flash = (i) => {
    detail.textContent = stageSummary(stages[i]);
    const all = [...built.map.querySelectorAll(`.band[data-stage="${i}"]`)]; // a split stage has one per row
    if (!all.length) return;
    const bx = Number(all[0].getAttribute("x"));
    wrap.scrollTo({ left: Math.max(0, bx * (built.map.getBoundingClientRect().width / built.W) - 24), behavior: "smooth" }); // the map may be drawn smaller
    for (const band of all) {
      band.classList.remove("on");
      void band.getBoundingClientRect();
      band.classList.add("on");
      setTimeout(() => band.classList.remove("on"), 1600);
    }
  };
  const used = new Set(stages.flatMap((g) => [stageStatus(g), ...(g.lanes || []).flatMap((l) => l.steps.map((s) => s.status))]));
  const legend = h(
    "span",
    { class: "pipe-legend" },
    ["active", "back", "done", "failed"].filter((s) => s !== "failed" || used.has(s)).map((s) => h("span", { class: `p-${s}` }, h("i"), PIPE_LABEL[s])),
  );
  const el = h(
    "div",
    { class: "pipe" },
    h("div", { class: "pipe-head" }, spec.title ? h("b", {}, spec.title) : null, h("span", { class: `pipe-now p-${now.status}` }, now.text), legend),
    wrap,
    pipelineChips(spec, flash, now.status === "done" ? -1 : now.stage),
    detail,
  );
  el.flashStage = flash;
  return el;
}

// ── background jobs ────────────────────────────────────────────────────────────
// The auto-jobs card (kind "jobs"): bg.ts's background jobs, one compact row
// each. The spec is what index.ts's jobsSpec() writes:
//   { jobs: [{ id, name, command,         // command: whitespace folded, ≤300 chars
//              log,                       // the log file's path (the page copies it)
//              started, ended,            // ISO strings; ended null while running
//              exit, signal,              // exit code / signal name, or null
//              stopped,                   // true when the user killed it
//              tail,                      // the log's last lines, or null
//              hidden }] }                // true: the command may print secrets, no tail
// Running jobs come first (oldest first), then ended ones (newest first).
//   scheduled: [{ id, name,                // name: a short label (≤40 chars), never the prompt
//                 kind, every,             // once|interval|daily|cron; "every 5m", "daily 15:30", …
//                 next, last,              // ISO strings or null
//                 status,                  // armed|paused|running|ok|error|timeout|skipped
//                 source }]                // session|agent|durable
// Scheduled tasks follow the jobs in their own group (or stand alone), soonest first, with
// "next in 4:12" counting down while the card is attached. They are not buttons either way.
// opts.onOpen(index, jobs): the page's full-screen log; with it each row is a
// button. Without it (a bubble: no modal, no daemon routes) each row shows its
// log tail inline in a <details>. Running times tick while the card is attached.

/** "42s", "3m05s", "1h02m". */
export function elapsedText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
/** A local date and time, or "" for a bad date. */
export const fullDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

/** live | stopped | ok | bad. */
export function jobState(j) {
  const live = !j.ended;
  const ok = !live && j.exit === 0 && !j.signal;
  return live ? "live" : j.stopped ? "stopped" : ok ? "ok" : "bad";
}
/** Elapsed time while running (data-since: it ticks), else ✓ / ✗ with the exit and how long it took. */
export function jobTime(j) {
  const state = jobState(j);
  if (state === "live") return h("span", { class: "job-el", "data-since": j.started, title: `Started ${fullDate(j.started)}` }, elapsedText(Date.now() - Date.parse(j.started)));
  const took = elapsedText(Date.parse(j.ended) - Date.parse(j.started));
  return h("span", { class: `job-el ${state}`, title: `Ended ${fullDate(j.ended)}` }, state === "stopped" ? `stopped · ${took}` : state === "ok" ? `✓ ${took}` : `✗ ${j.signal || `exit ${j.exit}`} · ${took}`);
}
export const jobDot = (j) => h("span", { class: `pulse ${{ live: "working", ok: "ok", bad: "error" }[jobState(j)] || "idle"}` });
/** The log tail as text, or why there is none. */
export const jobLog = (j) =>
  j.hidden ? h("p", { class: "job-m-none" }, "Output not shown: the command may print secrets.") : j.tail ? h("pre", { class: "job-m-log" }, j.tail) : h("p", { class: "job-m-none" }, j.ended ? "No output." : "No output yet.");

/**
 * Redraw root with swap() and keep what the reader opened: a <details data-key> that was open is
 * open again after the redraw (a job's log folded open stays open as its tail updates), and its
 * log keeps its scroll, or stays at the bottom if it was there.
 */
export function keepOpen(root, swap) {
  const was = new Map();
  for (const d of root.querySelectorAll("details[data-key][open]")) {
    const pre = d.querySelector("pre");
    was.set(d.dataset.key, pre ? { top: pre.scrollTop, end: pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 2 } : null);
  }
  swap();
  if (!was.size) return;
  for (const d of root.querySelectorAll("details[data-key]")) {
    if (!was.has(d.dataset.key)) continue;
    d.open = true;
    const pre = d.querySelector("pre");
    const at = was.get(d.dataset.key);
    if (pre && at) pre.scrollTop = at.end ? pre.scrollHeight : at.top;
  }
}

/** "4:12", "1:02:03", "2d 3h": how long until a scheduled run; "now" once it is due. */
export function countdownText(ms) {
  const s = Math.ceil(ms / 1000);
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d ${Math.floor((s % 86400) / 3600)}h`;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}
const untilText = (iso) => {
  const c = countdownText(Date.parse(iso) - Date.now());
  return c === "now" ? "due now" : `next in ${c}`;
};
const agoText = (iso) => `${elapsedText(Date.now() - Date.parse(iso))} ago`;
const updateTimes = (root) => {
  for (const t of root.querySelectorAll("[data-since]")) t.textContent = elapsedText(Date.now() - Date.parse(t.dataset.since));
  for (const t of root.querySelectorAll("[data-until]")) t.textContent = untilText(t.dataset.until);
  for (const t of root.querySelectorAll("[data-ago]")) t.textContent = agoText(t.dataset.ago);
};

const SCHED_DOT = { armed: "armed", paused: "idle", running: "working", ok: "ok", error: "error", timeout: "error", skipped: "idle" };
const SCHED_LAST = { ok: "✓", error: "✗ error", timeout: "✗ timeout", skipped: "skipped" };
const validIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
/** One scheduled task: dot, name, when it runs next (counting down), then its schedule and last run. */
export function schedRow(t) {
  const status = SCHED_DOT[t.status] ? t.status : "armed";
  const when =
    status === "paused"
      ? h("span", { class: "job-el" }, "paused")
      : status === "running"
        ? h("span", { class: "job-el ok" }, "running")
        : validIso(t.next)
          ? h("span", { class: "job-el", "data-until": t.next, title: `Next ${fullDate(t.next)}` }, untilText(t.next))
          : h("span", { class: "job-el" }, "no next run");
  const meta = [h("span", { class: "sched-every" }, String(t.every || t.kind || ""))];
  if (validIso(t.last)) {
    const mark = SCHED_LAST[t.status];
    meta.push(h("span", { class: `sched-last${t.status === "ok" ? " ok" : t.status === "error" || t.status === "timeout" ? " bad" : ""}`, title: `Last run ${fullDate(t.last)}` }, "last ", h("span", { "data-ago": t.last }, agoText(t.last)), mark ? ` · ${mark}` : ""));
  }
  if (t.source === "durable") meta.push(h("span", { class: "sched-src", title: "A /schedule task: runs without an open session" }, "durable"));
  else if (t.source === "agent") meta.push(h("span", { class: "sched-src", title: "Set by the agent with the schedule tool" }, "agent"));
  return h(
    "div",
    { class: `job sched ${status}`, "data-sched": String(t.id || "") },
    h("span", { class: `pulse ${SCHED_DOT[status]}` }),
    h("b", {}, String(t.name || t.id || "")),
    when,
    h("div", { class: "sched-meta" }, ...meta),
  );
}

/** Keep every [data-since] / [data-until] / [data-ago] under root ticking while it is attached; stops once it is gone. */
function tickSince(root) {
  if (!root.querySelector("[data-since], [data-until], [data-ago]")) return;
  let was = false;
  let idle = 0;
  const iv = setInterval(() => {
    if (root.isConnected) {
      was = true;
      idle = 0;
      if (root.checkVisibility?.() === false) return; // a display:none bubble: nothing to show
      updateTimes(root);
    } else if (was || ++idle > 10) clearInterval(iv);
  }, 1000);
}

export function renderJobs(spec, opts = {}) {
  const jobs = spec.jobs || [];
  const scheduled = Array.isArray(spec.scheduled) ? spec.scheduled : [];
  if (!jobs.length && !scheduled.length) return h("p", { class: "k-muted jobs-none" }, "No background jobs.");
  const open = typeof opts.onOpen === "function" ? opts.onOpen : null;
  const list = h(
    "div",
    { class: "jobs" },
    jobs.map((j, i) => {
      const parts = [jobDot(j), h("b", {}, j.name), jobTime(j), h("code", { class: "job-cmd" }, j.command)];
      if (!open) return h("div", { class: `job ${jobState(j)}`, "data-job": j.id }, ...parts, h("details", { class: "job-tail", "data-key": `job:${j.id}` }, h("summary", {}, "Log"), jobLog(j)));
      const row = h("div", { class: `job ${jobState(j)}`, "data-job": j.id, tabindex: "0", role: "button", title: "Open the log" }, ...parts);
      row.addEventListener("click", () => open(i, jobs));
      row.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        open(i, jobs);
      });
      return row;
    }),
  );
  if (scheduled.length) list.append(h("div", { class: "sched-hd" }, "Scheduled"), ...scheduled.map(schedRow));
  tickSince(list);
  return list;
}

// ── terminal ───────────────────────────────────────────────────────────────────
// Command output with its ANSI colours (mapped to --t0…--t15 so they follow
// the theme), a line count, a filter for long logs, and a tail while it runs.

function applySgr(style, params) {
  const p = params === "" ? [0] : params.split(";").map(Number);
  const c256 = (n) => {
    if (n < 16) return n;
    if (n >= 232) return `rgb(${[0, 0, 0].map(() => 8 + (n - 232) * 10).join(",")})`;
    const v = (x) => (x ? x * 40 + 55 : 0);
    n -= 16;
    return `rgb(${v(Math.floor(n / 36))},${v(Math.floor(n / 6) % 6)},${v(n % 6)})`;
  };
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) for (const k of Object.keys(style)) delete style[k];
    else if (n === 1) style.b = 1;
    else if (n === 2) style.dim = 1;
    else if (n === 3) style.i = 1;
    else if (n === 4) style.u = 1;
    else if (n === 7) style.inv = 1;
    else if (n === 22) delete style.b, delete style.dim;
    else if (n === 23) delete style.i;
    else if (n === 24) delete style.u;
    else if (n === 27) delete style.inv;
    else if (n >= 30 && n <= 37) style.fg = n - 30;
    else if (n >= 90 && n <= 97) style.fg = n - 90 + 8;
    else if (n === 39) delete style.fg;
    else if (n >= 40 && n <= 47) style.bg = n - 40;
    else if (n >= 100 && n <= 107) style.bg = n - 100 + 8;
    else if (n === 49) delete style.bg;
    else if (n === 38 || n === 48) {
      const key = n === 38 ? "fg" : "bg";
      if (p[i + 1] === 5) (style[key] = c256(p[i + 2] || 0)), (i += 2);
      else if (p[i + 1] === 2) (style[key] = `rgb(${p[i + 2] || 0},${p[i + 3] || 0},${p[i + 4] || 0})`), (i += 4);
    }
  }
}

/** Output split into lines of [text, style] runs, with \r redraws applied and other escapes dropped. */
function parseAnsi(text) {
  const lines = [];
  const style = {};
  let segs = [];
  let plain = "";
  const push = (t) => {
    t = t.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    if (t) segs.push([t, { ...style }]), (plain += t);
  };
  const end = () => {
    lines.push({ segs, plain });
    segs = [];
    plain = "";
  };
  text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  const re = /\x1b\[([0-9;?]*)([A-Za-z])|\r\n|\n|\r/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[0] === "\n" || m[0] === "\r\n") end();
    else if (m[0] === "\r") (segs = []), (plain = "");
    else if (m[2] === "m") applySgr(style, m[1]);
  }
  push(text.slice(last));
  if (segs.length || plain) end();
  return lines;
}

function ansiCss(st) {
  const color = (c) => (typeof c === "number" ? `var(--t${c})` : c);
  let fg = st.fg != null ? color(st.fg) : null;
  let bg = st.bg != null ? color(st.bg) : null;
  if (st.inv) [fg, bg] = [bg || "var(--code)", fg || "var(--ink)"];
  return [fg && `color:${fg}`, bg && `background:${bg}`, st.b && "font-weight:700", st.dim && "opacity:.65", st.i && "font-style:italic", st.u && "text-decoration:underline"].filter(Boolean).join(";");
}

const lineTint = (s) =>
  /(?<!\b0 )\b(error|errors|failed|failure|fatal|panic|exception)\b|✖|✗|^\s*not ok\b|^\s*FAIL\b/i.test(s)
    ? " bad"
    : /\b(warn|warning|deprecated)\b/i.test(s)
      ? " warn"
      : /✔|✓|^\s*ok\b|^\s*PASS\b|(?<!\b0 )\bpassed\b/.test(s)
        ? " ok"
        : "";

function fmtSeconds(s) {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function renderTerminal(spec, opts = {}) {
  const output = spec.output || "";
  const lines = parseAnsi(output);
  const colored = /\x1b\[[0-9;]*m/.test(output);
  const running = spec.running && spec.started;
  const count = h("span", { class: "term-count" });
  const filter = lines.length > 15 ? h("input", { class: "term-filter", type: "search", placeholder: "Filter lines", "aria-label": "Filter lines" }) : null;
  // A command still going: a pulse and an elapsed time that ticks between writes.
  let clock = null;
  let stop = null;
  if (running) {
    const t0 = Date.parse(spec.started);
    const label = h("span");
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
      label.textContent = `running ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}`;
    };
    tick();
    let was = false;
    let idle = 0;
    const iv = setInterval(() => {
      if (label.isConnected) (was = true), (idle = 0), tick();
      // Re-rendered or closed, or rendered but never attached (a 3 s refresh
      // can replace a body before inserting it): stop ticking either way.
      else if (was || ++idle > 10) clearInterval(iv);
    }, 1000);
    stop = () => clearInterval(iv);
    clock = h("span", { class: "term-running" }, h("span", { class: "pulse working" }), label);
  }
  const head = h(
    "div",
    { class: "term-head" },
    h("code", { class: "term-cmd" }, spec.command ? [h("span", { class: "term-ps" }, "$ "), spec.command] : h("span", { class: "term-ps" }, "output")),
    h(
      "span",
      { class: "term-meta" },
      spec.cwd ? h("span", { title: spec.cwd }, tilde(spec.cwd)) : null,
      clock,
      !running && spec.duration != null ? h("span", {}, typeof spec.duration === "number" ? fmtSeconds(spec.duration) : spec.duration) : null,
      spec.exit != null ? h("span", { class: `term-exit ${spec.exit === 0 ? "ok" : "bad"}` }, `exit ${spec.exit}`) : null,
      h("span", {}, `${lines.length.toLocaleString()} line${lines.length === 1 ? "" : "s"}`),
    ),
  );
  const copy = copyButtonFor(opts)(() => lines.map((l) => l.plain).join("\n"), "Copy output", null, { plain: "code" });
  const tools = filter ? h("div", { class: "term-tools" }, filter, count, copy) : null;
  if (!filter) head.lastChild.append(copy);
  const body = h("div", { class: "term-body" });
  const lineEl = (l, i, q) => {
    const text = h("span", { class: "tx" });
    if (q) {
      // Filtered lines show plain text with the matches marked.
      const low = l.plain.toLowerCase();
      let at = 0;
      for (let k = low.indexOf(q); k >= 0; k = low.indexOf(q, at)) {
        text.append(l.plain.slice(at, k), h("mark", {}, l.plain.slice(k, k + q.length)));
        at = k + q.length;
      }
      text.append(l.plain.slice(at));
    } else for (const [t, st] of l.segs) text.append(Object.keys(st).length ? h("span", { style: ansiCss(st) }, t) : t);
    return h("div", { class: `tl${colored ? "" : lineTint(l.plain)}` }, h("span", { class: "ln" }, i + 1), text);
  };
  const HEAD = 30;
  const TAIL = 40;
  let expanded = false;
  const draw = () => {
    const q = filter?.value.trim().toLowerCase() || "";
    body.replaceChildren();
    if (q) {
      const hits = [];
      lines.forEach((l, i) => l.plain.toLowerCase().includes(q) && hits.push(i));
      for (const i of hits.slice(0, 2000)) body.append(lineEl(lines[i], i, q));
      if (!hits.length) body.append(h("div", { class: "term-none" }, "No lines match"));
      count.textContent = `${hits.length.toLocaleString()} of ${lines.length.toLocaleString()}`;
      return;
    }
    count.textContent = "";
    if (expanded || lines.length <= HEAD + TAIL + 10) lines.forEach((l, i) => body.append(lineEl(l, i)));
    else if (running) {
      // Still going: the newest lines matter, so only the tail shows.
      const hidden = lines.length - TAIL;
      body.append(h("button", { class: "term-fold", type: "button", onclick: () => ((expanded = true), draw()) }, `Show ${hidden.toLocaleString()} earlier lines`));
      lines.slice(-TAIL).forEach((l, k) => body.append(lineEl(l, hidden + k)));
    } else {
      lines.slice(0, HEAD).forEach((l, i) => body.append(lineEl(l, i)));
      const hidden = lines.length - HEAD - TAIL;
      body.append(h("button", { class: "term-fold", type: "button", onclick: () => ((expanded = true), draw()) }, `Show ${hidden.toLocaleString()} more lines`));
      lines.slice(-TAIL).forEach((l, k) => body.append(lineEl(l, lines.length - TAIL + k)));
    }
    if (!lines.length) body.append(h("div", { class: "term-none" }, running ? "No output yet" : "No output"));
  };
  filter?.addEventListener("input", draw);
  draw();
  // Follow the newest line while it runs (once in the page).
  if (running) requestAnimationFrame(() => (body.scrollTop = body.scrollHeight));
  const el = h("div", { class: `term${running ? " running" : ""}` }, head, tools, body);
  // A host that drops a running body before inserting it stops the clock here.
  if (stop) el.dispose = stop;
  return el;
}

// ── timeline ───────────────────────────────────────────────────────────────────
// Events down a line. When every event has a real time they are sorted
// (unless order is "given"), grouped under day headings, and the gap since
// the previous event is shown; text times are shown as written.

function fmtGap(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(m / 1440);
  const hr = Math.round((m % 1440) / 60);
  return `${d}d${hr ? ` ${hr}h` : ""}`;
}

export function renderTimeline(spec) {
  const toDate = (at) => (typeof at === "number" ? new Date(at) : typeof at === "string" && /\d{4}-\d{2}-\d{2}|^\d{1,2}:\d{2}/.test(at) ? new Date(/^\d{1,2}:\d{2}/.test(at) ? `1970-01-01T${at.padStart(5, "0")}` : at) : null);
  let events = (spec.events || []).map((e, i) => ({ ...e, i, d: toDate(e.at) }));
  const dated = events.every((e) => e.d && !Number.isNaN(e.d.getTime()));
  const timeOnly = dated && events.every((e) => typeof e.at === "string" && /^\d{1,2}:\d{2}/.test(e.at));
  if (dated && spec.order !== "given") events = [...events].sort((a, b) => a.d - b.d || a.i - b.i);
  const list = h("ol", { class: "tline" });
  let lastDay = "";
  let prev = null;
  for (const e of events) {
    if (dated && !timeOnly) {
      const day = e.d.toDateString();
      if (day !== lastDay) list.append(h("li", { class: "tday" }, dayLabel(e.d)));
      lastDay = day;
    }
    const gap = dated && prev ? fmtGap(e.d - prev.d) : "";
    const tone = /^(ok|warn|bad|accent|dim|c[1-8])$/.test(e.tone) ? `var(--${e.tone})` : "var(--line)";
    list.append(
      h(
        "li",
        { class: `tev${e.tone ? " toned" : ""}`, style: `--tone:${tone}` },
        h("div", { class: "twhen" }, h("span", { title: dated && !timeOnly ? e.d.toLocaleString() : null }, dated ? (timeOnly ? e.at : clock(e.d)) : e.at ?? ""), gap ? h("span", { class: "tgap" }, `+${gap}`) : null),
        h("span", { class: "tdot" }),
        h(
          "div",
          { class: "tbody" },
          h("div", { class: "ttitle" }, e.title, e.tag ? h("span", { class: `ctag${/^(ok|warn|bad)$/.test(e.tone) ? ` ${e.tone}` : ""}` }, e.tag) : null),
          e.note ? h("div", { class: "tnote" }, e.note) : null,
        ),
      ),
    );
    prev = e;
  }
  const span = dated && events.length > 1 ? fmtGap(events.at(-1).d - events[0].d) : "";
  return h("div", { class: "tlw" }, list, spec.caption || span ? h("div", { class: "chart-cap" }, [spec.caption, span && `${events.length} events over ${span}`].filter(Boolean).join(" · ")) : null);
}

// ── json ───────────────────────────────────────────────────────────────────────
// A collapsible tree, built lazily as nodes open. Two levels open to start;
// the filter keeps the paths to matching keys and values and opens them.
// Clicking a key copies its jq-style path.

export function renderJson(text, opts = {}) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return h("pre", { class: "err" }, `Not JSON: ${e.message}`);
  }
  const copy = copyButtonFor(opts);
  const copyTextNow = copyTextFor(opts);
  const isObj = (v) => v && typeof v === "object";
  // jq-style paths: the root is ".", its children ".key" and ".[0]".
  const childPath = (p, k) => {
    const b = p === "." ? "" : p;
    if (typeof k === "number") return `${b || "."}[${k}]`;
    return /^[A-Za-z_$][\w$]*$/.test(k) ? `${b}.${k}` : `${b || "."}[${JSON.stringify(k)}]`;
  };
  const entriesOf = (v) => (Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v));
  const filter = h("input", { class: "tbl-filter", type: "search", placeholder: "Filter keys and values", "aria-label": "Filter keys and values" });
  const count = h("span", { class: "tbl-count" });
  const tree = h("div", { class: "jt" });
  let state = { open: "auto", keep: null, q: "", budget: 0 };

  const marked = (s, q) => {
    if (!q) return s;
    const k = s.toLowerCase().indexOf(q);
    return k < 0 ? s : [s.slice(0, k), h("mark", {}, s.slice(k, k + q.length)), s.slice(k + q.length)];
  };
  const prim = (v) => {
    const t = v === null ? "null" : typeof v;
    return h("span", { class: `jv j-${t}` }, marked(t === "string" ? JSON.stringify(v) : String(v), state.q));
  };
  const keyEl = (k, path) =>
    k == null
      ? null
      : h(
          "button",
          {
            type: "button",
            class: `jk${typeof k === "number" ? " idx" : ""}`,
            title: `Copy path ${path}`,
            onclick: async (e) => {
              e.stopPropagation();
              await copyTextNow(path).catch(() => {});
              e.target.classList.add("copied");
              setTimeout(() => e.target.classList.remove("copied"), 900);
            },
          },
          typeof k === "number" ? String(k) : marked(k, state.q),
        );
  const node = (k, v, path, depth, free) => {
    if (!isObj(v)) return h("div", { class: "jn leaf" }, h("span", { class: "jtog" }), keyEl(k, path), k != null ? h("span", { class: "jp" }, ": ") : null, prim(v));
    const entries = entriesOf(v);
    const arr = Array.isArray(v);
    const kids = h("div", { class: "jc" });
    const tog = h("span", { class: "jtog" }, entries.length ? "▸" : "");
    const preview = h("span", { class: "jprev" }, arr ? `[ ${entries.length} item${entries.length === 1 ? "" : "s"} ]` : `{ ${entries.length} key${entries.length === 1 ? "" : "s"} }`);
    const row = h("div", { class: "jrow" }, tog, keyEl(k, path), k != null ? h("span", { class: "jp" }, ": ") : null, preview);
    const wrap = h("div", { class: "jn" }, row, kids);
    let built = false;
    const build = () => {
      built = true;
      const keep = free ? null : state.keep;
      let shown = entries.filter(([ck]) => !keep || keep.has(childPath(path, ck)));
      const LIMIT = 200;
      const add = (from) => {
        for (const [ck, cv] of shown.slice(from, from + LIMIT)) {
          const cp = childPath(path, ck);
          // Below a match, everything shows; elsewhere the filter keeps only paths that lead to one.
          kids.append(node(ck, cv, cp, depth + 1, free || (keep && state.hits.has(cp))));
        }
        if (shown.length > from + LIMIT) {
          const more = h("button", { type: "button", class: "term-fold jmore", onclick: () => (more.remove(), add(from + LIMIT)) }, `Show ${Math.min(LIMIT, shown.length - from - LIMIT)} more of ${shown.length - from - LIMIT}`);
          kids.append(more);
        }
      };
      add(0);
    };
    const set = (open) => {
      if (open && !built) build();
      wrap.classList.toggle("open", open);
      tog.textContent = entries.length ? (open ? "▾" : "▸") : "";
    };
    row.addEventListener("click", () => entries.length && set(!wrap.classList.contains("open")));
    let open;
    if (state.keep && !free) open = true;
    else if (state.open === "all") open = state.budget-- > 0;
    else if (state.open === "none") open = depth === 0;
    else open = depth < 2 && entries.length <= 60;
    if (open && entries.length) set(true);
    return wrap;
  };

  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    state.q = q;
    state.keep = null;
    state.hits = new Set();
    if (q) {
      const keep = new Set(["."]);
      let seen = 0;
      const walk = (v, path, k, trail) => {
        if (++seen > 50000 || state.hits.size >= 500) return;
        const hit = (k != null && typeof k === "string" && k.toLowerCase().includes(q)) || (!isObj(v) && String(v).toLowerCase().includes(q));
        if (hit) {
          state.hits.add(path);
          for (const t of trail) keep.add(t);
          keep.add(path);
        }
        if (isObj(v)) for (const [ck, cv] of entriesOf(v)) walk(cv, childPath(path, ck), ck, [...trail, path]);
      };
      walk(root, ".", null, []);
      state.keep = keep;
      count.textContent = `${state.hits.size >= 500 ? "500+" : state.hits.size} match${state.hits.size === 1 ? "" : "es"}`;
    } else count.textContent = "";
    tree.replaceChildren(node(null, root, ".", 0, false));
    if (q && !state.hits.size) tree.replaceChildren(h("div", { class: "term-none" }, "Nothing matches"));
  };
  filter.addEventListener("input", () => ((state.open = "auto"), draw()));
  const btn = (label, mode) => h("button", { type: "button", class: "btn", onclick: () => ((state.open = mode), (state.budget = 3000), (filter.value = ""), draw()) }, label);
  draw();
  return h("div", { class: "jsonv" }, h("div", { class: "tbl-tools" }, filter, count, h("span", { class: "jtools" }, btn("Expand all", "all"), btn("Collapse", "none"), copy(() => JSON.stringify(root, null, 2), "Copy JSON"))), tree);
}

// ── code ───────────────────────────────────────────────────────────────────────
// A file's lines with numbers, highlighted bands, notes under their lines, and
// the language coloured. A bubble has no daemon to read a file, so its spec
// carries `text` (the VM tool sends the file's own text).

export function renderCode(spec, opts = {}) {
  // A host with the file's own text (a bubble, which has no daemon to read it)
  // sends { text, lines, highlight, notes }: normalise that to the shape below.
  if (spec?.text != null && spec.code == null) spec = codeFromText(spec, opts.langFor ?? langFor);
  const load = opts.loadHighlight ?? (() => Promise.resolve(window.hljs ?? null));
  const rows = codeLayout(spec);
  const last = rows.at(-1)?.n || 1;
  const body = h("div", { class: "code-body", style: `--gut:${String(last).length + 0.5}ch`, "data-rv-file": spec.path || "code", "data-rv-lang": spec.lang || "" });
  const cells = [];
  for (const r of rows) {
    const lc = h("span", { class: "lc" }, r.text || "\u200b");
    cells.push(lc);
    body.append(h("div", { class: `cl${r.hl ? " hl" : ""}${r.tone ? " toned" : ""}`, style: r.tone ? `--tone:${toneVar(r.tone)}` : null, "data-line": r.n }, h("span", { class: "ln", "data-rv": `:${r.n}` }, String(r.n)), lc));
    for (const n of r.notes) body.append(h("div", { class: "code-note", style: n.tone ? `--tone:${toneVar(n.tone)}` : null }, ...noteParas(n.text, h("span", { class: "at" }, lineLabel(n.from, n.to)))));
  }
  const shown = rows.length ? `lines ${rows[0].n}–${last} of ${spec.total}` : "";
  const head = h("div", { class: "code-head" }, h("span", { class: "path" }, spec.path || ""), h("span", {}, rows.length === spec.total ? `${spec.total} lines` : shown), spec.lang ? h("span", { class: "ctag" }, spec.lang) : null);
  // Highlight the whole range at once (a string or comment can span lines), then split the result back into rows.
  if (spec.lang && !PLAIN.has(spec.lang) && String(spec.code).length <= 200000)
    load().then((hl) => {
      if (!hl?.getLanguage(spec.lang) || !window.DOMPurify) return;
      try {
        const tmp = document.createElement("code");
        tmp.innerHTML = window.DOMPurify.sanitize(hl.highlight(String(spec.code), { language: spec.lang, ignoreIllegals: true }).value, HL_CLEAN);
        const lines = lineNodes(tmp);
        if (lines.length === cells.length) cells.forEach((c, i) => lines[i].length && c.replaceChildren(...lines[i]));
      } catch {}
    });
  return h("div", { class: "code" }, head, body, spec.caption ? h("div", { class: "code-cap" }, inline(spec.caption)) : null);
}

/** A highlighted element's content as one list of nodes per line; a span that crosses a line break is split, so every line stands alone. */
function lineNodes(root) {
  const lines = [[]];
  const walk = (node, chain) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === Node.TEXT_NODE) {
        ch.textContent.split("\n").forEach((part, i) => {
          if (i) lines.push([]);
          if (!part) return;
          let el = document.createTextNode(part);
          for (let j = chain.length - 1; j >= 0; j--) {
            const c = chain[j].cloneNode(false);
            c.append(el);
            el = c;
          }
          lines.at(-1).push(el);
        });
      } else if (ch.nodeType === Node.ELEMENT_NODE) walk(ch, [...chain, ch]);
    }
  };
  walk(root, []);
  return lines;
}

// ── tree ───────────────────────────────────────────────────────────────────────
// Folders fold; a tag colours the name; a folder's row sums the tags below it.
// Where a fold is remembered is the host's business: opts.folds reads and writes
// one map, opts.foldKey names this tree's entry in it. A bubble passes none and
// starts with the default (open when the tree is small).

const TREE_TONE = { added: "ok", changed: "warn", deleted: "bad", renamed: "c5", moved: "c5" };
const FOLDER_ICON = ["M1.8 4.2c0-.6.4-1 1-1h3.4l1.4 1.5h5.6c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z"];
const FILE_ICON = ["M4 1.8h5l3.2 3.2v9.2H4z", "M9 1.8V5h3.2"];

export function renderTree(spec, opts = {}) {
  const nodes = buildTree(spec.entries);
  const total = spec.entries?.length || 0;
  const folds = opts.folds ?? { read: () => ({}), write: () => {} };
  const foldKey = opts.foldKey ?? ((path) => path);
  const saved = folds.read();
  const glyph = (paths) => svg("svg", { class: "ico", viewBox: "0 0 16 16", width: 13, height: 13, "aria-hidden": "true" }, ...paths.map((d) => svg("path", { d, fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linejoin": "round" })));
  const list = (kids, depth) =>
    h(
      "ul",
      {},
      kids.map((n) => {
        const tone = TREE_TONE[n.tag];
        const sum = n.dir ? Object.entries(n.counts || {}).map(([t, c]) => `${c} ${t}`).join(" · ") || `${n.files} file${n.files === 1 ? "" : "s"}` : "";
        const row = h(
          "div",
          { class: `tr${n.dir ? " dir" : ""}${n.tag ? ` t-${n.tag}` : ""}`, title: n.path, ...(n.dir ? { role: "button", tabindex: "0" } : {}) },
          n.dir ? h("span", { class: "caret", "aria-hidden": "true" }, "▸") : h("span", { class: "caret" }),
          glyph(n.dir ? FOLDER_ICON : FILE_ICON),
          h("span", { class: "nm" }, n.dir ? `${n.name}/` : n.name),
          n.tag ? h("span", { class: "ttag", style: `--tone:${toneVar(tone)}` }, n.tag) : null,
          n.note ? h("span", { class: "note" }, inline(n.note)) : null,
          n.dir ? h("span", { class: "sum" }, sum) : null,
        );
        const li = h("li", {}, row);
        if (n.dir) {
          const sub = list(n.kids, depth + 1);
          const key = foldKey(n.path);
          const set = (open) => ((sub.hidden = !open), row.classList.toggle("open", open), row.setAttribute("aria-expanded", String(open)));
          set(saved[key] ?? (total <= 150 || depth < 1));
          const flip = () => {
            const open = sub.hidden;
            set(open);
            folds.write({ ...folds.read(), [key]: open });
          };
          row.addEventListener("click", flip);
          row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), flip()));
          li.append(sub);
        }
        return li;
      }),
    );
  return h("div", { class: "tree" }, spec.root ? h("div", { class: "tree-root" }, `${spec.root}/`) : null, list(nodes, 0), spec.caption ? h("div", { class: "tree-cap" }, inline(spec.caption)) : null);
}

// ── options ────────────────────────────────────────────────────────────────────
// Choices side by side: a letter, the label, pros and cons, scores, and a Pick
// button whose prompt (`optionPrompt`) goes to the host: the page sends it to pi
// (⌥-click copies), a bubble posts it back to the app.

export function renderOptions(spec, opts = {}) {
  const pick = (prompt) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (opts.onSend) return opts.onSend(prompt, e);
    return copyText(prompt, opts).catch(() => {});
  };
  const title = opts.onSend ? "Send this choice to pi (⌥-click: copy the prompt)" : "Copy this choice";
  const cards = (spec.options || []).map((o, i) =>
    h(
      "div",
      { class: `opt${o.recommended ? " rec" : ""}` },
      h("div", { class: "opt-hd" }, h("span", { class: "letter" }, optionLetter(i)), h("b", {}, inline(o.label)), o.recommended ? h("span", { class: "opt-badge" }, "Recommended") : null),
      o.cost ? h("div", { class: "opt-cost" }, o.cost) : null,
      o.summary ? h("div", {}, inline(o.summary)) : null,
      o.pros ? h("ul", { class: "pros" }, o.pros.map((p) => h("li", {}, h("span", {}, inline(p))))) : null,
      o.cons ? h("ul", { class: "cons" }, o.cons.map((p) => h("li", {}, h("span", {}, inline(p))))) : null,
      o.scores
        ? h(
            "div",
            { class: "opt-scores" },
            Object.entries(o.scores).flatMap(([k, v]) => [h("span", {}, k), h("span", { class: "cbar", title: `${k}: ${v}/5` }, h("i", { style: `width:${(v / 5) * 100}%` })), h("span", {}, String(v))]),
          )
        : null,
      h("div", { class: "opt-ft" }, h("button", { class: "btn", type: "button", title, onclick: pick(optionPrompt(spec, i)) }, "Pick")),
    ),
  );
  return h("div", {}, spec.question ? h("div", { class: "opts-q" }, inline(spec.question)) : null, h("div", { class: "opts" }, cards), spec.caption ? h("div", { class: "opt-cap" }, inline(spec.caption)) : null);
}

// ── kanban ─────────────────────────────────────────────────────────────────────
// Columns side by side, or stacked when the card is narrow (the side panel, a
// phone): a container query, so the same board fits both places.
// opts.onCard(card, column) opens the host's detail modal; opts.moves carries the
// "new" / → column marks the host stores; opts.ownerChip(owner) links an owner
// to its session. With no modal (a bubble), each card carries a Send instead.

export function renderKanban(spec, opts = {}) {
  const cols = spec.columns || [];
  const boardName = spec.title || opts.title || "Board";
  const todo = opts.section === "auto-tasks";
  const count = (c) => (c.cards || []).length + (Number(c.more) || 0);
  const busy = cols.some((c) => !c.compact && count(c));
  const marks = opts.moves || {};
  const folds = opts.folds ?? { read: () => ({}), write: () => {} };
  const foldKey = opts.foldKey ?? ((label) => label);
  const saved = folds.read();
  const owner = opts.ownerChip ?? ((name) => h("span", { class: "kb-owner", "data-owner": name }, `@${name}`));

  const card = (k, c) => {
    const mv = marks[cardKey(k)];
    const href = httpHref(k.href);
    const prompt = () => cardPrompt(k, c.label, { todo, board: boardName });
    // A bubble has no card modal, so the card's own Send hands it to the app.
    const send = !opts.onCard && opts.onSend ? h("button", { class: "btn", type: "button", title: "Send this card to pi", onclick: (e) => (e.preventDefault(), e.stopPropagation(), opts.onSend(prompt(), e)) }, "Send to pi") : null;
    const li = h(
      "li",
      { class: `kb-card${toneVar(k.tone) ? " toned" : ""}${mv ? " moved" : ""}`, style: toneVar(k.tone) ? `--card-tone:${toneVar(k.tone)}` : null, ...(opts.onCard ? { tabindex: "0", "aria-haspopup": "dialog" } : {}) },
      h(
        "div",
        { class: "kb-title", title: c.compact ? k.title : null },
        k.id ? h("span", { class: "kb-id" }, k.id) : null,
        href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, inline(k.title, false)) : inline(k.title),
        mv ? h("span", { class: "kb-moved", title: mv === "new" ? "New since you last looked" : `Moved to ${mv} since you last looked` }, mv === "new" ? "new" : `→ ${mv}`) : null,
      ),
      k.note && !c.compact ? h("div", { class: "kb-note" }, inline(k.note)) : null,
      (k.tag || k.owner || send) && !c.compact ? h("div", { class: "kb-meta" }, k.tag ? h("span", { class: `ctag${/^(ok|warn|bad)$/.test(k.tone) ? ` ${k.tone}` : ""}` }, k.tag) : null, k.owner ? owner(k.owner) : null, send) : null,
    );
    // A click (not on a link, not a text selection) or Enter opens the card's details.
    if (opts.onCard) {
      li.addEventListener("click", (e) => !e.target.closest("a, button") && !String(getSelection?.() || "") && opts.onCard(k, c));
      li.addEventListener("keydown", (e) => {
        if (e.target !== li || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        e.stopPropagation();
        opts.onCard(k, c);
      });
    }
    return li;
  };

  const column = (c) => {
    const n = count(c);
    const over = c.limit && n > c.limit;
    const key = foldKey(c.label);
    const foldable = c.compact && n > 0;
    const label = [foldable ? h("span", { class: "kb-chev", "aria-hidden": "true" }, "›") : null, h("span", { class: "kb-label" }, c.label), h("span", { class: "kb-n", title: c.limit ? `${n} cards, WIP limit ${c.limit}${over ? " (over)" : ""}` : `${n} cards` }, c.limit ? `${n}/${c.limit}` : String(n))];
    // A compact column (Done) folds when nothing else is on the board, unless opened by hand.
    const shut = foldable && (saved[key] ?? !busy);
    const head = foldable ? h("button", { class: "kb-fold", type: "button", "aria-expanded": String(!shut) }, label) : h("header", {}, label);
    const col = h(
      "section",
      { class: `kb-col${over ? " over" : ""}${n ? "" : " empty"}${c.compact ? " compact" : ""}${shut ? " folded" : ""}`, style: toneVar(c.tone) ? `--tone:${toneVar(c.tone)}` : null },
      head,
      n ? h("ul", { class: "kb-cards" }, (c.cards || []).map((k) => card(k, c))) : h("div", { class: "kb-empty" }, "Nothing here"),
      c.more ? h("div", { class: "kb-more" }, `+${c.more} more`) : null,
    );
    if (foldable)
      head.addEventListener("click", () => {
        const now = !col.classList.contains("folded");
        col.classList.toggle("folded", now);
        head.setAttribute("aria-expanded", String(!now));
        folds.write({ ...folds.read(), [key]: now });
      });
    return col;
  };

  const parts = cols.map((c) => ({ c, n: count(c) })).filter((p) => p.n);
  const progress = spec.progress
    ? h(
        "div",
        { class: "kb-progress" },
        h("div", { class: "kb-bar", "aria-hidden": "true" }, parts.map((p) => h("i", { style: `flex:${p.n};background:${toneVar(p.c.tone) || "var(--line)"}`, title: `${p.c.label}: ${p.n}` }))),
        h("div", { class: "kb-sum" }, parts.map((p) => `${p.n} ${p.c.label.toLowerCase()}`).join(" · ") || "Nothing on the board"),
      )
    : null;
  // Empty columns shrink to a thin labelled strip when the columns sit side by side.
  const tpl = cols.map((c) => (count(c) ? "minmax(170px, 1fr)" : "36px")).join(" ");
  const board = h("div", { class: "kb-cols", style: `--kb-tpl:${tpl}` }, cols.map(column));
  return h("div", { class: "kanban" }, spec.title ? h("div", { class: "kb-head" }, h("b", {}, spec.title)) : null, progress, board, spec.caption ? h("div", { class: "chart-cap" }, spec.caption) : null);
}

// ── diffs ──────────────────────────────────────────────────────────────────────
// A patch splits into files, each a block with old and new line numbers, its
// lines coloured by the file's extension, and the words that changed marked in
// paired -/+ lines. The page adds a summary bar, the Unified / Split switch,
// review comments and the modal on top; a bubble shows the blocks alone.

export const DIFF_LANGS = { rb: "ruby", rake: "ruby", gemspec: "ruby", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", mts: "typescript", json: "json", py: "python", rs: "rust", go: "go", sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", md: "markdown", html: "xml", erb: "xml", xml: "xml", svg: "xml", css: "css", scss: "scss", less: "less", sql: "sql", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cs: "csharp", ini: "ini", toml: "ini", php: "php", lua: "lua", pl: "perl", graphql: "graphql", mk: "makefile", diff: "diff", patch: "diff" };

export function langFor(path) {
  const name = String(path || "").split("/").pop().toLowerCase();
  if (["gemfile", "rakefile", "guardfile", "brewfile"].includes(name)) return "ruby";
  if (name === "makefile") return "makefile";
  return DIFF_LANGS[name.includes(".") ? name.split(".").pop() : ""] || "";
}

/** A patch as files: { from, to, path, status, binary, hunks: [{ head, rows: [{ t, a, b, text }] }], adds, dels }. */
export function parsePatch(text) {
  const files = [];
  let f = null;
  let hunk = null;
  let remA = 0;
  let remB = 0;
  const start = () => {
    f = { from: "", to: "", path: "", status: "modified", binary: false, hunks: [], adds: 0, dels: 0, minus: false };
    files.push(f);
    hunk = null;
  };
  const strip = (p) => (p === "/dev/null" ? "" : p.replace(/\t.*$/, "").replace(/^[ab]\//, ""));
  for (const line of text.split("\n")) {
    // Inside a hunk the header's counts say which lines belong to it, so a
    // removed line that reads "-- x" is never taken for a file header.
    if (hunk && (remA > 0 || remB > 0)) {
      const c = line[0];
      if (c === "+") (hunk.rows.push({ t: "add", b: hunk.b++, text: line.slice(1) }), f.adds++, remB--);
      else if (c === "-") (hunk.rows.push({ t: "del", a: hunk.a++, text: line.slice(1) }), f.dels++, remA--);
      else if (c === " " || line === "") (hunk.rows.push({ t: "ctx", a: hunk.a++, b: hunk.b++, text: line.slice(1) }), remA--, remB--);
      else if (c === "\\") hunk.rows.push({ t: "note", text: line.slice(2) });
      else hunk = null;
      if (hunk) continue;
    }
    if (hunk && line.startsWith("\\")) {
      hunk.rows.push({ t: "note", text: line.slice(2) });
      continue;
    }
    let m;
    if ((m = line.match(/^diff --git a\/(.+?) b\/(.+)$/))) {
      start();
      f.from = m[1];
      f.to = m[2];
    } else if (line.startsWith("--- ")) {
      if (!f || f.hunks.length || f.minus) start();
      f.minus = true;
      f.from = strip(line.slice(4));
      if (!f.from) f.status = "added";
    } else if (line.startsWith("+++ ") && f) {
      f.to = strip(line.slice(4));
      if (!f.to) f.status = "deleted";
    } else if (f && line.startsWith("new file mode")) f.status = "added";
    else if (f && line.startsWith("deleted file mode")) f.status = "deleted";
    else if (f && line.startsWith("rename from ")) (f.status = "renamed"), (f.from = line.slice(12));
    else if (f && line.startsWith("rename to ")) (f.status = "renamed"), (f.to = line.slice(10));
    else if (line.startsWith("Binary files ")) {
      if (!f) start();
      f.binary = true;
    } else if ((m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/))) {
      if (!f) start();
      hunk = { head: line, a: Number(m[1]), b: Number(m[3]), rows: [] };
      f.hunks.push(hunk);
      remA = m[2] === undefined ? 1 : Number(m[2]);
      remB = m[4] === undefined ? 1 : Number(m[4]);
    }
  }
  for (const x of files) x.path = x.to || x.from;
  return files.filter((x) => x.hunks.length || x.binary || x.status !== "modified");
}

const wordTokens = (s) => s.match(/\w+|\s+|[^\w\s]/g) || [];

/** The changed character ranges of a and b (LCS over words), or null when too long or too different to help. */
export function wordRanges(a, b) {
  const x = wordTokens(a);
  const y = wordTokens(b);
  if (!x.length || !y.length || x.length * y.length > 40000) return null;
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ra = [];
  const rb = [];
  let i = 0;
  let j = 0;
  let pa = 0;
  let pb = 0;
  let same = 0;
  const add = (r, s, e) => (r.length && r[r.length - 1][1] === s ? (r[r.length - 1][1] = e) : r.push([s, e]));
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      same += x[i].length;
      pa += x[i++].length;
      pb += y[j++].length;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      add(rb, pb, (pb += y[j++].length));
    } else {
      add(ra, pa, (pa += x[i++].length));
    }
  }
  // Mostly rewritten lines read better whole than speckled with marks.
  if (same < 0.4 * Math.max(a.length, b.length)) return null;
  return [ra, rb];
}

/** Wrap character ranges of el's text in <mark>, across any highlight spans. */
export function markRanges(el, ranges) {
  if (!ranges?.length) return;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n; (n = walk.nextNode()); ) nodes.push(n);
  let pos = 0;
  for (const node of nodes) {
    const start = pos;
    const end = (pos += node.data.length);
    const cuts = ranges.filter(([s, e]) => s < end && e > start).map(([s, e]) => [Math.max(s, start) - start, Math.min(e, end) - start]);
    if (!cuts.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const [s, e] of cuts) {
      if (s > at) frag.append(node.data.slice(at, s));
      frag.append(h("mark", {}, node.data.slice(s, e)));
      at = e;
    }
    if (at < node.data.length) frag.append(node.data.slice(at));
    node.replaceWith(frag);
  }
}

function codeCell(row, hl, lang, ranges) {
  const td = h("td", { class: "code" });
  if (!row) return (td.classList.add("blank"), td);
  let html = null;
  if (hl && lang && row.t !== "note" && row.text.length <= 2000 && window.DOMPurify) {
    try {
      html = window.DOMPurify.sanitize(hl.highlight(row.text, { language: lang, ignoreIllegals: true }).value, HL_CLEAN);
    } catch {}
  }
  if (html != null) td.innerHTML = html;
  else td.textContent = row.text;
  markRanges(td, ranges);
  return td;
}

/** Each del paired with the add at the same place in its change block: Map row -> ranges. */
export function pairWords(rows) {
  const marks = new Map();
  for (let i = 0; i < rows.length; ) {
    if (rows[i].t !== "del" && rows[i].t !== "add") {
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].t === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].t === "add") adds.push(rows[i++]);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const r = wordRanges(dels[k].text, adds[k].text);
      if (r) (marks.set(dels[k], r[0]), marks.set(adds[k], r[1]));
    }
  }
  return marks;
}

export function hunkRows(hunk, split, hl, lang) {
  const marks = pairWords(hunk.rows);
  const out = [h("tr", { class: "hunk" }, h("td", { colspan: split ? 4 : 3 }, hunk.head))];
  // A gutter cell that takes review comments carries data-rv="side:n".
  const ln = (n, side) => h("td", { class: "ln", ...(side && n != null ? { "data-rv": `${side}:${n}` } : {}) }, n ?? "");
  if (!split) {
    // Unified: one commentable cell per row, the new line's (the old one's for a deletion).
    for (const r of hunk.rows) out.push(h("tr", { class: r.t }, ln(r.a, r.t === "del" ? "old" : null), ln(r.b, r.t === "add" || r.t === "ctx" ? "new" : null), codeCell(r, hl, lang, marks.get(r))));
    return out;
  }
  const rows = hunk.rows;
  for (let i = 0; i < rows.length; ) {
    const r = rows[i];
    if (r.t === "ctx" || r.t === "note") {
      const side = r.t === "ctx";
      out.push(h("tr", { class: r.t }, ln(r.a, side && "old"), codeCell(r, hl, lang), ln(r.b, side && "new"), codeCell(r, hl, lang)));
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].t === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].t === "add") adds.push(rows[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k];
      const a = adds[k];
      out.push(h("tr", { class: "pair" }, ln(d?.a, d && "old"), codeCell(d, hl, lang, marks.get(d)), ln(a?.b, a && "new"), codeCell(a, hl, lang, marks.get(a))));
      const tr = out[out.length - 1];
      if (d) (tr.children[0].classList.add("del"), tr.children[1].classList.add("del"));
      if (a) (tr.children[2].classList.add("add"), tr.children[3].classList.add("add"));
    }
  }
  return out;
}

/** A file bigger than this opens on a click: a 200 KB hunk would stall the page. */
export const BIG_FILE = 1500;
export const STATUS = { added: "new", deleted: "deleted", renamed: "renamed" };
export const counts = (adds, dels) => [h("span", { class: "n-add" }, `+${adds}`), " ", h("span", { class: "n-del" }, `\u2212${dels}`)];

/**
 * One file's block: a collapsible header (path, status, counts) and its body.
 * onBody(body) runs after every fill, so the page can put review comments back
 * on a redraw; a bubble passes none.
 */
export function diffBlock(f, { split = false, hl = null, showHead = true, onBody = null } = {}) {
  const lang = langFor(f.path);
  const lines = f.hunks.reduce((n, x) => n + x.rows.length, 0);
  const body = h("div", { class: "dv-body", "data-rv-file": f.path, "data-rv-lang": "diff" });
  const fill = () => {
    if (f.binary) return body.replaceChildren(h("div", { class: "empty" }, "Binary file changed."));
    if (!f.hunks.length) return body.replaceChildren(h("div", { class: "empty" }, f.status === "renamed" ? "Renamed without changes." : "No content changes."));
    body.replaceChildren(h("table", { class: `diff${split ? " split" : ""}` }, split ? h("colgroup", {}, h("col", { class: "c-ln" }), h("col"), h("col", { class: "c-ln" }), h("col")) : null, h("tbody", {}, f.hunks.flatMap((x) => hunkRows(x, split, hl, lang)))));
    if (onBody) queueMicrotask(() => onBody(body)); // a redraw (Split / Unified, Show this diff) brings the comments back
  };
  if (lines > BIG_FILE && !f.loaded) body.append(h("button", { class: "btn dv-load", type: "button", onclick: () => ((f.loaded = true), fill()) }, `Show this diff (${lines} lines)`));
  else fill();
  if (!showHead) return h("section", { class: "dv-file bare" }, body);
  const block = h("section", { class: `dv-file${f.shut ? " shut" : ""}` });
  const head = h(
    "header",
    { title: f.shut ? "Expand" : "Collapse" },
    h("button", { class: "chev", type: "button", "aria-label": "Toggle file" }),
    h("span", { class: "dv-path" }, f.status === "renamed" && f.from !== f.to ? `${f.from} \u2192 ${f.to}` : f.path),
    STATUS[f.status] ? h("span", { class: `dv-status ${f.status}` }, STATUS[f.status]) : null,
    h("span", { class: "dv-n" }, f.binary ? "binary" : counts(f.adds, f.dels)),
  );
  head.addEventListener("click", () => {
    f.shut = !f.shut;
    block.classList.toggle("shut", f.shut);
  });
  block.append(head, body);
  return block;
}

/** The file list above several blocks: each entry opens its file and scrolls to it. (null for one file.) */
export function diffFileList(files, blocks) {
  if (files.length < 2) return null;
  return h(
    "ol",
    { class: "dv-files" },
    files.map((f, i) =>
      h(
        "li",
        {},
        h(
          "a",
          {
            href: "#",
            onclick: (e) => {
              e.preventDefault();
              if (f.shut) blocks[i].querySelector("header").click();
              blocks[i].scrollIntoView({ behavior: "smooth", block: "start" });
            },
          },
          f.path,
        ),
        STATUS[f.status] ? h("span", { class: `dv-status ${f.status}` }, STATUS[f.status]) : null,
        h("span", { class: "dv-n" }, f.binary ? "binary" : counts(f.adds, f.dels)),
      ),
    ),
  );
}

/** A patch as unified file blocks and, for several files, the list above them. */
export function renderDiff(text, opts = {}) {
  const files = parsePatch(text);
  if (!files.length) return h("div", { class: "empty" }, text.trim() ? "No file changes in this patch." : "No changes in this patch.");
  const hl = opts.hl !== undefined ? opts.hl : files.some((f) => langFor(f.path)) ? (window.hljs ?? null) : null;
  const blocks = files.map((f) => diffBlock(f, { split: !!opts.split, hl, showHead: opts.showHead ?? files.length > 1, onBody: opts.onBody }));
  return h("div", { class: `diffview${opts.inModal ? " in-modal" : ""}` }, diffFileList(files, blocks) ?? "", ...blocks);
}

// ── mermaid ────────────────────────────────────────────────────────────────────
// Diagram source drawn by mermaid, which the host loads lazily (opts.loadMermaid)
// and configures itself: the page re-themes it, a bubble has one theme. A host
// that has no `loadMermaid` (so window.mermaid is already there) must have called
// mermaid.initialize({ securityLevel: "strict", startOnLoad: false }) first: strict
// is what refuses scripts and HTML labels. Even then the drawn SVG is mermaid's,
// not ours, so any non-data image it carries loses its href before it goes in.

let mermaidSeq = 0;

export async function renderMermaid(el, source, opts = {}) {
  const loadMermaid = opts.loadMermaid ?? (() => Promise.resolve(window.mermaid));
  // Not "mermaid": mermaid's own startOnLoad scans for that class when its
  // script loads and would empty this box before render() fills it.
  el.classList.add("mmd");
  el._src = source; // kept so a theme change can draw it again
  try {
    const mermaid = await loadMermaid();
    const { svg: drawn } = await mermaid.render(`mmd-${++mermaidSeq}`, source);
    el.innerHTML = drawn;
    for (const n of el.querySelectorAll("img, image"))
      for (const a of ["href", "xlink:href", "src"]) {
        const v = n.getAttribute(a);
        if (v != null && !DATA_IMG.test(v.trim())) n.removeAttribute(a);
      }
  } catch (e) {
    el.replaceChildren(h("div", { class: "err" }, `mermaid: ${e.message || e}`), h("pre", {}, source));
  }
}
