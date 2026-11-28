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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

/** A JPEG segment: its marker, a 2-byte length, then the payload. */
const seg = (marker, payload) => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
};

/** SOFn's payload: precision, height, width, component count. */
const sofPayload = (w, h) => {
  const sof = Buffer.alloc(15);
  sof[0] = 8; // precision
  sof.writeUInt16BE(h, 1);
  sof.writeUInt16BE(w, 3);
  sof[5] = 3; // components
  return sof;
};

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** A JPEG: SOI, an APP0 segment, a DQT segment, then the SOF0 that carries the frame size. */
const jpeg = (w, h) => Buffer.concat([SOI, seg(0xe0, Buffer.from("JFIF\0", "latin1")), seg(0xdb, Buffer.alloc(4)), seg(0xc0, sofPayload(w, h)), EOI]);

/** An APP1 EXIF payload holding IFD0's orientation tag (0x0112), in either byte order. */
const exif = (orientation, le = true, ifd = 8) => {
  const tiff = Buffer.alloc(26);
  tiff.write(le ? "II" : "MM", 0, "latin1");
  const u16 = (at, v) => (le ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at));
  const u32 = (at, v) => (le ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at));
  u16(2, 42);
  u32(4, ifd); // where IFD0 starts
  if (ifd + 18 > tiff.length) return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]); // a hostile offset
  u16(ifd, 1); // one entry
  u16(ifd + 2, 0x0112); // orientation
  u16(ifd + 4, 3); // SHORT
  u32(ifd + 6, 1); // one value
  u16(ifd + 10, orientation); // in the first two bytes of the value field
  u32(ifd + 14, 0); // no next IFD
  return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
};

/** A JPEG whose EXIF orientation says how the picture is turned. */
const jpegExif = (w, h, orientation, le = true, ifd = 8) => Buffer.concat([SOI, seg(0xe1, exif(orientation, le, ifd)), seg(0xc0, sofPayload(w, h)), EOI]);

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

test("imageSize: a JPEG's EXIF orientation 5…8 turns the box upright", () => {
  // A phone's portrait shot is stored landscape and tagged 6 (or 8): the box has to swap.
  assert.deepEqual(imageSize(jpegExif(400, 300, 6)), { width: 300, height: 400 }, "orientation 6, little endian");
  assert.deepEqual(imageSize(jpegExif(400, 300, 8, false)), { width: 300, height: 400 }, "orientation 8, big endian");
  assert.deepEqual(imageSize(jpegExif(400, 300, 5)), { width: 300, height: 400 }, "orientation 5");
  assert.deepEqual(imageSize(jpegExif(400, 300, 7)), { width: 300, height: 400 }, "orientation 7");
  for (const o of [0, 1, 2, 3, 4, 9, 0xffff]) assert.deepEqual(imageSize(jpegExif(400, 300, o)), { width: 400, height: 300 }, `orientation ${o} is not a swap`);
  // An IFD offset pointing far outside the segment reads nothing: the size stands as it is.
  assert.deepEqual(imageSize(jpegExif(400, 300, 6, true, 0x7ffffff0)), { width: 400, height: 300 }, "a hostile IFD offset");
  assert.deepEqual(imageSize(jpeg(400, 300)), { width: 400, height: 300 }, "a JPEG with no EXIF at all");
});

test("imageSize: a mad header is null, never a throw and never an out-of-range read", () => {
  // 200 KB of fill bytes after SOI: the marker walk steps one byte at a time and ends.
  assert.equal(imageSize(Buffer.concat([SOI, Buffer.alloc(200_000, 0xff)])), null, "a run of 0xff");
  // A SOF whose length (2) can't hold its own fields: the next segment's bytes are not a size.
  assert.equal(imageSize(Buffer.concat([SOI, seg(0xc0, Buffer.alloc(0)), seg(0xdb, Buffer.from([0, 7, 0, 5, 0, 0, 0, 0])), EOI])), null, "a SOF too short for its fields");
  assert.equal(imageSize(Buffer.concat([SOI, Buffer.from([0xff, 0xc0, 0, 6, 8, 0, 7, 0, 5]), EOI])), null, "a SOF under 8 bytes long");
  assert.equal(imageSize(Buffer.concat([SOI, Buffer.from([0xff, 0xe0, 0xff, 0xff, 1, 2, 3])])), null, "a segment longer than the bytes there are");
  assert.equal(imageSize(Buffer.concat([SOI, SOI.subarray(0, 1)])), null, "a truncated marker");
  // A PNG claiming 2³¹ tall, or a 1:2000 sliver, would reserve a column nothing can fill.
  assert.equal(imageSize(png(1, 2147483647)), null, "a PNG 2³¹ tall");
  assert.equal(imageSize(png(2, 400)), null, "a PNG 1:200 sliver");
  assert.equal(imageSize(png(65536, 10)), null, "a PNG over 65535 wide");
  assert.deepEqual(imageSize(png(1000, 20000)), { width: 1000, height: 20000 }, "a tall one still gets its box (1:20)");
  assert.equal(imageSize(webpExtended(1, 65536)), null, "a VP8X canvas over 65535");
  // Truncations at every length: whatever the format, either a size or null.
  const samples = [png(800, 600), jpeg(200, 100), jpegExif(200, 100, 6), gif(40, 30), webpLossless(40, 30), webpLossy(40, 30), webpExtended(40, 30)];
  for (const s of samples) for (let n = 0; n <= s.length; n++) assert.doesNotThrow(() => imageSize(s.subarray(0, n)), `truncated at ${n} of ${s.length}`);
});

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
    // The cache is keyed by size and mtime: same file, same answer, no second read.
    const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    const a = join(dir, "a.png");
    writeFileSync(a, png(800, 600));
    utimesSync(a, when, when);
    assert.deepEqual(imageSizeOf(a), { width: 800, height: 600 });
    writeFileSync(a, png(100, 50)); // same 33 bytes, another picture
    utimesSync(a, when, when);
    assert.deepEqual(imageSizeOf(a), { width: 800, height: 600 }, "an unchanged size and mtime hits the cache");
    utimesSync(a, when, new Date(when.getTime() + 1000));
    assert.deepEqual(imageSizeOf(a), { width: 100, height: 50 }, "a touched file is read again");
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

