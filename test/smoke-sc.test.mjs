import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stubCtx, stubPi } from "./helpers/stub-pi.mjs";

// sc reads iCloud's Downloads under $HOME at load; point both somewhere fake.
const home = mkdtempSync(join(tmpdir(), "sc-home-"));
process.env.HOME = home;
process.env.BOEHSLINE_CONFIG = join(home, "none.json");
process.env.BOEHSLINE_ENABLE = "sc";
const downloads = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Downloads");

const { default: sc } = await import("../extensions/opt-in/sc/index.ts");

function load() {
	const s = stubPi();
	sc(s.pi);
	return s;
}

test("sc registers /sc only", () => {
	assert.deepEqual(load().names(), ["command:sc"]);
});

test("/sc: no folder, then a not-yet-downloaded file", async () => {
	const s = load();
	const { ctx, notes } = stubCtx();
	await s.commands.get("sc").handler("", ctx);
	assert.match(notes.at(-1)[1], /Nothing found in .*Downloads/);
	mkdirSync(downloads, { recursive: true });
	writeFileSync(join(downloads, ".shot.png.icloud"), "");
	writeFileSync(join(downloads, "shot.png.icloud"), "");
	await s.commands.get("sc").handler("", ctx);
	assert.match(notes.at(-1)[1], /shot\.png hasn't downloaded yet/);
	assert.equal(s.sent.length, 0);
});

test("/sc attaches the newest image, steering, with its path and the instruction", async () => {
	mkdirSync(downloads, { recursive: true });
	const old = join(downloads, "receipt.pdf");
	writeFileSync(old, "%PDF");
	utimesSync(old, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
	writeFileSync(join(downloads, "new.PNG"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	const s = load();
	await s.commands.get("sc").handler("what does this error say", stubCtx().ctx);
	const [{ content, options }] = s.sent;
	assert.deepEqual(options, { deliverAs: "steer" });
	assert.match(content[0].text, /new\.PNG.*attached\. what does this error say$/);
	assert.deepEqual(content[1], { type: "image", data: "iVBORw==", mimeType: "image/png" });
});

test("/sc sends a non-image by path, nothing attached", async () => {
	const notes = join(downloads, "notes.txt");
	writeFileSync(notes, "hi");
	// tmpfs (and other coarse clocks) can stamp back-to-back writes with the
	// same mtime, so readdir order would keep new.PNG. Force this file newest.
	const newer = new Date(Date.now() + 5_000);
	utimesSync(notes, newer, newer);
	const s = load();
	await s.commands.get("sc").handler("", stubCtx().ctx);
	assert.equal(typeof s.sent[0].content, "string");
	assert.match(s.sent[0].content, /notes\.txt.*not an image; read the file\. Read this screenshot\.$/);
});
