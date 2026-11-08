/**
 * /icon's drawn picker: a frame cut from a strip PNG (each filter type), halved, and the Kitty
 * sequences (chunked, tmux-wrapped, placeholders carrying the id).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { kittyDelete, kittyTransmit, placeholderRow, shrink, stripFrame } from "../extensions/opt-in/botsun-owner/icon-picker.ts";

function crc32(buf) {
	let c = ~0;
	for (const b of buf) {
		c ^= b;
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
	}
	return ~c >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}
const paeth = (a, b, c) => {
	const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
/** An RGBA PNG, row y filtered with type y % 5, IDAT split in two. */
function png(w, h, px) {
	const stride = w * 4;
	const rows = [];
	for (let y = 0; y < h; y++) {
		const f = y % 5;
		const row = Buffer.alloc(stride + 1);
		row[0] = f;
		for (let i = 0; i < stride; i++) {
			const x = px[y * stride + i];
			const a = i >= 4 ? px[y * stride + i - 4] : 0;
			const b = y > 0 ? px[(y - 1) * stride + i] : 0;
			const c = i >= 4 && y > 0 ? px[(y - 1) * stride + i - 4] : 0;
			const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
			row[i + 1] = (x - pred) & 255;
		}
		rows.push(row);
	}
	const z = deflateSync(Buffer.concat(rows));
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 6;
	const half = z.length >> 1;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", z.subarray(0, half)), chunk("IDAT", z.subarray(half)), chunk("IEND", Buffer.alloc(0))]);
}

test("stripFrame cuts one frame out, through every filter type", async () => {
	const size = 8, frames = 3, w = size * frames, h = size;
	const px = Buffer.alloc(w * h * 4);
	for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i >> 5) * 11) & 255;
	const file = png(w, h, px);
	for (let f = 0; f < frames; f++) {
		const got = await stripFrame(file, f, size);
		const want = Buffer.alloc(size * size * 4);
		for (let y = 0; y < size; y++) px.copy(want, y * size * 4, (y * w + f * size) * 4, (y * w + (f + 1) * size) * 4);
		assert.equal(got.w, size);
		assert.ok(got.rgba.equals(want), `frame ${f}`);
	}
	assert.equal(await stripFrame(file, frames, size), null, "past the strip's end");
	assert.equal(await stripFrame(Buffer.from("not a png at all, really not one"), 0, size), null);
});

test("shrink halves with alpha weighting, and a clear pixel adds no color", () => {
	const rgba = Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0]);
	const out = shrink({ w: 2, h: 2, rgba }, 1);
	assert.deepEqual([...out.rgba], [255, 0, 0, 128]);
});

test("kitty sequences: chunked, tmux-wrapped, and placeholders carry the id", () => {
	const saved = process.env.TMUX;
	try {
		delete process.env.TMUX;
		const z = Buffer.alloc(5000, 7);
		const seq = kittyTransmit(0x123456, 64, 64, z, 4, 2);
		const cmds = seq.split("\x1b\\").filter(Boolean);
		assert.match(cmds[0], /^\x1b_Ga=t,f=32,o=z,s=64,v=64,i=1193046,q=2,m=1;/);
		assert.match(cmds[1], /^\x1b_Gm=0;/);
		assert.equal(cmds[2], "\x1b_Ga=p,U=1,i=1193046,c=4,r=2,q=2");
		const b64 = cmds.slice(0, 2).map((c) => c.split(";")[1]).join("");
		assert.ok(Buffer.from(b64, "base64").equals(z));
		process.env.TMUX = "/tmp/x,1,0";
		assert.equal(kittyDelete(5), "\x1bPtmux;\x1b\x1b_Ga=d,d=I,i=5,q=2\x1b\x1b\\\x1b\\");
	} finally {
		if (saved === undefined) delete process.env.TMUX;
		else process.env.TMUX = saved;
	}
	const row = placeholderRow(0x010203, 1, 2);
	assert.equal(row, "\x1b[38;2;1;2;3m\u{10EEEE}\u030D\u0305\u{10EEEE}\u030D\u030D\x1b[39m");
});
