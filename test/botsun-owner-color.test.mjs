/**
 * botsun-owner's color mapping (extensions/opt-in/botsun-owner/color.ts): Botsun's palette names
 * to /color and back, and what a push from Botsun must be to be taken. The sync over the socket
 * is in botsun-owner.test.mjs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BOTSUN_COLORS, PI_NAMES, claimOf, colorPush, fromPi, nearest, toPi, xtermRgb } from "../extensions/opt-in/botsun-owner/color.ts";

// A copy of Botsun's test/fixtures/session-colors.json, which Botsun checks against the phone's fills.
test("the palette is Botsun's, in its order", () => {
	const fixture = JSON.parse(readFileSync(new URL("./fixtures/session-colors.json", import.meta.url), "utf8"));
	assert.deepEqual(Object.entries(BOTSUN_COLORS), Object.entries(fixture));
});

test("a name /color has goes as that name; Botsun's own go as the phone's hex", () => {
	for (const name of ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray"]) assert.equal(toPi(name), name);
	assert.equal(toPi("indigo"), "#6366ff");
	assert.equal(toPi("mint"), "#3de8b5");
	assert.equal(toPi("teal"), "#12b5b0");
	assert.equal(toPi("brown"), "#b5794a");
	for (const bad of ["chartreuse", "Blue", "#ff0000", "", "constructor", "__proto__"]) assert.equal(toPi(bad), null, bad);
	for (const name of PI_NAMES) assert.ok(Object.hasOwn(BOTSUN_COLORS, name), name);
});

test("what pi has comes back as the nearest Botsun name", () => {
	for (const name of Object.keys(BOTSUN_COLORS)) assert.equal(fromPi(toPi(name)), name, "a round trip is exact");
	assert.equal(fromPi("BLUE"), "blue");
	assert.equal(fromPi(" pink "), "pink");
	assert.equal(fromPi("#ff0000"), "red");
	assert.equal(fromPi("#f00"), "red", "short hex");
	assert.equal(fromPi("00c000"), "green", "hex without #");
	assert.equal(fromPi("#00ff7f"), "mint", "spring green");
	assert.equal(fromPi("#7f7f7f"), "gray");
	assert.equal(fromPi("#8b4513"), "brown");
	assert.equal(fromPi("#20b2aa"), "teal");
	assert.equal(fromPi("#4b0082"), "indigo");
	// /color's own palette, as hex: each lands on its own name.
	for (const [name, hex] of Object.entries({ red: "#ff5f5f", orange: "#ff8c42", yellow: "#d7af00", green: "#4fb04f", cyan: "#00b3b3",
		blue: "#5f87ff", purple: "#a878ff", pink: "#ff7ac6", gray: "#8a8a8a" })) {
		assert.equal(fromPi(hex), name === "cyan" ? "teal" : name, `${name} ${hex}`);
	}
	assert.equal(fromPi("196"), "red", "xterm 196 is #ff0000");
	assert.equal(fromPi("21"), "indigo", "xterm 21 is #0000ff, nearer indigo than the phone's blue");
	assert.equal(fromPi("33"), "blue", "xterm 33 is #0087ff");
	assert.equal(fromPi("244"), "gray", "the gray ramp");
	assert.equal(fromPi("2"), "green", "a system color");
	for (const none of [null, undefined, "", "256", "auto", "#12345", "plaid"]) assert.equal(fromPi(none), null, String(none));
});

test("xterm's table", () => {
	assert.deepEqual(xtermRgb(16), { r: 0, g: 0, b: 0 });
	assert.deepEqual(xtermRgb(196), { r: 255, g: 0, b: 0 });
	assert.deepEqual(xtermRgb(231), { r: 255, g: 255, b: 255 });
	assert.deepEqual(xtermRgb(232), { r: 8, g: 8, b: 8 });
	assert.deepEqual(xtermRgb(255), { r: 238, g: 238, b: 238 });
	assert.deepEqual(xtermRgb(9), { r: 255, g: 0, b: 0 });
	assert.equal(nearest({ r: 255, g: 212, b: 0 }), "yellow");
});

test("a claim is a Botsun name or null, and when", () => {
	assert.deepEqual(claimOf({ spec: "#12b5b0", at: 5 }), { color: "teal", color_at: 5 });
	assert.deepEqual(claimOf({ spec: null, at: null }), { color: null, color_at: null });
	assert.deepEqual(claimOf({ spec: "blue", at: -1 }), { color: "blue", color_at: null }, "a bad time is no time");
	assert.deepEqual(claimOf({ spec: 7, at: 1.5 }), { color: null, color_at: null });
	assert.equal(claimOf(null), null, "no color extension: no claim");
	assert.equal(claimOf(undefined), null);
});

test("a push is taken only for this session, a Botsun name and a good time", () => {
	const push = { v: 1, type: "color", session_id: "sid-a", color: "teal", at: 1_762_000_000_000 };
	assert.deepEqual(colorPush("sid-a", push), { spec: "#12b5b0", at: 1_762_000_000_000, color: "teal" });
	assert.deepEqual(colorPush("sid-a", { ...push, color: "pink" }), { spec: "pink", at: 1_762_000_000_000, color: "pink" });
	assert.equal(colorPush("sid-b", push), null, "for the session pi has left");
	assert.equal(colorPush(null, push), null);
	for (const bad of [{ color: "#ff0000" }, { color: "Teal" }, { color: null }, { at: -1 }, { at: 1.5 }, { at: "1" }, { at: 2 ** 53 },
		{ session_id: undefined }]) {
		assert.equal(colorPush("sid-a", { ...push, ...bad }), null, JSON.stringify(bad));
	}
});
