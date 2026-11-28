/**
 * The canvas page's photos: any image on the page opens the full-screen
 * gallery, that gallery spans the whole page in page order, a touch swipe steps
 * through it, and section images reserve their box before they load (the daemon
 * reads their sizes out of the image headers).
 *
 * The daemon's reader is tested on bytes built here; the page runs in jsdom
 * with canned routes, as in canvas-embed.test.mjs.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { imageSize, imageSizeOf, sectionSizes, sessionState } from "../extensions/canvas/daemon.mjs";
import * as nav from "../extensions/canvas/nav.mjs";
import * as render from "../extensions/canvas/render.mjs";
import * as theme from "../extensions/canvas/theme.mjs";

// ── image headers ────────────────────────────────────────────────────────────

const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

const gif = (w, h) => {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};

/** A JPEG: SOI, an APP0 segment, a DQT segment, then the SOF0 that carries the frame size. */
const jpeg = (w, h) => {
  const seg = (marker, payload) => {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
  };
  const sof = Buffer.alloc(15);
  sof[0] = 8; // precision
  sof.writeUInt16BE(h, 1);
  sof.writeUInt16BE(w, 3);
  sof[5] = 3; // components
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0", "latin1")), seg(0xdb, Buffer.alloc(4)), seg(0xc0, sof), Buffer.from([0xff, 0xd9])]);
};

/** WebP, lossless (VP8L): the size packs into the 4 bytes after 0x2f. */
const webpLossless = (w, h) => {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBPVP8L", 8, "latin1");
  b.writeUInt32LE(10, 16);
  b[20] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
};

/** WebP, lossy (VP8 ): a frame tag, the 9d 01 2a start code, then two 14-bit sizes. */
const webpLossy = (w, h) => {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(30, 4);
  b.write("WEBPVP8 ", 8, "latin1");
  b.writeUInt32LE(30, 16);
  b[20] = 0x30;
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a;
  b.writeUInt16LE(w, 26);
  b.writeUInt16LE(h, 28);
  return b;
};