async function runPage({ metas = {}, data = state(), md = MD_HTML, compare = COMPARE } = {}) {
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
    const body = /\/api\/s\/s1$/.test(path) ? data : /profile\.compare/.test(path) ? JSON.parse(compare) : /notes\.md/.test(path) ? "Notes" : /\/api\/sessions$/.test(path) ? [] : {};
    return { ok: true, status: 200, json: async () => body, text: async () => (typeof body === "string" ? body : /profile\.compare/.test(path) ? compare : "") };
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
  w.marked = { parse: () => md, lexer: () => ({ links: [] }) };
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

test("page modal: a swipe while the page is zoomed in pans, it doesn't step", async () => {
  const { w, doc } = await runPage();
  dialogs(w);
  click(w, doc.querySelector("#sec-shot img.shot"));
  const body = () => dialog(doc).querySelector(".mbody");
  w.visualViewport = { scale: 2 };
  swipe(w, body(), [300, 200], [100, 200]);
  assert.equal(pos(doc), "1 / 5", "zoomed in, a one-finger pan is the pan");
  w.visualViewport = { scale: 1 };
  swipe(w, body(), [300, 200], [100, 200]);
  assert.equal(pos(doc), "2 / 5", "back at 1× the swipe steps again");
});

test("page photos: a gallery caption opens its photo, a linked image follows its link", async () => {
  const md = `<p>Notes</p>${GALLERY}<p><a href="https://example.com/album"><img src="${PICTURE}" alt="Linked pic" width="800" height="600"></a></p>`;
  const { w, doc } = await runPage({ md });
  dialogs(w);
  click(w, doc.querySelector("#sec-notes .gallery figcaption"));
  assert.equal(dialog(doc).hasAttribute("open"), true, "a tap on the caption opens the gallery");
  assert.deepEqual([title(doc), pos(doc)], ["shot-1 · now", "4 / 4"], "at the caption's own photo");
  dialog(doc).close();
  click(w, doc.querySelector('#sec-notes .md img[alt="Linked pic"]'));
  assert.equal(dialog(doc).hasAttribute("open"), false, "a linked image opens nothing");
});

test("page photos: a small image, and an image inside a button, are not photos", async () => {
  const md = `<p><img src="${PICTURE}" alt="Big" width="800" height="600"></p><p><img src="${PICTURE}" alt="Small" width="20" height="20"></p><p><button type="button"><img src="${PICTURE}" alt="In a button" width="800" height="600"></button></p>`;
  const { w, doc } = await runPage({ md });
  dialogs(w);
  click(w, doc.querySelector("#sec-shot img.shot"));
  assert.equal(pos(doc), "1 / 4", "the shot, the compare's two sides and the big markdown image");
  for (let i = 0; i < 3; i++) dialog(doc).querySelector(".mstep.next").click();
  assert.equal(title(doc), "Big", "the last photo is the full-size one");
  dialog(doc).close();
  click(w, doc.querySelector('img[alt="Small"]'));
  assert.equal(dialog(doc).hasAttribute("open"), false, "a 20 px image is an icon");
  click(w, doc.querySelector('img[alt="In a button"]'));
  assert.equal(dialog(doc).hasAttribute("open"), false, "an image inside a button is a control's face");
});

test("page photos: a tap that can't be a photo doesn't walk the whole page", async () => {
  const { w, doc } = await runPage();
  dialogs(w);
  const qsa = doc.body.querySelectorAll.bind(doc.body);
  let walks = 0;
  doc.body.querySelectorAll = (sel) => (walks++, qsa(sel));
  click(w, doc.querySelector("#sec-notes .md > p"));
  assert.equal(walks, 0, "a tap on text builds no photo list");
  click(w, doc.querySelector("#sec-shot img.shot"));
  assert.ok(walks > 0, "a tap on an image walks the page");
});

test("page compare: the state's sizes hold only for the same file names", async () => {
  // The body names another before file than the state did: its old size must not land on this one.
  const { doc } = await runPage({ compare: JSON.stringify({ before: "other.png", after: "after.png", labels: ["Before", "After"] }) });
  const [before, after] = doc.querySelectorAll("#sec-profile .cmp-stack img");
  assert.equal(before.getAttribute("width"), null, "another file gets no box from the old name");
  assert.equal(after.getAttribute("width"), "640", "the unchanged side keeps its size");
});

test("page images: markdown's img src takes data: images and the page's own files, nothing else", () => {
  const m = pageSrc.match(/const PAGE_IMG = \/(.+)\/i;/);
  assert.ok(m, "page.mjs declares PAGE_IMG");
  const imgSrc = new RegExp(m[1], "i");
  for (const src of ["data:image/png;base64,AA", "data:image/svg+xml,<svg/>", "/s/s1/f/shot.png", "/a/b.png"]) assert.equal(imgSrc.test(src), true, src);
  for (const src of ["data:text/html,<script>alert(1)</script>", "data:,x", "//evil.example/x.png", "https://evil.example/x.png", "javascript:alert(1)", "\\\\host\\x.png"]) assert.equal(imgSrc.test(src), false, src);
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

test("sectionSizes reads no file outside the session dir", () => {
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
