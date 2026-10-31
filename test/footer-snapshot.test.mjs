import assert from "node:assert/strict";
import test from "node:test";

import { ansiSegments, latestFooter, onFooterChange, publishFooter } from "../lib/footer-snapshot.ts";

test("ansiSegments turns SGR colours into segments", () => {
	assert.deepEqual(ansiSegments("\x1b[35mmain*\x1b[0m \x1b[36m⇡\x1b[39m"), [
		{ text: "main*", fg: "magenta" },
		{ text: " " },
		{ text: "⇡", fg: "cyan" },
	]);
	assert.deepEqual(ansiSegments("\x1b[38;2;255;128;0m99\x1b[0m"), [{ text: "99", fg: "#ff8000" }]);
	assert.deepEqual(ansiSegments("\x1b[2m\x1b[93mdim\x1b[0m"), [{ text: "dim", fg: "brightYellow", dim: true }]);
	assert.deepEqual(ansiSegments("\x1b]8;;https://x\x07link\x1b]8;;\x07"), [{ text: "link" }]);
});

test("publishFooter tells listeners once per change", () => {
	let heard = 0;
	const stop = onFooterChange(() => heard++);
	publishFooter([{ id: "dir", text: "\x1b[34mbotsun\x1b[0m" }, { id: "boot", text: "" }]);
	publishFooter([{ id: "dir", text: "\x1b[34mbotsun\x1b[0m" }, { id: "boot", text: "" }]);
	stop();
	assert.equal(heard, 1);
	assert.deepEqual(latestFooter(), [{ id: "dir", segments: [{ text: "botsun", fg: "blue" }] }]);
});
