// Rendering shared by the canvas page (served as /assets/render.mjs) and
// botsun's chat bubbles (render/bubble.html): markdown, tables and charts.
// Plain DOM nodes with CSS-variable colours, so a host stylesheet themes them;
// nothing here reads the page's state, storage or session globals.
//
// A host must NOT call DOMPurify.setConfig(): in DOMPurify 3.x a global config
// wins over every later per-call config, which would quietly drop MD_CLEAN's
// FORBID_ATTR: ["style"] (a bot could then overlay the bubble) and the image
// rules below. Want a global tweak? Use DOMPurify.addHook(). This module passes
// its own allow-lists on every call, and the sanitised markdown is parsed into
// an inert <template> and filtered there before any of it is appended.
//
// The canvas page still has its own renderMarkdown (page.mjs: a .codeblock DOM,
// no image filter) so its look is unchanged; bubbles use this one.
//
// The DOM a host page styles (bubble.css):
//   .md                 markdown root
//   .md .code-wrap      a fenced block: scrolls sideways, never wraps
//     .md .code-head    its bar: .lang (the fence's language, if any) + button.copy
//     .md pre           the code; a highlighted one is pre > code.hljs
//   .md table           GFM/pipe tables
//   .chart, .tbl        renderChart / renderTable (see below)

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
const HL_CLEAN = { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false };
const PLAIN = new Set(["text", "txt", "plain", "plaintext", "output", "console", "log"]);

/** A fence's language, if it is one: lowercase, short, and not a plain-text alias. */
function langName(lang) {
  const name = String(lang || "").trim().split(/\s/, 1)[0].toLowerCase();
  return name && !PLAIN.has(name) && /^[a-z0-9_+#.-]{1,40}$/.test(name) ? name : null;
}

/**
 * Colour a fence in place. Only a named language (no guessing), only blocks up
 * to 16 KB, and the result is cut down to <span class> before use.
 */
function highlightInto(code, lang) {
  const name = langName(lang);
  const text = code.textContent;
  const hljs = window.hljs;
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
  tpl.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true }), MD_CLEAN);
  for (const bad of tpl.content.querySelectorAll("picture, source, video, audio, track")) bad.remove();
  // Dropping the attribute is what stops the fetch; the element (and its text)
  // stays, so <td background> keeps its cell.
  for (const el of tpl.content.querySelectorAll("[srcset], [background], [poster]")) for (const attr of ["srcset", "background", "poster"]) el.removeAttribute(attr);
  for (const img of tpl.content.querySelectorAll("img")) if (!DATA_IMG.test(img.getAttribute("src") || "")) img.remove();
  el.append(tpl.content);
  // A bubble is its own page: links leave for the real browser.
  for (const a of el.querySelectorAll("a[href]")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  for (const pre of el.querySelectorAll("pre")) {
    const code = pre.querySelector("code") || pre;
    const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9);
    if (lang) highlightInto(code, lang);
    else highlightGuess(code);
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