/** WebP, extended (VP8X): canvas width and height as 24-bit values, minus one. */
const webpExtended = (w, h) => {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(24, 4);
  b.write("WEBPVP8X", 8, "latin1");
  b.writeUInt32LE(24, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};

test("imageSize: PNG, GIF, JPEG and the three WebP flavours, from their headers alone", () => {
  assert.deepEqual(imageSize(png(3, 5)), { width: 3, height: 5 });
  assert.deepEqual(imageSize(png(2880, 1800)), { width: 2880, height: 1800 });
  assert.deepEqual(imageSize(gif(120, 90)), { width: 120, height: 90 });
  assert.deepEqual(imageSize(jpeg(17, 23)), { width: 17, height: 23 });
  assert.deepEqual(imageSize(webpLossless(64, 48)), { width: 64, height: 48 });
  assert.deepEqual(imageSize(webpLossy(1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(imageSize(webpExtended(320, 200)), { width: 320, height: 200 });
  for (const junk of [Buffer.alloc(0), Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), Buffer.from("not an image at all"), Buffer.alloc(4)]) assert.equal(imageSize(junk), null, `${junk.length} bytes: no size`);
});

test("imageSizeOf: a file's head, cached, and null for whatever it can't read", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-size-"));
  try {
    writeFileSync(join(dir, "a.png"), png(800, 600));
    writeFileSync(join(dir, "b.jpg"), jpeg(200, 100));
    writeFileSync(join(dir, "c.webp"), webpLossless(40, 30));
    writeFileSync(join(dir, "d.svg"), "<svg/>");
    assert.deepEqual(imageSizeOf(join(dir, "a.png")), { width: 800, height: 600 });
    assert.deepEqual(imageSizeOf(join(dir, "b.jpg")), { width: 200, height: 100 });
    assert.deepEqual(imageSizeOf(join(dir, "c.webp")), { width: 40, height: 30 });
    assert.equal(imageSizeOf(join(dir, "d.svg")), null, "an SVG has no pixel size in its header");
    assert.equal(imageSizeOf(join(dir, "gone.png")), null, "a missing file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sectionSizes: image sections get size, compares their two files' sizes, others are untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-sizes-"));
  try {
    writeFileSync(join(dir, "shot.png"), png(1200, 900));
    writeFileSync(join(dir, "before.png"), png(640, 480));
    writeFileSync(join(dir, "after.png"), jpeg(320, 240));
    writeFileSync(join(dir, "x.compare"), JSON.stringify({ before: "before.png", after: "after.png" }));
    const sections = [
      { id: "shot", kind: "image", file: "shot.png", title: "Shot" },
      { id: "cmp", kind: "compare", file: "x.compare", title: "Profile" },
      { id: "notes", kind: "markdown", file: "notes.md", title: "Notes" },
      { id: "gone", kind: "image", file: "missing.png", title: "Gone" },
    ];
    const [shot, cmp, notes, gone] = sectionSizes(dir, sections);
    assert.deepEqual(shot.size, { width: 1200, height: 900 }, "the image's own size");
    assert.deepEqual(cmp.files, { before: { file: "before.png", width: 640, height: 480 }, after: { file: "after.png", width: 320, height: 240 } }, "both sides of the compare, with their files");
    assert.deepEqual(notes, sections[2], "a markdown section is left alone");
    assert.deepEqual(gone, sections[3], "a file it can't read leaves the section as it was");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The state route carries the sizes: the page can only reserve an image's box
 * before it loads if /api/s/<id> hands it the width and height.
 */
test("sessionState: a screenshot's size and a compare's two files ride along to the page", () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-state-"));
  try {
    const dir = join(root, "abcdefghijkl");
    mkdirSync(dir);
    writeFileSync(join(dir, "shot.png"), png(900, 700));
    writeFileSync(join(dir, "before.png"), png(400, 300));
    writeFileSync(join(dir, "after.png"), png(400, 320));
    writeFileSync(join(dir, "x.compare"), JSON.stringify({ before: "before.png", after: "after.png" }));
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: "abcdefghijkl", name: "Demo", pid: process.pid }));
    writeFileSync(
      join(dir, "sections.json"),
      JSON.stringify([
        { id: "shot", title: "Shot", kind: "image", file: "shot.png", at: at(1) },
        { id: "cmp", title: "Profile", kind: "compare", file: "x.compare", at: at(2) },
      ]),
    );
    const state = sessionState(root, "abcdefghijkl");
    const shot = state.sections.find((s) => s.id === "shot");
    const cmp = state.sections.find((s) => s.id === "cmp");
    assert.deepEqual(shot.size, { width: 900, height: 700 }, "the image's size on its section");
    assert.deepEqual(cmp.files, { before: { file: "before.png", width: 400, height: 300 }, after: { file: "after.png", width: 400, height: 320 } }, "both compare files, sized");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── page.mjs in jsdom ────────────────────────────────────────────────────────
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

const NOW = Date.now();
const at = (secs) => new Date(NOW - secs * 1000).toISOString();

// Data URLs: render.mjs checks imgSrc with `instanceof RegExp`, which is realm-bound, so a page.html
// src (a real one is /s/s1/f/…) would be dropped by the jsdom harness. data: passes in both realms.
const THUMB = "data:image/png;base64,iVBORw0KGgo=";
const PICTURE = "data:image/png;base64,iVBORw0KGgo=";
const GALLERY = `<div class="gallery"><figure><a href="${THUMB}"><img src="${THUMB}" alt="shot-1" loading="lazy" decoding="async"></a><figcaption>shot-1 · now</figcaption></figure></div>`;
// What the page's marked stub turns any markdown into: the Screenshots gallery and an embedded image.
const MD_HTML = `<p>Notes</p>${GALLERY}<p><img src="${PICTURE}" alt="Markdown pic"></p>`;
const COMPARE = JSON.stringify({ before: "before.png", after: "after.png", labels: ["Before", "After"] });

/** Three sections, newest first: a screenshot, a compare, and markdown with a gallery and an image. */
function state() {
  return {
    meta: { id: "s1", name: "Demo", cwd: "/tmp/demo" },
    live: true,
    tmux: true,
    activity: "done",
    status: null,
    reply: null,
    acks: [],
    watch: null,
    meeting: null,
    sections: [
      { id: "shot", kind: "image", title: "A shot", file: "shot.png", at: at(1), size: { width: 800, height: 600 } },
      { id: "profile", kind: "compare", title: "Profile", file: "profile.compare", at: at(2), files: { before: { file: "before.png", width: 640, height: 480 }, after: { file: "after.png", width: 640, height: 480 } } },
      { id: "notes", kind: "markdown", title: "Notes", file: "notes.md", at: at(3) },
    ],
  };
}

async function runPage({ metas = {}, data = state() } = {}) {
  const head = Object.entries(metas)
    .map(([k, v]) => `<meta name="${k}" content="${v}">`)
    .join("");
  const dom = new JSDOM(`<!doctype html><head>${head}</head><body><div id="app"></div></body>`, { url: "http://127.0.0.1:8790/s/s1", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  // render.mjs runs in this realm and reaches for document/window/Node.
  Object.assign(globalThis, { document: w.document, window: w, Node: w.Node });
  const fetches = [];
  w.fetch = async (u) => {
    const path = String(u);
    fetches.push(path);
    const body = /\/api\/s\/s1$/.test(path) ? data : /profile\.compare/.test(path) ? JSON.parse(COMPARE) : /notes\.md/.test(path) ? "Notes" : /\/api\/sessions$/.test(path) ? [] : {};
    return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : /profile\.compare/.test(path) ? COMPARE : "") };
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
  // jsdom has no pointer capture, and marked/DOMPurify are the host's globals.
  w.Element.prototype.setPointerCapture = () => {};
  w.Element.prototype.releasePointerCapture = () => {};
  w.Element.prototype.hasPointerCapture = () => true;
  w.marked = { parse: () => MD_HTML, lexer: () => ({ links: [] }) };
  w.DOMPurify = { sanitize: (s) => s };
  const intervals = [];
  const realSetInterval = w.setInterval.bind(w);
  w.setInterval = (fn, ms) => (intervals.push({ fn, ms }), realSetInterval(() => {}, 1e9));
  w.__mods = { theme, nav, render };
  w.eval(asScript(pageSrc));
  await tick(80); // the state, the bodies, and the cards' first draw
  return { w, doc: w.document, fetches, streams, intervals };
}

/** jsdom has no <dialog>'s showModal/close: open and fire "close" like a browser. */
function dialogs(w) {
  const proto = w.HTMLDialogElement.prototype;
  proto.showModal = function () {
    this.setAttribute("open", "");
  };
  proto.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
}

const click = (w, el, opts = {}) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...opts }));

/** A swipe: one touch down at `from`, lifted at `to`; `fingers` > 1 is a pinch. */
function swipe(w, target, from, to, fingers = 1) {
  const points = (n, [x, y]) => Array.from({ length: n }, () => ({ clientX: x, clientY: y }));
  const send = (type, touches, changed) => {
    const e = new w.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "touches", { value: touches });
    Object.defineProperty(e, "changedTouches", { value: changed });
    target.dispatchEvent(e);
  };
  send("touchstart", points(fingers, from), points(fingers, from));
  send("touchend", [], points(1, to));
}

const dialog = (doc) => doc.querySelector("dialog.modal");
const pos = (doc) => dialog(doc)?.querySelector(".pos")?.textContent;
const title = (doc) => dialog(doc)?.querySelector("header .title")?.textContent;

test("page photos: every content image opens the gallery, in page order across sections", async () => {
  const { w, doc } = await runPage();
  dialogs(w);
  const shot = doc.querySelector("#sec-shot img.shot");
  assert.ok(shot, "the screenshot section drew its image");

  click(w, shot);
  assert.equal(dialog(doc).hasAttribute("open"), true, "a tap on the screenshot opens it");
  assert.deepEqual([title(doc), pos(doc)], ["A shot", "1 / 5"], "one gallery for the whole page, 1 of 5");
  const order = [];
  for (let i = 0; i < 5; i++) {
    order.push(title(doc));
    dialog(doc).querySelector(".mstep.next").click();
  }
  assert.deepEqual(order, ["A shot", "Profile (before)", "Profile (after)", "shot-1 · now", "Markdown pic"], "page order: image, compare before/after, gallery thumb, markdown image");

  // Each kind opens at its own place: the gallery thumb, the markdown image, then either side of the compare.
  const reopen = (el, expected) => {
    dialog(doc).close();
    click(w, el);
    assert.deepEqual([title(doc), pos(doc)], expected, `${expected[0]} opens at ${expected[1]}`);
  };
  reopen(doc.querySelector("#sec-notes .gallery img"), ["shot-1 · now", "4 / 5"]);
  reopen(doc.querySelector("#sec-notes .md > p img"), ["Markdown pic", "5 / 5"]);
  const cmpImgs = doc.querySelectorAll("#sec-profile .cmp-stack img");
  assert.equal(cmpImgs.length, 2, "the slider drew both sides");
  reopen(cmpImgs[0], ["Profile (before)", "2 / 5"]);
  dialog(doc).close();

  // A tap on the left of the slider opens the before image, a tap on the right the after one.
  const box = doc.querySelector("#sec-profile .cmp-stack.slide");
  box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 });
  const tap = (x) => {
    cmpImgs[1].dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, clientX: x }));
    cmpImgs[1].dispatchEvent(new w.MouseEvent("pointerup", { bubbles: true, clientX: x }));
    click(w, cmpImgs[1], { clientX: x });
  };
  tap(100);
  assert.deepEqual([title(doc), pos(doc)], ["Profile (before)", "2 / 5"], "a tap on the before side opens before");
  dialog(doc).close();
  tap(900);
  assert.deepEqual([title(doc), pos(doc)], ["Profile (after)", "3 / 5"], "a tap on the after side opens after");
  dialog(doc).close();
  // Dragging the slider is not a tap: it moves the divider and opens nothing.
  cmpImgs[1].dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, clientX: 100 }));
  cmpImgs[1].dispatchEvent(new w.MouseEvent("pointermove", { bubbles: true, clientX: 600 }));
  cmpImgs[1].dispatchEvent(new w.MouseEvent("pointerup", { bubbles: true, clientX: 600 }));
  click(w, cmpImgs[1], { clientX: 600 });
  assert.equal(dialog(doc).hasAttribute("open"), false, "a drag across the slider opens nothing");
  assert.equal(box.dataset.pos, "60", "and it moved the divider");
});

test("page photos: a folded section's images come along (their URLs are in the state)", async () => {
  const data = state();
  // Folded: the cards start shut, so their bodies never load.
  data.sections = data.sections.map((s) => ({ ...s, at: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() }));
  const { w, doc } = await runPage({ data });
  dialogs(w);
  const cards = [...doc.querySelectorAll("#sec-shot, #sec-profile")];
  assert.ok(cards.every((c) => c.classList.contains("collapsed")), "both start folded");
  assert.equal(doc.querySelector("#sec-shot img.shot"), null, "a folded card drew no image");
  // The gallery card is old too, but its body was opened by hand to have photos to tap.
  doc.querySelector("#sec-notes").setCollapsed(false);
  await tick();
  const thumb = doc.querySelector("#sec-notes .gallery img");
  assert.ok(thumb, "the opened card drew its gallery");
  click(w, thumb);
  assert.equal(pos(doc), "4 / 5", "the thumb is the page's fourth photo, after the folded sections' own");
  for (let k = 0; k < 3; k++) dialog(doc).querySelector(".mstep.prev").click();
  const titles = [];
  for (let i = 0; i < 5; i++) {
    titles.push(title(doc));
    dialog(doc).querySelector(".mstep.next").click();
  }
  assert.deepEqual(titles, ["A shot", "Profile (before)", "Profile (after)", "shot-1 · now", "Markdown pic"], "the folded sections' photos are in it, in page order");
});

test("page modal: a horizontal swipe steps next/prev; vertical, short and pinching moves don't", async () => {
  const { w, doc } = await runPage();
  dialogs(w);
  click(w, doc.querySelector("#sec-shot img.shot"));
  // Each show() replaces the dialog's children, so the body is looked up again for every swipe.
  const body = () => dialog(doc).querySelector(".mbody");
  assert.equal(pos(doc), "1 / 5");

  swipe(w, body(), [300, 200], [150, 205]);
  assert.equal(pos(doc), "2 / 5", "a leftward swipe goes to the next photo");
  swipe(w, body(), [150, 205], [350, 200]);
  assert.equal(pos(doc), "1 / 5", "a rightward swipe goes back");
  swipe(w, body(), [300, 100], [310, 400]);
  assert.equal(pos(doc), "1 / 5", "a mostly vertical move is a scroll, not a swipe");
  swipe(w, body(), [300, 200], [270, 205]);
  assert.equal(pos(doc), "1 / 5", "30 px is short of the threshold");
  swipe(w, body(), [300, 200], [100, 200], 2);
  assert.equal(pos(doc), "1 / 5", "a pinch (two fingers) is the browser's zoom");
  swipe(w, body(), [300, 200], [100, 200]);
  assert.equal(pos(doc), "2 / 5", "and a plain swipe works again after it");
});

test("page images: width/height from the file reserve the box, with lazy loading and async decoding", async () => {
  const { doc } = await runPage();
  const shot = doc.querySelector("#sec-shot img.shot");
  assert.deepEqual([shot.getAttribute("width"), shot.getAttribute("height")], ["800", "600"], "the section image carries its size");
  assert.deepEqual([shot.getAttribute("loading"), shot.getAttribute("decoding")], ["lazy", "async"]);
  const [before, after] = doc.querySelectorAll("#sec-profile .cmp-stack img");
  for (const img of [before, after]) assert.deepEqual([img.getAttribute("width"), img.getAttribute("height")], ["640", "480"], "each side of the compare carries its size");
  const md = doc.querySelector("#sec-notes .md img");
  assert.deepEqual([md.getAttribute("loading"), md.getAttribute("decoding")], ["lazy", "async"], "markdown images load lazily too");
  // The page's CSS keeps height auto (so the attributes only fix the aspect ratio) and leaves scroll anchoring on.
  const css = pageSrc.slice(pageSrc.indexOf("const CSS = `"), pageSrc.indexOf("`;", pageSrc.indexOf("const CSS = `")));
  assert.match(css, /img\.shot \{[^}]*height: auto/, "img.shot: height auto");
  assert.match(css, /\.md img \{[^}]*height: auto/, ".md img: height auto");
  assert.doesNotMatch(css, /overflow-anchor:\s*none\s*;/, "nothing turns the browser's scroll anchoring off");
});

test("page redraw: a replaced card keeps its height until the new image loads", async () => {
  const data = state();
  const { w, doc, intervals } = await runPage({ metas: { "canvas-live": "poll:250" }, data });
  // The old card's height, as a laid-out browser would have measured it.
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 300 });
  data.sections[0] = { ...data.sections[0], at: new Date().toISOString(), title: "A shot" };
  intervals.find((i) => i.ms === 250).fn();
  await tick(120);
  const card = doc.querySelector("#sec-shot");
  assert.equal(card.style.minHeight, "300px", "the old height is held while the new image loads");
  card.querySelector("img.shot").dispatchEvent(new w.Event("load"));
  assert.equal(card.style.minHeight, "", "released as soon as it arrives");
});

test("sectionSizes reads no file outside the session dir", async () => {
  const { sectionSizes } = await import("../extensions/canvas/daemon.mjs");
  const root = mkdtempSync(join(tmpdir(), "canvas-size-"));
  try {
    mkdirSync(join(root, "s"));
    writeFileSync(join(root, "out.png"), png(10, 10));
    writeFileSync(join(root, "s", "x.compare"), JSON.stringify({ before: "../out.png", after: "../out.png" }));
    const out = sectionSizes(join(root, "s"), [{ kind: "image", file: "../out.png" }, { kind: "compare", file: "x.compare" }]);
    assert.equal(out[0].size, undefined);
    assert.equal(out[1].files, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
